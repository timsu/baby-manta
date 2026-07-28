import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { workspaces } from "@manta/db";
import { requireAuth, type AuthVars } from "../auth/routes.ts";
import type { Sessions } from "../auth/session.ts";
import { createLogger } from "../logger.ts";
import { decryptJson, encryptJson } from "../secrets/crypto.ts";
import { disconnectNotion, notionConnected, storeNotionCredential } from "./client.ts";
import { exchangeNotionCode, startNotionOAuth, type NotionOAuthSession } from "./oauth.ts";

const logger = createLogger("Manta:NotionRoutes");
const OAUTH_COOKIE = "manta_notion_oauth";
type StoredOAuthSession = NotionOAuthSession & { state: string; userId: string; workspaceId: string };

export function createNotionRoutes(deps: { sessions?: Sessions; webAppUrl: string; secureCookies?: boolean }): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();
  const authGate = async (c: Context<{ Variables: AuthVars }>, next: () => Promise<void>) => {
    if (!deps.sessions) return c.json({ error: "auth_not_configured" }, 503);
    return requireAuth(deps.sessions)(c, next);
  };
  const memberWorkspace = async (c: Context<{ Variables: AuthVars }>, workspaceId: string): Promise<boolean> =>
    Boolean(workspaceId) && await workspaces.isMember(c.get("userId"), workspaceId);
  const redirectUri = `${deps.webAppUrl}/api/notion/oauth/callback`;

  app.get("/status", authGate, async (c) => {
    const workspaceId = c.req.query("ws") ?? "";
    if (!(await memberWorkspace(c, workspaceId))) return c.json({ error: "not_a_member" }, 403);
    const settings = await workspaces.getSettings(workspaceId);
    return c.json({ connected: await notionConnected(workspaceId), instructions: settings.notionInstructions ?? "" });
  });

  app.put("/instructions", authGate, async (c) => {
    const body = await c.req.json().catch(() => ({})) as { ws?: unknown; instructions?: unknown };
    const workspaceId = typeof body.ws === "string" ? body.ws : "";
    if (!(await memberWorkspace(c, workspaceId))) return c.json({ error: "not_a_member" }, 403);
    const instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 20_000) : "";
    await workspaces.updateSettings(workspaceId, { notionInstructions: instructions });
    return c.json({ instructions });
  });

  app.get("/oauth/connect", authGate, async (c) => {
    const workspaceId = c.req.query("ws") ?? "";
    if (!(await memberWorkspace(c, workspaceId))) return c.json({ error: "not_a_member" }, 403);
    const state = randomUUID();
    try {
      const started = await startNotionOAuth({ state, redirectUri });
      const session: StoredOAuthSession = { ...started.session, state, userId: c.get("userId"), workspaceId };
      setCookie(c, OAUTH_COOKIE, encryptJson(session).toString("base64url"), {
        httpOnly: true,
        secure: deps.secureCookies ?? false,
        sameSite: "Lax",
        path: "/",
        maxAge: 10 * 60,
      });
      return c.redirect(started.authUrl);
    } catch (err) {
      logger.warn("failed to start Notion OAuth", { workspaceId, err });
      return c.redirect(`${deps.webAppUrl}/?notion=error`);
    }
  });

  app.get("/oauth/callback", authGate, async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const cookie = getCookie(c, OAUTH_COOKIE);
    deleteCookie(c, OAUTH_COOKIE, { path: "/" });
    let session: StoredOAuthSession | null = null;
    try {
      if (cookie) session = decryptJson<StoredOAuthSession>(Buffer.from(cookie, "base64url"));
    } catch {
      session = null;
    }
    if (!session || !code || session.state !== state || session.userId !== c.get("userId") || session.expires < Date.now()) {
      return c.redirect(`${deps.webAppUrl}/?notion=error`);
    }
    if (!(await memberWorkspace(c, session.workspaceId))) return c.redirect(`${deps.webAppUrl}/?notion=error`);
    try {
      await storeNotionCredential(session.workspaceId, await exchangeNotionCode(code, session));
      return c.redirect(`${deps.webAppUrl}/?notion=connected`);
    } catch (err) {
      logger.warn("Notion OAuth callback failed", { workspaceId: session.workspaceId, err });
      return c.redirect(`${deps.webAppUrl}/?notion=error`);
    }
  });

  app.post("/disconnect", authGate, async (c) => {
    const body = await c.req.json().catch(() => ({})) as { ws?: unknown };
    const workspaceId = typeof body.ws === "string" ? body.ws : "";
    if (!(await memberWorkspace(c, workspaceId))) return c.json({ error: "not_a_member" }, 403);
    await disconnectNotion(workspaceId);
    return c.json({ ok: true });
  });
  return app;
}
