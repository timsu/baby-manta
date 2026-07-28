// HTTP API for external worker daemons — authenticated with a per-user worker
// token (the same credential used to register over /worker-ws). Exposes
// control-plane operations workers need without a direct database connection
// (report_pr, update_checklist, etc.).
//
// Auth: `Authorization: Bearer <workerToken>` header. The token resolves to the
// owning user; mutations are additionally checked against that user's workspace
// membership so a token can only touch workspaces its owner belongs to.

import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { tasks, prisma, workspaces, repos, messages, workerCredentials, sandboxCredentials, users, inbox, slack, agentSessions } from "@manta/db";
import type { AgentBackend, ToolDefinition } from "@manta/agent";
import { bus, chanTopic, kanbanTopic } from "../bus.ts";
import { createLogger } from "../logger.ts";
import { createPr, mintInstallationToken, isConfigured as githubAppConfigured } from "../github/app.ts";
import { routeNonEngineerPrReview } from "../github/reviewRouting.ts";
import { githubPrTokenSourceForTask, githubUserTokenStatusForTask } from "../github/userTokens.ts";
import { brainBackendIdFor, firstAvailableCardBackendForUser, getModelsView, setProvider, setUserProvider } from "../models/service.ts";
import { linearTokenForWorkspace, linearAppTokenForWorkspace, getLinearIssue, commentOnIssue, listLinearMembers, assignLinearIssue, listLinearIssues, listLinearCustomViewIssues } from "../linear/client.ts";
import { parseGitHubPrUrl } from "../github/urls.ts";
import { noteOnCard } from "../notices.ts";
import { formatPrTitleWithLinearIssue } from "@manta/shared/prTitle";
import { appendTaskTranscriptLink } from "./conversationLinks.ts";
import { disposeTaskWorker } from "./registry.ts";
import { decrypt } from "../secrets/crypto.ts";
import { startWorkerForTask } from "./dispatch.ts";
import { prFieldsForReport } from "./prReport.ts";
import { recreateTaskInRepo, SwitchRepoError } from "./switchRepo.ts";
import { runBrainTurn } from "../brain/runner.ts";
import { postWorkerSlackMessage, WorkerSlackPostError } from "../slack/workerPost.ts";
import { callNotionTool, NotionNotConnectedError } from "../notion/client.ts";
import { workerHandoffBody } from "./handoff.ts";
import { authorizeRepoChatToolGrant } from "./questions.ts";

const logger = createLogger("Manta:WorkerHttp");

// A worker principal is either a paired user daemon or a single-task cloud
// sandbox. Routes authorize against whichever is present.
type Principal =
  | { kind: "user"; userId: string }
  | { kind: "sandbox"; taskId: string; workspaceId: string };

type WorkerVars = { principal: Principal };

export interface WorkerBrainDeps {
  brainBackend: AgentBackend;
  brainBackendId: string;
  brainTools: ToolDefinition[];
  defaultBrainPrompt: string;
}

const brainWakeQueue = new Map<string, Promise<void>>();

function brainChannelForUser(userId: string | null | undefined): string {
  return userId ? `brain:${userId}` : "brain";
}

function queueWorkerHandoffBrainWake(input: {
  workspaceId: string;
  inboxItemId: string;
  userId?: string;
  deps?: WorkerBrainDeps;
}): boolean {
  if (!input.deps) return false;
  const channel = brainChannelForUser(input.userId);
  const key = `${input.workspaceId}:${channel}`;
  const prior = brainWakeQueue.get(key) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(() => runWorkerHandoffBrainTurn({ ...input, deps: input.deps!, channel }))
    .catch((err) => logger.error("worker handoff brain wake failed", { workspaceId: input.workspaceId, channel, err }))
    .finally(() => {
      if (brainWakeQueue.get(key) === next) brainWakeQueue.delete(key);
    });
  brainWakeQueue.set(key, next);
  return true;
}

async function runWorkerHandoffBrainTurn(input: {
  workspaceId: string;
  inboxItemId: string;
  userId?: string;
  channel: string;
  deps: WorkerBrainDeps;
}): Promise<void> {
  const [wsRecord, wsSettings, backendId, sessionKey, pendingItems, repoRows] = await Promise.all([
    workspaces.byId(input.workspaceId),
    workspaces.getSettings(input.workspaceId),
    brainBackendIdFor(input.workspaceId, input.deps.brainBackendId),
    agentSessions.getSessionKey(input.workspaceId, input.channel),
    inbox.pending(input.workspaceId, "brain"),
    repos.list({ workspaceId: input.workspaceId }),
  ]);
  const inboxItems = pendingItems
    .filter((i) => i.source === "worker" && i.id === input.inboxItemId)
    .map((i) => ({ id: i.id, body: i.body, source: i.source, createdAt: i.createdAt.getTime() }));
  if (!inboxItems.length) return;

  const result = await runBrainTurn({
    scope: { workspaceId: input.workspaceId },
    channel: input.channel,
    userMessage:
      "A worker sent an orchestration handoff. Treat this as an active request from the worker/task owner and act on it now. Use the worker handoff inbox item(s) below; if follow-up work or assignment is requested, call the appropriate brain tool in this turn.",
    backend: input.deps.brainBackend,
    backendId: wsSettings.defaultModel || backendId,
    tools: input.deps.brainTools,
    promptParts: {
      basePrompt: wsRecord?.brainPrompt?.trim() || input.deps.defaultBrainPrompt,
      teamMemory: wsRecord?.teamMemory,
      workspaceRepos: repoRows.filter((repo) => repo.enabled).map((repo) => ({ orgRepo: repo.orgRepo, defaultBranch: repo.defaultBranch })),
    },
    ...(input.userId ? { userId: input.userId } : {}),
    ...(sessionKey ? { resumeFrom: sessionKey } : {}),
    onSession: (key) => agentSessions.upsertSessionKey(input.workspaceId, input.channel, key),
    inbox: inboxItems,
    onEvent: (event) => {
      bus.publish(chanTopic(input.workspaceId, input.channel), event);
    },
  });

  await inbox.markConsumed(input.workspaceId, result.consumedInboxIds);
  bus.publish(kanbanTopic(input.workspaceId), {});
}

/** Authorize a (taskId, workspaceId) pair for the caller. A user must be a member
 * of the workspace; a sandbox token may touch only its own task+workspace. */
async function authorizeTask(p: Principal, taskId: string, workspaceId: string): Promise<boolean> {
  if (p.kind === "sandbox") return p.taskId === taskId && p.workspaceId === workspaceId;
  return workspaces.isMember(p.userId, workspaceId);
}

export function createWorkerRoutes(deps?: { brain?: WorkerBrainDeps }): Hono<{ Variables: WorkerVars }> {
  const app = new Hono<{ Variables: WorkerVars }>();

  // Middleware: require a valid worker token (per-user OR single-task sandbox);
  // stash the resolved principal.
  app.use("*", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const sandbox = await sandboxCredentials.verify(token);
    if (sandbox) {
      c.set("principal", { kind: "sandbox", taskId: sandbox.taskId, workspaceId: sandbox.workspaceId });
    } else {
      const cred = await workerCredentials.verify(token);
      if (!cred) return c.json({ error: "unauthorized" }, 401);
      c.set("principal", { kind: "user", userId: cred.userId });
    }
    await next();
  });

  // Repo chat runs outside a Task, but it may use a small, explicitly scoped
  // subset of brain-style board tools. Only paired user daemons are allowed;
  // sandbox credentials remain bound to their single task.
  app.post("/repo-chat/list-cards", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; repoChatToken?: string };
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json({ error: "user_worker_required" }, 403);
    if (!body.workspaceId || !(await workspaces.isMember(principal.userId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!body.repoChatToken || !authorizeRepoChatToolGrant(body.repoChatToken, body.workspaceId, principal.userId)) {
      return c.json({ error: "repo_chat_grant_required" }, 403);
    }
    const rows = await tasks.list({ workspaceId: body.workspaceId });
    return c.json({
      cards: rows.map((task) => ({
        id: task.id,
        taskNumber: task.taskNumber ?? null,
        title: task.title,
        repo: task.repo,
        cardType: task.cardType,
        cardStatus: task.cardStatus,
      })),
    });
  });

  app.post("/repo-chat/create-card", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      description?: string;
      title?: string;
      repo?: string;
      cardType?: "bot" | "investigation" | "interactive" | "backlog" | "plan";
      workerBackend?: string;
      repoChatToken?: string;
    };
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json({ error: "user_worker_required" }, 403);
    if (!body.workspaceId || !(await workspaces.isMember(principal.userId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!body.repoChatToken || !authorizeRepoChatToolGrant(body.repoChatToken, body.workspaceId, principal.userId)) {
      return c.json({ error: "repo_chat_grant_required" }, 403);
    }
    const description = body.description?.trim() ?? "";
    if (!description) return c.json({ error: "description_required" }, 400);
    if (!body.repo) return c.json({ error: "repo_required" }, 400);
    const workspaceRepo = await repos.byOrgRepo({ workspaceId: body.workspaceId }, body.repo);
    if (!workspaceRepo?.enabled) return c.json({ error: "repo_not_enabled" }, 400);

    const validCardTypes = ["bot", "investigation", "interactive", "backlog", "plan"] as const;
    if (body.cardType && !validCardTypes.includes(body.cardType)) return c.json({ error: "invalid_card_type" }, 400);
    const cardType = body.cardType ?? "bot";
    const statusByType = {
      bot: "bot_working",
      investigation: "bot_working",
      interactive: "interactive",
      backlog: "backlog",
      plan: "bot_working",
    } as const;
    const title = body.title?.trim() || description.split("\n")[0]!.slice(0, 72);
    const modelsView = await getModelsView(body.workspaceId, principal.userId);
    if (body.workerBackend && !modelsView.models.some((model) => model.id === body.workerBackend)) {
      return c.json({ error: "model_not_available" }, 400);
    }
    const task = await tasks.create(
      { workspaceId: body.workspaceId },
      {
        name: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "task",
        title,
        description,
        kind: "agent",
        cardType,
        cardStatus: statusByType[cardType],
        ...(cardType === "investigation" ? { type: "investigation" as const } : {}),
        repo: workspaceRepo.orgRepo,
        workerBackend: body.workerBackend || await firstAvailableCardBackendForUser(body.workspaceId, principal.userId),
        createdBy: principal.userId,
      },
    );
    await messages.append({ workspaceId: body.workspaceId }, { channel: task.id, role: "user", content: description });
    const workerStarted = await startWorkerForTask(task, description, { messageAlreadyPersisted: true });
    bus.publish(kanbanTopic(body.workspaceId), {});
    return c.json({
      id: task.id,
      taskNumber: task.taskNumber ?? null,
      title: task.title,
      repo: task.repo,
      cardType: task.cardType,
      cardStatus: task.cardStatus,
      workerStarted,
    });
  });

  // Report the task's PR. New bot_working tasks transition to ready_to_test; existing-PR cards keep their current status.
  app.post("/tasks/:taskId/report-pr", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      prNumber?: number;
      prUrl?: string;
      prTitle?: string;
      branch?: string;
    };
    if (!body.workspaceId || !body.prNumber || !body.prUrl || !body.prTitle || !body.branch) {
      return c.json({ error: "workspaceId, prNumber, prUrl, prTitle, branch required" }, 400);
    }
    if (!(await authorizeTask(c.get("principal"), taskId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const scope = { workspaceId: body.workspaceId };
    try {
      const task = await tasks.get(scope, taskId);
      if (!task) return c.json({ error: "task_not_found" }, 404);
      const prFields = prFieldsForReport(body.prTitle);
      if (!prFields) return c.json({ error: "prTitle_required" }, 400);
      const parsedPr = parseGitHubPrUrl(body.prUrl);
      if (!parsedPr) return c.json({ error: "invalid_pr_url" }, 400);
      if (parsedPr.orgRepo.toLowerCase() !== task.repo.toLowerCase() || parsedPr.prNumber !== body.prNumber) {
        logger.warn("report-pr rejected: PR does not match task repo/number", {
          taskId,
          taskRepo: task.repo,
          reportedRepo: parsedPr.orgRepo,
          taskPrNumber: body.prNumber,
          reportedPrNumber: parsedPr.prNumber,
        });
        return c.json({ error: "pr_does_not_match_task_repo" }, 400);
      }

      await Promise.all([
        tasks.setWorker(scope, taskId, { workerStatus: "pr_created", branch: body.branch }),
        tasks.setPr(scope, taskId, {
          ...prFields,
          prNumber: body.prNumber,
          prUrl: body.prUrl,
          prState: "open",
          prUpdatedAt: new Date(),
        }),
        task.cardStatus === "bot_working"
          ? tasks.transition(scope, taskId, "ready_to_test", "worker")
          : Promise.resolve(),
      ]);
      bus.publish(kanbanTopic(body.workspaceId), {});
      logger.info("PR reported via HTTP", { taskId, prNumber: body.prNumber });
      return c.json({ ok: true });
    } catch (err) {
      logger.error("report-pr failed", { taskId, err });
      return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  });

  // Update a task's checklist.
  app.post("/tasks/:taskId/update-checklist", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      items?: unknown[];
    };
    if (!body.workspaceId || !Array.isArray(body.items)) {
      return c.json({ error: "workspaceId and items required" }, 400);
    }
    if (!(await authorizeTask(c.get("principal"), taskId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      // Scope by workspaceId so a worker can't mutate another workspace's task
      // by passing a mismatched (taskId, workspaceId) pair.
      const res = await prisma.task.updateMany({
        where: { id: taskId, workspaceId: body.workspaceId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { checklist: body.items as any },
      });
      if (res.count === 0) return c.json({ error: "task_not_found" }, 404);
      bus.publish(kanbanTopic(body.workspaceId), {});
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  });

  // Rename a task card from a worker turn.
  app.post("/tasks/:taskId/rename-card", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      title?: string;
    };
    const title = body.title?.trim() ?? "";
    if (!body.workspaceId || !title) {
      return c.json({ error: "workspaceId and title required" }, 400);
    }
    if (!(await authorizeTask(c.get("principal"), taskId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      const res = await prisma.task.updateMany({
        where: { id: taskId, workspaceId: body.workspaceId },
        data: { title },
      });
      if (res.count === 0) return c.json({ error: "task_not_found" }, 404);
      bus.publish(kanbanTopic(body.workspaceId), {});
      return c.json({ ok: true, message: `Card renamed to ${title}` });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  });

  // Let a worker explicitly hand a card back to humans when it cannot safely continue.
  app.post("/tasks/:taskId/needs-help", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      reason?: string;
    };
    const reason = body.reason?.trim() ?? "";
    if (!body.workspaceId || !reason) {
      return c.json({ error: "workspaceId and reason required" }, 400);
    }
    if (!(await authorizeTask(c.get("principal"), taskId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const scope = { workspaceId: body.workspaceId };
    try {
      const task = await tasks.get(scope, taskId);
      if (!task) return c.json({ error: "task_not_found" }, 404);
      await tasks.setWorker(scope, taskId, { workerActive: false, workerStatus: "stalled" });
      if (task.cardStatus !== "needs_help") {
        await tasks.transition(scope, taskId, "needs_help", "worker", { reason });
      }
      await noteOnCard(scope, taskId, `🆘 Worker sent this card to Needs Help: ${reason}`);
      bus.publish(kanbanTopic(body.workspaceId), {});
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  });

  // Let a worker correct a card that was created in the wrong enabled repo.
  // Create a fresh card so repo-scoped history/checkouts stay with the old card;
  // carry forward only the actionable prompt fields (description image markdown
  // references stay intact) plus routing metadata, then close the old card.
  app.post("/tasks/:taskId/switch-repo", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      targetRepo?: string;
      reason?: string;
    };
    const targetRepo = body.targetRepo?.trim() ?? "";
    const reason = body.reason?.trim() ?? "";
    if (!body.workspaceId || !targetRepo || !reason) {
      return c.json({ error: "workspaceId, targetRepo, and reason required" }, 400);
    }
    if (!(await authorizeTask(c.get("principal"), taskId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const scope = { workspaceId: body.workspaceId };
    try {
      const task = await tasks.get(scope, taskId);
      if (!task) return c.json({ error: "task_not_found" }, 404);
      const replacement = await recreateTaskInRepo({
        workspaceId: body.workspaceId,
        taskId,
        targetRepo,
        reason,
      });
      const started = await startWorkerForTask(replacement, task.description);
      const sameRepoRefresh = replacement.repo === task.repo;
      await noteOnCard(scope, taskId, `🔀 Worker ${sameRepoRefresh ? "refreshed" : "recreated"} this card as ${replacement.id} in ${replacement.repo}: ${reason}`);
      await noteOnCard(scope, replacement.id, `🔀 Created from ${task.id} in ${task.repo}${sameRepoRefresh ? " to refresh its worker checkout" : ` because the worker determined the card belonged in ${replacement.repo}`}.\n\nReason: ${reason}`);
      disposeTaskWorker(taskId);
      bus.publish(chanTopic(body.workspaceId, taskId), { type: "task_updated" });
      bus.publish(chanTopic(body.workspaceId, replacement.id), { type: "task_updated" });
      bus.publish(kanbanTopic(body.workspaceId), {});
      return c.json({
        ok: true,
        repo: replacement.repo,
        newTaskId: replacement.id,
        newTaskNumber: replacement.taskNumber,
        workerStarted: started,
        message: `Created replacement card ${replacement.id} in ${replacement.repo} and canceled the old card.`,
      });
    } catch (err) {
      if (err instanceof SwitchRepoError) {
        const status = err.code === "task_not_found" ? 404 : err.code === "cannot_switch_repo_after_pr_reported" ? 409 : 400;
        return c.json({ error: err.code }, status);
      }
      return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  });

  // Save a plan-mode card's markdown plan and hand it back for human review.
  app.post("/tasks/:taskId/plan-ready", async (c) => {
    const taskId = c.req.param("taskId");
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      plan?: string;
    };
    const plan = body.plan?.trim() ?? "";
    if (!body.workspaceId || !plan) {
      return c.json({ error: "workspaceId and plan required" }, 400);
    }
    if (!(await authorizeTask(c.get("principal"), taskId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const scope = { workspaceId: body.workspaceId };
    try {
      const task = await tasks.get(scope, taskId);
      if (!task) return c.json({ error: "task_not_found" }, 404);
      if (task.cardType !== "plan") return c.json({ error: "task_not_plan_mode" }, 422);
      await prisma.task.updateMany({
        where: { id: taskId, workspaceId: body.workspaceId },
        data: { planDocument: plan, workerActive: false, workerStatus: "stalled" },
      });
      if (task.cardStatus !== "needs_help") {
        await tasks.transition(scope, taskId, "needs_help", "worker", { reason: "Plan ready for review" });
      }
      await noteOnCard(scope, taskId, "📋 Plan ready for review — moved to Needs Help.");
      bus.publish(chanTopic(body.workspaceId, taskId), { type: "task_updated" });
      bus.publish(kanbanTopic(body.workspaceId), {});
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  });

  // List the worker user's workspaces — used by `daemon login` to pick which
  // workspace a captured provider credential should attach to.
  app.get("/workspaces", async (c) => {
    const p = c.get("principal");
    if (p.kind !== "user") return c.json({ error: "forbidden" }, 403);
    const list = await users.membershipsFor(p.userId);
    return c.json({ workspaces: list.map((m) => ({ id: m.workspaceId, name: m.name })) });
  });

  // Store a provider credential. Used by `daemon login codex` to upload the
  // captured Codex OAuth blob. Subscription creds (authJson) go to per-user
  // UserSecret; API keys go to workspace WorkspaceSecret.
  app.post("/providers/:provider", async (c) => {
    const provider = c.req.param("provider");
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      authJson?: unknown;
      apiKey?: string;
    };
    if (!body.workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (body.authJson === undefined && body.apiKey === undefined) {
      return c.json({ error: "authJson or apiKey required" }, 400);
    }
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json({ error: "forbidden" }, 403);
    if (!(await workspaces.isMember(principal.userId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    try {
      if (body.authJson !== undefined) {
        // Subscription credential (OAuth) — stored per-user, not per-workspace.
        await setUserProvider(principal.userId, provider, { authJson: body.authJson });
      } else {
        await setProvider(body.workspaceId, provider, { apiKey: body.apiKey });
      }
      logger.info("provider credential stored via worker", { provider, userId: principal.userId });
      return c.json({ ok: true });
    } catch (err) {
      logger.warn("worker provider store rejected", { provider, err });
      return c.json({ error: err instanceof Error ? err.message : "invalid_credential" }, 400);
    }
  });

  // Read a Linear issue using the workspace's app token. Workers never receive
  // the token itself; the server checks membership/task scope, then proxies the read.
  app.post("/linear-issue", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; issueId?: string };
    if (!body.workspaceId || !body.issueId?.trim()) return c.json({ error: "workspaceId and issueId required" }, 400);
    const principal = c.get("principal");
    if (principal.kind === "sandbox") {
      if (principal.workspaceId !== body.workspaceId) return c.json({ error: "forbidden" }, 403);
    } else if (!(await workspaces.isMember(principal.userId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const token = await linearTokenForWorkspace(body.workspaceId);
    if (!token) return c.json({ error: "linear_not_connected" }, 400);
    const issue = await getLinearIssue(body.issueId.trim(), token);
    if (!issue) return c.json({ error: "linear_issue_not_found" }, 404);
    return c.json({ issue });
  });

  // Proxy the stable Notion tool surface through the server. The worker names a
  // Manta action, never an arbitrary MCP tool, and never receives the OAuth token.
  app.post("/notion-tool", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      workspaceId?: string;
      taskId?: string;
      action?: string;
      args?: Record<string, unknown>;
    };
    if (!body.workspaceId || !body.taskId || !body.action) return c.json({ error: "workspaceId, taskId, and action required" }, 400);
    if (!(await authorizeTask(c.get("principal"), body.taskId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
    const args = body.args ?? {};
    if (body.action === "instructions") {
      const settings = await workspaces.getSettings(body.workspaceId);
      return c.json({ instructions: settings.notionInstructions ?? "" });
    }
    const toolByAction: Record<string, string> = {
      search: "notion-search",
      fetch: "notion-fetch",
      create_pages: "notion-create-pages",
      update_page: "notion-update-page",
      create_comment: "notion-create-comment",
    };
    const tool = toolByAction[body.action];
    if (!tool) return c.json({ error: "unknown_notion_action" }, 400);
    try {
      return c.json({ result: await callNotionTool(body.workspaceId, tool, args) });
    } catch (err) {
      if (err instanceof NotionNotConnectedError) return c.json({ error: "notion_not_connected", message: err.message }, 400);
      logger.warn("worker Notion request failed", { workspaceId: body.workspaceId, taskId: body.taskId, action: body.action, err });
      return c.json({ error: "notion_request_failed", message: err instanceof Error ? err.message : "Notion request failed" }, 502);
    }
  });

  // Enumerate Linear issues so a worker can triage a set, not just a single
  // ticket. Read-only, proxied through the workspace token (never handed out).
  // Pass a custom-view UUID (viewId) to enumerate a saved view — the only way to
  // reproduce its filter — or a teamId to list a team's open issues.
  app.post("/linear-list", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      viewId?: string;
      teamId?: string;
      stateFilter?: string;
      limit?: number;
    };
    if (!body.workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!body.viewId?.trim() && !body.teamId?.trim()) return c.json({ error: "viewId or teamId required" }, 400);
    const principal = c.get("principal");
    if (principal.kind === "sandbox") {
      if (principal.workspaceId !== body.workspaceId) return c.json({ error: "forbidden" }, 403);
    } else if (!(await workspaces.isMember(principal.userId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    const token = await linearTokenForWorkspace(body.workspaceId);
    if (!token) return c.json({ error: "linear_not_connected" }, 400);
    // Surface Linear's own error text to the caller: a worker that gets a bare
    // 500 back can only give up, while the actual message ("no such state",
    // bad team key) usually tells the model how to fix its next call.
    try {
      if (body.viewId?.trim()) {
        const { view, issues } = await listLinearCustomViewIssues(body.viewId.trim(), { limit: body.limit }, token);
        if (!view) return c.json({ error: "linear_view_not_found" }, 404);
        return c.json({ view, issues });
      }
      const issues = await listLinearIssues(body.teamId!.trim(), { stateFilter: body.stateFilter?.trim(), limit: body.limit }, token);
      return c.json({ issues });
    } catch (err) {
      logger.warn("worker Linear list failed", { workspaceId: body.workspaceId, teamId: body.teamId, viewId: body.viewId, err });
      return c.json({ error: "linear_list_failed", message: err instanceof Error ? err.message : "Linear list failed" }, 502);
    }
  });

  // Post a Linear comment for a task's linked issue. Workers never receive the
  // Linear token itself; the server checks task scope, resolves the linked issue
  // by default, and proxies the write through the workspace app token.
  app.post("/linear-comment", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; taskId?: string; issueId?: string; body?: string };
    if (!body.workspaceId || !body.taskId || !body.body?.trim()) return c.json({ error: "workspaceId, taskId, and body required" }, 400);
    const principal = c.get("principal");
    if (!(await authorizeTask(principal, body.taskId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
    const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    const issueId = body.issueId?.trim() || task.linearIssueIdentifier;
    if (!issueId) return c.json({ error: "task has no linked Linear issue" }, 400);
    const token = await linearAppTokenForWorkspace(body.workspaceId);
    if (!token) return c.json({ error: "linear_app_oauth_not_connected" }, 400);
    await commentOnIssue(issueId, body.body.trim(), token);
    if (task.cardStatus === "bot_working" && !task.prNumber) {
      if (task.cardType !== "investigation") disposeTaskWorker(task.id);
      await tasks.transition({ workspaceId: body.workspaceId }, task.id, task.cardType === "investigation" ? "investigation_complete" : "done", "worker", {
        doneReason: task.cardType === "investigation" ? "investigation_complete" : "completed",
        reason: task.cardType === "investigation" ? "Investigation complete; result posted to Linear" : "Investigation result posted to Linear",
      });
      await tasks.setWorker({ workspaceId: body.workspaceId }, task.id, { workerActive: false, workerStatus: "done" });
      bus.publish(kanbanTopic(body.workspaceId), {});
      bus.publish(chanTopic(body.workspaceId, task.id), { type: "task_updated" });
    }
    return c.json({ ok: true, issueId });
  });

  // Post final findings for a Slack-originated investigation back to the source
  // thread. Workers never receive Slack tokens or channel/thread IDs; the server
  // resolves the stored card origin and posts as the originating bot.
  app.post("/slack-result", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; taskId?: string; body?: string };
    if (!body.workspaceId || !body.taskId || !body.body?.trim()) return c.json({ error: "workspaceId, taskId, and body required" }, 400);
    const principal = c.get("principal");
    if (!(await authorizeTask(principal, body.taskId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
    const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (!task.slackChannel || !task.slackThreadTs || !task.slackBotId) return c.json({ error: "task has no linked Slack thread" }, 400);
    const bot = await slack.getBot(body.workspaceId, task.slackBotId);
    if (!bot?.enabled) return c.json({ error: "slack_bot_unavailable" }, 400);

    const client = new WebClient(decrypt(Buffer.from(bot.botTokenCipher)));
    await client.chat.postMessage({
      channel: task.slackChannel,
      thread_ts: task.slackThreadTs,
      text: body.body.trim(),
    });
    if (task.cardStatus === "bot_working" && !task.prNumber) {
      if (task.cardType !== "investigation") disposeTaskWorker(task.id);
      await tasks.transition({ workspaceId: body.workspaceId }, task.id, task.cardType === "investigation" ? "investigation_complete" : "done", "worker", {
        doneReason: task.cardType === "investigation" ? "investigation_complete" : "completed",
        reason: task.cardType === "investigation" ? "Investigation complete; result posted to Slack" : "Investigation result posted to Slack",
      });
      await tasks.setWorker({ workspaceId: body.workspaceId }, task.id, { workerActive: false, workerStatus: "done" });
      await prisma.task.updateMany({ where: { id: task.id, workspaceId: body.workspaceId }, data: { slackDmSent: true } });
    }
    bus.publish(kanbanTopic(body.workspaceId), {});
    bus.publish(chanTopic(body.workspaceId, task.id), { type: "task_updated" });
    return c.json({ ok: true });
  });

  // Post an arbitrary workspace-scoped Slack message without exposing bot
  // tokens to the worker. A destination is either a channel/conversation ID or
  // a Slack user ID whose DM conversation the server opens first.
  app.post("/slack-post", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      taskId?: string;
      text?: string;
      bot?: string;
      channelId?: string;
      userId?: string;
      threadTs?: string;
    };
    if (!body.workspaceId || !body.taskId || !body.text?.trim()) {
      return c.json({ error: "workspaceId, taskId, and text required" }, 400);
    }
    if (!(await authorizeTask(c.get("principal"), body.taskId, body.workspaceId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!(await tasks.get({ workspaceId: body.workspaceId }, body.taskId))) {
      return c.json({ error: "task_not_found" }, 404);
    }
    try {
      return c.json(await postWorkerSlackMessage({
        workspaceId: body.workspaceId,
        text: body.text,
        ...(body.bot ? { bot: body.bot } : {}),
        ...(body.channelId ? { channelId: body.channelId } : {}),
        ...(body.userId ? { userId: body.userId } : {}),
        ...(body.threadTs ? { threadTs: body.threadTs } : {}),
      }));
    } catch (err) {
      if (err instanceof WorkerSlackPostError) return c.json({ error: err.code, message: err.message }, 400);
      logger.warn("worker Slack post failed", { workspaceId: body.workspaceId, taskId: body.taskId, err });
      return c.json({ error: "slack_post_failed", message: err instanceof Error ? err.message : "failed to post to Slack" }, 502);
    }
  });

  // Complete an investigation that has no external sink (Slack/Linear). This
  // records the findings on the card and marks it done with the investigation
  // completion reason so the board can group it distinctly.
  app.post("/investigation-complete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; taskId?: string; body?: string };
    if (!body.workspaceId || !body.taskId || !body.body?.trim()) return c.json({ error: "workspaceId, taskId, and body required" }, 400);
    const principal = c.get("principal");
    if (!(await authorizeTask(principal, body.taskId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
    const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (task.cardType !== "investigation") return c.json({ error: "task is not an investigation" }, 400);
    await noteOnCard({ workspaceId: body.workspaceId }, task.id, `🔎 Investigation complete\n\n${body.body.trim()}`);
    if (task.cardStatus === "bot_working" && !task.prNumber) {
      await tasks.transition({ workspaceId: body.workspaceId }, task.id, "investigation_complete", "worker", {
        doneReason: "investigation_complete",
        reason: "Investigation complete",
      });
      await tasks.setWorker({ workspaceId: body.workspaceId }, task.id, { workerActive: false, workerStatus: "done" });
    }
    bus.publish(kanbanTopic(body.workspaceId), {});
    bus.publish(chanTopic(body.workspaceId, task.id), { type: "task_updated" });
    return c.json({ ok: true });
  });

  // List Linear members so a worker can pick an assignee ID before handing off a
  // linked issue. Read-only fallback may use LINEAR_API_KEY in dev, but the
  // assignment mutation below requires the workspace app OAuth token.
  app.post("/linear-members", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; taskId?: string };
    if (!body.workspaceId || !body.taskId) return c.json({ error: "workspaceId and taskId required" }, 400);
    const principal = c.get("principal");
    if (!(await authorizeTask(principal, body.taskId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
    const token = await linearTokenForWorkspace(body.workspaceId);
    if (!token) return c.json({ error: "linear_not_connected" }, 400);
    const members = await listLinearMembers(token);
    return c.json({ members });
  });

  // Assign a Linear issue to an engineer and reset it to Todo for their review
  // work. Defaults to the task's linked issue so workers cannot accidentally act
  // on an unrelated issue unless they explicitly pass an issue id. Uses app OAuth
  // only to avoid human-token attribution.
  app.post("/linear-assign", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; taskId?: string; issueId?: string; assigneeId?: string };
    if (!body.workspaceId || !body.taskId || !body.assigneeId?.trim()) return c.json({ error: "workspaceId, taskId, and assigneeId required" }, 400);
    const principal = c.get("principal");
    if (!(await authorizeTask(principal, body.taskId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
    const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    const issueId = body.issueId?.trim() || task.linearIssueIdentifier;
    if (!issueId) return c.json({ error: "task has no linked Linear issue" }, 400);
    const token = await linearAppTokenForWorkspace(body.workspaceId);
    if (!token) return c.json({ error: "linear_app_oauth_not_connected" }, 400);
    await assignLinearIssue(issueId, body.assigneeId.trim(), token);
    return c.json({ ok: true, issueId, assigneeId: body.assigneeId.trim() });
  });

  // Let any worker hand orchestration work back to the brain instead of giving
  // workers direct card-spawning/assignment authority. When brain deps are
  // available, wake a brain turn immediately so create_task / Linear assignment
  // requests are acted on without waiting for the user to kick the brain.
  app.post("/brain-message", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; taskId?: string; message?: string };
    const message = body.message?.trim() ?? "";
    if (!body.workspaceId || !body.taskId || !message) return c.json({ error: "workspaceId, taskId, and message required" }, 400);
    const principal = c.get("principal");
    if (!(await authorizeTask(principal, body.taskId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
    const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    const handoff = await inbox.push(body.workspaceId, {
      channel: "brain",
      source: "worker",
      body: workerHandoffBody(task, message),
    });
    bus.publish(chanTopic(body.workspaceId, "brain"), { type: "status", text: `Worker ${task.id} sent a handoff to the brain.` });
    const requester = c.get("principal");
    const requesterUserId = requester.kind === "user" ? requester.userId : task.createdBy ?? undefined;
    const wakeStarted = queueWorkerHandoffBrainWake({ workspaceId: body.workspaceId, inboxItemId: handoff.id, userId: requesterUserId, deps: deps?.brain });
    return c.json({ ok: true, wakeStarted });
  });

  // Get a short-lived GitHub token (only when GitHub App is configured).
  app.post("/github-token", async (c) => {
    if (!githubAppConfigured()) return c.json({ error: "GitHub App not configured" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { orgRepo?: string; taskId?: string; workspaceId?: string };
    if (!body.orgRepo) return c.json({ error: "orgRepo required" }, 400);
    // A sandbox token may mint only for ITS task's repo — never an arbitrary repo
    // the caller names (cf. the get_github_token tool's same guard).
    const principal = c.get("principal");
    let task: Awaited<ReturnType<typeof tasks.get>> | null = null;
    if (principal.kind === "sandbox") {
      task = await tasks.get({ workspaceId: principal.workspaceId }, principal.taskId);
      if (!task?.repo) return c.json({ error: "task repo not found" }, 404);
      if (body.orgRepo !== task.repo) {
        return c.json({ error: `token is scoped to ${task.repo}, not ${body.orgRepo}` }, 403);
      }
    } else {
      if (!body.taskId || !body.workspaceId) return c.json({ error: "taskId and workspaceId required" }, 400);
      if (!(await authorizeTask(principal, body.taskId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
      task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
      if (!task?.repo) return c.json({ error: "task repo not found" }, 404);
      if (body.orgRepo !== task.repo) {
        return c.json({ error: `token is scoped to ${task.repo}, not ${body.orgRepo}` }, 403);
      }
    }
    try {
      const token = await mintInstallationToken(task.repo);
      return c.json({ token });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  });

  // Create a PR as the card creator. Ownerless automation cards may fall back to
  // the workspace GitHub App installation token, but user-created cards must not
  // silently create PRs as the App.
  app.post("/github-pr", async (c) => {
    if (!githubAppConfigured()) return c.json({ error: "GitHub App not configured" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      taskId?: string;
      title?: string;
      body?: string;
      head?: string;
      base?: string;
    };
    if (!body.workspaceId || !body.taskId || !body.title?.trim() || !body.head?.trim() || !body.base?.trim()) {
      return c.json({ error: "workspaceId, taskId, title, head, and base required" }, 400);
    }
    const principal = c.get("principal");
    if (!(await authorizeTask(principal, body.taskId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
    const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
    if (!task?.repo) return c.json({ error: "task repo not found" }, 404);
    try {
      const userToken = await githubUserTokenStatusForTask(task);
      const tokenSource = githubPrTokenSourceForTask(task, userToken);
      logger.info("creating GitHub PR via HTTP", { taskId: body.taskId, repo: task.repo, tokenSource });
      const token = userToken.token ?? await mintInstallationToken(task.repo);
      const title = formatPrTitleWithLinearIssue(body.title, task.linearIssueIdentifier);
      const pr = await createPr({
        orgRepo: task.repo,
        token,
        title,
        body: appendTaskTranscriptLink(body.body, body.workspaceId, body.taskId),
        head: body.head.trim(),
        base: body.base.trim(),
      });
      await routeNonEngineerPrReview({ task, orgRepo: task.repo, token, prNumber: pr.number, prUrl: pr.html_url, base: body.base.trim() }).catch((err) => {
        logger.warn("failed to route non-engineer PR review", { taskId: body.taskId, prUrl: pr.html_url, err: err instanceof Error ? err.message : String(err) });
      });
      return c.json({ pr: { prNumber: pr.number, prUrl: pr.html_url, prTitle: pr.title, branch: body.head.trim() } });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "failed" }, 500);
    }
  });

  return app;
}
