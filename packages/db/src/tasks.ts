import { randomBytes } from "node:crypto";
import { isTransitionAllowed, type CardTransition } from "@manta/shared";
import { prisma } from "./client.ts";
import type { WorkspaceScope } from "./index.ts";
import type {
  Task,
  TaskKind,
  TaskType,
  CardType,
  CardStatus,
  TransitionActor,
  DoneReason,
  WorkerStatus,
  WorkerVenue,
  VenueStatus,
} from "../generated/client/index.js";

/**
 * Short, URL-safe task id (the prototype scheme: `c-XXXX`). 6 random bytes (12 hex)
 * gives a ~2^48 space: the worktree dir and branch name are both keyed on this
 * id, and 3 bytes (16.7M) hit birthday-paradox collisions in the hundreds-of-
 * cards range, which let two cards share a worktree/branch. 6 bytes makes that
 * collision astronomically unlikely, so paths/branches stay unique by
 * construction. (Worktree ownership is also stamped in the daemon as a backstop.)
 */
export function newTaskId(prefix = "c"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

export interface CreateTaskInput {
  name: string;
  title: string;
  description: string;
  kind: TaskKind;
  cardType: CardType;
  repo: string;
  workerBackend: string;
  cardStatus?: CardStatus;
  type?: TaskType;
  model?: string;
  /** Linear issue identifier to link (e.g. "ENG-42"). */
  linearIssueIdentifier?: string;
  /** User who created the card (UI/chat). Omit for automation-created cards. */
  createdBy?: string;
  /** Hidden background cards power worker runs but do not appear on the board. */
  hidden?: boolean;
  /** Hidden worker execution mode, e.g. read-only scheduled runs vs orchestration-capable checks. */
  backgroundMode?: string;
  /** Slack origin, stamped when the card is spawned from a Slack request so the
   * outbound notifier can post the Done/ready/needs_help update back in-thread. */
  slackChannel?: string;
  slackThreadTs?: string;
  slackUserId?: string;
  slackBotId?: string;
  /** Override the generated id (tests, deterministic seeds). */
  id?: string;
}

export type DuplicateTaskMatchReason = "linear_issue" | "slack_thread" | "title" | "description";

export interface DuplicateTaskMatch {
  task: Task;
  reason: DuplicateTaskMatchReason;
}

const ACTIVE_DUPLICATE_STATUSES: CardStatus[] = [
  "backlog",
  "bot_working",
  "needs_help",
  "ready_to_test",
  "interactive",
  "pr_review",
  "investigation_complete",
];

function canonicalText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalLinearIdentifier(value: string | null | undefined): string | null {
  const direct = value?.trim();
  if (direct) return direct.toUpperCase();
  return null;
}

function extractLinearIdentifier(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const match = value?.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

function sameCanonicalText(a: string, b: string, minLength: number): boolean {
  return a.length >= minLength && a === b;
}

/**
 * Find an active, non-archived task that already represents the same incoming
 * request. The board is the source of truth: disconnected/needs-help/ready
 * cards are still active work and must be nudged/reused rather than replaced.
 */
export async function findActiveDuplicate(scope: WorkspaceScope, input: CreateTaskInput): Promise<DuplicateTaskMatch | null> {
  const incomingLinear = canonicalLinearIdentifier(input.linearIssueIdentifier)
    ?? extractLinearIdentifier(input.title, input.name, input.description);
  const incomingTitle = canonicalText(input.title || input.name);
  const incomingDescription = canonicalText(input.description);
  const hasSlackThread = Boolean(input.slackChannel && input.slackThreadTs);

  const candidates = await prisma.task.findMany({
    where: {
      workspaceId: scope.workspaceId,
      archivedAt: null,
      hidden: false,
      cardStatus: { in: ACTIVE_DUPLICATE_STATUSES },
      OR: [
        ...(incomingLinear ? [{ linearIssueIdentifier: { not: null } }] : []),
        ...(hasSlackThread ? [{ slackChannel: input.slackChannel, slackThreadTs: input.slackThreadTs }] : []),
        { repo: input.repo },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  for (const task of candidates) {
    const taskLinear = canonicalLinearIdentifier(task.linearIssueIdentifier)
      ?? extractLinearIdentifier(task.title, task.name, task.description);
    if (incomingLinear && taskLinear === incomingLinear) return { task, reason: "linear_issue" };
  }

  for (const task of candidates) {
    if (hasSlackThread && task.slackChannel === input.slackChannel && task.slackThreadTs === input.slackThreadTs) {
      return { task, reason: "slack_thread" };
    }
  }

  for (const task of candidates) {
    if (task.repo !== input.repo) continue;
    if (sameCanonicalText(incomingTitle, canonicalText(task.title || task.name), 12)) return { task, reason: "title" };
    if (sameCanonicalText(incomingDescription, canonicalText(task.description), 24)) return { task, reason: "description" };
  }

  return null;
}

/** Stamp any newly-discovered origin metadata onto a reused duplicate card. */
export async function attachDuplicateMetadata(scope: WorkspaceScope, id: string, input: CreateTaskInput): Promise<Task> {
  const existing = await get(scope, id);
  if (!existing) throw new TaskNotFoundError(id);

  const data: Partial<Pick<Task, "linearIssueIdentifier" | "slackChannel" | "slackThreadTs" | "slackUserId" | "slackBotId">> = {};
  if (!existing.linearIssueIdentifier && input.linearIssueIdentifier) data.linearIssueIdentifier = input.linearIssueIdentifier;
  if (!existing.slackChannel && input.slackChannel) data.slackChannel = input.slackChannel;
  if (!existing.slackThreadTs && input.slackThreadTs) data.slackThreadTs = input.slackThreadTs;
  if (!existing.slackUserId && input.slackUserId) data.slackUserId = input.slackUserId;
  if (!existing.slackBotId && input.slackBotId) data.slackBotId = input.slackBotId;

  if (Object.keys(data).length === 0) return existing;
  return prisma.task.update({ where: { id }, data });
}

/** Create a task INSIDE the given workspace. workspaceId comes from the scope,
 * never from caller input, so a task can't be misfiled into another workspace. */
export function create(scope: WorkspaceScope, input: CreateTaskInput): Promise<Task> {
  return prisma.$transaction(async (tx) => {
    const count = await tx.task.count({
      where: { workspaceId: scope.workspaceId, repo: input.repo },
    });
    return tx.task.create({
      data: {
        id: input.id ?? newTaskId(),
        workspaceId: scope.workspaceId,
        name: input.name,
        title: input.title,
        description: input.description,
        kind: input.kind,
        cardType: input.cardType,
        repo: input.repo,
        workerBackend: input.workerBackend,
        taskNumber: count + 1,
        ...(input.type ? { type: input.type } : {}),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        ...(input.hidden ? { hidden: true } : {}),
        ...(input.backgroundMode ? { backgroundMode: input.backgroundMode } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.cardStatus ? { cardStatus: input.cardStatus } : {}),
        ...(input.linearIssueIdentifier ? { linearIssueIdentifier: input.linearIssueIdentifier } : {}),
        ...(input.slackChannel ? { slackChannel: input.slackChannel } : {}),
        ...(input.slackThreadTs ? { slackThreadTs: input.slackThreadTs } : {}),
        ...(input.slackUserId ? { slackUserId: input.slackUserId } : {}),
        ...(input.slackBotId ? { slackBotId: input.slackBotId } : {}),
      },
    });
  });
}

export interface ListTasksOptions {
  status?: CardStatus;
  /** Include hidden background-worker debug cards alongside regular board cards. */
  includeBackgroundDebug?: boolean;
}

/** List non-archived tasks in the workspace, optionally filtered by status. */
export function list(scope: WorkspaceScope, statusOrOptions?: CardStatus | ListTasksOptions): Promise<Task[]> {
  const opts: ListTasksOptions = typeof statusOrOptions === "string" ? { status: statusOrOptions } : statusOrOptions ?? {};
  return prisma.task.findMany({
    where: {
      workspaceId: scope.workspaceId,
      archivedAt: null,
      ...(opts.includeBackgroundDebug
        ? { OR: [{ hidden: false }, { hidden: true, backgroundMode: { in: ["scheduled_slack", "spot_check", "linear_status_automation"] } }] }
        : { hidden: false }),
      ...(opts.status ? { cardStatus: opts.status } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}

/** Fetch one task by id, scoped to the workspace. Returns null if it belongs to
 * a different workspace — existence is not disclosed across the boundary. */
export function get(scope: WorkspaceScope, id: string): Promise<Task | null> {
  return prisma.task.findFirst({
    where: { id, workspaceId: scope.workspaceId },
  });
}

export interface WorkerFields {
  workerStatus?: WorkerStatus;
  workerActive?: boolean;
  worktreePath?: string;
  branch?: string;
  /** Pi JSONL session pointer — persisted so follow-up turns resume context. */
  sessionBlobKey?: string;
  /** Which venue runs the task's work, and its lifecycle state. */
  workerVenue?: WorkerVenue;
  venueStatus?: VenueStatus;
  venueStoppedAt?: Date | null;
  /** Daytona sandbox id (cloud venue) — also reattachable by workspace+task label. */
  sandboxId?: string | null;
}

export interface PrFields {
  title?: string;
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prState?: string;
  prUpdatedAt?: Date;
}

/** Update PR metadata on a task (workspace-scoped). */
export async function setPr(scope: WorkspaceScope, id: string, fields: PrFields): Promise<void> {
  await prisma.task.updateMany({ where: { id, workspaceId: scope.workspaceId }, data: fields });
}

/** Update worker-lifecycle fields on a task (workspace-scoped). */
export async function setWorker(scope: WorkspaceScope, id: string, fields: WorkerFields): Promise<void> {
  await prisma.task.updateMany({ where: { id, workspaceId: scope.workspaceId }, data: fields });
}

/**
 * Atomically claim the worker slot for a task: flip `workerActive` false→true in a
 * single conditional write, returning whether THIS caller won the claim.
 *
 * Use this to gate worker dispatch. A read-then-spawn guard (`if (!task.workerActive)
 * spawnWorker(...)`) is a TOCTOU race: `spawnWorker` is fire-and-forget and doesn't
 * set `workerActive` until several awaits deep, so two concurrent/duplicate requests
 * (e.g. a double drag-to-Working) both read `false` and both spawn a worker for the
 * same card. The DB compare-and-swap here lets exactly one win.
 */
export async function beginWork(scope: WorkspaceScope, id: string): Promise<boolean> {
  const res = await prisma.task.updateMany({
    where: { id, workspaceId: scope.workspaceId, workerActive: false },
    data: { workerActive: true, workerStatus: "running" },
  });
  return res.count === 1;
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task ${id} not found in workspace`);
    this.name = "TaskNotFoundError";
  }
}

export class TransitionNotAllowedError extends Error {
  constructor(
    readonly from: CardStatus,
    readonly to: CardStatus,
    readonly by: TransitionActor,
  ) {
    super(`Transition ${from}->${to} not allowed for actor "${by}"`);
    this.name = "TransitionNotAllowedError";
  }
}

export interface TransitionOptions {
  reason?: string;
  doneReason?: DoneReason;
  /**
   * Bypass the kanban edge allow-list (`isTransitionAllowed`) for this move.
   * A deliberate escape hatch for orchestration/recovery (e.g. the brain pulling
   * a wrongly-`done` card back to `needs_help`, an edge no actor has otherwise).
   * Still rejects no-op `from === to` moves; the audit row records the actor.
   */
  force?: boolean;
}

const READY_TO_TEST_PR_STATUS_RESET = {
  checks: [],
  checksStatus: "unknown" as const,
  reviewDecision: null,
  mergeable: "UNKNOWN" as const,
  autoMergeEnabled: false,
};

/**
 * Move a task to a new status, validated by the shared kanban state machine
 * (`isTransitionAllowed`). Atomically: appends a TaskTransition audit row,
 * updates `cardStatus` (+ `doneReason` when entering `done`/investigation-complete), and pushes onto
 * the `transitions` JSON mirror. Throws if the task isn't in the scope or the
 * edge is disallowed for the actor — unless `opts.force` is set, which skips the
 * edge allow-list (but still rejects a no-op `from === to`).
 */
export async function transition(
  scope: WorkspaceScope,
  id: string,
  to: CardStatus,
  by: TransitionActor,
  opts: TransitionOptions = {},
): Promise<Task> {
  const task = await get(scope, id);
  if (!task) throw new TaskNotFoundError(id);

  const from = task.cardStatus;
  // `from === to` is always a no-op and rejected, even under force.
  if (from === to) throw new TransitionNotAllowedError(from, to, by);
  if (!opts.force && !isTransitionAllowed(from, to, by, opts.doneReason)) {
    throw new TransitionNotAllowedError(from, to, by);
  }

  const at = new Date();
  const entry: CardTransition = {
    from,
    to,
    at: at.toISOString(),
    by,
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
  const existing = Array.isArray(task.transitions)
    ? (task.transitions as unknown as CardTransition[])
    : [];

  return prisma.$transaction(async (tx) => {
    await tx.taskTransition.create({
      data: {
        taskId: id,
        workspaceId: scope.workspaceId,
        fromStatus: from,
        toStatus: to,
        by,
        ...(opts.reason ? { reason: opts.reason } : {}),
        at,
      },
    });
    return tx.task.update({
      where: { id },
      data: {
        cardStatus: to,
        ...(to === "ready_to_test" ? READY_TO_TEST_PR_STATUS_RESET : {}),
        ...(to === "done" && opts.doneReason ? { doneReason: opts.doneReason } : {}),
        ...(to === "investigation_complete" ? { doneReason: "investigation_complete" as const } : {}),
        transitions: [...existing, entry] as unknown as object[],
      },
    });
  });
}
