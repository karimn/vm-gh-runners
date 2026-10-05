import {
  ServerExistsError,
  type CreateServerSpec,
  type Labels,
  type Provider,
  type Server,
  type ServerPatch,
} from "./provider.ts";

export class HetznerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Hetzner's machine-readable error code, e.g. `uniqueness_error`. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "HetznerApiError";
  }
}

export interface HetznerOptions {
  /** Project API token with read and write access. Never logged. */
  readonly token: string;
  /** SSH key names or IDs injected at creation, so a registrar can reach the VM. */
  readonly sshKeys?: readonly (string | number)[];
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

const PER_PAGE = 50;

// https://docs.hetzner.cloud "Labels": values and key names are at most 63 chars,
// start and end alphanumeric, with `-`, `_`, `.` allowed between. Values may be empty.
const LABEL_KEY = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/;
const LABEL_VALUE = /^([a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?)?$/;
// RFC 1123 hostname label: what a Hetzner server name must be.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const validateLabels = (labels: Labels): void => {
  for (const [k, v] of Object.entries(labels)) {
    if (k.startsWith("hetzner.cloud/")) {
      throw new Error(`label key "${k}" uses the reserved hetzner.cloud/ prefix`);
    }
    if (!LABEL_KEY.test(k)) throw new Error(`invalid Hetzner label key "${k}"`);
    if (!LABEL_VALUE.test(v)) {
      throw new Error(
        `invalid Hetzner label value for "${k}": "${v}" (letters, digits, - _ . only; max 63 chars)`,
      );
    }
  }
};

const STATUS: Record<string, Server["status"]> = {
  initializing: "starting",
  starting: "starting",
  running: "running",
  migrating: "running",
  stopping: "stopping",
  deleting: "stopping",
  off: "off",
  // Not ready, but they must stay reusable: reporting them as gone would make
  // ensure create a second server and run into the account's server cap.
  rebuilding: "starting",
  unknown: "starting",
};

interface ApiServer {
  id: number;
  name: string;
  status: string;
  created: string;
  labels: Labels;
  public_net?: { ipv4?: { ip: string } | null };
}

const toServer = (s: ApiServer): Server => ({
  id: String(s.id),
  name: s.name,
  labels: s.labels,
  createdAt: new Date(s.created),
  status: STATUS[s.status] ?? "starting",
  ...(s.public_net?.ipv4?.ip ? { address: s.public_net.ipv4.ip } : {}),
});

/** Hetzner Cloud adapter. */
export class HetznerProvider implements Provider {
  /** "We always round up the hourly usage of a server" (Hetzner FAQ). */
  readonly billing = "per-started-hour" as const;
  private readonly token: string;
  private readonly sshKeys: readonly (string | number)[];
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: HetznerOptions) {
    this.token = opts.token;
    this.sshKeys = opts.sshKeys ?? [];
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? "https://api.hetzner.cloud/v1";
  }

  async createServer(spec: CreateServerSpec): Promise<Server> {
    if (!HOSTNAME.test(spec.name)) {
      throw new Error(`server name "${spec.name}" is not a valid hostname (lowercase, digits, -, max 63)`);
    }
    validateLabels(spec.labels);

    try {
      const res = await this.request("POST", "/servers", {
        name: spec.name,
        server_type: spec.serverType,
        image: spec.image,
        location: spec.location,
        labels: spec.labels,
        user_data: spec.userData,
        start_after_create: true,
        ...(this.sshKeys.length > 0 ? { ssh_keys: this.sshKeys } : {}),
      });
      return toServer(((await res.json()) as { server: ApiServer }).server);
    } catch (e) {
      // The only unique field we send is the name.
      if (e instanceof HetznerApiError && e.status === 409 && e.code === "uniqueness_error") {
        throw new ServerExistsError(spec.name);
      }
      throw e;
    }
  }

  async listServers(selector: Labels): Promise<readonly Server[]> {
    // Selector values are spliced into a query language, so they must be plain
    // label values: no commas, `!`, parentheses or spaces can get through.
    validateLabels(selector);
    const labelSelector = Object.entries(selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");

    const servers: Server[] = [];
    for (let page: number | null = 1; page !== null; ) {
      const params = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
      if (labelSelector) params.set("label_selector", labelSelector);

      const res = await this.request("GET", `/servers?${params}`);
      const body = (await res.json()) as {
        servers: ApiServer[];
        meta?: { pagination?: { next_page: number | null } };
      };
      servers.push(...body.servers.map(toServer));
      page = body.meta?.pagination?.next_page ?? null;
    }
    return servers;
  }

  /** A server that is already gone counts as deleted. Any other failure rejects. */
  async deleteServer(id: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new Error(`invalid server id "${id}"`);
    try {
      await this.request("DELETE", `/servers/${id}`);
    } catch (e) {
      if (e instanceof HetznerApiError && e.status === 404) return;
      throw e;
    }
  }

  /**
   * Hetzner's `labels` on a PUT replaces the whole set, so the caller passes the
   * complete set it wants. Name and labels go in one request.
   */
  async updateServer(id: string, patch: ServerPatch): Promise<Server> {
    if (!/^\d+$/.test(id)) throw new Error(`invalid server id "${id}"`);
    if (!HOSTNAME.test(patch.name)) {
      throw new Error(`server name "${patch.name}" is not a valid hostname (lowercase, digits, -, max 63)`);
    }
    validateLabels(patch.labels);

    try {
      const res = await this.request("PUT", `/servers/${id}`, { name: patch.name, labels: patch.labels });
      return toServer(((await res.json()) as { server: ApiServer }).server);
    } catch (e) {
      if (e instanceof HetznerApiError && e.status === 409 && e.code === "uniqueness_error") {
        throw new ServerExistsError(patch.name);
      }
      throw e;
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // Only Hetzner's own message goes into the error, never our request headers.
      let detail = res.statusText;
      let code: string | undefined;
      try {
        const err = (await res.json()) as { error?: { message?: string; code?: string } };
        if (err.error?.message) detail = err.error.message;
        code = err.error?.code;
      } catch {
        // Not JSON; the status text will do.
      }
      throw new HetznerApiError(
        res.status,
        `Hetzner ${method} ${path.split("?")[0]} failed (${res.status}): ${detail}`,
        code,
      );
    }
    return res;
  }
}
