/**
 * The whole provider-specific surface. Everything else in this repo talks to a
 * `Provider`, so adding a cloud means writing one adapter and nothing more.
 */

export type Labels = Readonly<Record<string, string>>;

export interface Server {
  readonly id: string;
  readonly name: string;
  readonly labels: Labels;
  /** Creation time. Billing hours are counted from here, not from first use. */
  readonly createdAt: Date;
  /**
   * `error` is a server the provider could not build or that failed afterwards
   * (OpenStack's ERROR). It is never reused and the reaper deletes it, since
   * most clouds keep billing it.
   */
  readonly status: "starting" | "running" | "stopping" | "off" | "error";
  /** Public IPv4, if the server has one. Needed to reach it over SSH. */
  readonly address?: string;
}

export interface CreateServerSpec {
  readonly name: string;
  readonly labels: Labels;
  /** Provider-specific size name, e.g. a Hetzner server type or an OVH flavor. */
  readonly serverType: string;
  readonly image: string;
  /** A Hetzner location such as `nbg1`, or an OVH region such as `US-EAST-VA-1`. */
  readonly location: string;
  /**
   * First-boot script. Anything in here is readable from inside the VM without
   * authentication on most clouds, so never put a provider token in it.
   */
  readonly userData: string;
}

/**
 * How a cloud charges for a server, which decides when an idle one is worth
 * deleting.
 *
 * - `per-started-hour`: every started hour is billed in full (Hetzner). An idle
 *   server is kept until the last minutes of the hour already paid for, because
 *   deleting it earlier saves nothing and forfeits a warm VM.
 * - `prorated`: billed for the time it actually exists (OVH). Every idle minute
 *   is wasted, so an idle server is deleted at the next reap.
 *
 * Either way a stopped server still bills, so the reaper deletes, never stops.
 */
export type BillingModel = "per-started-hour" | "prorated";

export interface Provider {
  readonly billing: BillingModel;
  /**
   * Create and return a server, with `address` set once the provider has one.
   * Rejects with `ServerExistsError` if another live server already holds
   * `spec.name`: that is how concurrent `ensure` calls converge on one server.
   * Providers that enforce unique names get this for free; the others must
   * arbitrate after creating (see `OvhProvider`).
   */
  createServer(spec: CreateServerSpec): Promise<Server>;
  /** Servers whose labels contain every key/value in `selector`. */
  listServers(selector: Labels): Promise<readonly Server[]>;
  deleteServer(id: string): Promise<void>;
  /**
   * Rename a server and replace its labels in one request, so there is no
   * moment where it has the new name but the old labels or the reverse. `labels`
   * is the complete new set, not a patch. Rejects with `ServerExistsError` if
   * another server holds `name` (only on providers that enforce unique names).
   *
   * Not every provider can do both in one request. Where it takes two, the name
   * changes first and the labels second, so a failure in between leaves a server
   * that still carries the pool's labels and a retry finishes the job.
   */
  updateServer(id: string, patch: ServerPatch): Promise<Server>;
}

export interface ServerPatch {
  readonly name: string;
  readonly labels: Labels;
}

export const labelsMatch = (labels: Labels, selector: Labels): boolean =>
  Object.entries(selector).every(([k, v]) => labels[k] === v);

/**
 * Labels for a pool's server for one repo. Shared by ensure and reap so they
 * always agree. Cloud label values are restricted (Hetzner: letters, digits,
 * `-`, `_`, `.`, at most 63 chars), so `owner/name` becomes `owner_name`. That
 * is unambiguous because GitHub owner names cannot contain `_`.
 */
export const serverLabels = (pool: string, repo: string, runId?: string): Labels => ({
  pool,
  repo: repo.replace("/", "_"),
  ...(runId === undefined ? {} : { [RUN_LABEL]: runId }),
});

/**
 * Marks a server as belonging to one workflow run (`run-id` input). The pool
 * label stays on it, so a scheduled reaper over the pool still finds it. A
 * server without this label is a shared-pool server.
 */
export const RUN_LABEL = "vgr-run";

/** The workflow run that owns this server, or undefined for a shared-pool server. */
export const runOf = (server: Server): string | undefined => server.labels[RUN_LABEL];

/**
 * Thrown by `createServer` when a server with that name already exists. A
 * deterministic name works as a lock: of several concurrent creators exactly one
 * succeeds and the rest get this. Where the provider does not enforce unique
 * names the adapter has to produce the same outcome itself.
 */
export class ServerExistsError extends Error {
  constructor(readonly serverName: string) {
    super(`a server named "${serverName}" already exists`);
    this.name = "ServerExistsError";
  }
}

/**
 * Thrown by `createServer` when the provider refuses because the project's quota
 * or server limit is used up (OVH: cores/instances; Hetzner: the server limit).
 * Waiting would not help until another VM is deleted, so `ensure` fails at once
 * with the provider's own message instead of retrying.
 */
export class QuotaExceededError extends Error {
  constructor(readonly detail: string) {
    super(
      `the cloud project has no capacity for another server (quota or server limit reached): ${detail}. ` +
        "Per-run VMs need one slot each; wait for other runs to finish, or raise the quota.",
    );
    this.name = "QuotaExceededError";
  }
}
