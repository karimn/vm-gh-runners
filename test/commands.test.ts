import { beforeEach, describe, expect, test } from "bun:test";
import { formatReapResults, formatReleaseResult, runEnsure, runReap, runRelease, toGithubOutput } from "../src/commands.ts";
import type { EnsureCliConfig } from "../src/config.ts";
import { MockGithub } from "../src/mock-github.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { MockRegistrar } from "../src/mock-registrar.ts";
import type { CreateServerSpec } from "../src/provider.ts";
import { serverLabels } from "../src/provider.ts";
import { runnerName } from "../src/github.ts";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (m: number) => new Date(t0.getTime() + m * 60_000);

const ensureCfg: EnsureCliConfig = {
  repo: "karimn/sia",
  pool: "ci",
  provider: { kind: "hetzner", token: "x" },
  githubToken: "x",
  serverType: "cpx62",
  image: "ubuntu-24.04",
  location: "nbg1",
  runnerCount: 2,
  labels: ["vm-gh-runners", "pool-ci"],
  runnerVersion: "latest",
  extraPackages: [],
  sshKeyNames: ["k"],
  sshPrivateKey: "k",
};

let provider: MockProvider;
let github: MockGithub;
let registrar: MockRegistrar;
let specs: CreateServerSpec[];

beforeEach(() => {
  provider = new MockProvider(() => t0);
  const realCreate = provider.createServer.bind(provider);
  specs = [];
  provider.createServer = async (spec) => {
    specs.push(spec);
    return realCreate(spec);
  };
  github = new MockGithub();
  registrar = new MockRegistrar(github);
});

describe("runEnsure", () => {
  test("creates a server with first-boot user-data and registers the runners", async () => {
    const { outputs } = await runEnsure({ provider, github, registrar }, ensureCfg);

    expect(specs).toHaveLength(1);
    expect(specs[0]?.userData.startsWith("#cloud-config")).toBe(true);
    expect(specs[0]).toMatchObject({ serverType: "cpx62", image: "ubuntu-24.04", location: "nbg1" });
    expect(github.runners.size).toBe(2);
    expect(outputs).toMatchObject({ created: "true", registered: "2" });
    expect(outputs["server_id"]).toBe("1");
  });

  test("exposes the labels jobs should target as a JSON runs-on array", async () => {
    const { outputs } = await runEnsure({ provider, github, registrar }, ensureCfg);
    // No `self-hosted`: the runners do not carry it, so jobs must not ask for it.
    expect(JSON.parse(outputs["runs_on"]!)).toEqual(["vm-gh-runners", "pool-ci"]);
  });

  test("reuses the server on a second call and registers nothing", async () => {
    await runEnsure({ provider, github, registrar }, ensureCfg);
    const { outputs } = await runEnsure({ provider, github, registrar }, ensureCfg);

    expect(specs).toHaveLength(1);
    expect(outputs).toMatchObject({ created: "false", registered: "0" });
  });

  test("passes the pinned runner version and extra packages into the setup script", async () => {
    await runEnsure(
      { provider, github, registrar },
      { ...ensureCfg, runnerVersion: "2.321.0", extraPackages: ["build-essential"] },
    );
    expect(specs[0]?.userData).toContain("2.321.0");
    expect(specs[0]?.userData).toContain("build-essential");
  });

  test("never puts a token or key in the user-data", async () => {
    await runEnsure(
      { provider, github, registrar },
      { ...ensureCfg, githubToken: "GH-SECRET", provider: { kind: "hetzner", token: "HZ-SECRET" }, sshPrivateKey: "KEY-SECRET" },
    );
    for (const secret of ["GH-SECRET", "HZ-SECRET", "KEY-SECRET"]) {
      expect(specs[0]?.userData).not.toContain(secret);
    }
  });
});

describe("runReap", () => {
  const cfg = { repo: "karimn/sia", pool: "ci", provider: { kind: "hetzner" as const, token: "x" }, githubToken: "x", currentRunId: 9 };

  const addIdleServer = async () => {
    const s = await provider.createServer({
      name: "srv",
      labels: serverLabels("ci", "karimn/sia"),
      serverType: "t",
      image: "i",
      location: "l",
      userData: "",
    });
    github.addRunner({ id: 1, name: runnerName("srv", 1), busy: false, status: "online" });
    return s;
  };

  test("deletes idle servers in the window and reports the counts", async () => {
    await addIdleServer();
    const r = await runReap({ provider, github }, cfg, at(55));

    expect(r.outputs).toEqual({ deleted: "1", kept: "0", errors: "0" });
    expect(r.failed).toBe(false);
  });

  test("keeps servers outside the window", async () => {
    await addIdleServer();
    const r = await runReap({ provider, github }, cfg, at(10));

    expect(r.outputs).toEqual({ deleted: "0", kept: "1", errors: "0" });
    expect(provider.servers.size).toBe(1);
  });

  test("flags failure when any server could not be handled, so the workflow goes red", async () => {
    await addIdleServer();
    github.failDeregister.add(1);
    const r = await runReap({ provider, github }, cfg, at(55));

    expect(r.outputs["errors"]).toBe("1");
    expect(r.failed).toBe(true);
  });

  test("passes the window start and current run id through", async () => {
    await addIdleServer();
    github.activeRuns = true;
    await runReap({ provider, github }, { ...cfg, windowStartMinute: 30 }, at(40));
    expect(github.calls).toContain("hasActiveRuns:9");
  });
});

describe("formatReapResults", () => {
  test("gives one readable line per server, and says so when there are none", () => {
    expect(formatReapResults([])).toBe("no servers in this pool");
    const text = formatReapResults([
      { serverId: "1", name: "srv", action: "kept", reason: "busy" },
      { serverId: "2", name: "old", action: "error", reason: "delete-failed", error: "api down" },
    ]);
    expect(text).toContain("srv: kept (busy)");
    expect(text).toContain("old: error (delete-failed) api down");
  });
});

describe("toGithubOutput", () => {
  test("writes key=value lines", () => {
    expect(toGithubOutput({ a: "1", b: "two" })).toBe("a=1\nb=two\n");
  });

  test("refuses a value with a newline, which could forge another output", () => {
    expect(() => toGithubOutput({ a: "x\nb=evil" })).toThrow("newline");
  });
});

describe("runRelease", () => {
  const cfg = {
    repo: "karimn/sia", pool: "ci", provider: { kind: "hetzner" as const, token: "x" }, githubToken: "x", sshPrivateKey: "k",
    newPoolLabel: "released", force: false, currentRunId: 9,
  };

  const addServer = () =>
    provider.createServer({
      name: "srv", labels: serverLabels("ci", "karimn/sia"),
      serverType: "t", image: "i", location: "l", userData: "",
    });

  test("outputs the server id, new name and IP, and says billing continues", async () => {
    const s = await addServer();
    const r = await runRelease({ provider, github, registrar }, cfg);

    expect(r.failed).toBe(false);
    expect(r.outputs).toEqual({
      server_id: s.id,
      server_name: `released-${s.id}`,
      server_ip: s.address!,
    });
    expect(r.summary).toContain("billing continues");
    expect(r.summary).toContain("delete");
    expect(r.summary).toContain(s.address!);
  });

  test("a refusal fails the step, names the reason and has no outputs", async () => {
    await addServer();
    github.activeRuns = true;
    const r = await runRelease({ provider, github, registrar }, cfg);

    expect(r.failed).toBe(true);
    expect(r.outputs).toEqual({});
    expect(r.summary).toContain("active-runs");
    expect(r.summary).not.toContain("billing continues");
  });

  test("an error after runners were removed says what state the server is in", async () => {
    await addServer();
    registrar.failUninstallWith = new Error("ssh down");
    const r = await runRelease({ provider, github, registrar }, cfg);

    expect(r.failed).toBe(true);
    expect(r.summary).toContain("ssh down");
    expect(r.summary).toContain("still in the pool");
  });

  test("passes the force flag and run id through", async () => {
    await addServer();
    github.activeRuns = true;
    const r = await runRelease({ provider, github, registrar }, { ...cfg, force: true });
    expect(r.failed).toBe(false);
    expect(formatReleaseResult({ action: "refused", reason: "no-server" })).toContain("no server");
  });
});
