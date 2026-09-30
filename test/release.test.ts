import { beforeEach, describe, expect, test } from "bun:test";
import { runnerName } from "../src/github.ts";
import { MockGithub } from "../src/mock-github.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { MockRegistrar } from "../src/mock-registrar.ts";
import { serverName } from "../src/ensure.ts";
import { serverLabels } from "../src/provider.ts";
import { release } from "../src/release.ts";

const cfg = { pool: "ci", repo: "karimn/sia", newPoolLabel: "released", currentRunId: 99 };

let provider: MockProvider;
let github: MockGithub;
let registrar: MockRegistrar;

const addServer = async (name = serverName(cfg), busyIds: number[] = []) => {
  const s = await provider.createServer({
    name,
    labels: serverLabels("ci", "karimn/sia"),
    serverType: "t",
    image: "i",
    location: "l",
    userData: "",
  });
  [1, 2].forEach((n) => {
    const id = Number(s.id) * 10 + n;
    github.addRunner({ id, name: runnerName(name, n), busy: busyIds.includes(id), status: "online" });
  });
  return s;
};

const untouched = () => {
  expect(github.runners.size).toBe(2);
  expect(registrar.uninstalled).toHaveLength(0);
  expect(provider.calls.some((c) => c.startsWith("update:"))).toBe(false);
};

beforeEach(() => {
  provider = new MockProvider();
  github = new MockGithub();
  registrar = new MockRegistrar(github);
});

describe("release", () => {
  test("deregisters, uninstalls the services, then relabels and renames, in that order", async () => {
    const s = await addServer();
    const order: string[] = [];
    const dereg = github.deregisterRunner.bind(github);
    github.deregisterRunner = async (id) => (order.push("deregister"), dereg(id));
    const unin = registrar.uninstall.bind(registrar);
    registrar.uninstall = async (srv) => (order.push("uninstall"), unin(srv));
    const upd = provider.updateServer.bind(provider);
    provider.updateServer = async (id, p) => (order.push("update"), upd(id, p));

    const r = await release(provider, github, registrar, cfg);

    expect(r.action).toBe("released");
    expect(order).toEqual(["deregister", "deregister", "uninstall", "update"]);
    expect(github.runners.size).toBe(0);
    expect(registrar.uninstalled.map((x) => x.id)).toEqual([s.id]);
  });

  test("leaves the server invisible to reap and ensure", async () => {
    await addServer();
    const r = await release(provider, github, registrar, cfg);

    expect(await provider.listServers(serverLabels("ci", "karimn/sia"))).toHaveLength(0);
    // The deterministic name is free, so ensure can create a fresh server.
    await expect(
      provider.createServer({ name: serverName(cfg), labels: {}, serverType: "t", image: "i", location: "l", userData: "" }),
    ).resolves.toBeDefined();
    expect(r.name).not.toBe(serverName(cfg));
  });

  test("reports the server id, new name, address and previous name", async () => {
    const s = await addServer();
    const r = await release(provider, github, registrar, cfg);

    expect(r).toMatchObject({ action: "released", reason: "released", serverId: s.id, address: s.address, previousName: s.name });
    expect(r.name).toBe(provider.servers.get(s.id)?.name);
  });

  test("keeps the repo label, moves pool, and records where it came from", async () => {
    const s = await addServer();
    await release(provider, github, registrar, { ...cfg, newPoolLabel: "handed-off" });
    expect(provider.servers.get(s.id)?.labels).toEqual({
      pool: "handed-off",
      repo: "karimn_sia",
      "released-from": "ci",
    });
  });

  test("the new name is a valid hostname even for the longest deterministic name", async () => {
    const longCfg = { ...cfg, pool: "a".repeat(40), repo: `${"b".repeat(30)}/${"c".repeat(30)}` };
    const name = serverName(longCfg);
    expect(name.length).toBe(63);
    const s = await provider.createServer({
      name, labels: serverLabels(longCfg.pool, longCfg.repo), serverType: "t", image: "i", location: "l", userData: "",
    });
    const r = await release(provider, github, registrar, { ...longCfg, newPoolLabel: "Released.Pool_1" });

    expect(r.action).toBe("released");
    expect(r.name!.length).toBeLessThanOrEqual(63);
    expect(r.name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(r.name).toContain(s.id);
    expect(r.name).not.toBe(name);
  });

  test("refuses when a runner is busy, touching nothing", async () => {
    await addServer(undefined, [11]);
    const r = await release(provider, github, registrar, cfg);

    expect(r).toMatchObject({ action: "refused", reason: "busy" });
    untouched();
  });

  test("refuses while the repo has other active runs, excluding our own", async () => {
    await addServer();
    github.activeRuns = true;
    const r = await release(provider, github, registrar, cfg);

    expect(r).toMatchObject({ action: "refused", reason: "active-runs" });
    expect(github.calls).toContain("hasActiveRuns:99");
    untouched();
  });

  test("force skips the active-runs guard", async () => {
    await addServer();
    github.activeRuns = true;
    const r = await release(provider, github, registrar, { ...cfg, force: true });

    expect(r.action).toBe("released");
    expect(github.calls.some((c) => c.startsWith("hasActiveRuns"))).toBe(false);
  });

  test("force cannot release a busy runner: GitHub refuses, and the server stays in the pool", async () => {
    const s = await addServer(undefined, [11]);
    const r = await release(provider, github, registrar, { ...cfg, force: true });

    expect(r).toMatchObject({ action: "error", reason: "deregister-failed" });
    expect(provider.servers.get(s.id)?.labels["pool"]).toBe("ci");
    expect(registrar.uninstalled).toHaveLength(0);
  });

  test("errors when there is nothing to release", async () => {
    const r = await release(provider, github, registrar, cfg);
    expect(r).toMatchObject({ action: "refused", reason: "no-server" });
  });

  test("refuses when it cannot tell which server is meant", async () => {
    await addServer("one");
    await addServer("two");
    const r = await release(provider, github, registrar, cfg);

    expect(r).toMatchObject({ action: "refused", reason: "ambiguous" });
    expect(github.runners.size).toBe(4);
  });

  test("refuses a server that is not running, since it cannot be reached over SSH", async () => {
    const s = await addServer();
    provider.servers.set(s.id, { ...s, status: "off" });
    const r = await release(provider, github, registrar, cfg);

    expect(r).toMatchObject({ action: "refused", reason: "not-running" });
    untouched();
  });

  test("refuses a new pool label equal to the current pool before doing anything", async () => {
    await addServer();
    const r = await release(provider, github, registrar, { ...cfg, newPoolLabel: "ci" });

    expect(r).toMatchObject({ action: "refused", reason: "same-pool" });
    untouched();
  });

  test("a failed deregistration keeps the server in the pool and skips SSH", async () => {
    const s = await addServer();
    github.failDeregister.add(Number(s.id) * 10 + 1);
    const r = await release(provider, github, registrar, cfg);

    expect(r).toMatchObject({ action: "error", reason: "deregister-failed" });
    expect(registrar.uninstalled).toHaveLength(0);
    expect(provider.servers.get(s.id)?.labels["pool"]).toBe("ci");
  });

  test("a failed uninstall keeps the server in the pool, so the next ensure can restore it", async () => {
    const s = await addServer();
    registrar.failUninstallWith = new Error("ssh down");
    const r = await release(provider, github, registrar, cfg);

    expect(r).toMatchObject({ action: "error", reason: "uninstall-failed" });
    expect(r.error).toContain("ssh down");
    expect(provider.servers.get(s.id)?.labels["pool"]).toBe("ci");
    expect(provider.servers.get(s.id)?.name).toBe(s.name);
  });

  test("a failed relabel is reported, saying the runners are already gone", async () => {
    await addServer();
    provider.updateServer = async () => { throw new Error("api down"); };
    const r = await release(provider, github, registrar, cfg);

    expect(r).toMatchObject({ action: "error", reason: "relabel-failed" });
    expect(r.error).toContain("api down");
  });

  test("releases a server that never had runners", async () => {
    await provider.createServer({
      name: "bare", labels: serverLabels("ci", "karimn/sia"), serverType: "t", image: "i", location: "l", userData: "",
    });
    const r = await release(provider, github, registrar, cfg);
    expect(r.action).toBe("released");
  });

  test("leaves other pools' and other repos' servers alone", async () => {
    await addServer();
    const other = await provider.createServer({
      name: "other", labels: serverLabels("ci", "karimn/other"), serverType: "t", image: "i", location: "l", userData: "",
    });
    await release(provider, github, registrar, cfg);
    expect(provider.servers.get(other.id)?.labels["pool"]).toBe("ci");
  });
});
