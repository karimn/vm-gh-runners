import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Factory } from "../src/cli.ts";
import { withKeyFile } from "../src/keyfile.ts";
import { MockGithub } from "../src/mock-github.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { MockRegistrar } from "../src/mock-registrar.ts";

const env = {
  GITHUB_REPOSITORY: "karimn/sia",
  VGR_POOL: "ci",
  HCLOUD_TOKEN: "hz-secret",
  VGR_GITHUB_TOKEN: "gh-secret",
  VGR_SERVER_TYPE: "cpx62",
  VGR_SSH_KEY_NAMES: "ci-key",
  VGR_SSH_PRIVATE_KEY: "KEY",
};

const setup = () => {
  const provider = new MockProvider(() => new Date());
  const github = new MockGithub();
  const registrar = new MockRegistrar(github);
  const factory: Factory = {
    ensure: async () => ({ provider, github, registrar, dispose: () => {} }),
    reap: async () => ({ provider, github, dispose: () => {} }),
  };
  const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
  const out = join(dir, "github_output");
  const lines: string[] = [];
  return { provider, github, factory, out, lines, log: (s: string) => void lines.push(s) };
};

describe("main", () => {
  test("ensure runs, logs, and writes step outputs", async () => {
    const t = setup();
    const code = await main(["ensure"], { ...env, GITHUB_OUTPUT: t.out }, t.factory, t.log);

    expect(code).toBe(0);
    expect(t.provider.servers.size).toBe(1);
    const written = readFileSync(t.out, "utf8");
    expect(written).toContain("created=true");
    expect(written).toContain("server_id=1");
    expect(t.lines.join("\n")).toContain("created");
  });

  test("reap runs and reports", async () => {
    const t = setup();
    const code = await main(["reap"], { ...env, GITHUB_OUTPUT: t.out }, t.factory, t.log);

    expect(code).toBe(0);
    expect(t.lines.join("\n")).toContain("no servers in this pool");
    expect(readFileSync(t.out, "utf8")).toContain("deleted=0");
  });

  test("works without GITHUB_OUTPUT", async () => {
    const t = setup();
    expect(await main(["reap"], env, t.factory, t.log)).toBe(0);
  });

  test("exits 2 with usage for an unknown or missing command", async () => {
    const t = setup();
    expect(await main([], env, t.factory, t.log)).toBe(2);
    expect(await main(["explode"], env, t.factory, t.log)).toBe(2);
    expect(t.lines.join("\n")).toContain("usage");
  });

  test("exits 1 and names the problem when configuration is missing, without leaking secrets", async () => {
    const t = setup();
    const { HCLOUD_TOKEN: _, ...rest } = env;
    const code = await main(["ensure"], rest, t.factory, t.log);

    expect(code).toBe(1);
    const text = t.lines.join("\n");
    expect(text).toContain("HCLOUD_TOKEN");
    for (const secret of ["gh-secret", "KEY"]) expect(text).not.toContain(secret);
  });

  test("exits 1 when a reap could not handle a server", async () => {
    const t = setup();
    // An idle server in its billing window whose runner cannot be deregistered.
    const old = new Date(Date.now() - 55 * 60_000);
    const provider = new MockProvider(() => old);
    await provider.createServer({
      name: "srv", labels: { pool: "ci", repo: "karimn_sia" },
      serverType: "t", image: "i", location: "l", userData: "",
    });
    t.github.addRunner({ id: 1, name: "srv-1", busy: false, status: "online" });
    t.github.failDeregister.add(1);
    const factory: Factory = {
      ensure: t.factory.ensure,
      reap: async () => ({ provider, github: t.github, dispose: () => {} }),
    };

    expect(await main(["reap"], env, factory, t.log)).toBe(1);
  });

  test("disposes what the factory built, even when the command throws", async () => {
    const t = setup();
    let disposed = false;
    const factory: Factory = {
      ...t.factory,
      ensure: async () => ({
        provider: { ...t.provider, createServer: () => { throw new Error("boom"); }, listServers: async () => [], deleteServer: async () => {} },
        github: t.github,
        registrar: new MockRegistrar(t.github),
        dispose: () => { disposed = true; },
      }),
    };
    expect(await main(["ensure"], env, factory, t.log)).toBe(1);
    expect(disposed).toBe(true);
  });
});

describe("withKeyFile", () => {
  test("writes the key with owner-only permissions and removes it afterwards", () => {
    const { path, dispose } = withKeyFile("SECRET-KEY\n");
    expect(readFileSync(path, "utf8")).toBe("SECRET-KEY\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    dispose();
    expect(existsSync(path)).toBe(false);
  });

  test("adds a trailing newline, which ssh requires", () => {
    const { path, dispose } = withKeyFile("NO-NEWLINE");
    expect(readFileSync(path, "utf8")).toBe("NO-NEWLINE\n");
    dispose();
  });
});
