import { describe, it, expect } from "vitest";
import { createApp } from "../app.ts";
import type { Logger } from "../logger.ts";
import type { AuthDeps } from "./routes.ts";
import type { GoogleProfile } from "@manta/db";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function fakeAuth(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    googleAuth: {
      authUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      exchange: async (code): Promise<GoogleProfile> => {
        if (code !== "good") throw new Error("bad code");
        return { googleSub: "g-123", email: "dev@acme.com", name: "Dev" };
      },
    },
    sessions: {
      issue: async ({ userId }) => `tok-${userId}`,
      verify: async (token) =>
        token.startsWith("tok-") ? { sub: token.slice(4), email: "dev@acme.com", exp: 9_999_999_999 } : null,
    },
    upsertUser: async (p) => ({ id: "u1", email: p.email }),
    memberships: async () => [{ workspaceId: "w1", slug: "acme", name: "Acme", role: "owner" }],
    now: () => new Date("2026-05-29T00:00:00Z"),
    webAppUrl: "http://localhost:5173",
    secureCookies: false,
    ...overrides,
  };
}

const app = () => createApp({ logger: silent, auth: fakeAuth() });

describe("GET /api/auth/google", () => {
  it("redirects to Google and sets a state cookie", async () => {
    const res = await app().request("/api/auth/google");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("accounts.google.com");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("manta_oauth_state=");
    // the state in the redirect matches the one we stored
    const state = new URL(loc).searchParams.get("state");
    expect(setCookie).toContain(`manta_oauth_state=${state}`);
  });
});

describe("GET /api/auth/google/callback", () => {
  it("rejects a state mismatch (CSRF guard)", async () => {
    const res = await app().request("/api/auth/google/callback?code=good&state=xyz", {
      headers: { Cookie: "manta_oauth_state=abc" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a failed code exchange", async () => {
    const res = await app().request("/api/auth/google/callback?code=bad&state=s1", {
      headers: { Cookie: "manta_oauth_state=s1" },
    });
    expect(res.status).toBe(401);
  });

  it("on success upserts the user, sets a session cookie, and redirects to the app", async () => {
    const res = await app().request("/api/auth/google/callback?code=good&state=s1", {
      headers: { Cookie: "manta_oauth_state=s1" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:5173");
    expect(res.headers.get("set-cookie") ?? "").toContain("manta_session=tok-u1");
  });
});

describe("GET /api/me", () => {
  it("401s without a session", async () => {
    const res = await app().request("/api/me");
    expect(res.status).toBe(401);
  });

  it("returns the user + memberships with a valid session", async () => {
    const res = await app().request("/api/me", { headers: { Cookie: "manta_session=tok-u1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; memberships: Array<{ slug: string }> };
    expect(body.id).toBe("u1");
    expect(body.memberships[0]?.slug).toBe("acme");
  });
});
