// Per-user routes. Session-gated; scoped to the authenticated user (not a
// workspace). Currently handles per-user provider credentials (Codex OAuth).

import { Hono } from "hono";
import { requireAuth, type AuthVars } from "../auth/routes.ts";
import {
  getUserProvidersView,
  setUserProvider,
  removeUserProvider,
} from "../models/service.ts";
import {
  generatePKCE,
  buildAuthUrl,
  exchangeCode,
  type CodexOAuthSession,
} from "../models/codex-oauth.ts";
import type { Sessions } from "../auth/session.ts";

// In-memory PKCE sessions. Keyed by state nonce, TTL 10 minutes.
const codexOAuthSessions = new Map<string, CodexOAuthSession & { userId: string }>();

export function createUserRoutes(sessions: Sessions): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", requireAuth(sessions));

  // Current user's per-user provider statuses (subscription providers only).
  app.get("/providers", async (c) => {
    return c.json(await getUserProvidersView(c.get("userId")));
  });

  // Start Codex OAuth: generate PKCE + return the OpenAI authorization URL.
  app.post("/providers/openai-codex/oauth/start", async (c) => {
    const userId = c.get("userId");
    const { verifier, challenge } = await generatePKCE();
    const state = crypto.randomUUID();
    // Purge expired sessions before inserting so the map stays bounded.
    for (const [k, v] of codexOAuthSessions) {
      if (Date.now() > v.expires) codexOAuthSessions.delete(k);
    }
    codexOAuthSessions.set(state, { verifier, userId, expires: Date.now() + 10 * 60 * 1000 });
    return c.json({ authUrl: buildAuthUrl(challenge, state), state });
  });

  // Complete Codex OAuth: exchange the pasted redirect URL's code for tokens.
  app.post("/providers/openai-codex/oauth/complete", async (c) => {
    const userId = c.get("userId");
    const body = (await c.req.json().catch(() => ({}))) as { state?: unknown; code?: unknown };
    if (typeof body.state !== "string" || typeof body.code !== "string" || !body.state || !body.code) {
      return c.json({ error: "state and code are required" }, 400);
    }
    const { state, code } = body;
    const session = codexOAuthSessions.get(state);
    if (!session || session.userId !== userId || Date.now() > session.expires) {
      return c.json({ error: "OAuth session expired or invalid — please try again" }, 400);
    }
    codexOAuthSessions.delete(state);
    try {
      const tokens = await exchangeCode(code, session.verifier);
      const credential = { type: "oauth", ...tokens };
      const view = await setUserProvider(userId, "openai-codex", { authJson: credential });
      return c.json(view);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "OAuth failed" }, 400);
    }
  });

  // Store/replace any per-user provider credential.
  app.put("/providers/:provider", async (c) => {
    const provider = c.req.param("provider");
    const body = (await c.req.json().catch(() => ({}))) as { authJson?: unknown };
    try {
      return c.json(await setUserProvider(c.get("userId"), provider, body));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid_credential" }, 400);
    }
  });

  // Remove a per-user provider credential.
  app.delete("/providers/:provider", async (c) => {
    return c.json(await removeUserProvider(c.get("userId"), c.req.param("provider")));
  });

  return app;
}
