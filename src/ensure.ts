import { runnerName, type GithubHost } from "./github.ts";
import type { Provider, Server } from "./provider.ts";
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

/** Lowercase, hostname-safe, and stable for a given instant. */
const serverName = (cfg: EnsureConfig, now: Date): string => {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "").toLowerCase();
  return `${slug(cfg.pool)}-${slug(cfg.repo)}-${stamp}`;
};

/**
 * Reuse this pool's live server for this repo, or create one.
 *
 * Callers must serialise this (a `concurrency:` group in the workflow): two
 * concurrent calls can both see no server and each create one, and the
 * provider account has a small server cap.
 */
export const ensureServer = async (
  provider: Provider,
  cfg: EnsureConfig,
  now: Date = new Date(),
): Promise<EnsureResult> => {
  const labels = { pool: cfg.pool, repo: cfg.repo };
  const live = (await provider.listServers(labels))
    .filter((s) => LIVE.has(s.status))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const existing = live[0];
  if (existing) return { server: existing, created: false };

  const server = await provider.createServer({
    name: serverName(cfg, now),
    labels,
    serverType: cfg.serverType,
    image: cfg.image,
    location: cfg.location,
    userData: cfg.userData,
  });
  return { server, created: true };
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
  now: Date = new Date(),
): Promise<EnsureReadyResult> => {
  const ensured = await ensureServer(provider, cfg, now);
  const { registered } = await ensureRunners(github, registrar, ensured.server, cfg.runnerCount);
  return { ...ensured, registered };
};
