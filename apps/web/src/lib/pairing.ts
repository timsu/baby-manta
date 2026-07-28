// ─────────────────────────── worker pairing ───────────────────────────

const PAIR_KEY = "manta:pending-pair";

export interface PairRequest {
  /** Loopback URL the daemon is listening on (e.g. http://127.0.0.1:51234/cb). */
  callback: string;
  /** CSRF nonce the daemon generated; echoed back so it can match the response. */
  state: string;
  /** Human label for the machine (the daemon's hostname). */
  name: string;
}

// Read a pairing request from ?pair-worker=1&callback=…&state=…&name=… (then
// strip it), or from sessionStorage if a login round-trip happened in between.
export function capturePairRequest(): PairRequest | null {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("pair-worker")) {
      const callback = url.searchParams.get("callback") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const name = url.searchParams.get("name") || "worker";
      for (const k of ["pair-worker", "callback", "state", "name"]) url.searchParams.delete(k);
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      if (callback && state) {
        const req: PairRequest = { callback, state, name };
        sessionStorage.setItem(PAIR_KEY, JSON.stringify(req));
        return req;
      }
    }
  } catch { /* ignore malformed URL */ }
  try {
    const stored = sessionStorage.getItem(PAIR_KEY);
    return stored ? (JSON.parse(stored) as PairRequest) : null;
  } catch { return null; }
}

export function clearPairRequest() { sessionStorage.removeItem(PAIR_KEY); }

// Only ever hand the token back to a loopback address — never an arbitrary host,
// or the pairing page would become an open redirect that leaks worker tokens.
export function isLoopbackCallback(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:")
      && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  } catch { return false; }
}

// Chat now streams over the WebSocket (see ws.ts): user_ack + streamed events +
// kanban refresh all arrive as server messages.
