// Sandbox reconciler — a background sweep that fully cleans up sandboxes whose
// task is terminal (done/canceled/archived) or gone: it DELETES them (running or
// stopped) so they stop billing and disappear from the worker popup, rather than
// leaving a stopped box to linger until Daytona's 72h auto-delete. This also
// catches missed idle-spindowns and post-deploy orphans (in-memory grace timers
// don't survive a server roll).
//
// A non-terminal task's box is never touched — a stopped one is a legitimately
// asleep task waiting for a follow-up. Daytona is the source of truth (we list by
// label, not from memory), mirroring the PR poller. Best-effort — never throws.

import { prisma } from "@manta/db";
import { getSandboxes } from "../sandbox/factory.ts";
import { removeCloudSandbox } from "./cloud.ts";
import { cancelSpindown } from "./lifecycle.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:SandboxReconciler");

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
/** Card statuses past which no further worker turns happen. `archived` is a
 * separate `archivedAt` flag, handled below. */
const TERMINAL_STATUSES = new Set(["done", "canceled"]);

async function reconcile(): Promise<void> {
  let boxes;
  try {
    boxes = await getSandboxes().listByLabel({ app: "manta" });
  } catch (err) {
    logger.warn("list sandboxes failed", { err });
    return;
  }

  for (const box of boxes) {
    const taskId = box.labels["task"];
    const workspaceId = box.labels["workspace"];
    if (!taskId || !workspaceId) continue;

    try {
      const task = await prisma.task.findFirst({
        where: { id: taskId, workspaceId },
        select: { cardStatus: true, archivedAt: true },
      });
      // Only reap terminal tasks. A non-terminal task's box (even stopped/asleep)
      // is left alone — a follow-up can wake it.
      const terminal = !task || task.archivedAt !== null || TERMINAL_STATUSES.has(task.cardStatus);
      if (!terminal) continue;
      cancelSpindown(taskId);
      await removeCloudSandbox({ id: taskId, workspaceId });
      logger.info("removed sandbox for terminal task", {
        taskId,
        state: box.state ?? "unknown",
        reason: !task ? "missing" : task.archivedAt ? "archived" : task.cardStatus,
      });
    } catch (err) {
      logger.warn("reconcile box failed", { taskId, err });
    }
  }
}

/** Start the periodic reconciler. Returns a stop function (tests/shutdown). */
export function startSandboxReconciler(): () => void {
  const tick = () => void reconcile().catch((err) => logger.error("reconcile tick failed", { err }));
  // Stagger after startup so it doesn't race the poller's first tick.
  const init = setTimeout(tick, 20_000);
  const interval = setInterval(tick, RECONCILE_INTERVAL_MS);
  return () => {
    clearTimeout(init);
    clearInterval(interval);
  };
}
