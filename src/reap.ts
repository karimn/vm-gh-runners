import { shouldReap } from "./billing.ts";
import { runnersOfServer, type GithubHost } from "./github.ts";
import type { Provider, Server } from "./provider.ts";

export interface ReapConfig {
  readonly pool: string;
  readonly repo: string;
  /** The reaper's own workflow run, excluded from the "repo is busy" check. */
  readonly currentRunId?: number;
  readonly windowStartMinute?: number;
}

export type ReapReason =
  | "outside-window"
  | "busy"
  | "active-runs"
  | "deleted"
  | "deregister-failed"
  | "delete-failed";

export interface ReapResult {
  readonly serverId: string;
  readonly name: string;
  readonly action: "kept" | "deleted" | "error";
  readonly reason: ReapReason;
  readonly error?: string;
}

const LIVE: ReadonlySet<Server["status"]> = new Set(["starting", "running"]);

/**
 * Delete this pool's idle servers that are inside the last minutes of a paid hour.
 *
 * "Idle" is deliberately conservative: no runner on the server is busy AND the
 * repo has no other queued or in-progress run. A run between two jobs has no
 * busy runner, so runner state alone would delete a server out from under it.
 *
 * Runners are deregistered before the server is deleted. GitHub refuses to
 * remove a busy runner, so that call is also the last guard against a job that
 * landed after the busy check. If any deregistration fails the server is kept
 * and the failure reported; runners already removed stay removed, so a retry
 * (the next scheduled tick) finds fewer runners rather than none.
 *
 * Servers that are stopping or already off are ignored here.
 */
export const reap = async (
  provider: Provider,
  github: GithubHost,
  cfg: ReapConfig,
  now: Date = new Date(),
): Promise<readonly ReapResult[]> => {
  const servers = (await provider.listServers({ pool: cfg.pool, repo: cfg.repo })).filter(
    (s) => LIVE.has(s.status),
  );
  if (servers.length === 0) return [];

  const runners = await github.listRunners();
  // Repo-wide, so ask at most once, and only if some server got that far.
  let activeRuns: boolean | undefined;
  const repoHasActiveRuns = async () =>
    (activeRuns ??= await github.hasActiveRuns(cfg.currentRunId));

  const results: ReapResult[] = [];
  for (const server of servers) {
    const base = { serverId: server.id, name: server.name };
    const mine = runnersOfServer(runners, server.name);

    if (!shouldReap({ now, createdAt: server.createdAt, busy: false, windowStartMinute: cfg.windowStartMinute })) {
      results.push({ ...base, action: "kept", reason: "outside-window" });
      continue;
    }
    if (mine.some((r) => r.busy)) {
      results.push({ ...base, action: "kept", reason: "busy" });
      continue;
    }
    if (await repoHasActiveRuns()) {
      results.push({ ...base, action: "kept", reason: "active-runs" });
      continue;
    }

    try {
      for (const r of mine) await github.deregisterRunner(r.id);
    } catch (e) {
      results.push({
        ...base,
        action: "error",
        reason: "deregister-failed",
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    // The runners are gone by now, so a failure here leaves a billing server
    // with no runners. Report it loudly and carry on with the other servers.
    try {
      await provider.deleteServer(server.id);
    } catch (e) {
      results.push({
        ...base,
        action: "error",
        reason: "delete-failed",
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    results.push({ ...base, action: "deleted", reason: "deleted" });
  }
  return results;
};
