# vm-gh-runners

Run GitHub Actions jobs on a rented VM that is reused while it is paid for, and
deleted when it goes idle. Callers change one `runs-on:` line. Providers: Hetzner
Cloud and OVHcloud Public Cloud (the default).

Status: early. Unit-tested against mocks and fake HTTP; not yet run against a
real Hetzner or OVH project. See [DESIGN.md](DESIGN.md) for how it works and why.

## Use it

Four composite actions, called from CI workflows:

- [`ensure/`](ensure/action.yml) reuses or creates the pool's VM and registers its
  runners. Use its `runs_on` output as the labels of the jobs that should run there.
  [OVH example](examples/use-in-a-workflow-ovh.yml) (with a teardown job that
  deletes the VM as soon as the tests finish),
  [Hetzner example](examples/use-in-a-workflow.yml).
- [`reap/`](reap/action.yml) deletes idle VMs (or, with `run-id`, one run's VM): in the last minutes of their paid
  hour on Hetzner, at once on OVH (see [Providers](#providers)). Run it on a
  schedule, at least every 5 minutes. [OVH example](examples/reaper-ovh.yml),
  [Hetzner example](examples/reaper.yml).
- [`release/`](release/action.yml) hands the pool's VM to someone else once CI is
  done with it: it deregisters the runners, removes their services, and relabels
  and renames the VM so `reap` and `ensure` no longer see it. **Billing continues
  and nothing in this repo deletes the VM afterwards**; the new owner has to.
  Run it by hand, from a runner outside the pool. It refuses while a runner is
  busy or other runs are active (`force` skips those checks; GitHub still will not
  remove a busy runner). It needs the same SSH key as `ensure`.
  [Example](examples/release.yml).

- [`build-image/`](build-image/action.yml) (OVH only) builds the image `ensure`
  boots when given `image: latest-built`; see [Built images](#built-images).
  [Example](examples/build-image-ovh.yml): a weekly schedule.

## Built images

A CI VM never upgrades itself, so the stock `Ubuntu 24.04` image it boots goes
stale, and every run also pays a cold start installing Docker and the runner. The
`build-image` action fixes both: it boots a temporary VM from the stock image,
applies a full `apt-get dist-upgrade` (rebooting if required), installs Docker and
the runner, optionally pre-pulls your CI container images, cleans the machine
identity, snapshots it as `vgr-<pool>-<owner>_<repo>-<yyyymmdd>`, deletes the temporary VM, and
keeps only the newest 2 images. `ensure` with `image: latest-built` then boots the
newest one, skips what is already in it, and still registers the run's runners.
With no built image yet it falls back to the stock image and the full setup, and
warns.

To wire it up in a consuming repo:

1. Copy [`examples/build-image-ovh.yml`](examples/build-image-ovh.yml) into
   `.github/workflows/`. It runs every Monday and can be run by hand. The secrets
   are the ones the CI workflow already has; add a read-only registry token only
   if a pre-pulled image is private.
2. Run it once by hand (Actions, Run workflow) to make the first image.
3. Add `image: latest-built` to the `ensure` step. Keep the `reap` schedule: it
   also deletes a build's temporary VM if the build was killed.

Nothing has to be remembered: the cron runs it, and `ensure` warns on every run
once the newest image is older than `max-image-age-days` (default 14), so a
failing or disabled schedule is visible in the logs you already read. GitHub emails
only whoever last edited the cron line when a scheduled run fails, and disables
schedules in a public repo after 60 days without repository activity.

Cost: about 15 minutes of one small OVH VM a week, billed by runtime, plus the
snapshots' storage (per GB-month, two images of about the builder flavor's disk
size). What it saves per run is estimated in DESIGN.md "Built images".

Limits to know:

- An image belongs to a pool and a repo, like a server, so repos sharing a pool keep
  and prune their own. Run `build-image` from each repo that uses `latest-built`.
- The builder's `server-type` must have a root disk no larger than `ensure`'s.
- A pre-pulled image is read at build time: pass the tag in use now, not a literal
  that goes stale.
- Hetzner cannot build images; `latest-built` is an error there.

## Runner labels (breaking change, 2026-10-05)

Runners are registered with `config.sh --no-default-labels`, so they carry **only**
the labels below, not GitHub's defaults `self-hosted`, `Linux` and `X64`:

| Mode | Runner labels = `runs_on` |
| --- | --- |
| shared pool (no `run-id`) | `vm-gh-runners`, `pool-<pool>` |
| per run (`run-id`) | `vm-gh-runners`, `pool-<pool>`, `run-<id>` |

(`runner-labels` replaces the first two, and `run-<id>` is still appended.)

Before, any job in the repo with `runs-on: self-hosted`, whichever workflow or
run it belonged to, could be scheduled on a pool VM, including another run's
private per-run VM. It then held a runner the owning run needed, was killed when
the owner's teardown deleted the VM, and kept `reap`'s busy check true. Now only a
job that asks for the pool's labels can land there, in both modes.

What callers must change:

- Use `fromJSON(needs.<job>.outputs.runs_on)` for jobs meant for the VM. A
  hard-coded `runs-on: [self-hosted, vm-gh-runners, ...]` no longer matches
  anything; drop `self-hosted` from it.
- A job with plain `runs-on: self-hosted` now runs only on your other self-hosted
  runners, never on a pool VM. If it used to rely on landing on the VM, give it
  `runs_on`.
- `runner-labels` may not include `self-hosted`, `linux` or `x64` (in any case):
  that would reopen the VMs to every self-hosted job. A pinned `runner-version`
  must be 2.305.0 or later, the first runner with `--no-default-labels`.
- A shared-pool VM that already exists keeps its old runners, and their default
  labels, until it is deleted: `ensure` does not re-register healthy runners. Let
  `reap` delete it (or delete it by hand) after upgrading. Per-run VMs are created
  fresh for each run and need nothing.

## One VM per run, or one shared VM

By default every run of a repo shares the pool's one VM, and its jobs share the
VM's runners. Runs then overlap: a second run's jobs queue behind the first's,
and a teardown or reap triggered by one run can delete the VM while the other is
still using it.

Give `ensure` the run's id and each workflow run gets **its own VM**:

```yaml
- uses: karimn/vm-gh-runners/ensure@main
  with:
    pool: ci
    run-id: ${{ github.run_id }}
    # ...
```

- The run id is part of the server's identity, so two runs never get the same
  server, and is recorded on it as the `vgr-run` label. The `pool` label stays, so
  a scheduled reaper over the pool still finds every per-run VM.
- Runner labels become `vm-gh-runners,pool-<pool>,run-<id>` (`run-<id>` is added to
  a `runner-labels` list you give, if missing), and `runs_on` returns exactly
  those, so a job can only land on its own run's runners.
- `reap` with the same `run-id`, in the run's last job (`needs:` every job that
  uses the VM, `if: always()`), deletes just that run's VM as soon as no runner on
  it is busy. It does not look at other runs, and does not count its own as active.
  See the [OVH example](examples/use-in-a-workflow-ovh.yml).
- `reap` without `run-id`, on a schedule, is the safety net for a run that never
  reached teardown (cancelled, crashed): a per-run VM is kept while its run is
  queued or in progress and deleted once it is finished or gone. Optional
  `max-age-minutes` deletes a per-run VM that old regardless, even with a busy
  runner, so a stuck run cannot hold a VM forever. Shared-pool VMs are reaped as
  before.
- `release` takes `run-id` too, to hand over that run's VM.
- A re-run of a run (same id, higher `run_attempt`) reuses the previous attempt's
  VM if teardown has not deleted it, and otherwise creates a new one under the
  same name. Attempts never overlap, so attempt is not part of the identity.
  **"Re-run all jobs" works. "Re-run failed jobs" does not**: GitHub skips the
  already-successful `vm` job and reuses its old `runs_on` output, but teardown
  deleted that VM, so the re-run jobs wait for runners labelled `run-<id>` that no
  longer exist (a queued job is not bound by `timeout-minutes`; cancel it and use
  "Re-run all jobs").
- **One mode per pool.** A shared-mode job's labels (`vm-gh-runners`,
  `pool-<pool>`) are a subset of a per-run runner's, so a shared-mode workflow on
  the same pool can land on another run's runners. Every workflow that uses a pool
  must pass `run-id`, or none.
- With `run-id` unset everything behaves as before.
- On Hetzner the paid-hour window does not apply to per-run VMs: nothing will ever
  reuse one, so waiting out the hour buys nothing and would hold one of the
  account's five server slots. (The cost: a "Re-run all jobs" within the hour
  creates a new VM instead of reusing the warm one.)

**Capacity.** Each in-flight run holds a VM. A b3-32 is 8 vCPU; the Sia.jl OVH US
project's quota is 34 cores / 10 instances, shared with pioneer, so about 3 to 4
per-run VMs fit at once (a fresh US project showed 3 servers / 6 vCPU, so check the
quota first). When the project is out of quota or server slots `ensure` fails at
once with a message naming it, rather than waiting; re-run the workflow when
another run has finished. Hetzner accounts are capped at 5 servers.

Each consuming repo needs three kinds of Actions secret: the cloud credential
(a Hetzner project token, or an OVH application credential id and secret), a
fine-grained PAT on that repo with Administration read and write and Actions
read (the workflow's
own `GITHUB_TOKEN` cannot manage runners), and an SSH private key whose public
half is uploaded to the cloud project. The example files list them.

## Providers

Pick one with the `provider` input of `ensure`, `reap` and `release`: `ovh` (the
default) or `hetzner`. **A workflow written for Hetzner before OVH existed must
now add `provider: hetzner`**, or it fails asking for an OVH credential. Give the
same `provider` (and, on OVH, `location`) to all three.

| | OVH (default) | Hetzner |
| --- | --- | --- |
| Credential | `ovh-application-credential-id` and `-secret` | `hcloud-token` |
| `server-type` | flavor, e.g. `b3-32` | server type, e.g. `cpx62` |
| `location` | region, `US-EAST-VA-1` (default) | `nbg1` (default) |
| `image` | `Ubuntu 24.04` (default), or `latest-built` | `ubuntu-24.04` (default) |
| `ssh-key-names` | exactly one key pair, in the region | one or more keys in the project |
| Billing | by runtime, so an idle VM is deleted at once | per started hour, so an idle VM is deleted in the last minutes of the paid hour |

OVH setup, once per project (the same steps as pioneer's `OVH_SETUP.md`):

1. In the Public Cloud project, create an application credential as
   *unrestricted* (a restricted one cannot create servers) and keep its id and
   secret. `ovh-auth-url` defaults to the OVH US Keystone,
   `https://auth.cloud.ovh.us/v3`; an EU account sets
   `https://auth.cloud.ovh.net/v3` and an EU region such as `GRA11`.
2. Upload the CI public key as a key pair in the same region
   (`openstack keypair create --public-key ci.pub ci-key`), and use that name as
   `ssh-key-names`. Key pairs are per region.
3. Check the project's quota for the region before sizing the pool.

On OVH `window-start-minute` does not apply and setting it is an error.

CI VMs never upgrade themselves: first-boot setup turns off unattended-upgrades
and stops needrestart from restarting services, because a mid-run upgrade
restarted every runner and killed the jobs on it. See DESIGN.md "No automatic
upgrades". Updates are applied by `build-image` instead, on a VM that runs no jobs.

Until there is a release tag, reference the actions as `@main`; pin to a commit
SHA if you want them not to change under you.

## Layout

- `ensure/`, `reap/`, `release/`, `build-image/`: the composite actions.
- `src/cli.ts`: the entry point they run, configured through environment variables.
- `src/provider.ts`: the provider interface and billing model. `src/hetzner.ts` and
  `src/ovh.ts` are the adapters; `src/providers.ts` picks one from the config.
- `src/ensure.ts`, `src/reap.ts`, `src/release.ts`: the operations.
- `src/billing.ts`: when an idle server is deleted, given how the provider bills.
- `src/github-client.ts`: the GitHub REST calls for runners and runs.
- `src/ssh-registrar.ts`, `src/userdata.ts`: runner setup on the VM, and the
  bake, clean and first-boot scripts.
- `src/build-image.ts`, `src/images.ts`: the image builder, and image naming,
  resolution and pruning.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
```
