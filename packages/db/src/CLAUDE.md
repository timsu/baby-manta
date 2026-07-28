# db query layer — multi-tenancy rules

Every workspace-owned row (tasks, messages, inbox items, sessions, identities) is
multi-tenant. **All reads and writes must be scoped by `workspaceId`.**

- Public query helpers take a `scope = { workspaceId }` as their first argument —
  follow that pattern for new helpers. Never expose a by-`id`-only query/mutation
  for a workspace-owned row.
- For mutations, prefer `updateMany`/`deleteMany` with `where: { id, workspaceId }`
  over `update`/`delete` by unique `id`. A bare `where: { id }` lets a caller that
  passes a mismatched `(id, workspaceId)` pair mutate another tenant's row.
- When a function necessarily takes a list of ids (e.g. `inbox.markConsumed`), it
  must still carry `workspaceId` and scope the `where` clause to it — the ids alone
  are not a trust boundary.
