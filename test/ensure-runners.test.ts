import { beforeEach, describe, expect, test } from "bun:test";
import { ensureReady, ensureRunners } from "../src/ensure.ts";
import { runnerName } from "../src/github.ts";
import { MockGithub } from "../src/mock-github.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { MockRegistrar } from "../src/mock-registrar.ts";
import { reap } from "../src/reap.ts";
import type { Server } from "../src/provider.ts";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (m: number) => new Date(t0.getTime() + m * 60_000);
const cfg = {
  pool: "ci",
  repo: "karimn/sia",
  serverType: "t",
  image: "i",
  location: "l",
  userData: "",
  runnerCount: 3,
};

const server: Server = {
  id: "1",
  name: "srv",
  labels: {},
  createdAt: t0,
  status: "running",
};

let github: MockGithub;
let registrar: MockRegistrar;

const online = (id: number, name: string) =>
  github.addRunner({ id, name, busy: false, status: "online" });

beforeEach(() => {
  github = new MockGithub();
  registrar = new MockRegistrar(github);
});

describe("ensureRunners", () => {
  test("registers all runners on a server that has none", async () => {
    const r = await ensureRunners(github, registrar, server, 3);

    expect(r.registered).toEqual(["srv-1", "srv-2", "srv-3"]);
    expect(registrar.calls).toEqual([["srv-1", "srv-2", "srv-3"]]);
  });

  test("does nothing when every runner is registered and online", async () => {
    [1, 2, 3].forEach((n) => online(n, runnerName("srv", n)));
    const r = await ensureRunners(github, registrar, server, 3);

    expect(r.registered).toEqual([]);
    expect(registrar.calls).toEqual([]);
  });

  test("registers only the missing runners", async () => {
    online(1, "srv-1");
    online(3, "srv-3");
    const r = await ensureRunners(github, registrar, server, 3);

    expect(r.registered).toEqual(["srv-2"]);
  });

  test("re-registers a runner that is registered but offline", async () => {
    online(1, "srv-1");
    github.addRunner({ id: 2, name: "srv-2", busy: false, status: "offline" });
    online(3, "srv-3");

    const r = await ensureRunners(github, registrar, server, 3);
    expect(r.registered).toEqual(["srv-2"]);
  });

  test("ignores runners that belong to other servers", async () => {
    online(1, "other-1");
    online(2, "other-2");
    const r = await ensureRunners(github, registrar, server, 2);

    expect(r.registered).toEqual(["srv-1", "srv-2"]);
  });

  test("rejects a runner count below one", async () => {
    await expect(ensureRunners(github, registrar, server, 0)).rejects.toThrow("runnerCount");
  });
});

describe("ensureReady", () => {
  test("creates a server and registers all its runners", async () => {
    const provider = new MockProvider(() => t0);
    const r = await ensureReady(provider, github, registrar, cfg);

    expect(r.created).toBe(true);
    expect(r.registered).toHaveLength(3);
    expect(github.runners.size).toBe(3);
  });

  test("on a reused server registers nothing when it is already complete", async () => {
    const provider = new MockProvider(() => t0);
    await ensureReady(provider, github, registrar, cfg);
    registrar.calls.length = 0;

    const r = await ensureReady(provider, github, registrar, cfg);
    expect(r.created).toBe(false);
    expect(r.registered).toEqual([]);
    expect(registrar.calls).toEqual([]);
  });

  test("propagates a registration failure", async () => {
    const provider = new MockProvider(() => t0);
    registrar.failWith = new Error("ssh unreachable");

    await expect(ensureReady(provider, github, registrar, cfg)).rejects.toThrow("ssh unreachable");
  });

  test("keeps a server whose registration failed and retries on it next time", async () => {
    const provider = new MockProvider(() => t0);
    registrar.failWith = new Error("ssh unreachable");
    await expect(ensureReady(provider, github, registrar, cfg)).rejects.toThrow();
    expect(provider.servers.size).toBe(1);

    registrar.failWith = undefined;
    const retry = await ensureReady(provider, github, registrar, cfg);
    expect(retry.created).toBe(false);
    expect(provider.servers.size).toBe(1);
    expect(github.runners.size).toBe(3);
  });

  test("restores the runners a partly failed reap removed", async () => {
    const provider = new MockProvider(() => t0);
    const first = await ensureReady(provider, github, registrar, cfg);

    // A reap in the window that can remove runner 2 of 3 but not runner 3.
    const ids = [...github.runners.keys()];
    github.failDeregister.add(ids[2]!);
    const [res] = await reap(provider, github, { pool: "ci", repo: "karimn/sia" }, at(55));
    expect(res?.reason).toBe("deregister-failed");
    expect(github.runners.size).toBeLessThan(3);
    github.failDeregister.clear();

    const again = await ensureReady(provider, github, registrar, cfg);
    expect(again.created).toBe(false);
    expect(again.server.id).toBe(first.server.id);
    expect(github.runners.size).toBe(3);
  });
});
