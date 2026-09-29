import { describe, expect, test } from "bun:test";
import { GithubApiError, GithubClient } from "../src/github-client.ts";

interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
}

type Handler = (req: Recorded) => { status?: number; body?: unknown };

/** A fake fetch that records requests and answers from `handler`. */
const fake = (handler: Handler) => {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
    };
    requests.push(req);
    const { status = 200, body } = handler(req);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { requests, fetchImpl };
};

const client = (handler: Handler, repo = "karimn/sia") => {
  const f = fake(handler);
  return {
    ...f,
    gh: new GithubClient({ repo, token: "SECRET-TOKEN", fetch: f.fetchImpl }),
  };
};

const runner = (id: number, name: string, over: object = {}) => ({
  id,
  name,
  status: "online",
  busy: false,
  labels: [],
  ...over,
});

describe("GithubClient construction", () => {
  test("rejects a repo that is not owner/name", () => {
    expect(() => new GithubClient({ repo: "nope", token: "t" })).toThrow("owner/name");
    expect(() => new GithubClient({ repo: "a/b/c", token: "t" })).toThrow("owner/name");
  });
});

describe("listRunners", () => {
  test("maps runners and sends auth and API-version headers", async () => {
    const { gh, requests } = client(() => ({
      body: { total_count: 2, runners: [runner(1, "a-1"), runner(2, "a-2", { busy: true, status: "offline" })] },
    }));

    expect(await gh.listRunners()).toEqual([
      { id: 1, name: "a-1", busy: false, status: "online" },
      { id: 2, name: "a-2", busy: true, status: "offline" },
    ]);
    const req = requests[0]!;
    expect(req.url.pathname).toBe("/repos/karimn/sia/actions/runners");
    expect(req.headers.get("authorization")).toBe("Bearer SECRET-TOKEN");
    expect(req.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(req.headers.get("accept")).toBe("application/vnd.github+json");
  });

  test("follows pages until it has every runner", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => runner(i + 1, `r-${i + 1}`));
    const page2 = [runner(101, "r-101")];
    const { gh, requests } = client((req) => ({
      body: { total_count: 101, runners: req.url.searchParams.get("page") === "2" ? page2 : page1 },
    }));

    expect(await gh.listRunners()).toHaveLength(101);
    expect(requests.map((r) => r.url.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  test("stops on an empty page even if total_count is wrong", async () => {
    const { gh, requests } = client((req) => ({
      body: { total_count: 500, runners: req.url.searchParams.get("page") === "1" ? [runner(1, "a")] : [] },
    }));
    expect(await gh.listRunners()).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });
});

describe("hasActiveRuns", () => {
  const runsFor = (queued: number[], inProgress: number[]): Handler => (req) => {
    const status = req.url.searchParams.get("status");
    const ids = status === "queued" ? queued : status === "in_progress" ? inProgress : [];
    return { body: { total_count: ids.length, workflow_runs: ids.map((id) => ({ id })) } };
  };

  test("is false when nothing is queued or in progress", async () => {
    const { gh } = client(runsFor([], []));
    expect(await gh.hasActiveRuns()).toBe(false);
  });

  test("is true for a queued run", async () => {
    const { gh } = client(runsFor([5], []));
    expect(await gh.hasActiveRuns()).toBe(true);
  });

  test("is true for an in-progress run", async () => {
    const { gh } = client(runsFor([], [5]));
    expect(await gh.hasActiveRuns()).toBe(true);
  });

  test("ignores the excluded run", async () => {
    const { gh } = client(runsFor([], [99]));
    expect(await gh.hasActiveRuns(99)).toBe(false);
  });

  test("still sees other runs when one is excluded", async () => {
    const { gh } = client(runsFor([], [99, 100]));
    expect(await gh.hasActiveRuns(99)).toBe(true);
  });
});

describe("deregisterRunner", () => {
  test("sends DELETE for the runner", async () => {
    const { gh, requests } = client(() => ({ status: 204 }));
    await gh.deregisterRunner(42);

    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url.pathname).toBe("/repos/karimn/sia/actions/runners/42");
  });

  test("rejects with the status when GitHub refuses, as it does for a busy runner", async () => {
    const { gh } = client(() => ({ status: 422, body: { message: "Bad request - Runner \"x\" is still running a job" } }));

    const err = await gh.deregisterRunner(42).catch((e) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("still running a job");
  });
});

describe("createRegistrationToken", () => {
  test("POSTs and returns the token", async () => {
    const { gh, requests } = client(() => ({
      status: 201,
      body: { token: "REG-TOKEN", expires_at: "2026-01-01T01:00:00Z" },
    }));

    expect(await gh.createRegistrationToken()).toBe("REG-TOKEN");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.pathname).toBe("/repos/karimn/sia/actions/runners/registration-token");
  });
});

describe("errors", () => {
  test("never include the API token in the message", async () => {
    const { gh } = client(() => ({ status: 401, body: { message: "Bad credentials" } }));
    const err = await gh.listRunners().catch((e) => e);

    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain("SECRET-TOKEN");
  });

  test("survive a non-JSON error body", async () => {
    const f = fake(() => ({ status: 502 }));
    const gh = new GithubClient({ repo: "a/b", token: "t", fetch: f.fetchImpl });
    const err = await gh.listRunners().catch((e) => e);

    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(502);
  });
});
