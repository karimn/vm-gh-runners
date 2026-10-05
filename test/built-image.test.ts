import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILDER_LABEL, STALE_BUILDER_MINUTES } from "../src/build-image.ts";
import { main, type Factory } from "../src/cli.ts";
import { runEnsure, runReap } from "../src/commands.ts";
import { loadBuildImageConfig, loadEnsureConfig, type EnsureCliConfig } from "../src/config.ts";
import { MockGithub } from "../src/mock-github.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { MockRegistrar } from "../src/mock-registrar.ts";
import type { CreateServerSpec } from "../src/provider.ts";
import { BAKED_FILE } from "../src/userdata.ts";
import { FakeSsh } from "./fake-ssh.ts";

const now = new Date("2026-10-05T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

const cfg: EnsureCliConfig = {
  repo: "karimn/sia",
  pool: "ci",
  provider: { kind: "ovh", authUrl: "https://x", credentialId: "i", credentialSecret: "s", region: "R" },
  githubToken: "x",
  serverType: "b3-32",
  image: "latest-built",
  baseImage: "Ubuntu 24.04",
  maxImageAgeDays: 14,
  location: "R",
  runnerCount: 2,
  labels: ["vm-gh-runners", "pool-ci"],
  runnerVersion: "2.337.0",
  extraPackages: [],
  sshKeyNames: ["k"],
  sshPrivateKey: "k",
};

const setup = (images: [name: string, ageDays: number][] = []) => {
  const provider = new MockProvider(() => now, "prorated");
  for (const [name, age] of images) provider.images.set(`id-${name}`, { id: `id-${name}`, name, createdAt: daysAgo(age) });
  const specs: CreateServerSpec[] = [];
  const real = provider.createServer.bind(provider);
  provider.createServer = async (spec) => (specs.push(spec), real(spec));
  const github = new MockGithub();
  return { provider, specs, deps: { provider, github, registrar: new MockRegistrar(github) } };
};

describe("ensure with image latest-built", () => {
  test("boots the newest built image, by id", async () => {
    const t = setup([["vgr-ci-karimn_sia-20260928", 7], ["vgr-ci-karimn_sia-20261003", 2]]);
    const { outputs, summary } = await runEnsure(t.deps, cfg, { now: () => now });

    expect(t.specs).toHaveLength(1);
    expect(t.specs[0]!.image).toBe("id-vgr-ci-karimn_sia-20261003");
    expect(outputs["image"]).toBe("vgr-ci-karimn_sia-20261003");
    expect(outputs["image_built"]).toBe("true");
    expect(summary).toContain("image: vgr-ci-karimn_sia-20261003 (built)");
    expect(summary).not.toContain("::warning::");
  });

  test("falls back to the stock image, and warns, when no image has been built", async () => {
    const t = setup([["vgr-other-20261003", 1]]);
    const { outputs, summary } = await runEnsure(t.deps, cfg, { now: () => now });

    expect(t.specs[0]!.image).toBe("Ubuntu 24.04");
    expect(outputs["image_built"]).toBe("false");
    expect(summary).toContain('::warning::no built image for pool "ci"');
  });

  test("boots a built image with the same user-data as a stock one: the script decides at boot", async () => {
    const built = setup([["vgr-ci-karimn_sia-20261003", 2]]);
    const stock = setup();
    await runEnsure(built.deps, cfg, { now: () => now });
    await runEnsure(stock.deps, cfg, { now: () => now });
    expect(built.specs[0]!.userData).toBe(stock.specs[0]!.userData);
    expect(built.specs[0]!.userData).toContain(BAKED_FILE);
  });

  test("warns, and still boots it, when the newest image is older than the limit", async () => {
    const t = setup([["vgr-ci-karimn_sia-20260915", 20]]);
    const { summary } = await runEnsure(t.deps, cfg, { now: () => now });
    expect(t.specs[0]!.image).toBe("id-vgr-ci-karimn_sia-20260915");
    expect(summary).toContain("::warning::the newest built image vgr-ci-karimn_sia-20260915 is 20 days old (limit 14)");
    expect(summary).toContain("build-image workflow");
  });

  test("does not warn at the limit", async () => {
    const t = setup([["vgr-ci-karimn_sia-20260921", 14]]);
    expect((await runEnsure(t.deps, cfg, { now: () => now })).summary).not.toContain("::warning::");
  });

  test("a failed image lookup falls back to the stock image rather than failing CI", async () => {
    const t = setup();
    t.provider.listImages = async () => {
      throw new Error("glance 503");
    };
    const { summary } = await runEnsure(t.deps, cfg, { now: () => now });
    expect(t.specs[0]!.image).toBe("Ubuntu 24.04");
    expect(summary).toContain("::warning::could not look up built images (glance 503)");
  });

  test("an explicit image is used as given and no image is listed", async () => {
    const t = setup([["vgr-ci-karimn_sia-20261003", 2]]);
    const { outputs, summary } = await runEnsure(t.deps, { ...cfg, image: "Ubuntu 22.04" }, { now: () => now });
    expect(t.specs[0]!.image).toBe("Ubuntu 22.04");
    expect(t.provider.calls).not.toContain("listImages");
    expect(outputs["image_built"]).toBe("false");
    expect(summary).not.toContain("::warning::");
  });

  test("a reused server is left alone and the summary names no image for it", async () => {
    const t = setup([["vgr-ci-karimn_sia-20261003", 2]]);
    await runEnsure(t.deps, cfg, { now: () => now });
    const second = await runEnsure(t.deps, cfg, { now: () => now });
    expect(t.specs).toHaveLength(1);
    expect(second.summary).not.toContain("image:");
    expect(second.outputs["image"]).toBe("");
    expect(second.outputs["image_built"]).toBe("");
  });

  test("still registers the run's runners on a built image", async () => {
    const t = setup([["vgr-ci-karimn_sia-20261003", 2]]);
    const { outputs } = await runEnsure(t.deps, cfg, { now: () => now });
    expect(outputs["registered"]).toBe("2");
    expect(t.deps.registrar.calls).toHaveLength(1);
  });
});

describe("loadEnsureConfig image settings", () => {
  const env = {
    GITHUB_REPOSITORY: "karimn/sia",
    VGR_POOL: "ci",
    VGR_PROVIDER: "ovh",
    OS_APPLICATION_CREDENTIAL_ID: "i",
    OS_APPLICATION_CREDENTIAL_SECRET: "s",
    VGR_GITHUB_TOKEN: "g",
    VGR_SERVER_TYPE: "b3-32",
    VGR_SSH_KEY_NAMES: "k",
    VGR_SSH_PRIVATE_KEY: "KEY",
  };

  test("accepts latest-built on ovh, with the stock image as the fallback and a 14 day limit", () => {
    const c = loadEnsureConfig({ ...env, VGR_IMAGE: "latest-built" });
    expect(c).toMatchObject({ image: "latest-built", baseImage: "Ubuntu 24.04", maxImageAgeDays: 14 });
  });

  test("takes the fallback image and the age limit from the environment", () => {
    const c = loadEnsureConfig({ ...env, VGR_IMAGE: "latest-built", VGR_BASE_IMAGE: "Ubuntu 22.04", VGR_MAX_IMAGE_AGE_DAYS: "9" });
    expect(c).toMatchObject({ baseImage: "Ubuntu 22.04", maxImageAgeDays: 9 });
  });

  test("treats blank inputs, as Actions passes them, as the defaults", () => {
    expect(loadEnsureConfig({ ...env, VGR_BASE_IMAGE: "", VGR_MAX_IMAGE_AGE_DAYS: "" })).toMatchObject({
      image: "Ubuntu 24.04",
      maxImageAgeDays: 14,
    });
  });

  test("rejects latest-built on Hetzner, which cannot build images", () => {
    expect(() =>
      loadEnsureConfig({ ...env, VGR_PROVIDER: "hetzner", HCLOUD_TOKEN: "t", VGR_IMAGE: "latest-built" }),
    ).toThrow("only supported on ovh");
  });

  test("rejects a bad age limit", () => {
    expect(() => loadEnsureConfig({ ...env, VGR_MAX_IMAGE_AGE_DAYS: "0" })).toThrow("VGR_MAX_IMAGE_AGE_DAYS");
  });
});

describe("loadBuildImageConfig", () => {
  const env = {
    GITHUB_REPOSITORY: "karimn/sia",
    VGR_POOL: "ci",
    OS_APPLICATION_CREDENTIAL_ID: "i",
    OS_APPLICATION_CREDENTIAL_SECRET: "s",
    VGR_SERVER_TYPE: "b3-8",
    VGR_SSH_KEY_NAMES: "k",
    VGR_SSH_PRIVATE_KEY: "KEY",
  };

  test("reads required values and applies defaults; needs no GitHub token", () => {
    expect(loadBuildImageConfig(env)).toEqual({
      pool: "ci",
      repo: "karimn/sia",
      provider: { kind: "ovh", authUrl: "https://auth.cloud.ovh.us/v3", credentialId: "i", credentialSecret: "s", region: "US-EAST-VA-1" },
      serverType: "b3-8",
      baseImage: "Ubuntu 24.04",
      location: "US-EAST-VA-1",
      runnerVersion: "latest",
      extraPackages: [],
      prepullImages: [],
      keep: 2,
      sshKeyNames: ["k"],
      sshPrivateKey: "KEY",
    });
  });

  test("takes the repo from VGR_REPO over GITHUB_REPOSITORY, and requires owner/name", () => {
    expect(loadBuildImageConfig({ ...env, VGR_REPO: "karimn/other" }).repo).toBe("karimn/other");
    expect(() => loadBuildImageConfig({ ...env, VGR_REPO: "nope" })).toThrow("owner/name");
    const { GITHUB_REPOSITORY: _omit, ...none } = env;
    expect(() => loadBuildImageConfig(none)).toThrow("GITHUB_REPOSITORY");
  });

  test("splits pre-pull images on newlines and commas", () => {
    const c = loadBuildImageConfig({ ...env, VGR_PREPULL_IMAGES: "ghcr.io/o/a:1\nghcr.io/o/b:2, alpine:3\n\n" });
    expect(c.prepullImages).toEqual(["ghcr.io/o/a:1", "ghcr.io/o/b:2", "alpine:3"]);
  });

  test("builds a registry login from username and password, defaulting the host to ghcr.io", () => {
    expect(loadBuildImageConfig({ ...env, VGR_REGISTRY_USERNAME: "u", VGR_REGISTRY_PASSWORD: "p" }).registry).toEqual({
      host: "ghcr.io",
      username: "u",
      password: "p",
    });
    expect(
      loadBuildImageConfig({ ...env, VGR_REGISTRY: "registry.example.com", VGR_REGISTRY_USERNAME: "u", VGR_REGISTRY_PASSWORD: "p" }).registry?.host,
    ).toBe("registry.example.com");
  });

  test("rejects a username without a password and the reverse, which is a mistake not 'public images'", () => {
    expect(() => loadBuildImageConfig({ ...env, VGR_REGISTRY_USERNAME: "u" })).toThrow("together");
    expect(() => loadBuildImageConfig({ ...env, VGR_REGISTRY_PASSWORD: "p" })).toThrow("together");
  });

  test("blank inputs, as Actions passes them, mean no login", () => {
    expect(loadBuildImageConfig({ ...env, VGR_REGISTRY: "", VGR_REGISTRY_USERNAME: "", VGR_REGISTRY_PASSWORD: "" }).registry).toBeUndefined();
  });

  test("keeps 2 by default, takes a number, and refuses fewer than 2 (a concurrent ensure may have just resolved the older image)", () => {
    expect(loadBuildImageConfig({ ...env, VGR_KEEP_IMAGES: "3" }).keep).toBe(3);
    expect(() => loadBuildImageConfig({ ...env, VGR_KEEP_IMAGES: "1" })).toThrow("VGR_KEEP_IMAGES");
    expect(() => loadBuildImageConfig({ ...env, VGR_KEEP_IMAGES: "0" })).toThrow("VGR_KEEP_IMAGES");
  });

  test("is OVH only, and takes exactly one key pair", () => {
    expect(() => loadBuildImageConfig({ ...env, VGR_PROVIDER: "hetzner", HCLOUD_TOKEN: "t" })).toThrow("only supported on ovh");
    expect(() => loadBuildImageConfig({ ...env, VGR_SSH_KEY_NAMES: "a,b" })).toThrow("exactly one");
  });

  test("applies the runner version floor", () => {
    expect(() => loadBuildImageConfig({ ...env, VGR_RUNNER_VERSION: "2.300.0" })).toThrow("at least 2.305.0");
  });
});

describe("cli build-image", () => {
  const env = {
    GITHUB_REPOSITORY: "karimn/sia",
    VGR_POOL: "ci",
    OS_APPLICATION_CREDENTIAL_ID: "i",
    OS_APPLICATION_CREDENTIAL_SECRET: "s",
    VGR_SERVER_TYPE: "b3-8",
    VGR_SSH_KEY_NAMES: "k",
    VGR_SSH_PRIVATE_KEY: "KEY",
  };

  const factoryFor = (provider: MockProvider, ssh: FakeSsh) => {
    let disposed = false;
    const unused = async () => {
      throw new Error("not used");
    };
    const factory: Factory = {
      ensure: unused,
      reap: unused,
      release: unused,
      buildImage: async () => ({ provider, ssh, dispose: () => void (disposed = true) }),
    };
    return { factory, disposed: () => disposed };
  };
  const quickSsh = () => new FakeSsh((c) => (c.command === "test -f /var/run/reboot-required" ? { code: 1 } : undefined));

  test("builds, logs, writes step outputs, disposes, and exits 0", async () => {
    const provider = new MockProvider(() => now, "prorated");
    const out = join(mkdtempSync(join(tmpdir(), "bi-")), "out");
    const lines: string[] = [];
    const f = factoryFor(provider, quickSsh());

    const code = await main(["build-image"], { ...env, GITHUB_OUTPUT: out }, f.factory, (l) => void lines.push(l));

    expect(code).toBe(0);
    const written = readFileSync(out, "utf8");
    expect(written).toMatch(/image_name=vgr-ci-karimn_sia-\d{8}\n/);
    expect(written).toContain("pruned=0");
    expect(lines.join("\n")).toContain("built image vgr-ci-karimn_sia-");
    expect(f.disposed()).toBe(true);
    expect(provider.servers.size).toBe(0);
  });

  test("exits 1 and names the failure when the build fails, with the server deleted and the key file disposed", async () => {
    const provider = new MockProvider(() => now, "prorated");
    const lines: string[] = [];
    const f = factoryFor(provider, new FakeSsh((c) => (c.stdin?.includes("dist-upgrade") ? { code: 100, stderr: "E: broken" } : undefined)));

    const code = await main(["build-image"], env, f.factory, (l) => void lines.push(l));

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("baking failed");
    expect(f.disposed()).toBe(true);
    expect(provider.servers.size).toBe(0);
  });

  test("exits 1 when an old image could not be pruned, so growing storage is noticed", async () => {
    const provider = new MockProvider(() => now, "prorated");
    for (const n of ["20260101", "20260102", "20260103"]) provider.images.set(n, { id: n, name: `vgr-ci-karimn_sia-${n}`, createdAt: daysAgo(100) });
    provider.failDeleteImageWith = new Error("glance said no");
    const lines: string[] = [];
    const code = await main(["build-image"], { ...env, VGR_KEEP_IMAGES: "2" }, factoryFor(provider, quickSsh()).factory, (l) => void lines.push(l));
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("could not delete image vgr-ci-karimn_sia-20260101");
  });

  test("a config error exits 1 before building anything", async () => {
    const provider = new MockProvider(() => now, "prorated");
    const { VGR_SERVER_TYPE: _omit, ...missing } = env;
    expect(await main(["build-image"], missing, factoryFor(provider, quickSsh()).factory, () => {})).toBe(1);
    expect(provider.calls).toEqual([]);
  });

  test("the usage line names the command", async () => {
    const lines: string[] = [];
    expect(await main([], {}, factoryFor(new MockProvider(), quickSsh()).factory, (l) => void lines.push(l))).toBe(2);
    expect(lines[0]).toContain("build-image");
  });
});

describe("reap and stale builders", () => {
  const reapCfg = { repo: "karimn/sia", pool: "ci", provider: { kind: "ovh" as const, authUrl: "https://x", credentialId: "i", credentialSecret: "s", region: "R" }, githubToken: "x" };

  const addBuilder = (provider: MockProvider, name: string, ageMinutes: number) => {
    provider.servers.set(name, {
      id: name,
      name,
      labels: { [BUILDER_LABEL]: "ci" },
      createdAt: new Date(now.getTime() - ageMinutes * 60_000),
      status: "running",
      address: "192.0.2.1",
    });
  };

  test("deletes a builder a killed build left behind, and reports it", async () => {
    const provider = new MockProvider(() => now, "prorated");
    addBuilder(provider, "vgr-build-ci-dead", STALE_BUILDER_MINUTES + 5);
    const r = await runReap({ provider, github: new MockGithub() }, reapCfg, now);
    expect(provider.servers.size).toBe(0);
    expect(r.results).toEqual([{ serverId: "", name: "vgr-build-ci-dead", action: "deleted", reason: "stale-builder" }]);
    expect(r.outputs["deleted"]).toBe("1");
    expect(r.failed).toBe(false);
  });

  test("leaves a builder that is still within a normal build alone", async () => {
    const provider = new MockProvider(() => now, "prorated");
    addBuilder(provider, "vgr-build-ci-live", 25);
    await runReap({ provider, github: new MockGithub() }, reapCfg, now);
    expect(provider.servers.size).toBe(1);
  });

  test("never mistakes a builder for a pool server: it has no pool label, so reap's own logic ignores it", async () => {
    const provider = new MockProvider(() => now, "prorated");
    addBuilder(provider, "vgr-build-ci-live", 25);
    const r = await runReap({ provider, github: new MockGithub() }, reapCfg, now);
    expect(r.results).toEqual([]);
  });

  test("a failing sweep is reported, and the real reap still runs", async () => {
    const provider = new MockProvider(() => now, "prorated");
    addBuilder(provider, "vgr-build-ci-dead", 999);
    await provider.createServer({ name: "ci-sia-1", labels: { pool: "ci", repo: "karimn_sia" }, serverType: "t", image: "i", location: "l", userData: "" });
    const real = provider.deleteServer.bind(provider);
    provider.deleteServer = async (id) => {
      if (id === "vgr-build-ci-dead") throw new Error("nova 500");
      return real(id);
    };
    const r = await runReap({ provider, github: new MockGithub() }, reapCfg, now);
    expect(r.failed).toBe(true);
    expect(r.results.find((x) => x.error)?.error).toContain("nova 500");
    // the idle pool server was still reaped
    expect([...provider.servers.values()].map((s) => s.name)).toEqual(["vgr-build-ci-dead"]);
  });
});
