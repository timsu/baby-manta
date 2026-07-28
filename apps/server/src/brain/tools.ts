// Brain task tools (spec §6.4, the task-CRUD subset). Each is an agent
// ToolDefinition whose handler runs control-plane logic against the
// workspace-scoped db layer. ctx.workspaceId is the ONLY source of workspace
// scope — tool args never carry a workspaceId, so the brain can't act across
// workspaces.

import { defineTool, type ToolContext, type ToolDefinition } from "@manta/agent";
import { prisma, messages, tasks, workspaces, type TaskKind, type Task } from "@manta/db";
import type { CardStatus, CardType, TransitionActor, DoneReason } from "@manta/shared";
import { bus, chanTopic } from "../bus.ts";
import {
  linearTokenForWorkspace,
  linearAppTokenForWorkspace,
  listLinearTeams as linearListTeams,
  listLinearMembers as linearListMembers,
  listLinearIssues as linearListIssues,
  listLinearCustomViewIssues as linearListCustomViewIssues,
  getLinearIssue as linearGetIssue,
  createLinearIssue as linearCreateIssue,
  commentOnIssue as linearCommentOnIssue,
  searchDuplicateLinearIssue as linearSearchDuplicateIssue,
  findLinearIssueBySlackUrl as linearFindIssueBySlackUrl,
  attachSlackUrlToLinearIssue as linearAttachSlackUrl,
  assignLinearIssue as linearAssignIssue,
  updateLinearIssue as linearUpdateIssue,
} from "../linear/client.ts";
import { firstAvailableCardBackendForUser } from "../models/service.ts";
import { canonicalRepoForWorkspace } from "../repos/canonical.ts";
import { buildWorkerResumeMessage } from "../worker/resume-context.ts";
import type { AcceptedTaskMessage } from "../worker/taskMessages.ts";
import { disposeTaskWorker } from "../worker/registry.ts";
import { buildNotionTools } from "../notion/tools.ts";

const SLACK_LINEAR_REQUEST_MARKER = "manta:slack-request";
const TASK_REFERENCE_DESCRIPTION = "Full card ID or displayed ID (for example, c-95dbe6).";
export const SLACK_SUPPORT_LINEAR_LABELS = ["Bug", "Support", "On-call triage"] as const;

export function linearIssueLabelNamesForCreate(args: { labelNames?: string[] }, supportTriage: boolean | undefined): string[] | undefined {
  const explicit = args.labelNames ?? [];
  const defaults = supportTriage ? [...SLACK_SUPPORT_LINEAR_LABELS] : [];
  const labels = [...explicit, ...defaults]
    .map((label) => label.trim())
    .filter(Boolean);
  if (labels.length === 0) return undefined;
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withSlackLinearRequestMarker(description: string | undefined, origin: { slackUserId?: string; slackBotId?: string; channel?: string; threadTs?: string } | undefined): string | undefined {
  if (!origin?.slackUserId || !origin.slackBotId) return description;
  const payload = JSON.stringify({
    slackUserId: origin.slackUserId,
    slackBotId: origin.slackBotId,
    ...(origin.channel ? { channel: origin.channel } : {}),
    ...(origin.threadTs ? { threadTs: origin.threadTs } : {}),
  });
  const marker = `<!-- ${SLACK_LINEAR_REQUEST_MARKER} ${payload} -->`;
  const requester = `Requested from Slack by <@${origin.slackUserId}>.`;
  return [description?.trim(), requester, marker].filter(Boolean).join("\n\n");
}

export interface WorkerDriver {
  spawnWorker: (task: Task, message: string) => void;
  /** Persist a follow-up and confirm it was routed to an active worker turn. */
  acceptTaskMessage?: (workspaceId: string, taskId: string, message: string, actor?: "human" | "brain", opts?: { requireIdle?: boolean }) => Promise<AcceptedTaskMessage | null>;
}

const STATUS_BY_TYPE: Record<CardType, CardStatus> = {
  bot: "bot_working",
  investigation: "bot_working",
  interactive: "interactive",
  backlog: "backlog",
  plan: "bot_working",
};

export interface SlackDriver {
  postMessage: (channel: string, text: string, threadTs?: string) => Promise<void>;
  getPermalink?: (channel: string, messageTs: string) => Promise<string | null>;
}

/** Delegate a read-only "answer this about a repo" run to a worker (no Task).
 * `onUpdate` (optional) receives the worker agent's mid-investigation progress
 * notes so they can be surfaced live (e.g. posted to the Slack thread). */
export interface QuestionDriver {
  ask: (
    workspaceId: string,
    repo: string,
    question: string,
    onUpdate?: (text: string) => void,
  ) => Promise<{ ok: true; answer: string } | { ok: false; reason: string; message?: string }>;
}

export interface BrainToolDeps {
  worker?: WorkerDriver;
  slack?: SlackDriver;
  question?: QuestionDriver;
}

interface CreateTaskArgs {
  description: string;
  title?: string;
  name?: string;
  kind?: TaskKind;
  cardType?: CardType;
  repo: string;
  workerBackend?: string;
  linearIssueIdentifier?: string;
}

interface LinearWorkspaceSettings extends workspaces.WorkspaceSettings {
  linearProjectRepos?: Record<string, string>;
  linearTeamRepos?: Record<string, string>;
}

interface ListTasksArgs {
  status?: CardStatus;
}

interface GetTaskArgs {
  id: string;
}

interface TransitionArgs {
  id: string;
  to: CardStatus;
  reason?: string;
  doneReason?: DoneReason;
  force?: boolean;
}

/** kebab-case a title into a branch/worktree-safe slug. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "task";
}

/** The brain always acts as the "brain" transition actor. */
const BRAIN: TransitionActor = "brain";

type TaskReferenceResolution =
  | { status: "found"; task: Task }
  | { status: "not_found" }
  | { status: "ambiguous" };

async function resolveTaskReference(workspaceId: string, reference: string): Promise<TaskReferenceResolution> {
  const exact = await tasks.get({ workspaceId }, reference);
  if (exact) return { status: "found", task: exact };
  if (!/^c-[0-9a-f]{6}$/i.test(reference)) return { status: "not_found" };

  const matches = await prisma.task.findMany({
    where: { workspaceId, id: { startsWith: reference.toLowerCase() } },
    take: 2,
  });
  if (matches.length === 1) return { status: "found", task: matches[0]! };
  return { status: matches.length > 1 ? "ambiguous" : "not_found" };
}

function unresolvedTaskReference(resolution: Exclude<TaskReferenceResolution, { status: "found" }>, reference: string) {
  if (resolution.status === "ambiguous") {
    return {
      found: false,
      error: "ambiguous_task_reference",
      message: `Displayed card ID ${reference} matches multiple cards. Use the full card ID.`,
    };
  }
  return { found: false };
}

function attachmentEscalationBlocked(ctx: ToolContext, evidenceText: string): { error: string } | null {
  if (!ctx.ambiguousAttachmentRequest || !ctx.visibleAttachmentUrls?.length) return null;
  const text = evidenceText.toLowerCase();
  const mentionsAttachment = /screenshot|screen shot|image|attachment|attached|visible|shown|shows|from the screenshot|from the image/.test(text);
  const includesUrl = ctx.visibleAttachmentUrls.some((url) => url && evidenceText.includes(url));
  if (mentionsAttachment || includesUrl) return null;
  return {
    error:
      "This turn includes a visible attachment plus ambiguous wording. Inspect/ground on the attachment or ask a clarification before creating Linear issues, assigning people, spawning workers, or taking other escalation side effects. Include concrete visible evidence from the attachment/current message in the tool arguments before retrying.",
  };
}

async function mappedRepoForLinearIssue(workspaceId: string, issueId: string): Promise<string | null> {
  const [settings, token] = await Promise.all([
    workspaces.getSettings(workspaceId) as Promise<LinearWorkspaceSettings>,
    linearTokenForWorkspace(workspaceId),
  ]);
  if (!token) return null;
  const issue = await linearGetIssue(issueId, token).catch(() => null);
  if (!issue) return null;

  const projectRepo = issue.project?.id ? settings.linearProjectRepos?.[issue.project.id] : undefined;
  const teamRepo = issue.team?.id ? settings.linearTeamRepos?.[issue.team.id] : undefined;
  return projectRepo ?? teamRepo ?? null;
}

async function repoForCreateTask(ctx: ToolContext, args: Pick<CreateTaskArgs, "repo" | "linearIssueIdentifier">): Promise<string> {
  const mappedRepo = args.linearIssueIdentifier
    ? await mappedRepoForLinearIssue(ctx.workspaceId, args.linearIssueIdentifier)
    : null;
  return canonicalRepoForWorkspace(ctx.workspaceId, mappedRepo ?? args.repo);
}

export function brainTaskTools(deps?: BrainToolDeps): ToolDefinition[] {
  const worker = deps?.worker;
  const slackDrv = deps?.slack;
  const questionDrv = deps?.question;
  const createTask = defineTool<CreateTaskArgs>({
    name: "create_task",
    description:
      "Create a ticket + spawn a worker. Provide a description (the worker's initial prompt) and the target repo (org/repo). Returns the canonical created card fields, including repo/title/id/taskNumber.",
    parameters: {
      type: "object",
      required: ["description", "repo"],
      properties: {
        description: { type: "string" },
        title: { type: "string" },
        kind: { type: "string", enum: ["agent", "self", "skill", "review", "pr_review"] },
        cardType: { type: "string", enum: ["bot", "investigation", "interactive", "backlog", "plan"] },
        repo: { type: "string", description: "org/repo" },
        workerBackend: { type: "string" },
        linearIssueIdentifier: { type: "string", description: "Linear issue identifier to link (e.g. ENG-42)" },
      },
    },
    handler: async (args, ctx) => {
      const blocked = attachmentEscalationBlocked(ctx, `${args.title ?? ""}\n${args.description}`);
      if (blocked) return blocked;
      const title = args.title ?? args.description.slice(0, 72);
      const cardType = args.cardType ?? "bot";
      // When the turn came from Slack, attribute the card to the resolved human
      // (so it lands on their board + routes to their worker daemon) and stamp the
      // origin thread so the outbound notifier can reply there on completion.
      const origin = ctx.slackOrigin;
      const workerBackend = args.workerBackend ?? (await firstAvailableCardBackendForUser(ctx.workspaceId, ctx.userId));
      const repo = await repoForCreateTask(ctx, args);
      const input: tasks.CreateTaskInput = {
        name: args.name ?? slugify(title),
        title,
        description: args.description,
        kind: args.kind ?? "agent",
        cardType,
        cardStatus: STATUS_BY_TYPE[cardType],
        ...(cardType === "investigation" ? { type: "investigation" as const } : {}),
        repo,
        workerBackend,
        ...(ctx.userId ? { createdBy: ctx.userId } : {}),
        ...(args.linearIssueIdentifier ? { linearIssueIdentifier: args.linearIssueIdentifier } : {}),
        ...(origin
          ? {
              slackChannel: origin.channel,
              ...(origin.threadTs ? { slackThreadTs: origin.threadTs } : {}),
              ...(origin.slackUserId ? { slackUserId: origin.slackUserId } : {}),
              ...(origin.slackBotId ? { slackBotId: origin.slackBotId } : {}),
            }
          : {}),
      };
      const duplicate = await tasks.findActiveDuplicate({ workspaceId: ctx.workspaceId }, input);
      if (duplicate) {
        const task = await tasks.attachDuplicateMetadata({ workspaceId: ctx.workspaceId }, duplicate.task.id, input);
        ctx.turnState ??= {};
        ctx.turnState.createdTasks ??= [];
        ctx.turnState.createdTasks.push({
          id: task.id,
          title: task.title,
          repo: task.repo,
          cardStatus: task.cardStatus,
          taskNumber: task.taskNumber,
          reusedExisting: true,
        });
        return {
          id: task.id,
          title: task.title,
          repo: task.repo,
          cardStatus: task.cardStatus,
          taskNumber: task.taskNumber,
          workerStarted: false,
          reusedExisting: true,
          duplicateMatchReason: duplicate.reason,
        };
      }
      const task = await tasks.create(
        { workspaceId: ctx.workspaceId },
        input,
      );
      const workerStarted = worker
        ? (task.cardStatus === "bot_working" || task.cardStatus === "interactive")
          && (await tasks.beginWork({ workspaceId: ctx.workspaceId }, task.id))
        : false;
      if (worker && workerStarted) {
        worker.spawnWorker(task, args.description);
      }
      ctx.turnState ??= {};
      ctx.turnState.createdTasks ??= [];
      ctx.turnState.createdTasks.push({
        id: task.id,
        title: task.title,
        repo: task.repo,
        cardStatus: task.cardStatus,
        taskNumber: task.taskNumber,
        reusedExisting: false,
      });
      return {
        id: task.id,
        title: task.title,
        repo: task.repo,
        cardStatus: task.cardStatus,
        taskNumber: task.taskNumber,
        workerStarted,
      };
    },
  });

  const listTasks = defineTool<ListTasksArgs>({
    name: "list_tasks",
    description:
      "List non-archived tasks in this workspace, optionally filtered by status. Each row reports who owns the card: createdByMe is true for the requesting user's own cards and createdByEmail names the creator. When someone asks to act on \"my\" cards, only touch rows where createdByMe is true — never assume a status filter alone means they're all the requester's.",
    parameters: {
      type: "object",
      properties: { status: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const rows = await tasks.list({ workspaceId: ctx.workspaceId }, args.status);
      const creatorIds = [...new Set(rows.map((t) => t.createdBy).filter((v): v is string => v != null))];
      const creators = creatorIds.length
        ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, email: true } })
        : [];
      const emailById = new Map(creators.map((u) => [u.id, u.email]));
      return rows.map((t) => ({
        id: t.id,
        title: t.title,
        cardStatus: t.cardStatus,
        cardType: t.cardType,
        repo: t.repo,
        createdBy: t.createdBy ?? null,
        createdByEmail: t.createdBy ? emailById.get(t.createdBy) ?? null : null,
        createdByMe: ctx.userId != null && t.createdBy === ctx.userId,
      }));
    },
  });

  const getTask = defineTool<GetTaskArgs>({
    name: "get_task",
    description: "Fetch a single task by its full or displayed id, including its owner (createdByMe / createdBy) and cardType.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: TASK_REFERENCE_DESCRIPTION } },
    },
    handler: async (args, ctx) => {
      const resolved = await resolveTaskReference(ctx.workspaceId, args.id);
      if (resolved.status !== "found") return unresolvedTaskReference(resolved, args.id);
      const t = resolved.task;
      return {
        found: true,
        id: t.id,
        title: t.title,
        cardStatus: t.cardStatus,
        cardType: t.cardType,
        repo: t.repo,
        doneReason: t.doneReason ?? null,
        checklist: t.checklist,
        createdBy: t.createdBy ?? null,
        createdByMe: ctx.userId != null && t.createdBy === ctx.userId,
      };
    },
  });

  const transitionStatus = defineTool<TransitionArgs>({
    name: "transition_status",
    description:
      "Move a card to any status. By default the move must be a legal kanban edge for the brain, and for *→done you must pass doneReason abandoned|completed. Set force:true to override the guardrails — it both (a) bypasses the kanban edge rules so you can reach ANY status (e.g. pull a wrongly-done card back to needs_help, an edge no one otherwise has), and (b) lets you dispose (→done/→canceled) a card created by someone other than the requester. Only force when you genuinely need an otherwise-illegal move or the requester explicitly asked to affect everyone's cards; otherwise act only on the requester's own cards (createdByMe).",
    parameters: {
      type: "object",
      required: ["id", "to"],
      properties: {
        id: { type: "string", description: TASK_REFERENCE_DESCRIPTION },
        to: { type: "string" },
        reason: { type: "string" },
        doneReason: { type: "string", enum: ["merged", "abandoned", "completed", "closed_unmerged"] },
        force: {
          type: "boolean",
          description: "Override the kanban edge rules AND the cross-user disposal guard for this move. Default false.",
        },
      },
    },
    handler: async (args, ctx) => {
      const resolved = await resolveTaskReference(ctx.workspaceId, args.id);
      if (resolved.status !== "found") return unresolvedTaskReference(resolved, args.id);
      const target = resolved.task;
      // Guardrail: don't let a casual "mark my cards done" sweep dispose cards
      // that belong to other people. Only enforced when we know the requester
      // (ctx.userId) and the card has a creator that differs from them.
      const isDisposal = args.to === "done" || args.to === "canceled";
      if (
        isDisposal &&
        !args.force &&
        ctx.userId != null &&
        target.createdBy != null &&
        target.createdBy !== ctx.userId
      ) {
        return {
          error: "refused_cross_user",
          id: target.id,
          createdBy: target.createdBy,
          message: `Card ${target.id} was created by another user, not the requester. Refusing to move it to "${args.to}". Only dispose the requester's own cards (createdByMe) unless they explicitly asked to affect everyone's — then retry with force:true.`,
        };
      }
      const updated = await tasks.transition({ workspaceId: ctx.workspaceId }, target.id, args.to, BRAIN, {
        ...(args.reason ? { reason: args.reason } : {}),
        ...(args.doneReason ? { doneReason: args.doneReason } : {}),
        ...(args.force ? { force: true } : {}),
      });
      if (updated.cardStatus === "done" && (updated.doneReason === "abandoned" || updated.doneReason === "completed")) {
        disposeTaskWorker(updated.id);
      }
      return { id: updated.id, cardStatus: updated.cardStatus, doneReason: updated.doneReason };
    },
  });

  const clearInvestigationComplete = defineTool<{ allUsers?: boolean }>({
    name: "clear_investigation_complete",
    description:
      "Clear the Investigation Complete column: mark reviewed investigation cards (status investigation_complete) as done. Defaults to the requester's own cards only; pass allUsers:true to clear the whole column for everyone. Use this to tidy the board once investigation findings have been read.",
    parameters: {
      type: "object",
      properties: {
        allUsers: { type: "boolean", description: "Clear every user's investigation-complete cards, not just the requester's. Default false." },
      },
    },
    handler: async (args, ctx) => {
      const rows = await tasks.list({ workspaceId: ctx.workspaceId }, "investigation_complete");
      const targets = rows.filter((t) => args.allUsers || (ctx.userId != null && t.createdBy === ctx.userId));
      const cleared: string[] = [];
      for (const t of targets) {
        const updated = await tasks.transition({ workspaceId: ctx.workspaceId }, t.id, "done", BRAIN, {
          reason: "Cleared from Investigation Complete column",
          doneReason: "completed",
        });
        disposeTaskWorker(updated.id);
        cleared.push(updated.id);
      }
      return { cleared: cleared.length, ids: cleared, scope: args.allUsers ? "all_users" : "requester" };
    },
  });

  // ── Worker control tools (require WorkerDriver injection) ─────────────────

  const checkWorker = defineTool<{ id: string }>({
    name: "check_worker",
    description: "Get current status of a task's worker: active, workerStatus, branch, PR info, last 5 transcript messages.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: TASK_REFERENCE_DESCRIPTION } },
    },
    handler: async (args, ctx) => {
      const resolved = await resolveTaskReference(ctx.workspaceId, args.id);
      if (resolved.status !== "found") return unresolvedTaskReference(resolved, args.id);
      const t = resolved.task;
      const recentMessages = await prisma.message.findMany({
        where: { workspaceId: ctx.workspaceId, channel: t.id },
        orderBy: { seq: "desc" },
        take: 5,
        select: { role: true, content: true, ts: true },
      });
      return {
        found: true,
        id: t.id,
        title: t.title,
        cardStatus: t.cardStatus,
        workerActive: t.workerActive,
        workerStatus: t.workerStatus,
        branch: t.branch,
        prNumber: t.prNumber,
        prState: t.prState,
        recentMessages: recentMessages.reverse(),
      };
    },
  });

  const messageWorker = defineTool<{ id: string; message: string }>({
    name: "message_worker",
    description: "Send a follow-up instruction to a task's worker. Reports delivery only after a new idle-worker turn is claimed.",
    parameters: {
      type: "object",
      required: ["id", "message"],
      properties: {
        id: { type: "string", description: TASK_REFERENCE_DESCRIPTION },
        message: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const blocked = attachmentEscalationBlocked(ctx, args.message);
      if (blocked) return blocked;
      if (!worker?.acceptTaskMessage) return { error: "WorkerDriver does not support dispatch-confirmed follow-ups" };
      const resolved = await resolveTaskReference(ctx.workspaceId, args.id);
      if (resolved.status !== "found") return unresolvedTaskReference(resolved, args.id);
      const t = resolved.task;
      // No queue exists: be honest that a busy worker means the message was NOT
      // delivered, so the brain retries later instead of assuming it landed.
      if (t.workerActive) return { delivered: false, reason: "worker is busy; message not delivered — retry once it's idle" };
      const accepted = await worker.acceptTaskMessage(ctx.workspaceId, t.id, args.message, "brain", { requireIdle: true });
      if (!accepted?.dispatched) return { delivered: false, reason: "worker turn was not claimed; message not delivered — retry once the worker is idle" };
      return { delivered: true };
    },
  });

  const resurrectWorker = defineTool<{ id: string; instruction?: string }>({
    name: "resurrect_worker",
    description: "Re-spawn the worker for a stuck or needs_help task, optionally with new instructions.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: TASK_REFERENCE_DESCRIPTION },
        instruction: { type: "string", description: "Optional new direction for the worker." },
      },
    },
    handler: async (args, ctx) => {
      const blocked = attachmentEscalationBlocked(ctx, args.instruction ?? "");
      if (blocked) return blocked;
      if (!worker) return { error: "WorkerDriver not configured" };
      const scope = { workspaceId: ctx.workspaceId };
      const resolved = await resolveTaskReference(ctx.workspaceId, args.id);
      if (resolved.status !== "found") return unresolvedTaskReference(resolved, args.id);
      let t = resolved.task;
      if (t.workerActive) return { resurrected: false, reason: "worker is still active" };

      // Move card back to bot_working if it's waiting for human/brain input.
      if (t.cardStatus === "needs_help" || t.cardStatus === "investigation_complete") {
        t = await tasks.transition(scope, t.id, "bot_working", BRAIN, { reason: "brain resurrect" });
      }

      if (t.cardType === "plan" && t.planDocument?.trim()) {
        t = await prisma.task.update({ where: { id: t.id }, data: { cardType: "bot" } });
      }

      const priorMessages = await messages.list(scope, t.id, { limit: 100 });
      const msg = buildWorkerResumeMessage(t, priorMessages, args.instruction);
      worker.spawnWorker(t, msg);
      return { resurrected: true };
    },
  });

  const updateTask = defineTool<{ id: string; title?: string; description?: string; checklist?: { id: string; text: string; checked: boolean }[] }>({
    name: "update_task",
    description: "Update a task's title, description, or checklist items.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: TASK_REFERENCE_DESCRIPTION },
        title: { type: "string" },
        description: { type: "string" },
        checklist: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "text", "checked"],
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              checked: { type: "boolean" },
            },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const resolved = await resolveTaskReference(ctx.workspaceId, args.id);
      if (resolved.status !== "found") return unresolvedTaskReference(resolved, args.id);
      const t = resolved.task;
      const data: Record<string, unknown> = {};
      if (args.title !== undefined) data.title = args.title;
      if (args.description !== undefined) data.description = args.description;
      if (args.checklist !== undefined) data.checklist = args.checklist;
      await prisma.task.update({ where: { id: t.id }, data });
      bus.publish(chanTopic(ctx.workspaceId, t.id), { type: "task_updated" });
      return { updated: true };
    },
  });

  const archiveTask = defineTool<{ id: string }>({
    name: "archive_task",
    description: "Archive a task so it no longer appears on the board. If the task has active worker work, this aborts it by marking the card canceled before archiving.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: TASK_REFERENCE_DESCRIPTION } },
    },
    handler: async (args, ctx) => {
      const resolved = await resolveTaskReference(ctx.workspaceId, args.id);
      if (resolved.status !== "found") return unresolvedTaskReference(resolved, args.id);
      const t = resolved.task;
      const activeWorker = t.workerActive || t.cardStatus === "bot_working" || t.cardStatus === "interactive";
      if (t.cardStatus !== "canceled" && activeWorker) {
        await tasks.transition({ workspaceId: ctx.workspaceId }, t.id, "canceled", BRAIN, { reason: "Archived by brain while worker work was active." });
      }
      await prisma.task.update({ where: { id: t.id }, data: { archivedAt: new Date() } });
      return { archived: true, abortedActiveWorker: activeWorker };
    },
  });

  const ignore = defineTool<{ reason?: string }>({
    name: "ignore",
    description:
      "Call this when the incoming message is NOT for you — people chatting, thinking out loud, or talking to someone else — so no reply is warranted. It ends your turn silently: nothing is posted. Prefer this over a filler reply when there's no clear ask for you.",
    parameters: {
      type: "object",
      required: [],
      properties: { reason: { type: "string", description: "brief why, for logs (optional)" } },
    },
    handler: async () => ({ ignored: true }),
  });

  const replyToSlack = defineTool<{ channel?: string; text: string; thread_ts?: string }>({
    name: "reply_to_slack",
    description:
      "Post a message to Slack. In a Slack request it goes to the current thread automatically — use it to send progress updates or notes WHILE you work (e.g. \"On it — checking the repo…\"). Your final answer is posted for you, so don't repeat it here. Outside a Slack request, pass the channel id to message a specific channel.",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        channel: { type: "string", description: "Slack channel ID (e.g. C12345678). Omit in a Slack request — it defaults to the current thread." },
        text: { type: "string" },
        thread_ts: { type: "string", description: "Thread timestamp to reply in-thread; omit for a new top-level message." },
      },
    },
    handler: async (args, ctx) => {
      if (!slackDrv) return { error: "Slack not configured" };
      // In a Slack-originated turn, always target the originating thread — the
      // brain shouldn't have to know (or be able to spoof) the channel/thread.
      const channel = ctx.slackOrigin?.channel ?? args.channel;
      const threadTs = ctx.slackOrigin?.threadTs ?? args.thread_ts;
      if (!channel) return { error: "no channel: pass a channel id (no Slack thread in context)" };
      await slackDrv.postMessage(channel, args.text, threadTs);
      return { ok: true };
    },
  });

  // Linear tools resolve the workspace's actor=app OAuth token from ctx — so
  // reads are workspace-scoped and writes (comments) post as the Manta bot.
  const linearToken = (ctx: { workspaceId: string }) => linearTokenForWorkspace(ctx.workspaceId);

  const listLinearTeams = defineTool({
    name: "list_linear_teams",
    description: "List available Linear teams. Use to find the teamId before creating a Linear issue.",
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      const token = await linearToken(ctx);
      if (!token) return { error: "Linear not connected" };
      return { teams: await linearListTeams(token) };
    },
  });

  const listLinearMembers = defineTool({
    name: "list_linear_members",
    description: "List active Linear members. Use to find an assigneeId before assigning a Linear issue to the relevant engineer.",
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      const token = await linearToken(ctx);
      if (!token) return { error: "Linear not connected" };
      return { members: await linearListMembers(token) };
    },
  });

  const getLinearIssue = defineTool<{ issueId: string }>({
    name: "get_linear_issue",
    description: "Fetch a single Linear issue by UUID or identifier (e.g. ENG-42). Returns title, description, state, and URL.",
    parameters: {
      type: "object",
      required: ["issueId"],
      properties: { issueId: { type: "string", description: "Linear issue UUID or identifier like ENG-42" } },
    },
    handler: async (args, ctx) => {
      const token = await linearToken(ctx);
      if (!token) return { error: "Linear not connected" };
      const issue = await linearGetIssue(args.issueId, token);
      if (!issue) return { found: false };
      return { found: true, ...issue };
    },
  });

  const listLinearIssues = defineTool<{ teamId: string; limit?: number }>({
    name: "list_linear_issues",
    description: "List active Linear issues for a team (unstarted + in-progress), each with its assignee. Use list_linear_teams first to get the teamId.",
    parameters: {
      type: "object",
      required: ["teamId"],
      properties: {
        teamId: { type: "string" },
        limit: { type: "number", description: "Max issues to return (default 25). Ask for what you need — the server pages Linear internally; values above 500 are clamped to 500, not rejected." },
      },
    },
    handler: async (args, ctx) => {
      const token = await linearToken(ctx);
      if (!token) return { error: "Linear not connected" };
      const issues = await linearListIssues(args.teamId, { limit: args.limit }, token);
      return { issues };
    },
  });

  const listLinearView = defineTool<{ viewId: string; limit?: number }>({
    name: "list_linear_view",
    description:
      "Enumerate all issues in a Linear custom view by the view's UUID (from its URL). " +
      "A custom view holds a saved filter no team/state query can reproduce, so this is the only way " +
      "to triage a saved set (e.g. an automation's aging-candidates view). Returns each issue's " +
      "identifier, title, state, assignee, and description.",
    parameters: {
      type: "object",
      required: ["viewId"],
      properties: {
        viewId: { type: "string", description: "Linear custom view UUID." },
        limit: { type: "number", description: "Max issues to return (default 100, capped at 500)." },
      },
    },
    handler: async (args, ctx) => {
      const token = await linearToken(ctx);
      if (!token) return { error: "Linear not connected" };
      const { view, issues } = await linearListCustomViewIssues(args.viewId, { limit: args.limit }, token);
      if (!view) return { found: false };
      return { found: true, view, issues };
    },
  });

  const findDuplicateLinearIssue = defineTool<{ teamId: string; text: string; slackPermalink?: string }>({
    name: "find_duplicate_linear_issue",
    description:
      "Find an existing open Linear issue for a support request before creating a new one. " +
      "If slackPermalink is omitted during a Slack turn, the originating Slack thread permalink is used automatically. " +
      "Checks exact Slack attachments first, then searches Linear and reads candidate title, description, and recent comments before returning only a high-confidence same-issue match.",
    parameters: {
      type: "object",
      required: ["teamId", "text"],
      properties: {
        teamId: { type: "string" },
        text: { type: "string", description: "The user's support request text" },
        slackPermalink: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const token = await linearToken(ctx);
      if (!token) return { error: "Linear not connected" };
      if (ctx.slackOrigin && ctx.turnState) ctx.turnState.linearSupportTriage = true;
      const permalink = args.slackPermalink ?? (ctx.slackOrigin?.threadTs && slackDrv?.getPermalink ? await slackDrv.getPermalink(ctx.slackOrigin.channel, ctx.slackOrigin.threadTs).catch(() => null) : null);
      if (permalink) {
        const attached = await linearFindIssueBySlackUrl(permalink, token);
        if (attached) return { found: true, matchType: "slack_permalink", slackPermalink: permalink, issue: attached };
      }
      const issue = await linearSearchDuplicateIssue(args.teamId, args.text, token);
      return issue ? { found: true, matchType: "verified_search", ...(permalink ? { slackPermalink: permalink } : {}), issue } : { found: false, ...(permalink ? { slackPermalink: permalink } : {}) };
    },
  });

  const createLinearIssue = defineTool<{ teamId: string; title: string; description?: string; priority?: number; labelNames?: string[]; labelIds?: string[]; assigneeId?: string; slackPermalink?: string }>({
    name: "create_linear_issue",
    description:
      "Create a new Linear issue and return its identifier (e.g. ENG-42) and URL. " +
      "Use list_linear_teams first to pick the correct teamId, and for Slack support requests call find_duplicate_linear_issue before creating. " +
      "During Slack support triage, after find_duplicate_linear_issue has been called, Bug, Support, and On-call triage labels are applied automatically so the issue appears in the on-call triage view; pass labelNames only for additional labels. " +
      "Priority: 0=no priority, 1=urgent, 2=high, 3=medium, 4=low. " +
      "If slackPermalink is omitted during a Slack turn, the originating thread permalink is attached automatically.",
    parameters: {
      type: "object",
      required: ["teamId", "title"],
      properties: {
        teamId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "number" },
        labelNames: { type: "array", items: { type: "string" }, description: "Linear label names to apply, e.g. [\"Bug\"]." },
        labelIds: { type: "array", items: { type: "string" }, description: "Linear label IDs to apply directly, if known." },
        assigneeId: { type: "string", description: "Linear user ID to assign on create. Use list_linear_members first." },
        slackPermalink: { type: "string", description: "Slack thread URL to attach to the issue" },
      },
    },
    handler: async (args, ctx) => {
      const blocked = attachmentEscalationBlocked(ctx, `${args.title}\n${args.description ?? ""}`);
      if (blocked) return blocked;
      const token = await linearToken(ctx);
      if (!token) return { error: "Linear not connected" };
      const slackPermalink = args.slackPermalink ?? (ctx.slackOrigin?.threadTs && slackDrv?.getPermalink ? await slackDrv.getPermalink(ctx.slackOrigin.channel, ctx.slackOrigin.threadTs).catch(() => null) ?? undefined : undefined);
      const descriptionWithSlackPermalink = slackPermalink && args.description && !args.description.includes(slackPermalink)
        ? `${args.description}\n\nSlack thread: ${slackPermalink}`
        : args.description;
      const description = withSlackLinearRequestMarker(descriptionWithSlackPermalink, ctx.slackOrigin);
      const labelNames = linearIssueLabelNamesForCreate(args, Boolean(ctx.slackOrigin && ctx.turnState?.linearSupportTriage));
      const issue = await linearCreateIssue(args.teamId, args.title, {
        ...(description ? { description } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(labelNames ? { labelNames } : {}),
        ...(args.labelIds ? { labelIds: args.labelIds } : {}),
        ...(args.assigneeId ? { assigneeId: args.assigneeId } : {}),
        ...(slackPermalink ? { slackUrl: slackPermalink } : {}),
      }, undefined, token);
      return issue;
    },
  });

  const attachSlackPermalinkToLinearIssue = defineTool<{ issueId: string; slackPermalink?: string }>({
    name: "attach_slack_permalink_to_linear_issue",
    description: "Attach the current Slack thread (or a provided Slack permalink) to an existing Linear issue, enabling Linear's Slack attachment/comment sync when available.",
    parameters: {
      type: "object",
      required: ["issueId"],
      properties: { issueId: { type: "string" }, slackPermalink: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const token = await linearToken(ctx);
      if (!token) return { error: "Linear not connected" };
      const permalink = args.slackPermalink ?? (ctx.slackOrigin?.threadTs && slackDrv?.getPermalink ? await slackDrv.getPermalink(ctx.slackOrigin.channel, ctx.slackOrigin.threadTs).catch(() => null) : null);
      if (!permalink) return { error: "no Slack permalink available" };
      return { ok: await linearAttachSlackUrl(args.issueId, permalink, token), slackPermalink: permalink };
    },
  });

  const assignLinearIssue = defineTool<{ issueId: string; assigneeId: string }>({
    name: "assign_linear_issue",
    description: "Assign an existing Linear issue to an engineer and move it back to Todo for their review work. Use list_linear_members first to find the relevant engineer's assigneeId.",
    parameters: {
      type: "object",
      required: ["issueId", "assigneeId"],
      properties: {
        issueId: { type: "string", description: "Linear issue UUID or identifier like ENG-42" },
        assigneeId: { type: "string", description: "Linear user ID from list_linear_members" },
      },
    },
    handler: async (args, ctx) => {
      const blocked = attachmentEscalationBlocked(ctx, args.issueId);
      if (blocked) return blocked;
      const token = await linearToken(ctx);
      if (!token) return { error: "Linear not connected" };
      await linearAssignIssue(args.issueId, args.assigneeId, token);
      return { ok: true };
    },
  });

  const commentOnLinearIssue = defineTool<{ issueId: string; body: string }>({
    name: "comment_on_linear_issue",
    description:
      "Post a comment on a Linear issue (by UUID or identifier like ENG-42). " +
      "The comment is posted as the Manta bot. Use to reply to a request, give a status update, or hand off a result.",
    parameters: {
      type: "object",
      required: ["issueId", "body"],
      properties: {
        issueId: { type: "string", description: "Linear issue UUID or identifier like ENG-42" },
        body: { type: "string", description: "Markdown comment body" },
      },
    },
    handler: async (args, ctx) => {
      const token = await linearAppTokenForWorkspace(ctx.workspaceId);
      if (!token) return { error: "Linear app OAuth is not connected; refusing to post with a user token" };
      await linearCommentOnIssue(args.issueId, args.body, token);
      return { ok: true };
    },
  });

  const updateLinearIssue = defineTool<{ issueId: string; stateId?: string; stateName?: string; labelIds?: string[]; labelNames?: string[] }>({
    name: "update_linear_issue",
    description:
      "Update an existing Linear issue by UUID or identifier (e.g. ENG-42). " +
      "Use this to move status/state and/or add labels such as AutoValidated or NeedsHumanQA. " +
      "Pass stateName (e.g. Done) or stateId, and labelNames or labelIds. Existing labels are preserved.",
    parameters: {
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string", description: "Linear issue UUID or identifier like ENG-42" },
        stateId: { type: "string", description: "Linear workflow state ID to move to, if known" },
        stateName: { type: "string", description: "Linear workflow state name to move to, e.g. Done" },
        labelIds: { type: "array", items: { type: "string" }, description: "Linear label IDs to add, if known" },
        labelNames: { type: "array", items: { type: "string" }, description: "Linear label names to add, e.g. [\"AutoValidated\"]" },
      },
    },
    handler: async (args, ctx) => {
      const blocked = attachmentEscalationBlocked(ctx, `${args.issueId}\n${args.stateName ?? ""}\n${(args.labelNames ?? []).join("\n")}`);
      if (blocked) return blocked;
      const token = await linearAppTokenForWorkspace(ctx.workspaceId);
      if (!token) return { error: "Linear app OAuth is not connected; refusing to mutate with a user token" };
      const issue = await linearUpdateIssue(args.issueId, {
        ...(args.stateId ? { stateId: args.stateId } : {}),
        ...(args.stateName ? { stateName: args.stateName } : {}),
        ...(args.labelIds ? { labelIds: args.labelIds } : {}),
        ...(args.labelNames ? { labelNames: args.labelNames } : {}),
      }, token);
      return { ok: true, issue };
    },
  });

  const appendTeamMemory = defineTool<{ text: string }>({
    name: "append_team_memory",
    description:
      "Append a new fact or learning to the workspace's team memory. " +
      "Use this when you learn something durable — a convention, a decision, a gotcha — that future brain sessions should know. " +
      "Keep entries concise (1-3 sentences). Each call appends a new line.",
    parameters: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", description: "The fact or learning to record." } },
    },
    handler: async (args, ctx) => {
      const ws = await prisma.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { teamMemory: true } });
      const existing = ws?.teamMemory?.trim() ?? "";
      const updated = existing ? `${existing}\n${args.text.trim()}` : args.text.trim();
      await prisma.workspace.update({ where: { id: ctx.workspaceId }, data: { teamMemory: updated } });
      return { ok: true, totalLength: updated.length };
    },
  });

  // ── Delegate a read-only question to a worker (no Task) ───────────────────

  const answerQuestion = defineTool<{ repo: string; question: string }>({
    name: "answer_question",
    description:
      "Answer a question about a repo's code by delegating to a worker that runs a read-only agent in a real checkout — no card, no code changes. " +
      "Use for 'how does X work / where is Y / why does Z happen' questions. Use create_task instead when the user wants code CHANGED. " +
      "Returns the worker's answer, which you should relay (lightly edited) to the user.",
    parameters: {
      type: "object",
      required: ["repo", "question"],
      properties: {
        repo: { type: "string", description: "org/repo" },
        question: { type: "string", description: "the question to investigate in the repo" },
      },
    },
    handler: async (args, ctx) => {
      if (!questionDrv) return { error: "question delegation not configured" };
      // When the turn came from Slack, stream the worker's progress notes into
      // the thread so a long investigation isn't silent.
      const origin = ctx.slackOrigin;
      const onUpdate =
        origin && slackDrv
          ? (text: string) => void slackDrv.postMessage(origin.channel, text, origin.threadTs).catch(() => {})
          : undefined;
      const repo = await canonicalRepoForWorkspace(ctx.workspaceId, args.repo);
      const res = await questionDrv.ask(ctx.workspaceId, repo, args.question, onUpdate);
      if (res.ok) return { answer: res.answer };
      if (res.reason === "no_worker") {
        return { error: "no_worker", message: "No worker is online to investigate the repo right now. Offer to create a task instead." };
      }
      if (res.reason === "timeout") {
        return {
          error: "timeout",
          message: `The worker didn't finish in time (${res.message ?? "timed out"}). The checkout itself is fast, so this usually means the investigation ran long. Tell the user plainly and offer to create a task to dig in.`,
        };
      }
      // res.message is now specific (e.g. "couldn't check out org/repo: git fetch
      // timed out after 90s") — relay it so the user knows what actually broke.
      return { error: "failed", message: res.message ?? "The worker couldn't answer the question." };
    },
  });

  return [createTask, listTasks, getTask, transitionStatus, clearInvestigationComplete, updateTask, archiveTask, checkWorker, messageWorker, resurrectWorker, answerQuestion, replyToSlack, ignore, listLinearTeams, listLinearMembers, getLinearIssue, listLinearIssues, listLinearView, findDuplicateLinearIssue, createLinearIssue, attachSlackPermalinkToLinearIssue, assignLinearIssue, commentOnLinearIssue, updateLinearIssue, ...buildNotionTools(), appendTeamMemory];
}
