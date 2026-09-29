import { beforeEach, describe, expect, test } from "bun:test";
import { reap } from "../src/reap.ts";
import { MockGithub } from "../src/mock-github.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { runnerName } from "../src/github.ts";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (m: number) => new Date(t0.getTime() + m * 60_000);
const cfg = { pool: "ci", repo: "karimn/sia", currentRunId: 99 };

const spec = (name: string, labels: Record<string, string>) => ({
  name,
  labels,
  serverType: "t",
  image: "i",
  location: "l",
  userData: "",
});

let provider: MockProvider;
let github: MockGithub;

const addServerWithRunners = async (name: string, busyIds: number[] = []) => {
  const s = await provider.createServer(spec(name, { pool: "ci", repo: "karimn/sia" }));
  [1, 2].forEach((n) => {
    const id = Number(s.id) * 10 + n;
    github.addRunner({
      id,
      name: runnerName(name, n),
      busy: busyIds.includes(id),
      status: "online",
    });
  });
  return s;
};

beforeEach(() => {
  provider = new MockProvider(() => t0);
  github = new MockGithub();
});

describe("reap", () => {
  test("keeps an idle server outside the reap window", async () => {
    await addServerWithRunners("srv");
    const [r] = await reap(provider, github, cfg, at(20));

    expect(r?.action).toBe("kept");
    expect(r?.reason).toBe("outside-window");
    expect(provider.servers.size).toBe(1);
    expect(github.runners.size).toBe(2);
  });

  test("deregisters runners, then deletes an idle server in the window", async () => {
    await addServerWithRunners("srv");
    // Deregistration is the guard against deleting under a running job, so the
    // runners must already be gone from GitHub when the server is deleted.
    let runnersLeftAtDelete = -1;
    const realDelete = provider.deleteServer.bind(provider);
    provider.deleteServer = async (id) => {
      runnersLeftAtDelete = github.runners.size;
      return realDelete(id);
    };

    const [r] = await reap(provider, github, cfg, at(55));

    expect(r?.action).toBe("deleted");
    expect(provider.servers.size).toBe(0);
    expect(github.runners.size).toBe(0);
    expect(runnersLeftAtDelete).toBe(0);
  });

  test("keeps a server whose runner is busy", async () => {
    await addServerWithRunners("srv", [11]);
    const [r] = await reap(provider, github, cfg, at(55));

    expect(r?.action).toBe("kept");
    expect(r?.reason).toBe("busy");
    expect(provider.servers.size).toBe(1);
    expect(github.calls.some((c) => c.startsWith("deregister:"))).toBe(false);
  });

  test("keeps a server while the repo has other active runs, excluding our own", async () => {
    await addServerWithRunners("srv");
    github.activeRuns = true;
    const [r] = await reap(provider, github, cfg, at(55));

    expect(r?.action).toBe("kept");
    expect(r?.reason).toBe("active-runs");
    expect(github.calls).toContain("hasActiveRuns:99");
  });

  test("does not ask GitHub about runs when outside the window", async () => {
    await addServerWithRunners("srv");
    await reap(provider, github, cfg, at(20));
    expect(github.calls.some((c) => c.startsWith("hasActiveRuns"))).toBe(false);
  });

  test("keeps the server if a runner cannot be deregistered", async () => {
    await addServerWithRunners("srv");
    github.failDeregister.add(11);
    const [r] = await reap(provider, github, cfg, at(55));

    expect(r?.action).toBe("error");
    expect(r?.reason).toBe("deregister-failed");
    expect(provider.servers.size).toBe(1);
  });

  test("reports a failed delete and still handles the remaining servers", async () => {
    const first = await addServerWithRunners("first");
    await addServerWithRunners("second");
    const realDelete = provider.deleteServer.bind(provider);
    provider.deleteServer = async (id) => {
      if (id === first.id) throw new Error("api down");
      return realDelete(id);
    };

    const results = await reap(provider, github, cfg, at(55));
    const byName = Object.fromEntries(results.map((x) => [x.name, x]));

    expect(byName["first"]?.action).toBe("error");
    expect(byName["first"]?.reason).toBe("delete-failed");
    expect(byName["first"]?.error).toContain("api down");
    expect(byName["second"]?.action).toBe("deleted");
  });

  test("deletes an idle server that never got any runners registered", async () => {
    await provider.createServer(spec("bare", { pool: "ci", repo: "karimn/sia" }));
    const [r] = await reap(provider, github, cfg, at(55));
    expect(r?.action).toBe("deleted");
  });

  test("judges each server on its own and leaves other pools alone", async () => {
    await addServerWithRunners("busy-one", [11]);
    await addServerWithRunners("idle-one");
    await provider.createServer(spec("elsewhere", { pool: "other", repo: "karimn/sia" }));

    const results = await reap(provider, github, cfg, at(55));
    const byName = Object.fromEntries(results.map((x) => [x.name, x.action]));

    expect(byName).toEqual({ "busy-one": "kept", "idle-one": "deleted" });
    expect([...provider.servers.values()].map((s) => s.name).sort()).toEqual(["busy-one", "elsewhere"]);
  });
});
