import { describe, expect, test } from "bun:test";
import { MockProvider } from "../src/mock-provider.ts";
import type { CreateServerSpec } from "../src/provider.ts";

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

  test("delete removes the server and rejects unknown ids", async () => {
    const p = new MockProvider();
    const s = await p.createServer(spec("a", { pool: "ci" }));
    await p.deleteServer(s.id);
    expect(await p.listServers({ pool: "ci" })).toEqual([]);
    await expect(p.deleteServer(s.id)).rejects.toThrow("no such server");
  });
});
