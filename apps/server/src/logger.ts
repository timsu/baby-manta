// Local structured logger. Convention (from the platform): never `console.log`
// directly in app code — use createLogger(). Emits one JSON line per event so
// downstream shippers (CloudWatch / HyperDX) can parse it. Zero dependencies.

type Level = "debug" | "info" | "warn" | "error";

export interface ServerLogEntry {
  level: Level;
  domain: string;
  msg: string;
  time: string;
  [key: string]: unknown;
}

export type PublicServerLogEntry = Pick<ServerLogEntry, "level" | "domain" | "msg" | "time">;

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const MAX_RECENT_LOGS = 500;
const recentLogs: ServerLogEntry[] = [];

export function getRecentServerLogs(limit = 200): ServerLogEntry[] {
  const safeLimit = Math.max(1, Math.min(MAX_RECENT_LOGS, Math.floor(limit) || 200));
  return recentLogs.slice(-safeLimit).map((entry) => ({ ...entry }));
}

export function getRecentPublicServerLogs(limit = 200): PublicServerLogEntry[] {
  return getRecentServerLogs(limit).map(({ level, domain, msg, time }) => ({ level, domain, msg, time }));
}

function remember(entry: ServerLogEntry): void {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT_LOGS) recentLogs.splice(0, recentLogs.length - MAX_RECENT_LOGS);
}

/** Normalize Errors (recursing into `cause`) so JSON.stringify keeps message/stack. */
function normalize(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

function serializeError(err: Error): Record<string, unknown> {
  const base: Record<string, unknown> = {
    message: err.message,
    name: err.name,
    stack: err.stack,
  };
  if (err.cause instanceof Error) base["cause"] = serializeError(err.cause);
  else if (err.cause !== undefined) base["cause"] = err.cause;
  return base;
}

export function createLogger(domain: string): Logger {
  const emit = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    const entry: ServerLogEntry = {
      level,
      domain,
      msg,
      // Date.now is fine in app code; tests inject a clock where determinism matters.
      time: new Date().toISOString(),
      ...normalize(meta),
    };
    remember(entry);
    const line = JSON.stringify(entry);
    // The single sanctioned console use: the structured sink.
    if (level === "error" || level === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}
