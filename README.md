# vm-gh-runners

Run GitHub Actions jobs on a rented VM that is reused while it is paid for, and
deleted when it goes idle. Callers change one `runs-on:` line. Providers: Hetzner
Cloud (the default) and OVHcloud Public Cloud.

Status: early. Unit-tested against mocks and fake HTTP; not yet run against a
real Hetzner or OVH project. See [DESIGN.md](DESIGN.md) for how it works and why.

## Use it

Three composite actions, called from CI workflows:

- [`ensure/`](ensure/action.yml) reuses or creates the pool's VM and registers its
  runners. Use its `runs_on` output as the labels of the jobs that should run there.
  [Hetzner example](examples/use-in-a-workflow.yml),
  [OVH example](examples/use-in-a-workflow-ovh.yml).
- [`reap/`](reap/action.yml) deletes idle VMs: in the last minutes of their paid
  hour on Hetzner, at once on OVH (see [Providers](#providers)). Run it on a
  schedule, at least every 5 minutes. [Hetzner example](examples/reaper.yml),
  [OVH example](examples/reaper-ovh.yml).
- [`release/`](release/action.yml) hands the pool's VM to someone else once CI is
  done with it: it deregisters the runners, removes their services, and relabels
  and renames the VM so `reap` and `ensure` no longer see it. **Billing continues
  and nothing in this repo deletes the VM afterwards**; the new owner has to.
  Run it by hand, from a runner outside the pool. It refuses while a runner is
  busy or other runs are active (`force` skips those checks; GitHub still will not
  remove a busy runner). It needs the same SSH key as `ensure`.
  [Example](examples/release.yml).

Each consuming repo needs three kinds of Actions secret: the cloud credential
(a Hetzner project token, or an OVH application credential id and secret), a
fine-grained PAT with Administration read and write on that repo (the workflow's
own `GITHUB_TOKEN` cannot manage runners), and an SSH private key whose public
half is uploaded to the cloud project. The example files list them.

## Providers

Pick one with the `provider` input of `ensure`, `reap` and `release`: `hetzner`
(the default, so existing workflows keep working) or `ovh`. Give the same
`provider` (and, on OVH, `location`) to all three.

| | Hetzner | OVH |
| --- | --- | --- |
| Credential | `hcloud-token` | `ovh-application-credential-id` and `-secret` |
| `server-type` | server type, e.g. `cpx62` | flavor, e.g. `b3-32` |
| `location` | `nbg1` (default) | region, `US-EAST-VA-1` (default) |
| `image` | `ubuntu-24.04` (default) | `Ubuntu 24.04` (default) |
| `ssh-key-names` | one or more keys in the project | exactly one key pair, in the region |
| Billing | per started hour, so an idle VM is deleted in the last minutes of the paid hour | by runtime, so an idle VM is deleted at the next reap |

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

Until there is a release tag, reference the actions as `@main`; pin to a commit
SHA if you want them not to change under you.

## Layout

- `ensure/`, `reap/`, `release/`: the composite actions.
- `src/cli.ts`: the entry point they run, configured through environment variables.
- `src/provider.ts`: the provider interface and billing model. `src/hetzner.ts` and
  `src/ovh.ts` are the adapters; `src/providers.ts` picks one from the config.
- `src/ensure.ts`, `src/reap.ts`, `src/release.ts`: the operations.
- `src/billing.ts`: when an idle server is deleted, given how the provider bills.
- `src/github-client.ts`: the GitHub REST calls for runners and runs.
- `src/ssh-registrar.ts`, `src/userdata.ts`: runner setup on the VM.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
```
