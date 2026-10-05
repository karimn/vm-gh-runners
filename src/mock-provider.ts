import {
  labelsMatch,
  ServerExistsError,
  type CreateServerSpec,
  type Image,
  type BillingModel,
  type Labels,
  type Provider,
  type Server,
  type ServerPatch,
} from "./provider.ts";

/** In-memory provider for unit tests. `now` is injectable so age is testable. */
export class MockProvider implements Provider {
  readonly servers = new Map<string, Server>();
  readonly calls: string[] = [];
  readonly images = new Map<string, Image>();
  /** Set to make the next `createImage` fail, after the server was stopped. */
  failImageWith: Error | undefined;
  /** Set to make `deleteImage` fail. */
  failDeleteImageWith: Error | undefined;
  private nextId = 1;
  private nextImageId = 1;

  constructor(
    private readonly now: () => Date = () => new Date(),
    readonly billing: BillingModel = "per-started-hour",
  ) {}

  async createServer(spec: CreateServerSpec): Promise<Server> {
    this.calls.push(`create:${spec.name}`);
    if ([...this.servers.values()].some((s) => s.name === spec.name)) {
      throw new ServerExistsError(spec.name);
    }
    const server: Server = {
      id: String(this.nextId++),
      name: spec.name,
      labels: spec.labels,
      createdAt: this.now(),
      status: "running",
      address: `192.0.2.${this.nextId - 1}`,
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

  async updateServer(id: string, patch: ServerPatch): Promise<Server> {
    this.calls.push(`update:${id}`);
    const current = this.servers.get(id);
    if (!current) throw new Error(`no such server: ${id}`);
    if ([...this.servers.values()].some((s) => s.id !== id && s.name === patch.name)) {
      throw new ServerExistsError(patch.name);
    }
    const updated: Server = { ...current, name: patch.name, labels: patch.labels };
    this.servers.set(id, updated);
    return updated;
  }

  async createImage(serverId: string, name: string): Promise<Image> {
    this.calls.push(`createImage:${name}`);
    const current = this.servers.get(serverId);
    if (!current) throw new Error(`no such server: ${serverId}`);
    this.servers.set(serverId, { ...current, status: "off" });
    if (this.failImageWith) throw this.failImageWith;
    const image: Image = { id: `img-${this.nextImageId++}`, name, createdAt: this.now() };
    this.images.set(image.id, image);
    return image;
  }

  async listImages(namePrefix: string): Promise<readonly Image[]> {
    this.calls.push("listImages");
    return [...this.images.values()].filter((i) => i.name.startsWith(namePrefix));
  }

  async deleteImage(id: string): Promise<void> {
    this.calls.push(`deleteImage:${id}`);
    if (this.failDeleteImageWith) throw this.failDeleteImageWith;
    this.images.delete(id);
  }
}
