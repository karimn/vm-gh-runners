import type { EnsureCliConfig, ReapCliConfig, ReleaseCliConfig } from "./config.ts";
import { ensureReady, type EnsureOptions } from "./ensure.ts";
import type { GithubHost } from "./github.ts";
import type { Provider } from "./provider.ts";
import { reap, type ReapResult } from "./reap.ts";
import { release, type ReleaseResult } from "./release.ts";
import type { RunnerRegistrar } from "./registrar.ts";
import { buildUserData } from "./userdata.ts";

export type Outputs = Readonly<Record<string, string>>;

export interface EnsureDeps {
  readonly provider: Provider;
  readonly github: GithubHost;
  readonly registrar: RunnerRegistrar;
}

export interface ReapDeps {
  readonly provider: Provider;
  readonly github: GithubHost;
}

export interface ReleaseDeps {
  readonly provider: Provider;
  readonly github: GithubHost;
  readonly registrar: RunnerRegistrar;
}

export interface EnsureOutcome {
  readonly outputs: Outputs;
  readonly summary: string;
}

/** Reuse or create the pool's server for the repo and bring its runners up. */
export const runEnsure = async (
  deps: EnsureDeps,
  cfg: EnsureCliConfig,
  options: EnsureOptions = {},
): Promise<EnsureOutcome> => {
  const userData = buildUserData({
    runnerVersion: cfg.runnerVersion,
    extraPackages: cfg.extraPackages,
  });
  const r = await ensureReady(
    deps.provider,
    deps.github,
    deps.registrar,
    {
      pool: cfg.pool,
      repo: cfg.repo,
      serverType: cfg.serverType,
      image: cfg.image,
      location: cfg.location,
      userData,
      runnerCount: cfg.runnerCount,
    },
    options,
  );
  return {
    outputs: {
      server_id: r.server.id,
      server_name: r.server.name,
      created: String(r.created),
      registered: String(r.registered.length),
      // Feed straight into `runs-on: ${{ fromJSON(...) }}` so callers hard-code nothing.
      runs_on: JSON.stringify(["self-hosted", ...cfg.labels]),
    },
    summary:
      `server ${r.server.name} (${r.server.id}): ${r.created ? "created" : "reused"}; ` +
      `registered ${r.registered.length} runner(s)`,
  };
};

export interface ReapOutcome {
  readonly results: readonly ReapResult[];
  readonly outputs: Outputs;
  /** True if any server could not be handled, so the workflow should go red. */
  readonly failed: boolean;
}

/** Delete this pool's idle servers that are in the last minutes of a paid hour. */
export const runReap = async (
  deps: ReapDeps,
  cfg: ReapCliConfig,
  now: Date = new Date(),
): Promise<ReapOutcome> => {
  const results = await reap(
    deps.provider,
    deps.github,
    {
      pool: cfg.pool,
      repo: cfg.repo,
      currentRunId: cfg.currentRunId,
      windowStartMinute: cfg.windowStartMinute,
    },
    now,
  );
  const count = (action: ReapResult["action"]) => results.filter((r) => r.action === action).length;
  return {
    results,
    outputs: {
      deleted: String(count("deleted")),
      kept: String(count("kept")),
      errors: String(count("error")),
    },
    failed: count("error") > 0,
  };
};

export const formatReapResults = (results: readonly ReapResult[]): string =>
  results.length === 0
    ? "no servers in this pool"
    : results
        .map((r) => `${r.name}: ${r.action} (${r.reason})${r.error ? ` ${r.error}` : ""}`)
        .join("\n");

export interface ReleaseOutcome {
  readonly result: ReleaseResult;
  /** Empty unless the server was released. */
  readonly outputs: Outputs;
  readonly summary: string;
  /** True unless the server was released: the step exists to release it. */
  readonly failed: boolean;
}

const RELEASE_REFUSALS: Readonly<Record<string, string>> = {
  "no-server": "no server in this pool for this repo",
  ambiguous: "more than one server matches",
  "not-running": "the server is not running, so its runner services cannot be stopped",
  "same-pool": "the new pool label equals the current pool",
  busy: "a runner on the server is busy; wait for the job or cancel it",
  "active-runs": "the repo has other queued or in-progress runs; wait, or set force",
  "deregister-failed": "runners could not be deregistered; the server is still in the pool (some runners may be gone, and the next ensure restores them)",
  "uninstall-failed": "runner services could not be removed; the runners are deregistered but the server is still in the pool, so run release again or let ensure restore them",
  "relabel-failed": "the server could not be relabelled; its runners are deregistered and their services removed, so run release again",
};

export const formatReleaseResult = (r: ReleaseResult): string => {
  if (r.action === "released") {
    return [
      `released server ${r.previousName} (id ${r.serverId}) as ${r.name}`,
      `address: ${r.address ?? "none"}`,
      "reap and ensure no longer see it; nothing will delete it.",
      "Hetzner billing continues until the new owner deletes the server.",
    ].join("\n");
  }
  const what = RELEASE_REFUSALS[r.reason] ?? r.reason;
  const who = r.previousName ? ` ${r.previousName}` : "";
  return `release ${r.action === "refused" ? "refused" : "failed"} for${who || " this pool"} (${r.reason}): ${what}${r.error ? `\n${r.error}` : ""}`;
};

/** Hand the pool's server to another owner. See `release` for the steps. */
export const runRelease = async (deps: ReleaseDeps, cfg: ReleaseCliConfig): Promise<ReleaseOutcome> => {
  const result = await release(deps.provider, deps.github, deps.registrar, {
    pool: cfg.pool,
    repo: cfg.repo,
    newPoolLabel: cfg.newPoolLabel,
    force: cfg.force,
    currentRunId: cfg.currentRunId,
  });
  const released = result.action === "released";
  return {
    result,
    outputs: released
      ? { server_id: result.serverId ?? "", server_name: result.name ?? "", server_ip: result.address ?? "" }
      : {},
    summary: formatReleaseResult(result),
    failed: !released,
  };
};

/** Lines for `$GITHUB_OUTPUT`. A newline in a value could forge a second output. */
export const toGithubOutput = (outputs: Outputs): string =>
  Object.entries(outputs)
    .map(([k, v]) => {
      if (/[\r\n]/.test(v) || /[\r\n=]/.test(k)) throw new Error(`output "${k}" contains a newline`);
      return `${k}=${v}\n`;
    })
    .join("");
