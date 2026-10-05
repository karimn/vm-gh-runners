# CLAUDE.md

Read [DESIGN.md](DESIGN.md) first; it records the decisions and why.

## Commands

```bash
bun install
bun test
bun run typecheck
```

## Conventions

- TypeScript on Bun, strict mode. Provider-specific code lives only behind the
  `Provider` interface in `src/provider.ts`; everything else stays cloud-neutral.
- GitHub Actions only. Do not generalise to other CI systems.
- OVH is the default provider (decided 2026-10-05); Hetzner callers must pass
  `provider: hetzner`.
- This repo is public. Never commit tokens, keys, or real server IDs.
- Feature work happens in a worktree, not the main checkout.

## Facts learned running Hetzner in the sibling `pioneer` repo

- Billing is per started hour, measured from server creation. A stopped server is
  still billed; it has to be deleted.
- The account is capped at 5 servers. Two consumers plus fit VMs can hit it.
- Cloud-init user-data is readable without authentication from inside the VM, so
  never put a provider token in it.
- The `github-token` PAT needs Administration read and write AND Actions read
  (reap lists workflow runs); see DESIGN.md "GitHub token permissions".
- Runners registered to a personal-account repo serve only that repo. Each
  consuming repo therefore needs its own VM and its own secrets.

## Facts about OVH Public Cloud (US account)

- Billing is prorated by runtime, not per started hour (observed on invoices,
  2026-10-02/03). Pioneer's `OVH_SETUP.md` still says rounded up; the invoices
  win. A stopped server still bills, so delete.
- Compute is OpenStack. Auth is an unrestricted application credential against
  `https://auth.cloud.ovh.us/v3` (EU: `auth.cloud.ovh.net`); region
  `US-EAST-VA-1`. A restricted credential cannot create servers.
- Nova server names are not unique, so there is no 409 lock; see DESIGN.md
  "Concurrency".
- Key pairs are per region and Nova takes one per server.
- Quota is per project and region; a fresh US project showed 3 servers / 6 vCPU.
- Stock Ubuntu images do not allow root SSH unless cloud-init says so.
- The OVH adapter's tests use a fake OpenStack written from the API reference.
  Nothing has been run against a real project yet; see DESIGN.md "Open".
