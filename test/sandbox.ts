import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs a generated shell script for real, but against a throwaway root and with
 * every system command replaced by a stub that only records its arguments. That
 * makes "what does this boot path actually do" a measurement, not a reading.
 *
 * Paths under /etc, /opt and /var are rewritten into the sandbox. The stubs are
 * the ones the scripts call; anything else (cat, rm, install, sed, seq, touch,
 * printf, uname, date) is the real one.
 */
export interface SandboxRun {
  readonly code: number;
  readonly stderr: string;
  /** One entry per stubbed command, in order: `name arg arg`. */
  readonly commands: readonly string[];
  readonly root: string;
  exists(path: string): boolean;
  read(path: string): string;
}

const STUBS = ["systemctl", "apt-get", "dpkg", "useradd", "usermod", "visudo", "curl", "docker", "sleep"];

const stub = (name: string, body = ""): string => `#!/usr/bin/env bash
echo "${name} $*" >> "$SANDBOX_LOG"
${body}
`;

export const runInSandbox = async (
  script: string,
  setup: (root: string) => void = () => {},
  env: Record<string, string> = {},
): Promise<SandboxRun> => {
  const root = mkdtempSync(join(tmpdir(), "vgr-sandbox-"));
  const bin = join(root, "stubs");
  const log = join(root, "commands.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  // Directories a stock Ubuntu image already has.
  for (const dir of ["etc/apt/apt.conf.d", "etc/sudoers.d", "opt", "var/lib"]) mkdirSync(join(root, dir), { recursive: true });

  const write = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  for (const name of STUBS) write(name, stub(name));
  // No automatic upgrade is running.
  write("pgrep", stub("pgrep", "exit 1"));
  // `id runner` succeeds only if the image already has the user.
  write("id", stub("id", '[ -n "${RUNNER_USER_EXISTS:-}" ]'));
  write("jq", stub("jq", "cat >/dev/null; echo v9.9.9"));
  // The "download": unpack a runner distribution (config.sh and a dependency installer) into -C dir.
  write(
    "tar",
    stub(
      "tar",
      `dir=""; while [ $# -gt 0 ]; do [ "$1" = -C ] && dir="$2"; shift; done
cat >/dev/null
mkdir -p "$dir/bin"
printf '#!/usr/bin/env bash\\necho "installdependencies" >> "$SANDBOX_LOG"\\n' > "$dir/bin/installdependencies.sh"
printf '#!/usr/bin/env bash\\n' > "$dir/config.sh"
chmod +x "$dir/bin/installdependencies.sh" "$dir/config.sh"`,
    ),
  );

  // The finalize script deletes ~/.ssh/authorized_keys and shell history. Rewriting
  // only /etc, /opt and /var would let it do that to the real home directory.
  if (/(^|[\s'"=])(\/home\/|\/root\/|~\/|\$HOME)/m.test(script)) {
    throw new Error("refusing to run a script that touches /home, /root or ~ outside a VM");
  }

  setup(root);

  // Only absolute system paths, never the middle of a URL or an option.
  const sandboxed = script.replace(/(?<![A-Za-z0-9.:/])\/(etc|opt|var)\//g, `${root}/$1/`);
  const file = join(root, "script.sh");
  writeFileSync(file, sandboxed);

  const proc = Bun.spawn(["bash", file], {
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, SANDBOX_LOG: log, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  return {
    code,
    stderr,
    commands: readFileSync(log, "utf8").split("\n").filter(Boolean),
    root,
    exists: (p) => existsSync(join(root, p)),
    read: (p) => readFileSync(join(root, p), "utf8"),
  };
};
