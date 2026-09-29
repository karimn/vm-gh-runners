import { describe, expect, test } from "bun:test";
import { ensureServer, serverName, type EnsureConfig } from "../src/ensure.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { serverLabels } from "../src/provider.ts";

const config: EnsureConfig = {
  pool: "ci",
  repo: "karimn/sia",
  serverType: "big",
  image: "ubuntu-24.04",
  location: "nbg1",
  userData: "#cloud-config",
};

const t0 = new Date("2026-01-01T00:00:00Z");
const noWait = { sleep: async () => {}, conflictDelayMs: 0 };

describe("serverName", () => {
  test("is deterministic, so the provider's unique-name rule acts as the lock", () => {
    expect(serverName(config)).toBe(serverName({ ...config }));
  });

  test("is a valid hostname of at most 63 characters, however long the repo", () => {
    for (const repo of ["karimn/sia", `karimn/${"long-repo-name-".repeat(10)}`]) {
      const name = serverName({ ...config, repo });
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });

  test("differs for pools and repos that would slug to the same text", () => {
    const names = [
      serverName({ ...config, repo: "a-b/c" }),
      serverName({ ...config, repo: "a/b-c" }),
      serverName({ ...config, pool: "x-y", repo: "a/b" }),
      serverName({ ...config, pool: "x", repo: "y-a/b" }),
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  test("differs for two long repos that share a long prefix", () => {
    const long = "long-repo-name-".repeat(10);
    expect(serverName({ ...config, repo: `karimn/${long}one` })).not.toBe(
      serverName({ ...config, repo: `karimn/${long}two` }),
    );
  });
});

describe("ensureServer", () => {
  test("creates a server when none exists", async () => {
    const p = new MockProvider(() => t0);
    const r = await ensureServer(p, config, noWait);

    expect(r.created).toBe(true);
    expect(r.server.name).toBe(serverName(config));
    expect(r.server.labels).toEqual({ pool: "ci", repo: "karimn_sia" });
    expect(p.servers.size).toBe(1);
  });

  test("reuses a running server instead of creating another", async () => {
    const p = new MockProvider(() => t0);
    const first = await ensureServer(p, config, noWait);
    const second = await ensureServer(p, config, noWait);

    expect(second.created).toBe(false);
    expect(second.server.id).toBe(first.server.id);
    expect(p.servers.size).toBe(1);
  });

  test("ignores servers from another pool or repo", async () => {
    const p = new MockProvider(() => t0);
    await ensureServer(p, { ...config, pool: "other" }, noWait);
    await ensureServer(p, { ...config, repo: "karimn/pioneer" }, noWait);

    const r = await ensureServer(p, config, noWait);
    expect(r.created).toBe(true);
    expect(p.servers.size).toBe(3);
  });

  test("with several live matches, reuses the oldest and creates nothing", async () => {
    const p = new MockProvider(() => t0);
    const old = await p.createServer({ ...config, name: "old", labels: serverLabels("ci", "karimn/sia") });
    const later = new MockProvider(() => new Date(t0.getTime() + 3_600_000));
    p.servers.set("2", {
      ...(await later.createServer({ ...config, name: "new", labels: serverLabels("ci", "karimn/sia") })),
      id: "2",
    });

    const r = await ensureServer(p, config, noWait);
    expect(r.created).toBe(false);
    expect(r.server.id).toBe(old.id);
    expect(p.servers.size).toBe(2);
  });
});

describe("concurrent callers", () => {
  test("two simultaneous calls end up with one server, one of them creating it", async () => {
    const p = new MockProvider(() => t0);
    const [a, b] = await Promise.all([
      ensureServer(p, config, noWait),
      ensureServer(p, config, noWait),
    ]);

    expect(p.servers.size).toBe(1);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.server.id).toBe(b.server.id);
  });

  test("many simultaneous calls still make exactly one server", async () => {
    const p = new MockProvider(() => t0);
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureServer(p, config, noWait)));

    expect(p.servers.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  test("waits for a server that is still being deleted to release its name, then creates", async () => {
    const p = new MockProvider(() => t0);
    const first = await ensureServer(p, config, noWait);
    p.servers.set(first.server.id, { ...first.server, status: "stopping" });

    let sleeps = 0;
    const r = await ensureServer(p, config, {
      conflictDelayMs: 1,
      // Deletion finishes while we are waiting.
      sleep: async () => {
        if (++sleeps === 2) p.servers.delete(first.server.id);
      },
    });

    expect(r.created).toBe(true);
    expect(r.server.id).not.toBe(first.server.id);
    expect(sleeps).toBe(2);
  });

  test("gives up with a clear error if something else holds the name", async () => {
    const p = new MockProvider(() => t0);
    // A server with our name but not our labels: not ours to reuse, and it never goes away.
    await p.createServer({ ...config, name: serverName(config), labels: { pool: "someone-else" } });

    const err = await ensureServer(p, config, { ...noWait, conflictAttempts: 3 }).catch((e) => e);
    expect(String(err.message)).toContain(serverName(config));
    expect(String(err.message)).toContain("already exists");
  });
});
