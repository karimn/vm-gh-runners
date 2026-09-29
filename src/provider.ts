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
  readonly status: "starting" | "running" | "stopping" | "off";
}

export interface CreateServerSpec {
  readonly name: string;
  readonly labels: Labels;
  /** Provider-specific size name, e.g. a Hetzner server type. */
  readonly serverType: string;
  readonly image: string;
  readonly location: string;
  /**
   * First-boot script. Anything in here is readable from inside the VM without
   * authentication on most clouds, so never put a provider token in it.
   */
  readonly userData: string;
}

export interface Provider {
  createServer(spec: CreateServerSpec): Promise<Server>;
  /** Servers whose labels contain every key/value in `selector`. */
  listServers(selector: Labels): Promise<readonly Server[]>;
  deleteServer(id: string): Promise<void>;
}

export const labelsMatch = (labels: Labels, selector: Labels): boolean =>
  Object.entries(selector).every(([k, v]) => labels[k] === v);
