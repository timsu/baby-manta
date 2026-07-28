// Turn wedge-recovery, split out of daemon.ts (which runs on import) so it can be
// unit-tested with an injected clock.
//
// A worker turn streams events from backend.runTurn(). It can wedge two ways:
//
//   1. ABORTED-BUT-STUCK. A newer message aborts the turn's AbortController, but
//      the turn refuses to unwind (a hung await a plain abort can't reach). We
//      give it a short grace, then abandon it so the drain loop can fold the
//      queued message into a fresh turn.
//
//   2. SILENTLY STUCK. The turn stops emitting events entirely with NO new
//      message to abort it — e.g. an over-context model call that can't proceed,
//      or a subagent that never returns. The original recovery ONLY armed on an
//      abort, so a silent wedge ran forever and the UI sat on "working…" (observed
//      2026-07-21: a turn pinned at 98.7% of the context window stalled for 45min
//      and every re-dispatch just re-queued behind it). This module adds an
//      inactivity trigger so a turn that makes no progress for `inactivityMs` is
//      abandoned even without a new message.

export interface WatchdogTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: WatchdogTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Don't let a recovery timer keep the process alive on its own; it still
    // fires while the loop is live for other work.
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Resolves once `signal` has aborted (or immediately if already aborted). Add a
 * single listener per turn and reuse the promise — do NOT create one per stream
 * event, or a long turn leaks a listener per event onto the signal. */
export function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export interface AbandonOptions {
  /** Grace after an abort before a turn that won't unwind is abandoned. */
  graceMs: number;
  /** Max time a turn may emit no events before it is abandoned even without an
   *  abort. <= 0 disables the inactivity trigger. */
  inactivityMs: number;
  /** How often to poll for inactivity (default 30s). */
  pollMs?: number;
}

/**
 * Resolves `"abandoned"` when a turn should be given up on — either it was
 * aborted and did not unwind within `graceMs`, or it made no progress for
 * `inactivityMs`. In the healthy case it never resolves (it loses the
 * Promise.race against the completing turn and is GC'd with the controller).
 *
 * @param signal            the turn's AbortController signal
 * @param getLastActivity   ms timestamp of the turn's most recent streamed event
 * @param onInactivityAbort called once if the INACTIVITY trigger fires, so the
 *        caller can abort the controller and tear the wedged generator down
 *        (the abort trigger's controller is, by definition, already aborted)
 */
export function turnAbandonDeadline(
  signal: AbortSignal,
  getLastActivity: () => number,
  opts: AbandonOptions,
  onInactivityAbort: () => void,
  timers: WatchdogTimers = realTimers,
): Promise<"abandoned"> {
  const pollMs = opts.pollMs ?? 30_000;
  return new Promise((resolve) => {
    let settled = false;
    let pollHandle: unknown;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (pollHandle !== undefined) timers.clearTimeout(pollHandle);
      resolve("abandoned");
    };

    // Trigger 1: aborted-but-stuck. Arm the grace only once the signal aborts.
    const armGrace = () => timers.setTimeout(finish, opts.graceMs);
    if (signal.aborted) armGrace();
    else signal.addEventListener("abort", armGrace, { once: true });

    // Trigger 2: silent inactivity (no abort needed).
    if (opts.inactivityMs > 0) {
      const check = () => {
        if (settled) return;
        if (timers.now() - getLastActivity() >= opts.inactivityMs) {
          onInactivityAbort();
          finish();
          return;
        }
        pollHandle = timers.setTimeout(check, pollMs);
      };
      pollHandle = timers.setTimeout(check, pollMs);
    }
  });
}
