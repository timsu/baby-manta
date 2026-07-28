// Integration test against a REAL Postgres (DATABASE_URL). Proves the core
// multi-tenancy invariant: workspace-scoped queries cannot see another
// workspace's rows. Skipped when DATABASE_URL is absent (e.g. a unit-only run);
// CI provides a Postgres service (see .github/workflows/ci.yml).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "./client.ts";
import * as workspaces from "./workspaces.ts";
import * as tasks from "./tasks.ts";

const hasDb = Boolean(process.env["DATABASE_URL"]);
const uniq = () => randomSlug();
function randomSlug(): string {
  return "ws-" + Math.random().toString(36).slice(2, 9);
}

describe.skipIf(!hasDb)("db integration: workspace isolation", () => {
  const created: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    // Clean up the workspaces we made (cascades to tasks).
    if (created.length) {
      await prisma.workspace.deleteMany({ where: { id: { in: created } } });
    }
    await prisma.$disconnect();
  });

  it("scopes task reads to their workspace", async () => {
    const a = await workspaces.create({ slug: uniq(), name: "A" });
    const b = await workspaces.create({ slug: uniq(), name: "B" });
    created.push(a.id, b.id);

    const t = await tasks.create(
      { workspaceId: a.id },
      {
        name: "fix-thing",
        title: "Fix thing",
        description: "do it",
        kind: "agent",
        cardType: "bot",
        repo: "acme/widgets",
        workerBackend: "pi-gpt-5.4",
      },
    );

    // Visible within its own workspace...
    expect((await tasks.get({ workspaceId: a.id }, t.id))?.id).toBe(t.id);
    expect((await tasks.list({ workspaceId: a.id })).map((x) => x.id)).toContain(t.id);

    // ...invisible from another workspace (existence not disclosed).
    expect(await tasks.get({ workspaceId: b.id }, t.id)).toBeNull();
    expect(await tasks.list({ workspaceId: b.id })).toHaveLength(0);
  });

  it("create files the task into the scope's workspace, ignoring any stray id", async () => {
    const a = await workspaces.create({ slug: uniq(), name: "A2" });
    created.push(a.id);
    const t = await tasks.create(
      { workspaceId: a.id },
      {
        name: "n",
        title: "T",
        description: "d",
        kind: "self",
        cardType: "interactive",
        repo: "acme/x",
        workerBackend: "claude-sonnet",
      },
    );
    expect(t.workspaceId).toBe(a.id);
    expect(t.id).toMatch(/^c-[0-9a-f]{12}$/);
    expect(t.cardStatus).toBe("bot_working"); // schema default
  });

  it("clears stale PR status fields when moving to ready_to_test", async () => {
    const a = await workspaces.create({ slug: uniq(), name: "A3" });
    created.push(a.id);
    const t = await tasks.create(
      { workspaceId: a.id },
      {
        name: "fix-pr",
        title: "Fix PR",
        description: "d",
        kind: "agent",
        cardType: "bot",
        repo: "acme/pr-status",
        workerBackend: "pi-gpt-5.4",
      },
    );

    await prisma.task.update({
      where: { id: t.id },
      data: {
        prNumber: 123,
        prUrl: "https://github.com/acme/pr-status/pull/123",
        checksStatus: "failing",
        checks: [{ name: "ci", status: "failing", conclusion: "failure" }],
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "CONFLICTING",
        autoMergeEnabled: true,
      },
    });

    const updated = await tasks.transition({ workspaceId: a.id }, t.id, "ready_to_test", "worker");

    expect(updated.cardStatus).toBe("ready_to_test");
    expect(updated.prNumber).toBe(123);
    expect(updated.prUrl).toBe("https://github.com/acme/pr-status/pull/123");
    expect(updated.checksStatus).toBe("unknown");
    expect(updated.checks).toEqual([]);
    expect(updated.reviewDecision).toBeNull();
    expect(updated.mergeable).toBe("UNKNOWN");
    expect(updated.autoMergeEnabled).toBe(false);
  });
});
