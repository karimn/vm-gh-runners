import { describe, expect, test } from "bun:test";
import { HetznerApiError, HetznerProvider } from "../src/hetzner.ts";
import type { CreateServerSpec } from "../src/provider.ts";

interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
}
type Handler = (req: Recorded) => { status?: number; body?: unknown };

const fake = (handler: Handler) => {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(req);
    const { status = 200, body } = handler(req);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { requests, fetchImpl };
};

const make = (handler: Handler, extra: object = {}) => {
  const f = fake(handler);
  return { ...f, hz: new HetznerProvider({ token: "SECRET-TOKEN", fetch: f.fetchImpl, ...extra }) };
};

const apiServer = (over: object = {}) => ({
  id: 4242,
  name: "ci-karimn-sia-20260101t000000z",
  status: "running",
  created: "2026-01-01T00:00:00+00:00",
  labels: { pool: "ci", repo: "karimn_sia" },
  ...over,
});

const spec: CreateServerSpec = {
  name: "ci-karimn-sia-20260101t000000z",
  labels: { pool: "ci", repo: "karimn_sia" },
  serverType: "cpx62",
  image: "ubuntu-24.04",
  location: "nbg1",
  userData: "#cloud-config",
};

describe("createServer", () => {
  test("POSTs the spec in Hetzner's shape and maps the response", async () => {
    const { hz, requests } = make(() => ({ status: 201, body: { server: apiServer() } }));
    const s = await hz.createServer(spec);

    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url.pathname).toBe("/v1/servers");
    expect(req.headers.get("authorization")).toBe("Bearer SECRET-TOKEN");
    expect(req.body).toEqual({
      name: spec.name,
      server_type: "cpx62",
      image: "ubuntu-24.04",
      location: "nbg1",
      labels: spec.labels,
      user_data: "#cloud-config",
      start_after_create: true,
    });
    expect(s).toEqual({
      id: "4242",
      name: spec.name,
      labels: { pool: "ci", repo: "karimn_sia" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      status: "running",
    });
  });

  test("injects SSH keys when configured, so a registrar can reach the VM", async () => {
    const { hz, requests } = make(() => ({ status: 201, body: { server: apiServer() } }), {
      sshKeys: ["ci-key", 7],
    });
    await hz.createServer(spec);
    expect(requests[0]?.body.ssh_keys).toEqual(["ci-key", 7]);
  });

  test("omits ssh_keys when none are configured", async () => {
    const { hz, requests } = make(() => ({ status: 201, body: { server: apiServer() } }));
    await hz.createServer(spec);
    expect("ssh_keys" in requests[0]!.body).toBe(false);
  });

  test("rejects a label value Hetzner would refuse, before any request", async () => {
    const { hz, requests } = make(() => ({ status: 201, body: { server: apiServer() } }));

    await expect(hz.createServer({ ...spec, labels: { repo: "karimn/sia" } })).rejects.toThrow("repo");
    await expect(hz.createServer({ ...spec, labels: { repo: "x".repeat(64) } })).rejects.toThrow("repo");
    await expect(hz.createServer({ ...spec, labels: { "hetzner.cloud/x": "v" } })).rejects.toThrow("hetzner.cloud");
    expect(requests).toHaveLength(0);
  });

  test("rejects a server name that is not a valid hostname", async () => {
    const { hz, requests } = make(() => ({ status: 201, body: { server: apiServer() } }));

    await expect(hz.createServer({ ...spec, name: "Has_Underscore" })).rejects.toThrow("hostname");
    await expect(hz.createServer({ ...spec, name: "a".repeat(64) })).rejects.toThrow("hostname");
    expect(requests).toHaveLength(0);
  });

  test("never puts the token in an error", async () => {
    const { hz } = make(() => ({
      status: 403,
      body: { error: { code: "forbidden", message: "insufficient permissions" } },
    }));
    const err = await hz.createServer(spec).catch((e) => e);

    expect(err).toBeInstanceOf(HetznerApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("insufficient permissions");
    expect(err.message).not.toContain("SECRET-TOKEN");
  });
});

describe("listServers", () => {
  test("filters with a label selector", async () => {
    const { hz, requests } = make(() => ({ body: { servers: [], meta: { pagination: { next_page: null } } } }));
    await hz.listServers({ pool: "ci", repo: "karimn_sia" });

    const url = requests[0]!.url;
    expect(url.pathname).toBe("/v1/servers");
    expect(url.searchParams.get("label_selector")).toBe("pool=ci,repo=karimn_sia");
    expect(url.searchParams.get("per_page")).toBe("50");
  });

  test("sends no selector for an empty one", async () => {
    const { hz, requests } = make(() => ({ body: { servers: [], meta: { pagination: { next_page: null } } } }));
    await hz.listServers({});
    expect(requests[0]!.url.searchParams.has("label_selector")).toBe(false);
  });

  test("refuses a selector value that could inject selector syntax", async () => {
    const { hz, requests } = make(() => ({ body: { servers: [] } }));
    await expect(hz.listServers({ pool: "ci,repo!=x" })).rejects.toThrow("pool");
    expect(requests).toHaveLength(0);
  });

  test("follows next_page until it is null", async () => {
    const { hz, requests } = make((req) => {
      const page = Number(req.url.searchParams.get("page"));
      return {
        body: {
          servers: [apiServer({ id: page })],
          meta: { pagination: { next_page: page < 3 ? page + 1 : null } },
        },
      };
    });

    const servers = await hz.listServers({ pool: "ci" });
    expect(servers.map((s) => s.id)).toEqual(["1", "2", "3"]);
    expect(requests.map((r) => r.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  test("maps Hetzner statuses onto the neutral ones", async () => {
    const statuses = [
      "initializing", "starting", "running", "migrating",
      "stopping", "deleting", "off", "rebuilding", "unknown",
    ];
    const { hz } = make(() => ({
      body: {
        servers: statuses.map((status, i) => apiServer({ id: i, status })),
        meta: { pagination: { next_page: null } },
      },
    }));

    const got = Object.fromEntries((await hz.listServers({})).map((s, i) => [statuses[i], s.status]));
    expect(got).toEqual({
      initializing: "starting",
      starting: "starting",
      running: "running",
      migrating: "running",
      stopping: "stopping",
      deleting: "stopping",
      off: "off",
      // Not ready, but must stay reusable so we do not create a second server
      // and hit the account's server cap.
      rebuilding: "starting",
      unknown: "starting",
    });
  });
});

describe("deleteServer", () => {
  test("sends DELETE for the id", async () => {
    const { hz, requests } = make(() => ({ body: { action: { id: 1 } } }));
    await hz.deleteServer("4242");

    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url.pathname).toBe("/v1/servers/4242");
  });

  test("treats a server that is already gone as deleted", async () => {
    const { hz } = make(() => ({ status: 404, body: { error: { code: "not_found", message: "server not found" } } }));
    await expect(hz.deleteServer("4242")).resolves.toBeUndefined();
  });

  test("rejects on any other failure, since an undeleted server keeps billing", async () => {
    const { hz } = make(() => ({ status: 500, body: { error: { code: "server_error", message: "boom" } } }));
    const err = await hz.deleteServer("4242").catch((e) => e);
    expect(err).toBeInstanceOf(HetznerApiError);
    expect(err.status).toBe(500);
  });

  test("refuses a non-numeric id rather than building an odd URL", async () => {
    const { hz, requests } = make(() => ({ body: {} }));
    await expect(hz.deleteServer("../volumes/1")).rejects.toThrow("id");
    expect(requests).toHaveLength(0);
  });
});
