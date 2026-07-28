# Manta

pnpm monorepo. `apps/web` (React/Vite), `apps/server` (Hono/Node), `packages/` (shared, db, agent).

## Coding guidelines

Do not hardcode repo-specific names, ordering, or behavior. Derive repo lists and ordering from workspace configuration/data instead.

## OpenSpec

Use OpenSpec for new feature work and for documenting existing behavior. Before implementing a new user-visible capability or materially changing behavior, add or update the relevant `openspec/specs/<capability>/spec.md` requirements and scenarios; keep them focused on observable behavior, not implementation details.

## Install

```bash
pnpm install
```

In a git worktree, `node_modules` is absent. `pnpm install` should work (`.npmrc` sets `verify-store-integrity=false` to avoid a pnpm 10 worktree bug).

## Key commands

```bash
pnpm typecheck              # typecheck all packages
pnpm --filter @manta/web typecheck
pnpm --filter @manta/server typecheck
pnpm test                   # vitest
pnpm dev                    # start server + web dev servers
```
