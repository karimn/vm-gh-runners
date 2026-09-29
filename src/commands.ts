import type { EnsureCliConfig, ReapCliConfig } from "./config.ts";
import { ensureReady } from "./ensure.ts";
import type { GithubHost } from "./github.ts";
import type { Provider } from "./provider.ts";
import { reap, type ReapResult } from "./reap.ts";
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

export interface EnsureOutcome {
  readonly outputs: Outputs;
  readonly summary: string;
}

/** Reuse or create the pool's server for the repo and bring its runners up. */
export const runEnsure = async (
  deps: EnsureDeps,
  cfg: EnsureCliConfig,
  now: Date = new Date(),
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
    now,
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

/** Lines for `$GITHUB_OUTPUT`. A newline in a value could forge a second output. */
export const toGithubOutput = (outputs: Outputs): string =>
  Object.entries(outputs)
    .map(([k, v]) => {
      if (/[\r\n]/.test(v) || /[\r\n=]/.test(k)) throw new Error(`output "${k}" contains a newline`);
      return `${k}=${v}\n`;
    })
    .join("");
