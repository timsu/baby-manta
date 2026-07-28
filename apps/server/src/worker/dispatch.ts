// Worker dispatch — routes a task's coding turn to a venue. Prefers the task
// creator's own laptop daemon (human-authored PR, free compute); otherwise runs
// in an isolated Daytona cloud sandbox (bot-authored PR).
//
// The old in-process "cloud bot" that executed the agent ON the server container
// has been removed: it gave an LLM shell access to the multi-tenant prod host
// (every workspace's secrets) and its worktrees died on every rolling deploy.
// Cloud work now runs in a per-task-isolated sandbox — see worker/cloud.ts.

import { tasks, messages, repos, type Task } from "@manta/db";
import { createLogger } from "../logger.ts";
import { dispatchTask, availableWorkerCount, ownerHasPresentWorker, holdDispatch } from "./registry.ts";
import { buildTaskPayload } from "./payload.ts";
import { runCloudTask } from "./cloud.ts";
import { noteOnCard } from "../notices.ts";
import { normalizeTaskRepoForDispatch } from "../repos/canonical.ts";
import { getTaskOwnerAuthBlob } from "../models/service.ts";

const logger = createLogger("Manta:Dispatch");

type LaptopRunTaskPayload = {
  type: "run_task";
  taskId: string;
  workspaceId: string;
  message: string;
  task: Awaited<ReturnType<typeof buildTaskPayload>>;
  authJson?: unknown;
};

export interface SpawnWorkerOptions {
  messageAlreadyPersisted?: boolean;
  forceCloud?: boolean;
  /** Laptop-only: never spawn (or re-spawn) a Daytona sandbox. Used by
   * move-to-local so a dispatch miss lands in Needs Help instead of bouncing the
   * task back to the cloud venue it's explicitly leaving. */
  forceLaptop?: boolean;
}

export function shouldAutoStartWorker(task: Pick<Task, "cardStatus">): boolean {
  return task.cardStatus === "bot_working" || task.cardStatus === "interactive";
}

function shouldRunSetupCommands(task: Pick<Task, "backgroundMode">): boolean {
  return task.backgroundMode !== "scheduled_slack";
}

/** Automation/background runs (spot checks, pollers, Linear/Slack automations)
 * are machine-initiated, not a human coding at their laptop. They carry a
 * `createdBy` only so credentials resolve — often steered to whichever member
 * has a live worker — so left alone they'd dispatch to that person's laptop,
 * running in their local toolchain/secrets. Pin them to the isolated cloud
 * sandbox (the controlled image with the seed repos' decrypt keys) instead. */
function isAutomationBackgroundRun(task: Pick<Task, "backgroundMode">): boolean {
  return task.backgroundMode != null;
}

/**
 * Atomically claim a task's worker slot and dispatch a turn when the card status
 * implies active bot work. Use this after any card creation path so "Working"
 * cards cannot sit unassigned.
 */
export async function startWorkerForTask(
  task: Task,
  message: string,
  opts?: SpawnWorkerOptions,
): Promise<boolean> {
  if (!shouldAutoStartWorker(task)) return false;
  const claimed = await tasks.beginWork({ workspaceId: task.workspaceId }, task.id);
  if (!claimed) return false;
  spawnWorker(task, message, opts);
  return true;
}

/** Spawn a worker for a task. Routes to the creator's laptop daemon if one is
 * connected, else to a Daytona cloud sandbox. Fire-and-forget; turns stream back over
 * /worker-ws and the kanban/bus. */
export function spawnWorker(
  task: Task,
  message: string,
  opts?: SpawnWorkerOptions,
): void {
  void (async () => {
    task = await normalizeTaskRepoForDispatch(task);
    const scope = { workspaceId: task.workspaceId };
    if (!opts?.messageAlreadyPersisted) {
      await messages.append(scope, { channel: task.id, role: "user", content: message });
    }

    // Automation/background runs are pinned to the cloud sandbox unless the
    // caller explicitly forces the laptop (move-to-local). See
    // isAutomationBackgroundRun.
    const forceCloud = opts?.forceCloud || (isAutomationBackgroundRun(task) && !opts?.forceLaptop);

    // Prefer a daemon owned by the task's creator (the BYO-laptop venue), unless
    // the caller explicitly requested a cloud sandbox.
    // Ownerless tasks (createdBy null — poller/Slack/Linear automation) can never
    // match an owner's daemon, so skip straight to cloud (avoids a transient
    // venue=laptop write + a wasted repo lookup before the guaranteed fallback).
    if (!forceCloud && task.createdBy && availableWorkerCount(task.createdBy) > 0) {
      await tasks.setWorker(scope, task.id, {
        workerActive: true,
        workerStatus: "running",
        workerVenue: "laptop",
        venueStatus: "active",
      });
      // The daemon has no DB access, so pass the repo's setup commands along for
      // it to run if it provisions a fresh worktree.
      const repo = shouldRunSetupCommands(task) ? await repos.byOrgRepo(scope, task.repo).catch(() => null) : null;
      const payload = await buildLaptopRunTaskPayload(task, message, repo?.setupCommands?.trim() || undefined);
      const dispatched = dispatchTask(
        payload,
        task.createdBy,
      );
      if (dispatched) return;
      // Race: the daemon disconnected between check and dispatch — fall to cloud.
      logger.info("laptop dispatch lost a race; falling back to cloud", { taskId: task.id });
    }

    // Laptop-only (move-to-local): never spawn — or re-spawn — a cloud sandbox. If
    // the laptop dispatch above didn't happen or lost the race, the owner has no
    // connected worker; leave the task in Needs Help with a note rather than
    // silently bouncing it (back) to Daytona, which is the venue the caller is
    // explicitly trying to leave.
    if (opts?.forceLaptop) {
      await tasks.setWorker(scope, task.id, { workerActive: false, workerStatus: "stalled" });
      await tasks
        .transition(scope, task.id, "needs_help", "worker", { reason: "No local worker available" })
        .catch(() => {});
      await noteOnCard(scope, task.id, "↩️ Couldn't move to a local worker — the task owner has no worker connected.");
      return;
    }

    // No laptop daemon registered for the owner right now. If presence says the
    // owner had a worker within the TTL, it's mid-reconnect (deploy window) — hold
    // the task for it rather than spawn a redundant Daytona sandbox. holdDispatch
    // falls back to cloud after a timeout if the worker never reconnects.
    if (!forceCloud && task.createdBy && (await ownerHasPresentWorker(task.createdBy))) {
      await tasks.setWorker(scope, task.id, {
        workerActive: true,
        workerStatus: "running",
        workerVenue: "laptop",
        venueStatus: "active",
      });
      const repo = shouldRunSetupCommands(task) ? await repos.byOrgRepo(scope, task.repo).catch(() => null) : null;
      const payload = await buildLaptopRunTaskPayload(task, message, repo?.setupCommands?.trim() || undefined);
      logger.info("holding dispatch for reconnecting worker (deploy window)", { taskId: task.id });
      holdDispatch(
        task.createdBy,
        payload,
        () => void runCloudTask(task, message),
      );
      return;
    }

    // No laptop daemon for the owner → isolated Daytona cloud sandbox.
    await runCloudTask(task, message);
  })().catch(async (err) => {
    // Anything thrown above (DB hiccup, payload build, dispatch) would otherwise
    // be a silent unhandled rejection — the card stays in bot_working with no
    // worker and an empty transcript ("never started"). Surface it instead.
    logger.error("spawnWorker failed", { taskId: task.id, err });
    const scope = { workspaceId: task.workspaceId };
    await tasks.setWorker(scope, task.id, { workerActive: false, workerStatus: "failed" }).catch(() => {});
    await tasks
      .transition(scope, task.id, "needs_help", "worker", { reason: "Worker failed to start" })
      .catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    await noteOnCard(scope, task.id, `🚨 Worker failed to start — moved to Needs Help.\n\n${detail}`);
  });
}

export async function buildLaptopRunTaskPayload(
  task: Task,
  message: string,
  setupCommands?: string,
): Promise<LaptopRunTaskPayload> {
  const [payload, authJson] = await Promise.all([
    buildTaskPayload(task, { setupCommands }),
    getTaskOwnerAuthBlob(task.createdBy, task.workerBackend),
  ]);
  return {
    type: "run_task",
    taskId: task.id,
    workspaceId: task.workspaceId,
    message,
    task: payload,
    ...(authJson ? { authJson } : {}),
  };
}
