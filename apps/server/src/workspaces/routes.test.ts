// Workspace create + chat routes against real Postgres, with a ScriptedBackend
// (no Pi cost). Proves: auth gating, workspace creation makes the caller owner,
// membership authorization, and a chat turn runs the brain + its tools scoped
// to the workspace. Skipped without DATABASE_URL.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, tasks } from "@manta/db";
import { ScriptedBackend } from "@manta/agent";
import { createApp } from "../app.ts";
import { brainTaskTools } from "../brain/tools.ts";
import { getTaskWorkerSend, listWorkers, registerWorker, unregisterWorker } from "../worker/registry.ts";
import type { Logger } from "../logger.ts";
import type { AuthDeps } from "../auth/routes.ts";

const hasDb = Boolean(process.env["DATABASE_URL"]);
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lastError) throw lastError;
}

// Minimal auth deps: a session "tok-<userId>" maps to that user (created in DB).
function authDeps(): AuthDeps {
  return {
    googleAuth: { authUrl: () => "", exchange: async () => ({ googleSub: "x", email: "x@y.z" }) },
    sessions: {
      issue: async ({ userId }) => `tok-${userId}`,
      verify: async (t) => (t.startsWith("tok-") ? { sub: t.slice(4), email: "u@x.com", exp: 9_999_999_999 } : null),
    },
    upsertUser: async (p) => ({ id: "u", email: p.email }),
    memberships: async () => [],
    now: () => new Date(),
    webAppUrl: "http://localhost:5173",
    secureCookies: false,
  };
}

function app() {
  return createApp({
    logger: silent,
    auth: authDeps(),
    brain: {
      brainBackend: new ScriptedBackend([
        { type: "call", tool: "create_task", args: { description: "Add health endpoint", repo: "acme/api" } },
        { type: "text", text: "Card created." },
      ]),
      brainBackendId: "fake",
      brainTools: brainTaskTools(),
      defaultBrainPrompt: "You are the brain.",
    },
  });
}

describe.skipIf(!hasDb)("workspace + chat routes", () => {
  let userId = "";
  beforeAll(async () => {
    await prisma.$connect();
    const u = await prisma.user.create({
      data: { googleSub: "g-" + Math.random().toString(36).slice(2), email: `u${Date.now()}@x.com`, name: "U" },
    });
    userId = u.id;
  });
  afterAll(async () => {
    await prisma.membership.deleteMany({ where: { userId } });
    await prisma.workspace.deleteMany({ where: { members: { some: { userId } } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const cookie = () => ({ Cookie: `manta_session=tok-${userId}` });

  it("requires auth", async () => {
    const res = await app().request("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "X" }) });
    expect(res.status).toBe(401);
  });

  it("creates a workspace with the caller as owner, then chats → brain spawns a task", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST",
      headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()) as { id: string; slug: string };
    expect(ws.slug).toMatch(/^acme-/);

    const chat = await a.request(`/api/workspaces/${ws.id}/chat`, {
      method: "POST",
      headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "add a health endpoint to acme/api" }),
    });
    expect(chat.status).toBe(200);
    const body = (await chat.json()) as { toolsUsed: string[]; assistantText: string };
    expect(body.toolsUsed).toContain("create_task");
    expect(body.assistantText).toContain("Card created");

    const list = await tasks.list({ workspaceId: ws.id });
    expect(list).toHaveLength(1);
    expect(list[0]?.repo).toBe("acme/api");
  });

  it("manages repos and creates a card directly (New-card modal)", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Repos" }),
    });
    const ws = (await created.json()) as { id: string };

    const addRepo = await a.request(`/api/workspaces/${ws.id}/repos`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgRepo: "acme/platform" }),
    });
    expect(addRepo.status).toBe(201);

    // bad org/repo is rejected
    const bad = await a.request(`/api/workspaces/${ws.id}/repos`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgRepo: "not-a-repo" }),
    });
    expect(bad.status).toBe(400);

    const list = (await (await a.request(`/api/workspaces/${ws.id}/repos`, { headers: cookie() })).json()) as { repos: { orgRepo: string }[] };
    expect(list.repos.map((r) => r.orgRepo)).toEqual(["acme/platform"]);

    const card = await a.request(`/api/workspaces/${ws.id}/cards`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Add /metrics endpoint", repo: "acme/platform", cardType: "interactive", workerBackend: "pi-openai-codex:gpt-5.5" }),
    });
    expect(card.status).toBe(201);
    const cardBody = (await card.json()) as { cardStatus: string };
    expect(cardBody.cardStatus).toBe("interactive"); // interactive type → interactive status

    const tasksList = await tasks.list({ workspaceId: ws.id });
    expect(tasksList).toHaveLength(1);
    expect(tasksList[0]?.repo).toBe("acme/platform");
  });

  it("lets members manage member invites without granting admin invite access", async () => {
    const a = app();
    const member = await prisma.user.create({
      data: { googleSub: "g-member-" + Math.random().toString(36).slice(2), email: `member${Date.now()}@x.com`, name: "Member" },
    });
    try {
      const created = await a.request("/api/workspaces", {
        method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Invites" }),
      });
      const ws = (await created.json()) as { id: string };
      await prisma.membership.create({ data: { workspaceId: ws.id, userId: member.id, role: "member" } });
      const memberCookie = { Cookie: `manta_session=tok-${member.id}` };

      const adminInvite = await a.request(`/api/workspaces/${ws.id}/invitations`, {
        method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });
      expect(adminInvite.status).toBe(201);
      const adminBody = (await adminInvite.json()) as { id: string; role: string };
      expect(adminBody.role).toBe("admin");

      const memberCannotCreateAdmin = await a.request(`/api/workspaces/${ws.id}/invitations`, {
        method: "POST", headers: { ...memberCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });
      expect(memberCannotCreateAdmin.status).toBe(403);

      const memberInvite = await a.request(`/api/workspaces/${ws.id}/invitations`, {
        method: "POST", headers: { ...memberCookie, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(memberInvite.status).toBe(201);
      const memberBody = (await memberInvite.json()) as { id: string; role: string };
      expect(memberBody.role).toBe("member");

      const visibleToMember = await a.request(`/api/workspaces/${ws.id}/invitations`, { headers: memberCookie });
      const visibleBody = (await visibleToMember.json()) as { invitations: Array<{ id: string; role: string }> };
      expect(visibleBody.invitations.map((inv) => inv.role)).toEqual(["member"]);

      const revokeAdmin = await a.request(`/api/workspaces/${ws.id}/invitations/${adminBody.id}`, {
        method: "DELETE", headers: memberCookie,
      });
      expect(revokeAdmin.status).toBe(403);

      const revokeMember = await a.request(`/api/workspaces/${ws.id}/invitations/${memberBody.id}`, {
        method: "DELETE", headers: memberCookie,
      });
      expect(revokeMember.status).toBe(200);
    } finally {
      await prisma.user.deleteMany({ where: { id: member.id } });
    }
  });

  it("starts work when a card is moved into Bot Working and marks inactive when moved out", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lifecycle" }),
    });
    const ws = (await created.json()) as { id: string };

    const addRepo = await a.request(`/api/workspaces/${ws.id}/repos`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgRepo: "acme/api" }),
    });
    expect(addRepo.status).toBe(201);

    const card = await a.request(`/api/workspaces/${ws.id}/cards`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Fix stuck card", repo: "acme/api", cardType: "backlog" }),
    });
    expect(card.status).toBe(201);
    const { id: taskId } = (await card.json()) as { id: string };

    const sent: Array<{ type: string; taskId: string; message: string }> = [];
    const connId = registerWorker("route-lifecycle-worker", userId, (msg) => sent.push(msg as { type: string; taskId: string; message: string }));
    try {
      const toBot = await a.request(`/api/workspaces/${ws.id}/tasks/${taskId}/status`, {
        method: "PATCH", headers: { ...cookie(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "bot_working" }),
      });
      expect(toBot.status).toBe(200);

      await eventually(() => {
        expect(sent).toContainEqual(expect.objectContaining({
          type: "run_task",
          taskId,
          message: expect.stringContaining("moved this card into Working"),
        }));
      });
      let task = await tasks.get({ workspaceId: ws.id }, taskId);
      expect(task?.workerActive).toBe(true);
      expect(task?.workerStatus).toBe("running");

      const out = await a.request(`/api/workspaces/${ws.id}/tasks/${taskId}/status`, {
        method: "PATCH", headers: { ...cookie(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "ready_to_test" }),
      });
      expect(out.status).toBe(200);
      task = await tasks.get({ workspaceId: ws.id }, taskId);
      expect(task?.workerActive).toBe(false);
      expect(task?.venueStatus).toBe("idle");
      expect(listWorkers().find((worker) => worker.workerId === "route-lifecycle-worker")?.activeTaskIds).toEqual([]);
    } finally {
      unregisterWorker("route-lifecycle-worker", connId);
    }
  });

  it("disposes worker runtime when a task is abandoned into Done", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Abandon runtime" }),
    });
    const ws = (await created.json()) as { id: string };

    const addRepo = await a.request(`/api/workspaces/${ws.id}/repos`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgRepo: "acme/api" }),
    });
    expect(addRepo.status).toBe(201);

    const card = await a.request(`/api/workspaces/${ws.id}/cards`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Abandon me", repo: "acme/api", cardType: "backlog" }),
    });
    expect(card.status).toBe(201);
    const { id: taskId } = (await card.json()) as { id: string };

    const sent: Array<{ type: string; taskId: string; message?: string }> = [];
    const connId = registerWorker("route-dispose-worker", userId, (msg) => sent.push(msg as { type: string; taskId: string; message?: string }));
    try {
      const toBot = await a.request(`/api/workspaces/${ws.id}/tasks/${taskId}/status`, {
        method: "PATCH", headers: { ...cookie(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "bot_working" }),
      });
      expect(toBot.status).toBe(200);
      await eventually(() => expect(getTaskWorkerSend(taskId)).not.toBeNull());

      const done = await a.request(`/api/workspaces/${ws.id}/tasks/${taskId}/status`, {
        method: "PATCH", headers: { ...cookie(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "done", doneReason: "abandoned" }),
      });
      expect(done.status).toBe(200);

      expect(sent).toContainEqual(expect.objectContaining({ type: "dispose_task", taskId }));
      expect(getTaskWorkerSend(taskId)).toBeNull();
      const task = await tasks.get({ workspaceId: ws.id }, taskId);
      expect(task?.workerActive).toBe(false);
      expect(task?.cardStatus).toBe("done");
      expect(task?.doneReason).toBe("abandoned");
    } finally {
      unregisterWorker("route-dispose-worker", connId);
    }
  });

  it("clears the Investigation Complete column to Done, skipping non-matching cards", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Clear investigations" }),
    });
    const ws = (await created.json()) as { id: string };
    await a.request(`/api/workspaces/${ws.id}/repos`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgRepo: "acme/api" }),
    });

    const mk = async (prompt: string) => {
      const card = await a.request(`/api/workspaces/${ws.id}/cards`, {
        method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, repo: "acme/api", cardType: "backlog" }),
      });
      return ((await card.json()) as { id: string }).id;
    };
    const invA = await mk("investigation A");
    const invB = await mk("investigation B");
    const other = await mk("not an investigation");
    await prisma.task.updateMany({
      where: { id: { in: [invA, invB] }, workspaceId: ws.id },
      data: { cardStatus: "investigation_complete", doneReason: "investigation_complete" },
    });

    const res = await a.request(`/api/workspaces/${ws.id}/tasks/clear-investigation-complete`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: [invA, invB, other] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cleared: number; ids: string[] };
    expect(body.cleared).toBe(2);
    expect(body.ids.sort()).toEqual([invA, invB].sort());

    expect((await tasks.get({ workspaceId: ws.id }, invA))?.cardStatus).toBe("done");
    expect((await tasks.get({ workspaceId: ws.id }, invB))?.doneReason).toBe("completed");
    // The non-investigation card is untouched.
    expect((await tasks.get({ workspaceId: ws.id }, other))?.cardStatus).toBe("backlog");
  });

  it("lets a human drag a card to an otherwise-illegal status (done -> needs_help)", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Drag anywhere" }),
    });
    const ws = (await created.json()) as { id: string };
    await a.request(`/api/workspaces/${ws.id}/repos`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgRepo: "acme/api" }),
    });
    const card = await a.request(`/api/workspaces/${ws.id}/cards`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drag me back", repo: "acme/api", cardType: "backlog" }),
    });
    const { id: taskId } = (await card.json()) as { id: string };

    const toDone = await a.request(`/api/workspaces/${ws.id}/tasks/${taskId}/status`, {
      method: "PATCH", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ to: "done", doneReason: "abandoned" }),
    });
    expect(toDone.status).toBe(200);

    // done -> needs_help has no kanban edge for any actor, but a human drag forces it.
    const back = await a.request(`/api/workspaces/${ws.id}/tasks/${taskId}/status`, {
      method: "PATCH", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ to: "needs_help" }),
    });
    expect(back.status).toBe(200);
    expect((await tasks.get({ workspaceId: ws.id }, taskId))?.cardStatus).toBe("needs_help");
  });

  it("rejects clearing investigations for a non-member", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Clear auth" }),
    });
    const ws = (await created.json()) as { id: string };
    const res = await a.request(`/api/workspaces/${ws.id}/tasks/clear-investigation-complete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("starts work from a non-active column even if a stale worker is marked running", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Stale running" }),
    });
    const ws = (await created.json()) as { id: string };

    const addRepo = await a.request(`/api/workspaces/${ws.id}/repos`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgRepo: "acme/api" }),
    });
    expect(addRepo.status).toBe(201);

    const card = await a.request(`/api/workspaces/${ws.id}/cards`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Resume stale card", repo: "acme/api", cardType: "backlog" }),
    });
    expect(card.status).toBe(201);
    const { id: taskId } = (await card.json()) as { id: string };
    await prisma.task.update({
      where: { id: taskId },
      data: {
        cardStatus: "ready_to_test",
        workerActive: true,
        workerStatus: "running",
        workerVenue: "laptop",
        venueStatus: "active",
      },
    });

    const sent: Array<{ type: string; taskId: string; message: string }> = [];
    const connId = registerWorker("route-stale-running-worker", userId, (msg) => sent.push(msg as { type: string; taskId: string; message: string }));
    try {
      const toBot = await a.request(`/api/workspaces/${ws.id}/tasks/${taskId}/status`, {
        method: "PATCH", headers: { ...cookie(), "Content-Type": "application/json" },
        body: JSON.stringify({ to: "bot_working" }),
      });
      expect(toBot.status).toBe(200);

      await eventually(() => {
        expect(sent).toContainEqual(expect.objectContaining({
          type: "run_task",
          taskId,
          message: expect.stringContaining("moved this card into Working"),
        }));
      });
      const task = await tasks.get({ workspaceId: ws.id }, taskId);
      expect(task?.cardStatus).toBe("bot_working");
      expect(task?.workerActive).toBe(true);
      expect(task?.workerStatus).toBe("running");
    } finally {
      unregisterWorker("route-stale-running-worker", connId);
    }
  });

  it("lets active laptop tasks start a conflict-fix turn", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Conflicts" }),
    });
    const ws = (await created.json()) as { id: string };

    const addRepo = await a.request(`/api/workspaces/${ws.id}/repos`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgRepo: "acme/api" }),
    });
    expect(addRepo.status).toBe(201);

    const card = await a.request(`/api/workspaces/${ws.id}/cards`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Fix conflict", repo: "acme/api", cardType: "backlog" }),
    });
    expect(card.status).toBe(201);
    const { id: taskId } = (await card.json()) as { id: string };
    await prisma.task.update({
      where: { id: taskId },
      data: {
        cardStatus: "ready_to_test",
        prNumber: 123,
        prUrl: "https://github.com/acme/api/pull/123",
        mergeable: "CONFLICTING",
        workerActive: true,
        workerStatus: "running",
        workerVenue: "laptop",
        venueStatus: "active",
      },
    });

    const sent: Array<{ type: string; taskId: string; message: string }> = [];
    const connId = registerWorker("route-conflict-worker", userId, (msg) => sent.push(msg as { type: string; taskId: string; message: string }));
    try {
      const res = await a.request(`/api/workspaces/${ws.id}/tasks/${taskId}/fix-conflicts`, {
        method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);

      await eventually(() => {
        expect(sent).toContainEqual(expect.objectContaining({
          type: "run_task",
          taskId,
          message: expect.stringContaining("fix the merge conflicts"),
        }));
      });
      const task = await tasks.get({ workspaceId: ws.id }, taskId);
      expect(task?.cardStatus).toBe("bot_working");
      expect(task?.workerActive).toBe(true);
    } finally {
      unregisterWorker("route-conflict-worker", connId);
    }
  });

  it("lets PR tasks start a failing-checks fix turn", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Checks" }),
    });
    const ws = (await created.json()) as { id: string };

    const addRepo = await a.request(`/api/workspaces/${ws.id}/repos`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgRepo: "acme/api" }),
    });
    expect(addRepo.status).toBe(201);

    const card = await a.request(`/api/workspaces/${ws.id}/cards`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Fix checks", repo: "acme/api", cardType: "backlog" }),
    });
    expect(card.status).toBe(201);
    const { id: taskId } = (await card.json()) as { id: string };
    await prisma.task.update({
      where: { id: taskId },
      data: {
        cardStatus: "pr_review",
        prNumber: 124,
        prUrl: "https://github.com/acme/api/pull/124",
        checksStatus: "failing",
        checks: [{ name: "ai-evals", status: "failing", conclusion: "failure" }],
      },
    });

    const res = await a.request(`/api/workspaces/${ws.id}/tasks/${taskId}/fix-checks`, {
      method: "POST", headers: { ...cookie(), "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const task = await tasks.get({ workspaceId: ws.id }, taskId);
    expect(task?.cardStatus).toBe("bot_working");
  });

  it("rejects chat from a non-member", async () => {
    const a = app();
    const created = await a.request("/api/workspaces", {
      method: "POST",
      headers: { ...cookie(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Private" }),
    });
    const ws = (await created.json()) as { id: string };
    // A different (unknown) user's session
    const res = await a.request(`/api/workspaces/${ws.id}/chat`, {
      method: "POST",
      headers: { Cookie: "manta_session=tok-someone-else", "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(403);
  });
});
