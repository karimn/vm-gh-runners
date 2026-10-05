# vm-gh-runners: design

GitHub Actions only. Provider-neutral. Providers: OVHcloud Public Cloud (the
default) and Hetzner Cloud (the first).

## Goal

Run a repo's CI jobs on a rented VM that is reused while it is already paid for,
then deleted when idle. On Hetzner that means the whole started hour; on OVH,
which bills by runtime, nothing is gained by waiting, so it is deleted when idle.
Callers change one `runs-on:` line.

Nothing here is run by hand. CI workflows call the `ensure` action, and a
scheduled workflow calls `reap`.

## How it fits together

1. A workflow's first job calls `ensure/`. It reuses the pool's server for the
   repo or creates one, then makes sure `runner-count` runners are registered on
   it. It outputs `runs_on`, the labels later jobs target.
2. Later jobs use `runs-on: ${{ fromJSON(...runs_on) }}` and run on those runners.
3. Nothing deletes the VM at the end of a run. A scheduled workflow calls `reap/`
   every 5 minutes. On a provider that bills per started hour it deletes an idle
   server in the last 10 minutes of each paid hour, and a busy server rides into
   the next paid hour. On a provider that bills by runtime it deletes an idle
   server at once.

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

OpenStack (OVH) does not enforce unique names, so there is no 409. The OVH
adapter instead creates, then lists the live servers with that name, and the
oldest wins (ties broken by id, since `created` has one-second resolution). A
loser deletes its own server and throws the same `ServerExistsError`, so
`ensureServer` is unchanged. A loser's server lives for seconds, which prorated
billing makes nearly free. A keypair-name lock would also be atomic but leaks
if a run crashes while holding it.

A server also exists, and is listed, before OpenStack assigns it an address. The
creator waits for one; a reuser that finds a server without one waits too,
rather than creating a second.

## OVH specifics

- Auth is an unrestricted OpenStack application credential against Keystone v3
  (OVH US: `https://auth.cloud.ovh.us/v3`, region `US-EAST-VA-1`). The adapter
  talks Keystone, Nova, Glance and Neutron over `fetch`: no dependency, no
  `openstack` CLI. Like the Hetzner token, the credential stays in the workflow;
  the VM never gets it.
- Nova wants IDs, so flavor, image and the `Ext-Net` network are resolved by name
  first. User-data is base64. `key_name` takes one key pair, and key pairs are
  per region.
- Status comes from Nova's `status` and `task_state`: a server being deleted can
  still say ACTIVE. ERROR servers are their own state; ensure never reuses them
  and reap deletes them, since they bill.
- `release` needs two calls (rename, then replace metadata) where Hetzner takes
  one. The rename goes first, so a failure in between leaves a server that is
  still the pool's and release can be retried.
- OVH's Ubuntu image logs in as `ubuntu` and gives root's key a "log in as ubuntu"
  stub. The registrar connects as root, so the cloud-config sets
  `disable_root: false`. That is a no-op on Hetzner.
- The default image is `Ubuntu 24.04`, not `Debian 12 - Docker`: the latter ships
  docker-ce, and the setup script's `apt install docker.io` would conflict.

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
- A server left by a crashed run is reaped at the end of its paid hour (Hetzner) or at the next reap (OVH).
- The reaper (and any teardown job) must not run on one of the pool's own runners: it would be the busy
  runner that makes reap keep the server. Pool runners are `self-hosted` like any
  other, so its `runs-on` needs a label only non-pool runners have, or a
  GitHub-hosted runner (what the OVH examples use).
- On Hetzner the reaper must run at least every 5 minutes, or a VM is billed a
  second hour. It is cheap on a self-hosted runner and costly on a GitHub-hosted
  one (about 8,600 billed minutes a month). On OVH it is only a safety net behind
  the workflow's teardown job, so every 30 minutes on a GitHub-hosted runner is
  enough (about 1,500 billed minutes a month).
- Runners above the configured count are ignored, and stopping or off servers
  are not reaped. An off OVH server still bills; delete it by hand.
- OVH: a creator whose request was stamped earlier but committed later than a
  rival's list could also win, leaving two servers with one name; the reaper
  deletes the spare once idle.
- OVH: a prorated idle server is deleted at the next reap, so a run that starts a
  few minutes after the last one pays a cold start (cloud-init: Docker, the
  runner and its dependencies). A prebuilt image is the optimisation.
- No firewall is set; SSH is key-only on an open port.

## Prior art

- hstern/fj-bellows: the same warm-for-the-paid-hour idea, for Forgejo Actions.
- Cyclenerd/hcloud-github-runner: one-shot ephemeral runner per workflow.

## Open

- Run the OVH adapter against a real project and check, in this order: that the
  root login works with `disable_root: false`; that the response shapes match
  the fake in `test/ovh.test.ts` (written from the OpenStack API reference, not
  captured from OVH); that a server's `created` does not change between the
  create call and ACTIVE (arbitration sorts by it, so a creator that saw a
  different value than its rival would let both win); that the flavor, `Ubuntu 24.04` image and `Ext-Net`
  network resolve by those names; that concurrent `ensure` calls converge on one
  server; that billing really is prorated.
- An inverse of `release`, to hand a released server back to the pool instead of
  deleting it. The `released-from` label keeps the information needed.
- Runner count per VM and VM size (measure SiaTuring memory per group first).
- Trigger policy in the first consumer (Sia.jl): label vs every push.
- An automatic integration test against a real Hetzner project, run by CI.
