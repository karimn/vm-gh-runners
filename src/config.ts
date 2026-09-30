/**
 * Configuration comes from environment variables, not argv: a GitHub Actions
 * step passes secrets through `env:`, and command-line arguments are visible in
 * process listings. Error messages name the variable and never echo a value
 * that could be a secret.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface CommonConfig {
  /** `owner/name`. */
  readonly repo: string;
  readonly pool: string;
  readonly hcloudToken: string;
  /** A token allowed to manage this repo's runners (Administration: read and write). */
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
  /** Names or IDs of SSH keys already uploaded to the Hetzner project. */
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

const common = (env: Env): CommonConfig => {
  const repo = env["VGR_REPO"]?.trim() || required(env, "GITHUB_REPOSITORY");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("the repo must be in owner/name form");
  return {
    repo,
    pool: required(env, "VGR_POOL"),
    hcloudToken: required(env, "HCLOUD_TOKEN"),
    githubToken: required(env, "VGR_GITHUB_TOKEN"),
  };
};

export const loadEnsureConfig = (env: Env): EnsureCliConfig => {
  const base = common(env);
  const labels = list(env["VGR_RUNNER_LABELS"]);
  return {
    ...base,
    serverType: required(env, "VGR_SERVER_TYPE"),
    image: env["VGR_IMAGE"]?.trim() || "ubuntu-24.04",
    location: env["VGR_LOCATION"]?.trim() || "nbg1",
    runnerCount: integer(env, "VGR_RUNNER_COUNT", 1) ?? 3,
    labels: labels.length > 0 ? labels : ["vm-gh-runners", `pool-${base.pool}`],
    runnerVersion: env["VGR_RUNNER_VERSION"]?.trim() || "latest",
    extraPackages: list(env["VGR_EXTRA_PACKAGES"]),
    sshKeyNames: list(required(env, "VGR_SSH_KEY_NAMES")),
    sshPrivateKey: required(env, "VGR_SSH_PRIVATE_KEY"),
  };
};

export const loadReapConfig = (env: Env): ReapCliConfig => {
  const windowStartMinute = integer(env, "VGR_WINDOW_START_MINUTE", 0, 59);
  const currentRunId = integer(env, "GITHUB_RUN_ID", 0);
  return {
    ...common(env),
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
