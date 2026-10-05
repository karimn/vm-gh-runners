import { beforeEach, describe, expect, test } from "bun:test";
import { runEnsure, runReap, runRelease } from "../src/commands.ts";
import { loadEnsureConfig, loadReapConfig, type EnsureCliConfig } from "../src/config.ts";
import { ensureServer, serverName } from "../src/ensure.ts";
import { runnerName } from "../src/github.ts";
import { MockGithub } from "../src/mock-github.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { MockRegistrar } from "../src/mock-registrar.ts";
import { QuotaExceededError, runOf, type Server } from "../src/provider.ts";
import { reap } from "../src/reap.ts";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (m: number) => new Date(t0.getTime() + m * 60_000);

const cfgFor = (runId?: string): EnsureCliConfig => ({
  repo: "karimn/sia", pool: "sia-ci", provider: { kind: "ovh", authUrl: "https://x", credentialId: "i", credentialSecret: "s", region: "R" },
  githubToken: "x", serverType: "t", image: "i", location: "l", runnerCount: 2,
  labels: runId === undefined ? ["vm-gh-runners", "pool-sia-ci"] : ["vm-gh-runners", "pool-sia-ci", `run-${runId}`],
  runnerVersion: "latest", extraPackages: [], sshKeyNames: ["k"], sshPrivateKey: "k",
  ...(runId === undefined ? {} : { runId }),
});

let provider: MockProvider;
let github: MockGithub;
let registrar: MockRegistrar;
const deps = () => ({ provider, github, registrar });
const noWait = { sleep: async () => {}, conflictDelayMs: 0 };

beforeEach(() => {
  provider = new MockProvider(() => t0, "prorated");
  github = new MockGithub();
  registrar = new MockRegistrar(github);
});

let nextServerId = 1;

/** Add a server directly, with two runners, for reap tests that need an age or a busy runner. */
const addServer = async (runId: string | undefined, opts: { busy?: boolean; ageMin?: number } = {}) => {
  const name = serverName({ pool: "sia-ci", repo: "karimn/sia", runId });
  const n = nextServerId++;
  const server: Server = {
    id: `s${n}`,
    name,
    labels: { pool: "sia-ci", repo: "karimn_sia", ...(runId === undefined ? {} : { "vgr-run": runId }) },
    createdAt: at(-(opts.ageMin ?? 0)),
    status: "running",
    address: `192.0.2.${n}`,
  };
  provider.servers.set(server.id, server);
  [1, 2].forEach((i) =>
    github.addRunner({ id: n * 100 + i, name: runnerName(name, i), busy: !!opts.busy && i === 1, status: "online" }),
  );
  return server;
};

describe("ensure with run-id", () => {
  test("two concurrent runs get two servers with different names and disjoint runner labels", async () => {
    const [a, b] = await Promise.all([runEnsure(deps(), cfgFor("111")), runEnsure(deps(), cfgFor("222"))]);

    expect(provider.servers.size).toBe(2);
    expect(a.outputs["server_name"]).not.toBe(b.outputs["server_name"]);
    expect(a.outputs["created"]).toBe("true");
    expect(b.outputs["created"]).toBe("true");
    const la = JSON.parse(a.outputs["runs_on"]!) as string[];
    const lb = JSON.parse(b.outputs["runs_on"]!) as string[];
    expect(la).toContain("run-111");
    expect(lb).toContain("run-222");
    // A job asking for all of a run's labels cannot match the other run's runners.
    expect(la.filter((l) => lb.includes(l)).includes("run-111")).toBe(false);
    expect(lb.includes("run-111")).toBe(false);
    expect(la.includes("run-222")).toBe(false);
  });

  test("runs_on is exactly the run's labels, with no self-hosted", async () => {
    const { outputs } = await runEnsure(deps(), cfgFor("111"));
    expect(JSON.parse(outputs["runs_on"]!)).toEqual(["vm-gh-runners", "pool-sia-ci", "run-111"]);
  });

  test("records the run on the server and keeps the pool label", async () => {
    await runEnsure(deps(), cfgFor("111"));
    const [s] = [...provider.servers.values()];
    expect(s?.labels).toEqual({ pool: "sia-ci", repo: "karimn_sia", "vgr-run": "111" });
  });

  test("a re-run of the same run id reuses the server that is still there", async () => {
    await runEnsure(deps(), cfgFor("111"));
    const again = await runEnsure(deps(), cfgFor("111"));
    expect(provider.servers.size).toBe(1);
    expect(again.outputs["created"]).toBe("false");
  });

  test("a re-run after teardown creates a fresh server under the same name", async () => {
    const first = await runEnsure(deps(), cfgFor("111"));
    await reap(provider, github, { pool: "sia-ci", repo: "karimn/sia", runId: "111" }, at(1));
    const again = await runEnsure(deps(), cfgFor("111"));
    expect(again.outputs["created"]).toBe("true");
    expect(again.outputs["server_name"]).toBe(first.outputs["server_name"]);
  });

  test("shared-pool mode never adopts a per-run server, and the reverse", async () => {
    await runEnsure(deps(), cfgFor("111"));
    const shared = await runEnsure(deps(), cfgFor());
    expect(shared.outputs["created"]).toBe("true");
    expect(provider.servers.size).toBe(2);
    expect(JSON.parse(shared.outputs["runs_on"]!)).toEqual(["vm-gh-runners", "pool-sia-ci"]);
    const again = await runEnsure(deps(), cfgFor());
    expect(again.outputs["server_id"]).toBe(shared.outputs["server_id"]);
  });

  test("with run-id unset the name is exactly what it was before", () => {
    expect(serverName({ pool: "ci", repo: "a/b" })).toBe(serverName({ pool: "ci", repo: "a/b", runId: undefined }));
    expect(serverName({ pool: "ci", repo: "a/b", runId: "1" })).not.toBe(serverName({ pool: "ci", repo: "a/b" }));
  });

  test("fails at once, without retrying, when the project is out of quota", async () => {
    let creates = 0;
    provider.createServer = async () => {
      creates++;
      throw new QuotaExceededError("Quota exceeded for cores");
    };
    const err = await ensureServer(provider, { pool: "p", repo: "a/b", serverType: "t", image: "i", location: "l", userData: "", runId: "1" }, noWait).catch((e) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(creates).toBe(1);
  });
});

describe("config with run-id", () => {
  const env = { VGR_POOL: "sia-ci", VGR_REPO: "karimn/sia", VGR_GITHUB_TOKEN: "t", OS_APPLICATION_CREDENTIAL_ID: "i", OS_APPLICATION_CREDENTIAL_SECRET: "s", VGR_SERVER_TYPE: "t", VGR_SSH_KEY_NAMES: "k", VGR_SSH_PRIVATE_KEY: "p" };

  test("default labels gain run-<id>; the pool label stays", () => {
    expect(loadEnsureConfig({ ...env, VGR_RUN_ID: "37320956332" }).labels).toEqual(["vm-gh-runners", "pool-sia-ci", "run-37320956332"]);
  });

  test("a caller's own labels get run-<id> appended so runs still cannot share runners", () => {
    expect(loadEnsureConfig({ ...env, VGR_RUN_ID: "5", VGR_RUNNER_LABELS: "big" }).labels).toEqual(["big", "run-5"]);
    expect(loadEnsureConfig({ ...env, VGR_RUN_ID: "5", VGR_RUNNER_LABELS: "big,run-5" }).labels).toEqual(["big", "run-5"]);
  });

  test("unset or blank run-id changes nothing", () => {
    for (const VGR_RUN_ID of [undefined, ""]) {
      const c = loadEnsureConfig({ ...env, VGR_RUN_ID });
      expect(c.labels).toEqual(["vm-gh-runners", "pool-sia-ci"]);
      expect(c.runId).toBeUndefined();
    }
  });

  test("rejects a run id that is not digits", () => {
    expect(() => loadEnsureConfig({ ...env, VGR_RUN_ID: "1; rm" })).toThrow("VGR_RUN_ID");
  });

  test("reap reads run-id and max-age-minutes", () => {
    expect(loadReapConfig({ ...env, VGR_RUN_ID: "9", VGR_MAX_AGE_MINUTES: "180" })).toMatchObject({ runId: "9", maxAgeMinutes: 180 });
    expect(loadReapConfig(env).maxAgeMinutes).toBeUndefined();
    expect(() => loadReapConfig({ ...env, VGR_MAX_AGE_MINUTES: "0" })).toThrow("VGR_MAX_AGE_MINUTES");
  });
});

describe("reap with run-id (a run's teardown)", () => {
  const cfg = { pool: "sia-ci", repo: "karimn/sia", runId: "111", currentRunId: 111 };

  test("deletes only its own run's server while another run is active", async () => {
    const a = await addServer("111");
    const b = await addServer("222");
    github.activeRuns = true; // run 222 is in progress; irrelevant to run 111's teardown
    github.runStates.set(222, "active");

    const results = await reap(provider, github, cfg, at(1));

    expect(results.map((r) => [r.serverId, r.action])).toEqual([[a.id, "deleted"]]);
    expect([...provider.servers.keys()]).toEqual([b.id]);
    expect(github.runners.size).toBe(2); // run 222's runners are untouched
    expect(github.calls.some((c) => c.startsWith("hasActiveRuns"))).toBe(false);
  });

  test("does not count its own run as active", async () => {
    await addServer("111");
    github.runStates.set(111, "active");
    const [r] = await reap(provider, github, cfg, at(1));
    expect(r?.action).toBe("deleted");
  });

  test("still keeps the server while one of its runners is busy", async () => {
    await addServer("111", { busy: true });
    const [r] = await reap(provider, github, cfg, at(1));
    expect(r).toMatchObject({ action: "kept", reason: "busy" });
    expect(provider.servers.size).toBe(1);
  });

  test("ignores shared-pool servers", async () => {
    await addServer(undefined);
    expect(await reap(provider, github, cfg, at(1))).toEqual([]);
    expect(provider.servers.size).toBe(1);
  });

  test("on a per-started-hour provider deletes at once: a per-run server will never be reused", async () => {
    provider = new MockProvider(() => t0, "per-started-hour");
    await addServer("111");
    const [r] = await reap(provider, github, cfg, at(2));
    expect(r?.action).toBe("deleted");
  });
});

describe("scheduled reap (no run-id)", () => {
  const cfg = { pool: "sia-ci", repo: "karimn/sia", currentRunId: 999 };

  test("keeps a server whose run is in progress; deletes completed, cancelled and vanished runs", async () => {
    const running = await addServer("1");
    const done = await addServer("2");
    const gone = await addServer("3");
    github.runStates.set(1, "active");
    github.runStates.set(2, "finished"); // completed or cancelled: GitHub reports both as completed
    // run 3 is not in the map: not found

    const results = await reap(provider, github, cfg, at(5));
    const by = Object.fromEntries(results.map((r) => [r.serverId, `${r.action}:${r.reason}`]));

    expect(by[running.id]).toBe("kept:run-active");
    expect(by[done.id]).toBe("deleted:deleted");
    expect(by[gone.id]).toBe("deleted:deleted");
    expect([...provider.servers.keys()]).toEqual([running.id]);
  });

  test("does not use the repo-wide active-runs check for a per-run server", async () => {
    await addServer("2");
    github.activeRuns = true;
    github.runStates.set(2, "finished");
    const [r] = await reap(provider, github, cfg, at(5));
    expect(r?.action).toBe("deleted");
  });

  test("a failed run lookup is reported for that server only, and the others still go", async () => {
    const bad = await addServer("1");
    const done = await addServer("2");
    github.failRunState.add(1);
    const results = await reap(provider, github, cfg, at(5));
    expect(results.find((r) => r.serverId === bad.id)).toMatchObject({ action: "error", reason: "run-check-failed" });
    expect(results.find((r) => r.serverId === done.id)?.action).toBe("deleted");
  });

  test("keeps a run-labelled server with a busy runner even if its run looks finished", async () => {
    await addServer("2", { busy: true });
    github.runStates.set(2, "finished");
    const [r] = await reap(provider, github, cfg, at(5));
    expect(r).toMatchObject({ action: "kept", reason: "busy" });
  });

  test("shared-pool servers keep today's repo-wide behaviour", async () => {
    await addServer(undefined);
    github.activeRuns = true;
    const [r] = await reap(provider, github, cfg, at(5));
    expect(r).toMatchObject({ action: "kept", reason: "active-runs" });
    github.activeRuns = false;
    const [r2] = await reap(provider, github, cfg, at(6));
    expect(r2?.action).toBe("deleted");
  });

  test("max-age deletes an old per-run server whose run is still active, even with a busy runner", async () => {
    const stuck = await addServer("1", { ageMin: 300, busy: true });
    const young = await addServer("2", { ageMin: 10 });
    github.runStates.set(1, "active");
    github.runStates.set(2, "active");

    const results = await reap(provider, github, { ...cfg, maxAgeMinutes: 240 }, t0);

    expect(results.find((r) => r.serverId === stuck.id)).toMatchObject({ action: "deleted", reason: "max-age" });
    expect(results.find((r) => r.serverId === young.id)).toMatchObject({ action: "kept", reason: "run-active" });
  });

  test("max-age is off by default and never applies to shared-pool servers", async () => {
    const old = await addServer("1", { ageMin: 5000 });
    github.runStates.set(1, "active");
    const [r] = await reap(provider, github, cfg, t0);
    expect(r).toMatchObject({ action: "kept", reason: "run-active" });
    expect(old).toBeDefined();
  });
});

describe("release with per-run servers", () => {
  const rel = { pool: "sia-ci", repo: "karimn/sia", newPoolLabel: "released" };

  test("with run-id releases that run's server, drops the run label, and ignores other runs", async () => {
    const a = await runEnsure(deps(), cfgFor("111"));
    await runEnsure(deps(), cfgFor("222"));
    github.activeRuns = true;

    const out = await runRelease(deps(), { ...cfgFor("111"), ...rel, force: false, sshPrivateKey: "k" });

    expect(out.failed).toBe(false);
    const released = provider.servers.get(a.outputs["server_id"]!)!;
    expect(released.labels).toEqual({ pool: "released", repo: "karimn_sia", "released-from": "sia-ci" });
    expect(runOf(released)).toBeUndefined();
    expect(provider.servers.size).toBe(2);
  });

  test("without run-id it does not see per-run servers", async () => {
    await runEnsure(deps(), cfgFor("111"));
    const out = await runRelease(deps(), { ...cfgFor(), ...rel, force: false, sshPrivateKey: "k" });
    expect(out.result).toMatchObject({ action: "refused", reason: "no-server" });
  });

  test("after release a scheduled reap leaves the server alone", async () => {
    await runEnsure(deps(), cfgFor("111"));
    await runRelease(deps(), { ...cfgFor("111"), ...rel, force: false, sshPrivateKey: "k" });
    expect(await runReap(deps(), { ...cfgFor(), githubToken: "x" } as any, at(5))).toMatchObject({ results: [] });
    expect(provider.servers.size).toBe(1);
  });
});
