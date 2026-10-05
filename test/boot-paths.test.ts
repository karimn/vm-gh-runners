import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BAKED_FILE, buildBakeScript, buildFinalizeScript, buildUserData, DEFAULT_TEMPLATE_DIR, READY_FILE } from "../src/userdata.ts";
import { runInSandbox } from "./sandbox.ts";

const setupScript = (opts: Parameters<typeof buildUserData>[0] = {}): string =>
  (Bun.YAML.parse(buildUserData(opts)) as { write_files: { content: string }[] }).write_files[0]!.content;

/** What an image made by `build-image` holds: the marker, the runner template, the runner user. */
const bakedImage = (version = "2.337.0") => (root: string) => {
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  put(BAKED_FILE, `runner_version=${version}\nbuilt_at=2026-10-01T00:00:00Z\n`);
  put(`${DEFAULT_TEMPLATE_DIR}/config.sh`, "#!/usr/bin/env bash\n");
  chmodSync(join(root, DEFAULT_TEMPLATE_DIR, "config.sh"), 0o755);
};
const imageEnv = { RUNNER_USER_EXISTS: "1" };

const names = (commands: readonly string[]) => commands.map((c) => c.split(" ")[0]);
const apt = (commands: readonly string[], verb: string) => commands.filter((c) => c.startsWith("apt-get") && c.includes(` ${verb}`));

describe("first boot on the stock image", () => {
  test("installs everything, then writes the ready marker", async () => {
    const r = await runInSandbox(setupScript({ runnerVersion: "2.337.0" }));
    expect(r.code).toBe(0);
    expect(apt(r.commands, "update")).toHaveLength(1);
    expect(apt(r.commands, "install")[0]).toContain("docker.io");
    expect(r.commands).toContain("useradd -m -s /bin/bash runner");
    expect(names(r.commands)).toContain("curl");
    expect(r.commands).toContain("installdependencies");
    expect(r.exists(READY_FILE)).toBe(true);
  });
});

describe("first boot on a built image", () => {
  test("installs nothing: no apt, no download, no user creation, but still the ready marker", async () => {
    const r = await runInSandbox(setupScript({ runnerVersion: "2.337.0" }), bakedImage(), imageEnv);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    for (const forbidden of ["apt-get", "curl", "tar", "useradd", "installdependencies", "visudo"]) {
      expect(names(r.commands)).not.toContain(forbidden);
    }
    expect(r.commands).toContain("systemctl enable --now docker");
    expect(r.exists(READY_FILE)).toBe(true);
  });

  test("a runner version of latest uses the baked one and downloads nothing", async () => {
    const r = await runInSandbox(setupScript(), bakedImage("2.330.0"), imageEnv);
    expect(r.code).toBe(0);
    expect(names(r.commands)).not.toContain("curl");
  });

  test("a pin different from the baked version replaces only the runner", async () => {
    const r = await runInSandbox(setupScript({ runnerVersion: "2.340.0" }), bakedImage("2.337.0"), imageEnv);
    expect(r.code).toBe(0);
    expect(names(r.commands)).toContain("curl");
    expect(r.commands).toContain("installdependencies");
    expect(names(r.commands)).not.toContain("apt-get");
    expect(names(r.commands)).not.toContain("useradd");
  });

  test("extra packages are installed, and only those", async () => {
    const r = await runInSandbox(setupScript({ runnerVersion: "2.337.0", extraPackages: ["build-essential"] }), bakedImage(), imageEnv);
    expect(apt(r.commands, "install")).toHaveLength(1);
    expect(apt(r.commands, "install")[0]).toContain("build-essential");
    expect(apt(r.commands, "install")[0]).not.toContain("docker.io");
  });

  test("fails, without a ready marker, when the image is damaged", async () => {
    const r = await runInSandbox(
      setupScript({ runnerVersion: "2.337.0" }),
      (root) => {
        bakedImage()(root);
        chmodSync(join(root, DEFAULT_TEMPLATE_DIR, "config.sh"), 0o644);
      },
      imageEnv,
    );
    expect(r.code).not.toBe(0);
    expect(r.exists(READY_FILE)).toBe(false);
  });

  test("a stale ready marker in the image would be fatal to trust, so first boot does not read one", async () => {
    // build-image removes it; this checks the boot script never skips on it either.
    const r = await runInSandbox(setupScript({ runnerVersion: "2.337.0" }), (root) => {
      bakedImage()(root);
      mkdirSync(join(root, "var/lib/vm-gh-runners"), { recursive: true });
      writeFileSync(join(root, READY_FILE), "");
    }, imageEnv);
    expect(r.code).toBe(0);
    expect(r.commands).toContain("systemctl enable --now docker");
  });
});

describe.each([
  ["stock", (_root: string) => {}, {}],
  ["built", bakedImage(), imageEnv],
] as const)("never upgrades itself: %s image", (_name, setup, env) => {
  test("masks the upgrade units and turns needrestart to list-only before anything else", async () => {
    const r = await runInSandbox(setupScript({ runnerVersion: "2.337.0" }), setup, env);
    expect(r.code).toBe(0);
    expect(r.read("etc/needrestart/conf.d/50-vgr.conf")).toContain("$nrconf{restart} = 'l';");
    expect(r.read("etc/apt/apt.conf.d/99-vgr-no-auto-upgrades")).toContain('Unattended-Upgrade "0"');
    const mask = r.commands.findIndex((c) => c.startsWith("systemctl mask apt-daily"));
    expect(mask).toBeGreaterThanOrEqual(0);
    const firstApt = r.commands.findIndex((c) => c.startsWith("apt-get") || c.startsWith("curl"));
    if (firstApt !== -1) expect(mask).toBeLessThan(firstApt);
    // and nothing in the first-boot script upgrades
    expect(apt(r.commands, "upgrade") .concat(apt(r.commands, "dist-upgrade"))).toEqual([]);
  });
});

describe("the sandbox", () => {
  test("refuses a script that would touch the real home directory, such as the finalize script", async () => {
    await expect(runInSandbox(buildFinalizeScript())).rejects.toThrow("refusing to run");
  });
});

describe("the bake script", () => {
  test("upgrades first and only then installs, with the same masking as first boot", async () => {
    const r = await runInSandbox(buildBakeScript({ runnerVersion: "2.337.0" }));
    expect(r.code).toBe(0);
    const at = (prefix: string) => r.commands.findIndex((c) => c.startsWith(prefix));
    expect(at("systemctl mask apt-daily")).toBeLessThan(at("apt-get -o DPkg::Lock::Timeout=300 -y -o Dpkg::Options::=--force-confdef"));
    expect(r.commands.some((c) => c.includes("dist-upgrade"))).toBe(true);
    expect(r.commands.findIndex((c) => c.includes("dist-upgrade"))).toBeLessThan(r.commands.findIndex((c) => c.includes(" install ca-certificates")));
  });

  test("writes the baked marker with the resolved runner version, and no ready marker", async () => {
    const r = await runInSandbox(buildBakeScript({ runnerVersion: "2.337.0" }), (root) => {
      mkdirSync(join(root, "var/lib/vm-gh-runners"), { recursive: true });
      writeFileSync(join(root, READY_FILE), "stale");
    });
    expect(r.read(BAKED_FILE.slice(1))).toMatch(/^runner_version=2\.337\.0\nbuilt_at=\d{4}-\d\d-\d\dT[\d:]+Z\n$/);
    expect(r.exists(READY_FILE)).toBe(false);
  });

  test("records the version it resolved when asked for latest", async () => {
    const r = await runInSandbox(buildBakeScript());
    expect(r.read(BAKED_FILE.slice(1))).toContain("runner_version=9.9.9\n");
  });

  test("the baked marker is written last, so a failed bake never leaves one", async () => {
    const script = buildBakeScript({ runnerVersion: "2.337.0" });
    expect(script.trimEnd().split("\n").at(-1)).toContain(BAKED_FILE);
    expect(script.split(BAKED_FILE).length - 1).toBe(1);
  });

  test("bakes caller extras into the image", () => {
    expect(buildBakeScript({ extraPackages: ["libssl-dev"] })).toContain("libssl-dev");
  });

  test("rejects what first boot rejects", () => {
    expect(() => buildBakeScript({ runnerVersion: "x" })).toThrow("runnerVersion");
    expect(() => buildBakeScript({ extraPackages: ["a;b"] })).toThrow("package");
  });

  test("the bake and finalize scripts are valid bash", async () => {
    for (const script of [buildBakeScript(), buildFinalizeScript()]) {
      const proc = Bun.spawn(["bash", "-n"], { stdin: new TextEncoder().encode(script), stderr: "pipe" });
      expect(await proc.exited).toBe(0);
    }
  });
});

describe("cold-start work, stock versus built (stubbed commands actually executed)", () => {
  test("a built image removes every apt call and download from first boot", async () => {
    const opts = { runnerVersion: "2.337.0" };
    const stock = await runInSandbox(setupScript(opts));
    const built = await runInSandbox(setupScript(opts), bakedImage(), imageEnv);

    const heavy = (cmds: readonly string[]) =>
      cmds.filter((c) => /^(apt-get .* (update|install)|curl|tar|installdependencies|useradd|usermod)/.test(c));

    console.log(`stock first boot: ${stock.commands.length} commands, ${heavy(stock.commands).length} install/download steps`);
    console.log(`built first boot: ${built.commands.length} commands, ${heavy(built.commands).length} install/download steps`);
    expect(heavy(stock.commands).length).toBeGreaterThanOrEqual(6);
    expect(heavy(built.commands)).toEqual([]);
    expect(built.commands.length).toBeLessThan(stock.commands.length);
  });
});
