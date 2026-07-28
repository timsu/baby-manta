// Sign-in routes (Google OAuth + passwordless email) and the requireAuth
// middleware. All external seams (Google, sessions, user upsert) are injected
// via AuthDeps so the whole flow is testable with fakes and no network.
//
// Either method may be absent: `googleAuth` is null when no OAuth client is
// configured, and email sign-in is off unless `emailLoginEnabled`. GET
// /api/auth/methods tells the SPA which buttons to render.

import { Hono, type Context, type MiddlewareHandler } from "hono";
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
  /** Null when no Google OAuth client is configured. */
  googleAuth: GoogleAuth | null;
  sessions: Sessions;
  upsertUser(p: GoogleProfile): Promise<{ id: string; email: string }>;
  /** Find-or-create by email alone; backs the passwordless sign-in route. */
  upsertUserByEmail?(p: { email: string; name?: string }): Promise<{ id: string; email: string }>;
  /** Whether the passwordless email route is served at all. */
  emailLoginEnabled?: boolean;
  memberships(userId: string): Promise<Membership[]>;
  now: () => Date;
  webAppUrl: string;
  secureCookies: boolean;
}

/** Conservative address check — we only need to reject obvious junk, since
 * there is no delivery step that would catch it later. */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const STATE_COOKIE = "manta_oauth_state";

/** Hono var typing: requireAuth sets the authenticated user id. */
export type AuthVars = { userId: string; email: string };

export function createAuthRoutes(deps: AuthDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  const emailLogin = Boolean(deps.emailLoginEnabled && deps.upsertUserByEmail);

  /** Issue the session cookie for a signed-in user. */
  function setSession(c: Context, token: string) {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: deps.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 14,
    });
  }

  // Which sign-in methods this deployment offers. Unauthenticated by design —
  // the SPA calls it to decide what to render on the login card.
  app.get("/methods", (c) => c.json({ google: Boolean(deps.googleAuth), email: emailLogin }));

  // Passwordless sign-in: an address is enough, and the account is created on
  // first use. See config.emailLoginEnabled for why this is dev-only by default.
  app.post("/email", async (c) => {
    if (!emailLogin || !deps.upsertUserByEmail) return c.json({ error: "email_login_disabled" }, 404);

    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    if (!EMAIL_RE.test(email)) return c.json({ error: "invalid_email" }, 400);

    const user = await deps.upsertUserByEmail(name ? { email, name } : { email });
    setSession(c, await deps.sessions.issue({ userId: user.id, email: user.email }));
    return c.json({ ok: true, email: user.email });
  });

  // Kick off OAuth: set a CSRF state cookie and redirect to Google.
  app.get("/google", (c) => {
    if (!deps.googleAuth) return c.json({ error: "google_login_disabled" }, 404);
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
    if (!deps.googleAuth) return c.json({ error: "google_login_disabled" }, 404);
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
    setSession(c, await deps.sessions.issue({ userId: user.id, email: user.email }));
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
