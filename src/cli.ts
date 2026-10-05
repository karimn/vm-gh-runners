import { appendFileSync } from "node:fs";
import {
  formatReapResults,
  runEnsure,
  runReap,
  runRelease,
  toGithubOutput,
  type EnsureDeps,
  type Outputs,
  type ReapDeps,
  type ReleaseDeps,
} from "./commands.ts";
import {
  loadEnsureConfig,
  loadReapConfig,
  loadReleaseConfig,
  type Env,
  type EnsureCliConfig,
  type ReapCliConfig,
  type ReleaseCliConfig,
} from "./config.ts";
import { GithubClient } from "./github-client.ts";
import { withKeyFile } from "./keyfile.ts";
import { createProvider } from "./providers.ts";
import { SshRegistrar } from "./ssh-registrar.ts";
import { SystemSsh } from "./ssh.ts";

export interface EnsureRuntime extends EnsureDeps {
  dispose(): void;
}
export interface ReapRuntime extends ReapDeps {
  dispose(): void;
}

export interface ReleaseRuntime extends ReleaseDeps {
  dispose(): void;
}

/** Builds the real dependencies for a command. Tests substitute mocks. */
export interface Factory {
  ensure(cfg: EnsureCliConfig): Promise<EnsureRuntime>;
  reap(cfg: ReapCliConfig): Promise<ReapRuntime>;
  release(cfg: ReleaseCliConfig): Promise<ReleaseRuntime>;
}

export const realFactory: Factory = {
  async ensure(cfg) {
    const key = withKeyFile(cfg.sshPrivateKey);
    const github = new GithubClient({ repo: cfg.repo, token: cfg.githubToken });
    return {
      provider: createProvider(cfg.provider, { sshKeys: cfg.sshKeyNames }),
      github,
      registrar: new SshRegistrar({
        github,
        repo: cfg.repo,
        ssh: new SystemSsh({ keyPath: key.path }),
        labels: cfg.labels,
      }),
      dispose: key.dispose,
    };
  },
  async reap(cfg) {
    return {
      provider: createProvider(cfg.provider),
      github: new GithubClient({ repo: cfg.repo, token: cfg.githubToken }),
      dispose: () => {},
    };
  },
  async release(cfg) {
    const key = withKeyFile(cfg.sshPrivateKey);
    const github = new GithubClient({ repo: cfg.repo, token: cfg.githubToken });
    return {
      provider: createProvider(cfg.provider),
      github,
      // Only `uninstall` is used, which needs neither the token source nor labels.
      registrar: new SshRegistrar({ github, repo: cfg.repo, ssh: new SystemSsh({ keyPath: key.path }) }),
      dispose: key.dispose,
    };
  },
};

const USAGE = "usage: cli.ts <ensure|reap|release>   (configured through VGR_* environment variables)";

const writeOutputs = (env: Env, outputs: Outputs): void => {
  // GitHub Actions supplies this path; outside Actions there is nothing to write.
  if (env["GITHUB_OUTPUT"]) appendFileSync(env["GITHUB_OUTPUT"], toGithubOutput(outputs));
};

/** Returns the process exit code: 0 ok, 1 failure, 2 usage. */
export const main = async (
  argv: readonly string[],
  env: Env,
  factory: Factory = realFactory,
  log: (line: string) => void = console.log,
): Promise<number> => {
  const command = argv[0];
  if (command !== "ensure" && command !== "reap" && command !== "release") {
    log(USAGE);
    return 2;
  }

  try {
    if (command === "ensure") {
      const cfg = loadEnsureConfig(env);
      const rt = await factory.ensure(cfg);
      try {
        const { outputs, summary } = await runEnsure(rt, cfg);
        log(summary);
        writeOutputs(env, outputs);
        return 0;
      } finally {
        rt.dispose();
      }
    }

    if (command === "release") {
      const cfg = loadReleaseConfig(env);
      const rt = await factory.release(cfg);
      try {
        const { outputs, summary, failed } = await runRelease(rt, cfg);
        log(summary);
        writeOutputs(env, outputs);
        return failed ? 1 : 0;
      } finally {
        rt.dispose();
      }
    }

    const cfg = loadReapConfig(env);
    const rt = await factory.reap(cfg);
    try {
      const { results, outputs, failed } = await runReap(rt, cfg);
      log(formatReapResults(results));
      writeOutputs(env, outputs);
      return failed ? 1 : 0;
    } finally {
      rt.dispose();
    }
  } catch (e) {
    // Only the message is printed: config errors name a variable, and the API
    // clients keep tokens out of theirs.
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
};

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env));
}
