import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SshResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command on a host. Exit code 255 means the SSH connection itself failed. */
export interface Ssh {
  exec(host: string, command: string, stdin?: string): Promise<SshResult>;
}

export type Spawn = (argv: readonly string[], stdin?: string) => Promise<SshResult>;

const bunSpawn: Spawn = async (argv, stdin) => {
  const proc = Bun.spawn([...argv], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

// IPv4, IPv6 or a hostname; crucially it cannot start with "-" or hold spaces,
// so a host can never be read by ssh as an option.
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/;

export interface SystemSshOptions {
  /** Private key file, mode 0600. The workflow writes the secret here. */
  readonly keyPath: string;
  readonly user?: string;
  /**
   * Where first-connect host keys are recorded. Defaults to a fresh temp file
   * so a reused IP (Hetzner recycles them) never trips a stale-key error. Within
   * one run a later connection is still checked against the first one.
   */
  readonly knownHostsPath?: string;
  readonly spawn?: Spawn;
}

/** Shells out to the system `ssh`, key-only and non-interactive. */
export class SystemSsh implements Ssh {
  private readonly keyPath: string;
  private readonly user: string;
  private readonly knownHostsPath: string;
  private readonly spawn: Spawn;

  constructor(opts: SystemSshOptions) {
    this.keyPath = opts.keyPath;
    this.user = opts.user ?? "root";
    this.knownHostsPath =
      opts.knownHostsPath ?? join(mkdtempSync(join(tmpdir(), "vm-gh-runners-")), "known_hosts");
    this.spawn = opts.spawn ?? bunSpawn;
  }

  async exec(host: string, command: string, stdin?: string): Promise<SshResult> {
    if (!HOST.test(host)) throw new Error(`refusing to connect: invalid host "${host}"`);
    return this.spawn(
      [
        "ssh",
        "-i", this.keyPath,
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        // Trust on first connect: Hetzner does not publish a new server's host key.
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
        "-o", "ConnectTimeout=10",
        "-o", "LogLevel=ERROR",
        `${this.user}@${host}`,
        command,
      ],
      stdin,
    );
  }
}
