import { buildImage, sweepStaleBuilders, type BuildImageDeps, type BuildImageOptions, type BuildImageResult } from "./build-image.ts";
import type { BuildImageCliConfig, EnsureCliConfig, ReapCliConfig, ReleaseCliConfig } from "./config.ts";
import { ensureReady, type EnsureOptions } from "./ensure.ts";
import type { GithubHost } from "./github.ts";
import { BUILT_IMAGE_REF, resolveImage, type ResolvedImage } from "./images.ts";
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

export interface RunEnsureOptions extends EnsureOptions {
  readonly now?: () => Date;
}

const DAY_MS = 86_400_000;

/**
 * Resolves `latest-built`, and says what a human should know about the result.
 * A lookup that fails falls back to the stock image rather than failing the run:
 * the stock image works, only slower, and the warning says why.
 */
const imageFor = async (
  provider: Provider,
  cfg: EnsureCliConfig,
  now: Date,
): Promise<{ resolved: ResolvedImage; notes: string[] }> => {
  const notes: string[] = [];
  let resolved: ResolvedImage;
  try {
    resolved = await resolveImage(provider, cfg);
  } catch (e) {
    notes.push(
      `::warning::could not look up built images (${e instanceof Error ? e.message : String(e)}); booting the stock image with the full setup`,
    );
    return { resolved: { image: cfg.baseImage, built: false }, notes };
  }
  if (cfg.image === BUILT_IMAGE_REF && !resolved.built) {
    notes.push(
      `::warning::no built image for pool "${cfg.pool}"; booting the stock image with the full setup (about 2 minutes slower). Run the build-image workflow.`,
    );
  }
  if (resolved.builtAt) {
    const days = Math.floor((now.getTime() - resolved.builtAt.getTime()) / DAY_MS);
    if (days > cfg.maxImageAgeDays) {
      notes.push(
        `::warning::the newest built image ${resolved.name} is ${days} days old (limit ${cfg.maxImageAgeDays}): is the scheduled build-image workflow failing or disabled?`,
      );
    }
  }
  return { resolved, notes };
};

/** Reuse or create the pool's server for the repo and bring its runners up. */
export const runEnsure = async (
  deps: EnsureDeps,
  cfg: EnsureCliConfig,
  options: RunEnsureOptions = {},
): Promise<EnsureOutcome> => {
  const userData = buildUserData({
    runnerVersion: cfg.runnerVersion,
    extraPackages: cfg.extraPackages,
  });
  const { now = () => new Date(), ...ensureOptions } = options;
  const { resolved, notes } = await imageFor(deps.provider, cfg, now());
  const r = await ensureReady(
    deps.provider,
    deps.github,
    deps.registrar,
    {
      pool: cfg.pool,
      repo: cfg.repo,
      serverType: cfg.serverType,
      image: resolved.image,
      location: cfg.location,
      userData,
      runnerCount: cfg.runnerCount,
      runId: cfg.runId,
    },
    ensureOptions,
  );
  return {
    outputs: {
      server_id: r.server.id,
      server_name: r.server.name,
      created: String(r.created),
      registered: String(r.registered.length),
      // Feed straight into `runs-on: ${{ fromJSON(...) }}` so callers hard-code nothing.
      // Exactly the runners' labels: they carry no `self-hosted` (see SshRegistrar).
      runs_on: JSON.stringify(cfg.labels),
      // Empty for a reused server: it keeps whatever image it booted, not this one.
      image: r.created ? (resolved.name ?? resolved.image) : "",
      image_built: r.created ? String(resolved.built) : "",
    },
    summary: [
      `server ${r.server.name} (${r.server.id}): ${r.created ? "created" : "reused"}; ` +
        `registered ${r.registered.length} runner(s)`,
      // Only a created server booted an image; a reused one keeps the one it has.
      ...(r.created ? [`image: ${resolved.name ?? resolved.image}${resolved.built ? " (built)" : ""}`] : []),
      ...notes,
    ].join("\n"),
  };
};

export interface BuildImageOutcome {
  readonly result: BuildImageResult;
  readonly outputs: Outputs;
  readonly summary: string;
  /** True if the image was built but older ones could not all be deleted: storage would grow unnoticed. */
  readonly failed: boolean;
}

/** Build the pool's image and prune the old ones. See `buildImage`. */
export const runBuildImage = async (
  deps: BuildImageDeps,
  cfg: BuildImageCliConfig,
  options: BuildImageOptions = {},
): Promise<BuildImageOutcome> => {
  const result = await buildImage(
    deps,
    {
      pool: cfg.pool,
      serverType: cfg.serverType,
      baseImage: cfg.baseImage,
      location: cfg.location,
      runnerVersion: cfg.runnerVersion,
      extraPackages: cfg.extraPackages,
      prepullImages: cfg.prepullImages,
      registry: cfg.registry,
      keep: cfg.keep,
    },
    options,
  );
  const { failed, deleted } = result.pruned;
  return {
    result,
    outputs: { image_id: result.imageId, image_name: result.imageName, pruned: String(deleted.length) },
    summary: [
      `built image ${result.imageName} (${result.imageId})${result.rebooted ? " after a reboot" : ""}`,
      ...(result.sweptBuilders.length > 0 ? [`deleted stale builder server(s): ${result.sweptBuilders.join(", ")}`] : []),
      `pruned ${deleted.length} older image(s)${deleted.length > 0 ? `: ${deleted.join(", ")}` : ""}`,
      ...failed.map((f) => `could not delete image ${f.name} (${f.id}): ${f.error}`),
    ].join("\n"),
    failed: failed.length > 0,
  };
};

export interface ReapOutcome {
  readonly results: readonly ReapResult[];
  readonly outputs: Outputs;
  /** True if any server could not be handled, so the workflow should go red. */
  readonly failed: boolean;
}

/**
 * Delete this pool's idle servers: in the last minutes of a paid hour where the
 * provider bills per started hour, at once where it bills by runtime.
 */
export const runReap = async (
  deps: ReapDeps,
  cfg: ReapCliConfig,
  now: Date = new Date(),
): Promise<ReapOutcome> => {
  // A killed build-image run leaves its temporary server; this is the schedule that catches it.
  // Its failure must not stop the real reap, but it is reported, since a builder bills.
  const sweepFailure: ReapResult[] = [];
  const stale = await sweepStaleBuilders(deps.provider, cfg.pool, now).catch((e: unknown) => {
    sweepFailure.push({
      serverId: "",
      name: "(stale builder sweep)",
      action: "error",
      reason: "delete-failed",
      error: e instanceof Error ? e.message : String(e),
    });
    return [] as readonly string[];
  });
  const results = await reap(
    deps.provider,
    deps.github,
    {
      pool: cfg.pool,
      repo: cfg.repo,
      currentRunId: cfg.currentRunId,
      windowStartMinute: cfg.windowStartMinute,
      runId: cfg.runId,
      maxAgeMinutes: cfg.maxAgeMinutes,
    },
    now,
  );
  const all: readonly ReapResult[] = [
    ...stale.map((name): ReapResult => ({ serverId: "", name, action: "deleted", reason: "stale-builder" })),
    ...sweepFailure,
    ...results,
  ];
  const count = (action: ReapResult["action"]) => all.filter((r) => r.action === action).length;
  return {
    results: all,
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
      "billing continues until the new owner deletes the server.",
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
    runId: cfg.runId,
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
