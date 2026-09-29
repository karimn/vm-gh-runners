# vm-gh-runners: design

GitHub Actions only. Provider-neutral. First provider: Hetzner Cloud.

## Goal

Run a repo's CI jobs on a rented VM that is reused for the whole billing hour
already paid for, then deleted when idle. Callers change one `runs-on:` line.

## Decisions so far

- Name: `vm-gh-runners`. Public repo. Holds no secrets; tokens live in each caller's repo.
- TypeScript on Bun. Unit-tested logic against a mock provider.
- Scope: reusable across repos, not across CI systems.
- Provider adapter with three operations: create server with labels, list by
  label, delete. Hetzner is the first adapter.
- Billing is per started hour, measured from server creation (Hetzner FAQ:
  "We always round up the hourly usage of a server"). Idle check at ~50 min
  past each hour boundary since creation, not since last job.
- Reaper is a scheduled workflow on a GitHub-hosted runner, not a timer on the
  VM, so no provider token sits on the VM and it works with the laptop off.
- Reaper deregisters the runner first, then deletes the server.
- `ensure` job checks for an existing labelled server before creating one; a
  `concurrency:` group stops two runs both creating one.
- N persistent runners per VM (config value, default to be sized from measured
  memory), one shared label.
- Runners registered to a personal-account repo can only serve that repo, so
  each consuming repo gets its own VM and its own secrets.
- Servers are labelled `pool` and `repo` so the reaper touches only its own.

## Prior art

- hstern/fj-bellows: the same warm-for-the-paid-hour idea, for Forgejo Actions.
- Cyclenerd/hcloud-github-runner: one-shot ephemeral runner per workflow.

## Open

- Runner count per VM and VM size (measure SiaTuring memory per group first).
- Trigger policy in the first consumer (Sia.jl): label/manual vs every push.
