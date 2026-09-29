/**
 * The GitHub side of the reaper: what it needs to know about runners and runs.
 * A real implementation over the REST API comes later; the reaper only sees this.
 */

export interface Runner {
  readonly id: number;
  readonly name: string;
  readonly busy: boolean;
  readonly status: "online" | "offline";
}

export interface GithubHost {
  listRunners(): Promise<readonly Runner[]>;
  /**
   * True if the repo has any workflow run that is queued or in progress, other
   * than `excludeRunId`. A run between two jobs has no busy runner yet, so
   * runner state alone under-reports; this is the conservative backstop.
   */
  hasActiveRuns(excludeRunId?: number): Promise<boolean>;
  /** Must reject if the runner is busy, which GitHub does. */
  deregisterRunner(id: number): Promise<void>;
}

/**
 * Runners are named `<server name>-<n>`, so the owning server is recoverable
 * from the name alone with no extra state.
 */
export const runnerName = (serverName: string, index: number): string =>
  `${serverName}-${index}`;

export const runnersOfServer = (
  runners: readonly Runner[],
  serverName: string,
): readonly Runner[] =>
  runners.filter((r) => r.name.startsWith(`${serverName}-`));
