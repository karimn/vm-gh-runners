import type { GithubHost, Runner, RunState } from "./github.ts";

/** In-memory GitHub for tests. Deregistering a busy runner rejects, as GitHub does. */
export class MockGithub implements GithubHost {
  readonly runners = new Map<number, Runner>();
  readonly calls: string[] = [];
  activeRuns = false;
  /** Per-run state for `runState`; a run not listed is `not-found`. */
  readonly runStates = new Map<number, RunState>();
  /** Run ids whose lookup should fail, as a GitHub outage or a missing permission would. */
  readonly failRunState = new Set<number>();
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

  async runState(runId: number): Promise<RunState> {
    this.calls.push(`runState:${runId}`);
    if (this.failRunState.has(runId)) throw new Error(`run lookup failed: ${runId}`);
    return this.runStates.get(runId) ?? "not-found";
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
