# vm-gh-runners

Run GitHub Actions jobs on a rented VM that is reused for the billing hour you
already paid for, and deleted when it goes idle. Callers change one `runs-on:` line.

Status: early. Unit-tested against mocks; not yet run against a real Hetzner
project. See [DESIGN.md](DESIGN.md) for how it works and why.

## Use it

Two composite actions, both called from CI workflows:

- [`ensure/`](ensure/action.yml) reuses or creates the pool's VM and registers its
  runners. Use its `runs_on` output as the labels of the jobs that should run there.
  [Example](examples/use-in-a-workflow.yml).
- [`reap/`](reap/action.yml) deletes idle VMs in the last minutes of their paid
  hour. Run it on a schedule, at least every 5 minutes.
  [Example](examples/reaper.yml).

Each consuming repo needs three Actions secrets: a Hetzner project token, a
fine-grained PAT with Administration read and write on that repo (the workflow's
own `GITHUB_TOKEN` cannot manage runners), and an SSH private key whose public
half is uploaded to the Hetzner project. The example files list them.

Until there is a release tag, reference the actions as `@main`; pin to a commit
SHA if you want them not to change under you.

## Layout

- `ensure/`, `reap/`: the composite actions.
- `src/cli.ts`: the entry point they run, configured through environment variables.
- `src/provider.ts`: the provider interface. `src/hetzner.ts` is the Hetzner adapter.
- `src/ensure.ts`, `src/reap.ts`: the two operations.
- `src/billing.ts`: when an idle server is deleted.
- `src/github-client.ts`: the GitHub REST calls for runners and runs.
- `src/ssh-registrar.ts`, `src/userdata.ts`: runner setup on the VM.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
```
