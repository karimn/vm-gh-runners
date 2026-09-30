import { describe, expect, test } from "bun:test";
import { MockProvider } from "../src/mock-provider.ts";
import { ServerExistsError, type CreateServerSpec } from "../src/provider.ts";

const spec = (name: string, labels: Record<string, string>): CreateServerSpec => ({
  name,
  labels,
  serverType: "test",
  image: "test",
  location: "test",
  userData: "",
});

describe("MockProvider", () => {
  test("lists only servers matching every selector label", async () => {
    const p = new MockProvider();
    await p.createServer(spec("a", { pool: "ci", repo: "x" }));
    await p.createServer(spec("b", { pool: "ci", repo: "y" }));
    await p.createServer(spec("c", { pool: "other", repo: "x" }));

    const found = await p.listServers({ pool: "ci", repo: "x" });
    expect(found.map((s) => s.name)).toEqual(["a"]);
  });

  test("records creation time from the injected clock", async () => {
    const t = new Date("2026-01-01T00:00:00Z");
    const p = new MockProvider(() => t);
    const s = await p.createServer(spec("a", {}));
    expect(s.createdAt).toEqual(t);
  });

  test("refuses a second server with the same name, as a real provider does", async () => {
    const p = new MockProvider();
    await p.createServer(spec("dup", {}));
    await expect(p.createServer(spec("dup", {}))).rejects.toBeInstanceOf(ServerExistsError);
    expect(p.servers.size).toBe(1);
  });

  test("delete removes the server and rejects unknown ids", async () => {
    const p = new MockProvider();
    const s = await p.createServer(spec("a", { pool: "ci" }));
    await p.deleteServer(s.id);
    expect(await p.listServers({ pool: "ci" })).toEqual([]);
    await expect(p.deleteServer(s.id)).rejects.toThrow("no such server");
  });

  test("update replaces the labels and renames, so the old selector and name no longer match", async () => {
    const p = new MockProvider();
    const a = await p.createServer(spec("a", { pool: "ci", repo: "x" }));
    const updated = await p.updateServer(a.id, { name: "b", labels: { pool: "released", repo: "x" } });

    expect(updated.name).toBe("b");
    expect(updated.id).toBe(a.id);
    expect(await p.listServers({ pool: "ci" })).toHaveLength(0);
    expect(await p.listServers({ pool: "released" })).toHaveLength(1);
    // The old name is free again, which is what ensure's lock relies on.
    await expect(p.createServer(spec("a", {}))).resolves.toBeDefined();
  });

  test("update refuses a name another server holds, and rejects unknown ids", async () => {
    const p = new MockProvider();
    await p.createServer(spec("a", {}));
    const b = await p.createServer(spec("b", {}));

    await expect(p.updateServer(b.id, { name: "a", labels: {} })).rejects.toBeInstanceOf(ServerExistsError);
    await expect(p.updateServer("99", { name: "z", labels: {} })).rejects.toThrow("99");
  });
});
