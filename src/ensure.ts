import { createHash } from "node:crypto";
import { runnerName, type GithubHost } from "./github.ts";
import { ServerExistsError, serverLabels, type Provider, type Server } from "./provider.ts";
import type { RunnerRegistrar } from "./registrar.ts";

export interface EnsureConfig {
  /** Names a group of servers, so several consumers can share one provider account. */
  readonly pool: string;
  /** The consuming repo, e.g. `owner/name`. A personal-account runner serves one repo only. */
  readonly repo: string;
  readonly serverType: string;
  readonly image: string;
  readonly location: string;
  readonly userData: string;
}

export interface EnsureResult {
  readonly server: Server;
  readonly created: boolean;
}

const LIVE: ReadonlySet<Server["status"]> = new Set(["starting", "running"]);

const MAX_HOSTNAME = 63;
const HASH_LENGTH = 8;

/**
 * Deterministic, hostname-safe and at most 63 chars. Being deterministic is the
 * point: the provider refuses a second server with the same name, so of several
 * concurrent `ensureServer` calls exactly one can create it. The readable prefix
 * is truncated if long; the hash of the exact pool and repo keeps distinct
 * pools and repos distinct even when their prefixes slug alike or get cut.
 */
export const serverName = (cfg: Pick<EnsureConfig, "pool" | "repo">): string => {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const hash = createHash("sha256")
    .update(`${cfg.pool}\0${cfg.repo}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const prefix = `${slug(cfg.pool)}-${slug(cfg.repo)}`
    .slice(0, MAX_HOSTNAME - HASH_LENGTH - 1)
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${hash}`;
};

export interface EnsureOptions {
  /**
   * How many times to re-check after losing a create race, or after finding a
   * server another run is still building. Default 30.
   */
  readonly conflictAttempts?: number;
  /** Wait between re-checks. Default 10 s: enough for a deleted server to free its name. */
  readonly conflictDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Reuse this pool's live server for this repo, or create one.
 *
 * Safe to call concurrently, from any number of workflow runs. A workflow
 * `concurrency:` group is NOT a substitute: GitHub cancels all but the newest
 * pending job in a group, which would fail real CI runs.
 *
 * Losing a race is normal, not an error: the creator that loses gets
 * `ServerExistsError`, waits, and reuses the winner's server. The same path
 * covers a previous server that is still being deleted and holds the name.
 */
export const ensureServer = async (
  provider: Provider,
  cfg: EnsureConfig,
  options: EnsureOptions = {},
): Promise<EnsureResult> => {
  const {
    conflictAttempts = 30,
    conflictDelayMs = 10_000,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = options;
  const labels = serverLabels(cfg.pool, cfg.repo);
  const name = serverName(cfg);
  let unaddressed: Server | undefined;

  for (let attempt = 1; attempt <= conflictAttempts; attempt++) {
    const live = (await provider.listServers(labels))
      .filter((s) => LIVE.has(s.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const existing = live[0];
    if (existing?.address !== undefined) return { server: existing, created: false };
    if (existing) {
      // Another run created it and the provider has not assigned an address yet
      // (OpenStack servers appear before they have one). It cannot be registered
      // against until it does, so wait rather than create a second server.
      unaddressed = existing;
      if (attempt < conflictAttempts) await sleep(conflictDelayMs);
      continue;
    }
    unaddressed = undefined;

    try {
      const server = await provider.createServer({
        name,
        labels,
        serverType: cfg.serverType,
        image: cfg.image,
        location: cfg.location,
        userData: cfg.userData,
      });
      return { server, created: true };
    } catch (e) {
      if (!(e instanceof ServerExistsError)) throw e;
      if (attempt < conflictAttempts) await sleep(conflictDelayMs);
    }
  }
  if (unaddressed) {
    throw new Error(
      `server ${unaddressed.name} (${unaddressed.id}) still has no address after ${conflictAttempts} checks`,
    );
  }
  throw new Error(
    `a server named "${name}" already exists but is not a live server of pool "${cfg.pool}" ` +
      `for ${cfg.repo}; gave up after ${conflictAttempts} checks`,
  );
};

export interface EnsureReadyConfig extends EnsureConfig {
  /** Runners per server. Also the number that repair restores after a partial reap. */
  readonly runnerCount: number;
}

export interface EnsureRunnersResult {
  /** Names registered by this call: missing ones, and offline ones re-registered. */
  readonly registered: readonly string[];
}

/**
 * Make sure `count` runners named `<server>-1..count` are registered and online.
 *
 * The same call does first-time registration and repair, e.g. after a reap that
 * deregistered some runners and then failed. A runner that is registered but
 * offline is re-registered too; the registrar replaces same-name entries.
 *
 * Not safe to call concurrently for one server, for the same reason as
 * `ensureServer`: serialise it with the workflow's `concurrency:` group.
 */
export const ensureRunners = async (
  github: GithubHost,
  registrar: RunnerRegistrar,
  server: Server,
  count: number,
): Promise<EnsureRunnersResult> => {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`runnerCount must be a positive integer, got ${count}`);
  }
  const online = new Set(
    (await github.listRunners()).filter((r) => r.status === "online").map((r) => r.name),
  );
  const missing = Array.from({ length: count }, (_, i) => runnerName(server.name, i + 1)).filter(
    (name) => !online.has(name),
  );
  if (missing.length > 0) await registrar.register(server, missing);
  return { registered: missing };
};

export interface EnsureReadyResult extends EnsureResult, EnsureRunnersResult {}

/**
 * Reuse or create the server, then bring its runners up to `runnerCount`.
 *
 * If registration fails on a server this call just created, the server is left
 * running and the error propagates. The hour is billed from creation either
 * way, so deleting it would save nothing; the next call reuses it and retries
 * registration. If registration keeps failing, the reaper removes the server at
 * the end of its paid hour and the next call starts a fresh one.
 */
export const ensureReady = async (
  provider: Provider,
  github: GithubHost,
  registrar: RunnerRegistrar,
  cfg: EnsureReadyConfig,
  options: EnsureOptions = {},
): Promise<EnsureReadyResult> => {
  const ensured = await ensureServer(provider, cfg, options);
  const { registered } = await ensureRunners(github, registrar, ensured.server, cfg.runnerCount);
  return { ...ensured, registered };
};
