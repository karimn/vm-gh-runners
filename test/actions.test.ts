import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runEnsure, runReap, runRelease } from "../src/commands.ts";
import type { EnsureCliConfig } from "../src/config.ts";
import { MockGithub } from "../src/mock-github.ts";
import { MockProvider } from "../src/mock-provider.ts";
import { MockRegistrar } from "../src/mock-registrar.ts";

const root = join(import.meta.dir, "..");

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
}
interface Action {
  runs: { using: string; steps: Step[] };
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, { value: string }>;
}

const load = (dir: string): Action =>
  Bun.YAML.parse(readFileSync(join(root, dir, "action.yml"), "utf8")) as Action;

const cliStep = (a: Action): Step => a.runs.steps.find((s) => s.id === "cli")!;

const configSource = readFileSync(join(root, "src/config.ts"), "utf8");
const cliSource = readFileSync(join(root, "src/cli.ts"), "utf8");

const ensureCfg: EnsureCliConfig = {
  repo: "karimn/sia", pool: "ci", provider: { kind: "hetzner", token: "x" }, githubToken: "x", serverType: "t",
  image: "i", location: "l", runnerCount: 1, labels: ["a"], runnerVersion: "latest",
  extraPackages: [], sshKeyNames: ["k"], sshPrivateKey: "k",
};

describe.each(["ensure", "reap", "release"])("%s/action.yml", (dir) => {
  const action = load(dir);

  test("is a composite action", () => {
    expect(action.runs.using).toBe("composite");
  });

  test("gives every run step a shell", () => {
    for (const s of action.runs.steps.filter((s) => s.run)) expect(s.shell).toBe("bash");
  });

  test("has no ${{ }} in any description or name", () => {
    // GitHub evaluates expressions inside action metadata, and only a few
    // contexts exist there. A literal example such as `${{ needs.x }}` in a
    // description made the whole action fail to load (issue #2). Describe it in
    // words instead.
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        const here = `${path}.${key}`;
        if ((key === "description" || key === "name") && typeof value === "string" && value.includes("${{")) {
          offenders.push(here);
        }
        walk(value, here);
      }
    };
    walk(Bun.YAML.parse(readFileSync(join(root, dir, "action.yml"), "utf8")), dir);
    expect(offenders).toEqual([]);
  });

  test("never interpolates inputs or secrets into a shell script", () => {
    // ${{ }} in `run:` is pasted into the script before bash parses it, so a
    // crafted input could run commands. Values go through `env:` instead.
    for (const s of action.runs.steps.filter((s) => s.run)) {
      expect(s.run).not.toMatch(/\$\{\{\s*(inputs|secrets|github\.event)/);
    }
  });

  test("passes only environment variables the CLI actually reads", () => {
    for (const name of Object.keys(cliStep(action).env ?? {})) {
      const known = configSource.includes(`"${name}"`) || cliSource.includes(name) || name === "ACTION_PATH";
      expect(known).toBe(true);
    }
  });

  test("maps every environment variable from a declared input", () => {
    for (const [name, value] of Object.entries(cliStep(action).env ?? {})) {
      const m = /^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/.exec(value);
      if (m) expect(Object.keys(action.inputs)).toContain(m[1]!);
      else expect(name).toBe("ACTION_PATH");
    }
  });

  test("points at a CLI file that exists", () => {
    expect(cliStep(action).run).toContain("$ACTION_PATH/../src/cli.ts");
    expect(existsSync(join(root, dir, "../src/cli.ts"))).toBe(true);
  });
});

describe.each(["ensure", "reap", "release"])("%s provider inputs", (dir) => {
  const action = load(dir);
  const env = cliStep(action).env ?? {};

  test("selects the provider, and defaults to hetzner by leaving it unset", () => {
    expect(env["VGR_PROVIDER"]).toBe("${{ inputs.provider }}");
    expect(action.inputs["provider"]?.required).not.toBe(true);
    expect(action.inputs["provider"]?.default).toBeUndefined();
  });

  test("leaves every credential optional, because only one provider's is used", () => {
    for (const i of ["hcloud-token", "ovh-application-credential-id", "ovh-application-credential-secret", "ovh-auth-url"]) {
      expect(action.inputs[i]).toBeDefined();
      expect(action.inputs[i]?.required).not.toBe(true);
      expect(action.inputs[i]?.default).toBeUndefined();
    }
  });

  test("passes the OVH credential under the OpenStack names the CLI reads", () => {
    expect(env["OS_APPLICATION_CREDENTIAL_ID"]).toBe("${{ inputs.ovh-application-credential-id }}");
    expect(env["OS_APPLICATION_CREDENTIAL_SECRET"]).toBe("${{ inputs.ovh-application-credential-secret }}");
    expect(env["OS_AUTH_URL"]).toBe("${{ inputs.ovh-auth-url }}");
    expect(env["HCLOUD_TOKEN"]).toBe("${{ inputs.hcloud-token }}");
  });

  test("takes the region from the location input, which reap and release need too", () => {
    expect(env["VGR_LOCATION"]).toBe("${{ inputs.location }}");
    expect(action.inputs["location"]?.required).not.toBe(true);
  });
});

describe("ensure inputs and env", () => {
  const action = load("ensure");
  const env = cliStep(action).env ?? {};

  test("supplies everything the CLI requires", () => {
    for (const name of [
      "VGR_GITHUB_TOKEN", "VGR_POOL", "VGR_SERVER_TYPE",
      "VGR_SSH_KEY_NAMES", "VGR_SSH_PRIVATE_KEY",
    ]) {
      expect(Object.keys(env)).toContain(name);
    }
  });

  test("marks the required inputs required", () => {
    for (const i of ["pool", "server-type", "ssh-key-names", "ssh-private-key", "github-token"]) {
      expect(action.inputs[i]?.required).toBe(true);
    }
  });

  test("leaves optional inputs without a default, so the CLI's own defaults apply", () => {
    for (const i of ["runner-count", "image", "location", "runner-labels", "runner-version", "extra-packages"]) {
      expect(action.inputs[i]).toBeDefined();
      expect(action.inputs[i]?.required).not.toBe(true);
      expect(action.inputs[i]?.default).toBeUndefined();
    }
  });

  test("exposes exactly the outputs the command produces", async () => {
    const github = new MockGithub();
    const { outputs } = await runEnsure(
      { provider: new MockProvider(), github, registrar: new MockRegistrar(github) },
      ensureCfg,
    );
    expect(Object.keys(action.outputs).sort()).toEqual(Object.keys(outputs).sort());
    for (const [name, { value }] of Object.entries(action.outputs)) {
      expect(value).toBe(`\${{ steps.cli.outputs.${name} }}`);
    }
  });
});

describe("reap inputs and env", () => {
  const action = load("reap");
  const env = cliStep(action).env ?? {};

  test("supplies everything the CLI requires", () => {
    for (const name of ["VGR_GITHUB_TOKEN", "VGR_POOL"]) {
      expect(Object.keys(env)).toContain(name);
    }
  });

  test("marks the required inputs required", () => {
    for (const i of ["pool", "github-token"]) {
      expect(action.inputs[i]?.required).toBe(true);
    }
  });

  test("exposes exactly the outputs the command produces", async () => {
    const { outputs } = await runReap(
      { provider: new MockProvider(), github: new MockGithub() },
      { repo: "karimn/sia", pool: "ci", provider: { kind: "hetzner", token: "x" }, githubToken: "x" },
    );
    expect(Object.keys(action.outputs).sort()).toEqual(Object.keys(outputs).sort());
    for (const [name, { value }] of Object.entries(action.outputs)) {
      expect(value).toBe(`\${{ steps.cli.outputs.${name} }}`);
    }
  });
});

describe("release inputs and env", () => {
  const action = load("release");
  const env = cliStep(action).env ?? {};

  test("supplies everything the CLI requires", () => {
    for (const name of ["VGR_GITHUB_TOKEN", "VGR_POOL", "VGR_SSH_PRIVATE_KEY"]) {
      expect(Object.keys(env)).toContain(name);
    }
  });

  test("marks the required inputs required, and the optional ones without a default", () => {
    for (const i of ["pool", "github-token", "ssh-private-key"]) {
      expect(action.inputs[i]?.required).toBe(true);
    }
    for (const i of ["new-pool-label", "force"]) {
      expect(action.inputs[i]).toBeDefined();
      expect(action.inputs[i]?.required).not.toBe(true);
      expect(action.inputs[i]?.default).toBeUndefined();
    }
  });

  test("says in the output descriptions that billing continues", () => {
    expect(JSON.stringify(action)).toMatch(/billing/i);
  });

  test("exposes exactly the outputs the command produces", async () => {
    const provider = new MockProvider();
    const github = new MockGithub();
    await provider.createServer({
      name: "s", labels: { pool: "ci", repo: "karimn_sia" }, serverType: "t", image: "i", location: "l", userData: "",
    });
    const { outputs } = await runRelease(
      { provider, github, registrar: new MockRegistrar(github) },
      { repo: "karimn/sia", pool: "ci", provider: { kind: "hetzner", token: "x" }, githubToken: "x", sshPrivateKey: "k", newPoolLabel: "released", force: false },
    );
    expect(Object.keys(action.outputs).sort()).toEqual(Object.keys(outputs).sort());
    for (const [name, { value }] of Object.entries(action.outputs)) {
      expect(value).toBe(`\${{ steps.cli.outputs.${name} }}`);
    }
  });
});

describe.each([
  ["examples/use-in-a-workflow.yml", "ensure"],
  ["examples/reaper.yml", "reap"],
  ["examples/use-in-a-workflow-ovh.yml", "ensure"],
  ["examples/reaper-ovh.yml", "reap"],
  ["examples/release.yml", "release"],
])("%s", (file, actionDir) => {
  const workflow = Bun.YAML.parse(readFileSync(join(root, file), "utf8")) as {
    jobs: Record<string, { steps?: { uses?: string; with?: Record<string, string> }[] }>;
  };
  const step = Object.values(workflow.jobs)
    .flatMap((j) => j.steps ?? [])
    .find((s) => s.uses?.startsWith(`karimn/vm-gh-runners/${actionDir}@`));
  const action = load(actionDir);

  test("calls the action", () => {
    expect(step).toBeDefined();
  });

  test("passes only inputs the action declares, and every required one", () => {
    const given = Object.keys(step?.with ?? {});
    for (const g of given) expect(Object.keys(action.inputs)).toContain(g);
    for (const [name, def] of Object.entries(action.inputs)) {
      if (def.required) expect(given).toContain(name);
    }
  });

  test("takes every token and key from a secret, never inline", () => {
    for (const i of ["hcloud-token", "ovh-application-credential-id", "ovh-application-credential-secret", "github-token", "ssh-private-key"]) {
      const v = step?.with?.[i];
      if (v !== undefined) expect(v).toMatch(/^\$\{\{\s*secrets\.\w+\s*\}\}$/);
    }
  });
});
