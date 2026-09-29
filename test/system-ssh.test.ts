import { describe, expect, test } from "bun:test";
import { SystemSsh, type Spawn } from "../src/ssh.ts";

const recording = (result = { code: 0, stdout: "out", stderr: "err" }) => {
  const calls: { argv: readonly string[]; stdin: string | undefined }[] = [];
  const spawn: Spawn = async (argv, stdin) => {
    calls.push({ argv, stdin });
    return result;
  };
  return { calls, spawn };
};

const make = (spawn: Spawn) =>
  new SystemSsh({ keyPath: "/tmp/ci_key", knownHostsPath: "/tmp/known_hosts", spawn });

describe("SystemSsh", () => {
  test("builds a non-interactive, key-only command line", async () => {
    const { calls, spawn } = recording();
    await make(spawn).exec("203.0.113.7", "cloud-init status --wait");

    const argv = calls[0]!.argv;
    expect(argv[0]).toBe("ssh");
    expect(argv.join(" ")).toContain("-i /tmp/ci_key");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("IdentitiesOnly=yes");
    expect(argv).toContain("StrictHostKeyChecking=accept-new");
    expect(argv).toContain("UserKnownHostsFile=/tmp/known_hosts");
    expect(argv.slice(-2)).toEqual(["root@203.0.113.7", "cloud-init status --wait"]);
  });

  test("passes stdin through and returns code, stdout and stderr", async () => {
    const { calls, spawn } = recording({ code: 3, stdout: "o", stderr: "e" });
    const r = await make(spawn).exec("203.0.113.7", "bash -s", "echo hi");

    expect(calls[0]?.stdin).toBe("echo hi");
    expect(r).toEqual({ code: 3, stdout: "o", stderr: "e" });
  });

  test("refuses a host that could be read as an ssh option", async () => {
    const { calls, spawn } = recording();
    const ssh = make(spawn);
    await expect(ssh.exec("-oProxyCommand=evil", "true")).rejects.toThrow("host");
    await expect(ssh.exec("a b", "true")).rejects.toThrow("host");
    expect(calls).toHaveLength(0);
  });

  test("accepts an IPv6 address", async () => {
    const { spawn } = recording();
    await expect(make(spawn).exec("2001:db8::1", "true")).resolves.toBeDefined();
  });
});
