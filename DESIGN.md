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
3. In shared-pool mode nothing deletes the VM at the end of a run (with `run-id`
   the run's last job calls `reap/` to delete its own VM; see "One server per
   workflow run"). A scheduled workflow calls `reap/`
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
- Provider adapter with seven operations: create with labels, list by label,
  delete, and update name and labels together, plus create, list and delete images
  (used by `build-image`; Hetzner's throw). Hetzner is the first. Label values are validated against Hetzner's
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
  On a project-owned image the same script skips what the image holds; see
  "Built images".
- CI VMs never upgrade themselves: the setup script turns automatic upgrades off
  before it installs anything, and applies no updates of its own. See "No
  automatic upgrades".
- Runners registered to a personal-account repo serve only that repo, so each
  consuming repo gets its own VM and its own secrets.
- Servers are labelled `pool` and `repo`, and `vgr-run` when made for one run;
  the reaper touches only its own.
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

## One server per workflow run

Shared-pool mode (the default) has a flaw: two runs of one repo share the VM and
its runners. On 2026-10-05 two PR runs of Sia.jl used one pool; the second reused
the first's VM and waited about 15 minutes for free runners, and when one run's
teardown ran, the VM was deleted under the other's jobs.

`run-id` (`github.run_id`) on `ensure`, `reap` and `release` switches to one VM per
run:

- Identity. The run id goes into the name hash, so each run's server has its own
  name and `ensureServer` converges concurrent callers of one run (the lock) while
  separating runs. The server also gets the label `vgr-run=<id>`; `pool` and
  `repo` stay. Shared-pool `ensure` and `release` ignore servers with `vgr-run`,
  so the two modes never adopt each other's servers.
- Isolation. Default runner labels gain `run-<id>` (appended to a caller's own
  list if missing); `runs_on` returns the same labels. GitHub schedules a job only
  onto a runner that has all of its labels, so this run's jobs cannot land on
  another run's runners. The reverse needs more: a job lands on any runner whose
  labels are a superset of its own, so runners carry no labels beyond these (see
  "Runner labels").
- Teardown (`reap` with `run-id`). Only that run's server. The repo-wide
  active-runs guard is replaced by "the run's own jobs are done", which is true
  because teardown is the run's last job; the run is not counted. A busy runner
  still keeps the server (deregistration enforces it).
- Safety net (`reap` without `run-id`). A run-labelled server is kept while
  `GET /actions/runs/{id}` says the run is not completed, and deleted when it is
  completed (including cancelled) or 404, which covers runs whose teardown never
  ran. A failed lookup is an error for that server only. `max-age-minutes`
  (default off) deletes an older run-labelled server whatever its run is doing,
  deregistering what it can: the guards are what a stuck run breaks. Servers with
  no run label keep the repo-wide behaviour.
- Billing. A per-run server is never reused, so the Hetzner paid-hour window is
  skipped for it: waiting buys nothing and holds one of the 5 account slots. OVH
  was already delete-at-once. The scheduled reaper's 5-minute cadence matters less
  on Hetzner for per-run servers, since teardown deletes them directly.
- Re-runs. The attempt is not part of the identity. Attempts of one run never
  overlap, so a re-run reuses the previous attempt's server if teardown has not
  deleted it, else creates a new one under the same name (Hetzner waits out a
  server still being deleted, as in "Concurrency"). "Re-run all jobs" works.
  "Re-run failed jobs" is unsupported: GitHub skips the successful `vm` job and
  reuses its old `runs_on` output, but teardown deleted the VM, so the re-run jobs
  queue on `run-<id>` labels no runner has, and a queued job has no timeout.
- One mode per pool. A shared-mode job's labels are a subset of a per-run
  runner's, so a shared-mode workflow on the same pool could land on another run's
  runners. All workflows on a pool pass `run-id`, or none does.
- Decision to review: the Hetzner window rule was kept for shared servers but
  skipped for per-run ones (above). Keeping it would let a "Re-run all jobs" within
  the hour reuse a warm VM, at the cost of a slot of the 5-server cap.
- `release` with `run-id` hands over that run's server and skips the repo-wide
  guard; the relabel drops `vgr-run`, so nothing reaps it afterwards.
- Capacity. Concurrent runs are bounded by the project's quota, not by anything
  here. OVH US (Sia.jl's project) is 34 cores / 10 instances shared with pioneer,
  so about 3 to 4 b3-32 (8 vCPU) VMs. A refusal for quota or the server limit
  (OpenStack 403/413 "Quota exceeded", Hetzner `resource_limit_exceeded`) becomes
  `QuotaExceededError`, and `ensure` fails at once with the provider's message
  instead of retrying: waiting cannot help until another run finishes.
- The `ensure` job should not run on the pool's own runners (it could land on
  another run's VM and hold a runner there).

## Runner labels

Decided 2026-10-05, after karimn/Sia.jl runs 37350044108 and 37350552615 ran jobs
that asked only for `self-hosted` on another run's per-run VM.

- `config.sh --no-default-labels`: a runner carries exactly the configured labels,
  never GitHub's `self-hosted`, `Linux`, `X64`. With the defaults, every job in the
  repo that targets `self-hosted` matched every pool runner, and `run-<id>` only
  kept a run's jobs in; it never kept other jobs out.
- `runs_on` is exactly the registered labels; one list (`EnsureCliConfig.labels`)
  feeds both the registrar and the output, and a test drives config, the real
  registrar's script and the output together.
- Shared-pool mode drops `self-hosted` too, rather than keeping it there for
  compatibility. Keeping it would leave the same leak in that mode (a stray
  `self-hosted` job holding a pool runner, and keeping reap's busy check true).
  Breaking for callers that hard-coded `self-hosted` with the pool labels; the
  README lists what they change.
- `runner-labels` may not name a default label (case-insensitive, as GitHub
  matches), since that would undo the above.
- The flag first shipped in runner v2.305.0 (actions/runner#2443), so a pinned
  `runner-version` below that is rejected. `--replace` (repairing a runner under
  the same name) clears the agent's labels before applying the new ones, so a
  repaired runner does not regain the defaults (checked in the runner's
  `ConfigurationManager.UpdateExistingAgent` at v2.337.0).
- A server registered before this keeps its default-labelled runners until it is
  deleted, because `ensure` leaves healthy runners alone.

## GitHub token permissions

`github-token` is a fine-grained PAT on the consuming repo. The workflow's own
`GITHUB_TOKEN` cannot manage runners. Every REST call (`src/github-client.ts`) and
the permission it needs:

| Call | Used by | Permission |
|---|---|---|
| `GET /actions/runners` | ensure, reap, release | Administration: read |
| `POST /actions/runners/registration-token` | ensure | Administration: write |
| `DELETE /actions/runners/{id}` | reap, release | Administration: write |
| `GET /actions/runs?status=queued\|in_progress` | reap, release | Actions: read |
| `GET /actions/runs/{id}` | reap (scheduled, per-run servers) | Actions: read |

So the PAT needs **Administration read and write AND Actions read**. Missing
Actions read made `reap` fail on 2026-10-05 and left a billed VM running. `reap`
keeps failing loudly on a 403 (a silent skip would leave the VM billing); the error
now names the missing permission and endpoint.

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

## No automatic upgrades

Found on 2026-10-05 (karimn/Sia.jl PR #328, run 37355068734, OVH Ubuntu 24.04).
Jobs died at random with `The runner has received a shutdown signal`, from 28 s
to 29 min into a run, on every runner of the VM at once. The runners were back
within seconds, and a second wave sometimes followed. The VM's journal, captured
by the teardown job before reap deleted the VM, showed this at 18:42:16 UTC:

- `systemd[1]: Stopping actions.runner.karimn-Sia.jl.<name>-N.service` for all
  six runners, `runsvc.sh: Sending SIGINT/SIGKILL to runner listener`, then
  `Started actions.runner...` in the same second.
- In that same second rsyslog, udevd, polkit, systemd-networkd, timesyncd,
  resolved, ModemManager, packagekit and containerd all restarted. A containerd
  restart also kills job containers.
- `systemd[1]: Reexecuting requested from client PID ... ('systemctl') (unit
  apt-daily-upgrade.service)`, five `Reloading requested ... (unit
  apt-daily-upgrade.service)`, `apt.systemd.daily: /usr/bin/unattended-upgrade`,
  and more restarts through 18:42:42.

The cause is the stock image's `apt-daily-upgrade.timer`. It has
`Persistent=true` and has been overdue since the image was built, and with
`RandomizedDelaySec=60m` it fires at a random time in each fresh VM's first
hour. unattended-upgrades then re-executes systemd. needrestart (auto mode on
this image) restarts the services, the runner units included. Package postinst
scripts restart their own services too (containerd, rsyslog, udev, the
systemd-* daemons). Runs where the timer fired after the run ended passed. A
stock VM did not reproduce the kills because it had only four kernel packages
pending. A CI VM installs more, so it gets upgrades that restart services.

So the setup script's first step is to turn this off for the VM's life. It
does all of the following before it installs anything:

- It disables the timers and masks `apt-daily`, `apt-daily-upgrade` and
  `unattended-upgrades`, so no package install can enable them again.
- It sets `APT::Periodic` to `0` in a `99-` file, which sorts after the image's
  `20auto-upgrades`.
- It stops any run already queued. These units use `KillMode=process`, so a stop
  can leave `unattended-upgrade` or dpkg running. The script waits for those to
  finish rather than kill dpkg mid-install, then runs `dpkg --configure -a`.
- needrestart is set to list-only (`$nrconf{restart} = 'l'`, and
  `NEEDRESTART_MODE=l` for the script's own apt calls).

The needrestart setting is defence in depth, not the fix. It cannot stop a
package's own postinst from restarting that package's service, and containerd's
restart is enough to kill jobs. Do not "simplify" this down to the needrestart
config alone.

The script also applies no security updates up front. A CI VM lives under an
hour, accepts only key-based SSH, and runs the caller's own code. An upgrade
would add minutes to every cold start, and a kernel update would need a reboot
to take effect. Updates are applied where no job runs: `build-image` upgrades a
temporary VM once a week and snapshots it (see "Built images").

Only VMs created with this user-data are covered. A shared-pool VM created
before the change keeps its timer until it is reaped.

## Built images

Decided 2026-10-05, after PR #12 stopped CI VMs upgrading themselves. They boot
OVH's stock `Ubuntu 24.04` (built 2026-05-11, about five months of openssh,
openssl, systemd and kernel updates missing), and nothing refreshed it. Every run
also paid a cold start in `ensure` while cloud-init installed Docker and the
runner.

**Why a VM image, not a container image.** The stale part is the host (sshd,
kernel, openssl, systemd, the Docker daemon), and Nova boots disk images (kernel,
bootloader, init, cloud-init), not OCI images. A job's container image never
touches the host. So the container image goes *inside* the VM image
(`prepull-images`), which gets both. The alternative, building a bootable disk
from a Dockerfile's root filesystem on a GitHub-hosted runner and uploading it to
Glance, needs no temporary OVH server, but then this repo owns the kernel,
bootloader, cloud-init and network configuration and uploads several GB a week.
Not chosen; revisit only if the temporary server turns out to be the problem.

**The builder** (`build-image` command, `build-image/` action, `src/build-image.ts`):

1. Sweep this pool's builder servers older than 3 hours (a killed earlier build).
2. Boot a temporary server from the stock image. It is labelled `vgr-builder=<pool>`
   and deliberately has no `pool` label, so `ensure` never adopts it and `reap`
   never treats it as an idle CI server mid-build.
3. Over SSH: the bake script, which is first boot's no-auto-upgrade prologue, a full
   `apt-get dist-upgrade` (config files kept), the same provisioning first boot does
   (packages, Docker, the `runner` user, the pinned runner's binaries and
   dependencies in the template dir) and a last step that writes the marker
   `/var/lib/vm-gh-runners/baked` (`runner_version=`, `built_at=`).
4. Reboot if `/var/run/reboot-required` exists (it covers libc and systemd, not only
   the kernel), and wait for a new boot id.
5. Optionally pull `prepull-images`. The registry credential travels in the script
   on SSH stdin, is used through a throwaway `DOCKER_CONFIG`, and is never in
   user-data, a command line or the image; errors are redacted.
6. The finalize script makes clones boot as new machines: `cloud-init clean --logs
   --seed`, empty `/etc/machine-id`, SSH host keys removed (cloud-init regenerates
   them), the builder's `authorized_keys`, shell history, Docker client config, apt
   lists and the old netplan file removed. It leaves the baked marker and no
   `ready` marker: `ready` is per VM, and a stale copy would let the registrar
   trust a VM whose setup failed.
7. `createImage`: the provider stops the server (a snapshot of a running disk can
   be inconsistent), snapshots it as `vgr-<pool>-<owner>_<repo>-<yyyymmdd>` and waits until the
   image is active. A failed or never-active snapshot is deleted, so `ensure`
   cannot pick up a half-made image.
8. Only then prune: keep the newest N (default 2, minimum 2) built images of the
   pool. A failed build prunes nothing. An image that cannot be deleted fails the
   run, so growing storage is noticed.
9. Always delete the temporary server, on every path after it was created. If that
   delete fails the error is loud and keeps the build's own error. A build killed
   outright cannot clean up; its server is deleted by the next build and by `reap`
   (which runs on a schedule in the consuming repo), after 3 hours.

**`ensure`.** `image: latest-built` (OVH only; an error on Hetzner) resolves to the
id of the newest `vgr-<pool>-<owner>_<repo>-<yyyymmdd>` image of its own pool and
repo (the repo is spelled `owner_name`, as in server labels). The name must be the
prefix plus exactly eight digits, so another pool or repo whose name extends this
one's is never matched or pruned. Any other
`image` value is used as given, and nothing is listed. With no built image, or if
the lookup fails, it boots `base-image` (the stock image) and warns: a repo works
before its first build and survives a Glance outage, only slower. It also warns,
and carries on, when the newest image is older than `max-image-age-days` (default
14, which tolerates one failed weekly build): a scheduled workflow that fails or is
disabled then shows up on every CI run.

**First boot on either image.** The user-data is identical; the script decides at
boot by the baked marker. Without it, everything is installed as before. With it,
the script re-asserts the no-auto-upgrade settings (they must not depend on the
image), starts Docker, installs only caller-given `extra-packages` and a runner
version different from the baked one (a pin; `latest` means the baked one), checks
the template dir and the `runner` user exist (a damaged image fails here, not in
the registrar), and writes `ready`. Registration is unchanged and still happens
over SSH per run. A built image never applies upgrades while runners exist: the
masked timers are in the image, and first boot masks them again before anything
else; the only `dist-upgrade` is in the bake script. `test/boot-paths.test.ts`
executes both scripts against stubbed commands and checks this.

**What it saves.** From Sia.jl run 37355068734 (OVH, 6 runners, stock image): the
`ensure` step took 116 s, and "Initialize containers", which is the CI image pull
onto the fresh VM (six jobs at once, shared layers), took 31 s; run 37350552615 had
136 s and 26 s. `test/boot-paths.test.ts` runs both first-boot scripts against
stubbed commands: the stock path runs 16 commands, 7 of them installs or downloads
(`apt-get update`, `apt-get install`, `curl`, `tar`, the runner's dependency
installer, `useradd`, `usermod`); the built path runs 8 and none of those. So first
boot no longer downloads or installs anything. How much of the 116 s that is cannot
be split from the logs (the VM's creation and boot, and registering six runners over
SSH, stay), and a snapshot may boot more slowly than OVH's stock image, which
hypervisors probably cache. Estimate, not a measurement: roughly 60 to 90 s off
`ensure` and, with the CI image pre-pulled, about 25 to 30 s off the container
initialisation, so 1.5 to 2 minutes of a 17 to 20 minute run. The larger gain is
that the VM is patched at all. Only a real run measures it.

**Cost.** A weekly build is about 15 minutes of one small server (prorated), plus
the snapshots' storage: per GB-month, for two images of about the builder flavor's
disk size plus pre-pulled images. Prices are on OVH's price list and are not
restated here.

**Limits and decisions to review.**

- Images are keyed by pool and repo, like servers (decided 2026-10-05; first named
  by pool only, which would have let two repos on one pool boot and prune each
  other's images). The builder takes the repo from `GITHUB_REPOSITORY`
  (`VGR_REPO` overrides), so each repo that uses `latest-built` runs its own build.
- A snapshot's minimum disk is the builder flavor's disk, so `ensure`'s flavor must
  have at least that much.
- Minimum retention is 2: with 1, a build could delete the image a concurrent
  `ensure` has just resolved. A boot of an image being deleted at that instant can
  still fail; narrow.
- A pre-pulled image is read at build time, so the caller must pass the tag in use
  now. A tag that does not exist fails the build rather than shipping an old image.
- The bake script runs over one SSH session. A `dist-upgrade` that restarts sshd
  keeps that session; if a systemd upgrade ever drops it, the build fails and
  retries next week.
- Hetzner is not supported: its adapter throws. A snapshot adapter would be a
  small addition to `Provider`.

## Known races and limits

- Teardown must not depend on a busy queue. On 2026-10-05 the boot test's
  `teardown` job (GitHub-hosted `ubuntu-latest`) was never assigned a runner and was
  cancelled after 15 minutes while its VM kept billing; a re-run of just that job
  cleaned up. The OVH example now runs teardown on a self-hosted runner of the
  caller's own (safe, since pool runners carry no `self-hosted`), and the scheduled
  reaper remains the safety net for when no runner picks it up.

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
- A server left by a crashed run is reaped at the end of its paid hour (Hetzner) or at the next reap (OVH). A per-run server is reaped at the next scheduled reap once its run is completed.
- Per-run mode: a run that is queued behind a manual-approval gate counts as active and keeps its server until `max-age-minutes`, if set. A re-run triggered in the instant after the scheduled reaper saw its run completed but before the delete can lose its VM; narrow, and the next `ensure` creates a new one.
- The reaper (and any teardown job) must not run on one of the pool's own runners: it would be the busy
  runner that makes reap keep the server. Pool runners do not carry `self-hosted`
  (see "Runner labels"), so a plain `runs-on: self-hosted` reaper cannot land on
  one; a GitHub-hosted runner (what the OVH examples use) cannot either. A server
  registered before that change still has `self-hosted` runners until it is
  deleted.
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
  runner and its dependencies). A built image (`image: latest-built`) removes most
  of it; see "Built images".
- No firewall is set; SSH is key-only on an open port.

## Prior art

- hstern/fj-bellows: the same warm-for-the-paid-hour idea, for Forgejo Actions.
- Cyclenerd/hcloud-github-runner: one-shot ephemeral runner per workflow.

## Open

- Run `build-image` once for real, then one `ensure` on `latest-built`, and check,
  because the adapter was written from the OpenStack API reference and the fake in
  `test/ovh.test.ts`: that `listImages`, which filters on `visibility=private`,
  finds the snapshot (the strict name pattern already scopes the list, so dropping
  that filter is cheap if OVH marks snapshots differently); whether Nova's
  `createImage` answers with a `Location` header or `image_id` (both are handled);
  how long a snapshot takes to become active, against the 20 minute wait; that a
  clone boots cleanly (networking after the old netplan file is removed, root SSH,
  regenerated host keys, a new machine-id, cloud-init applying the new key and
  user-data); that the `min_disk` of the snapshot matches the flavor; and the boot
  time against the stock image.

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
