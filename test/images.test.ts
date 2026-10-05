import { describe, expect, test } from "bun:test";
import { BUILT_IMAGE_REF, imageName, listBuiltImages, pruneImages, resolveImage } from "../src/images.ts";
import { MockProvider } from "../src/mock-provider.ts";

let clock = new Date("2026-10-05T12:00:00Z");
const day = (d: number) => new Date(Date.UTC(2026, 9, d, 3));

/** A provider whose images were created on the given October days, oldest first. */
const withImages = (specs: [name: string, day: number][]) => {
  const provider = new MockProvider(() => clock);
  for (const [name, d] of specs) {
    clock = day(d);
    provider.images.set(`id-${name}`, { id: `id-${name}`, name, createdAt: clock });
  }
  return provider;
};

const cfg = { pool: "ci", image: BUILT_IMAGE_REF, baseImage: "Ubuntu 24.04" };

describe("imageName", () => {
  test("is vgr-<pool>-<yyyymmdd> in UTC", () => {
    expect(imageName("ci", new Date("2026-10-05T23:59:59Z"))).toBe("vgr-ci-20261005");
    expect(imageName("sia-ci", new Date("2026-01-02T00:00:00Z"))).toBe("vgr-sia-ci-20260102");
  });
});

describe("resolveImage", () => {
  test("picks the newest built image of the pool, by id", async () => {
    const provider = withImages([
      ["vgr-ci-20261001", 1],
      ["vgr-ci-20261008", 8],
      ["vgr-ci-20261003", 3],
    ]);
    const r = await resolveImage(provider, cfg);
    expect(r).toEqual({ image: "id-vgr-ci-20261008", built: true, name: "vgr-ci-20261008", builtAt: day(8) });
  });

  test("falls back to the stock image, marked not built, when the pool has none", async () => {
    const r = await resolveImage(withImages([]), cfg);
    expect(r).toEqual({ image: "Ubuntu 24.04", built: false });
  });

  test("uses any other image setting as given, without listing", async () => {
    const provider = withImages([["vgr-ci-20261001", 1]]);
    provider.calls.length = 0;
    expect(await resolveImage(provider, { ...cfg, image: "Debian 12" })).toEqual({ image: "Debian 12", built: false });
    expect(provider.calls).toEqual([]);
  });

  test("ignores other pools, including one whose name extends this pool's", async () => {
    const provider = withImages([
      ["vgr-ci-sia-20261009", 9],
      ["vgr-other-20261010", 10],
      ["vgr-ci-20261002", 2],
      ["vgr-ci-latest", 11],
      ["vgr-ci-20261012-old", 12],
    ]);
    expect((await resolveImage(provider, cfg)).name).toBe("vgr-ci-20261002");
  });

  test("two builds on one day: the later one wins", async () => {
    const provider = new MockProvider();
    provider.images.set("a", { id: "a", name: "vgr-ci-20261005", createdAt: new Date("2026-10-05T01:00:00Z") });
    provider.images.set("b", { id: "b", name: "vgr-ci-20261005", createdAt: new Date("2026-10-05T09:00:00Z") });
    expect((await resolveImage(provider, cfg)).image).toBe("b");
  });

  test("treats regex characters in a pool name literally", async () => {
    const provider = withImages([["vgr-c.-20261001", 1], ["vgr-ci-20261002", 2]]);
    expect((await listBuiltImages(provider, "c.")).map((i) => i.name)).toEqual(["vgr-c.-20261001"]);
  });
});

describe("pruneImages", () => {
  const five = () =>
    withImages([
      ["vgr-ci-20261001", 1],
      ["vgr-ci-20261002", 2],
      ["vgr-ci-20261003", 3],
      ["vgr-ci-20261004", 4],
      ["vgr-ci-20261005", 5],
    ]);

  test("keeps the newest N and deletes the rest", async () => {
    const provider = five();
    const r = await pruneImages(provider, "ci", 2);
    expect([...r.deleted].sort()).toEqual(["vgr-ci-20261001", "vgr-ci-20261002", "vgr-ci-20261003"]);
    expect([...provider.images.values()].map((i) => i.name).sort()).toEqual(["vgr-ci-20261004", "vgr-ci-20261005"]);
  });

  test("deletes nothing when there are no more than N", async () => {
    const provider = five();
    expect((await pruneImages(provider, "ci", 5)).deleted).toEqual([]);
    expect(provider.images.size).toBe(5);
  });

  test("never touches another pool's images or unrelated names", async () => {
    const provider = withImages([
      ["vgr-ci-20261001", 1],
      ["vgr-ci-20261002", 2],
      ["vgr-ci-sia-20260901", 3],
      ["my-snapshot", 4],
    ]);
    await pruneImages(provider, "ci", 1);
    expect([...provider.images.values()].map((i) => i.name).sort()).toEqual([
      "my-snapshot",
      "vgr-ci-20261002",
      "vgr-ci-sia-20260901",
    ]);
  });

  test("one failing delete does not stop the rest, and is reported", async () => {
    const provider = five();
    const real = provider.deleteImage.bind(provider);
    provider.deleteImage = async (id) => {
      if (id === "id-vgr-ci-20261002") throw new Error("glance said no");
      return real(id);
    };
    const r = await pruneImages(provider, "ci", 2);
    expect([...r.deleted].sort()).toEqual(["vgr-ci-20261001", "vgr-ci-20261003"]);
    expect(r.failed).toEqual([{ name: "vgr-ci-20261002", id: "id-vgr-ci-20261002", error: "glance said no" }]);
  });

  test("refuses to keep fewer than one, which would delete the image just built", async () => {
    await expect(pruneImages(five(), "ci", 0)).rejects.toThrow("positive integer");
    await expect(pruneImages(five(), "ci", 1.5)).rejects.toThrow("positive integer");
  });
});
