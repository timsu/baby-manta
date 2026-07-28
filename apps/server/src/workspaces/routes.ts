// Workspace bootstrap + chat-with-the-brain over HTTP. Both gated by requireAuth.
// The chat endpoint runs a real brain turn (Pi in prod, ScriptedBackend in
// tests) scoped to the workspace, so the brain's tools act only within it.
// Streaming over WS is Phase 5; this is the non-streaming form.

import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { workspaces, tasks, repos, messages, slack, invitations, cardImages, prisma, users } from "@manta/db";
import type { CardType, CardStatus, Role, SlackBot, SlackBotType, SpawnCardPolicy, SlackMessageSchedule, SlackMessageScheduleCadence } from "@manta/db";
import type { AgentEvent } from "@manta/shared";
import type { AgentBackend, ToolDefinition } from "@manta/agent";
import { requireAuth, type AuthVars } from "../auth/routes.ts";
import { runBrainTurn } from "../brain/runner.ts";
import { spawnWorker, startWorkerForTask } from "../worker/dispatch.ts";
import { buildWorkerResumeMessage } from "../worker/resume-context.ts";
import { removeCloudSandbox, stopCloudSandbox } from "../worker/cloud.ts";
import { availableQuestionWorkerCount, disposeTaskWorker, freeTaskWorker, listWorkersWithPresence, type OwnerWorkerPresenceStatus } from "../worker/registry.ts";
import { encrypt, decrypt } from "../secrets/crypto.ts";
import { tokenForWorkspaceRepo } from "../github/tokens.ts";
import {
  getModelsView,
  getRepoChatModels,
  setProvider,
  removeProvider,
  updateModelSettings,
  firstAvailableCardBackendForUser,
} from "../models/service.ts";
import { bus, chanTopic, kanbanTopic } from "../bus.ts";
import { refreshPrStates } from "../poller.ts";
import type { Sessions } from "../auth/session.ts";
import { completedScheduledSlackPreviewText, generateScheduledSlackMessage, nextScheduleRunAt, parseTimeOfDayUtc } from "../slack/scheduled.ts";
import { postWorkerSlackMessage, WorkerSlackPostError } from "../slack/workerPost.ts";
import { terminalSessions } from "../ws/state.ts";
import { linearCardMetadataAndRepo, localWorkerStatusForOwner } from "./routeHelpers.ts";
import { createSpotCheckRoutes } from "./spotChecksRoutes.ts";
import { acceptTaskMessage } from "../worker/taskMessages.ts";
import { askWorkerQuestion } from "../worker/questions.ts";

export interface WorkspaceRoutesDeps {
  sessions: Sessions;
  brainBackend: AgentBackend;
  brainBackendId: string;
  brainTools: ToolDefinition[];
  defaultBrainPrompt: string;
}

function slugify(s: string): string {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace");
}

function canManagePrivilegedWorkspaceAccess(role: Role): boolean {
  return role === "owner" || role === "admin";
}

function closeTaskTerminalRelays(taskId: string): void {
  for (const [sessionId, session] of [...terminalSessions]) {
    if (session.taskId !== taskId) continue;
    try { session.close(1000, "task disposed"); } catch { /* already closed */ }
    terminalSessions.delete(sessionId);
  }
}

interface ParsedGithubPrUrl {
  orgRepo: string;
  prNumber: number;
  htmlUrl: string;
}

interface CiCheckView {
  name?: unknown;
  status?: unknown;
}

function failingCheckNames(checks: unknown): string[] {
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((check: CiCheckView) => check.status === "failing" && typeof check.name === "string" && check.name.trim())
    .map((check) => (check.name as string).trim());
}

function parseGithubPrUrl(raw: string): ParsedGithubPrUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") return null;
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/|$)/);
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!;
  const prNumber = Number(match[3]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return {
    orgRepo: `${owner}/${repo}`,
    prNumber,
    htmlUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
  };
}

const TRANSCRIPT_MESSAGE_LIMIT = 1000;

async function fetchGithubPrMetadata(workspaceId: string, parsed: ParsedGithubPrUrl): Promise<{
  title: string;
  url: string;
  state: string;
  branch: string | null;
} | null> {
  const [owner, repo] = parsed.orgRepo.split("/");
  if (!owner || !repo) return null;
  const token = await tokenForWorkspaceRepo(workspaceId, parsed.orgRepo);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${parsed.prNumber}`, { headers }).catch(() => null);
  if (!res?.ok) return null;
  const pr = await res.json() as {
    title?: string;
    html_url?: string;
    state?: string;
    head?: { ref?: string };
  };
  return {
    title: pr.title?.trim() || `PR #${parsed.prNumber}`,
    url: pr.html_url || parsed.htmlUrl,
    state: pr.state || "open",
    branch: pr.head?.ref ?? null,
  };
}

export function createWorkspaceRoutes(deps: WorkspaceRoutesDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", requireAuth(deps.sessions));

  // Create a workspace; the caller becomes its owner.
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; slug?: string };
    if (!body.name) return c.json({ error: "name_required" }, 400);
    const slug = `${slugify(body.slug ?? body.name)}-${Math.random().toString(36).slice(2, 6)}`;
    const ws = await workspaces.createWithOwner({ slug, name: body.name, ownerId: c.get("userId") });
    return c.json({ id: ws.id, slug: ws.slug, name: ws.name }, 201);
  });

  // Workspace detail (name, brainPrompt, teamMemory).
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const ws = await workspaces.byId(id);
    if (!ws) return c.json({ error: "not_found" }, 404);
    return c.json({ id: ws.id, slug: ws.slug, name: ws.name, brainPrompt: ws.brainPrompt, teamMemory: ws.teamMemory, defaultBrainPrompt: deps.defaultBrainPrompt });
  });

  // Update workspace (name, brainPrompt, teamMemory). Member-gated; role check TBD.
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string; brainPrompt?: string; teamMemory?: string;
    };
    const ws = await workspaces.update(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.brainPrompt !== undefined ? { brainPrompt: body.brainPrompt } : {}),
      ...(body.teamMemory !== undefined ? { teamMemory: body.teamMemory } : {}),
    });
    return c.json({ id: ws.id, slug: ws.slug, name: ws.name, brainPrompt: ws.brainPrompt, teamMemory: ws.teamMemory });
  });

  // ── Models & providers ─────────────────────────────────────────────────────
  // Configure which AI models power the brain and new cards, and store the
  // credentials (provider API keys / Codex OAuth) that make them available.

  // Available models + provider statuses + current model settings.
  app.get("/:id/models", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    return c.json(await getModelsView(id, c.get("userId")));
  });

  // Update default model and/or the new-card model picker list.
  app.put("/:id/models", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      defaultModel?: unknown; scoutModel?: unknown; cardModels?: unknown;
    };
    // Validate types — a non-string model id or non-string[] cardModels would
    // be stored verbatim and break backend selection. null clears the setting.
    const patch: { defaultModel?: string | null; scoutModel?: string | null; cardModels?: string[] } = {};
    if (body.defaultModel !== undefined) {
      if (body.defaultModel !== null && typeof body.defaultModel !== "string") {
        return c.json({ error: "defaultModel must be a string or null" }, 400);
      }
      patch.defaultModel = body.defaultModel;
    }
    if (body.scoutModel !== undefined) {
      if (body.scoutModel !== null && typeof body.scoutModel !== "string") {
        return c.json({ error: "scoutModel must be a string or null" }, 400);
      }
      patch.scoutModel = body.scoutModel;
    }
    if (body.cardModels !== undefined) {
      if (!Array.isArray(body.cardModels) || !body.cardModels.every((m) => typeof m === "string")) {
        return c.json({ error: "cardModels must be an array of strings" }, 400);
      }
      patch.cardModels = body.cardModels;
    }
    return c.json(await updateModelSettings(id, patch, c.get("userId")));
  });

  // Store/replace a provider credential (API key or pasted Codex auth JSON).
  app.put("/:id/providers/:provider", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const provider = c.req.param("provider");
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string; authJson?: unknown };
    try {
      const view = await setProvider(id, provider, body, c.get("userId"));
      return c.json(view);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid_credential" }, 400);
    }
  });

  // Remove a provider's stored credential.
  app.delete("/:id/providers/:provider", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    return c.json(await removeProvider(id, c.req.param("provider"), c.get("userId")));
  });

  // Workspace members list.
  app.get("/:id/members", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const members = await workspaces.listMembers(id);
    const localWorkerCounts = new Map<string, number>();
    for (const worker of await listWorkersWithPresence()) {
      if (worker.sticky) continue;
      if (!worker.live) continue;
      localWorkerCounts.set(worker.ownerUserId, (localWorkerCounts.get(worker.ownerUserId) ?? 0) + 1);
    }
    return c.json({
      members: members.map((m) => ({
        userId: m.userId,
        role: m.role,
        email: m.user.email,
        name: m.user.name,
        avatarUrl: m.user.avatarUrl,
        githubLogin: m.user.githubLogin,
        nonEngineer: m.user.nonEngineer,
        localWorkerCount: localWorkerCounts.get(m.userId) ?? 0,
      })),
    });
  });

  // Mark whether a workspace user should be treated as a non-engineer for PR review routing.
  app.patch("/:id/members/:userId/non-engineer", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);

    const userId = c.req.param("userId");
    if (!(await workspaces.isMember(userId, id))) return c.json({ error: "member_not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { nonEngineer?: unknown };
    if (typeof body.nonEngineer !== "boolean") return c.json({ error: "nonEngineer boolean required" }, 400);

    const user = await users.setNonEngineer(userId, body.nonEngineer);
    return c.json({ userId, nonEngineer: user.nonEngineer });
  });

  // ── Invitations ────────────────────────────────────────────────────────────
  // Members can invite teammates as regular members. Admin/owner access is only
  // needed for privileged (admin) invite links so regular members cannot grant a
  // stronger workspace role than they have.

  // List active invite codes for the workspace.
  app.get("/:id/invitations", async (c) => {
    const id = c.req.param("id");
    const role = await workspaces.roleFor(c.get("userId"), id);
    if (!role) return c.json({ error: "not_a_member" }, 403);
    const list = await invitations.listActive(id);
    const visible = canManagePrivilegedWorkspaceAccess(role) ? list : list.filter((inv) => inv.role === "member");
    return c.json({
      invitations: visible.map((inv) => ({
        id: inv.id, code: inv.code, role: inv.role,
        expiresAt: inv.expiresAt, createdAt: inv.createdAt,
      })),
    });
  });

  // Generate a new shareable invite code.
  app.post("/:id/invitations", async (c) => {
    const id = c.req.param("id");
    const role = await workspaces.roleFor(c.get("userId"), id);
    if (!role) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { role?: string; expiresInDays?: number | null };
    if (body.role === "admin" && !canManagePrivilegedWorkspaceAccess(role)) return c.json({ error: "forbidden" }, 403);
    const inviteRole = body.role === "admin" ? "admin" : "member";
    const inv = await invitations.create({
      workspaceId: id,
      createdBy: c.get("userId"),
      role: inviteRole,
      expiresInDays: body.expiresInDays === undefined ? 14 : body.expiresInDays,
    });
    return c.json({ id: inv.id, code: inv.code, role: inv.role, expiresAt: inv.expiresAt, createdAt: inv.createdAt }, 201);
  });

  // Revoke an invite code.
  app.delete("/:id/invitations/:invId", async (c) => {
    const id = c.req.param("id");
    const role = await workspaces.roleFor(c.get("userId"), id);
    if (!role) return c.json({ error: "not_a_member" }, 403);
    if (!canManagePrivilegedWorkspaceAccess(role)) {
      const inv = (await invitations.listActive(id)).find((item) => item.id === c.req.param("invId"));
      if (!inv) return c.json({ ok: true });
      if (inv.role !== "member") return c.json({ error: "forbidden" }, 403);
    }
    await invitations.revoke(id, c.req.param("invId"));
    return c.json({ ok: true });
  });

  // Board snapshot: tasks in the workspace (membership-gated).
  app.get("/:id/tasks", async (c) => {
    const workspaceId = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), workspaceId))) {
      return c.json({ error: "not_a_member" }, 403);
    }
    const includeBackgroundDebug = c.req.query("includeBackgroundDebug") === "true" || c.req.query("includeScheduled") === "true";
    const rows = await tasks.list({ workspaceId }, { includeBackgroundDebug });
    const localWorkerStatusCache = new Map<string, Promise<OwnerWorkerPresenceStatus>>();
    return c.json({
      tasks: await Promise.all(rows.map(async (t) => ({
        id: t.id,
        title: t.title,
        cardType: t.cardType,
        cardStatus: t.cardStatus,
        doneReason: t.doneReason ?? null,
        hidden: t.hidden,
        backgroundMode: t.backgroundMode ?? null,
        repo: t.repo,
        prUrl: t.prUrl,
        prNumber: t.prNumber,
        prState: t.prState,
        prTitle: t.prTitle,
        checksStatus: t.checksStatus,
        checks: t.checks,
        reviewDecision: t.reviewDecision,
        mergeable: t.mergeable,
        autoMergeEnabled: t.autoMergeEnabled,
        workerStatus: t.workerStatus,
        workerActive: t.workerActive,
        workerVenue: t.workerVenue,
        venueStatus: t.venueStatus,
        branch: t.branch,
        characterEmoji: t.characterEmoji,
        updatedAt: t.updatedAt,
        createdAt: t.createdAt,
        taskNumber: t.taskNumber ?? null,
        linearIssueIdentifier: t.linearIssueIdentifier ?? null,
        linearIssueUrl: t.linearIssueUrl ?? null,
        createdBy: t.createdBy ?? null,
        workerBackend: t.workerBackend,
        localWorkerStatus: await localWorkerStatusForOwner(t.createdBy ?? null, localWorkerStatusCache),
      }))),
    });
  });

  // Checkout-backed repo chat. It deliberately routes only to the signed-in
  // user's compatible laptop daemon: no teammate worker and no cloud fallback.
  app.get("/:id/repo-chat/status", async (c) => {
    const workspaceId = c.req.param("id");
    const userId = c.get("userId");
    if (!(await workspaces.isMember(userId, workspaceId))) return c.json({ error: "not_a_member" }, 403);
    return c.json({ available: availableQuestionWorkerCount(userId) > 0, models: await getRepoChatModels(workspaceId, userId) });
  });

  app.post("/:id/repo-chat", async (c) => {
    const workspaceId = c.req.param("id");
    const userId = c.get("userId");
    if (!(await workspaces.isMember(userId, workspaceId))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      repo?: string;
      model?: string;
      message?: string;
      history?: Array<{ role?: string; text?: string }>;
    };
    const message = body.message?.trim() ?? "";
    if (!message) return c.json({ error: "message_required" }, 400);
    if (!body.repo) return c.json({ error: "repo_required" }, 400);
    if (!body.model) return c.json({ error: "model_required" }, 400);

    const [repoRow, modelsView] = await Promise.all([
      repos.byOrgRepo({ workspaceId }, body.repo),
      getRepoChatModels(workspaceId, userId),
    ]);
    if (!repoRow?.enabled) return c.json({ error: "repo_not_enabled" }, 400);
    if (!modelsView.some((model) => model.id === body.model)) return c.json({ error: "model_not_available" }, 400);
    if (availableQuestionWorkerCount(userId) === 0) return c.json({ error: "local_worker_required" }, 409);

    const history = (body.history ?? [])
      .filter((line): line is { role: "user" | "assistant"; text: string } =>
        (line.role === "user" || line.role === "assistant") && typeof line.text === "string" && Boolean(line.text.trim()),
      )
      .slice(-20)
      .map((line) => `${line.role === "user" ? "User" : "Assistant"}: ${line.text.trim().slice(0, 8_000)}`)
      .join("\n\n");
    const question = history
      ? `Continue this repository chat. Conversation so far:\n\n${history}\n\nUser's new message:\n${message}`
      : message;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* client disconnected */ }
        };
        try {
          const result = await askWorkerQuestion(
            { workspaceId, repo: repoRow.orgRepo, question, backendId: body.model!, ownerUserId: userId },
            (text) => send("status", { message: text }),
            (event: AgentEvent) => send("agent_event", event),
          );
          if (result.ok) send("complete", { answer: result.answer });
          else send("error", { message: result.message || (result.reason === "no_worker" ? "A compatible local worker is required" : result.reason) });
        } catch (err) {
          send("error", { message: err instanceof Error ? err.message : String(err) });
        } finally {
          try { controller.close(); } catch { /* client disconnected */ }
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });

  // ── Repos ──────────────────────────────────────────────────────────
  app.get("/:id/repos", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    return c.json({ repos: await repos.list({ workspaceId: id }) });
  });

  app.post("/:id/repos", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { orgRepo?: string; defaultBranch?: string };
    if (!body.orgRepo || !/^[\w.-]+\/[\w.-]+$/.test(body.orgRepo)) {
      return c.json({ error: "orgRepo must be 'org/repo'" }, 400);
    }
    const repo = await repos.add(
      { workspaceId: id },
      { orgRepo: body.orgRepo, ...(body.defaultBranch ? { defaultBranch: body.defaultBranch } : {}) },
    );
    return c.json(repo, 201);
  });

  app.patch("/:id/repos/:repoId", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { setupCommands?: string; globalInstructions?: string; skillRepos?: Array<{ repo: string; path?: string }> };
    const skillRepos = body.skillRepos
      ?.map((entry) => ({ repo: entry.repo.trim(), path: entry.path?.trim() || undefined }))
      .filter((entry) => entry.repo);
    const repo = await repos.update({ workspaceId: id }, c.req.param("repoId"), {
      ...(body.setupCommands !== undefined ? { setupCommands: body.setupCommands } : {}),
      ...(body.globalInstructions !== undefined ? { globalInstructions: body.globalInstructions } : {}),
      ...(body.skillRepos !== undefined ? { skillRepos } : {}),
    });
    return c.json(repo);
  });

  app.delete("/:id/repos/:repoId", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    await repos.remove({ workspaceId: id }, c.req.param("repoId"));
    return c.json({ ok: true });
  });

  app.get("/:id/repos/:repoId/personal", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const p = await repos.getPersonal(c.get("userId"), c.req.param("repoId"));
    return c.json({ instructions: p?.instructions ?? "" });
  });

  app.patch("/:id/repos/:repoId/personal", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { instructions?: string };
    const p = await repos.setPersonal(c.get("userId"), c.req.param("repoId"), body.instructions ?? "");
    return c.json({ instructions: p.instructions });
  });

  app.post("/:id/refresh-github-statuses", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    await refreshPrStates({ workspaceId: id });
    return c.json({ ok: true });
  });

  // ── GitHub PRs not yet tracked as Manta cards ─────────────────────────────
  // Each PR carries its author (login + avatar) so the board can show "my PRs"
  // and group by person in team mode. Tokens are minted per-repo from the
  // workspace's App installation — no shared PAT.
  app.get("/:id/github-prs", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);

    const repoList = await repos.list({ workspaceId: id });
    const { prisma } = await import("@manta/db");
    const trackedPrs = await prisma.task.findMany({
      where: { workspaceId: id, prNumber: { not: null }, archivedAt: null },
      select: { repo: true, prNumber: true },
    });
    const trackedSet = new Set(trackedPrs.map((t) => `${t.repo}#${t.prNumber}`));

    const allPrs: Array<{
      number: number; title: string; url: string;
      branch: string; repo: string; updatedAt: string; state: string;
      author: { login: string; avatarUrl: string } | null;
    }> = [];

    await Promise.all(repoList.map(async (repo) => {
      const token = await tokenForWorkspaceRepo(id, repo.orgRepo);
      if (!token) return; // GitHub not connected for this workspace
      const [owner, repoName] = repo.orgRepo.split("/");
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/pulls?state=open&per_page=50`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );
        if (!res.ok) return;
        const prs = await res.json() as Array<{
          number: number; title: string; html_url: string;
          head: { ref: string }; updated_at: string; state: string;
          user: { login: string; avatar_url: string } | null;
        }>;
        for (const pr of prs) {
          if (!trackedSet.has(`${repo.orgRepo}#${pr.number}`)) {
            allPrs.push({
              number: pr.number,
              title: pr.title,
              url: pr.html_url,
              branch: pr.head.ref,
              repo: repo.orgRepo,
              updatedAt: pr.updated_at,
              state: pr.state,
              author: pr.user ? { login: pr.user.login, avatarUrl: pr.user.avatar_url } : null,
            });
          }
        }
      } catch { /* ignore per-repo errors */ }
    }));

    allPrs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return c.json({ prs: allPrs });
  });

  // ── Repo file tree for @-mention autocomplete ─────────────────────────────
  app.get("/:id/repo-files", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);

    const orgRepo = c.req.query("orgRepo");
    if (!orgRepo || !/^[\w.-]+\/[\w.-]+$/.test(orgRepo)) return c.json({ error: "invalid_orgRepo" }, 400);

    const token = await tokenForWorkspaceRepo(id, orgRepo);
    if (!token) return c.json({ files: [] });

    const [owner, repo] = orgRepo.split("/");
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!res.ok) return c.json({ files: [] });
      const data = await res.json() as { tree: Array<{ path: string; type: string }> };
      const files = data.tree
        .filter((item) => item.type === "blob")
        .map((item) => item.path)
        .slice(0, 5000);
      return c.json({ files });
    } catch {
      return c.json({ files: [] });
    }
  });

  // ── Skill files from .claude/skills/*.md across all workspace repos ─────────
  app.get("/:id/skills", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);

    const repoList = await repos.list({ workspaceId: id });
    const skills: Array<{ name: string; repo: string }> = [];

    await Promise.all(repoList.map(async (repo) => {
      const token = await tokenForWorkspaceRepo(id, repo.orgRepo);
      if (!token) return;
      const [owner, repoName] = repo.orgRepo.split("/");
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/contents/.claude/skills`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );
        if (!res.ok) return;
        const files = await res.json() as Array<{ name: string; type: string }>;
        for (const file of files) {
          if (file.type === "file" && file.name.endsWith(".md")) {
            skills.push({ name: file.name.replace(/\.md$/, ""), repo: repo.orgRepo });
          }
        }
      } catch { /* ignore per-repo errors */ }
    }));

    return c.json({ skills });
  });

  // ── Create a card from an existing GitHub PR ───────────────────────────────
  app.post("/:id/cards/from-pr", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      repo?: string; prNumber?: number; prTitle?: string;
      prUrl?: string; prState?: string; branch?: string;
    };
    if (!body.repo) return c.json({ error: "repo_required" }, 400);
    if (!body.prNumber) return c.json({ error: "prNumber_required" }, 400);

    const title = body.prTitle?.trim() || `PR #${body.prNumber}`;
    const task = await tasks.create(
      { workspaceId: id },
      {
        name: slugify(title),
        title,
        description: "",
        kind: "agent",
        cardType: "interactive",
        repo: body.repo,
        workerBackend: await firstAvailableCardBackendForUser(id, c.get("userId")),
        cardStatus: "pr_review",
        createdBy: c.get("userId"),
      },
    );
    const { prisma } = await import("@manta/db");
    await prisma.task.update({
      where: { id: task.id },
      data: {
        prNumber: body.prNumber,
        prUrl: body.prUrl ?? null,
        prTitle: body.prTitle ?? null,
        prState: body.prState ?? "open",
        branch: body.branch ?? null,
      },
    });
    return c.json({ id: task.id, cardStatus: "pr_review" }, 201);
  });

  // ── Create a card directly (the New-card modal) ─────────────────────
  const STATUS_BY_TYPE: Record<CardType, CardStatus> = {
    bot: "bot_working",
    investigation: "bot_working",
    interactive: "interactive",
    backlog: "backlog",
    plan: "bot_working",
  };
  app.post("/:id/cards", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      prompt?: string; repo?: string; cardType?: CardType; workerBackend?: string; model?: string; workerVenue?: "laptop" | "daytona"; linearIssueIdentifier?: string;
    };
    if (!body.prompt?.trim()) return c.json({ error: "prompt_required" }, 400);
    if (!body.repo) return c.json({ error: "repo_required" }, 400);
    const cardType = body.cardType ?? "bot";
    const title = body.prompt.trim().split("\n")[0]!.slice(0, 72);
    const linearMetadata = await linearCardMetadataAndRepo(id, body.repo, body.linearIssueIdentifier);
    // Default model: explicit request → first model offered in the New-card
    // picker for this user → built-in fallback.
    const defaultBackend = await firstAvailableCardBackendForUser(id, c.get("userId"));
    const task = await tasks.create(
      { workspaceId: id },
      {
        name: slugify(title),
        title,
        description: body.prompt.trim(),
        kind: "agent",
        cardType,
        repo: linearMetadata.repo,
        workerBackend: body.workerBackend ?? defaultBackend,
        cardStatus: STATUS_BY_TYPE[cardType],
        ...(cardType === "investigation" ? { type: "investigation" as const } : {}),
        createdBy: c.get("userId"),
        ...(linearMetadata.linearIssueIdentifier ? { linearIssueIdentifier: linearMetadata.linearIssueIdentifier } : {}),
        ...(linearMetadata.linearIssueUrl ? { linearIssueUrl: linearMetadata.linearIssueUrl } : {}),
        ...(body.model ? { model: body.model } : {}),
      },
    );
    // Persist the prompt synchronously so it's in the DB before the client subscribes.
    // This also gives non-worker cards (backlog) an initial chat transcript.
    await messages.append({ workspaceId: id }, { channel: task.id, role: "user", content: body.prompt.trim() });
    // Any card that lands in an active work status needs a worker. The helper
    // atomically claims the worker slot so every creation source follows the same
    // assignment path.
    await startWorkerForTask(task, body.prompt.trim(), {
      messageAlreadyPersisted: true,
      forceCloud: body.workerVenue === "daytona",
    });
    return c.json({ id: task.id, cardStatus: task.cardStatus }, 201);
  });

  app.route("/", createSpotCheckRoutes({ brainBackendId: deps.brainBackendId, defaultBrainPrompt: deps.defaultBrainPrompt }));

  // ── Task detail + mutations ────────────────────────────────────────────────

  // Full task detail (description, checklist, PR fields).
  app.get("/:id/tasks/:taskId", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);
    const owner = task.createdBy && task.createdBy !== c.get("userId") ? await users.byId(task.createdBy) : null;
    const localWorkerStatusCache = new Map<string, Promise<OwnerWorkerPresenceStatus>>();
    return c.json({
      id: task.id, title: task.title, description: task.description,
      cardType: task.cardType,
      cardStatus: task.cardStatus, doneReason: task.doneReason ?? null,
      hidden: task.hidden, backgroundMode: task.backgroundMode ?? null,
      workerStatus: task.workerStatus,
      workerActive: task.workerActive,
      workerVenue: task.workerVenue, venueStatus: task.venueStatus,
      repo: task.repo, branch: task.branch,
      prUrl: task.prUrl, prNumber: task.prNumber, prTitle: task.prTitle,
      prState: task.prState, checksStatus: task.checksStatus, checks: task.checks,
      reviewDecision: task.reviewDecision, mergeable: task.mergeable,
      autoMergeEnabled: task.autoMergeEnabled,
      checklist: task.checklist,
      terminalTabs: task.terminalTabs,
      planDocument: task.planDocument ?? null,
      characterEmoji: task.characterEmoji,
      updatedAt: task.updatedAt,
      createdAt: task.createdAt,
      taskNumber: task.taskNumber ?? null,
      linearIssueIdentifier: task.linearIssueIdentifier ?? null,
      linearIssueUrl: task.linearIssueUrl ?? null,
      createdBy: task.createdBy ?? null,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      workerBackend: task.workerBackend,
      localWorkerStatus: await localWorkerStatusForOwner(task.createdBy ?? null, localWorkerStatusCache),
    });
  });

  app.post("/:id/tasks/:taskId/messages", async (c) => {
    const workspaceId = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), workspaceId))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    const message = body.message?.trim();
    if (!message) return c.json({ error: "message_required" }, 400);
    const accepted = await acceptTaskMessage(workspaceId, c.req.param("taskId"), message);
    if (!accepted) return c.json({ error: "not_found" }, 404);
    if (!accepted.dispatched) return c.json({ error: "worker_not_started", taskId: accepted.task.id }, 503);
    return c.json({ ok: true, taskId: accepted.task.id }, 202);
  });

  // Standalone task transcript view. Returns the durable message log for the
  // card so a permalink can show the conversation without opening the board UI.
  app.get("/:id/tasks/:taskId/transcript", async (c) => {
    const id = c.req.param("id");
    const taskId = c.req.param("taskId");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const task = await tasks.get({ workspaceId: id }, taskId);
    if (!task) return c.json({ error: "not_found" }, 404);
    const scope = { workspaceId: id };
    const [rows, totalMessages] = await Promise.all([
      messages.list(scope, taskId, { limit: TRANSCRIPT_MESSAGE_LIMIT }),
      messages.count(scope, taskId),
    ]);
    return c.json({
      task: {
        id: task.id,
        title: task.title,
        repo: task.repo,
        branch: task.branch,
        cardStatus: task.cardStatus,
        prUrl: task.prUrl,
        prNumber: task.prNumber,
        linearIssueIdentifier: task.linearIssueIdentifier,
        linearIssueUrl: task.linearIssueUrl,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      messages: rows.map((m) => ({
        id: m.id,
        seq: m.seq,
        role: m.role,
        content: m.content,
        meta: m.meta,
        ts: m.ts,
      })),
      truncated: totalMessages > rows.length,
      totalMessages,
      messageLimit: TRANSCRIPT_MESSAGE_LIMIT,
    });
  });

  // Manually link a GitHub PR URL to an existing task.
  app.patch("/:id/tasks/:taskId/pr", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { prUrl?: string };
    const parsed = body.prUrl ? parseGithubPrUrl(body.prUrl) : null;
    if (!parsed) return c.json({ error: "invalid_github_pr_url" }, 400);

    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);
    if (task.repo.toLowerCase() !== parsed.orgRepo.toLowerCase()) return c.json({ error: "pr_repo_mismatch" }, 422);
    const linked = { ...parsed, orgRepo: task.repo, htmlUrl: `https://github.com/${task.repo}/pull/${parsed.prNumber}` };

    const { prisma } = await import("@manta/db");
    const existing = await prisma.task.findFirst({
      where: {
        workspaceId: id,
        repo: linked.orgRepo,
        prNumber: linked.prNumber,
        archivedAt: null,
        id: { not: task.id },
      },
      select: { id: true },
    });
    if (existing) return c.json({ error: "pr_already_linked" }, 409);

    const metadata = await fetchGithubPrMetadata(id, linked);
    await Promise.all([
      tasks.setPr({ workspaceId: id }, task.id, {
        prNumber: linked.prNumber,
        prUrl: metadata?.url ?? linked.htmlUrl,
        prTitle: metadata?.title ?? `PR #${linked.prNumber}`,
        prState: metadata?.state ?? "open",
        prUpdatedAt: new Date(),
      }),
      metadata?.branch ? tasks.setWorker({ workspaceId: id }, task.id, { branch: metadata.branch }) : Promise.resolve(),
    ]);

    bus.publish(kanbanTopic(id), {});
    bus.publish(chanTopic(id, task.id), { type: "task_updated" });
    void refreshPrStates({ taskId: task.id }).catch(() => {});
    return c.json({ id: task.id, prNumber: linked.prNumber, prUrl: metadata?.url ?? linked.htmlUrl });
  });

  // Toggle Manta-managed auto-merge for this task's PR.
  app.patch("/:id/tasks/:taskId/auto-merge", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled_required" }, 400);
    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);
    if (body.enabled && !task.prNumber) return c.json({ error: "task_has_no_pr" }, 422);
    if (body.enabled && (task.cardStatus === "done" || task.cardStatus === "canceled" || task.prState === "closed")) {
      return c.json({ error: "pr_not_open" }, 422);
    }
    const { prisma } = await import("@manta/db");
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { autoMergeEnabled: body.enabled },
      select: { id: true, autoMergeEnabled: true },
    });
    bus.publish(kanbanTopic(id), {});
    bus.publish(chanTopic(id, task.id), { type: "task_updated" });
    if (body.enabled) void refreshPrStates({ taskId: task.id }).catch(() => {});
    return c.json(updated);
  });

  // Switch the model/backend for a task (takes effect on next worker turn).
  app.patch("/:id/tasks/:taskId/model", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { workerBackend?: unknown };
    if (typeof body.workerBackend !== "string" || !body.workerBackend.trim()) {
      return c.json({ error: "workerBackend_required" }, 400);
    }
    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);
    const { prisma } = await import("@manta/db");
    await prisma.task.updateMany({
      where: { id: task.id, workspaceId: id },
      data: { workerBackend: body.workerBackend },
    });
    bus.publish(kanbanTopic(id), {});
    bus.publish(chanTopic(id, task.id), { type: "task_updated" });
    return c.json({ id: task.id, workerBackend: body.workerBackend });
  });

  // Reassign a card to another workspace member. `createdBy` is the board owner
  // field used for Mine/team filtering and for owner-routed local workers on
  // future turns, so changing it moves the card to that user's queue.
  app.patch("/:id/tasks/:taskId/assignee", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { userId?: unknown };
    if (typeof body.userId !== "string" || !body.userId.trim()) return c.json({ error: "userId_required" }, 400);
    if (!(await workspaces.isMember(body.userId, id))) return c.json({ error: "assignee_not_a_member" }, 422);

    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: { createdBy: body.userId },
      select: { id: true, createdBy: true },
    });
    bus.publish(kanbanTopic(id), {});
    bus.publish(chanTopic(id, task.id), { type: "task_updated" });
    return c.json(updated);
  });

  // Overwrite the task's checklist (full replace — client owns the full array).
  app.patch("/:id/tasks/:taskId/checklist", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { items?: unknown };
    if (!Array.isArray(body.items)) return c.json({ error: "items_required" }, 400);
    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);
    const { prisma } = await import("@manta/db");
    await prisma.task.update({ where: { id: task.id }, data: { checklist: body.items } });
    return c.json({ ok: true });
  });

  app.patch("/:id/tasks/:taskId/terminal-tabs", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { tabs?: unknown; activeTerminalId?: unknown };
    const tabs = Array.isArray(body.tabs)
      ? body.tabs.filter((tab): tab is { id: string; label: string } => {
        if (!tab || typeof tab !== "object") return false;
        const t = tab as { id?: unknown; label?: unknown };
        return typeof t.id === "string" && t.id !== "" && t.id !== "plan" && typeof t.label === "string" && t.label !== "";
      })
      : [];
    if (tabs.length === 0) return c.json({ error: "tabs_required" }, 400);
    const activeTerminalId = typeof body.activeTerminalId === "string" && tabs.some((tab) => tab.id === body.activeTerminalId)
      ? body.activeTerminalId
      : tabs[0]!.id;
    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);
    const { prisma } = await import("@manta/db");
    await prisma.task.update({ where: { id: task.id }, data: { terminalTabs: { tabs, activeTerminalId } } });
    return c.json({ ok: true });
  });

  // Human-initiated status transition (drag-drop, manual moves).
  app.patch("/:id/tasks/:taskId/status", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      to?: string; doneReason?: string;
    };
    if (!body.to) return c.json({ error: "to_required" }, 400);
    const to = body.to as import("@manta/db").CardStatus;
    const scope = { workspaceId: id };
    const taskId = c.req.param("taskId");
    try {
      const previous = await tasks.get(scope, taskId);
      if (!previous) return c.json({ error: "not_found" }, 404);

      // A human dragging on the board is an explicit, intentional move, so it
      // may go to any column — force past the kanban edge allow-list (which
      // exists to discipline the automated actors). Side effects below still run.
      let updated = await tasks.transition(
        scope,
        taskId,
        to,
        "human",
        { force: true, ...(body.doneReason ? { doneReason: body.doneReason as import("@manta/db").DoneReason } : {}) },
      );

      // Moving an approved plan card back into Working means “implement the
      // reviewed plan now”, not “produce another plan”. Flip the card back to a
      // normal bot task before dispatch so the worker prompt allows writes.
      if (updated.cardStatus === "bot_working" && updated.cardType === "plan" && updated.planDocument?.trim()) {
        updated = await prisma.task.update({ where: { id: updated.id }, data: { cardType: "bot" } });
      }

      // Dragging a card into Working is an explicit "go" — kick off a worker turn
      // so the card actually starts, instead of sitting in bot_working with no
      // worker. The synthetic prompt tells the bot to either finish autonomously
      // or bounce back to Needs Help for clarification (mirrors the resurrect flow).
      // startWorkerForTask performs an atomic claim: it ensures duplicate/concurrent
      // moves (a double drag) can't each spawn a worker — exactly one wins.
      if (updated.cardStatus === "bot_working") {
        const startMessage = previous.cardType === "plan" && updated.planDocument?.trim()
          ? `The user approved this plan-mode card and moved it into Working. Implement the approved plan below; if you need clarification, move the card back to Needs Help and ask.\n\nApproved plan document:\n\n${updated.planDocument.trim()}`
          : "The user moved this card into Working. If you know what to do, work autonomously to finish it. If you need clarification, move the card back to Needs Help and ask.";
        const started = await startWorkerForTask(
          updated,
          startMessage,
        );
        // A card outside active-compute columns can still carry a stale
        // workerActive=true/workerStatus=running flag from an interrupted or
        // raced prior turn. In that state the atomic claim above correctly
        // refuses to double-start an *active* task, but for a human drag from a
        // non-active column it would otherwise leave the card stuck in Working
        // with no new worker. Clear only that stale non-active-column flag and
        // retry the claim.
        if (!started && previous.workerActive && previous.cardStatus !== "bot_working" && previous.cardStatus !== "interactive") {
          await tasks.setWorker(scope, updated.id, { workerActive: false });
          await startWorkerForTask(updated, startMessage);
        }
      }

      // Terminal board states mean the board no longer wants active compute or
      // lingering shells for that task. Ask the worker to abort task work and
      // kill every PTY, close server relays, and fully remove cloud boxes.
      const terminalStatus = updated.cardStatus === "done" || updated.cardStatus === "canceled";
      const leavingActiveCompute =
        (previous.cardStatus === "bot_working" || previous.cardStatus === "interactive") &&
        updated.cardStatus !== "bot_working" &&
        updated.cardStatus !== "interactive";
      if (terminalStatus) {
        closeTaskTerminalRelays(updated.id);
        disposeTaskWorker(updated.id);
        await tasks.setWorker(scope, updated.id, {
          workerActive: false,
          workerStatus: updated.cardStatus === "done" ? "done" : "failed",
          venueStatus: "idle",
        });
        if (previous.workerVenue === "daytona") {
          void removeCloudSandbox(previous);
        }
      } else if (leavingActiveCompute) {
        // Conversely, dragging a card out of Bot Working / Interactive means the
        // board no longer wants active compute for that task. Stop Daytona boxes
        // immediately; laptop turns are cooperative, so mark them inactive/idle in
        // the DB and release active-turn routing while preserving terminal access.
        await tasks.setWorker(scope, updated.id, { workerActive: false, venueStatus: "idle" });
        freeTaskWorker(updated.id);
        if (previous.workerVenue === "daytona") {
          void stopCloudSandbox(previous);
        }
      }
      return c.json({ id: updated.id, cardStatus: updated.cardStatus });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "transition_failed" }, 422);
    }
  });

  // Clear the Investigation Complete column: mark the given investigation-complete
  // cards done. The ids come from the board, so it clears exactly what the member
  // sees (their repo lane / Mine-or-Team scope); each id is re-checked server-side
  // and skipped unless it is still investigation_complete in this workspace.
  app.post("/:id/tasks/clear-investigation-complete", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { taskIds?: unknown };
    const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((v): v is string => typeof v === "string") : [];
    const scope = { workspaceId: id };
    const cleared: string[] = [];
    for (const taskId of taskIds) {
      const task = await tasks.get(scope, taskId);
      if (!task || task.cardStatus !== "investigation_complete") continue;
      try {
        const updated = await tasks.transition(scope, taskId, "done", "human", { doneReason: "completed" });
        // Mirror the terminal-state cleanup the human status route does on →done.
        closeTaskTerminalRelays(updated.id);
        disposeTaskWorker(updated.id);
        await tasks.setWorker(scope, updated.id, { workerActive: false, workerStatus: "done", venueStatus: "idle" });
        if (task.workerVenue === "daytona") void removeCloudSandbox(task);
        cleared.push(updated.id);
      } catch {
        // Skip any card that can't transition; clear the rest.
      }
    }
    return c.json({ cleared: cleared.length, ids: cleared });
  });

  // Resurrect a needs_help task: transition back to bot_working and spawn a new worker turn.
  app.post("/:id/tasks/:taskId/resurrect", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { instruction?: string };
    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);

    if (task.cardStatus !== "needs_help") {
      return c.json({ error: "task_not_stuck", cardStatus: task.cardStatus }, 422);
    }
    const priorMessages = await messages.list({ workspaceId: id }, task.id, { limit: 100 });
    const transitioned = await tasks.transition({ workspaceId: id }, task.id, "bot_working", "human", {});
    const updated = transitioned.cardType === "plan" && transitioned.planDocument?.trim()
      ? await prisma.task.update({ where: { id: transitioned.id }, data: { cardType: "bot" } })
      : transitioned;
    const msg = buildWorkerResumeMessage(updated, priorMessages, body.instruction);
    await startWorkerForTask(updated, msg);
    return c.json({ id: updated.id, cardStatus: updated.cardStatus });
  });

  // Ask the worker to resolve merge conflicts on an open PR and push the fix.
  app.post("/:id/tasks/:taskId/fix-conflicts", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);
    if (!task.prNumber || task.mergeable !== "CONFLICTING") return c.json({ error: "task_has_no_conflicts" }, 422);
    const activeLaptopWorker = task.workerActive && task.workerVenue === "laptop";
    if (task.workerActive && !activeLaptopWorker) return c.json({ error: "worker_is_busy" }, 422);

    const updated = task.cardStatus === "bot_working"
      ? task
      : await tasks.transition({ workspaceId: id }, task.id, "bot_working", "human", { reason: "fix conflicts" });
    const message = "Please fix the merge conflicts on this PR and push the resolved branch.";
    if (activeLaptopWorker) {
      // Laptop workers are intentionally multi-task. If a locally-owned task is
      // still marked active (for example a previous turn is running or the flag
      // is stale after a local turn), don't block the explicit conflict-fix
      // request with worker_is_busy; dispatch another local turn instead.
      spawnWorker(updated, message);
    } else {
      await startWorkerForTask(updated, message);
    }
    return c.json({ id: updated.id, cardStatus: updated.cardStatus });
  });

  // Ask the worker to fix failing checks on an open PR and push the fix.
  app.post("/:id/tasks/:taskId/fix-checks", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const task = await tasks.get({ workspaceId: id }, c.req.param("taskId"));
    if (!task) return c.json({ error: "not_found" }, 404);
    if (!task.prNumber || task.checksStatus !== "failing") return c.json({ error: "task_has_no_failing_checks" }, 422);
    const activeLaptopWorker = task.workerActive && task.workerVenue === "laptop";
    if (task.workerActive && !activeLaptopWorker) return c.json({ error: "worker_is_busy" }, 422);

    const updated = task.cardStatus === "bot_working"
      ? task
      : await tasks.transition({ workspaceId: id }, task.id, "bot_working", "human", { reason: "fix checks" });
    const names = failingCheckNames(task.checks);
    const checkLabel = names.length ? ` (${names.join(", ")})` : "";
    const message = `Please investigate the failing checks${checkLabel} on this PR, fix the failures, and push the resolved branch.`;
    if (activeLaptopWorker) {
      spawnWorker(updated, message);
    } else {
      await startWorkerForTask(updated, message);
    }
    return c.json({ id: updated.id, cardStatus: updated.cardStatus });
  });

  // Archive (soft-delete) a task.
  app.delete("/:id/tasks/:taskId", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const { prisma } = await import("@manta/db");
    const task = await prisma.task.findUnique({ where: { id: c.req.param("taskId") }, select: { workspaceId: true } });
    if (!task || task.workspaceId !== id) return c.json({ error: "not_found" }, 404);
    await prisma.task.update({ where: { id: c.req.param("taskId") }, data: { archivedAt: new Date() } });
    // Archiving a task is terminal — tear down its cloud sandbox now so it stops
    // billing and leaves the popup immediately (the reconciler is the backstop).
    // Fire-and-forget so archive stays snappy; removeCloudSandbox never throws.
    void removeCloudSandbox({ id: c.req.param("taskId"), workspaceId: id });
    return c.json({ ok: true });
  });

  // Chat with the brain for this workspace (one turn).
  app.post("/:id/chat", async (c) => {
    const workspaceId = c.req.param("id");
    const userId = c.get("userId");
    if (!(await workspaces.isMember(userId, workspaceId))) {
      return c.json({ error: "not_a_member" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    if (!body.message) return c.json({ error: "message_required" }, 400);

    const [ws, settings, repoRows] = await Promise.all([
      workspaces.byId(workspaceId),
      workspaces.getSettings(workspaceId),
      repos.list({ workspaceId }),
    ]);
    const backendId = settings.defaultModel || deps.brainBackendId;
    const result = await runBrainTurn({
      scope: { workspaceId },
      channel: "brain",
      userMessage: body.message,
      backend: deps.brainBackend,
      backendId,
      tools: deps.brainTools,
      userId,
      promptParts: {
        basePrompt: ws?.brainPrompt?.trim() || deps.defaultBrainPrompt,
        teamMemory: ws?.teamMemory,
        workspaceRepos: repoRows.filter((repo) => repo.enabled).map((repo) => ({ orgRepo: repo.orgRepo, defaultBranch: repo.defaultBranch })),
      },
    });

    return c.json({
      assistantText: result.assistantText,
      toolsUsed: result.events.filter((e) => e.type === "tool_use").map((e) => (e.type === "tool_use" ? e.toolName : "")),
      terminalReason: result.terminalReason,
    });
  });

  // ── Slack bots (multi-bot registration) ────────────────────────────────────
  // One workspace ↔ one Slack workspace ↔ many bots. Each bot is its own Slack
  // app; we validate its token via auth.test, discover its api_app_id (the
  // inbound-event routing key) via bots.info, and store both secrets encrypted.

  const BOT_TYPES = ["slack", "linear"] as const;
  const SPAWN_POLICIES = ["auto", "never"] as const;
  const SCHEDULE_CADENCES = ["daily", "weekly"] as const;

  // Never leak the encrypted secrets back to the client.
  function sanitizeBot(bot: SlackBot) {
    return {
      id: bot.id,
      name: bot.name,
      slackAppId: bot.slackAppId,
      teamId: bot.teamId,
      botUserId: bot.botUserId,
      instructions: bot.instructions,
      botType: bot.botType,
      autoRespondChannels: bot.autoRespondChannels,
      autoRespondChannelInstructions: (bot.autoRespondChannelInstructions ?? {}) as Record<string, string>,
      spawnCardPolicy: bot.spawnCardPolicy,
      defaultRepo: bot.defaultRepo,
      enabled: bot.enabled,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    };
  }

  function sanitizeMessageSchedule(schedule: SlackMessageSchedule) {
    return {
      id: schedule.id,
      slackBotId: schedule.slackBotId,
      name: schedule.name,
      channelId: schedule.channelId,
      repo: schedule.repo,
      prompt: schedule.prompt,
      cadence: schedule.cadence,
      timeOfDayUtc: schedule.timeOfDayUtc,
      daysOfWeek: schedule.daysOfWeek,
      timeZone: schedule.timeZone,
      includeWeekendsAndHolidays: schedule.includeWeekendsAndHolidays,
      enabled: schedule.enabled,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      lastError: schedule.lastError,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    };
  }

  // Validate a bot token and discover (teamId, botUserId, slackAppId). Returns
  // null if the token is bad or the app id can't be determined.
  async function inspectBotToken(
    botToken: string,
  ): Promise<{ teamId: string; botUserId: string | null; slackAppId: string } | null> {
    const client = new WebClient(botToken);
    const auth = await client.auth.test().catch(() => null);
    if (!auth?.ok || !auth.team_id) return null;
    const botSlackId = auth.bot_id ? String(auth.bot_id) : undefined;
    if (!botSlackId) return null;
    const info = await client.bots.info({ bot: botSlackId }).catch(() => null);
    const slackAppId = info?.bot?.app_id ? String(info.bot.app_id) : undefined;
    if (!slackAppId) return null;
    return {
      teamId: String(auth.team_id),
      botUserId: auth.user_id ? String(auth.user_id) : null,
      slackAppId,
    };
  }

  app.get("/:id/slack/bots", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const bots = await slack.listBots(id);
    return c.json({ bots: bots.map(sanitizeBot) });
  });

  async function validateDefaultRepo(workspaceId: string, value: string | null | undefined): Promise<string | null> {
    const repo = value?.trim();
    if (!repo) return null;
    const found = await prisma.repo.findFirst({ where: { workspaceId, orgRepo: repo, enabled: true }, select: { orgRepo: true } });
    if (!found) throw new Error("invalid_default_repo");
    return found.orgRepo;
  }

  function cleanChannelInstructions(value: Record<string, unknown> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [channelId, instructions] of Object.entries(value ?? {})) {
      const id = channelId.trim();
      const text = typeof instructions === "string" ? instructions.trim() : "";
      if (/^C[A-Z0-9]+$/.test(id) && text) out[id] = text;
    }
    return out;
  }

  app.post("/:id/slack/bots", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      instructions?: string;
      botType?: string;
      botToken?: string;
      signingSecret?: string;
      autoRespondChannels?: string[];
      autoRespondChannelInstructions?: Record<string, unknown>;
      spawnCardPolicy?: string;
      defaultRepo?: string | null;
    };
    if (!body.name?.trim()) return c.json({ error: "name_required" }, 400);
    if (!body.botToken?.trim()) return c.json({ error: "bot_token_required" }, 400);
    if (!body.signingSecret?.trim()) return c.json({ error: "signing_secret_required" }, 400);

    const inspected = await inspectBotToken(body.botToken.trim());
    if (!inspected) return c.json({ error: "invalid_bot_token" }, 400);
    let defaultRepo: string | null;
    try {
      defaultRepo = await validateDefaultRepo(id, body.defaultRepo);
    } catch {
      return c.json({ error: "invalid_default_repo" }, 400);
    }

    // Enforce one Slack team per workspace: all of a workspace's bots must live in
    // the same Slack workspace, and that team must not already belong elsewhere.
    const existingTeam = await slack.findSlackTeamForWorkspace(id);
    if (existingTeam && existingTeam !== inspected.teamId) {
      return c.json({ error: "workspace_has_different_slack_team" }, 409);
    }
    const teamOwner = await slack.findWorkspaceBySlackTeam(inspected.teamId);
    if (teamOwner && teamOwner !== id) {
      return c.json({ error: "slack_team_linked_to_another_workspace" }, 409);
    }

    try {
      const bot = await slack.createBot(id, {
        name: body.name.trim(),
        slackAppId: inspected.slackAppId,
        teamId: inspected.teamId,
        botUserId: inspected.botUserId,
        instructions: body.instructions ?? "",
        botTokenCipher: encrypt(body.botToken.trim()),
        signingSecretCipher: encrypt(body.signingSecret.trim()),
        ...(body.botType && (BOT_TYPES as readonly string[]).includes(body.botType)
          ? { botType: body.botType as SlackBotType }
          : {}),
        ...(body.autoRespondChannels ? { autoRespondChannels: body.autoRespondChannels } : {}),
        ...(body.autoRespondChannelInstructions ? { autoRespondChannelInstructions: cleanChannelInstructions(body.autoRespondChannelInstructions) } : {}),
        ...(body.spawnCardPolicy && (SPAWN_POLICIES as readonly string[]).includes(body.spawnCardPolicy)
          ? { spawnCardPolicy: body.spawnCardPolicy as SpawnCardPolicy }
          : {}),
        defaultRepo,
      });
      // Record the team↔workspace mapping so the Integrations tab shows Slack on.
      await slack.linkSlackTeam(id, inspected.teamId);
      return c.json(sanitizeBot(bot));
    } catch (err) {
      // Unique violation on slackAppId ⇒ this Slack app is already registered.
      if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
        return c.json({ error: "bot_already_registered" }, 409);
      }
      throw err;
    }
  });

  app.patch("/:id/slack/bots/:botId", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const botId = c.req.param("botId");
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      instructions?: string;
      botType?: string;
      autoRespondChannels?: string[];
      autoRespondChannelInstructions?: Record<string, unknown>;
      spawnCardPolicy?: string;
      defaultRepo?: string | null;
      enabled?: boolean;
      botToken?: string;
      signingSecret?: string;
    };

    const data: slack.UpdateBotInput = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.instructions !== undefined) data.instructions = body.instructions;
    if (body.botType && (BOT_TYPES as readonly string[]).includes(body.botType)) data.botType = body.botType as SlackBotType;
    if (body.autoRespondChannels !== undefined) data.autoRespondChannels = body.autoRespondChannels;
    if (body.autoRespondChannelInstructions !== undefined) data.autoRespondChannelInstructions = cleanChannelInstructions(body.autoRespondChannelInstructions);
    if (body.spawnCardPolicy && (SPAWN_POLICIES as readonly string[]).includes(body.spawnCardPolicy)) {
      data.spawnCardPolicy = body.spawnCardPolicy as SpawnCardPolicy;
    }
    if (body.defaultRepo !== undefined) {
      try {
        data.defaultRepo = await validateDefaultRepo(id, body.defaultRepo);
      } catch {
        return c.json({ error: "invalid_default_repo" }, 400);
      }
    }
    if (body.enabled !== undefined) data.enabled = body.enabled;

    // Optional secret rotation: re-validate the new token and refresh the derived
    // identity fields (team/botUser/appId can change if the app was recreated).
    if (body.botToken?.trim()) {
      const inspected = await inspectBotToken(body.botToken.trim());
      if (!inspected) return c.json({ error: "invalid_bot_token" }, 400);
      data.botTokenCipher = encrypt(body.botToken.trim());
      data.teamId = inspected.teamId;
      data.botUserId = inspected.botUserId;
      data.slackAppId = inspected.slackAppId;
    }
    if (body.signingSecret?.trim()) data.signingSecretCipher = encrypt(body.signingSecret.trim());

    try {
      const updated = await slack.updateBot(id, botId, data);
      if (!updated) return c.json({ error: "not_found" }, 404);
      return c.json(sanitizeBot(updated));
    } catch (err) {
      // Rotating to a token whose app id collides with another registered bot.
      if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
        return c.json({ error: "bot_already_registered" }, 409);
      }
      throw err;
    }
  });

  app.delete("/:id/slack/bots/:botId", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    await slack.deleteBot(id, c.req.param("botId"));
    return c.json({ ok: true });
  });

  // List the channels a bot can see, to populate the auto-respond picker. Include
  // private channels the bot has been invited to so saved auto-response channels
  // can render as #name instead of falling back to the raw channel ID.
  app.get("/:id/slack/bots/:botId/channels", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const bot = await slack.getBot(id, c.req.param("botId"));
    if (!bot) return c.json({ error: "not_found" }, 404);
    const client = new WebClient(decrypt(Buffer.from(bot.botTokenCipher)));
    const channels: { id: string; name: string }[] = [];
    // Fetch each conversation type independently. Slack rejects the WHOLE
    // conversations.list call with missing_scope if you request a type you lack
    // the scope for (e.g. private_channel needs groups:read) — so a combined
    // "public_channel,private_channel" request returns nothing, even the public
    // channels you can see with channels:read. Querying per type degrades
    // gracefully: a missing scope on one type doesn't hide the other.
    let warning: string | undefined;
    for (const type of ["public_channel", "private_channel"] as const) {
      let cursor: string | undefined;
      do {
        const res = await client.conversations
          .list({ types: type, limit: 200, exclude_archived: true, ...(cursor ? { cursor } : {}) })
          .catch((e: { data?: { error?: string } }) => { warning = e?.data?.error ?? "slack_api_error"; return null; });
        if (!res) break;
        channels.push(...(res.channels ?? []).flatMap((ch) => (ch.id && ch.name ? [{ id: ch.id, name: ch.name }] : [])));
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
    }
    // Only report a warning if we genuinely found nothing — a missing groups:read
    // is harmless once public channels resolved.
    return c.json({ channels, ...(warning && channels.length === 0 ? { warning } : {}) });
  });

  function validateScheduleInput(body: {
    name?: unknown;
    slackBotId?: unknown;
    channelId?: unknown;
    repo?: unknown;
    prompt?: unknown;
    cadence?: unknown;
    timeOfDayUtc?: unknown;
    daysOfWeek?: unknown;
    timeZone?: unknown;
    includeWeekendsAndHolidays?: unknown;
    enabled?: unknown;
  }): { ok: true; value: {
    name: string;
    slackBotId: string;
    channelId: string;
    repo: string | null;
    prompt: string;
    cadence: SlackMessageScheduleCadence;
    timeOfDayUtc: string;
    daysOfWeek: number[];
    timeZone: string;
    includeWeekendsAndHolidays: boolean;
    enabled?: boolean;
  } } | { ok: false; error: string } {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const slackBotId = typeof body.slackBotId === "string" ? body.slackBotId.trim() : "";
    const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : null;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const cadence = typeof body.cadence === "string" && (SCHEDULE_CADENCES as readonly string[]).includes(body.cadence)
      ? body.cadence as SlackMessageScheduleCadence
      : null;
    const timeOfDayUtc = typeof body.timeOfDayUtc === "string" ? body.timeOfDayUtc.trim() : "";
    const daysOfWeek = Array.isArray(body.daysOfWeek)
      ? [...new Set(body.daysOfWeek.map(Number))].sort((a, b) => a - b)
      : [];
    const timeZone = typeof body.timeZone === "string" && body.timeZone.trim() ? body.timeZone.trim() : "UTC";
    const includeWeekendsAndHolidays = typeof body.includeWeekendsAndHolidays === "boolean" ? body.includeWeekendsAndHolidays : false;

    if (!name) return { ok: false, error: "name_required" };
    if (!slackBotId) return { ok: false, error: "slack_bot_required" };
    if (!channelId) return { ok: false, error: "channel_required" };
    if (!prompt) return { ok: false, error: "prompt_required" };
    if (!cadence) return { ok: false, error: "invalid_cadence" };
    if (!parseTimeOfDayUtc(timeOfDayUtc)) return { ok: false, error: "invalid_time_of_day" };
    let weeklyDays: number[] = [];
    if (cadence === "weekly") {
      if (daysOfWeek.length === 0 || daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        return { ok: false, error: "invalid_days_of_week" };
      }
      if (!includeWeekendsAndHolidays && daysOfWeek.every((day) => day === 0 || day === 6)) {
        return { ok: false, error: "weekend_days_require_inclusion" };
      }
      weeklyDays = daysOfWeek;
    }
    try {
      nextScheduleRunAt({ cadence, timeOfDayUtc, daysOfWeek: weeklyDays, timeZone, includeWeekendsAndHolidays });
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_schedule";
      return { ok: false, error: message };
    }
    return {
      ok: true,
      value: {
        name,
        slackBotId,
        channelId,
        repo,
        prompt,
        cadence,
        timeOfDayUtc,
        daysOfWeek: weeklyDays,
        timeZone,
        includeWeekendsAndHolidays,
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      },
    };
  }

  app.get("/:id/slack/message-schedules", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const schedules = await slack.listMessageSchedules(id);
    return c.json({ schedules: schedules.map(sanitizeMessageSchedule) });
  });

  app.post("/:id/slack/message-schedules", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const parsed = validateScheduleInput(await c.req.json().catch(() => ({})) as Record<string, unknown>);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const bot = await slack.getBot(id, parsed.value.slackBotId);
    if (!bot) return c.json({ error: "slack_bot_not_found" }, 404);
    let scheduleRepo: string | null;
    try {
      scheduleRepo = await validateDefaultRepo(id, parsed.value.repo ?? bot.defaultRepo ?? null);
    } catch {
      return c.json({ error: "invalid_repo" }, 400);
    }
    const schedule = await slack.createMessageSchedule(id, {
      ...parsed.value,
      repo: scheduleRepo,
      nextRunAt: nextScheduleRunAt({
        cadence: parsed.value.cadence,
        timeOfDayUtc: parsed.value.timeOfDayUtc,
        daysOfWeek: parsed.value.daysOfWeek,
        timeZone: parsed.value.timeZone,
        includeWeekendsAndHolidays: parsed.value.includeWeekendsAndHolidays,
      }),
    });
    return c.json(sanitizeMessageSchedule(schedule), 201);
  });

  app.post("/:id/slack/message-schedules/test", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const parsed = validateScheduleInput(await c.req.json().catch(() => ({})) as Record<string, unknown>);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const bot = await slack.getBot(id, parsed.value.slackBotId);
    if (!bot) return c.json({ error: "slack_bot_not_found" }, 404);
    const result = await generateScheduledSlackMessage({
      workspaceId: id,
      createdBy: c.get("userId"),
      repo: parsed.value.repo ?? bot.defaultRepo ?? null,
      prompt: parsed.value.prompt,
      backend: deps.brainBackend,
      backendId: deps.brainBackendId,
      defaultBrainPrompt: deps.defaultBrainPrompt,
      tools: deps.brainTools,
      preview: true,
    });
    if (!result.text) return c.json({ error: "empty_ai_message", taskId: result.taskId }, 502);
    return c.json({
      text: result.text,
      events: result.events,
      taskId: result.taskId,
      terminalReason: result.terminalReason ?? null,
    });
  });

  app.post("/:id/slack/message-schedules/test/stream", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const parsed = validateScheduleInput(await c.req.json().catch(() => ({})) as Record<string, unknown>);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const bot = await slack.getBot(id, parsed.value.slackBotId);
    if (!bot) return c.json({ error: "slack_bot_not_found" }, 404);

    const encoder = new TextEncoder();
    const writeLine = (controller: ReadableStreamDefaultController<Uint8Array>, value: unknown) => {
      controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
    };

    return c.body(new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            const result = await generateScheduledSlackMessage({
              workspaceId: id,
              createdBy: c.get("userId"),
              repo: parsed.value.repo ?? bot.defaultRepo ?? null,
              prompt: parsed.value.prompt,
              backend: deps.brainBackend,
              backendId: deps.brainBackendId,
              defaultBrainPrompt: deps.defaultBrainPrompt,
              tools: deps.brainTools,
              preview: true,
              signal: c.req.raw.signal,
              onTaskCreated: (taskId) => writeLine(controller, { type: "task", taskId }),
              onEvent: (event) => writeLine(controller, { type: "event", event }),
            });
            if (!result.text) writeLine(controller, { type: "error", error: "empty_ai_message", taskId: result.taskId });
            else writeLine(controller, { type: "result", text: result.text, taskId: result.taskId, terminalReason: result.terminalReason ?? null });
          } catch (err) {
            const message = err instanceof Error ? err.message : "scheduled_message_test_failed";
            writeLine(controller, { type: "error", error: message });
          } finally {
            controller.close();
          }
        })();
      },
    }), {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  });

  app.post("/:id/slack/message-schedules/test/post", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    const slackBotId = typeof body.slackBotId === "string" ? body.slackBotId.trim() : "";
    const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    if (!taskId) return c.json({ error: "test_task_required" }, 400);
    if (!slackBotId) return c.json({ error: "slack_bot_required" }, 400);
    if (!channelId) return c.json({ error: "channel_required" }, 400);

    const task = await tasks.get({ workspaceId: id }, taskId);
    const rows = await messages.list({ workspaceId: id }, taskId, { limit: 25 });
    const text = completedScheduledSlackPreviewText(task, rows, c.get("userId"));
    if (!text) return c.json({ error: "completed_test_not_found" }, 404);

    try {
      const result = await postWorkerSlackMessage({ workspaceId: id, bot: slackBotId, channelId, text });
      return c.json({ ok: true, channelId: result.channelId, messageTs: result.messageTs ?? null });
    } catch (err) {
      if (err instanceof WorkerSlackPostError) {
        const status = err.code === "slack_bot_unavailable" ? 404 : 400;
        return c.json({ error: err.code }, status);
      }
      return c.json({ error: "slack_post_failed" }, 502);
    }
  });

  app.patch("/:id/slack/message-schedules/:scheduleId", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const existing = await slack.getMessageSchedule(id, c.req.param("scheduleId"));
    if (!existing) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const candidate = {
      name: body.name ?? existing.name,
      slackBotId: body.slackBotId ?? existing.slackBotId,
      channelId: body.channelId ?? existing.channelId,
      repo: body.repo ?? existing.repo,
      prompt: body.prompt ?? existing.prompt,
      cadence: body.cadence ?? existing.cadence,
      timeOfDayUtc: body.timeOfDayUtc ?? existing.timeOfDayUtc,
      daysOfWeek: body.daysOfWeek ?? existing.daysOfWeek,
      timeZone: body.timeZone ?? existing.timeZone,
      includeWeekendsAndHolidays: body.includeWeekendsAndHolidays ?? existing.includeWeekendsAndHolidays,
      enabled: body.enabled ?? existing.enabled,
    };
    const parsed = validateScheduleInput(candidate);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const bot = await slack.getBot(id, parsed.value.slackBotId);
    if (!bot) return c.json({ error: "slack_bot_not_found" }, 404);
    let scheduleRepo: string | null;
    try {
      scheduleRepo = await validateDefaultRepo(id, parsed.value.repo ?? bot.defaultRepo ?? null);
    } catch {
      return c.json({ error: "invalid_repo" }, 400);
    }
    const timingChanged = body.cadence !== undefined || body.timeOfDayUtc !== undefined || body.daysOfWeek !== undefined || body.timeZone !== undefined || body.includeWeekendsAndHolidays !== undefined || (body.enabled === true && !existing.enabled);
    const updated = await slack.updateMessageSchedule(id, existing.id, {
      ...parsed.value,
      repo: scheduleRepo,
      ...(timingChanged ? { nextRunAt: nextScheduleRunAt({ cadence: parsed.value.cadence, timeOfDayUtc: parsed.value.timeOfDayUtc, daysOfWeek: parsed.value.daysOfWeek, timeZone: parsed.value.timeZone, includeWeekendsAndHolidays: parsed.value.includeWeekendsAndHolidays }) } : {}),
    });
    return c.json(sanitizeMessageSchedule(updated!));
  });

  app.delete("/:id/slack/message-schedules/:scheduleId", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    await slack.deleteMessageSchedule(id, c.req.param("scheduleId"));
    return c.json({ ok: true });
  });

  // Upload an image attachment. Returns a permanent URL the worker can download
  // and embed in Pi's context as a local file path (avoids sending raw base64
  // in the task message, which blows up the Pi session context window).
  app.post("/:id/images", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const { mimeType, data } = await c.req.json<{ mimeType: string; data: string }>();
    if (!mimeType || !data) return c.json({ error: "missing_fields" }, 400);
    if (!mimeType.startsWith("image/")) return c.json({ error: "invalid_mime_type" }, 400);
    const image = await cardImages.create({ workspaceId: id }, { mimeType, data });
    return c.json({ url: `/api/images/${image.id}` });
  });

  app.get("/:id/integrations", async (c) => {
    const id = c.req.param("id");
    if (!(await workspaces.isMember(c.get("userId"), id))) return c.json({ error: "not_a_member" }, 403);
    const { prisma } = await import("@manta/db");
    const identities = await prisma.workspaceIdentity.findMany({ where: { workspaceId: id } });
    return c.json({ providers: identities.map((i) => i.provider) });
  });

  return app;
}
