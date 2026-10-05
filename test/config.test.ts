import { describe, expect, test } from "bun:test";
import { loadEnsureConfig, loadReapConfig, loadReleaseConfig } from "../src/config.ts";

const base = {
  GITHUB_REPOSITORY: "karimn/sia",
  VGR_POOL: "ci",
  VGR_PROVIDER: "hetzner",
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
      provider: { kind: "hetzner", token: "hz-secret" },
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
    VGR_PROVIDER: "hetzner",
    HCLOUD_TOKEN: "hz-secret",
    VGR_GITHUB_TOKEN: "gh-secret",
  };

  test("needs no SSH or sizing settings", () => {
    expect(loadReapConfig(reapBase)).toEqual({
      repo: "karimn/sia",
      pool: "ci",
      provider: { kind: "hetzner", token: "hz-secret" },
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
    VGR_PROVIDER: "hetzner",
    HCLOUD_TOKEN: "hz-secret",
    VGR_GITHUB_TOKEN: "gh-secret",
    VGR_SSH_PRIVATE_KEY: "PRIVATE-KEY-BODY",
  };

  test("defaults the new pool label to released and force to off", () => {
    expect(loadReleaseConfig(relBase)).toEqual({
      repo: "karimn/sia",
      pool: "ci",
      provider: { kind: "hetzner", token: "hz-secret" },
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

describe("provider selection", () => {
  const ovh = {
    ...base,
    HCLOUD_TOKEN: undefined,
    VGR_PROVIDER: "ovh",
    OS_APPLICATION_CREDENTIAL_ID: "cred-id",
    OS_APPLICATION_CREDENTIAL_SECRET: "cred-secret",
    VGR_SERVER_TYPE: "b3-32",
    VGR_SSH_KEY_NAMES: "sia-ci-key",
  };

  test("defaults to ovh, and treats a blank provider as unset (an unset action input)", () => {
    expect(loadEnsureConfig(ovh).provider.kind).toBe("ovh");
    expect(loadEnsureConfig({ ...ovh, VGR_PROVIDER: "" }).provider.kind).toBe("ovh");
    expect(loadEnsureConfig({ ...ovh, VGR_PROVIDER: undefined }).provider.kind).toBe("ovh");
  });

  test("a caller that gives only a Hetzner token must now say provider: hetzner", () => {
    const { VGR_PROVIDER: _, ...noProvider } = base;
    expect(() => loadEnsureConfig(noProvider)).toThrow("OS_APPLICATION_CREDENTIAL_ID");
  });

  test("rejects an unknown provider, naming the choices", () => {
    expect(() => loadEnsureConfig({ ...base, VGR_PROVIDER: "aws" })).toThrow("hetzner or ovh");
  });

  test("hetzner still needs its token, and an OVH credential does not substitute", () => {
    const { HCLOUD_TOKEN: _, ...rest } = base;
    expect(() => loadEnsureConfig({ ...rest, OS_APPLICATION_CREDENTIAL_ID: "x", OS_APPLICATION_CREDENTIAL_SECRET: "y" })).toThrow("HCLOUD_TOKEN");
  });

  test("ovh reads the application credential and defaults to OVH US, Ubuntu 24.04", () => {
    expect(loadEnsureConfig(ovh)).toMatchObject({
      provider: {
        kind: "ovh",
        authUrl: "https://auth.cloud.ovh.us/v3",
        credentialId: "cred-id",
        credentialSecret: "cred-secret",
        region: "US-EAST-VA-1",
      },
      image: "Ubuntu 24.04",
      location: "US-EAST-VA-1",
      serverType: "b3-32",
      sshKeyNames: ["sia-ci-key"],
    });
  });

  test("ovh does not need HCLOUD_TOKEN, and hetzner does not need the OVH credential", () => {
    expect(() => loadEnsureConfig(ovh)).not.toThrow();
    expect(() => loadEnsureConfig(base)).not.toThrow();
  });

  test("ovh names the missing credential variable", () => {
    expect(() => loadEnsureConfig({ ...ovh, OS_APPLICATION_CREDENTIAL_SECRET: "" })).toThrow("OS_APPLICATION_CREDENTIAL_SECRET");
    expect(() => loadEnsureConfig({ ...ovh, OS_APPLICATION_CREDENTIAL_ID: undefined })).toThrow("OS_APPLICATION_CREDENTIAL_ID");
  });

  test("ovh takes the region from the location, then OS_REGION_NAME, and honours an EU auth URL and image", () => {
    expect(loadEnsureConfig({ ...ovh, VGR_LOCATION: "GRA11" }).provider).toMatchObject({ region: "GRA11" });
    expect(loadEnsureConfig({ ...ovh, VGR_LOCATION: "GRA11" }).location).toBe("GRA11");
    expect(loadEnsureConfig({ ...ovh, OS_REGION_NAME: "SBG5" }).provider).toMatchObject({ region: "SBG5" });
    const eu = loadEnsureConfig({ ...ovh, OS_AUTH_URL: "https://auth.cloud.ovh.net/v3", VGR_IMAGE: "Debian 12" });
    expect(eu.provider).toMatchObject({ authUrl: "https://auth.cloud.ovh.net/v3" });
    expect(eu.image).toBe("Debian 12");
  });

  test("ovh refuses an auth URL that is not https, since the credential is sent there", () => {
    expect(() => loadEnsureConfig({ ...ovh, OS_AUTH_URL: "http://auth.example/v3" })).toThrow("https");
  });

  test("ovh needs exactly one SSH key name", () => {
    expect(() => loadEnsureConfig({ ...ovh, VGR_SSH_KEY_NAMES: "a, b" })).toThrow("exactly one");
  });

  test("an error never contains the OVH secret", () => {
    for (const bad of [
      () => loadEnsureConfig({ ...ovh, OS_AUTH_URL: "http://cred-secret.example/v3" }),
      () => loadEnsureConfig({ ...ovh, VGR_SSH_KEY_NAMES: "" }),
      () => loadEnsureConfig({ ...ovh, VGR_RUNNER_COUNT: "x" }),
    ]) {
      try {
        bad();
      } catch (e) {
        expect((e as Error).message).not.toContain("cred-secret");
      }
    }
  });

  const reapOvh = {
    GITHUB_REPOSITORY: "karimn/sia",
    VGR_POOL: "ci",
    VGR_GITHUB_TOKEN: "gh",
    VGR_PROVIDER: "ovh",
    OS_APPLICATION_CREDENTIAL_ID: "cred-id",
    OS_APPLICATION_CREDENTIAL_SECRET: "cred-secret",
  };

  test("reap and release on ovh get the region from the location too", () => {
    expect(loadReapConfig(reapOvh).provider).toMatchObject({ kind: "ovh", region: "US-EAST-VA-1" });
    expect(loadReapConfig({ ...reapOvh, VGR_LOCATION: "GRA11" }).provider).toMatchObject({ region: "GRA11" });
    expect(loadReleaseConfig({ ...reapOvh, VGR_SSH_PRIVATE_KEY: "k" }).provider).toMatchObject({ kind: "ovh" });
  });

  test("a window start is an error on ovh, not silently ignored", () => {
    expect(() => loadReapConfig({ ...reapOvh, VGR_WINDOW_START_MINUTE: "45" })).toThrow("no effect on ovh");
    expect(loadReapConfig({ ...reapOvh, VGR_WINDOW_START_MINUTE: "" }).windowStartMinute).toBeUndefined();
  });

  test("a window start is still honoured on hetzner, and a stray location is ignored there", () => {
    const hz = { VGR_PROVIDER: "hetzner", GITHUB_REPOSITORY: "karimn/sia", VGR_POOL: "ci", VGR_GITHUB_TOKEN: "gh", HCLOUD_TOKEN: "t" };
    expect(loadReapConfig({ ...hz, VGR_WINDOW_START_MINUTE: "45", VGR_LOCATION: "US-EAST-VA-1" }).windowStartMinute).toBe(45);
  });
});
