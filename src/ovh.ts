import {
  labelsMatch,
  QuotaExceededError,
  ServerExistsError,
  type CreateServerSpec,
  type Labels,
  type Provider,
  type Server,
  type ServerPatch,
} from "./provider.ts";

/**
 * OVHcloud Public Cloud adapter. OVH's compute is OpenStack, so this speaks
 * Keystone (auth), Nova (servers, flavors), Glance (images) and Neutron
 * (networks) directly over HTTP, which keeps the repo free of runtime
 * dependencies and of the `openstack` CLI.
 *
 * Differences from Hetzner that shape the code:
 * - Nova does not enforce unique server names, so `createServer` arbitrates
 *   after creating instead of relying on a 409 (see there).
 * - Create takes IDs, not names, so flavor, image and network are resolved first.
 * - A server exists, and is listed, before it has an address.
 * - A server being deleted can still report ACTIVE; `task_state` says otherwise.
 * - Servers are billed for the time they exist (`billing: "prorated"`).
 * - A server's labels are its Nova `metadata`, and listing filters client-side.
 */

export class OvhApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Which OpenStack service answered: `identity`, `compute`, `image` or `network`. */
    readonly service: string,
  ) {
    super(message);
    this.name = "OvhApiError";
  }
}

export interface OvhOptions {
  /** Keystone v3 URL, e.g. `https://auth.cloud.ovh.us/v3`. The credential is sent here. */
  readonly authUrl: string;
  /** Application credential ID and secret. Never logged. */
  readonly credentialId: string;
  readonly credentialSecret: string;
  /** Region name, e.g. `US-EAST-VA-1` (OVH US) or `GRA11` (EU). Selects the service endpoints. */
  readonly region: string;
  /**
   * Names of key pairs already uploaded to the project, injected at creation so
   * a registrar can reach the VM. Nova takes one, and key pairs are per region.
   */
  readonly sshKeys?: readonly string[];
  /** Public network the server is attached to. Default `Ext-Net`. */
  readonly network?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Polls for the address of a new server. Defaults: 60 polls, 5 s apart. */
  readonly readyAttempts?: number;
  readonly readyDelayMs?: number;
}

interface Session {
  readonly token: string;
  readonly compute: string;
  readonly image: string;
  readonly network: string;
}

type Service = "compute" | "image" | "network";

interface ApiServer {
  id: string;
  name: string;
  status: string;
  created: string;
  metadata?: Labels;
  addresses?: Record<string, { addr: string; version: number }[]>;
  "OS-EXT-STS:task_state"?: string | null;
  fault?: { message?: string };
}

const PAGE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// RFC 1123 hostname label, as for Hetzner: ensure's names are already like this.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_METADATA = 255;

const validateLabels = (labels: Labels): void => {
  for (const [k, v] of Object.entries(labels)) {
    if (k === "" || k.length > MAX_METADATA || v.length > MAX_METADATA) {
      throw new Error(`invalid OVH label "${k}": keys must be non-empty and keys and values at most ${MAX_METADATA} chars`);
    }
  }
};

const validateName = (name: string): void => {
  if (!HOSTNAME.test(name)) {
    throw new Error(`server name "${name}" is not a valid hostname (lowercase, digits, -, max 63)`);
  }
};

const validateId = (id: string): void => {
  if (!UUID.test(id)) throw new Error(`invalid server id "${id}"`);
};

type Status = Server["status"];

// https://docs.openstack.org/api-guide/compute/server_concepts.html
const STATUS: Record<string, Status> = {
  BUILD: "starting",
  REBUILD: "starting",
  REBOOT: "starting",
  HARD_REBOOT: "starting",
  ACTIVE: "running",
  PASSWORD: "running",
  MIGRATING: "running",
  RESIZE: "running",
  VERIFY_RESIZE: "running",
  REVERT_RESIZE: "running",
  RESCUE: "running",
  SHUTOFF: "off",
  STOPPED: "off",
  PAUSED: "off",
  SUSPENDED: "off",
  SHELVED: "off",
  SHELVED_OFFLOADED: "off",
  DELETED: "stopping",
  SOFT_DELETED: "stopping",
  ERROR: "error",
};

const toStatus = (s: ApiServer): Status => {
  // A server that is being deleted keeps its old status until the delete lands.
  if (s["OS-EXT-STS:task_state"] === "deleting") return "stopping";
  // Unknown states stay unreusable rather than being assumed healthy.
  return STATUS[s.status] ?? "off";
};

const isPrivateV4 = (ip: string): boolean => {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
};

/** The first public IPv4 address, whichever network it is listed under. */
const publicAddress = (s: ApiServer): string | undefined =>
  Object.values(s.addresses ?? {})
    .flat()
    .find((a) => a.version === 4 && !isPrivateV4(a.addr))?.addr;

const toServer = (s: ApiServer): Server => {
  const address = publicAddress(s);
  return {
    id: s.id,
    name: s.name,
    labels: s.metadata ?? {},
    createdAt: new Date(s.created),
    status: toStatus(s),
    ...(address ? { address } : {}),
  };
};

/** Oldest first; the ID breaks ties because `created` has only one-second resolution. */
const byAge = (a: Server, b: Server): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const LIVE: ReadonlySet<Status> = new Set(["starting", "running"]);

/** The first `message` found in an OpenStack error body, whatever service wrote it. */
const errorMessage = (body: unknown): string | undefined => {
  if (body === null || typeof body !== "object") return undefined;
  const o = body as Record<string, unknown>;
  if (typeof o["message"] === "string") return o["message"];
  if (typeof o["detail"] === "string") return o["detail"];
  for (const v of Array.isArray(o["errors"]) ? o["errors"] : Object.values(o)) {
    const m = errorMessage(v);
    if (m) return m;
  }
  return undefined;
};

/** A versioned service URL from the catalog may or may not already end in its version. */
const withVersion = (url: string, version: string): string =>
  /\/v\d+(\.\d+)?$/.test(url) ? url : `${url}${version}`;

export class OvhProvider implements Provider {
  /** OVH bills the time a server exists, not started hours (invoices, 2026-10-02/03). */
  readonly billing = "prorated" as const;

  private readonly opts: OvhOptions;
  private readonly sshKeys: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private session: Promise<Session> | undefined;
  private readonly refs = new Map<string, Promise<string>>();

  constructor(opts: OvhOptions) {
    if (!/^https:\/\//i.test(opts.authUrl)) {
      // The application credential is sent to this URL.
      throw new Error("the OVH auth URL must be an https:// URL");
    }
    if ((opts.sshKeys ?? []).length > 1) {
      throw new Error("OVH takes exactly one SSH key pair name per server; give one");
    }
    this.opts = opts;
    this.sshKeys = opts.sshKeys ?? [];
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async createServer(spec: CreateServerSpec): Promise<Server> {
    validateName(spec.name);
    validateLabels(spec.labels);

    const [flavorRef, imageRef, networkId] = await Promise.all([
      this.flavorId(spec.serverType),
      this.imageId(spec.image),
      this.networkId(),
    ]);

    const res = await this.createRequest({
      server: {
        name: spec.name,
        flavorRef,
        imageRef,
        networks: [{ uuid: networkId }],
        metadata: spec.labels,
        // Nova wants user data base64-encoded; Hetzner takes it raw.
        user_data: Buffer.from(spec.userData, "utf8").toString("base64"),
        ...(this.sshKeys[0] ? { key_name: this.sshKeys[0] } : {}),
      },
    });
    const { id } = ((await res.json()) as { server: { id: string } }).server;

    try {
      await this.arbitrate(id, spec.name);
      return await this.waitUntilAddressed(id);
    } catch (e) {
      // Never leave a half-made or losing server behind: it would bill.
      await this.discard(id, e);
      throw e;
    }
  }

  /** Nova answers 403 (or 413 on older releases) with "Quota exceeded for ..." when the project is full. */
  private async createRequest(body: unknown): Promise<Response> {
    try {
      return await this.request("compute", "POST", "/servers", body);
    } catch (e) {
      if (e instanceof OvhApiError && (e.status === 403 || e.status === 413) && /quota|over ?limit/i.test(e.message)) {
        throw new QuotaExceededError(e.message);
      }
      throw e;
    }
  }

  async listServers(selector: Labels): Promise<readonly Server[]> {
    return (await this.fetchServers()).filter((s) => labelsMatch(s.labels, selector));
  }

  /** A server that is already gone counts as deleted. Any other failure rejects. */
  async deleteServer(id: string): Promise<void> {
    validateId(id);
    try {
      await this.request("compute", "DELETE", `/servers/${id}`);
    } catch (e) {
      if (e instanceof OvhApiError && e.status === 404) return;
      throw e;
    }
  }

  /**
   * Nova has no single call for both, so this is two. The name goes first: if the
   * labels then fail, the server still carries the pool's labels, which is the
   * state `release` can retry from. The metadata PUT replaces the whole set.
   */
  async updateServer(id: string, patch: ServerPatch): Promise<Server> {
    validateId(id);
    validateName(patch.name);
    validateLabels(patch.labels);

    await this.request("compute", "PUT", `/servers/${id}`, { server: { name: patch.name } });
    await this.request("compute", "PUT", `/servers/${id}/metadata`, { metadata: patch.labels });
    return this.getServer(id);
  }

  /**
   * Nova allows any number of servers with one name, so there is no 409 to lose
   * a race on. Instead every creator, right after its create call, lists the live
   * servers with this name and the oldest wins: the others delete their own and
   * report `ServerExistsError`, as Hetzner would have. `ensureServer` then
   * reuses the winner.
   *
   * Rests on a created server being listed by the time its create call returns,
   * so of any two creators at least one sees the other. The tie-break is
   * deterministic, so creators that both see both agree. A loser's server
   * lives for a few seconds, and billing is by runtime, so that costs little.
   * Left open: a creator whose request was stamped earlier but committed later
   * than a rival's list could also win, producing two servers; the reaper
   * removes the spare once idle.
   */
  private async arbitrate(id: string, name: string): Promise<void> {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const rivals = (await this.fetchServers()).filter(
        (s) => s.id === id || (s.name === name && LIVE.has(s.status)),
      );
      if (rivals.some((s) => s.id === id)) {
        const [winner] = rivals.sort(byAge);
        if (winner && winner.id !== id) throw new ServerExistsError(name);
        return;
      }
      if (attempt < attempts) await this.sleep(1000);
    }
    throw new Error(`OVH server ${id} was created but never appeared in the server list`);
  }

  /** Returns once the server has a public address; fails if it errors or takes too long. */
  private async waitUntilAddressed(id: string): Promise<Server> {
    const { readyAttempts = 60, readyDelayMs = 5000 } = this.opts;
    for (let attempt = 1; attempt <= readyAttempts; attempt++) {
      const raw = await this.getRaw(id);
      const server = toServer(raw);
      if (server.status === "error") {
        throw new Error(`OVH server ${id} went to ERROR: ${raw.fault?.message ?? "no reason given"}`);
      }
      if (server.status === "stopping" || server.status === "off") {
        throw new Error(`OVH server ${id} is ${raw.status} instead of starting`);
      }
      if (server.address) return server;
      if (attempt < readyAttempts) await this.sleep(readyDelayMs);
    }
    throw new Error(`OVH server ${id} had no public address after ${readyAttempts} checks`);
  }

  /** Delete a server this call created and is giving up on. Loud if that fails too. */
  private async discard(id: string, cause: unknown): Promise<void> {
    try {
      await this.deleteServer(id);
    } catch (e) {
      const why = cause instanceof Error ? cause.message : String(cause);
      const del = e instanceof Error ? e.message : String(e);
      throw new Error(`${why}; and deleting the new server ${id} failed (${del}): delete it by hand, it is billing`);
    }
  }

  private async getRaw(id: string): Promise<ApiServer> {
    const res = await this.request("compute", "GET", `/servers/${id}`);
    return ((await res.json()) as { server: ApiServer }).server;
  }

  private async getServer(id: string): Promise<Server> {
    return toServer(await this.getRaw(id));
  }

  private async fetchServers(): Promise<Server[]> {
    const servers: Server[] = [];
    for (let marker: string | undefined; ; ) {
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (marker) params.set("marker", marker);
      const res = await this.request("compute", "GET", `/servers/detail?${params}`);
      const body = (await res.json()) as {
        servers: ApiServer[];
        servers_links?: { rel: string }[];
      };
      servers.push(...body.servers.map(toServer));
      const next = body.servers_links?.some((l) => l.rel === "next");
      const last = body.servers.at(-1);
      if (!next || !last) return servers;
      marker = last.id;
    }
  }

  private cached(key: string, resolve: () => Promise<string>): Promise<string> {
    let p = this.refs.get(key);
    if (!p) {
      p = resolve();
      this.refs.set(key, p);
      // A failed lookup must not stick; the next call retries.
      p.catch(() => this.refs.delete(key));
    }
    return p;
  }

  private flavorId(name: string): Promise<string> {
    return this.cached(`flavor:${name}`, async () => {
      const res = await this.request("compute", "GET", "/flavors");
      const { flavors } = (await res.json()) as { flavors: { id: string; name: string }[] };
      const hit = flavors.find((f) => f.name === name) ?? flavors.find((f) => f.id === name);
      if (!hit) {
        throw new Error(`OVH flavor "${name}" not found in region ${this.opts.region}`);
      }
      return hit.id;
    });
  }

  private imageId(name: string): Promise<string> {
    if (UUID.test(name)) return Promise.resolve(name);
    return this.cached(`image:${name}`, async () => {
      const params = new URLSearchParams({ name, status: "active" });
      const res = await this.request("image", "GET", `/images?${params}`);
      const { images } = (await res.json()) as { images: { id: string; name: string }[] };
      const exact = images.filter((i) => i.name === name);
      if (exact.length !== 1) {
        throw new Error(
          `${exact.length === 0 ? "no" : `${exact.length}`} active OVH image named "${name}" in region ` +
            `${this.opts.region}${exact.length > 1 ? "; use its ID instead" : ""}`,
        );
      }
      return exact[0]!.id;
    });
  }

  private networkId(): Promise<string> {
    const name = this.opts.network ?? "Ext-Net";
    return this.cached(`network:${name}`, async () => {
      const params = new URLSearchParams({ name });
      const res = await this.request("network", "GET", `/networks?${params}`);
      const { networks } = (await res.json()) as { networks: { id: string; name: string }[] };
      const exact = networks.filter((n) => n.name === name);
      if (exact.length !== 1) {
        throw new Error(`expected one OVH network named "${name}" in region ${this.opts.region}, found ${exact.length}`);
      }
      return exact[0]!.id;
    });
  }

  private authenticate(): Promise<Session> {
    this.session ??= this.login().catch((e) => {
      this.session = undefined;
      throw e;
    });
    return this.session;
  }

  /** Exchanges the application credential for a token and the region's endpoints. */
  private async login(): Promise<Session> {
    const res = await this.fetchImpl(`${this.opts.authUrl.replace(/\/+$/, "")}/auth/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        auth: {
          identity: {
            methods: ["application_credential"],
            application_credential: { id: this.opts.credentialId, secret: this.opts.credentialSecret },
          },
        },
      }),
    });
    if (!res.ok) throw await this.failure("identity", "POST", "/auth/tokens", res);

    const token = res.headers.get("x-subject-token");
    if (!token) throw new Error("OVH authentication returned no token");
    const { token: body } = (await res.json()) as {
      token: {
        catalog: {
          type: string;
          endpoints: { interface: string; region?: string; region_id?: string; url: string }[];
        }[];
      };
    };

    const endpoint = (type: Service): string => {
      const service = body.catalog.find((s) => s.type === type);
      const hit = service?.endpoints.find(
        (e) => e.interface === "public" && (e.region === this.opts.region || e.region_id === this.opts.region),
      );
      if (!hit) {
        const regions = [...new Set((service?.endpoints ?? []).map((e) => e.region ?? e.region_id))].join(", ");
        throw new Error(
          `no public ${type} endpoint for region "${this.opts.region}" in the OVH catalog` +
            (regions ? ` (it has: ${regions})` : ""),
        );
      }
      return hit.url.replace(/\/+$/, "");
    };

    return {
      token,
      compute: endpoint("compute"),
      image: withVersion(endpoint("image"), "/v2"),
      network: withVersion(endpoint("network"), "/v2.0"),
    };
  }

  private async request(
    service: Service,
    method: string,
    path: string,
    body?: unknown,
    reauthenticate = true,
  ): Promise<Response> {
    const session = await this.authenticate();
    const res = await this.fetchImpl(`${session[service]}${path}`, {
      method,
      headers: {
        "x-auth-token": session.token,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && reauthenticate) {
      // The token expired mid-run (they last about a day). Log in once more.
      this.session = undefined;
      return this.request(service, method, path, body, false);
    }
    if (!res.ok) throw await this.failure(service, method, path, res);
    return res;
  }

  private async failure(service: string, method: string, path: string, res: Response): Promise<OvhApiError> {
    // Only OpenStack's own message goes into the error, never our request headers or body.
    let detail = res.statusText;
    try {
      detail = errorMessage(await res.json()) ?? detail;
    } catch {
      // Not JSON; the status text will do.
    }
    return new OvhApiError(
      res.status,
      `OVH ${service} ${method} ${path.split("?")[0]} failed (${res.status}): ${detail}`,
      service,
    );
  }
}
