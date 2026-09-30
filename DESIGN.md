# vm-gh-runners: design

GitHub Actions only. Provider-neutral. First provider: Hetzner Cloud.

## Goal

Run a repo's CI jobs on a rented VM that is reused for the whole billing hour
already paid for, then deleted when idle. Callers change one `runs-on:` line.

Nothing here is run by hand. CI workflows call the `ensure` action, and a
scheduled workflow calls `reap`.

## How it fits together

1. A workflow's first job calls `ensure/`. It reuses the pool's server for the
   repo or creates one, then makes sure `runner-count` runners are registered on
   it. It outputs `runs_on`, the labels later jobs target.
2. Later jobs use `runs-on: ${{ fromJSON(...runs_on) }}` and run on those runners.
3. Nothing deletes the VM at the end of a run. A scheduled workflow calls `reap/`
   every 5 minutes; it deletes an idle server in the last 10 minutes of each paid
   hour. A busy server rides into the next paid hour.

## Decisions

- Name: `vm-gh-runners`. Public repo, MIT. Holds no secrets; tokens live in each
  caller's repo as Actions secrets.
- TypeScript on Bun, no build step, no runtime dependencies. Logic is unit-tested
  against mock providers; the actions are checked against the CLI by contract tests.
- Scope: reusable across repos, not across CI systems.
- Provider adapter with four operations (create with labels, list by label,
  delete, and update name and labels together). Hetzner is the first. Label values are validated against Hetzner's
  rules, so `owner/name` is stored as `owner_name`.
- Billing is per started hour, measured from server creation (Hetzner FAQ:
  "We always round up the hourly usage of a server"). The reap window is
  measured from creation, not from the last job.
- The reaper is a scheduled workflow, not a timer on the VM, so no provider
  token sits on the VM. It deregisters the runners first (GitHub refuses to
  remove a busy one, so that is the last guard), then deletes the server.
  "Idle" means no busy runner AND no other queued or in-progress run in the repo
  (a run between two jobs has no busy runner).
- Runner registration happens over SSH from the workflow after boot, not from
  cloud-init, so no GitHub token is ever in user-data (readable from inside the
  VM without authentication). The same call registers a missing runner and
  repairs a dead or partly-deregistered one. The workflow's SSH key is a
  single-purpose secret; a new host is trusted on first connect.
- First-boot setup (cloud-init) installs Docker, the runner and its
  dependencies, and writes a marker file last. The registrar requires the
  marker: cloud-init's "degraded" exit also appears when a setup script fails.
  A prebuilt snapshot is the later optimisation if cold starts hurt.
- Runners registered to a personal-account repo serve only that repo, so each
  consuming repo gets its own VM and its own secrets.
- Servers are labelled `pool` and `repo`; the reaper touches only its own.
- `release` hands a server to another owner. `reap` finds servers by label and
  `ensure` locks on the name, so deregistering the runners is not enough: the
  server is relabelled (`pool` becomes the new label, default `released`;
  `released-from` records the old pool) and renamed in one provider request. The
  new name is built from the provider id, so it is unique and is never the
  deterministic name `ensure` locks on. The order is guards, deregister, stop and
  uninstall the runner services over SSH, then relabel and rename, so that until
  the last step the server is still the pool's and every earlier failure is
  repaired by the next `ensure` or a retry. Runner services are found by
  directory on the VM, not from GitHub's list. It refuses rather than guesses
  when zero or several servers match, or the server is not running. Nothing
  deletes a released server; the new owner must, or it bills indefinitely.

## Concurrency

`ensure` must be safe when many runs call it at once, and a workflow
`concurrency:` group cannot provide that: GitHub cancels all but the newest
pending job in a group, which would fail real CI runs.

Instead the server name is deterministic (pool and repo, plus a hash so long
names stay distinct). The provider refuses a second server with the same name
(Hetzner: `409 uniqueness_error`), so of N concurrent creators exactly one
wins. The others wait and reuse the winner's server. The same path waits out a
previous server that is still being deleted and holds the name.

## Known races and limits

- A run queued in the instant after the reaper's idle check but before the delete
  finds a server with no runners; its `ensure` fails and a re-run works. Narrow,
  and the in-progress-run check makes it rare.
- If a reap deregisters some runners then fails, the server is kept and the next
  `ensure` restores the missing ones.
- A release that fails after deregistering leaves the server in the pool with
  fewer runners; the next `ensure` restores them and release can be retried. An
  `ensure` that runs between release's guards and its relabel can re-register
  runners that release then uninstalls; narrow, and the active-runs guard makes it
  rare. `force` cannot release a busy runner, since GitHub refuses to deregister it.
- A server left by a crashed run is reaped at the end of its paid hour.
- The reaper must run at least every 5 minutes. It is cheap on a self-hosted
  runner and costly on a GitHub-hosted one (about 8,600 billed minutes a month).
- Runners above the configured count are ignored, and stopping or off servers
  are not reaped.
- No firewall is set; SSH is key-only on an open port.

## Prior art

- hstern/fj-bellows: the same warm-for-the-paid-hour idea, for Forgejo Actions.
- Cyclenerd/hcloud-github-runner: one-shot ephemeral runner per workflow.

## Open

- An inverse of `release`, to hand a released server back to the pool instead of
  deleting it. The `released-from` label keeps the information needed.
- Runner count per VM and VM size (measure SiaTuring memory per group first).
- Trigger policy in the first consumer (Sia.jl): label vs every push.
- An automatic integration test against a real Hetzner project, run by CI.
