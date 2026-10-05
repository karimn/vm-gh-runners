import { describe, expect, test } from "bun:test";
import { OvhApiError, OvhProvider } from "../src/ovh.ts";
import { QuotaExceededError, ServerExistsError, type CreateServerSpec } from "../src/provider.ts";

const AUTH = "https://auth.example.test/v3";
const REGION = "US-EAST-VA-1";
const COMPUTE = "https://compute.example.test/v2.1";
const IMAGE = "https://image.example.test";
const NETWORK = "https://network.example.test";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface FakeServer {
  id: string;
  name: string;
  status: string;
  created: string;
  metadata: Record<string, string>;
  addresses: Record<string, { addr: string; version: number }[]>;
  "OS-EXT-STS:task_state": string | null;
  fault?: { message: string };
  /** Detail polls left before a BUILD server turns ACTIVE with an address. */
  buildPolls: number;
  userData?: string;
  body?: any;
}

/**
 * A small in-memory OpenStack: Keystone, Nova, Glance and Neutron behind one
 * `fetch`. Only what the adapter calls is implemented, with the response shapes
 * of the OpenStack API reference (not yet captured from a live OVH project).
 */
class FakeCloud {
  readonly servers: FakeServer[] = [];
  readonly requests: { method: string; url: URL; headers: Headers; body: any }[] = [];
  logins = 0;
  token = "TOKEN-1";
  region = REGION;
  /** Servers returned per page. */
  pageSize = 100;
  /** First N detail listings omit the newest server, as if its commit were not visible yet. */
  hideNewestFor = 0;
  /** What a new server turns into after `buildPolls` polls. */
  buildOutcome: "ACTIVE" | "ERROR" | "never" = "ACTIVE";
  buildPolls = 2;
  images = [{ id: uuid(900), name: "Ubuntu 24.04" }];
  flavors = [
    { id: uuid(800), name: "b3-32" },
    { id: uuid(801), name: "c3-32" },
  ];
  networks = [{ id: uuid(700), name: "Ext-Net" }];
  deleteStatus = 204;
  /** Snapshots (Glance private images). `savePolls` is how many GETs before a new one is active. */
  snapshots: { id: string; name: string; status: string; created_at: string; savePolls: number }[] = [];
  savePolls = 2;
  /** What a snapshot becomes: active, or killed, or never finishes. */
  snapshotOutcome: "active" | "killed" | "never" = "active";
  /** Nova's createImage reply: a Location header (older microversions) or `image_id` in the body. */
  snapshotReply: "location" | "body" = "location";
  /** Server actions answered with an error instead (e.g. { "createImage": 409 }). */
  actionFailure: Record<string, number> = {};
  /** GETs of a stopping server before it is SHUTOFF. */
  stopPolls = 2;
  now = () => "2026-10-05T12:00:00Z";
  private nextId = 1;
  private nextToken = 2;
  private listCalls = 0;

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, url, headers, body });
    return this.route(method, url, headers, body);
  }) as typeof fetch;

  expireToken(): void {
    this.token = `TOKEN-${this.nextToken++}`;
  }

  private json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  }

  private route(method: string, url: URL, headers: Headers, body: any): Response {
    if (url.origin + url.pathname === `${AUTH}/auth/tokens`) {
      const cred = body?.auth?.identity?.application_credential;
      if (cred?.id !== "CRED-ID" || cred?.secret !== "CRED-SECRET") {
        return this.json(401, { error: { code: 401, message: "The request you have made requires authentication." } });
      }
      this.logins++;
      const ep = (u: string) => ({ interface: "public", region: this.region, url: u });
      return this.json(
        201,
        {
          token: {
            catalog: [
              { type: "compute", endpoints: [ep(COMPUTE), { interface: "admin", region: this.region, url: "https://admin.example.test" }] },
              { type: "image", endpoints: [ep(IMAGE)] },
              { type: "network", endpoints: [ep(NETWORK)] },
              { type: "compute", endpoints: [] },
            ],
          },
        },
        { "x-subject-token": this.token },
      );
    }

    if (headers.get("x-auth-token") !== this.token) {
      return this.json(401, { error: { code: 401, message: "token expired" } });
    }
    const path = url.pathname;

    if (url.origin === IMAGE && path === "/v2/images" && url.searchParams.get("visibility") === "private") {
      return this.listSnapshots(url);
    }
    if (url.origin === IMAGE && path === "/v2/images") {
      const name = url.searchParams.get("name");
      return this.json(200, { images: this.images.filter((i) => i.name === name) });
    }
    const img = url.origin === IMAGE ? /^\/v2\/images\/([^/]+)$/.exec(path) : null;
    if (img) {
      const snap = this.snapshots.find((i) => i.id === img[1]);
      if (!snap) return this.json(404, { message: "Image not found" });
      if (method === "DELETE") {
        this.snapshots.splice(this.snapshots.indexOf(snap), 1);
        return this.json(204);
      }
      if (method === "GET") {
        if (snap.status === "queued" && this.snapshotOutcome !== "never" && --snap.savePolls <= 0) {
          snap.status = this.snapshotOutcome;
        }
        const { savePolls: _p, ...api } = snap;
        return this.json(200, api);
      }
    }
    if (url.origin === NETWORK && path === "/v2.0/networks") {
      const name = url.searchParams.get("name");
      return this.json(200, { networks: this.networks.filter((n) => n.name === name) });
    }
    if (url.origin !== "https://compute.example.test") return this.json(404, {});

    const rest = path.replace("/v2.1", "");
    if (method === "GET" && rest === "/flavors") return this.json(200, { flavors: this.flavors });
    if (method === "POST" && rest === "/servers") return this.create(body.server);
    if (method === "GET" && rest === "/servers/detail") return this.list(url);

    const m = /^\/servers\/([^/]+)(\/metadata|\/action)?$/.exec(rest);
    if (!m) return this.json(404, {});
    const server = this.servers.find((s) => s.id === m[1]);
    if (!server) {
      return this.json(404, { itemNotFound: { message: `Instance ${m[1]} could not be found.`, code: 404 } });
    }
    if (method === "POST" && m[2] === "/action") return this.action(server, body);
    if (method === "GET") return this.json(200, { server: this.poll(server) });
    if (method === "DELETE") {
      if (this.deleteStatus === 204) this.servers.splice(this.servers.indexOf(server), 1);
      return this.json(this.deleteStatus, this.deleteStatus === 204 ? undefined : { conflictingRequest: { message: "busy" } });
    }
    if (method === "PUT" && m[2]) {
      server.metadata = { ...body.metadata };
      return this.json(200, { metadata: server.metadata });
    }
    if (method === "PUT") {
      server.name = body.server.name;
      return this.json(200, { server: this.view(server) });
    }
    return this.json(405, {});
  }

  private action(server: FakeServer, body: any): Response {
    const name = Object.keys(body)[0]!;
    const failure = this.actionFailure[name];
    if (failure) return this.json(failure, { conflictingRequest: { message: `cannot ${name}` } });
    if (name === "os-stop") {
      server.status = "ACTIVE";
      server["OS-EXT-STS:task_state"] = "powering-off";
      (server as any).stopPolls = this.stopPolls;
      return this.json(202);
    }
    if (name === "createImage") {
      if (server.status !== "SHUTOFF") return this.json(409, { conflictingRequest: { message: "server must be stopped" } });
      const id = uuid(5000 + this.snapshots.length + 1);
      this.snapshots.push({ id, name: body.createImage.name, status: "queued", created_at: this.now(), savePolls: this.savePolls });
      return this.snapshotReply === "body"
        ? this.json(202, { image_id: id })
        : this.json(202, undefined, { location: `${IMAGE}/v2/images/${id}` });
    }
    return this.json(400, {});
  }

  private listSnapshots(url: URL): Response {
    const marker = url.searchParams.get("marker");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const active = this.snapshots.filter((i) => i.status === "active");
    const start = marker ? active.findIndex((i) => i.id === marker) + 1 : 0;
    const page = active.slice(start, start + limit);
    return this.json(200, {
      images: page.map(({ savePolls: _p, ...api }) => api),
      ...(start + limit < active.length ? { next: "/v2/images?marker=ignored" } : {}),
    });
  }

  private create(spec: any): Response {
    const server: FakeServer = {
      id: uuid(this.nextId++),
      name: spec.name,
      status: "BUILD",
      created: this.now(),
      metadata: spec.metadata ?? {},
      addresses: {},
      "OS-EXT-STS:task_state": "spawning",
      buildPolls: this.buildPolls,
      userData: spec.user_data,
      body: spec,
    };
    this.servers.push(server);
    return this.json(202, { server: { id: server.id, links: [] } });
  }

  private poll(server: FakeServer): FakeServer {
    if ((server as any).stopPolls !== undefined && --(server as any).stopPolls <= 0) {
      server.status = "SHUTOFF";
      server["OS-EXT-STS:task_state"] = null;
      delete (server as any).stopPolls;
    }
    if (server.status === "BUILD" && this.buildOutcome !== "never" && --server.buildPolls <= 0) {
      if (this.buildOutcome === "ERROR") {
        server.status = "ERROR";
        server.fault = { message: "No valid host was found." };
      } else {
        server.status = "ACTIVE";
        server["OS-EXT-STS:task_state"] = null;
        server.addresses = {
          "Ext-Net": [{ addr: "203.0.113.7", version: 4 }, { addr: "2001:db8::7", version: 6 }],
        };
      }
    }
    return this.view(server);
  }

  private view(server: FakeServer): FakeServer {
    const { buildPolls: _b, userData: _u, body: _body, stopPolls: _s, ...api } = server as FakeServer & { stopPolls?: number };
    return api as FakeServer;
  }

  private list(url: URL): Response {
    this.listCalls++;
    let visible = [...this.servers];
    if (this.listCalls <= this.hideNewestFor) visible = visible.slice(0, -1);
    const marker = url.searchParams.get("marker");
    const start = marker ? visible.findIndex((s) => s.id === marker) + 1 : 0;
    const page = visible.slice(start, start + this.pageSize);
    const more = start + this.pageSize < visible.length;
    return this.json(200, {
      servers: page.map((s) => this.view(s)),
      ...(more ? { servers_links: [{ rel: "next", href: "ignored" }] } : {}),
    });
  }
}

const spec: CreateServerSpec = {
  name: "ci-karimn-sia-1a2b3c4d",
  labels: { pool: "ci", repo: "karimn_sia" },
  serverType: "b3-32",
  image: "Ubuntu 24.04",
  location: REGION,
  userData: "#cloud-config\nfoo: bar\n",
};

const make = (cloud = new FakeCloud(), extra: object = {}) => {
  const sleeps: number[] = [];
  const ovh = new OvhProvider({
    authUrl: AUTH,
    credentialId: "CRED-ID",
    credentialSecret: "CRED-SECRET",
    region: REGION,
    sshKeys: ["sia-ci-key"],
    fetch: cloud.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { cloud, ovh, sleeps };
};

describe("OvhProvider", () => {
  test("bills by runtime, not per started hour", () => {
    expect(make().ovh.billing).toBe("prorated");
  });

  test("refuses to send the credential over anything but https", () => {
    expect(
      () => new OvhProvider({ authUrl: "http://auth.example.test/v3", credentialId: "a", credentialSecret: "b", region: "R" }),
    ).toThrow("https");
  });

  test("refuses more than one SSH key, which Nova cannot take", () => {
    expect(
      () => new OvhProvider({ authUrl: AUTH, credentialId: "a", credentialSecret: "b", region: "R", sshKeys: ["a", "b"] }),
    ).toThrow("exactly one");
  });
});

describe("authentication", () => {
  test("logs in once with the application credential and sends the token on every call", async () => {
    const { cloud, ovh } = make();
    await ovh.listServers({});
    await ovh.listServers({});

    expect(cloud.logins).toBe(1);
    const login = cloud.requests[0]!;
    expect(login.method).toBe("POST");
    expect(login.body).toEqual({
      auth: { identity: { methods: ["application_credential"], application_credential: { id: "CRED-ID", secret: "CRED-SECRET" } } },
    });
    for (const r of cloud.requests.slice(1)) expect(r.headers.get("x-auth-token")).toBe("TOKEN-1");
  });

  test("logs in again, once, when the token has expired", async () => {
    const { cloud, ovh } = make();
    await ovh.listServers({});
    cloud.expireToken();
    await ovh.listServers({});
    expect(cloud.logins).toBe(2);
  });

  test("a rejected credential fails without echoing it", async () => {
    const { cloud } = make();
    const bad = new OvhProvider({ authUrl: AUTH, credentialId: "CRED-ID", credentialSecret: "WRONG-SECRET", region: REGION, fetch: cloud.fetch });
    const err = await bad.listServers({}).catch((e) => e);
    expect(err).toBeInstanceOf(OvhApiError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("identity");
    expect(err.message).not.toContain("WRONG-SECRET");
    expect(err.message).not.toContain("CRED-ID");
  });

  test("names the regions the catalog does have when the configured one is missing", async () => {
    const { cloud } = make();
    cloud.region = "GRA11";
    const err = await make(cloud).ovh.listServers({}).catch((e) => e);
    expect(err.message).toContain(`"${REGION}"`);
    expect(err.message).toContain("GRA11");
  });

  test("a failed login is retried by the next call, not remembered", async () => {
    const { cloud } = make();
    cloud.region = "GRA11";
    const { ovh } = make(cloud);
    await expect(ovh.listServers({})).rejects.toThrow("no public compute endpoint");
    cloud.region = REGION;
    expect(await ovh.listServers({})).toEqual([]);
  });
});

describe("createServer", () => {
  test("resolves flavor, image and network to IDs and posts Nova's shape", async () => {
    const { cloud, ovh } = make();
    await ovh.createServer(spec);

    const post = cloud.requests.find((r) => r.method === "POST" && r.url.pathname === "/v2.1/servers")!;
    expect(post.body.server).toMatchObject({
      name: spec.name,
      flavorRef: uuid(800),
      imageRef: uuid(900),
      networks: [{ uuid: uuid(700) }],
      metadata: spec.labels,
      key_name: "sia-ci-key",
    });
  });

  test("turns Nova's quota refusal into a QuotaExceededError naming the quota", async () => {
    const { cloud } = make();
    const quotaFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" && new URL(String(input)).pathname === "/v2.1/servers"
        ? new Response(
            JSON.stringify({ forbidden: { code: 403, message: "Quota exceeded for cores: Requested 8, but already used 32 of 34 cores" } }),
            { status: 403, headers: { "content-type": "application/json" } },
          )
        : cloud.fetch(input, init)) as typeof fetch;
    const { ovh } = make(cloud, { fetch: quotaFetch });
    const err = await ovh.createServer(spec).catch((e) => e);

    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.message).toContain("Quota exceeded for cores");
    expect(cloud.servers).toHaveLength(0);
  });

  test("base64-encodes the user data, which Nova requires", async () => {
    const { cloud, ovh } = make();
    await ovh.createServer(spec);
    const sent = cloud.servers[0]!.userData!;
    expect(sent).not.toContain("#cloud-config");
    expect(Buffer.from(sent, "base64").toString("utf8")).toBe(spec.userData);
  });

  test("returns the server once it has a public IPv4 address, polling until then", async () => {
    const { cloud, ovh, sleeps } = make();
    const server = await ovh.createServer(spec);

    expect(server).toMatchObject({
      name: spec.name,
      labels: spec.labels,
      status: "running",
      address: "203.0.113.7",
    });
    expect(server.id).toBe(uuid(1));
    expect(server.createdAt.toISOString()).toBe("2026-10-05T12:00:00.000Z");
    expect(sleeps.length).toBeGreaterThan(0);
    expect(cloud.servers).toHaveLength(1);
  });

  test("sends no key_name when none was configured", async () => {
    const { cloud, ovh } = make(new FakeCloud(), { sshKeys: [] });
    await ovh.createServer(spec);
    expect(cloud.servers[0]!.body).not.toHaveProperty("key_name");
  });

  test("passes an image UUID straight through without asking Glance", async () => {
    const { cloud, ovh } = make();
    await ovh.createServer({ ...spec, image: uuid(555) });
    expect(cloud.servers[0]!.body.imageRef).toBe(uuid(555));
    expect(cloud.requests.some((r) => r.url.origin === IMAGE)).toBe(false);
  });

  test.each([
    ["flavor", { serverType: "nope-1" }, 'flavor "nope-1" not found'],
    ["image", { image: "Windows" }, 'no active OVH image named "Windows"'],
  ])("fails clearly on an unknown %s, before creating anything", async (_n, over, message) => {
    const { cloud, ovh } = make();
    await expect(ovh.createServer({ ...spec, ...over })).rejects.toThrow(message);
    expect(cloud.servers).toHaveLength(0);
  });

  test("refuses an ambiguous image name rather than guessing", async () => {
    const { cloud, ovh } = make();
    cloud.images.push({ id: uuid(901), name: "Ubuntu 24.04" });
    await expect(ovh.createServer(spec)).rejects.toThrow("2 active OVH image");
  });

  test("fails when there is no Ext-Net", async () => {
    const { cloud, ovh } = make();
    cloud.networks = [];
    await expect(ovh.createServer(spec)).rejects.toThrow("Ext-Net");
  });

  test("rejects a name that is not a hostname", async () => {
    await expect(make().ovh.createServer({ ...spec, name: "Bad_Name" })).rejects.toThrow("hostname");
  });

  test("deletes a server that goes to ERROR, and says why", async () => {
    const { cloud, ovh } = make();
    cloud.buildOutcome = "ERROR";
    await expect(ovh.createServer(spec)).rejects.toThrow("No valid host was found.");
    expect(cloud.servers).toHaveLength(0);
  });

  test("deletes a server that never gets an address", async () => {
    const { cloud, ovh } = make(new FakeCloud(), { readyAttempts: 3 });
    cloud.buildOutcome = "never";
    await expect(ovh.createServer(spec)).rejects.toThrow("no public address after 3 checks");
    expect(cloud.servers).toHaveLength(0);
  });

  test("says loudly that a server is still billing when the cleanup delete fails too", async () => {
    const { cloud, ovh } = make(new FakeCloud(), { readyAttempts: 2 });
    cloud.buildOutcome = "never";
    cloud.deleteStatus = 409;
    const err = await ovh.createServer(spec).catch((e) => e);
    expect(err.message).toContain("no public address");
    expect(err.message).toContain(uuid(1));
    expect(err.message).toContain("billing");
  });
});

describe("createServer under concurrency (Nova has no unique names)", () => {
  test("of several concurrent creators for one name exactly one wins and the rest lose cleanly", async () => {
    const { cloud, ovh } = make();
    const results = await Promise.allSettled([ovh.createServer(spec), ovh.createServer(spec), ovh.createServer(spec)]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const l of lost) expect((l as PromiseRejectedResult).reason).toBeInstanceOf(ServerExistsError);
    // The losers deleted their own servers; only the winner is left, and it is the oldest.
    expect(cloud.servers.map((s) => s.id)).toEqual([uuid(1)]);
    expect((won[0] as PromiseFulfilledResult<any>).value.id).toBe(uuid(1));
  });

  test("a creator loses to an older live server with the same name", async () => {
    const { cloud, ovh } = make();
    const first = await ovh.createServer(spec);
    const err = await ovh.createServer(spec).catch((e) => e);

    expect(err).toBeInstanceOf(ServerExistsError);
    expect(cloud.servers.map((s) => s.id)).toEqual([first.id]);
  });

  test("a server of that name that is already being deleted does not block a new one", async () => {
    const { cloud, ovh } = make();
    const old = await ovh.createServer(spec);
    cloud.servers.find((s) => s.id === old.id)!["OS-EXT-STS:task_state"] = "deleting";

    const fresh = await ovh.createServer(spec);
    expect(fresh.id).not.toBe(old.id);
  });

  test("an off server of that name does not block a new one either", async () => {
    const { cloud, ovh } = make();
    const old = await ovh.createServer(spec);
    cloud.servers.find((s) => s.id === old.id)!.status = "SHUTOFF";
    await expect(ovh.createServer(spec)).resolves.toMatchObject({ status: "running" });
  });

  test("ties on created are broken by id, so every creator picks the same winner", async () => {
    const { cloud, ovh } = make();
    // Same second for everyone, as OVH reports it.
    cloud.now = () => "2026-10-05T12:00:00Z";
    const [a, b] = await Promise.allSettled([ovh.createServer(spec), ovh.createServer(spec)]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
  });

  test("waits for its own server to show up in the list before deciding", async () => {
    const { cloud, ovh, sleeps } = make();
    cloud.hideNewestFor = 2;
    const server = await ovh.createServer(spec);
    expect(server.id).toBe(uuid(1));
    expect(sleeps).toContain(1000);
  });

  test("gives up, and deletes the server, if its own server never shows up", async () => {
    const { cloud, ovh } = make();
    cloud.hideNewestFor = 100;
    await expect(ovh.createServer(spec)).rejects.toThrow("never appeared");
    expect(cloud.servers).toHaveLength(0);
  });
});

describe("listServers", () => {
  const seed = async (cloud: FakeCloud, over: Partial<FakeServer> & { name: string }) => {
    const ovh = make(cloud).ovh;
    const s = await ovh.createServer({ ...spec, name: over.name, labels: over.metadata ?? spec.labels });
    Object.assign(cloud.servers.find((x) => x.id === s.id)!, over);
    return s;
  };

  test("filters on labels client-side, since Nova's name filter is a regex", async () => {
    const cloud = new FakeCloud();
    await seed(cloud, { name: "a", metadata: { pool: "ci", repo: "karimn_sia" } });
    await seed(cloud, { name: "b", metadata: { pool: "other", repo: "karimn_sia" } });
    await seed(cloud, { name: "c", metadata: { pool: "ci", repo: "karimn_other" } });

    const found = await make(cloud).ovh.listServers({ pool: "ci", repo: "karimn_sia" });
    expect(found.map((s) => s.name)).toEqual(["a"]);
    expect(cloud.requests.every((r) => !r.url.searchParams.has("name") || r.url.origin === IMAGE || r.url.origin === NETWORK)).toBe(true);
  });

  test("follows pagination to the end", async () => {
    const cloud = new FakeCloud();
    for (let i = 0; i < 5; i++) await seed(cloud, { name: `s${i}` });
    cloud.pageSize = 2;
    const found = await make(cloud).ovh.listServers({ pool: "ci" });
    expect(found.map((s) => s.name)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  test.each([
    ["BUILD", null, "starting"],
    ["ACTIVE", null, "running"],
    ["ACTIVE", "deleting", "stopping"],
    ["HARD_REBOOT", null, "starting"],
    ["SHUTOFF", null, "off"],
    ["PAUSED", null, "off"],
    ["SHELVED_OFFLOADED", null, "off"],
    ["ERROR", null, "error"],
    ["SOMETHING_NEW", null, "off"],
  ])("maps Nova %s with task state %s to %s", async (status, task, expected) => {
    const cloud = new FakeCloud();
    await seed(cloud, { name: "x", status, "OS-EXT-STS:task_state": task });
    const [s] = await make(cloud).ovh.listServers({});
    expect(s?.status).toBe(expected as any);
  });

  test("uses the public IPv4 address, not a private or IPv6 one, and omits it when there is none", async () => {
    const cloud = new FakeCloud();
    await seed(cloud, {
      name: "x",
      addresses: {
        private: [{ addr: "10.0.0.5", version: 4 }],
        "Ext-Net": [{ addr: "2001:db8::1", version: 6 }, { addr: "198.51.100.9", version: 4 }],
      },
    });
    await seed(cloud, { name: "y", addresses: { private: [{ addr: "192.168.1.5", version: 4 }] } });
    const [x, y] = await make(cloud).ovh.listServers({});
    expect(x?.address).toBe("198.51.100.9");
    expect(y).not.toHaveProperty("address");
  });
});

describe("deleteServer", () => {
  test("deletes by id", async () => {
    const { cloud, ovh } = make();
    const s = await ovh.createServer(spec);
    await ovh.deleteServer(s.id);
    expect(cloud.servers).toHaveLength(0);
  });

  test("treats a server that is already gone as deleted", async () => {
    await expect(make().ovh.deleteServer(uuid(42))).resolves.toBeUndefined();
  });

  test("rejects on any other failure", async () => {
    const { cloud, ovh } = make();
    const s = await ovh.createServer(spec);
    cloud.deleteStatus = 409;
    await expect(ovh.deleteServer(s.id)).rejects.toBeInstanceOf(OvhApiError);
  });

  test("rejects an id that is not a UUID before sending anything", async () => {
    const { cloud, ovh } = make();
    await expect(ovh.deleteServer("../servers")).rejects.toThrow("invalid server id");
    expect(cloud.requests).toHaveLength(0);
  });
});

describe("updateServer", () => {
  test("renames, then replaces the whole label set, in that order", async () => {
    const { cloud, ovh } = make();
    const s = await ovh.createServer(spec);
    const updated = await ovh.updateServer(s.id, {
      name: "released-1",
      labels: { pool: "released", repo: "karimn_sia", "released-from": "ci" },
    });

    const puts = cloud.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.url.pathname)).toEqual([`/v2.1/servers/${s.id}`, `/v2.1/servers/${s.id}/metadata`]);
    expect(puts[0]!.body).toEqual({ server: { name: "released-1" } });
    expect(puts[1]!.body).toEqual({ metadata: { pool: "released", repo: "karimn_sia", "released-from": "ci" } });
    expect(updated.name).toBe("released-1");
    // Replaced, not merged: nothing of the old set is left to match the pool.
    expect(updated.labels).toEqual({ pool: "released", repo: "karimn_sia", "released-from": "ci" });
  });

  test("a failed relabel leaves the server renamed but still in the pool, so release can retry", async () => {
    const { cloud, ovh } = make();
    const s = await ovh.createServer(spec);
    const real = cloud.fetch;
    const failing = new OvhProvider({
      authUrl: AUTH, credentialId: "CRED-ID", credentialSecret: "CRED-SECRET", region: REGION,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/metadata") ? new Response("{}", { status: 500 }) : real(input, init)) as typeof fetch,
    });
    await expect(failing.updateServer(s.id, { name: "released-1", labels: { pool: "released" } })).rejects.toBeInstanceOf(OvhApiError);
    expect(cloud.servers[0]).toMatchObject({ name: "released-1", metadata: spec.labels });
  });

  test("validates the name and id", async () => {
    const { ovh } = make();
    await expect(ovh.updateServer("nope", { name: "ok", labels: {} })).rejects.toThrow("invalid server id");
    await expect(ovh.updateServer(uuid(1), { name: "Not OK", labels: {} })).rejects.toThrow("hostname");
  });
});

describe("images", () => {
  const snap = (cloud: FakeCloud, name: string, created: string, status = "active", id?: string) => {
    const entry = { id: id ?? uuid(6000 + cloud.snapshots.length), name, status, created_at: created, savePolls: 0 };
    cloud.snapshots.push(entry);
    return entry;
  };

  test("snapshots a stopped server and returns the image once it is active", async () => {
    const { cloud, ovh } = make();
    const server = await ovh.createServer(spec);

    const image = await ovh.createImage(server.id, "vgr-ci-20261005");

    expect(image).toMatchObject({ name: "vgr-ci-20261005", createdAt: new Date("2026-10-05T12:00:00Z") });
    expect(cloud.snapshots).toHaveLength(1);
    const actions = cloud.requests.filter((r) => r.url.pathname.endsWith("/action")).map((r) => Object.keys(r.body)[0]);
    // The disk is consistent only if the server is stopped first.
    expect(actions).toEqual(["os-stop", "createImage"]);
    expect(cloud.servers[0]!.status).toBe("SHUTOFF");
  });

  test("reads the image id from the body when the microversion returns it there", async () => {
    const { cloud, ovh } = make();
    cloud.snapshotReply = "body";
    const server = await ovh.createServer(spec);
    expect((await ovh.createImage(server.id, "vgr-ci-20261005")).id).toBe(cloud.snapshots[0]!.id);
  });

  test("waits while the snapshot is saving", async () => {
    const { cloud, ovh, sleeps } = make();
    cloud.savePolls = 4;
    const server = await ovh.createServer(spec);
    sleeps.length = 0;
    await ovh.createImage(server.id, "vgr-ci-20261005");
    expect(sleeps.filter((ms) => ms === 10_000).length).toBeGreaterThanOrEqual(3);
  });

  test("deletes the image and rejects when the snapshot is killed, so it can never be picked up", async () => {
    const { cloud, ovh } = make();
    cloud.snapshotOutcome = "killed";
    const server = await ovh.createServer(spec);
    await expect(ovh.createImage(server.id, "vgr-ci-20261005")).rejects.toThrow("killed");
    expect(cloud.snapshots).toHaveLength(0);
  });

  test("deletes the image and rejects when it never becomes active", async () => {
    const { cloud, ovh } = make(new FakeCloud(), { snapshotAttempts: 3 });
    cloud.snapshotOutcome = "never";
    const server = await ovh.createServer(spec);
    await expect(ovh.createImage(server.id, "vgr-ci-20261005")).rejects.toThrow("not active in time");
    expect(cloud.snapshots).toHaveLength(0);
  });

  test("rejects when the server never stops", async () => {
    const { cloud, ovh } = make(new FakeCloud(), { snapshotAttempts: 2 });
    cloud.stopPolls = 99;
    const server = await ovh.createServer(spec);
    await expect(ovh.createImage(server.id, "x")).rejects.toThrow("did not stop");
    expect(cloud.snapshots).toHaveLength(0);
  });

  test("propagates a refused snapshot request", async () => {
    const { cloud, ovh } = make();
    cloud.actionFailure = { createImage: 409 };
    const server = await ovh.createServer(spec);
    await expect(ovh.createImage(server.id, "x")).rejects.toBeInstanceOf(OvhApiError);
  });

  test("lists only private, active images with the prefix, across pages", async () => {
    const { cloud, ovh } = make();
    snap(cloud, "vgr-ci-20261001", "2026-10-01T00:00:00Z");
    snap(cloud, "vgr-ci-20261002", "2026-10-02T00:00:00Z");
    snap(cloud, "vgr-ci-20261003", "2026-10-03T00:00:00Z");
    snap(cloud, "vgr-other-20261003", "2026-10-03T00:00:00Z");
    snap(cloud, "vgr-ci-20261004", "2026-10-04T00:00:00Z", "queued");

    const names = (await ovh.listImages("vgr-ci-")).map((i) => i.name).sort();
    expect(names).toEqual(["vgr-ci-20261001", "vgr-ci-20261002", "vgr-ci-20261003"]);

    const req = cloud.requests.find((r) => r.url.pathname === "/v2/images")!;
    expect(req.url.searchParams.get("visibility")).toBe("private");
    expect(req.url.searchParams.get("status")).toBe("active");
  });

  test("pages through a long listing", async () => {
    const { cloud, ovh } = make();
    for (let i = 0; i < 150; i++) snap(cloud, `vgr-ci-${20260000 + i}`, "2026-10-01T00:00:00Z");
    expect(await ovh.listImages("vgr-ci-")).toHaveLength(150);
  });

  test("deletes an image, and counts one that is already gone as deleted", async () => {
    const { cloud, ovh } = make();
    const a = snap(cloud, "vgr-ci-20261001", "2026-10-01T00:00:00Z");
    await ovh.deleteImage(a.id);
    expect(cloud.snapshots).toHaveLength(0);
    await ovh.deleteImage(a.id);
    await expect(ovh.deleteImage("nope")).rejects.toThrow("invalid image id");
  });
});
