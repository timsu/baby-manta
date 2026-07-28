// Google OAuth routes + the requireAuth middleware. All external seams
// (Google, sessions, user upsert) are injected via AuthDeps so the whole flow
// is testable with fakes and no network.

import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import type { GoogleProfile } from "@manta/db";
import type { GoogleAuth } from "./google.ts";
import { type Sessions, SESSION_COOKIE } from "./session.ts";

export interface Membership {
  workspaceId: string;
  slug: string;
  name: string;
  role: string;
}

export interface AuthDeps {
  googleAuth: GoogleAuth;
  sessions: Sessions;
  upsertUser(p: GoogleProfile): Promise<{ id: string; email: string }>;
  memberships(userId: string): Promise<Membership[]>;
  now: () => Date;
  webAppUrl: string;
  secureCookies: boolean;
}

const STATE_COOKIE = "manta_oauth_state";

/** Hono var typing: requireAuth sets the authenticated user id. */
export type AuthVars = { userId: string; email: string };

export function createAuthRoutes(deps: AuthDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  // Kick off OAuth: set a CSRF state cookie and redirect to Google.
  app.get("/google", (c) => {
    const state = randomBytes(16).toString("hex");
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: deps.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    return c.redirect(deps.googleAuth.authUrl(state));
  });

  // OAuth callback: validate state, exchange code, upsert user, set session.
  app.get("/google/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });

    if (!code || !state || !expected || state !== expected) {
      return c.json({ error: "invalid_oauth_state" }, 400);
    }

    let profile: GoogleProfile;
    try {
      profile = await deps.googleAuth.exchange(code);
    } catch {
      return c.json({ error: "oauth_exchange_failed" }, 401);
    }

    const user = await deps.upsertUser(profile);
    const token = await deps.sessions.issue({ userId: user.id, email: user.email });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: deps.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 14,
    });
    return c.redirect(deps.webAppUrl);
  });

  // Log out.
  app.delete("/", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}

/** Middleware: require a valid session; sets `userId`/`email` on the context. */
export function requireAuth(sessions: Sessions): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const claims = token ? await sessions.verify(token) : null;
    if (!claims) return c.json({ error: "unauthenticated" }, 401);
    c.set("userId", claims.sub);
    c.set("email", claims.email);
    await next();
  };
}
