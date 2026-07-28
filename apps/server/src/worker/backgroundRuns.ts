import { messages, prisma, repos, tasks } from "@manta/db";
import type { AgentEvent } from "@manta/shared";
import { bus, chanTopic } from "../bus.ts";
import { createLogger } from "../logger.ts";
import { startWorkerForTask } from "./dispatch.ts";
import { listWorkersWithPresence } from "./registry.ts";

const logger = createLogger("Manta:BackgroundWorkerRuns");

const BACKGROUND_RUN_TIMEOUT_MS = 15 * 60 * 1000;

export interface WorkerBackgroundRunInput {
  workspaceId: string;
  /** Branch-friendly task name used by workers for generated refs. */
  name?: string;
  /** Human-readable task title shown in transcripts and logs. */
  title: string;
  prompt: string;
  backendId: string;
  repo?: string | null;
  mode?: "readonly" | "orchestration" | "scheduled_slack" | "spot_check" | "linear_status_automation";
  /** Show the worker card on the board instead of keeping it hidden. */
  visible?: boolean;
  /** User to own a visible debug/background card. */
  createdBy?: string;
  onTaskCreated?: (taskId: string) => void | Promise<void>;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface WorkerBackgroundRunResult {
  text: string;
  events: AgentEvent[];
  taskId: string;
  ownerUserId?: string;
  terminalReason?: string;
}

async function firstEnabledRepo(workspaceId: string): Promise<string> {
  const rows = await repos.list({ workspaceId });
  const repo = rows.find((row) => row.enabled)?.orgRepo;
  if (!repo) throw new Error("no_enabled_repo_for_worker_background_run");
  return repo;
}

async function resolveRunRepo(workspaceId: string, requested: string | null | undefined): Promise<string> {
  const repo = requested?.trim();
  if (!repo) return firstEnabledRepo(workspaceId);
  const found = await repos.byOrgRepo({ workspaceId }, repo).catch(() => null);
  if (!found?.enabled) throw new Error("invalid_background_run_repo");
  return found.orgRepo;
}

async function ownerForLocalWorker(workspaceId: string): Promise<string | undefined> {
  const [workers, memberships] = await Promise.all([
    listWorkersWithPresence().catch(() => []),
    prisma.membership.findMany({ where: { workspaceId }, select: { userId: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const members = new Set(memberships.map((member) => member.userId));
  const liveWorker = workers.find((worker) => worker.live && !worker.sticky && members.has(worker.ownerUserId));
  return liveWorker?.ownerUserId ?? memberships[0]?.userId;
}

export async function runWorkerBackgroundTurn(input: WorkerBackgroundRunInput): Promise<WorkerBackgroundRunResult> {
  const workspaceId = input.workspaceId;
  const repo = await resolveRunRepo(workspaceId, input.repo);
  const ownerUserId = input.createdBy ?? await ownerForLocalWorker(workspaceId);
  const task = await tasks.create({ workspaceId }, {
    name: input.name?.trim() || input.title,
    title: input.title,
    description: input.prompt,
    kind: "self",
    cardType: "bot",
    cardStatus: "bot_working",
    repo,
    workerBackend: input.backendId,
    hidden: !input.visible,
    backgroundMode: input.mode ?? "readonly",
    ...(ownerUserId ? { createdBy: ownerUserId } : {}),
  });
  try {
    await input.onTaskCreated?.(task.id);
  } catch (err) {
    await prisma.task.update({ where: { id: task.id }, data: { cardStatus: "canceled", workerActive: false, workerStatus: "failed" } }).catch((updateErr) => {
      logger.warn("failed to clean up background task after creation callback failed", { taskId: task.id, err: updateErr });
    });
    throw err;
  }

  const events: AgentEvent[] = [];
  let streamedText = "";
  let finishRun: (err?: unknown, value?: { terminalReason?: string }) => void = () => undefined;
  const resultPromise = new Promise<{ terminalReason?: string }>((resolve, reject) => {
    let settled = false;
    finishRun = (err?: unknown, value?: { terminalReason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      input.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(value ?? {});
    };
    const onAbort = () => finishRun(new Error("background_worker_run_aborted"));
    const timer = setTimeout(() => finishRun(new Error("background_worker_run_timeout")), BACKGROUND_RUN_TIMEOUT_MS);
    timer.unref?.();
    const unsubscribe = bus.subscribe(chanTopic(workspaceId, task.id), (raw) => {
      const event = raw as AgentEvent;
      if (!event || typeof event !== "object" || typeof event.type !== "string") return;
      events.push(event);
      if (event.type === "text") streamedText += event.text;
      input.onEvent?.(event);
      if (event.type === "done") finishRun(undefined, { terminalReason: event.reason });
      if (event.type === "error") finishRun(new Error(event.message || "background_worker_run_failed"));
    });
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
  });

  const started = await startWorkerForTask(task, input.prompt);
  if (!started) {
    finishRun(new Error("background_worker_run_not_started"));
  }
  try {
    const result = await resultPromise;
    const rows = await messages.list({ workspaceId }, task.id, { limit: 25 });
    const assistant = [...rows].reverse().find((message) => message.role === "assistant")?.content?.trim() || streamedText.trim();
    await prisma.task.update({ where: { id: task.id }, data: { cardStatus: "done", workerActive: false, workerStatus: "done" } }).catch((err) => {
      logger.warn("failed to mark hidden background task done", { taskId: task.id, err });
    });
    return {
      text: assistant,
      events,
      taskId: task.id,
      ...(ownerUserId ? { ownerUserId } : {}),
      ...(result.terminalReason ? { terminalReason: result.terminalReason } : {}),
    };
  } catch (err) {
    await prisma.task.update({ where: { id: task.id }, data: { cardStatus: "canceled", workerActive: false, workerStatus: "failed" } }).catch((updateErr) => {
      logger.warn("failed to mark hidden background task failed", { taskId: task.id, err: updateErr });
    });
    throw err;
  }
}
