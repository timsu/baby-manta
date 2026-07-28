// Upstash Redis (REST) used purely as a *survives-restart cache*, not a source of
// truth. Single-instance deployments lose all in-memory worker state on every
// deploy (the process is replaced); parking presence and in-flight turn state
// here lets the new process show the worker as still-online and finish a message
// whose stream spanned the restart.
//
// Every call is best-effort: Redis being slow or down must NEVER break a request
// or a worker event. Helpers swallow errors and return null/empty, and the whole
// module no-ops when the creds are unset (dev/tests run without Redis).
//
// REST has no pub/sub (no persistent SUBSCRIBE), but a single instance needs no
// cross-instance bus — plain GET/SET/HSET with read-time expiry is enough.

import { Redis } from "@upstash/redis";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";

const logger = createLogger("Manta:Redis");

// dev and prod share one Upstash instance, so namespace every key by env to keep
// a local dev worker's presence from colliding with production's.
const PREFIX = `manta:${config.isProd() ? "prod" : "dev"}:`;
const k = (key: string): string => PREFIX + key;

let client: Redis | null | undefined;

/** Lazily construct the client (or null if unconfigured). Cached after first call. */
function getClient(): Redis | null {
  if (client !== undefined) return client;
  const { url, token } = config.redis();
  if (!url || !token) {
    logger.info("Redis disabled (no UPSTASH_REDIS_REST_* configured)");
    client = null;
    return null;
  }
  client = new Redis({ url, token });
  return client;
}

export function redisEnabled(): boolean {
  return getClient() !== null;
}

/** Set field on a hash to a JSON value. Best-effort. */
export async function hset(key: string, field: string, value: unknown): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.hset(k(key), { [field]: JSON.stringify(value) });
  } catch (err) {
    logger.warn("hset failed", { key, field, err });
  }
}

/** Read every field of a hash as parsed JSON values. Best-effort → {} on error. */
export async function hgetall<T = unknown>(key: string): Promise<Record<string, T>> {
  const c = getClient();
  if (!c) return {};
  try {
    const raw = await c.hgetall<Record<string, unknown>>(k(key));
    if (!raw) return {};
    const out: Record<string, T> = {};
    for (const [field, v] of Object.entries(raw)) {
      // Upstash auto-deserializes JSON; tolerate both already-parsed and string.
      out[field] = (typeof v === "string" ? safeParse(v) : v) as T;
    }
    return out;
  } catch (err) {
    logger.warn("hgetall failed", { key, err });
    return {};
  }
}

/** Remove a field from a hash. Best-effort. */
export async function hdel(key: string, field: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.hdel(k(key), field);
  } catch (err) {
    logger.warn("hdel failed", { key, field, err });
  }
}

/** Set a JSON value with a TTL (seconds). Best-effort.
 * Returns false only when a configured Redis write fails; disabled Redis is a
 * successful no-op so callers don't retain unsendable cache entries forever. */
export async function setJson(key: string, value: unknown, ttlSec: number): Promise<boolean> {
  const c = getClient();
  if (!c) return true;
  try {
    await c.set(k(key), JSON.stringify(value), { ex: ttlSec });
    return true;
  } catch (err) {
    logger.warn("setJson failed", { key, err });
    return false;
  }
}

/** Read a JSON value, or null if absent/error. */
export async function getJson<T = unknown>(key: string): Promise<T | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const v = await c.get<unknown>(k(key));
    if (v == null) return null;
    return (typeof v === "string" ? safeParse(v) : v) as T;
  } catch (err) {
    logger.warn("getJson failed", { key, err });
    return null;
  }
}

/** Delete a key. Best-effort. */
export async function del(key: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.del(k(key));
  } catch (err) {
    logger.warn("del failed", { key, err });
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
