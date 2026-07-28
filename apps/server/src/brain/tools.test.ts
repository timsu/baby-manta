// Brain task tools against real Postgres. Proves the tools create/list/fetch
// within workspace scope and that transition_status enforces the kanban state
// machine for the "brain" actor. Skipped without DATABASE_URL.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, tasks as dbTasks, workspaces } from "@manta/db";
import type { ToolDefinition, ToolContext } from "@manta/agent";
import { brainTaskTools } from "./tools.ts";

const hasDb = Boolean(process.env["DATABASE_URL"]);
const tools = brainTaskTools();
const tool = (name: string): ToolDefinition => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const run = <R = unknown>(name: string, args: unknown, ctx: ToolContext): Promise<R> =>
  Promise.resolve(tool(name).handler(args, ctx) as R);

describe.skipIf(!hasDb)("brain task tools", () => {
  let workspaceId = "";
  let ctx: ToolContext;

  beforeAll(async () => {
    await prisma.$connect();
    const ws = await workspaces.create({ slug: "ws-tools-" + Math.random().toString(36).slice(2, 8), name: "Tools" });
    workspaceId = ws.id;
    ctx = { workspaceId, channel: "brain" };
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  it("create_task → list_tasks → get_task round-trips within the workspace", async () => {
    const created = await run<{ id: string; title: string; repo: string; cardStatus: string; taskNumber: number; workerStarted: boolean }>(
      "create_task",
      { description: "Fix the flaky login test", repo: "acme/app" },
      ctx,
    );
    expect(created.id).toMatch(/^c-/);
    expect(created.title).toBe("Fix the flaky login test");
    expect(created.repo).toBe("acme/app");
    expect(created.cardStatus).toBe("bot_working");
    expect(created.taskNumber).toBe(1);
    expect(created.workerStarted).toBe(false);

    const list = await run<Array<{ id: string }>>("list_tasks", {}, ctx);
    expect(list.map((t) => t.id)).toContain(created.id);

    const got = await run<{ found: boolean; id?: string }>("get_task", { id: created.id }, ctx);
    expect(got.found).toBe(true);
    expect(got.id).toBe(created.id);
  });

  it("resolves a unique displayed card ID for lookups and actions", async () => {
    const created = await run<{ id: string }>("create_task", { description: "short reference", repo: "acme/app" }, ctx);
    const displayId = created.id.slice(0, 8);

    const got = await run<{ found: boolean; id?: string }>("get_task", { id: displayId }, ctx);
    expect(got).toMatchObject({ found: true, id: created.id });

    const moved = await run<{ id: string; cardStatus: string }>(
      "transition_status",
      { id: displayId, to: "done", doneReason: "completed" },
      ctx,
    );
    expect(moved).toMatchObject({ id: created.id, cardStatus: "done" });
  });

  it("does not resolve an ambiguous displayed card ID", async () => {
    const create = (id: string) => dbTasks.create(
      { workspaceId },
      {
        id,
        name: id,
        title: id,
        description: "ambiguous display ID test",
        kind: "agent",
        cardType: "bot",
        repo: "acme/app",
        workerBackend: "test",
      },
    );
    await create("c-abcdef111111");
    await create("c-abcdef222222");

    const got = await run<{ found: boolean; error?: string; message?: string }>("get_task", { id: "c-abcdef" }, ctx);
    expect(got).toMatchObject({
      found: false,
      error: "ambiguous_task_reference",
      message: expect.stringContaining("full card ID"),
    });
  });

  it("transition_status allows the wildcard *→done with a valid doneReason", async () => {
    const { id } = await run<{ id: string }>("create_task", { description: "ship it", repo: "acme/app" }, ctx);
    const res = await run<{ cardStatus: string; doneReason: string | null }>(
      "transition_status",
      { id, to: "done", doneReason: "completed" },
      ctx,
    );
    expect(res.cardStatus).toBe("done");
    expect(res.doneReason).toBe("completed");
  });

  it("transition_status rejects an edge the brain isn't allowed to drive", async () => {
    const { id } = await run<{ id: string }>("create_task", { description: "x", repo: "acme/app" }, ctx);
    // bot_working -> ready_to_test is [worker, human] only; brain is not allowed.
    await expect(run("transition_status", { id, to: "ready_to_test" }, ctx)).rejects.toThrow(
      /not allowed/i,
    );
  });

  it("transition_status force bypasses the kanban edge rules", async () => {
    const { id } = await run<{ id: string }>("create_task", { description: "force me", repo: "acme/app" }, ctx);
    await run("transition_status", { id, to: "done", doneReason: "abandoned" }, ctx);
    // done -> needs_help is an edge no actor has; it must fail without force...
    await expect(run("transition_status", { id, to: "needs_help" }, ctx)).rejects.toThrow(/not allowed/i);
    // ...and succeed with force (the incident-recovery move).
    const forced = await run<{ cardStatus: string }>("transition_status", { id, to: "needs_help", force: true }, ctx);
    expect(forced.cardStatus).toBe("needs_help");
    // force still rejects a no-op same-state move.
    await expect(run("transition_status", { id, to: "needs_help", force: true }, ctx)).rejects.toThrow(/not allowed/i);
  });

  it("get_task does not find a task from another workspace", async () => {
    const other = await workspaces.create({ slug: "ws-other-" + Math.random().toString(36).slice(2, 8), name: "Other" });
    try {
      const { id } = await run<{ id: string }>("create_task", { description: "secret", repo: "acme/app" }, ctx);
      const got = await run<{ found: boolean }>("get_task", { id }, { workspaceId: other.id, channel: "brain" });
      expect(got.found).toBe(false);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: other.id } });
    }
  });

  it("list_tasks reports card ownership (createdByMe)", async () => {
    const me = { workspaceId, channel: "brain", userId: "u-me" } as ToolContext;
    const created = await run<{ id: string }>("create_task", { description: "a card I own", repo: "acme/app" }, me);
    const mine = await run<Array<{ id: string; createdBy: string | null; createdByMe: boolean }>>("list_tasks", {}, me);
    const row = mine.find((t) => t.id === created.id);
    expect(row?.createdBy).toBe("u-me");
    expect(row?.createdByMe).toBe(true);
    // A different requester sees the same card as not theirs.
    const other = await run<Array<{ id: string; createdByMe: boolean }>>(
      "list_tasks",
      {},
      { workspaceId, channel: "brain", userId: "u-other" } as ToolContext,
    );
    expect(other.find((t) => t.id === created.id)?.createdByMe).toBe(false);
  });

  it("transition_status refuses to dispose another user's card unless forced", async () => {
    const owner = { workspaceId, channel: "brain", userId: "u-owner" } as ToolContext;
    const requester = { workspaceId, channel: "brain", userId: "u-requester" } as ToolContext;
    const { id } = await run<{ id: string }>("create_task", { description: "owned by someone else", repo: "acme/app" }, owner);
    const refused = await run<{ error?: string; createdBy?: string }>(
      "transition_status",
      { id, to: "done", doneReason: "abandoned" },
      requester,
    );
    expect(refused.error).toBe("refused_cross_user");
    expect(refused.createdBy).toBe("u-owner");
    // Card is untouched by the refusal.
    expect((await run<{ cardStatus: string }>("get_task", { id }, owner)).cardStatus).toBe("bot_working");
    // force overrides the guard.
    const forced = await run<{ cardStatus: string }>("transition_status", { id, to: "done", doneReason: "abandoned", force: true }, requester);
    expect(forced.cardStatus).toBe("done");
    // The owner disposing their own card needs no force.
    const { id: id2 } = await run<{ id: string }>("create_task", { description: "owned, disposed by owner", repo: "acme/app" }, owner);
    expect((await run<{ cardStatus: string }>("transition_status", { id: id2, to: "done", doneReason: "abandoned" }, owner)).cardStatus).toBe("done");
  });

  it("clear_investigation_complete clears the requester's investigation-complete cards", async () => {
    const me = { workspaceId, channel: "brain", userId: "u-inv-me" } as ToolContext;
    const mine = await run<{ id: string }>("create_task", { description: "my investigation", repo: "acme/app" }, me);
    const theirs = await run<{ id: string }>(
      "create_task",
      { description: "their investigation", repo: "acme/app" },
      { workspaceId, channel: "brain", userId: "u-inv-other" } as ToolContext,
    );
    await prisma.task.updateMany({
      where: { id: { in: [mine.id, theirs.id] } },
      data: { cardStatus: "investigation_complete", doneReason: "investigation_complete" },
    });
    const res = await run<{ cleared: number; ids: string[] }>("clear_investigation_complete", {}, me);
    expect(res.ids).toContain(mine.id);
    expect(res.ids).not.toContain(theirs.id);
    expect((await run<{ cardStatus: string }>("get_task", { id: mine.id }, me)).cardStatus).toBe("done");
    // allUsers clears everyone's remaining investigation-complete cards.
    const all = await run<{ ids: string[] }>("clear_investigation_complete", { allUsers: true }, me);
    expect(all.ids).toContain(theirs.id);
  });

  it("reuses an active card for duplicate Linear issue create_task attempts", async () => {
    const spawned: string[] = [];
    const workerTools = brainTaskTools({ worker: { spawnWorker: (task) => spawned.push(task.id) } });
    const workerTool = (name: string): ToolDefinition => {
      const t = workerTools.find((x) => x.name === name);
      if (!t) throw new Error(`no tool ${name}`);
      return t;
    };
    const runWithWorker = <R = unknown>(name: string, args: unknown): Promise<R> =>
      Promise.resolve(workerTool(name).handler(args, ctx) as R);

    const first = await runWithWorker<{ id: string; reusedExisting?: boolean; workerStarted: boolean }>(
      "create_task",
      { description: "Fix the ENG-5994 regression", repo: "acme/app", linearIssueIdentifier: "ENG-5994" },
    );
    const second = await runWithWorker<{ id: string; reusedExisting?: boolean; workerStarted: boolean; duplicateMatchReason?: string }>(
      "create_task",
      { description: "Fix the ENG-5994 regression", repo: "acme/app", linearIssueIdentifier: "eng-5994" },
    );

    expect(second.id).toBe(first.id);
    expect(second.reusedExisting).toBe(true);
    expect(second.workerStarted).toBe(false);
    expect(second.duplicateMatchReason).toBe("linear_issue");
    expect(spawned).toEqual([first.id]);

    const rows = await prisma.task.findMany({ where: { workspaceId, linearIssueIdentifier: "ENG-5994" } });
    expect(rows).toHaveLength(1);
  });

  it("dispatches a confirmed follow-up turn for a review-ready card", async () => {
    const started: Array<{ workspaceId: string; id: string; message: string; actor?: string; requireIdle?: boolean }> = [];
    const workerTools = brainTaskTools({
      worker: {
        spawnWorker: () => {},
        acceptTaskMessage: async (workspaceId, id, message, actor, opts) => {
          started.push({ workspaceId, id, message, actor, requireIdle: opts?.requireIdle });
          return { task: { id, cardStatus: "bot_working" } as never, dispatched: true };
        },
      },
    });
    const messageWorker = workerTools.find((candidate) => candidate.name === "message_worker")!;
    const task = await dbTasks.create(
      { workspaceId },
      {
        name: "review-ready-follow-up",
        title: "Review-ready follow-up",
        description: "Review-ready follow-up",
        kind: "agent",
        cardType: "bot",
        cardStatus: "ready_to_test",
        repo: "acme/app",
        workerBackend: "test",
      },
    );

    const result = await Promise.resolve(messageWorker.handler({ id: task.id, message: "Address the review feedback" }, ctx)) as { delivered: boolean };

    expect(result).toEqual({ delivered: true });
    expect(started).toEqual([{ workspaceId, id: task.id, message: "Address the review feedback", actor: "brain", requireIdle: true }]);
  });

  it("does not report a Brain follow-up delivered when dispatch loses its claim", async () => {
    const workerTools = brainTaskTools({
      worker: { spawnWorker: () => {}, acceptTaskMessage: async () => ({ task: {} as never, dispatched: false }) },
    });
    const messageWorker = workerTools.find((candidate) => candidate.name === "message_worker")!;
    const task = await dbTasks.create(
      { workspaceId },
      {
        name: "unclaimed-follow-up",
        title: "Unclaimed follow-up",
        description: "Unclaimed follow-up",
        kind: "agent",
        cardType: "bot",
        repo: "acme/app",
        workerBackend: "test",
      },
    );

    await expect(Promise.resolve(messageWorker.handler({ id: task.id, message: "Please continue" }, ctx))).resolves.toMatchObject({ delivered: false });
  });

  it("archives active worker cards by canceling them first", async () => {
    const spawned: string[] = [];
    const workerTools = brainTaskTools({ worker: { spawnWorker: (task) => spawned.push(task.id) } });
    const workerTool = (name: string): ToolDefinition => {
      const t = workerTools.find((x) => x.name === name);
      if (!t) throw new Error(`no tool ${name}`);
      return t;
    };
    const runWithWorker = <R = unknown>(name: string, args: unknown, toolCtx: ToolContext = ctx): Promise<R> =>
      Promise.resolve(workerTool(name).handler(args, toolCtx) as R);
    const slackCtx: ToolContext = {
      ...ctx,
      slackOrigin: { channel: "C-dupe", threadTs: "1700000000.000200", slackUserId: "U123" },
    };

    const first = await runWithWorker<{ id: string; workerStarted: boolean }>(
      "create_task",
      { title: "Sort dashboard by activity", description: "Sort dashboard by newest activity first", repo: "acme/app" },
      slackCtx,
    );
    const archived = await runWithWorker<{ archived?: boolean; abortedActiveWorker?: boolean }>("archive_task", { id: first.id }, slackCtx);

    expect(first.workerStarted).toBe(true);
    expect(archived).toEqual({ archived: true, abortedActiveWorker: true });
    expect(spawned).toEqual([first.id]);

    const rows = await prisma.task.findMany({ where: { workspaceId, slackChannel: "C-dupe", slackThreadTs: "1700000000.000200" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cardStatus).toBe("canceled");
    expect(rows[0]?.archivedAt).toBeInstanceOf(Date);
  });

  it("archives already-canceled cards even if workerActive is still true", async () => {
    const created = await run<{ id: string }>(
      "create_task",
      { title: "Cancel me", description: "This work was canceled", repo: "acme/app" },
      ctx,
    );
    await prisma.task.update({ where: { id: created.id }, data: { cardStatus: "canceled", workerActive: true } });

    const archived = await run<{ archived?: boolean; abortedActiveWorker?: boolean }>("archive_task", { id: created.id }, ctx);

    expect(archived).toEqual({ archived: true, abortedActiveWorker: true });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.cardStatus).toBe("canceled");
    expect(row.archivedAt).toBeInstanceOf(Date);
  });

  it("reuses a Slack-origin card when a Linear duplicate has the same request", async () => {
    const slackCtx: ToolContext = {
      workspaceId,
      channel: "brain",
      slackOrigin: { channel: "C123", threadTs: "1700000000.000100", slackUserId: "U123" },
    };
    const first = await run<{ id: string; reusedExisting?: boolean }>(
      "create_task",
      { title: "Fix checkout OAuth redirect", description: "Fix checkout OAuth redirect failing after login", repo: "acme/app" },
      slackCtx,
    );
    const second = await run<{ id: string; reusedExisting?: boolean; duplicateMatchReason?: string }>(
      "create_task",
      { title: "Fix checkout OAuth redirect", description: "Fix checkout OAuth redirect failing after login", repo: "acme/app", linearIssueIdentifier: "ENG-5995" },
      ctx,
    );

    expect(second.id).toBe(first.id);
    expect(second.reusedExisting).toBe(true);
    expect(second.duplicateMatchReason).toBe("title");

    const task = await prisma.task.findUniqueOrThrow({ where: { id: first.id } });
    expect(task.slackChannel).toBe("C123");
    expect(task.slackThreadTs).toBe("1700000000.000100");
    expect(task.linearIssueIdentifier).toBe("ENG-5995");
  });
});
