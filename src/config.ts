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

/** The `image` value that boots the newest built image; see `images.ts`. */
const BUILT_IMAGE_REF = "latest-built";

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
  /**
   * The workflow run that owns the server, `${{ github.run_id }}`. Unset is
   * shared-pool mode. Digits only: it goes into labels and the server's identity.
   */
  readonly runId?: string;
}

export interface EnsureCliConfig extends CommonConfig {
  readonly serverType: string;
  /** An image name or id, or `latest-built` for the newest image `build-image` made for the pool. */
  readonly image: string;
  /** The stock image: what `latest-built` falls back to when the pool has no built image yet. */
  readonly baseImage: string;
  /** Warn (not fail) when the newest built image is older than this many days. */
  readonly maxImageAgeDays: number;
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

export interface BuildImageCliConfig {
  readonly pool: string;
  /** `owner/name`; in Actions it is `GITHUB_REPOSITORY`. Part of the image's name. */
  readonly repo: string;
  readonly provider: ProviderConfig;
  readonly serverType: string;
  readonly baseImage: string;
  readonly location: string;
  readonly runnerVersion: string;
  readonly extraPackages: readonly string[];
  readonly prepullImages: readonly string[];
  readonly registry?: { readonly host: string; readonly username: string; readonly password: string };
  readonly keep: number;
  readonly sshKeyNames: readonly string[];
  readonly sshPrivateKey: string;
}

export interface ReapCliConfig extends CommonConfig {
  readonly windowStartMinute?: number;
  readonly currentRunId?: number;
  /** Delete per-run servers older than this regardless of their run's state. Off when unset. */
  readonly maxAgeMinutes?: number;
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

const repoFrom = (env: Env): string => {
  const repo = env["VGR_REPO"]?.trim() || required(env, "GITHUB_REPOSITORY");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("the repo must be in owner/name form");
  return repo;
};

const common = (env: Env): CommonConfig => {
  const repo = repoFrom(env);
  const runId = env["VGR_RUN_ID"]?.trim();
  // Actions passes an unset input as "". Anything else must be a real run id.
  if (runId && !/^\d{1,20}$/.test(runId)) throw new Error("VGR_RUN_ID must be a workflow run id (digits only)");
  return {
    repo,
    pool: required(env, "VGR_POOL"),
    provider: providerConfig(env),
    githubToken: required(env, "VGR_GITHUB_TOKEN"),
    ...(runId ? { runId } : {}),
  };
};

/**
 * GitHub's default runner labels. Runners are registered without them, so a
 * plain `runs-on: self-hosted` job elsewhere in the repo cannot land on a pool
 * VM; a caller listing one would quietly undo that. GitHub matches labels
 * case-insensitively, so this does too.
 */
const DEFAULT_GITHUB_LABELS = new Set(["self-hosted", "linux", "x64"]);

/**
 * With a run id the labels must be run-scoped, or two runs' jobs could land on
 * each other's runners. A caller's own labels get `run-<id>` appended if missing.
 */
const runnerLabels = (given: readonly string[], base: CommonConfig): readonly string[] => {
  const reserved = given.filter((l) => DEFAULT_GITHUB_LABELS.has(l.toLowerCase()));
  if (reserved.length > 0) {
    throw new Error(
      `VGR_RUNNER_LABELS must not include GitHub's default labels (${reserved.join(", ")}): ` +
        "runners are registered without them so that jobs targeting them cannot land on the pool's VMs",
    );
  }
  const labels = given.length > 0 ? given : ["vm-gh-runners", `pool-${base.pool}`];
  const run = base.runId === undefined ? undefined : `run-${base.runId}`;
  return run === undefined || labels.includes(run) ? labels : [...labels, run];
};

/** `config.sh --no-default-labels` first shipped in runner v2.305.0. */
const MIN_RUNNER_VERSION = [2, 305, 0] as const;

const runnerVersion = (env: Env): string => {
  const v = env["VGR_RUNNER_VERSION"]?.trim() || "latest";
  if (v === "latest") return v;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`VGR_RUNNER_VERSION must be "latest" or a version such as 2.321.0, got "${v}"`);
  const parts = m.slice(1).map(Number);
  const i = parts.findIndex((p, k) => p !== MIN_RUNNER_VERSION[k]);
  if (i !== -1 && parts[i]! < MIN_RUNNER_VERSION[i]!) {
    throw new Error(`VGR_RUNNER_VERSION must be at least ${MIN_RUNNER_VERSION.join(".")} (--no-default-labels), got ${v}`);
  }
  return v;
};

export const loadEnsureConfig = (env: Env): EnsureCliConfig => {
  const base = common(env);
  const labels = list(env["VGR_RUNNER_LABELS"]);
  const sshKeyNames = list(required(env, "VGR_SSH_KEY_NAMES"));
  if (base.provider.kind === "ovh" && sshKeyNames.length !== 1) {
    throw new Error("VGR_SSH_KEY_NAMES must name exactly one key pair for ovh (Nova takes one per server)");
  }
  const defaults = DEFAULTS[base.provider.kind];
  const image = env["VGR_IMAGE"]?.trim() || defaults.image;
  if (image === BUILT_IMAGE_REF && base.provider.kind !== "ovh") {
    throw new Error(`VGR_IMAGE ${BUILT_IMAGE_REF} is only supported on ovh`);
  }
  return {
    ...base,
    serverType: required(env, "VGR_SERVER_TYPE"),
    image,
    baseImage: env["VGR_BASE_IMAGE"]?.trim() || defaults.image,
    maxImageAgeDays: integer(env, "VGR_MAX_IMAGE_AGE_DAYS", 1) ?? 14,
    location: base.provider.kind === "ovh" ? base.provider.region : env["VGR_LOCATION"]?.trim() || defaults.location,
    runnerCount: integer(env, "VGR_RUNNER_COUNT", 1) ?? 3,
    labels: runnerLabels(labels, base),
    runnerVersion: runnerVersion(env),
    extraPackages: list(env["VGR_EXTRA_PACKAGES"]),
    sshKeyNames,
    sshPrivateKey: required(env, "VGR_SSH_PRIVATE_KEY"),
  };
};

export const loadBuildImageConfig = (env: Env): BuildImageCliConfig => {
  const provider = providerConfig(env);
  if (provider.kind !== "ovh") throw new Error("build-image is only supported on ovh");
  const sshKeyNames = list(required(env, "VGR_SSH_KEY_NAMES"));
  if (sshKeyNames.length !== 1) {
    throw new Error("VGR_SSH_KEY_NAMES must name exactly one key pair for ovh (Nova takes one per server)");
  }
  const username = env["VGR_REGISTRY_USERNAME"]?.trim();
  const password = env["VGR_REGISTRY_PASSWORD"];
  // Actions passes an unset input as "". One without the other is a mistake, not "public images".
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("VGR_REGISTRY_USERNAME and VGR_REGISTRY_PASSWORD must be given together");
  }
  return {
    pool: required(env, "VGR_POOL"),
    repo: repoFrom(env),
    provider,
    serverType: required(env, "VGR_SERVER_TYPE"),
    baseImage: env["VGR_BASE_IMAGE"]?.trim() || DEFAULTS.ovh.image,
    location: provider.region,
    runnerVersion: runnerVersion(env),
    extraPackages: list(env["VGR_EXTRA_PACKAGES"]),
    // One per line in a workflow's multi-line input, or comma separated.
    prepullImages: (env["VGR_PREPULL_IMAGES"] ?? "").split(/[\s,]+/).filter(Boolean),
    ...(username && password
      ? { registry: { host: env["VGR_REGISTRY"]?.trim() || "ghcr.io", username, password } }
      : {}),
    // At least 2: with 1, a build could delete the image a concurrent ensure just resolved.
    keep: integer(env, "VGR_KEEP_IMAGES", 2) ?? 2,
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
  const maxAgeMinutes = integer(env, "VGR_MAX_AGE_MINUTES", 1);
  return {
    ...base,
    ...(windowStartMinute === undefined ? {} : { windowStartMinute }),
    ...(maxAgeMinutes === undefined ? {} : { maxAgeMinutes }),
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
