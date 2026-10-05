import { createHash } from "node:crypto";
import { imageName, pruneImages, type PruneResult } from "./images.ts";
import type { Provider, Server } from "./provider.ts";
import { shq } from "./ssh-registrar.ts";
import type { Ssh, SshResult } from "./ssh.ts";
import { BUILDER_USER_DATA, buildBakeScript, buildFinalizeScript } from "./userdata.ts";

/**
 * Builds the image `ensure` boots (`image: latest-built`): a temporary server is
 * brought up from the stock image, given everything that does not depend on a
 * run, cleaned so that clones boot as new machines, snapshotted, and deleted.
 *
 * Never leaves the temporary server behind: it is deleted on every path that got
 * far enough to create it, and servers a killed build left are swept by the next
 * build and by `reap` (see `sweepStaleBuilders`).
 */

/**
 * Marks a temporary builder server. It deliberately is NOT the `pool` label:
 * `ensure` and `reap` select by `pool`, and a builder must never be adopted as a
 * CI server or reaped as an idle one mid-build.
 */
export const BUILDER_LABEL = "vgr-builder";

/** A build takes about 15 minutes; a server this old was left by a build that died. */
export const STALE_BUILDER_MINUTES = 180;

export interface RegistryLogin {
  readonly host: string;
  readonly username: string;
  readonly password: string;
}

export interface BuildImageConfig {
  readonly pool: string;
  /** `owner/name`: the repo the image is for. It is part of the image's name. */
  readonly repo: string;
  readonly serverType: string;
  /** The stock image to build from. */
  readonly baseImage: string;
  readonly location: string;
  readonly runnerVersion: string;
  readonly extraPackages: readonly string[];
  /** Container images to pull into the VM image, e.g. a repo's CI image. */
  readonly prepullImages: readonly string[];
  readonly registry?: RegistryLogin;
  /** How many built images to keep, the new one included. */
  readonly keep: number;
}

export interface BuildImageDeps {
  readonly provider: Provider;
  readonly ssh: Ssh;
}

export interface BuildImageOptions {
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Polls for SSH and for a reboot. Defaults: 60 polls, 5 s apart. */
  readonly connectAttempts?: number;
  readonly connectDelayMs?: number;
}

export interface BuildImageResult {
  readonly imageId: string;
  readonly imageName: string;
  readonly rebooted: boolean;
  readonly pruned: PruneResult;
  /** Builder servers from earlier, killed builds that were deleted first. */
  readonly sweptBuilders: readonly string[];
}

const SSH_CONNECTION_FAILED = 255;
// Everything below is interpolated into a shell script, so it is checked first and then quoted.
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;
const REGISTRY_HOST = /^[A-Za-z0-9][A-Za-z0-9.\-:]*$/;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/**
 * Pulls the images with a throwaway DOCKER_CONFIG, so the credential exists only
 * for the pulls and never reaches the image's disk. It travels in this script
 * (stdin of `bash -s`), not on a command line or in user-data.
 */
export const prepullScript = (images: readonly string[], registry?: RegistryLogin): string => {
  for (const i of images) {
    if (!IMAGE_REF.test(i)) throw new Error(`invalid container image reference "${i}"`);
  }
  if (registry) {
    if (!REGISTRY_HOST.test(registry.host)) throw new Error(`invalid registry host "${registry.host}"`);
    if (!USERNAME.test(registry.username)) throw new Error("invalid registry username");
  }
  return `set -euo pipefail
for _ in $(seq 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null
export DOCKER_CONFIG="$(mktemp -d)"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
${registry ? `printf '%s' ${shq(registry.password)} | docker login ${shq(registry.host)} -u ${shq(registry.username)} --password-stdin >/dev/null` : "# public images: no login"}
for image in ${images.map(shq).join(" ")}; do
  for attempt in 1 2 3; do
    docker pull "$image" && break
    [ "$attempt" = 3 ] && { echo "could not pull $image" >&2; exit 1; }
    sleep 10
  done
done
`;
};

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Unique per build (the server name is not a lock here), hostname-safe, at most 63 chars. */
const builderName = (pool: string, now: Date): string => {
  const hash = createHash("sha256").update(`${pool}\0${now.getTime()}\0${Math.random()}`).digest("hex").slice(0, 8);
  return `vgr-build-${slug(pool).slice(0, 40)}-${hash}`.replace(/-+/g, "-");
};

/**
 * Delete this pool's temporary builder servers older than `STALE_BUILDER_MINUTES`.
 * Called at the start of every build, and by `reap`, which runs on a schedule in
 * the consuming repo, so a cancelled build does not bill for a week.
 */
export const sweepStaleBuilders = async (
  provider: Provider,
  pool: string,
  now: Date = new Date(),
): Promise<readonly string[]> => {
  const swept: string[] = [];
  for (const s of await provider.listServers({ [BUILDER_LABEL]: pool })) {
    if (now.getTime() - s.createdAt.getTime() < STALE_BUILDER_MINUTES * 60_000) continue;
    await provider.deleteServer(s.id);
    swept.push(s.name);
  }
  return swept;
};

export const buildImage = async (
  deps: BuildImageDeps,
  cfg: BuildImageConfig,
  options: BuildImageOptions = {},
): Promise<BuildImageResult> => {
  const {
    now = () => new Date(),
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    connectAttempts = 60,
    connectDelayMs = 5000,
  } = options;
  const { provider, ssh } = deps;

  // Check inputs before anything is created, so a typo cannot cost a server.
  const bake = buildBakeScript({ runnerVersion: cfg.runnerVersion, extraPackages: cfg.extraPackages });
  const finalize = buildFinalizeScript();
  const prepull = cfg.prepullImages.length > 0 ? prepullScript(cfg.prepullImages, cfg.registry) : undefined;
  const secret = cfg.registry?.password;

  const sweptBuilders = await sweepStaleBuilders(provider, cfg.pool, now());

  const server = await provider.createServer({
    name: builderName(cfg.pool, now()),
    labels: { [BUILDER_LABEL]: cfg.pool },
    serverType: cfg.serverType,
    image: cfg.baseImage,
    location: cfg.location,
    userData: BUILDER_USER_DATA,
  });

  let failure: unknown;
  try {
    const host = server.address;
    if (!host) throw new Error(`builder server ${server.name} has no address to connect to`);

    const run = async (what: string, command: string, stdin?: string): Promise<SshResult> => {
      const res = await ssh.exec(host, command, stdin);
      if (res.code !== 0) {
        const detail = (secret ? res.stderr.replaceAll(secret, "***") : res.stderr).trim();
        throw new Error(`${what} failed on the builder (exit ${res.code}): ${detail}`);
      }
      return res;
    };

    await waitForSsh(ssh, host, connectAttempts, () => sleep(connectDelayMs));
    await run("baking", "bash -s", bake);

    // reboot-required also covers libc and systemd, not only the kernel.
    const needsReboot = (await ssh.exec(host, "test -f /var/run/reboot-required")).code === 0;
    if (needsReboot) await reboot(ssh, host, connectAttempts, () => sleep(connectDelayMs));

    if (prepull) await run("pulling container images", "bash -s", prepull);
    await run("cleaning for snapshot", "bash -s", finalize);

    const image = await provider.createImage(server.id, imageName(cfg.pool, cfg.repo, now()));
    // Only after the new image exists, so a failed build never shrinks the set.
    const pruned = await pruneImages(provider, cfg.pool, cfg.repo, cfg.keep);
    return { imageId: image.id, imageName: image.name, rebooted: needsReboot, pruned, sweptBuilders };
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    await deleteBuilder(provider, server, failure);
  }
};

/** Delete the temporary server. If that fails it is loud, since the server bills, and it never hides the build's own error. */
const deleteBuilder = async (provider: Provider, server: Server, buildError: unknown): Promise<void> => {
  try {
    await provider.deleteServer(server.id);
  } catch (e) {
    const del = e instanceof Error ? e.message : String(e);
    const why = buildError === undefined ? "" : `${buildError instanceof Error ? buildError.message : String(buildError)}; and `;
    throw new Error(`${why}deleting the builder server ${server.name} (${server.id}) failed (${del}): delete it by hand, it is billing`);
  }
};

const waitForSsh = async (ssh: Ssh, host: string, attempts: number, pause: () => Promise<void>): Promise<void> => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await ssh.exec(host, "cloud-init status --wait");
    // 2 is cloud-init's "degraded"; the builder's own user-data is trivial, so that is not our concern.
    if (res.code === 0 || res.code === 2) return;
    if (res.code !== SSH_CONNECTION_FAILED) {
      throw new Error(`cloud-init did not finish on the builder (exit ${res.code}): ${res.stderr.trim()}`);
    }
    if (attempt < attempts) await pause();
  }
  throw new Error(`the builder at ${host} was not reachable over SSH after ${attempts} attempts`);
};

const BOOT_ID = "cat /proc/sys/kernel/random/boot_id";

const reboot = async (ssh: Ssh, host: string, attempts: number, pause: () => Promise<void>): Promise<void> => {
  const before = await ssh.exec(host, BOOT_ID);
  if (before.code !== 0) throw new Error(`could not read the builder's boot id (exit ${before.code})`);
  // The connection drops as the machine goes down, so this command's own result means nothing.
  await ssh.exec(host, "systemctl reboot");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await pause();
    const now = await ssh.exec(host, BOOT_ID);
    // Right after the command the old system may still answer; a new boot id is the proof.
    if (now.code === 0 && now.stdout.trim() !== before.stdout.trim()) return;
  }
  throw new Error(`the builder did not come back after a reboot (${attempts} checks)`);
};
