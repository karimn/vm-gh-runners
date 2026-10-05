import type { Ssh, SshResult } from "../src/ssh.ts";

export interface SshCall {
  readonly host: string;
  readonly command: string;
  readonly stdin?: string;
}

const ok: SshResult = { code: 0, stdout: "", stderr: "" };

/**
 * A scripted Ssh for the image builder. `handler` sees every call and returns a
 * result, or undefined for the default (success, empty output).
 */
export class FakeSsh implements Ssh {
  readonly calls: SshCall[] = [];

  constructor(private readonly handler: (call: SshCall) => Partial<SshResult> | undefined = () => undefined) {}

  async exec(host: string, command: string, stdin?: string): Promise<SshResult> {
    const call = { host, command, ...(stdin === undefined ? {} : { stdin }) };
    this.calls.push(call);
    return { ...ok, ...this.handler(call) };
  }

  /** The stdin of every `bash -s` call, in order: the scripts the builder ran. */
  get scripts(): string[] {
    return this.calls.filter((c) => c.command === "bash -s").map((c) => c.stdin ?? "");
  }
}
