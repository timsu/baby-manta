import { describe, it, expect } from "vitest";
import { turnAbandonDeadline, whenAborted, type WatchdogTimers } from "./wedgeWatchdog.ts";

/** A controllable clock + timer queue so recovery timing is tested without real
 * waits. `advance(ms)` moves virtual time and fires any timers now due. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: WatchdogTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      pending.delete(h as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    // Fire due timers in chronological order, allowing re-scheduling within.
    while (true) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of pending) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      pending.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = target;
  };
  return { timers, advance };
}

describe("turnAbandonDeadline — abort-then-stuck trigger", () => {
  it("abandons a turn that is aborted and does not unwind within the grace", async () => {
    const { timers, advance } = fakeTimers();
    const ctrl = new AbortController();
    let inactivityFired = false;
    const p = turnAbandonDeadline(
      ctrl.signal,
      () => timers.now(),
      { graceMs: 20_000, inactivityMs: 0 },
      () => {
        inactivityFired = true;
      },
      timers,
    );

    ctrl.abort();
    advance(19_999);
    // Not yet — still inside the grace window.
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    advance(2);
    expect(await p).toBe("abandoned");
    // The abort trigger must NOT invoke the inactivity-abort hook.
    expect(inactivityFired).toBe(false);
  });

  it("never resolves for a healthy turn that is never aborted and stays active", async () => {
    const { timers, advance } = fakeTimers();
    const ctrl = new AbortController();
    let resolved = false;
    void turnAbandonDeadline(
      ctrl.signal,
      () => timers.now(), // activity tracks the clock — always fresh
      { graceMs: 20_000, inactivityMs: 60_000, pollMs: 10_000 },
      () => {},
      timers,
    ).then(() => {
      resolved = true;
    });

    advance(10 * 60_000);
    await Promise.resolve();
    expect(resolved).toBe(false);
  });
});

describe("turnAbandonDeadline — silent inactivity trigger", () => {
  it("abandons a turn that emits no events for inactivityMs, with no abort", async () => {
    const { timers, advance } = fakeTimers();
    const ctrl = new AbortController();
    let inactivityAborts = 0;
    // Activity frozen at time 0 — the turn goes silent immediately.
    const p = turnAbandonDeadline(
      ctrl.signal,
      () => 0,
      { graceMs: 20_000, inactivityMs: 120_000, pollMs: 30_000 },
      () => {
        inactivityAborts++;
      },
      timers,
    );

    advance(119_000);
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    advance(60_000); // cross the 120s inactivity threshold at the next poll
    expect(await p).toBe("abandoned");
    // It must abort the controller exactly once so the caller can tear down.
    expect(inactivityAborts).toBe(1);
  });

  it("does not fire while the turn keeps making progress", async () => {
    const { timers, advance } = fakeTimers();
    const ctrl = new AbortController();
    let lastActivity = 0;
    let resolved = false;
    void turnAbandonDeadline(
      ctrl.signal,
      () => lastActivity,
      { graceMs: 20_000, inactivityMs: 120_000, pollMs: 30_000 },
      () => {},
      timers,
    ).then(() => {
      resolved = true;
    });

    // Bump activity every 30s of virtual time for 10 minutes.
    for (let i = 0; i < 20; i++) {
      advance(30_000);
      lastActivity = timers.now();
    }
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it("inactivityMs <= 0 disables the silent-wedge trigger", async () => {
    const { timers, advance } = fakeTimers();
    const ctrl = new AbortController();
    let resolved = false;
    void turnAbandonDeadline(
      ctrl.signal,
      () => 0, // permanently silent
      { graceMs: 20_000, inactivityMs: 0 },
      () => {},
      timers,
    ).then(() => {
      resolved = true;
    });

    advance(60 * 60_000);
    await Promise.resolve();
    expect(resolved).toBe(false);
  });
});

describe("whenAborted", () => {
  it("resolves immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(Promise.race([whenAborted(ctrl.signal), Promise.reject(new Error("hung"))])).resolves.toBeUndefined();
  });

  it("resolves when the signal aborts later", async () => {
    const ctrl = new AbortController();
    let resolved = false;
    void whenAborted(ctrl.signal).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    ctrl.abort();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });
});
