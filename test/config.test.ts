import { describe, expect, test } from "bun:test";
import { loadEnsureConfig, loadReapConfig, loadReleaseConfig } from "../src/config.ts";

const base = {
  GITHUB_REPOSITORY: "karimn/sia",
  VGR_POOL: "ci",
  HCLOUD_TOKEN: "hz-secret",
  VGR_GITHUB_TOKEN: "gh-secret",
  VGR_SERVER_TYPE: "cpx62",
  VGR_SSH_KEY_NAMES: "ci-key",
  VGR_SSH_PRIVATE_KEY: "PRIVATE-KEY-BODY",
};

describe("loadEnsureConfig", () => {
  test("reads required values and applies defaults", () => {
    expect(loadEnsureConfig(base)).toEqual({
      repo: "karimn/sia",
      pool: "ci",
      hcloudToken: "hz-secret",
      githubToken: "gh-secret",
      serverType: "cpx62",
      image: "ubuntu-24.04",
      location: "nbg1",
      runnerCount: 3,
      labels: ["vm-gh-runners", "pool-ci"],
      runnerVersion: "latest",
      extraPackages: [],
      sshKeyNames: ["ci-key"],
      sshPrivateKey: "PRIVATE-KEY-BODY",
    });
  });

  test("honours overrides and trims comma lists", () => {
    const c = loadEnsureConfig({
      ...base,
      VGR_REPO: "karimn/other",
      VGR_IMAGE: "debian-12",
      VGR_LOCATION: "fsn1",
      VGR_RUNNER_COUNT: "6",
      VGR_RUNNER_LABELS: "fast, gpu ",
      VGR_RUNNER_VERSION: "2.321.0",
      VGR_EXTRA_PACKAGES: "build-essential, libssl-dev",
      VGR_SSH_KEY_NAMES: "a, b",
    });
    expect(c).toMatchObject({
      repo: "karimn/other",
      image: "debian-12",
      location: "fsn1",
      runnerCount: 6,
      labels: ["fast", "gpu"],
      runnerVersion: "2.321.0",
      extraPackages: ["build-essential", "libssl-dev"],
      sshKeyNames: ["a", "b"],
    });
  });

  test("names the missing variable", () => {
    const { HCLOUD_TOKEN: _, ...rest } = base;
    expect(() => loadEnsureConfig(rest)).toThrow("HCLOUD_TOKEN");
    expect(() => loadEnsureConfig({ ...base, VGR_POOL: "" })).toThrow("VGR_POOL");
  });

  test("errors never contain a secret value", () => {
    const { HCLOUD_TOKEN: _, ...rest } = base;
    for (const bad of [
      () => loadEnsureConfig(rest),
      () => loadEnsureConfig({ ...base, VGR_RUNNER_COUNT: "many" }),
      () => loadEnsureConfig({ ...base, GITHUB_REPOSITORY: "no-slash" }),
    ]) {
      const msg = String((() => { try { bad(); } catch (e) { return (e as Error).message; } })());
      for (const secret of ["hz-secret", "gh-secret", "PRIVATE-KEY-BODY"]) {
        expect(msg).not.toContain(secret);
      }
    }
  });

  test("rejects a runner count that is not a positive integer", () => {
    for (const bad of ["0", "-1", "2.5", "many"]) {
      expect(() => loadEnsureConfig({ ...base, VGR_RUNNER_COUNT: bad })).toThrow("VGR_RUNNER_COUNT");
    }
  });

  test("treats blank optional values as unset, since Actions passes an unset input as an empty string", () => {
    const c = loadEnsureConfig({
      ...base,
      VGR_RUNNER_COUNT: "",
      VGR_IMAGE: " ",
      VGR_LOCATION: "",
      VGR_RUNNER_LABELS: "",
      VGR_RUNNER_VERSION: "",
      VGR_EXTRA_PACKAGES: "",
      VGR_REPO: "",
    });
    expect(c).toMatchObject({
      runnerCount: 3,
      image: "ubuntu-24.04",
      location: "nbg1",
      labels: ["vm-gh-runners", "pool-ci"],
      runnerVersion: "latest",
      extraPackages: [],
      repo: "karimn/sia",
    });
  });

  test("rejects a repo that is not owner/name", () => {
    expect(() => loadEnsureConfig({ ...base, GITHUB_REPOSITORY: "no-slash" })).toThrow("owner/name");
  });

  test("needs a repo from somewhere", () => {
    const { GITHUB_REPOSITORY: _, ...rest } = base;
    expect(() => loadEnsureConfig(rest)).toThrow("GITHUB_REPOSITORY");
  });
});

describe("loadReapConfig", () => {
  const reapBase = {
    GITHUB_REPOSITORY: "karimn/sia",
    VGR_POOL: "ci",
    HCLOUD_TOKEN: "hz-secret",
    VGR_GITHUB_TOKEN: "gh-secret",
  };

  test("needs no SSH or sizing settings", () => {
    expect(loadReapConfig(reapBase)).toEqual({
      repo: "karimn/sia",
      pool: "ci",
      hcloudToken: "hz-secret",
      githubToken: "gh-secret",
    });
  });

  test("reads the current run id and window start", () => {
    const c = loadReapConfig({ ...reapBase, GITHUB_RUN_ID: "12345", VGR_WINDOW_START_MINUTE: "45" });
    expect(c.currentRunId).toBe(12345);
    expect(c.windowStartMinute).toBe(45);
  });

  test("treats a blank window start as unset", () => {
    expect(loadReapConfig({ ...reapBase, VGR_WINDOW_START_MINUTE: "" }).windowStartMinute).toBeUndefined();
  });

  test("rejects a window start outside 0-59 and a non-numeric run id", () => {
    expect(() => loadReapConfig({ ...reapBase, VGR_WINDOW_START_MINUTE: "60" })).toThrow("VGR_WINDOW_START_MINUTE");
    expect(() => loadReapConfig({ ...reapBase, VGR_WINDOW_START_MINUTE: "abc" })).toThrow("VGR_WINDOW_START_MINUTE");
    expect(() => loadReapConfig({ ...reapBase, GITHUB_RUN_ID: "abc" })).toThrow("GITHUB_RUN_ID");
  });
});

describe("loadReleaseConfig", () => {
  const relBase = {
    GITHUB_REPOSITORY: "karimn/sia",
    VGR_POOL: "ci",
    HCLOUD_TOKEN: "hz-secret",
    VGR_GITHUB_TOKEN: "gh-secret",
    VGR_SSH_PRIVATE_KEY: "PRIVATE-KEY-BODY",
  };

  test("defaults the new pool label to released and force to off", () => {
    expect(loadReleaseConfig(relBase)).toEqual({
      repo: "karimn/sia",
      pool: "ci",
      hcloudToken: "hz-secret",
      githubToken: "gh-secret",
      sshPrivateKey: "PRIVATE-KEY-BODY",
      newPoolLabel: "released",
      force: false,
    });
  });

  test("needs the SSH key, and names it when missing", () => {
    const { VGR_SSH_PRIVATE_KEY: _, ...rest } = relBase;
    expect(() => loadReleaseConfig(rest)).toThrow("VGR_SSH_PRIVATE_KEY");
  });

  test("reads the new label, force and the current run id; blanks mean unset", () => {
    const c = loadReleaseConfig({ ...relBase, VGR_NEW_POOL_LABEL: "sia-dev", VGR_FORCE: "true", GITHUB_RUN_ID: "77" });
    expect(c).toMatchObject({ newPoolLabel: "sia-dev", force: true, currentRunId: 77 });
    expect(loadReleaseConfig({ ...relBase, VGR_NEW_POOL_LABEL: " ", VGR_FORCE: "" })).toMatchObject({
      newPoolLabel: "released",
      force: false,
    });
  });

  test("force is strictly true or false", () => {
    expect(() => loadReleaseConfig({ ...relBase, VGR_FORCE: "yes" })).toThrow("VGR_FORCE");
  });

  test("rejects a new pool label the provider would refuse, before anything is touched", () => {
    for (const bad of ["has space", "-lead", "a,b", "x".repeat(64)]) {
      expect(() => loadReleaseConfig({ ...relBase, VGR_NEW_POOL_LABEL: bad })).toThrow("VGR_NEW_POOL_LABEL");
    }
  });

  test("errors never contain a secret value", () => {
    const err = (() => { try { loadReleaseConfig({ ...relBase, VGR_FORCE: "nope" }); } catch (e) { return String(e); } return ""; })();
    for (const s of ["hz-secret", "gh-secret", "PRIVATE-KEY-BODY"]) expect(err).not.toContain(s);
  });
});
