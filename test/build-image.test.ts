import { describe, expect, test } from "bun:test";
import {
  BUILDER_LABEL,
  buildImage,
  prepullScript,
  STALE_BUILDER_MINUTES,
  sweepStaleBuilders,
  type BuildImageConfig,
} from "../src/build-image.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { BAKED_FILE, READY_FILE } from "../src/userdata.ts";
import { FakeSsh, type SshCall } from "./fake-ssh.ts";

const now = new Date("2026-10-05T12:00:00Z");
const options = { now: () => now, sleep: async () => {}, connectAttempts: 3 };

const cfg: BuildImageConfig = {
  pool: "ci",
  serverType: "b3-8",
  baseImage: "Ubuntu 24.04",
  location: "US-EAST-VA-1",
  runnerVersion: "2.337.0",
  extraPackages: [],
  prepullImages: [],
  keep: 2,
};

/** An ssh whose machine reboots when asked, if `reboot-required` exists. */
const sshFor = (opts: { reboot?: boolean; fail?: (c: SshCall) => { code: number; stderr?: string } | undefined } = {}) => {
  let bootId = "boot-1";
  return new FakeSsh((c) => {
    const failed = opts.fail?.(c);
    if (failed) return failed;
    if (c.command === "test -f /var/run/reboot-required") return { code: opts.reboot ? 0 : 1 };
    if (c.command === "cat /proc/sys/kernel/random/boot_id") return { stdout: `${bootId}\n` };
    if (c.command === "systemctl reboot") {
      bootId = "boot-2";
      return { code: 255 };
    }
    return undefined;
  });
};

const seedImage = (p: MockProvider, name: string, createdAt: string) =>
  p.images.set(`old-${name}`, { id: `old-${name}`, name, createdAt: new Date(createdAt) });

describe("buildImage", () => {
  test("builds from the stock image, snapshots, deletes the builder, and returns the image", async () => {
    const provider = new MockProvider(() => now);
    const ssh = sshFor();

    const r = await buildImage({ provider, ssh }, cfg, options);

    expect(r.imageName).toBe("vgr-ci-20261005");
    expect(provider.images.get(r.imageId)?.name).toBe("vgr-ci-20261005");
    expect(r.rebooted).toBe(false);
    expect(provider.servers.size).toBe(0);
    expect(provider.calls.filter((c) => c.startsWith("create:"))).toHaveLength(1);
  });

  test("the temporary server is not in the pool: ensure and reap select by `pool` and must never see it", async () => {
    const provider = new MockProvider(() => now);
    let seen: unknown;
    const ssh = new FakeSsh((c) => {
      if (c.command === "bash -s") seen ??= [...provider.servers.values()].map((s) => s.labels);
      return c.command === "test -f /var/run/reboot-required" ? { code: 1 } : undefined;
    });
    await buildImage({ provider, ssh }, cfg, options);
    expect(seen).toEqual([{ [BUILDER_LABEL]: "ci" }]);
  });

  test("bakes, then cleans last: the clean script runs after everything else", async () => {
    const provider = new MockProvider(() => now);
    const ssh = sshFor();
    await buildImage({ provider, ssh }, { ...cfg, prepullImages: ["ghcr.io/o/ci:1"] }, options);

    const [bake, pull, clean] = ssh.scripts;
    expect(bake).toContain("dist-upgrade");
    expect(bake).toContain(BAKED_FILE);
    expect(pull).toContain("docker pull");
    expect(clean).toContain("cloud-init clean");
    expect(ssh.scripts).toHaveLength(3);
  });

  test("the finalize script resets identity and leaves no builder key, host key, ready marker or credential", async () => {
    const ssh = sshFor();
    await buildImage({ provider: new MockProvider(() => now), ssh }, cfg, options);
    const clean = ssh.scripts.at(-1)!;
    for (const needle of [
      "cloud-init clean --logs --seed",
      "truncate -s 0 /etc/machine-id",
      "/var/lib/dbus/machine-id",
      "/etc/ssh/ssh_host_*",
      "/root/.ssh/authorized_keys",
      "/home/*/.ssh/authorized_keys",
      `rm -f ${READY_FILE}`,
      "/root/.docker/config.json",
    ]) {
      expect(clean).toContain(needle);
    }
    // The baked marker has to survive the clean.
    expect(clean).not.toContain(BAKED_FILE);
  });

  test("reboots when the upgrade asks for it, and waits for a new boot", async () => {
    const provider = new MockProvider(() => now);
    const ssh = sshFor({ reboot: true });

    const r = await buildImage({ provider, ssh }, cfg, options);

    expect(r.rebooted).toBe(true);
    const cmds = ssh.calls.map((c) => c.command);
    const reboot = cmds.indexOf("systemctl reboot");
    expect(reboot).toBeGreaterThan(cmds.indexOf("bash -s"));
    // the clean script runs after the reboot, not before it
    expect(cmds.lastIndexOf("bash -s")).toBeGreaterThan(reboot);
  });

  test("fails, and deletes the builder, if the machine never comes back", async () => {
    const provider = new MockProvider(() => now);
    const ssh = new FakeSsh((c) => {
      if (c.command === "test -f /var/run/reboot-required") return { code: 0 };
      if (c.command === "cat /proc/sys/kernel/random/boot_id") return { stdout: "same\n" };
      return undefined;
    });
    await expect(buildImage({ provider, ssh }, cfg, options)).rejects.toThrow("did not come back");
    expect(provider.servers.size).toBe(0);
    expect(provider.images.size).toBe(0);
  });

  test("a snapshot adds an image first, and only then are older ones pruned to N", async () => {
    const provider = new MockProvider(() => now);
    seedImage(provider, "vgr-ci-20260101", "2026-01-01T00:00:00Z");
    seedImage(provider, "vgr-ci-20260901", "2026-09-01T00:00:00Z");
    seedImage(provider, "vgr-ci-20260928", "2026-09-28T00:00:00Z");

    const r = await buildImage({ provider, ssh: sshFor() }, cfg, options);

    expect([...r.pruned.deleted].sort()).toEqual(["vgr-ci-20260101", "vgr-ci-20260901"]);
    expect([...provider.images.values()].map((i) => i.name).sort()).toEqual(["vgr-ci-20260928", "vgr-ci-20261005"]);
    const calls = provider.calls;
    expect(calls.indexOf("createImage:vgr-ci-20261005")).toBeLessThan(calls.findIndex((c) => c.startsWith("deleteImage:")));
  });

  test("keeps N images when told to", async () => {
    const provider = new MockProvider(() => now);
    for (const d of ["01", "02", "03"]) seedImage(provider, `vgr-ci-202609${d}`, `2026-09-${d}T00:00:00Z`);
    await buildImage({ provider, ssh: sshFor() }, { ...cfg, keep: 4 }, options);
    expect(provider.images.size).toBe(4);
  });

  test("reports an image it could not prune without failing the build", async () => {
    const provider = new MockProvider(() => now);
    seedImage(provider, "vgr-ci-20260101", "2026-01-01T00:00:00Z");
    seedImage(provider, "vgr-ci-20260901", "2026-09-01T00:00:00Z");
    provider.failDeleteImageWith = new Error("glance said no");
    const r = await buildImage({ provider, ssh: sshFor() }, { ...cfg, keep: 1 }, options);
    expect(r.pruned.failed).toHaveLength(2);
    expect(provider.servers.size).toBe(0);
  });

  describe("the temporary server is always deleted, and nothing is pruned or published", () => {
    const failures: [string, (c: SshCall) => { code: number; stderr?: string } | undefined, string][] = [
      ["the bake script fails", (c) => (c.stdin?.includes("dist-upgrade") ? { code: 100, stderr: "E: broken packages" } : undefined), "baking failed"],
      ["cloud-init fails on the builder", (c) => (c.command === "cloud-init status --wait" ? { code: 1, stderr: "boom" } : undefined), "cloud-init did not finish"],
      ["the builder is unreachable", (c) => (c.command === "cloud-init status --wait" ? { code: 255 } : undefined), "not reachable"],
      ["the pull fails", (c) => (c.stdin?.includes("docker pull") ? { code: 1, stderr: "denied" } : undefined), "pulling container images failed"],
      ["the clean script fails", (c) => (c.stdin?.includes("cloud-init clean") ? { code: 1, stderr: "x" } : undefined), "cleaning for snapshot failed"],
    ];
    test.each(failures)("when %s", async (_name, fail, message) => {
      const provider = new MockProvider(() => now);
      seedImage(provider, "vgr-ci-20260901", "2026-09-01T00:00:00Z");
      seedImage(provider, "vgr-ci-20260928", "2026-09-28T00:00:00Z");

      await expect(
        buildImage({ provider, ssh: sshFor({ fail }) }, { ...cfg, prepullImages: ["ghcr.io/o/ci:1"] }, options),
      ).rejects.toThrow(message);

      expect(provider.servers.size).toBe(0);
      expect([...provider.images.values()].map((i) => i.name).sort()).toEqual(["vgr-ci-20260901", "vgr-ci-20260928"]);
      expect(provider.calls.some((c) => c.startsWith("deleteImage:"))).toBe(false);
    });

    test("when the snapshot fails", async () => {
      const provider = new MockProvider(() => now);
      seedImage(provider, "vgr-ci-20260901", "2026-09-01T00:00:00Z");
      provider.failImageWith = new Error("snapshot refused");

      await expect(buildImage({ provider, ssh: sshFor() }, cfg, options)).rejects.toThrow("snapshot refused");

      expect(provider.servers.size).toBe(0);
      expect(provider.images.size).toBe(1);
    });

    test("when the builder has no address", async () => {
      const provider = new MockProvider(() => now);
      const real = provider.createServer.bind(provider);
      provider.createServer = async (spec) => {
        const { address: _a, ...bare } = await real(spec);
        provider.servers.set(bare.id, bare);
        return bare;
      };
      await expect(buildImage({ provider, ssh: sshFor() }, cfg, options)).rejects.toThrow("no address");
      expect(provider.servers.size).toBe(0);
    });
  });

  test("a failed delete of the builder is loud, and keeps the build's own error", async () => {
    const provider = new MockProvider(() => now);
    provider.deleteServer = async () => {
      throw new Error("nova said 500");
    };
    const ssh = sshFor({ fail: (c) => (c.stdin?.includes("dist-upgrade") ? { code: 1, stderr: "E: broken" } : undefined) });

    const error = await buildImage({ provider, ssh }, cfg, options).catch((e: Error) => e);

    expect((error as Error).message).toContain("baking failed");
    expect((error as Error).message).toContain("delete it by hand, it is billing");
  });

  test("a failed delete after a good build still fails the run, since the server bills", async () => {
    const provider = new MockProvider(() => now);
    provider.deleteServer = async () => {
      throw new Error("nova said 500");
    };
    await expect(buildImage({ provider, ssh: sshFor() }, cfg, options)).rejects.toThrow("it is billing");
  });

  test("checks its inputs before creating anything", async () => {
    const provider = new MockProvider(() => now);
    await expect(buildImage({ provider, ssh: sshFor() }, { ...cfg, prepullImages: ["bad image; reboot"] }, options)).rejects.toThrow(
      "invalid container image",
    );
    await expect(buildImage({ provider, ssh: sshFor() }, { ...cfg, runnerVersion: "v2" }, options)).rejects.toThrow("runnerVersion");
    expect(provider.calls).toEqual([]);
  });

  test("a registry password is redacted from a failure", async () => {
    const provider = new MockProvider(() => now);
    const ssh = sshFor({ fail: (c) => (c.stdin?.includes("docker login") ? { code: 1, stderr: "login failed for hunter2" } : undefined) });
    const error = await buildImage(
      { provider, ssh },
      { ...cfg, prepullImages: ["ghcr.io/o/ci:1"], registry: { host: "ghcr.io", username: "u", password: "hunter2" } },
      options,
    ).catch((e: Error) => e);
    expect((error as Error).message).toContain("login failed for ***");
    expect((error as Error).message).not.toContain("hunter2");
  });

  test("the credential reaches the VM only over SSH stdin, never user-data or a command line", async () => {
    const provider = new MockProvider(() => now);
    const ssh = sshFor();
    const specs: string[] = [];
    const real = provider.createServer.bind(provider);
    provider.createServer = async (spec) => (specs.push(spec.userData), real(spec));

    await buildImage(
      { provider, ssh },
      { ...cfg, prepullImages: ["ghcr.io/o/ci:1"], registry: { host: "ghcr.io", username: "u", password: "hunter2" } },
      options,
    );

    expect(specs.join()).not.toContain("hunter2");
    expect(ssh.calls.map((c) => c.command).join("\n")).not.toContain("hunter2");
    expect(ssh.scripts.filter((s) => s.includes("hunter2"))).toHaveLength(1);
    expect(ssh.scripts.at(-1)).not.toContain("hunter2");
  });
});

describe("stale builders", () => {
  const builder = (provider: MockProvider, name: string, ageMinutes: number, pool = "ci") => {
    const clock = new MockProvider(() => new Date(now.getTime() - ageMinutes * 60_000));
    return clock.createServer({ name, labels: { [BUILDER_LABEL]: pool }, serverType: "t", image: "i", location: "l", userData: "" }).then((s) => {
      provider.servers.set(s.id + name, { ...s, id: s.id + name });
      return s.id + name;
    });
  };

  test("deletes this pool's builders older than the limit, and only those", async () => {
    const provider = new MockProvider(() => now);
    await builder(provider, "vgr-build-ci-old", STALE_BUILDER_MINUTES + 1);
    await builder(provider, "vgr-build-ci-fresh", 20);
    await builder(provider, "vgr-build-other-old", STALE_BUILDER_MINUTES + 1, "other");

    expect(await sweepStaleBuilders(provider, "ci", now)).toEqual(["vgr-build-ci-old"]);
    expect([...provider.servers.values()].map((s) => s.name).sort()).toEqual(["vgr-build-ci-fresh", "vgr-build-other-old"]);
  });

  test("a build sweeps a killed predecessor's server before it starts", async () => {
    const provider = new MockProvider(() => now);
    await builder(provider, "vgr-build-ci-dead", 500);
    const r = await buildImage({ provider, ssh: sshFor() }, cfg, options);
    expect(r.sweptBuilders).toEqual(["vgr-build-ci-dead"]);
    expect(provider.servers.size).toBe(0);
  });
});

describe("prepullScript", () => {
  test("pulls each image, quoted, with retries", () => {
    const s = prepullScript(["ghcr.io/o/ci:manifest-abc", "alpine:3"]);
    expect(s).toContain("'ghcr.io/o/ci:manifest-abc' 'alpine:3'");
    expect(s).toContain("docker pull");
    expect(s).not.toContain("docker login");
  });

  test("logs in with a throwaway DOCKER_CONFIG so the credential never reaches the image", () => {
    const s = prepullScript(["ghcr.io/o/ci:1"], { host: "ghcr.io", username: "u", password: "pw" });
    expect(s).toContain('DOCKER_CONFIG="$(mktemp -d)"');
    expect(s).toContain("--password-stdin");
    expect(s.indexOf("export DOCKER_CONFIG")).toBeLessThan(s.indexOf("docker login"));
    expect(s).toContain("trap 'rm -rf \"$DOCKER_CONFIG\"' EXIT");
  });

  test("quotes a password that holds shell metacharacters", () => {
    expect(prepullScript(["a:1"], { host: "ghcr.io", username: "u", password: "p'; rm -rf / #" })).toContain(
      `'p'\\''; rm -rf / #'`,
    );
  });

  test("rejects references, hosts and usernames that could inject shell", () => {
    expect(() => prepullScript(["a b"])).toThrow("invalid container image");
    expect(() => prepullScript(["$(x)"])).toThrow("invalid container image");
    expect(() => prepullScript(["-v"])).toThrow("invalid container image");
    expect(() => prepullScript(["a:1"], { host: "x; y", username: "u", password: "p" })).toThrow("registry host");
    expect(() => prepullScript(["a:1"], { host: "h", username: "u v", password: "p" })).toThrow("username");
  });

  test("is valid bash", async () => {
    const proc = Bun.spawn(["bash", "-n"], { stdin: new TextEncoder().encode(prepullScript(["a:1", "b:2"], { host: "ghcr.io", username: "u", password: "p" })), stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });
});
