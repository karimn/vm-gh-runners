import type { Provider, Server } from "./provider.ts";

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
