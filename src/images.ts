import type { Image, Provider } from "./provider.ts";

/**
 * Built images are named `vgr-<pool>-<owner>_<repo>-<yyyymmdd>` and found by that
 * name alone, so no state is kept anywhere: `ensure` lists, picks the newest, and
 * `build-image` lists, adds one, and prunes the rest. The repo is in the name
 * because servers are keyed by pool and repo, so images must be too: two repos
 * sharing a pool would otherwise boot, and prune, each other's images.
 */

/** The `image` value that means "the newest image `build-image` made for this pool". */
export const BUILT_IMAGE_REF = "latest-built";

/** `owner/name` as a name part, the same way server labels spell it (`owner_name`). */
const repoPart = (repo: string): string => repo.replace("/", "_");

export const imagePrefix = (pool: string, repo: string): string => `vgr-${pool}-${repoPart(repo)}-`;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `vgr-ci-karimn_sia-20261005`. A date, not a timestamp: a second build the same day is just a newer image of that name. */
export const imageName = (pool: string, repo: string, now: Date): string =>
  `${imagePrefix(pool, repo)}${now.toISOString().slice(0, 10).replaceAll("-", "")}`;

/**
 * This pool's built images for this repo, newest first. The name must be the
 * prefix plus exactly eight digits, so another pool or repo whose name extends
 * this one's never matches (`vgr-ci-karimn_sia-x-20261005` starts with
 * `vgr-ci-karimn_sia-`, but is not eight digits after it).
 */
export const listBuiltImages = async (provider: Provider, pool: string, repo: string): Promise<readonly Image[]> => {
  const prefix = imagePrefix(pool, repo);
  const own = new RegExp(`^${escapeRegExp(prefix)}\\d{8}$`);
  return (await provider.listImages(prefix))
    .filter((i) => own.test(i.name))
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.name < b.name ? 1 : a.name > b.name ? -1 : 0) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
};

export interface ResolvedImage {
  /** What to pass to `createServer`: the built image's id, or the configured image name. */
  readonly image: string;
  /** True if this is a built image (the first-boot script then skips what it holds). */
  readonly built: boolean;
  readonly name?: string;
  readonly builtAt?: Date;
}

/**
 * Turn the `image` setting into something `createServer` can boot. Any value
 * other than `latest-built` is used as given. `latest-built` is the newest built
 * image of the pool, or `baseImage` (the stock image, with the full setup) when
 * there is none yet. Falling back keeps a repo working before its first build.
 * The id is returned, not the name, so two images with one name cannot be
 * confused.
 */
export const resolveImage = async (
  provider: Provider,
  cfg: { readonly pool: string; readonly repo: string; readonly image: string; readonly baseImage: string },
): Promise<ResolvedImage> => {
  if (cfg.image !== BUILT_IMAGE_REF) return { image: cfg.image, built: false };
  const [newest] = await listBuiltImages(provider, cfg.pool, cfg.repo);
  if (!newest) return { image: cfg.baseImage, built: false };
  return { image: newest.id, built: true, name: newest.name, builtAt: newest.createdAt };
};

export interface PruneResult {
  readonly deleted: readonly string[];
  readonly failed: readonly { readonly name: string; readonly id: string; readonly error: string }[];
}

/**
 * Delete all but the newest `keep` built images of the pool and repo. Call it only after
 * a new image exists, so a failed build never shrinks the set. One image failing
 * to delete does not stop the others.
 */
export const pruneImages = async (
  provider: Provider,
  pool: string,
  repo: string,
  keep: number,
): Promise<PruneResult> => {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a positive integer, got ${keep}`);
  const stale = (await listBuiltImages(provider, pool, repo)).slice(keep);
  const deleted: string[] = [];
  const failed: { name: string; id: string; error: string }[] = [];
  for (const image of stale) {
    try {
      await provider.deleteImage(image.id);
      deleted.push(image.name);
    } catch (e) {
      failed.push({ name: image.name, id: image.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { deleted, failed };
};
