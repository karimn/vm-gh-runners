import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RUNNER_USER,
  DEFAULT_TEMPLATE_DIR,
  READY_FILE,
  buildUserData,
} from "../src/userdata.ts";

const parse = (userData: string) => {
  const doc = Bun.YAML.parse(userData) as {
    ssh_pwauth: boolean;
    disable_root: boolean;
    write_files: { path: string; permissions: string; content: string }[];
    runcmd: unknown[];
  };
  return { doc, script: doc.write_files.find((f) => f.path.endsWith("setup.sh"))!.content };
};

describe("buildUserData", () => {
  test("is a cloud-config that writes the setup script and runs it", () => {
    const ud = buildUserData();
    expect(ud.startsWith("#cloud-config\n")).toBe(true);

    const { doc } = parse(ud);
    const file = doc.write_files.find((f) => f.path === "/opt/vm-gh-runners/setup.sh");
    expect(file?.permissions).toBe("0755");
    expect(doc.runcmd).toEqual([["bash", "/opt/vm-gh-runners/setup.sh"]]);
  });

  test("turns password login off", () => {
    expect(parse(buildUserData()).doc.ssh_pwauth).toBe(false);
  });

  test("lets the injected key log in as root, which the registrar does and OVH's images forbid by default", () => {
    expect(parse(buildUserData()).doc.disable_root).toBe(false);
  });

  test("the setup script is valid bash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "userdata-test-"));
    const file = join(dir, "setup.sh");
    await Bun.write(file, parse(buildUserData()).script);

    const proc = Bun.spawn(["bash", "-n", file], { stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });

  test("installs docker, the runner and its dependencies, and creates the runner user", () => {
    const { script } = parse(buildUserData());
    expect(script).toContain("docker.io");
    expect(script).toContain(DEFAULT_TEMPLATE_DIR);
    expect(script).toContain("installdependencies.sh");
    expect(script).toContain(`useradd`);
    expect(script).toContain(DEFAULT_RUNNER_USER);
    expect(script).toContain("/etc/sudoers.d/");
    expect(script).toContain("usermod -aG docker");
    expect(script).toContain("set -euo pipefail");
  });

  test("waits for the apt lock instead of failing against unattended upgrades", () => {
    expect(parse(buildUserData()).script).toContain("DPkg::Lock::Timeout");
  });

  test("writes the ready marker last, so it exists only if every step succeeded", () => {
    const { script } = parse(buildUserData());
    const lines = script.trimEnd().split("\n");
    expect(lines.at(-1)).toContain(READY_FILE);
    expect(script.split(READY_FILE).length - 1).toBe(1);
  });

  test("picks the runner architecture from the machine", () => {
    const { script } = parse(buildUserData());
    expect(script).toContain("x86_64");
    expect(script).toContain("aarch64");
  });

  test("looks up the latest runner by default, and uses a pinned version when given", () => {
    expect(parse(buildUserData()).script).toContain("releases/latest");

    const pinned = parse(buildUserData({ runnerVersion: "2.321.0" })).script;
    expect(pinned).toContain("2.321.0");
    expect(pinned).not.toContain("releases/latest");
  });

  test("installs extra packages when asked", () => {
    expect(parse(buildUserData({ extraPackages: ["build-essential", "libssl-dev"] })).script).toContain(
      "build-essential libssl-dev",
    );
  });

  test("rejects a version or package name that could inject shell", () => {
    expect(() => buildUserData({ runnerVersion: "2.0.0; rm -rf /" })).toThrow("runnerVersion");
    expect(() => buildUserData({ runnerVersion: "v2.0.0" })).toThrow("runnerVersion");
    expect(() => buildUserData({ extraPackages: ["ok", "bad pkg; reboot"] })).toThrow("package");
    expect(() => buildUserData({ extraPackages: ["$(x)"] })).toThrow("package");
  });

  test("fits inside the provider's 32 KiB user-data limit", () => {
    expect(new TextEncoder().encode(buildUserData()).length).toBeLessThan(32 * 1024);
  });
});
