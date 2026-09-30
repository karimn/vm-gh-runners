import type { MockGithub } from "./mock-github.ts";
import type { Server } from "./provider.ts";
import type { RunnerRegistrar } from "./registrar.ts";

/** Registers runners straight into a MockGithub, replacing same-name entries. */
export class MockRegistrar implements RunnerRegistrar {
  readonly calls: (readonly string[])[] = [];
  private nextId = 1000;
  readonly uninstalled: Server[] = [];
  failWith: Error | undefined;
  failUninstallWith: Error | undefined;

  constructor(private readonly github: MockGithub) {}

  async register(_server: Server, runnerNames: readonly string[]): Promise<void> {
    this.calls.push(runnerNames);
    if (this.failWith) throw this.failWith;
    for (const name of runnerNames) {
      for (const [id, r] of this.github.runners) {
        if (r.name === name) this.github.runners.delete(id);
      }
      const id = this.nextId++;
      this.github.addRunner({ id, name, busy: false, status: "online" });
    }
  }

  async uninstall(server: Server): Promise<void> {
    if (this.failUninstallWith) throw this.failUninstallWith;
    this.uninstalled.push(server);
  }
}
