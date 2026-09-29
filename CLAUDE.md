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
- This repo is public. Never commit tokens, keys, or real server IDs.
- Feature work happens in a worktree, not the main checkout.

## Facts learned running Hetzner in the sibling `pioneer` repo

- Billing is per started hour, measured from server creation. A stopped server is
  still billed; it has to be deleted.
- The account is capped at 5 servers. Two consumers plus fit VMs can hit it.
- Cloud-init user-data is readable without authentication from inside the VM, so
  never put a provider token in it.
- Runners registered to a personal-account repo serve only that repo. Each
  consuming repo therefore needs its own VM and its own secrets.
