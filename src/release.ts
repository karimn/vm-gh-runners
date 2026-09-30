import { runnersOfServer, type GithubHost } from "./github.ts";
import { serverLabels, type Provider } from "./provider.ts";
import type { RunnerRegistrar } from "./registrar.ts";

export interface ReleaseConfig {
  readonly pool: string;
  readonly repo: string;
  /** Value `pool` gets on the released server, so reap and ensure stop matching it. */
  readonly newPoolLabel: string;
  /** The release's own workflow run, excluded from the "repo is busy" check. */
  readonly currentRunId?: number;
  /** Skip the busy-runner and active-runs checks. GitHub still refuses a busy runner. */
  readonly force?: boolean;
}

export type ReleaseReason =
  | "released"
  | "no-server"
  | "ambiguous"
  | "not-running"
  | "same-pool"
  | "busy"
  | "active-runs"
  | "deregister-failed"
  | "uninstall-failed"
  | "relabel-failed";

export interface ReleaseResult {
  /** `refused` changed nothing; `error` may have changed something, see `error`. */
  readonly action: "released" | "refused" | "error";
  readonly reason: ReleaseReason;
  readonly serverId?: string;
  /** The server's name after release. */
  readonly name?: string;
  readonly previousName?: string;
  readonly address?: string;
  readonly error?: string;
}

const MAX_HOSTNAME = 63;

/**
 * Hostname-safe, at most 63 chars, and unique because the provider's id is in
 * it. It cannot be `serverName(...)`'s output: that is what ensure locks on, and
 * the point of renaming is to free it.
 */
export const releasedName = (newPoolLabel: string, serverId: string): string => {
  const slug = newPoolLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "released";
  const id = serverId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const prefix = slug.slice(0, MAX_HOSTNAME - id.length - 1).replace(/-+$/g, "");
  return prefix ? `${prefix}-${id}` : id;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Hand this pool's server for the repo to someone else: nothing in this repo
 * will schedule onto it, reap it or treat it as its own afterwards. Billing
 * continues; the new owner deletes it.
 *
 * Steps, in an order that keeps every failure recoverable:
 *  1. Guards, as in reap: no busy runner and no other active run in the repo.
 *  2. Deregister the runners, so GitHub stops scheduling onto them. GitHub
 *     refuses a busy runner, so this is also the last guard.
 *  3. Stop and uninstall the runner services over SSH.
 *  4. Relabel and rename in one request, so reap (which finds servers by label)
 *     and ensure (which locks on the name) no longer see it. This is last on
 *     purpose: until it succeeds the server is still the pool's, so a failure
 *     at 2 or 3 leaves something the next `ensure` repairs (it re-registers the
 *     missing runners) and a retry of release finishes.
 *
 * Refuses, rather than guessing, when zero or several servers match, or the
 * server is not running (it cannot be reached over SSH).
 */
export const release = async (
  provider: Provider,
  github: GithubHost,
  registrar: RunnerRegistrar,
  cfg: ReleaseConfig,
): Promise<ReleaseResult> => {
  if (cfg.newPoolLabel === cfg.pool) {
    return { action: "refused", reason: "same-pool", error: `the new pool label must differ from the pool "${cfg.pool}"` };
  }

  const servers = await provider.listServers(serverLabels(cfg.pool, cfg.repo));
  const [server] = servers;
  if (!server) return { action: "refused", reason: "no-server" };
  if (servers.length > 1) {
    return {
      action: "refused",
      reason: "ambiguous",
      error: `${servers.length} servers match (${servers.map((s) => s.name).join(", ")}); release one by hand`,
    };
  }

  const base = { serverId: server.id, name: server.name, previousName: server.name, address: server.address };
  if (server.status !== "running") return { ...base, action: "refused", reason: "not-running" };

  const mine = runnersOfServer(await github.listRunners(), server.name);
  if (!cfg.force) {
    if (mine.some((r) => r.busy)) return { ...base, action: "refused", reason: "busy" };
    if (await github.hasActiveRuns(cfg.currentRunId)) return { ...base, action: "refused", reason: "active-runs" };
  }

  try {
    for (const r of mine) await github.deregisterRunner(r.id);
  } catch (e) {
    return { ...base, action: "error", reason: "deregister-failed", error: message(e) };
  }

  try {
    await registrar.uninstall(server);
  } catch (e) {
    return { ...base, action: "error", reason: "uninstall-failed", error: message(e) };
  }

  try {
    const updated = await provider.updateServer(server.id, {
      name: releasedName(cfg.newPoolLabel, server.id),
      labels: { ...serverLabels(cfg.newPoolLabel, cfg.repo), "released-from": cfg.pool },
    });
    return { ...base, action: "released", reason: "released", name: updated.name };
  } catch (e) {
    return {
      ...base,
      action: "error",
      reason: "relabel-failed",
      error: `${message(e)} (the runners are already deregistered and their services removed)`,
    };
  }
};
