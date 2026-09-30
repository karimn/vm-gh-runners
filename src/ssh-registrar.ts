import type { Server } from "./provider.ts";
import type { RunnerRegistrar } from "./registrar.ts";
import type { Ssh } from "./ssh.ts";
import { DEFAULT_RUNNER_USER, DEFAULT_TEMPLATE_DIR, READY_FILE } from "./userdata.ts";

export interface TokenSource {
  createRegistrationToken(): Promise<string>;
}

export interface SshRegistrarOptions {
  readonly github: TokenSource;
  /** `owner/name`. */
  readonly repo: string;
  readonly ssh: Ssh;
  /** Labels every runner gets; jobs select the VM with `runs-on: [self-hosted, <label>]`. */
  readonly labels?: readonly string[];
  /** Unprivileged account the runners run as. The runner refuses to run as root. */
  readonly runnerUser?: string;
  /**
   * An unpacked runner distribution on the VM, copied once per runner. Whatever
   * builds the VM's first-boot script is responsible for installing it here.
   */
  readonly runnerTemplateDir?: string;
  readonly runnersDir?: string;
  readonly readyAttempts?: number;
  readonly readyDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USER = /^[a-z_][a-z0-9_-]*$/;
const PATH = /^\/[A-Za-z0-9_./-]*$/;

const SSH_CONNECTION_FAILED = 255;

/** Single-quote for a POSIX shell. */
export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Registers runners by SSHing to the server. Everything interpolated into the
 * remote script is validated first and then quoted, and the registration token
 * goes over stdin so it never appears in a process list or a command line.
 */
export class SshRegistrar implements RunnerRegistrar {
  private readonly o: Required<Omit<SshRegistrarOptions, "github" | "ssh">> &
    Pick<SshRegistrarOptions, "github" | "ssh">;

  constructor(opts: SshRegistrarOptions) {
    const o = {
      labels: ["vm-gh-runners"],
      runnerUser: DEFAULT_RUNNER_USER,
      runnerTemplateDir: DEFAULT_TEMPLATE_DIR,
      runnersDir: "/home/runner/runners",
      readyAttempts: 60,
      readyDelayMs: 5000,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      ...opts,
    };
    if (!REPO.test(o.repo)) throw new Error(`repo must be "owner/name", got "${o.repo}"`);
    for (const l of o.labels) {
      if (!LABEL.test(l)) throw new Error(`invalid runner label "${l}"`);
    }
    if (!USER.test(o.runnerUser)) throw new Error(`invalid runner user "${o.runnerUser}"`);
    for (const p of [o.runnerTemplateDir, o.runnersDir]) {
      if (!PATH.test(p)) throw new Error(`invalid path "${p}"`);
    }
    this.o = o;
  }

  async register(server: Server, runnerNames: readonly string[]): Promise<void> {
    for (const n of runnerNames) {
      if (!NAME.test(n)) throw new Error(`invalid runner name "${n}"`);
    }
    const host = server.address;
    if (!host) throw new Error(`server ${server.name} has no address to connect to`);

    await this.waitUntilReady(host);
    // One token serves every runner in this call; it is valid for about an hour.
    const token = await this.o.github.createRegistrationToken();

    for (const name of runnerNames) {
      const res = await this.o.ssh.exec(host, "bash -s", this.script(name, token));
      if (res.code !== 0) {
        const detail = res.stderr.replaceAll(token, "***").trim();
        throw new Error(`registering runner ${name} failed (exit ${res.code}): ${detail}`);
      }
    }
  }

  /**
   * Stops and uninstalls the service of every runner directory. The directories
   * are found on the VM, not from GitHub's runner list, so a runner that was
   * already deregistered (or never finished registering) is still cleaned up. A
   * failure in one directory does not stop the others, but the call fails at the
   * end. Does not wait for cloud-init: the server is already up and in use.
   */
  async uninstall(server: Server): Promise<void> {
    const host = server.address;
    if (!host) throw new Error(`server ${server.name} has no address to connect to`);

    const res = await this.o.ssh.exec(host, "bash -s", this.uninstallScript());
    if (res.code !== 0) {
      throw new Error(`uninstalling runner services on ${server.name} failed (exit ${res.code}): ${res.stderr.trim()}`);
    }
  }

  private uninstallScript(): string {
    return `set -u
failed=0
for dir in ${shq(this.o.runnersDir)}/*/; do
  [ -f "$dir/.service" ] || continue
  if ! (cd "$dir" && ./svc.sh stop && ./svc.sh uninstall); then
    echo "could not remove the service in $dir" >&2
    failed=1
  fi
done
exit "$failed"
`;
  }

  private async waitUntilReady(host: string): Promise<void> {
    const { readyAttempts, readyDelayMs, sleep, ssh } = this.o;
    for (let attempt = 1; attempt <= readyAttempts; attempt++) {
      const res = await ssh.exec(host, "cloud-init status --wait");
      if (res.code === 0 || res.code === 2) return this.checkSetupFinished(host);
      if (res.code !== SSH_CONNECTION_FAILED) {
        throw new Error(`cloud-init did not finish cleanly on ${host} (exit ${res.code}): ${res.stderr.trim()}`);
      }
      if (attempt < readyAttempts) await sleep(readyDelayMs);
    }
    throw new Error(`${host} not reachable over SSH after ${readyAttempts} attempts`);
  }

  /**
   * cloud-init exit 2 means "degraded", which is also what a failed setup
   * script produces, so it proves nothing. The setup script's last step is to
   * create a marker file; its absence means an install step failed.
   */
  private async checkSetupFinished(host: string): Promise<void> {
    const marker = await this.o.ssh.exec(host, `test -f ${READY_FILE}`);
    if (marker.code === 0) return;
    const log = await this.o.ssh.exec(host, "tail -n 40 /var/log/cloud-init-output.log");
    throw new Error(`setup did not finish on ${host}; cloud-init output:\n${log.stdout.trim()}`);
  }

  /**
   * Container jobs run as root, so they leave root-owned files in the runner's
   * `_work`, and a later plain job's checkout then cannot delete them (#4). The
   * runner runs these hooks before and after every job; running before as well
   * as after covers a job that was cancelled or crashed before its own hook
   * ran. The runner user has passwordless sudo (see userdata.ts). The runner
   * reads `.env` when the service starts, so this must precede `svc.sh start`.
   */
  private ownershipHookScript(name: string): string {
    const { runnerUser, runnersDir } = this.o;
    const dir = `${runnersDir}/${name}`;
    const hook = `${dir}/hooks/fix-ownership.sh`;
    const work = `${dir}/_work`;
    return `install -d "$DIR"/hooks
cat > ${shq(hook)} <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
[ -d ${shq(work)} ] || exit 0
sudo -n chown -R ${shq(runnerUser)}:${shq(runnerUser)} ${shq(work)}
HOOK
chmod 0755 ${shq(hook)}
printf '\\n%s\\n%s\\n' ${shq(`ACTIONS_RUNNER_HOOK_JOB_STARTED=${hook}`)} ${shq(`ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${hook}`)} >> "$DIR"/.env
`;
  }

  /**
   * Idempotent: an existing runner of this name is stopped and replaced, so the
   * same script both creates a missing runner and repairs a dead one. The token
   * is on the runner's command line for the moment it runs; that is the runner's
   * documented interface, and it is a short-lived single-purpose token on a
   * single-tenant VM.
   */
  private script(name: string, token: string): string {
    const { repo, labels, runnerUser, runnerTemplateDir, runnersDir } = this.o;
    return `set -euo pipefail
TOKEN=${shq(token)}
NAME=${shq(name)}
DIR=${shq(runnersDir)}/"$NAME"

if [ -d "$DIR" ]; then
  (cd "$DIR" && ./svc.sh stop && ./svc.sh uninstall) || true
fi
rm -rf "$DIR"
install -d -o ${shq(runnerUser)} -g ${shq(runnerUser)} ${shq(runnersDir)}
cp -r ${shq(runnerTemplateDir)} "$DIR"
chown -R ${shq(runnerUser)}:${shq(runnerUser)} "$DIR"

runuser -u ${shq(runnerUser)} -- bash -c 'cd "$1" && ./config.sh --unattended --replace --url "$2" --token "$3" --name "$4" --labels "$5" --work _work' _ \\
  "$DIR" ${shq(`https://github.com/${repo}`)} "$TOKEN" "$NAME" ${shq(labels.join(","))}

${this.ownershipHookScript(name)}
cd "$DIR"
./svc.sh install ${shq(runnerUser)}
./svc.sh start
`;
  }
}
