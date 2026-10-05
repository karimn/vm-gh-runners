/**
 * Configuration comes from environment variables, not argv: a GitHub Actions
 * step passes secrets through `env:`, and command-line arguments are visible in
 * process listings. Error messages name the variable and never echo a value
 * that could be a secret.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/** Which cloud, and how to authenticate to it. */
export type ProviderConfig =
  | { readonly kind: "hetzner"; readonly token: string }
  | {
      readonly kind: "ovh";
      /** Keystone v3 URL. The OVH US account's is `https://auth.cloud.ovh.us/v3`; EU's differs. */
      readonly authUrl: string;
      readonly credentialId: string;
      readonly credentialSecret: string;
      /** The region, from `VGR_LOCATION`. Selects which service endpoints are used. */
      readonly region: string;
    };

export const DEFAULTS = {
  hetzner: { image: "ubuntu-24.04", location: "nbg1" },
  // OVH's stock Ubuntu image, not "Debian 12 - Docker": that one ships docker-ce,
  // which the first-boot script's `apt install docker.io` would fight with.
  ovh: { image: "Ubuntu 24.04", location: "US-EAST-VA-1" },
} as const;

export interface CommonConfig {
  /** `owner/name`. */
  readonly repo: string;
  readonly pool: string;
  readonly provider: ProviderConfig;
  /** A token allowed to manage this repo's runners (Administration: read and write; Actions: read). */
  readonly githubToken: string;
}

export interface EnsureCliConfig extends CommonConfig {
  readonly serverType: string;
  readonly image: string;
  readonly location: string;
  readonly runnerCount: number;
  readonly labels: readonly string[];
  readonly runnerVersion: string;
  readonly extraPackages: readonly string[];
  /**
   * Names or IDs of SSH keys already uploaded to the cloud project. OVH takes
   * exactly one, and it must exist in the configured region.
   */
  readonly sshKeyNames: readonly string[];
  /** Private half of the key above. Written to a 0600 temp file, never logged. */
  readonly sshPrivateKey: string;
}

export interface ReapCliConfig extends CommonConfig {
  readonly windowStartMinute?: number;
  readonly currentRunId?: number;
}

export interface ReleaseCliConfig extends CommonConfig {
  /** Private half of the project's SSH key, used to stop the runner services. */
  readonly sshPrivateKey: string;
  /** What `pool` is relabelled to, so reap and ensure stop seeing the server. */
  readonly newPoolLabel: string;
  readonly force: boolean;
  readonly currentRunId?: number;
}

const required = (env: Env, name: string): string => {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
};

const list = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const integer = (env: Env, name: string, min: number, max = Infinity): number | undefined => {
  const raw = env[name];
  // Actions passes an unset input as an empty string, so blank means "use the default".
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer from ${min}${max < Infinity ? ` to ${max}` : " up"}`);
  }
  return Number(raw);
};

const providerConfig = (env: Env): ProviderConfig => {
  const kind = env["VGR_PROVIDER"]?.trim() || "ovh";
  if (kind === "hetzner") return { kind, token: required(env, "HCLOUD_TOKEN") };
  if (kind === "ovh") {
    const authUrl = env["OS_AUTH_URL"]?.trim() || "https://auth.cloud.ovh.us/v3";
    // The application credential is sent to this URL, so never to plain http.
    if (!/^https:\/\/[^\s]+$/i.test(authUrl)) throw new Error("OS_AUTH_URL must be an https:// URL");
    return {
      kind,
      authUrl,
      credentialId: required(env, "OS_APPLICATION_CREDENTIAL_ID"),
      credentialSecret: required(env, "OS_APPLICATION_CREDENTIAL_SECRET"),
      region: env["VGR_LOCATION"]?.trim() || env["OS_REGION_NAME"]?.trim() || DEFAULTS.ovh.location,
    };
  }
  throw new Error(`VGR_PROVIDER must be hetzner or ovh, got "${kind}"`);
};

const common = (env: Env): CommonConfig => {
  const repo = env["VGR_REPO"]?.trim() || required(env, "GITHUB_REPOSITORY");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("the repo must be in owner/name form");
  return {
    repo,
    pool: required(env, "VGR_POOL"),
    provider: providerConfig(env),
    githubToken: required(env, "VGR_GITHUB_TOKEN"),
  };
};

export const loadEnsureConfig = (env: Env): EnsureCliConfig => {
  const base = common(env);
  const labels = list(env["VGR_RUNNER_LABELS"]);
  const sshKeyNames = list(required(env, "VGR_SSH_KEY_NAMES"));
  if (base.provider.kind === "ovh" && sshKeyNames.length !== 1) {
    throw new Error("VGR_SSH_KEY_NAMES must name exactly one key pair for ovh (Nova takes one per server)");
  }
  const defaults = DEFAULTS[base.provider.kind];
  return {
    ...base,
    serverType: required(env, "VGR_SERVER_TYPE"),
    image: env["VGR_IMAGE"]?.trim() || defaults.image,
    location: base.provider.kind === "ovh" ? base.provider.region : env["VGR_LOCATION"]?.trim() || defaults.location,
    runnerCount: integer(env, "VGR_RUNNER_COUNT", 1) ?? 3,
    labels: labels.length > 0 ? labels : ["vm-gh-runners", `pool-${base.pool}`],
    runnerVersion: env["VGR_RUNNER_VERSION"]?.trim() || "latest",
    extraPackages: list(env["VGR_EXTRA_PACKAGES"]),
    sshKeyNames,
    sshPrivateKey: required(env, "VGR_SSH_PRIVATE_KEY"),
  };
};

export const loadReapConfig = (env: Env): ReapCliConfig => {
  const base = common(env);
  const windowStartMinute = integer(env, "VGR_WINDOW_START_MINUTE", 0, 59);
  if (base.provider.kind === "ovh" && windowStartMinute !== undefined) {
    // OVH bills by runtime, so there is no paid hour to wait out. Refuse rather
    // than let someone believe they are holding idle VMs warm.
    throw new Error("VGR_WINDOW_START_MINUTE has no effect on ovh (billed by runtime, idle servers are deleted at once); remove it");
  }
  const currentRunId = integer(env, "GITHUB_RUN_ID", 0);
  return {
    ...base,
    ...(windowStartMinute === undefined ? {} : { windowStartMinute }),
    ...(currentRunId === undefined ? {} : { currentRunId }),
  };
};

// The strictest common subset of cloud label rules (Hetzner's): alphanumeric
// at both ends, `-_.` between, at most 63 chars. Checked here, before anything
// is deregistered, so a bad label cannot fail the last step of a release.
const LABEL_VALUE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

const flag = (env: Env, name: string): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`${name} must be true or false`);
};

export const loadReleaseConfig = (env: Env): ReleaseCliConfig => {
  const newPoolLabel = env["VGR_NEW_POOL_LABEL"]?.trim() || "released";
  if (!LABEL_VALUE.test(newPoolLabel)) {
    throw new Error("VGR_NEW_POOL_LABEL must be letters, digits, - _ . only, starting and ending alphanumeric, at most 63 chars");
  }
  const currentRunId = integer(env, "GITHUB_RUN_ID", 0);
  return {
    ...common(env),
    sshPrivateKey: required(env, "VGR_SSH_PRIVATE_KEY"),
    newPoolLabel,
    force: flag(env, "VGR_FORCE"),
    ...(currentRunId === undefined ? {} : { currentRunId }),
  };
};
