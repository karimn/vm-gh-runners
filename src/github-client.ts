import type { GithubHost, Runner } from "./github.ts";

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
  /** Needs repo Administration (read and write) to manage runners. Never logged. */
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

const PER_PAGE = 100;

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
      throw new GithubApiError(res.status, `GitHub ${method} ${path} failed (${res.status}): ${detail}`);
    }
    return res;
  }
}
