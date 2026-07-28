// GitHub integration routes, mounted at /api/integrations/github.
//
// Two connect flows live here:
//   • App installation (per workspace) — the prerequisite for everything.
//     "Connect" → GitHub install screen → Setup URL redirects back to
//     /callback with installation_id → we store WorkspaceIdentity(github).
//   • Per-user link — "Link GitHub" runs the App's user OAuth so we learn the
//     person's GitHub login/token (used to show "my PRs" and open PRs as them).
//
// Plus the App webhook receiver, which keeps the connection state self-healing
// (installation removed on GitHub → we drop the identity row).
//
// GitHub App settings (one-time, manual): Setup URL → …/api/integrations/github/callback,
// User authorization callback URL → …/api/integrations/github/me/callback,
// Webhook URL → …/api/integrations/github/webhook.

import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { workspaces, github as githubDb, userSecrets, prisma } from "@manta/db";
import { requireAuth, type AuthVars } from "../auth/routes.ts";
import type { Sessions } from "../auth/session.ts";
import { config } from "../config.ts";
import { getInstallation, listInstallationRepos } from "./app.ts";
import { encryptGithubUserToken } from "./userTokens.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:GitHub");

export interface GithubRoutesDeps {
  sessions: Sessions;
  /** Web origin to bounce browsers back to after a flow completes. */
  webAppUrl: string;
  secureCookies: boolean;
}

const INSTALL_STATE_COOKIE = "manta_gh_install";
const USER_STATE_COOKIE = "manta_gh_user";

function setStateCookie(c: Context, name: string, value: string, secure: boolean) {
  setCookie(c, name, value, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
}

export function createGithubRoutes(deps: GithubRoutesDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();
  const auth = requireAuth(deps.sessions);

  // ── App webhook (no auth; verified by signature) ────────────────────────────
  app.post("/webhook", async (c) => {
    const secret = config.github().webhookSecret;
    // Fail closed: without a configured secret we can't verify the signature, so
    // we must not process the payload — an unsigned request could otherwise
    // mutate installation/identity rows.
    if (!secret) {
      logger.warn("github webhook rejected: GITHUB_WEBHOOK_SECRET not configured");
      return c.json({ error: "webhook_not_configured" }, 503);
    }
    const raw = await c.req.text();
    const sig = c.req.header("x-hub-signature-256");
    const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const a = Buffer.from(sig ?? "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const event = c.req.header("x-github-event") ?? "";
    const action = (payload.action as string | undefined) ?? "";
    const installation = payload.installation as { id?: number } | undefined;
    const installationId = installation?.id ? String(installation.id) : null;

    // Record the delivery (best-effort, cross-workspace).
    const deliveryId = c.req.header("x-github-delivery") ?? randomBytes(8).toString("hex");
    const workspaceId = installationId
      ? await githubDb.findWorkspaceByInstallation(installationId)
      : null;
    try {
      await prisma.webhookDelivery.create({
        data: {
          provider: "github",
          eventId: deliveryId,
          kind: `${event}.${action}`,
          payload: payload as object,
          ...(workspaceId ? { workspaceId } : {}),
        },
      });
    } catch {
      /* duplicate delivery — ignore */
    }

    // Lifecycle: installation removed on GitHub → drop the identity so the badge
    // flips back to "Not connected" without manual cleanup.
    if (event === "installation" && action === "deleted" && installationId) {
      await githubDb.unlinkInstallationById(installationId);
      logger.info("github installation removed", { installationId });
    }

    return c.json({ ok: true });
  });

  // ── App installation: kick off ──────────────────────────────────────────────
  app.get("/install", auth, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);

    const slug = config.github().appSlug;
    if (!slug) return c.json({ error: "github_app_not_configured" }, 500);

    const nonce = randomBytes(16).toString("hex");
    setStateCookie(c, INSTALL_STATE_COOKIE, nonce, deps.secureCookies);
    const state = `${nonce}.${ws}`;
    return c.redirect(`https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`);
  });

  // ── App installation: Setup URL redirect target ─────────────────────────────
  app.get("/callback", auth, async (c) => {
    const installationId = c.req.query("installation_id");
    const state = c.req.query("state") ?? "";
    const expected = getCookie(c, INSTALL_STATE_COOKIE);
    deleteCookie(c, INSTALL_STATE_COOKIE, { path: "/" });

    const [nonce, ws] = state.split(".");
    if (!installationId || !nonce || !ws || nonce !== expected) {
      return c.redirect(`${deps.webAppUrl}/?github=error`);
    }
    if (!(await workspaces.isMember(c.get("userId"), ws))) {
      return c.redirect(`${deps.webAppUrl}/?github=error`);
    }

    await githubDb.linkInstallation(ws, installationId);
    logger.info("github installation linked", { ws, installationId });
    return c.redirect(`${deps.webAppUrl}/?github=connected`);
  });

  // ── Repos the installation can access (for the repo picker) ─────────────────
  app.get("/repos", auth, async (c) => {
    const ws = c.req.query("ws");
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);

    const installationId = await githubDb.findInstallationForWorkspace(ws);
    if (!installationId) return c.json({ connected: false, account: null, repos: [] });

    let account: { login: string; avatarUrl: string } | null = null;
    try {
      const inst = await getInstallation(installationId);
      account = { login: inst.account.login, avatarUrl: inst.account.avatar_url };
    } catch {
      /* installation may have been removed on GitHub; surface as connected:false */
      return c.json({ connected: false, account: null, repos: [] });
    }

    let available: Array<{ orgRepo: string; defaultBranch: string; private: boolean }> = [];
    try {
      available = await listInstallationRepos(installationId);
    } catch (err) {
      logger.warn("failed to list installation repos", { ws, err });
    }
    return c.json({ connected: true, account, repos: available });
  });

  // ── Disconnect (forget the installation on our side) ────────────────────────
  app.post("/disconnect", auth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ws?: string };
    const ws = body.ws;
    if (!ws) return c.json({ error: "ws required" }, 400);
    if (!(await workspaces.isMember(c.get("userId"), ws))) return c.json({ error: "not_a_member" }, 403);
    await githubDb.unlinkInstallation(ws);
    return c.json({ ok: true });
  });

  // ── Per-user link: learn the caller's GitHub login/token via user OAuth ─────
  app.get("/me/connect", auth, (c) => {
    const { clientId } = config.github();
    if (!clientId) return c.json({ error: "github_app_not_configured" }, 500);
    const nonce = randomBytes(16).toString("hex");
    setStateCookie(c, USER_STATE_COOKIE, nonce, deps.secureCookies);
    const redirectUri = `${deps.webAppUrl}/api/integrations/github/me/callback`;
    const url =
      `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&state=${nonce}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    return c.redirect(url);
  });

  app.get("/me/callback", auth, async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const expected = getCookie(c, USER_STATE_COOKIE);
    deleteCookie(c, USER_STATE_COOKIE, { path: "/" });
    if (!code || !state || state !== expected) {
      return c.redirect(`${deps.webAppUrl}/?github_user=error`);
    }

    const { clientId, clientSecret } = config.github();
    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        refresh_token_expires_in?: number;
      };
      const accessToken = tokenJson.access_token;
      if (!accessToken) throw new Error("no access_token");

      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      const ghUser = (await userRes.json()) as { login?: string; id?: number };
      if (!ghUser.login || !ghUser.id) throw new Error("no user");

      const userId = c.get("userId");
      const tokenMeta = {
        login: ghUser.login,
        githubUserId: String(ghUser.id),
        ...(tokenJson.expires_in ? { expiresAt: Date.now() + tokenJson.expires_in * 1000 } : {}),
        ...(tokenJson.refresh_token_expires_in
          ? { refreshTokenExpiresAt: Date.now() + tokenJson.refresh_token_expires_in * 1000 }
          : {}),
      };
      const tokenCiphertext = Buffer.from(encryptGithubUserToken(accessToken, tokenJson.refresh_token));
      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: { githubLogin: ghUser.login, githubUserId: String(ghUser.id) },
        }),
        prisma.userSecret.upsert({
          where: { userId_kind: { userId, kind: userSecrets.GITHUB_OAUTH_SECRET_KIND } },
          create: {
            userId,
            kind: userSecrets.GITHUB_OAUTH_SECRET_KIND,
            ciphertext: tokenCiphertext,
            meta: tokenMeta,
          },
          update: {
            ciphertext: tokenCiphertext,
            meta: tokenMeta,
          },
        }),
      ]);
      logger.info("github user linked", { userId, login: ghUser.login });
      return c.redirect(`${deps.webAppUrl}/?github_user=linked`);
    } catch (err) {
      logger.warn("github user link failed", { err });
      return c.redirect(`${deps.webAppUrl}/?github_user=error`);
    }
  });

  return app;
}
