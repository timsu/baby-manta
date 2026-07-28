import { describe, it, expect } from "vitest";
import { createApp } from "./app.ts";
import { createLogger, getRecentPublicServerLogs, type Logger } from "./logger.ts";
import type { AuthDeps } from "./auth/routes.ts";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeAuth(): AuthDeps {
  return {
    googleAuth: { authUrl: () => "", exchange: async () => ({ googleSub: "g", email: "dev@example.com" }) },
    sessions: {
      issue: async ({ userId }) => `tok-${userId}`,
      verify: async (token) => token === "tok-u1" ? { sub: "u1", email: "dev@example.com", exp: 9_999_999_999 } : null,
    },
    upsertUser: async (profile) => ({ id: "u1", email: profile.email }),
    memberships: async () => [],
    now: () => new Date("2026-05-28T00:00:00.000Z"),
    webAppUrl: "http://localhost:5173",
    secureCookies: false,
  };
}

describe("createApp", () => {
  it("/_ping always returns 200 ok", async () => {
    const app = createApp({ logger: silentLogger });
    const res = await app.request("/_ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("/api/health returns 200 when ready, with injected clock", async () => {
    const fixed = new Date("2026-05-28T00:00:00.000Z");
    const app = createApp({ logger: silentLogger, now: () => fixed, isReady: () => true });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, time: fixed.toISOString() });
  });

  it("/api/health returns 503 when not ready (draining)", async () => {
    const app = createApp({ logger: silentLogger, isReady: () => false });
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("/api/debug/server-logs requires auth", async () => {
    const app = createApp({ logger: silentLogger, auth: fakeAuth() });
    const res = await app.request("/api/debug/server-logs");
    expect(res.status).toBe(401);
  });

  it("/api/debug/server-logs returns sanitized recent structured logs", async () => {
    createLogger("Manta:Test").info("debug endpoint test", { requestId: "r1" });
    const app = createApp({ logger: silentLogger, auth: fakeAuth() });
    const res = await app.request("/api/debug/server-logs?limit=20", { headers: { Cookie: "manta_session=tok-u1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: ReturnType<typeof getRecentPublicServerLogs> };
    const log = body.logs.find((entry) => entry.domain === "Manta:Test" && entry.msg === "debug endpoint test");
    expect(log).toMatchObject({ level: "info", domain: "Manta:Test", msg: "debug endpoint test" });
    expect(log).not.toHaveProperty("requestId");
  });
});
