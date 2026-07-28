// Card notices — durable, user-visible explanations for automated card moves.
//
// Failure/stall transitions into `needs_help` (worker disconnect, cloud-start
// failure, scout triage) historically surfaced ONLY as ephemeral `bus` events:
// nothing was persisted, so a card could land in "Needs Help" with an empty
// transcript and no record of why ("never started"). Persisting a `status`
// message keeps the reason in the card's history (it renders in the transcript
// just like the worker's own status lines); the bus publish notifies anyone
// watching live. Best-effort — never throws into the caller's failure path.

import { messages, type WorkspaceScope } from "@manta/db";
import { bus, chanTopic } from "./bus.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger("Manta:Notices");

/** Persist a system status note onto a task's chat stream AND push it live. */
export async function noteOnCard(scope: WorkspaceScope, taskId: string, content: string): Promise<void> {
  try {
    await messages.append(scope, { channel: taskId, role: "status", content });
    // Frontend maps a chan `error` event to a "⚠️ …" status line (see web/ws.ts).
    bus.publish(chanTopic(scope.workspaceId, taskId), { type: "error", message: content });
  } catch (err) {
    // A notice that can't be written must not mask the original failure.
    logger.warn("failed to persist card notice", { taskId, content, err });
  }
}
