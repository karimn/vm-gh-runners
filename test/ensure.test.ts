import { describe, expect, test } from "bun:test";
import { ensureServer, type EnsureConfig } from "../src/ensure.ts";
import { MockProvider } from "../src/mock-provider.ts";

const config: EnsureConfig = {
  pool: "ci",
  repo: "karimn/sia",
  serverType: "big",
  image: "ubuntu-24.04",
  location: "nbg1",
  userData: "#cloud-config",
};

const t0 = new Date("2026-01-01T00:00:00Z");

describe("ensureServer", () => {
  test("creates a server when none exists", async () => {
    const p = new MockProvider(() => t0);
    const r = await ensureServer(p, config, t0);

    expect(r.created).toBe(true);
    expect(r.server.labels).toEqual({ pool: "ci", repo: "karimn/sia" });
    expect(p.servers.size).toBe(1);
  });

  test("reuses a running server instead of creating another", async () => {
    const p = new MockProvider(() => t0);
    const first = await ensureServer(p, config, t0);
    const second = await ensureServer(p, config, t0);

    expect(second.created).toBe(false);
    expect(second.server.id).toBe(first.server.id);
    expect(p.servers.size).toBe(1);
  });

  test("ignores servers from another pool or repo", async () => {
    const p = new MockProvider(() => t0);
    await ensureServer(p, { ...config, pool: "other" }, t0);
    await ensureServer(p, { ...config, repo: "karimn/pioneer" }, t0);

    const r = await ensureServer(p, config, t0);
    expect(r.created).toBe(true);
    expect(p.servers.size).toBe(3);
  });

  test("does not reuse a server that is being deleted", async () => {
    const p = new MockProvider(() => t0);
    const first = await ensureServer(p, config, t0);
    p.servers.set(first.server.id, { ...first.server, status: "stopping" });

    const r = await ensureServer(p, config, t0);
    expect(r.created).toBe(true);
    expect(r.server.id).not.toBe(first.server.id);
  });

  test("with several live matches, reuses the oldest and creates nothing", async () => {
    const p = new MockProvider(() => t0);
    const old = await p.createServer({ ...config, name: "old", labels: { pool: "ci", repo: "karimn/sia" } });
    const later = new MockProvider(() => new Date(t0.getTime() + 3_600_000));
    p.servers.set("2", {
      ...(await later.createServer({ ...config, name: "new", labels: { pool: "ci", repo: "karimn/sia" } })),
      id: "2",
    });

    const r = await ensureServer(p, config, t0);
    expect(r.created).toBe(false);
    expect(r.server.id).toBe(old.id);
    expect(p.servers.size).toBe(2);
  });

  test("names servers uniquely from pool, repo and time", async () => {
    const p = new MockProvider(() => t0);
    const r = await ensureServer(p, config, t0);
    expect(r.server.name).toBe("ci-karimn-sia-20260101t000000z");
  });
});
