import type { GithubHost, Runner } from "./github.ts";

/** In-memory GitHub for tests. Deregistering a busy runner rejects, as GitHub does. */
export class MockGithub implements GithubHost {
  readonly runners = new Map<number, Runner>();
  readonly calls: string[] = [];
  activeRuns = false;
  /** Runner ids whose deregistration should fail for a reason other than busy. */
  readonly failDeregister = new Set<number>();

  addRunner(runner: Runner): void {
    this.runners.set(runner.id, runner);
  }

  async listRunners(): Promise<readonly Runner[]> {
    this.calls.push("listRunners");
    return [...this.runners.values()];
  }

  async hasActiveRuns(excludeRunId?: number): Promise<boolean> {
    this.calls.push(`hasActiveRuns:${excludeRunId ?? ""}`);
    return this.activeRuns;
  }

  async deregisterRunner(id: number): Promise<void> {
    this.calls.push(`deregister:${id}`);
    const r = this.runners.get(id);
    if (!r) throw new Error(`no such runner: ${id}`);
    if (r.busy) throw new Error(`runner ${id} is busy`);
    if (this.failDeregister.has(id)) throw new Error(`deregister failed: ${id}`);
    this.runners.delete(id);
  }
}
