import { beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "../src/provider.ts";
import type { Ssh, SshResult } from "../src/ssh.ts";
import { SshRegistrar, shq } from "../src/ssh-registrar.ts";
import { READY_FILE } from "../src/userdata.ts";
import { configInvocation } from "./config-invocation.ts";

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

  test("registers with only the given labels, never GitHub's defaults", async () => {
    // With the default `self-hosted` label, any `runs-on: self-hosted` job in the
    // repo, from any run, could be scheduled on this VM.
    const { ssh, calls } = fakeSsh();
    await build(ssh, { labels: ["vm-gh-runners", "pool-ci", "run-42"] }).register(server, ["srv-1"]);

    const script = calls.find((c) => c.command === "bash -s")!.stdin!;
    const { configCmd, labelsArg } = configInvocation(script);
    expect(configCmd).toContain(" --no-default-labels ");
    expect(configCmd).toContain(' --labels "$5" ');
    expect(labelsArg).toBe("vm-gh-runners,pool-ci,run-42");
  });

  test("refuses an empty label set, which config.sh rejects with --no-default-labels", () => {
    expect(() => build(fakeSsh().ssh, { labels: [] })).toThrow("at least one label");
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

describe("uninstall", () => {
  test("stops and uninstalls every runner service in one call, without waiting for cloud-init", async () => {
    const { ssh, calls } = fakeSsh();
    await build(ssh).uninstall(server);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.host).toBe("203.0.113.7");
    const script = calls[0]?.stdin ?? "";
    expect(script).toContain("/home/runner/runners");
    expect(script).toContain("./svc.sh stop");
    expect(script).toContain("./svc.sh uninstall");
    expect(tokenCalls).toBe(0);
    expect(sleeps).toHaveLength(0);
  });

  test("a failure surfaces, and names the exit code", async () => {
    const { ssh } = fakeSsh(() => ({ code: 3, stdout: "", stderr: "unit busy" }));
    const err = await build(ssh).uninstall(server).catch((e) => e);
    expect(err.message).toContain("exit 3");
    expect(err.message).toContain("unit busy");
  });

  test("the script really stops and uninstalls each installed runner, skips the rest, and fails if one fails", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "uninstall-"));
    const runner = (name: string, svc: string, installed = true) => {
      const dir = join(root, name);
      mkdirSync(dir);
      if (installed) writeFileSync(join(dir, ".service"), "x");
      writeFileSync(join(dir, "svc.sh"), `#!/bin/bash\n${svc}\n`);
      chmodSync(join(dir, "svc.sh"), 0o755);
      return dir;
    };
    const log = join(root, "log");
    const a = runner("a", `echo "a $1" >> ${log}`);
    const b = runner("b", `echo "b $1" >> ${log}; [ "$1" = stop ] && exit 1 || true`);
    const c = runner("c", `echo "c $1" >> ${log}`);
    runner("never-installed", `echo "n $1" >> ${log}`, false);

    const local: Ssh = {
      async exec(_h, _cmd, stdin) {
        const p = Bun.spawn(["bash", "-s"], { stdin: new TextEncoder().encode(stdin ?? ""), stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        return { code, stdout, stderr };
      },
    };
    const err = await build(local, { runnersDir: root }).uninstall(server).catch((e) => e);

    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["a stop", "a uninstall", "b stop", "c stop", "c uninstall"]);
    expect(err.message).toContain(b);
    expect(err.message).not.toContain(a);
    expect(err.message).not.toContain(c);
  });

  test("needs a server address", async () => {
    const { ssh, calls } = fakeSsh();
    await expect(build(ssh).uninstall({ ...server, address: undefined })).rejects.toThrow("no address");
    expect(calls).toHaveLength(0);
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
