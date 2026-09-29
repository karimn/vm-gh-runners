# vm-gh-runners

Run GitHub Actions jobs on a rented VM that is reused for the billing hour you
already paid for, and deleted when it goes idle. Callers change one `runs-on:` line.

Status: early scaffold. Nothing here is usable yet. See [DESIGN.md](DESIGN.md)
for the design and the decisions made so far.

## Layout

- `src/provider.ts` is the provider interface: create, list by label, delete.
  Hetzner Cloud will be the first adapter.
- `src/billing.ts` is the rule for when an idle server is deleted, based on the
  provider's per-started-hour billing.
- `src/mock-provider.ts` is an in-memory provider for tests.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
```
