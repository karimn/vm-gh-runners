import { beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "../src/provider.ts";
import type { Ssh, SshResult } from "../src/ssh.ts";
import { SshRegistrar, shq } from "../src/ssh-registrar.ts";
import { READY_FILE } from "../src/userdata.ts";

const server: Server = {
  id: "1",
  name: "ci-karimn-sia-20260101t000000z",
  labels: {},
  createdAt: new Date("2026-01-01T00:00:00Z"),
  status: "running",
  address: "203.0.113.7",
};

const ok: SshResult = { code: 0, stdout: "", stderr: "" };

interface Call {
  host: string;
  command: string;
  stdin: string | undefined;
}

/** Scripted SSH: `respond` decides each result from the call and its index. */
const fakeSsh = (respond: (c: Call, i: number) => SshResult = () => ok) => {
  const calls: Call[] = [];
  const ssh: Ssh = {
    async exec(host, command, stdin) {
      const call = { host, command, stdin };
      calls.push(call);
      return respond(call, calls.length - 1);
    },
  };
  return { ssh, calls };
};

let tokenCalls: number;
const github = {
  async createRegistrationToken() {
    tokenCalls++;
    return "REG-TOKEN-abc123";
  },
};

const sleeps: number[] = [];
const build = (ssh: Ssh, extra: object = {}) =>
  new SshRegistrar({
    github,
    repo: "karimn/sia",
    ssh,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });

beforeEach(() => {
  tokenCalls = 0;
  sleeps.length = 0;
});

describe("readiness", () => {
  test("waits for cloud-init before registering anything", async () => {
    const { ssh, calls } = fakeSsh();
    await build(ssh).register(server, ["srv-1"]);

    expect(calls[0]?.command).toBe("cloud-init status --wait");
    expect(calls[1]?.command).toBe(`test -f ${READY_FILE}`);
    expect(calls[2]?.command).toBe("bash -s");
    expect(calls.every((c) => c.host === "203.0.113.7")).toBe(true);
  });

  test("refuses a server whose setup did not finish, and shows why", async () => {
    // cloud-init exit 2 ("degraded") can hide a failed setup script, so the
    // marker file is the real signal.
    const { ssh, calls } = fakeSsh((c) => {
      if (c.command === "cloud-init status --wait") return { code: 2, stdout: "", stderr: "" };
      if (c.command.startsWith("test -f")) return { code: 1, stdout: "", stderr: "" };
      if (c.command.startsWith("tail")) return { code: 0, stdout: "E: Unable to locate package docker.io", stderr: "" };
      return ok;
    });
    const err = await build(ssh).register(server, ["srv-1"]).catch((e) => e);

    expect(String(err.message)).toContain("setup did not finish");
    expect(String(err.message)).toContain("Unable to locate package docker.io");
    expect(calls.some((c) => c.command === "bash -s")).toBe(false);
    expect(tokenCalls).toBe(0);
  });

  test("retries while SSH is not up yet (exit 255), then proceeds", async () => {
    const { ssh, calls } = fakeSsh((_, i) => (i < 3 ? { code: 255, stdout: "", stderr: "refused" } : ok));
    await build(ssh, { readyDelayMs: 7 }).register(server, ["srv-1"]);

    expect(calls.filter((c) => c.command === "cloud-init status --wait")).toHaveLength(4);
    expect(sleeps).toEqual([7, 7, 7]);
  });

  test("gives up after the configured attempts", async () => {
    const { ssh } = fakeSsh(() => ({ code: 255, stdout: "", stderr: "refused" }));
    const err = await build(ssh, { readyAttempts: 3 }).register(server, ["srv-1"]).catch((e) => e);

    expect(String(err.message)).toContain("not reachable");
    expect(tokenCalls).toBe(0);
  });

  test("fails fast when cloud-init itself reports an error", async () => {
    const { ssh, calls } = fakeSsh(() => ({ code: 1, stdout: "", stderr: "status: error" }));
    const err = await build(ssh).register(server, ["srv-1"]).catch((e) => e);

    expect(String(err.message)).toContain("cloud-init");
    expect(String(err.message)).toContain("status: error");
    expect(calls).toHaveLength(1);
  });

  test("treats cloud-init's recoverable-error exit (2) as ready", async () => {
    const { ssh } = fakeSsh((c) => (c.command.startsWith("cloud-init") ? { code: 2, stdout: "", stderr: "" } : ok));
    await expect(build(ssh).register(server, ["srv-1"])).resolves.toBeUndefined();
  });

  test("needs a server address", async () => {
    const { ssh, calls } = fakeSsh();
    const { address: _, ...noAddress } = server;
    await expect(build(ssh).register(noAddress, ["srv-1"])).rejects.toThrow("address");
    expect(calls).toHaveLength(0);
  });
});

describe("registration", () => {
  test("fetches one token and registers each runner in its own call", async () => {
    const { ssh, calls } = fakeSsh();
    await build(ssh).register(server, ["srv-1", "srv-2", "srv-3"]);

    expect(tokenCalls).toBe(1);
    const scripts = calls.filter((c) => c.command === "bash -s");
    expect(scripts).toHaveLength(3);
    expect(scripts[1]?.stdin).toContain("srv-2");
  });

  test("script replaces an existing runner, runs unattended, as a non-root user, then starts the service", async () => {
    const { ssh, calls } = fakeSsh();
    await build(ssh, { labels: ["vm-gh-runners", "pool-ci"] }).register(server, ["srv-1"]);

    const script = calls.find((c) => c.command === "bash -s")!.stdin!;
    expect(script).toContain("--unattended");
    expect(script).toContain("--replace");
    expect(script).toContain("https://github.com/karimn/sia");
    expect(script).toContain("vm-gh-runners,pool-ci");
    expect(script).toContain("runuser -u 'runner'");
    expect(script.indexOf("config.sh")).toBeLessThan(script.indexOf("svc.sh start"));
  });

  test("hands the workspace back to the runner user before and after every job (#4)", async () => {
    // Container jobs run as root, so they leave root-owned files in _work that a
    // later plain job's checkout cannot delete.
    const { ssh, calls } = fakeSsh();
    await build(ssh, { runnersDir: "/srv/runners" }).register(server, ["srv-1"]);

    const script = calls.find((c) => c.command === "bash -s")!.stdin!;
    const hook = "/srv/runners/srv-1/hooks/fix-ownership.sh";
    expect(script).toContain(`chown -R 'runner':'runner' '/srv/runners/srv-1/_work'`);
    expect(script).toContain(`'ACTIONS_RUNNER_HOOK_JOB_STARTED=${hook}'`);
    expect(script).toContain(`'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${hook}'`);
    expect(script).toContain(`chmod 0755 '${hook}'`);
    // The service reads .env when it starts, so the hooks must be in place first.
    expect(script.indexOf("ACTIONS_RUNNER_HOOK_JOB_STARTED")).toBeLessThan(script.indexOf("svc.sh start"));
  });

  test("the token travels on stdin only, never in a command line", async () => {
    const { ssh, calls } = fakeSsh();
    await build(ssh).register(server, ["srv-1"]);

    for (const c of calls) expect(c.command).not.toContain("REG-TOKEN");
    expect(calls.find((c) => c.command === "bash -s")!.stdin).toContain("REG-TOKEN-abc123");
  });

  test("a failure names the runner and never echoes the token", async () => {
    const { ssh } = fakeSsh((c) =>
      c.command === "bash -s"
        ? { code: 1, stdout: "", stderr: "Http response code: NotFound from 'POST' REG-TOKEN-abc123" }
        : ok,
    );
    const err = await build(ssh).register(server, ["srv-1"]).catch((e) => e);

    expect(String(err.message)).toContain("srv-1");
    expect(String(err.message)).not.toContain("REG-TOKEN-abc123");
  });

  test("stops at the first runner that fails", async () => {
    const { ssh, calls } = fakeSsh((c) => (c.command === "bash -s" ? { code: 1, stdout: "", stderr: "x" } : ok));
    await build(ssh).register(server, ["srv-1", "srv-2"]).catch(() => {});
    expect(calls.filter((c) => c.command === "bash -s")).toHaveLength(1);
  });
});

describe("input validation happens before any SSH or token request", () => {
  const rejected = async (registrar: SshRegistrar, names: string[]) => {
    await expect(registrar.register(server, names)).rejects.toThrow();
  };

  test("runner names that could break out of the shell", async () => {
    const { ssh, calls } = fakeSsh();
    const r = build(ssh);
    await rejected(r, ["srv-1; rm -rf /"]);
    await rejected(r, ["$(reboot)"]);
    await rejected(r, ["Has Space"]);
    await rejected(r, ["UPPER"]);
    await rejected(r, [""]);
    expect(calls).toHaveLength(0);
    expect(tokenCalls).toBe(0);
  });

  test("labels and repo", async () => {
    const { ssh, calls } = fakeSsh();
    expect(() => build(ssh, { labels: ["ok", "bad label"] })).toThrow("label");
    expect(() => build(ssh, { repo: "no-slash" })).toThrow("repo");
    expect(() => build(ssh, { repo: "a/b; reboot" })).toThrow("repo");
    expect(calls).toHaveLength(0);
  });
});

describe("shq", () => {
  test("single-quotes and escapes embedded quotes", () => {
    expect(shq("plain")).toBe("'plain'");
    expect(shq("it's")).toBe("'it'\\''s'");
    expect(shq("$(x) `y` ;")).toBe("'$(x) `y` ;'");
  });
});
