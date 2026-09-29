import {
  labelsMatch,
  type CreateServerSpec,
  type Labels,
  type Provider,
  type Server,
} from "./provider.ts";

/** In-memory provider for unit tests. `now` is injectable so age is testable. */
export class MockProvider implements Provider {
  readonly servers = new Map<string, Server>();
  readonly calls: string[] = [];
  private nextId = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async createServer(spec: CreateServerSpec): Promise<Server> {
    this.calls.push(`create:${spec.name}`);
    const server: Server = {
      id: String(this.nextId++),
      name: spec.name,
      labels: spec.labels,
      createdAt: this.now(),
      status: "running",
    };
    this.servers.set(server.id, server);
    return server;
  }

  async listServers(selector: Labels): Promise<readonly Server[]> {
    this.calls.push("list");
    return [...this.servers.values()].filter((s) =>
      labelsMatch(s.labels, selector),
    );
  }

  async deleteServer(id: string): Promise<void> {
    this.calls.push(`delete:${id}`);
    if (!this.servers.delete(id)) throw new Error(`no such server: ${id}`);
  }
}
