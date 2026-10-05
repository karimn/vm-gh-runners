import type { GithubHost, Runner, RunState } from "./github.ts";

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

export interface GithubClientOptions {
  /** `owner/name`. Runners registered to a personal repo serve only that repo. */
  readonly repo: string;
  /**
   * Fine-grained PAT with repo Administration (read and write) and Actions (read);
   * see PAT_PERMISSIONS below for what each call needs. Never logged.
   */
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

const PER_PAGE = 100;

/** The fine-grained PAT permission each REST call needs, keyed by `METHOD path-prefix`. */
const PAT_PERMISSIONS: readonly (readonly [string, string])[] = [
  ["GET /actions/runners", "Administration: read"],
  ["DELETE /actions/runners/", "Administration: write"],
  ["POST /actions/runners/registration-token", "Administration: write"],
  ["GET /actions/runs", "Actions: read"],
];

const PAT_DENIED = "Resource not accessible by personal access token";

const missingPermission = (method: string, path: string): string | undefined =>
  PAT_PERMISSIONS.find(([key]) => `${method} ${path}`.startsWith(key))?.[1];

interface RunnersPage {
  total_count: number;
  runners: { id: number; name: string; status: string; busy: boolean }[];
}

interface RunsPage {
  workflow_runs: { id: number }[];
}

/** GitHub REST client for the calls the reaper and registrar need. */
export class GithubClient implements GithubHost {
  private readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: GithubClientOptions) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
      throw new Error(`repo must be "owner/name", got "${opts.repo}"`);
    }
    this.repo = opts.repo;
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
  }

  async listRunners(): Promise<readonly Runner[]> {
    const runners: Runner[] = [];
    for (let page = 1; ; page++) {
      const body = await this.json<RunnersPage>(
        "GET",
        `/actions/runners?per_page=${PER_PAGE}&page=${page}`,
      );
      for (const r of body.runners) {
        runners.push({
          id: r.id,
          name: r.name,
          busy: r.busy,
          status: r.status === "online" ? "online" : "offline",
        });
      }
      // An empty page also ends the loop, so a wrong total_count cannot spin forever.
      if (body.runners.length === 0 || runners.length >= body.total_count) return runners;
    }
  }

  async hasActiveRuns(excludeRunId?: number): Promise<boolean> {
    for (const status of ["queued", "in_progress"]) {
      const body = await this.json<RunsPage>(
        "GET",
        `/actions/runs?status=${status}&per_page=${PER_PAGE}`,
      );
      // At most one run is excluded, so any other run on this page settles it.
      if (body.workflow_runs.some((r) => r.id !== excludeRunId)) return true;
    }
    return false;
  }

  async runState(runId: number): Promise<RunState> {
    try {
      const body = await this.json<{ status: string | null }>("GET", `/actions/runs/${runId}`);
      return body.status === "completed" ? "finished" : "active";
    } catch (e) {
      if (e instanceof GithubApiError && e.status === 404) return "not-found";
      throw e;
    }
  }

  async deregisterRunner(id: number): Promise<void> {
    await this.request("DELETE", `/actions/runners/${id}`);
  }

  /** Short-lived token the runner's config step needs. Handle it as a secret. */
  async createRegistrationToken(): Promise<string> {
    const body = await this.json<{ token: string }>("POST", "/actions/runners/registration-token");
    return body.token;
  }

  private async json<T>(method: string, path: string): Promise<T> {
    return (await (await this.request(method, path)).json()) as T;
  }

  private async request(method: string, path: string): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "vm-gh-runners",
      },
    });
    if (!res.ok) {
      // Only GitHub's own message goes into the error, never our request headers.
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) detail = body.message;
      } catch {
        // Not JSON; the status text will do.
      }
      let hint = "";
      if (res.status === 403 && detail.includes(PAT_DENIED)) {
        const needed = missingPermission(method, path);
        hint =
          ` -- the github-token PAT lacks "${needed ?? "a required permission"}" on ${this.repo}` +
          ` (needed for ${method} /repos/${this.repo}${path.split("?")[0]})`;
      }
      throw new GithubApiError(
        res.status,
        `GitHub ${method} ${path} failed (${res.status}): ${detail}${hint}`,
      );
    }
    return res;
  }
}
