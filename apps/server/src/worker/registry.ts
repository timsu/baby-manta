// In-memory registry of connected worker daemons. Workers connect via
// WebSocket, authenticate, and register here. The server dispatches tasks to
// owner workers and tracks which worker holds which task across turns.

import { createLogger } from "../logger.ts";
import { hset, hgetall, hdel } from "../redis.ts";

const logger = createLogger("Manta:WorkerRegistry");

// ── Presence (survives-restart cache) ────────────────────────────────────────
// The in-memory `workers` map is authoritative for THIS process, but it's wiped
// on every deploy. We mirror each worker into a Redis hash with an expiry so the
// freshly-started process can still report the worker as online during the brief
// window before it reconnects — otherwise it vanishes from the UI on every deploy.
const PRESENCE_KEY = "presence";
/** A presence record is valid this long after its last heartbeat. Heartbeats are
 * ~30s, so 90s tolerates two missed pings before a worker is considered gone. */
const PRESENCE_TTL_MS = 90_000;

interface PresenceRecord {
  workerId: string;
  ownerUserId: string;
  activeTaskIds: string[];
  connectedAt: string;
  gitHash: string | null;
  idle: boolean;
  expiresAt: number;
}

function presenceFromEntry(e: WorkerEntry, now: number): PresenceRecord {
  return {
    workerId: e.workerId,
    ownerUserId: e.ownerUserId,
    activeTaskIds: [...e.activeTaskIds],
    connectedAt: e.connectedAt.toISOString(),
    gitHash: e.gitHash,
    idle: e.activeTaskIds.size === 0 && e.activeQuestionIds.size === 0,
    expiresAt: now + PRESENCE_TTL_MS,
  };
}

/** Mirror a worker's current state into the presence cache (fire-and-forget). */
function writePresence(workerId: string): void {
  const e = workers.get(workerId);
  if (!e || e.sticky) return; // sandbox workers are per-task & ephemeral; not user-facing in the worker list
  void hset(PRESENCE_KEY, workerId, presenceFromEntry(e, Date.now()));
}

/** Refresh a worker's presence TTL (called on each heartbeat). */
export function touchWorkerPresence(workerId: string): void {
  writePresence(workerId);
}

type SendFn = (msg: unknown) => void;

interface WorkerEntry {
  workerId: string;
  /** Monotonic id for THIS socket. `workerId` is stable across reconnects
   * (per-user/host, set by the daemon), so a late close from a dropped socket
   * must not clobber a newer connection that re-registered under the same
   * workerId — every mutation driven by a socket close is gated on its connId
   * still being current. */
  connId: number;
  /** The user this daemon is paired to. Tasks route to their owner's daemon. */
  ownerUserId: string;
  send: SendFn;
  /** taskIds with an active turn on this worker. BYO laptop workers can run multiple tasks. */
  activeTaskIds: Set<string>;
  /** questionIds this worker is currently answering (ephemeral, read-only, no Task).
   * Questions run concurrently with each other and with tasks, so this never blocks
   * claiming — it's tracked only to load-balance and to surface activity. */
  activeQuestionIds: Set<string>;
  /** Protocol capabilities the daemon advertised (e.g. "run_question"). Older
   * daemons advertise none, so they're never picked for features they can't do. */
  caps: Set<string>;
  /** A sandbox worker is permanently bound to its one task: it stays bound across
   * turns (so follow-ups keep routing here) until it disconnects. A laptop daemon
   * is freed after each turn and re-dispatched by owner. */
  sticky: boolean;
  connectedAt: Date;
  gitHash: string | null;
  /** Loopback port the daemon exposes for direct (same-machine) terminal access,
   * or null if it doesn't offer one (e.g. a remote/Daytona worker). */
  terminalPort: number | null;
}

/** A claimed worker handle for sending a one-shot request (e.g. a question). */
export interface WorkerHandle {
  workerId: string;
  send: SendFn;
}

export interface WorkerInfo {
  workerId: string;
  ownerUserId: string;
  /** True when the worker has a WebSocket connected to this server process.
   * False entries come from the short-lived presence cache used to avoid UI
   * flicker during deploy reconnects; they are not usable for immediate task or
   * terminal dispatch. */
  live: boolean;
  /** True for task-bound cloud sandbox workers; false for user-paired local daemons. */
  sticky: boolean;
  /** Back-compat: the first active task, or null when none are active. */
  currentTaskId: string | null;
  activeTaskIds: string[];
  activeTaskCount: number;
  connectedAt: string; // ISO
  idle: boolean;
  gitHash: string | null;
}

const workers = new Map<string, WorkerEntry>();
/** taskId → workerId, so follow-up turns route to the same worker. Cleared after
 * each laptop turn by freeTaskWorker (gates follow-up vs. re-dispatch), but kept
 * for sticky sandbox workers for the life of the sandbox. */
const taskToWorker = new Map<string, string>();
/** taskId → workerId for the worker that physically holds the task's worktree.
 * Unlike taskToWorker this survives laptop turn completion (so the terminal can
 * reach the worktree between turns); it's cleared only on worker disconnect or re-dispatch. */
const taskHomeWorker = new Map<string, string>();
/** Source of per-connection ids (see WorkerEntry.connId). */
let connSeq = 0;

/** Register (or re-register) a worker. Returns the connId for THIS socket; the
 * caller passes it back to unregisterWorker on close so a stale close is ignored. */
export function registerWorker(
  workerId: string,
  ownerUserId: string,
  send: SendFn,
  opts?: { gitHash?: string | null; terminalPort?: number | null; boundTaskId?: string; caps?: string[] },
): number {
  // A sandbox worker is dedicated to one task: bind it immediately so follow-up
  // turns route here (forwardToTaskWorker) and owner-based dispatch never matches
  // it (sticky workers are excluded). It's also the task's home worker (holds the
  // worktree → terminals route to it).
  const boundTaskId = opts?.boundTaskId ?? null;
  const gitHash = opts?.gitHash ?? null;
  const terminalPort = opts?.terminalPort ?? null;
  const caps = opts?.caps ?? [];
  const connId = ++connSeq;
  const activeTaskIds = new Set<string>();
  if (boundTaskId) activeTaskIds.add(boundTaskId);
  workers.set(workerId, {
    workerId,
    connId,
    ownerUserId,
    send,
    activeTaskIds,
    activeQuestionIds: new Set(),
    caps: new Set(caps),
    sticky: boundTaskId !== null,
    connectedAt: new Date(),
    gitHash,
    terminalPort,
  });
  if (boundTaskId) {
    taskToWorker.set(boundTaskId, workerId);
    taskHomeWorker.set(boundTaskId, workerId);
  }
  logger.info("worker registered", { workerId, connId, ownerUserId, gitHash, terminalPort, caps, total: workers.size, boundTaskId });
  writePresence(workerId);
  return connId;
}

/** Rebuild active-turn routing for a (re)connecting worker that advertises tasks
 * with an in-flight turn (deploy reconnect). Unlike claimTaskWorktrees (which only
 * restores terminal routing), this restores `activeTaskIds` + `taskToWorker` so a
 * follow-up turn forwards to this worker and a *later* real disconnect still flips
 * the task to needs_help. Skipped for sticky sandbox workers (already bound on
 * register). Idempotent. */
export function claimActiveTasks(workerId: string, taskIds: string[]): void {
  const entry = workers.get(workerId);
  if (!entry || entry.sticky) return;
  for (const taskId of taskIds) {
    entry.activeTaskIds.add(taskId);
    taskToWorker.set(taskId, workerId);
    taskHomeWorker.set(taskId, workerId);
  }
  if (taskIds.length) {
    logger.info("worker reclaimed in-flight tasks", { workerId, count: taskIds.length, taskIds });
    writePresence(workerId);
  }
}

/** Whether `connId` is the worker's current connection. A close handler checks
 * this before tearing anything down, so a late close from a superseded socket
 * (same workerId, new connection already registered) is a no-op. */
export function isLiveConnection(workerId: string, connId: number): boolean {
  return workers.get(workerId)?.connId === connId;
}

/** Unregister a worker. Returns the taskIds it was actively running so the caller
 * can transition them. Pass the connId from registerWorker: if a newer connection
 * has already taken this workerId, the stale close is ignored (returns []). */
export function unregisterWorker(workerId: string, connId?: number): string[] {
  const entry = workers.get(workerId);
  if (!entry) return [];
  if (connId !== undefined && entry.connId !== connId) {
    // Superseded by a reconnect — leave the live connection's state intact.
    logger.info("ignoring stale worker close", { workerId, staleConnId: connId, liveConnId: entry.connId });
    return [];
  }
  const activeTaskIds = [...entry.activeTaskIds];
  for (const taskId of activeTaskIds) {
    taskToWorker.delete(taskId);
    // The disconnect handler owns these tasks now; a stale liveness timer must not
    // also fire needs_help for a task whose worker already dropped.
    clearLivenessTimer(taskId);
  }
  // Drop every worktree-home association pointing at this worker — its worktrees
  // (and any open terminals) are gone with the connection.
  for (const [taskId, wid] of taskHomeWorker) {
    if (wid === workerId) taskHomeWorker.delete(taskId);
  }
  workers.delete(workerId);
  // A real disconnect (not a deploy — onClose skips this during shutdown) means
  // the worker is genuinely gone: drop its presence so the UI shows it offline.
  void hdel(PRESENCE_KEY, workerId);
  logger.info("worker unregistered", { workerId, remaining: workers.size, activeTaskIds });
  return activeTaskIds;
}

export function listWorkers(): WorkerInfo[] {
  return [...workers.values()].map((e) => {
    const activeTaskIds = [...e.activeTaskIds];
    return {
      workerId: e.workerId,
      ownerUserId: e.ownerUserId,
      live: true,
      sticky: e.sticky,
      currentTaskId: activeTaskIds[0] ?? null,
      activeTaskIds,
      activeTaskCount: activeTaskIds.length,
      connectedAt: e.connectedAt.toISOString(),
      idle: activeTaskIds.length === 0 && e.activeQuestionIds.size === 0,
      gitHash: e.gitHash,
    };
  });
}

/** Worker list for the UI, merged with the presence cache: includes workers that
 * were online moments ago (their presence hasn't expired) but aren't connected to
 * THIS process yet — i.e. mid-reconnect during a deploy. Without this merge a
 * deploy makes every worker blink offline. Live (in-memory) entries always win. */
export async function listWorkersWithPresence(): Promise<WorkerInfo[]> {
  const live = listWorkers();
  const liveIds = new Set(live.map((w) => w.workerId));
  const now = Date.now();
  const cached = await hgetall<PresenceRecord>(PRESENCE_KEY);
  const extra: WorkerInfo[] = [];
  for (const rec of Object.values(cached)) {
    if (!rec || liveIds.has(rec.workerId) || rec.expiresAt <= now) continue;
    extra.push({
      workerId: rec.workerId,
      ownerUserId: rec.ownerUserId,
      live: false,
      sticky: false,
      currentTaskId: rec.activeTaskIds[0] ?? null,
      activeTaskIds: rec.activeTaskIds,
      activeTaskCount: rec.activeTaskIds.length,
      connectedAt: rec.connectedAt,
      idle: rec.idle,
      gitHash: rec.gitHash,
    });
  }
  return [...live, ...extra];
}

/** Whether `ownerUserId` has a worker connected now OR had one online within the
 * presence TTL with no live connection in this process (i.e. it is expected to
 * reconnect through a deploy). Tasks and questions are concurrent, so a worker
 * answering a question is still present and task-capable. */
export async function ownerHasPresentWorker(ownerUserId: string): Promise<boolean> {
  for (const e of workers.values()) {
    if (e.sticky || e.ownerUserId !== ownerUserId) continue;
    return true;
  }

  const now = Date.now();
  const cached = await hgetall<PresenceRecord>(PRESENCE_KEY);
  for (const rec of Object.values(cached)) {
    if (rec && rec.ownerUserId === ownerUserId && rec.expiresAt > now) return true;
  }
  return false;
}

export type OwnerWorkerPresenceStatus = "online" | "reconnecting" | "offline";

/** Task-chat routing status for an owner's local worker. Live workers can take a
 * local turn now; reconnecting workers are present only in the short-lived
 * deploy/reconnect cache, so dispatch holds briefly before cloud fallback. */
export async function ownerWorkerPresenceStatus(ownerUserId: string | null | undefined): Promise<OwnerWorkerPresenceStatus> {
  if (!ownerUserId) return "offline";
  for (const e of workers.values()) {
    if (e.sticky || e.ownerUserId !== ownerUserId) continue;
    return "online";
  }

  const now = Date.now();
  const cached = await hgetall<PresenceRecord>(PRESENCE_KEY);
  for (const rec of Object.values(cached)) {
    if (rec && rec.ownerUserId === ownerUserId && rec.expiresAt > now) return "reconnecting";
  }
  return "offline";
}

export function requestWorkerUpdate(workerId: string, ownerUserId: string): boolean {
  const entry = workers.get(workerId);
  if (!entry || entry.ownerUserId !== ownerUserId) return false;
  entry.send({ type: "update", reason: "user_requested" });
  logger.info("worker update requested", { workerId, ownerUserId, gitHash: entry.gitHash });
  return true;
}

/** Dispatch a task to a connected laptop daemon owned by `ownerUserId`. Returns
 * the workerId, or null if that user has no daemon connected. A task with no
 * owner never matches a daemon.
 *
 * BYO laptop daemons are multi-task: unlike Daytona sandboxes, a connected daemon
 * can accept more work even while it already has active tasks. When multiple
 * daemons are connected for the owner, choose the least-loaded one. */
export function dispatchTask(
  payload: { type: "run_task"; taskId: string; [k: string]: unknown },
  ownerUserId: string | null | undefined,
): string | null {
  if (!ownerUserId) return null;
  let selected: WorkerEntry | null = null;
  for (const entry of workers.values()) {
    if (entry.sticky) continue;
    if (entry.ownerUserId !== ownerUserId) continue;
    if (!selected || entry.activeTaskIds.size < selected.activeTaskIds.size) selected = entry;
  }
  if (!selected) {
    logger.info("no owner laptop daemon", { taskId: payload.taskId, ownerUserId, total: workers.size });
    return null;
  }

  selected.activeTaskIds.add(payload.taskId);
  taskToWorker.set(payload.taskId, selected.workerId);
  // This worker now physically holds the task's worktree (survives turn end).
  taskHomeWorker.set(payload.taskId, selected.workerId);
  selected.send(payload);
  writePresence(selected.workerId);
  logger.info("task dispatched", {
    taskId: payload.taskId,
    workerId: selected.workerId,
    ownerUserId,
    activeTaskCount: selected.activeTaskIds.size,
  });
  // Delivery check: a ws send to a half-dead socket succeeds silently (buffered
  // into the void), so the daemon never starts the task and nothing is logged —
  // the "dispatched but no 'starting task'" ghost. The daemon acks run_task on
  // receipt; if no ack lands in time, surface it loudly so the drop is visible.
  const taskId = payload.taskId;
  const workerId = selected.workerId;
  const prior = pendingDispatchAcks.get(taskId);
  if (prior) clearTimeout(prior);
  const ackTimer = setTimeout(() => {
    pendingDispatchAcks.delete(taskId);
    logger.warn("dispatch NOT acked within 10s — worker socket likely dead; task may never start", { taskId, workerId });
  }, 10_000);
  ackTimer.unref?.();
  pendingDispatchAcks.set(taskId, ackTimer);
  return selected.workerId;
}

/** run_task dispatches awaiting a daemon ack (see dispatchTask / ackDispatch). */
const pendingDispatchAcks = new Map<string, ReturnType<typeof setTimeout>>();

// ── Post-ack liveness watchdog ───────────────────────────────────────────────
// The ack timer above only catches "the dispatch never arrived". A second failure
// mode is invisible to it: the daemon receives run_task, ACKS it, and then the
// turn wedges — a hung subprocess, or a session-resume that never yields after a
// socket blip left an orphaned turn holding the daemon's per-task drain lock. The
// turn emits nothing (no tool/text/thinking/done/error), so the card sits on
// "working…" forever with the server believing a worker is happily assigned.
// After an ack we arm this liveness timer; the first streamed event clears it
// (markTaskActivity). If total silence outlasts LIVENESS_MS, onWorkerWedged fires
// so the card can self-heal to Needs Help instead of rotting.
const pendingLivenessTimers = new Map<string, ReturnType<typeof setTimeout>>();
const LIVENESS_MS = 120_000;
let onWorkerWedged: ((taskId: string, workerId: string) => void) | null = null;

/** Register the handler invoked when an acked dispatch streams nothing within the
 * liveness window. Wired once at startup (see ws.ts) so this low-level registry
 * stays free of DB/notice imports. */
export function setOnWorkerWedged(fn: (taskId: string, workerId: string) => void): void {
  onWorkerWedged = fn;
}

function clearLivenessTimer(taskId: string): void {
  const t = pendingLivenessTimers.get(taskId);
  if (t) {
    clearTimeout(t);
    pendingLivenessTimers.delete(taskId);
  }
}

/** A worker streamed task activity (a validated turn event/setup/session/worktree message) —
 * proof the turn is alive. Cancels the acked-but-silent watchdog. */
export function markTaskActivity(taskId: string): void {
  clearLivenessTimer(taskId);
}

/** Clear a pending dispatch-ack timer when the daemon confirms receipt of run_task,
 * then arm the post-ack liveness watchdog (see above). */
export function ackDispatch(taskId: string): void {
  const timer = pendingDispatchAcks.get(taskId);
  // Acks can arrive late from a prior turn or be unsolicited. Only an ack for
  // an outstanding dispatch is allowed to start a liveness watchdog.
  if (!timer) return;
  clearTimeout(timer);
  pendingDispatchAcks.delete(taskId);
  logger.info("dispatch acked by worker", { taskId });
  const workerId = taskToWorker.get(taskId);
  if (!workerId) return; // turn already ended/freed before the ack landed
  clearLivenessTimer(taskId);
  const liveTimer = setTimeout(() => {
    pendingLivenessTimers.delete(taskId);
    logger.warn("dispatch acked but no worker output within liveness window — turn looks wedged", {
      taskId,
      workerId,
      ms: LIVENESS_MS,
    });
    onWorkerWedged?.(taskId, workerId);
  }, LIVENESS_MS);
  liveTimer.unref?.();
  pendingLivenessTimers.set(taskId, liveTimer);
}

// ── Deploy-window dispatch hold ──────────────────────────────────────────────
// During a deploy the owner's worker briefly isn't in the live registry (it's
// reconnecting to the new process). A new turn in that window would otherwise
// fall straight through to a Daytona sandbox — a redundant cloud venue for a
// worker that's about to reappear. When presence says the worker is mid-reconnect
// (ownerHasPresentWorker), callers hold the dispatch here; it's drained the moment
// that owner's worker re-registers, or falls back to the caller-supplied cloud
// path after a timeout if it never does. The fallback is a closure so this module
// stays decoupled from the cloud sandbox code.
interface HeldDispatch {
  payload: { type: "run_task"; taskId: string; [k: string]: unknown };
  fallback: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const heldDispatches = new Map<string, HeldDispatch[]>();
/** Re-check cadence while holding. Each tick we re-confirm the worker is still
 * mid-reconnect (presence valid) rather than giving up on a fixed timer: a blip's
 * reconnect backoff alone (1+2+4+8+16s) already exceeds 30s, and presence is good
 * for PRESENCE_TTL_MS (90s), so a flat 30s give-up would bounce a live-but-
 * reconnecting worker's card to cloud — the exact misroute we're avoiding. */
const DISPATCH_HOLD_TICK_MS = 30_000;
/** Absolute backstop: never pin a dispatch longer than this, even if presence keeps
 * looking valid (a flapping worker that re-registers but never lands a turn). Sits
 * just above PRESENCE_TTL_MS so a genuinely-gone worker's presence expires first. */
const MAX_DISPATCH_HOLD_MS = 120_000;

export function holdDispatch(
  ownerUserId: string,
  payload: { type: "run_task"; taskId: string; [k: string]: unknown },
  fallback: () => void,
): void {
  const queue = heldDispatches.get(ownerUserId) ?? [];
  const deadline = Date.now() + MAX_DISPATCH_HOLD_MS;

  const giveUp = (): void => {
    const q = heldDispatches.get(ownerUserId);
    if (!q) return;
    const idx = q.findIndex((p) => p.payload.taskId === payload.taskId);
    if (idx === -1) return;
    q.splice(idx, 1);
    if (q.length === 0) heldDispatches.delete(ownerUserId);
    logger.warn("held dispatch timed out — falling back to cloud", { taskId: payload.taskId, ownerUserId });
    fallback();
  };

  const arm = (): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => {
      // A live re-register drains the queue (drainHeldDispatches) and clears this
      // timer; reaching here means the socket is still down. Keep holding while
      // presence says the worker is coming back; only fall to cloud once it's
      // truly gone (presence expired) or we hit the backstop.
      const held = heldDispatches.get(ownerUserId)?.find((p) => p.payload.taskId === payload.taskId);
      if (!held) return;
      void (async () => {
        if (Date.now() < deadline && (await ownerHasPresentWorker(ownerUserId))) {
          held.timer = arm();
          return;
        }
        giveUp();
      })();
    }, DISPATCH_HOLD_TICK_MS);
    t.unref?.();
    return t;
  };

  queue.push({ payload, fallback, timer: arm() });
  heldDispatches.set(ownerUserId, queue);
  logger.info("holding dispatch for reconnecting worker", { taskId: payload.taskId, ownerUserId });
}

/** Drain dispatches held for an owner whose worker just (re)registered. */
export function drainHeldDispatches(ownerUserId: string): void {
  const queue = heldDispatches.get(ownerUserId);
  if (!queue) return;
  heldDispatches.delete(ownerUserId);
  for (const p of queue) {
    clearTimeout(p.timer);
    const workerId = dispatchTask(p.payload, ownerUserId);
    if (workerId) {
      logger.info("drained held dispatch to reconnected worker", { taskId: p.payload.taskId, workerId });
    } else {
      // Worker registered then vanished before we dispatched — use the fallback.
      p.fallback();
    }
  }
}

/** Send a follow-up message to the worker currently holding a task.
 * Returns true if the worker was found. */
export function forwardToTaskWorker(taskId: string, payload: unknown): boolean {
  const workerId = taskToWorker.get(taskId);
  if (!workerId) return false;
  const entry = workers.get(workerId);
  if (!entry) return false;
  entry.send(payload);
  return true;
}

/** Free the worker that held this task (called after the task's done event).
 * A sticky (sandbox) worker stays bound — it's the task's dedicated venue for its
 * whole life, so follow-up turns keep routing to it until it disconnects. */
export function freeTaskWorker(taskId: string): void {
  const workerId = taskToWorker.get(taskId);
  if (!workerId) return;
  const entry = workers.get(workerId);
  if (entry?.sticky) {
    logger.info("worker turn done; staying bound (sticky)", { workerId, taskId });
    return;
  }
  taskToWorker.delete(taskId);
  clearLivenessTimer(taskId);
  if (entry) {
    entry.activeTaskIds.delete(taskId);
    writePresence(workerId);
    logger.info("worker freed", { workerId, taskId, activeTaskCount: entry.activeTaskIds.size });
  }
}

/** Tell the worker holding a task to abort any in-flight turn and kill all PTYs,
 * then forget both active-turn and terminal/worktree routing for that task. Used
 * when a card reaches a terminal board state. */
export function disposeTaskWorker(taskId: string): void {
  const workerIds = new Set<string>();
  const activeWorkerId = taskToWorker.get(taskId);
  const homeWorkerId = taskHomeWorker.get(taskId);
  if (activeWorkerId) workerIds.add(activeWorkerId);
  if (homeWorkerId) workerIds.add(homeWorkerId);

  for (const workerId of workerIds) {
    const entry = workers.get(workerId);
    if (!entry) continue;
    entry.send({ type: "dispose_task", taskId });
    entry.activeTaskIds.delete(taskId);
    writePresence(workerId);
  }

  const ackTimer = pendingDispatchAcks.get(taskId);
  if (ackTimer) clearTimeout(ackTimer);
  pendingDispatchAcks.delete(taskId);
  clearLivenessTimer(taskId);
  taskToWorker.delete(taskId);
  taskHomeWorker.delete(taskId);
  logger.info("task worker disposed", { taskId, workerIds: [...workerIds] });
}

/** Whether an external worker currently holds this task (and follow-up turns
 * should route to it rather than dispatching a new venue). */
export function isExternalTask(taskId: string): boolean {
  return taskToWorker.has(taskId);
}

/** Record the task worktrees a (re)connecting worker still holds. The daemon
 * advertises these on register (from its in-memory state, which survives a
 * server deploy since the daemon process keeps running), so terminal routing is
 * rebuilt immediately after a server restart instead of only on the next
 * dispatch. Idempotent; last claimant wins if two daemons claim the same task. */
export function claimTaskWorktrees(workerId: string, taskIds: string[]): void {
  for (const taskId of taskIds) taskHomeWorker.set(taskId, workerId);
  if (taskIds.length) logger.info("worker claimed worktrees", { workerId, count: taskIds.length });
}

/** Re-bind a task's terminal/worktree routing to one of the owner's currently
 * connected laptop daemons without starting an agent turn. This is used by the
 * terminal "Reconnect" button when the browser card lost its task→worker
 * association but the user's daemon is back online and may still have the
 * worktree on disk. Returns false when there is no suitable live daemon. */
export function reconnectTaskHome(taskId: string, ownerUserId: string | null | undefined): boolean {
  if (!ownerUserId) return false;
  let selected: WorkerEntry | null = null;
  for (const entry of workers.values()) {
    if (entry.sticky) continue;
    if (entry.ownerUserId !== ownerUserId) continue;
    if (!selected || entry.activeTaskIds.size < selected.activeTaskIds.size) selected = entry;
  }
  if (!selected) return false;
  taskHomeWorker.set(taskId, selected.workerId);
  writePresence(selected.workerId);
  logger.info("task terminal reconnected to worker", { taskId, workerId: selected.workerId, ownerUserId });
  return true;
}

/** Send function for the worker that physically holds a task's worktree, or null
 * if no such worker is currently connected. Used by the terminal relay. */
export function getTaskWorkerSend(taskId: string): SendFn | null {
  const workerId = taskHomeWorker.get(taskId);
  if (!workerId) return null;
  return workers.get(workerId)?.send ?? null;
}

/** Routing info for the worker holding a task's worktree, or null if offline.
 * `terminalPort` (if non-null) lets a same-machine browser connect directly. */
export function getTaskWorkerInfo(
  taskId: string,
): { workerId: string; ownerUserId: string; terminalPort: number | null } | null {
  const workerId = taskHomeWorker.get(taskId);
  if (!workerId) return null;
  const entry = workers.get(workerId);
  if (!entry) return null;
  return { workerId, ownerUserId: entry.ownerUserId, terminalPort: entry.terminalPort };
}

/** Count connected non-sticky laptop daemons. With an ownerUserId, counts only
 * that user's daemons. BYO workers are reusable/multi-task and questions run
 * concurrently, so neither active tasks nor in-flight questions make a daemon
 * unavailable. */
export function availableWorkerCount(ownerUserId?: string | null): number {
  let n = 0;
  for (const e of workers.values()) {
    if (e.sticky) continue;
    if (ownerUserId != null && e.ownerUserId !== ownerUserId) continue;
    n++;
  }
  return n;
}

/** Count live laptop daemons that can run checkout-backed question/repo-chat
 * turns. Unlike generic worker presence, this excludes old daemons that have
 * not advertised the run_question protocol capability yet. */
export function availableQuestionWorkerCount(ownerUserId: string): number {
  let n = 0;
  for (const entry of workers.values()) {
    if (!entry.sticky && entry.ownerUserId === ownerUserId && entry.caps.has("repo_chat")) n++;
  }
  return n;
}

/** Whether any currently connected worker still has this task in-flight. Used
 * after one worker disconnects: another daemon may have already reclaimed the
 * same active task, so the card should not be marked stalled. */
export function hasActiveTaskWorker(taskId: string): boolean {
  for (const e of workers.values()) {
    if (e.activeTaskIds.has(taskId)) return true;
  }
  return false;
}

// ── Ephemeral questions (read-only agent runs, no Task) ──────────────────────

/** Pick a question-capable worker whose owner passes `isEligible` (e.g. is a
 * member of the asking workspace — questions run on ANY member's daemon, not just
 * the asker's, so non-engineers can ask too). Read-only questions run concurrently
 * with each other and with tasks, so a busy daemon is never refused; we just pick
 * the one with the fewest in-flight questions to spread load. Sticky (sandbox)
 * workers are skipped — questions go to laptop daemons. Tracks `questionId` on the
 * worker; release it with releaseQuestionWorker. Returns null only when no
 * eligible, question-capable worker is connected. */
export function claimWorkerForQuestion(
  questionId: string,
  isEligible: (ownerUserId: string) => boolean,
  requiredCap = "run_question",
): WorkerHandle | null {
  let selected: WorkerEntry | null = null;
  for (const entry of workers.values()) {
    if (entry.sticky) continue;
    if (!entry.caps.has(requiredCap)) continue;
    if (!isEligible(entry.ownerUserId)) continue;
    if (!selected || entry.activeQuestionIds.size < selected.activeQuestionIds.size) selected = entry;
  }
  if (!selected) return null;
  selected.activeQuestionIds.add(questionId);
  logger.info("worker picked for question", { workerId: selected.workerId, questionId, inflight: selected.activeQuestionIds.size });
  return { workerId: selected.workerId, send: selected.send };
}

/** Free whichever worker is holding `questionId` (no-op if already gone). */
export function releaseQuestionWorker(questionId: string): void {
  for (const entry of workers.values()) {
    if (entry.activeQuestionIds.delete(questionId)) {
      logger.info("worker freed from question", { workerId: entry.workerId, questionId, inflight: entry.activeQuestionIds.size });
      return;
    }
  }
}
