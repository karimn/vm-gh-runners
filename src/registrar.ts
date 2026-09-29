import type { Server } from "./provider.ts";

/**
 * Puts GitHub Actions runners on a server. The real implementation reaches the
 * VM (e.g. over SSH), waits for it to be ready, fetches a short-lived
 * registration token and runs the runner's config step.
 *
 * Registration happens from the workflow, after boot, and not from cloud-init,
 * so no GitHub token ever sits in the VM's user-data.
 *
 * Contract: idempotent, and a name that is already registered is replaced
 * (the runner's `--replace`), so repairing an offline runner and creating a
 * missing one are the same call.
 */
export interface RunnerRegistrar {
  register(server: Server, runnerNames: readonly string[]): Promise<void>;
}
