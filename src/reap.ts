import { shouldReap } from "./billing.ts";
import { runnersOfServer, type GithubHost } from "./github.ts";
import { runOf, serverLabels, type Provider, type Server } from "./provider.ts";

export interface ReapConfig {
  readonly pool: string;
  readonly repo: string;
  /** The reaper's own workflow run, excluded from the "repo is busy" check. */
  readonly currentRunId?: number;
  /** Only used when the provider bills per started hour; see `shouldReap`. */
  readonly windowStartMinute?: number;
  /**
   * Tear down one run's server (the `teardown` job of a run that gave `ensure`
   * the same `run-id`) and nothing else. Without it, every server of the pool is
   * considered: per-run servers by their run's state, shared servers as before.
   */
  readonly runId?: string;
  /**
   * Delete a per-run server older than this regardless of its run's state, so a
   * stuck run cannot hold a server (and a slot in the quota) forever. Off when unset.
   */
  readonly maxAgeMinutes?: number;
}

export type ReapReason =
  | "outside-window"
  | "busy"
  | "active-runs"
  | "run-active"
  | "run-check-failed"
  | "max-age"
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

// `error` servers are included so a failed build does not bill forever.
const REAPABLE: ReadonlySet<Server["status"]> = new Set(["starting", "running", "error"]);

/**
 * Delete this pool's idle servers.
 *
 * Shared-pool servers (no run label): when the provider bills per started hour
 * that means only inside the last minutes of a paid hour; when it bills by
 * actual runtime, as soon as they are idle. "Idle" is deliberately conservative:
 * no runner on the server is busy AND the repo has no other queued or in-progress
 * run. A run between two jobs has no busy runner, so runner state alone would
 * delete a server out from under it.
 *
 * Per-run servers (labelled with the run that `ensure` was given):
 *  - With `cfg.runId` (a run's own teardown job): only that run's server, deleted
 *    unless a runner on it is busy. The repo-wide check is skipped, since other
 *    runs have servers of their own, and the run itself is not counted: its
 *    teardown job is the last one.
 *  - Without it (the scheduled safety net): kept while its run is still active,
 *    deleted once the run is finished or gone (a cancelled or crashed run never
 *    ran its teardown). `cfg.maxAgeMinutes` deletes it regardless.
 *  Nothing will ever reuse a per-run server, so the paid-hour window does not
 *  apply: waiting out the hour would buy nothing and hold a slot of a capped project.
 *
 * Runners are deregistered before the server is deleted. GitHub refuses to
 * remove a busy runner, so that call is also the last guard against a job that
 * landed after the busy check. If any deregistration fails the server is kept
 * and the failure reported; runners already removed stay removed, so a retry
 * (the next scheduled tick) finds fewer runners rather than none. The max-age
 * path is the exception: it deregisters what it can and deletes anyway.
 *
 * Servers that are stopping or already off are ignored here.
 */
export const reap = async (
  provider: Provider,
  github: GithubHost,
  cfg: ReapConfig,
  now: Date = new Date(),
): Promise<readonly ReapResult[]> => {
  const servers = (await provider.listServers(serverLabels(cfg.pool, cfg.repo)))
    .filter((s) => REAPABLE.has(s.status))
    .filter((s) => cfg.runId === undefined || runOf(s) === cfg.runId);
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
    const run = runOf(server);
    // Stuck-run cap: skips every guard, because the guards are what is stuck.
    const expired =
      run !== undefined &&
      cfg.maxAgeMinutes !== undefined &&
      now.getTime() - server.createdAt.getTime() >= cfg.maxAgeMinutes * 60_000;

    // A server that errored cannot be running a job, and it bills, so it skips
    // the idle checks and the paid-hour window. Its runners, if any, still go.
    if (server.status !== "error" && !expired) {
      if (run === undefined) {
        if (
          !shouldReap({
            now,
            createdAt: server.createdAt,
            busy: false,
            billing: provider.billing,
            windowStartMinute: cfg.windowStartMinute,
          })
        ) {
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
      } else {
        if (cfg.runId === undefined) {
          // Scheduled sweep: the run's own teardown has not (or never) run.
          let state;
          try {
            state = await github.runState(Number(run));
          } catch (e) {
            results.push({
              ...base,
              action: "error",
              reason: "run-check-failed",
              error: e instanceof Error ? e.message : String(e),
            });
            continue;
          }
          if (state === "active") {
            results.push({ ...base, action: "kept", reason: "run-active" });
            continue;
          }
        }
        if (mine.some((r) => r.busy)) {
          results.push({ ...base, action: "kept", reason: "busy" });
          continue;
        }
      }
    }

    try {
      for (const r of mine) {
        // Past the age cap a busy runner (which GitHub refuses to remove) must not save the server.
        if (expired) await github.deregisterRunner(r.id).catch(() => {});
        else await github.deregisterRunner(r.id);
      }
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
    results.push({ ...base, action: "deleted", reason: expired ? "max-age" : "deleted" });
  }
  return results;
};
