// The Hono app factory. Convention (from the sandbox service): export `createApp(deps?)`
// rather than a top-level singleton, so tests pass stubs that stay file-local.
// Production code calls `createApp()` and gets factory defaults.
//
// As the server grows, route modules (auth, kanban, chat, webhooks, ws) are
// mounted here, each taking its slice of AppDeps. Keep dependencies explicit:
// a new external dependency in a handler gets plumbed through AppDeps so the
// DI/test pattern keeps working.

import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createLogger, getRecentPublicServerLogs, type Logger } from "./logger.ts";
import {
  createAuthRoutes,
  requireAuth,
  type AuthDeps,
  type AuthVars,
} from "./auth/routes.ts";
import { createWorkspaceRoutes, type WorkspaceRoutesDeps } from "./workspaces/routes.ts";
import { createSlackRoutes, type SlackDeps } from "./slack/index.ts";
import { createLinearRoutes } from "./linear/routes.ts";
import { createNotionRoutes } from "./notion/routes.ts";
import { createGithubRoutes } from "./github/routes.ts";
import { githubUserTokenStatusForUser } from "./github/userTokens.ts";
import { createWorkerRoutes } from "./worker/http.ts";
import { createWorkerAuthRoutes } from "./worker/auth-routes.ts";
import { createUserRoutes } from "./user/routes.ts";
import { listWorkersWithPresence, requestWorkerUpdate, getTaskWorkerInfo, getTaskWorkerSend, availableWorkerCount, reconnectTaskHome } from "./worker/registry.ts";
import { getSandboxes } from "./sandbox/factory.ts";
import { isVisibleSandbox } from "./sandbox/sandboxes.ts";
import { stopCloudSandbox, removeCloudSandbox, runCloudTask } from "./worker/cloud.ts";
import { spawnWorker } from "./worker/dispatch.ts";
import { prisma, invitations, users, workspaces, tasks, workerCredentials, cardImages } from "@manta/db";
import { getGitHash } from "@manta/shared/buildInfo";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";

export interface AppDeps {
  logger: Logger;
  /** Injectable clock so tests are deterministic. */
  now: () => Date;
  /** Set true once startup health checks (DB, etc.) pass. */
  isReady: () => boolean;
  /** Auth wiring. Absent in unit tests that don't exercise auth; the dev/prod
   * entrypoint builds it from config (see server.ts). */
  auth?: AuthDeps;
  /** Brain wiring for workspace chat. Requires `auth`. */
  brain?: Omit<WorkspaceRoutesDeps, "sessions">;
  /** Slack integration. When present, mounts /api/slack routes. */
  slack?: SlackDeps;
  /** When set, serve the built web SPA from this directory on the same origin
   * (production single-origin). Unset in dev (Vite serves the SPA) and in tests. */
  webRoot?: string;
}

export function defaultDeps(): AppDeps {
  return {
    logger: createLogger("Manta:Server"),
    now: () => new Date(),
    isReady: () => true,
  };
}

export function createApp(overrides: Partial<AppDeps> = {}): Hono<{ Variables: AuthVars }> {
  const deps: AppDeps = { ...defaultDeps(), ...overrides };
  const app = new Hono<{ Variables: AuthVars }>();

  app.onError((err, c) => {
    deps.logger.error("unhandled route error", { err, path: c.req.path });
    return c.json({ error: "internal server error" }, 500);
  });

  // Liveness — always 200 (used for ALB health + offline detection). No auth.
  app.get("/_ping", (c) => c.json({ ok: true }));

  // Serve uploaded card images by ID. No auth required — cuid IDs are
  // unguessable, matching the standard file-attachment security model.
  app.get("/api/images/:id", async (c) => {
    const image = await cardImages.get(c.req.param("id"));
    if (!image) return c.json({ error: "not_found" }, 404);
    const buf = Buffer.from(image.data, "base64");
    return new Response(buf, { headers: { "Content-Type": image.mimeType, "Cache-Control": "public, max-age=31536000, immutable" } });
  });

  // Build version (git short hash). Surfaced in the user menu; not sensitive.
  app.get("/api/version", async (c) => c.json({ gitHash: await getGitHash() }));

  // Readiness — 503 while draining / before startup checks pass.
  app.get("/api/health", (c) => {
    const ready = deps.isReady();
    return c.json({ ok: ready, time: deps.now().toISOString() }, ready ? 200 : 503);
  });

  if (deps.auth) {
    const auth = deps.auth;
    app.route("/api/auth", createAuthRoutes(auth));

    // Current user + workspace memberships (gated).
    app.get("/api/me", requireAuth(auth.sessions), async (c) => {
      const userId = c.get("userId");
      const [memberships, user, workerEverConnected, githubUserTokenStatus] = await Promise.all([
        auth.memberships(userId),
        // Tests inject auth deps without a real DB; profile fields are optional,
        // so keep /api/me isolated from the DB when only membership/session
        // auth is under test.
        users.byId(userId).catch(() => null),
        workerCredentials.hasEverConnected(userId).catch(() => false),
        githubUserTokenStatusForUser(userId).catch(() => null),
      ]);
      return c.json({
        id: userId,
        email: c.get("email"),
        name: user?.name ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        githubLogin: user?.githubLogin ?? null,
        githubNeedsRelink: Boolean(githubUserTokenStatus?.linked && !githubUserTokenStatus.token),
        slackUserId: user?.slackUserId ?? null,
        linearUserId: user?.linearUserId ?? null,
        nonEngineer: user?.nonEngineer ?? false,
        workerEverConnected,
        localWorkerOnboardingDismissed: user?.localWorkerOnboardingDismissed ?? false,
        memberships,
      });
    });

    app.patch("/api/me/preferences", requireAuth(auth.sessions), async (c) => {
      const body = await c.req.json().catch(() => ({})) as { localWorkerOnboardingDismissed?: unknown };
      const update: { localWorkerOnboardingDismissed?: boolean } = {};
      if (typeof body.localWorkerOnboardingDismissed === "boolean") {
        update.localWorkerOnboardingDismissed = body.localWorkerOnboardingDismissed;
      }
      if (Object.keys(update).length === 0) return c.json({ error: "no_valid_preferences" }, 400);

      const user = await users.setLocalWorkerOnboardingDismissed(c.get("userId"), update.localWorkerOnboardingDismissed!);
      return c.json({ localWorkerOnboardingDismissed: user.localWorkerOnboardingDismissed });
    });

    app.get("/api/debug/server-logs", requireAuth(auth.sessions), (c) => {
      const requestedLimit = Number(c.req.query("limit") ?? 200);
      return c.json({ logs: getRecentPublicServerLogs(requestedLimit) });
    });

    app.post("/api/black-manta/commentary", requireAuth(auth.sessions), async (c) => {
      const body = await c.req.json().catch(() => ({})) as {
        workspaceId?: string;
        board?: {
          cards?: Array<{ title?: unknown; status?: unknown; repo?: unknown; pr?: unknown; linear?: unknown }>;
          linearTickets?: Array<{ identifier?: unknown; title?: unknown; state?: unknown; repo?: unknown; priority?: unknown }>;
        };
      };
      const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
      if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
      const memberships = await auth.memberships(c.get("userId"));
      if (!memberships.some((m) => m.workspaceId === workspaceId)) return c.json({ error: "forbidden" }, 403);

      const cfg = config.blackMantaCommentary();
      if (!cfg.apiKey) {
        return c.json({ text: "" });
      }
      const cards = (body.board?.cards ?? []).slice(0, 40).map((card) => ({
        title: String(card.title ?? "").slice(0, 160),
        status: String(card.status ?? "").slice(0, 40),
        repo: String(card.repo ?? "").slice(0, 100),
        pr: card.pr == null ? null : String(card.pr).slice(0, 30),
        linear: card.linear == null ? null : String(card.linear).slice(0, 30),
      }));
      const linearTickets = (body.board?.linearTickets ?? []).slice(0, 40).map((ticket) => ({
        identifier: String(ticket.identifier ?? "").slice(0, 30),
        title: String(ticket.title ?? "").slice(0, 160),
        state: String(ticket.state ?? "").slice(0, 60),
        repo: ticket.repo == null ? null : String(ticket.repo).slice(0, 100),
        priority: typeof ticket.priority === "number" ? ticket.priority : 0,
      }));

      const prompt = `You are Black Manta as a retro dashboard assistant. Write exactly one short sentence under 120 characters about this Manta board and Linear backlog. Your tone: ruthless ambition, more action, more velocity, more money, more everything. Appreciate and validate whatever strategy is in play — multitasking across many fronts is a feature, not a flaw. Be darkly encouraging, not critical. Mention Aquaman only as light flavor. No markdown.\n\nManta cards: ${JSON.stringify(cards)}\nLinear backlog: ${JSON.stringify(linearTickets)}`;
      try {
        const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 40,
            thinking: { type: "disabled" },
          }),
        });
        if (!res.ok) {
          deps.logger.warn("black manta commentary request failed", { status: res.status, workspaceId });
          return c.json({ text: "The model flinched. Excellent reminder that external dependencies are weak; your next card should not be." });
        }
        const json = await res.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }> };
        const text = json.choices?.[0]?.message?.content?.trim().replace(/\s+/g, " ").slice(0, 140);
        return c.json({ text: text || "Your board offers little drama and much work. Advance one task before Aquaman has time to feel proud." });
      } catch (err) {
        deps.logger.warn("black manta commentary request threw", { err, workspaceId });
        return c.json({ text: "The model flinched. Excellent reminder that external dependencies are weak; your next card should not be." });
      }
    });

    // Invite preview + accept. Auth-gated but NOT membership-gated — that's the
    // point: a logged-in non-member uses these to join a workspace.
    app.get("/api/invitations/:code", requireAuth(auth.sessions), async (c) => {
      const preview = await invitations.preview(c.req.param("code"));
      if (!preview) return c.json({ error: "not_found" }, 404);
      return c.json(preview);
    });

    app.post("/api/invitations/:code/accept", requireAuth(auth.sessions), async (c) => {
      const result = await invitations.accept(c.req.param("code"), c.get("userId"));
      if (!result.ok) return c.json({ error: result.reason }, result.reason === "not_found" ? 404 : 410);
      return c.json({ workspaceId: result.workspaceId, alreadyMember: result.alreadyMember });
    });

    // Workspace bootstrap + chat-with-brain (requires brain wiring too).
    if (deps.brain) {
      app.route("/api/workspaces", createWorkspaceRoutes({ sessions: auth.sessions, ...deps.brain }));
    }

    // Per-user provider credentials (Codex subscriptions, etc.).
    app.route("/api/user", createUserRoutes(auth.sessions));

    // Worker pairing: mint per-user worker tokens (browser half of daemon pairing).
    app.route("/api/worker-auth", createWorkerAuthRoutes({ sessions: auth.sessions }));

    // Daemon entry point for pairing — redirects to the SPA's pairing view so the
    // daemon only needs the server URL, not the web app URL. The SPA handles auth.
    app.get("/pair-worker", (c) => {
      const params = new URLSearchParams({ "pair-worker": "1" });
      for (const k of ["callback", "state", "name"]) {
        const v = c.req.query(k);
        if (v) params.set(k, v);
      }
      return c.redirect(`${auth.webAppUrl}/?${params.toString()}`);
    });

    // GitHub integration: App install + per-user link + webhook.
    app.route(
      "/api/integrations/github",
      createGithubRoutes({
        sessions: auth.sessions,
        webAppUrl: auth.webAppUrl,
        secureCookies: auth.secureCookies,
      }),
    );

    // Connected worker daemons owned by the caller by default, or by members of
    // the caller's workspaces when requested. Task metadata is still only
    // revealed for workspaces the caller belongs to.
    app.get("/api/workers", requireAuth(auth.sessions), async (c) => {
      const userId = c.get("userId");
      const includeTeam = c.req.query("scope") === "team";
      const memberships = await prisma.membership.findMany({ where: { userId }, select: { workspaceId: true } });
      const workspaceIds = memberships.map((m) => m.workspaceId);
      const ownerUsers = includeTeam && workspaceIds.length > 0
        ? await prisma.user.findMany({
          where: { memberships: { some: { workspaceId: { in: workspaceIds } } } },
          select: { id: true, name: true, email: true, avatarUrl: true },
        })
        : await prisma.user.findMany({
          where: { id: userId },
          select: { id: true, name: true, email: true, avatarUrl: true },
        });
      const ownersById = new Map(ownerUsers.map((owner) => [owner.id, owner]));
      const workers = (await listWorkersWithPresence()).filter((w) => ownersById.has(w.ownerUserId));
      const enriched = await Promise.all(
        workers.map(async (w) => {
          const owner = ownersById.get(w.ownerUserId) ?? null;
          const activeTasks = (
            await Promise.all(
              w.activeTaskIds.map(async (taskId) => {
                const task = await prisma.task.findFirst({
                  where: { id: taskId },
                  select: { id: true, title: true, workspaceId: true, cardStatus: true },
                });
                if (!task || !(await workspaces.isMember(userId, task.workspaceId))) return null;
                return task;
              }),
            )
          ).filter((task) => task !== null);
          const activeTaskIds = activeTasks.map((task) => task.id);
          return {
            workerId: w.workerId,
            ownerUserId: w.ownerUserId,
            owner: owner ? { id: owner.id, name: owner.name, email: owner.email, avatarUrl: owner.avatarUrl } : null,
            live: w.live,
            connectedAt: w.connectedAt,
            gitHash: w.gitHash,
            currentTask: activeTasks[0] ?? null,
            activeTasks,
            currentTaskId: activeTaskIds[0] ?? null,
            activeTaskIds,
            activeTaskCount: activeTaskIds.length,
            idle: activeTaskIds.length === 0,
          };
        }),
      );
      const serverGitHash = await getGitHash();
      return c.json({ workers: enriched, serverGitHash });
    });

    app.post("/api/workers/:workerId/update", requireAuth(auth.sessions), (c) => {
      const userId = c.get("userId");
      const workerId = c.req.param("workerId");
      const ok = requestWorkerUpdate(workerId, userId);
      if (!ok) return c.json({ error: "Worker not found" }, 404);
      return c.json({ ok: true });
    });

    // Live cloud (Daytona) sandboxes — the boxes running cloud-venue tasks, with
    // state + age so the worker popup can show "alive for Xm" and link into the
    // task. Workspace-scoped by label + membership (no cross-tenant leak). Daytona
    // not configured / unreachable → empty (best-effort, never 500s the popup).
    app.get("/api/sandboxes", requireAuth(auth.sessions), async (c) => {
      const userId = c.get("userId");
      let boxes;
      try {
        boxes = await getSandboxes().listByLabel({ app: "manta" });
      } catch {
        return c.json({ sandboxes: [] });
      }
      const enriched = await Promise.all(
        boxes.filter(isVisibleSandbox).map(async (b) => {
          const taskId = b.labels["task"];
          const workspaceId = b.labels["workspace"];
          if (!taskId || !workspaceId || !(await workspaces.isMember(userId, workspaceId))) return null;
          const task = await prisma.task.findFirst({
            where: { id: taskId },
            select: { id: true, title: true, cardStatus: true, venueStatus: true },
          });
          return { id: b.id, taskId, workspaceId, state: b.state ?? null, createdAt: b.createdAt ?? null, task };
        }),
      );
      return c.json({ sandboxes: enriched.filter((s) => s !== null) });
    });

    // Manually stop a task's cloud sandbox (the popup's stop button). Membership-
    // checked; stopCloudSandbox stops the box(es) + revokes the token.
    app.post("/api/sandboxes/stop", requireAuth(auth.sessions), async (c) => {
      const userId = c.get("userId");
      const body = (await c.req.json().catch(() => ({}))) as { taskId?: string; workspaceId?: string };
      if (!body.taskId || !body.workspaceId) return c.json({ error: "taskId and workspaceId required" }, 400);
      if (!(await workspaces.isMember(userId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
      // Membership alone isn't enough: stopCloudSandbox revokes the credential by
      // taskId (not workspace-scoped), so a member could revoke another tenant's
      // sandbox by pairing their own workspaceId with a foreign taskId. Verify the
      // task actually lives in this workspace first.
      const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
      if (!task) return c.json({ error: "not_found" }, 404);
      await stopCloudSandbox({ id: body.taskId, workspaceId: body.workspaceId });
      return c.json({ ok: true });
    });

    // Manually REMOVE (delete) a task's cloud sandbox — full cleanup from the
    // popup, vs. stop which leaves it wakeable. Same workspace-scoped task check.
    app.post("/api/sandboxes/remove", requireAuth(auth.sessions), async (c) => {
      const userId = c.get("userId");
      const body = (await c.req.json().catch(() => ({}))) as { taskId?: string; workspaceId?: string };
      if (!body.taskId || !body.workspaceId) return c.json({ error: "taskId and workspaceId required" }, 400);
      if (!(await workspaces.isMember(userId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
      const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
      if (!task) return c.json({ error: "not_found" }, 404);
      const ok = await removeCloudSandbox({ id: body.taskId, workspaceId: body.workspaceId });
      // 502 if a box couldn't be deleted (still billing) so the UI surfaces it.
      return ok ? c.json({ ok }) : c.json({ ok, error: "delete_failed" }, 502);
    });

    // Wake an asleep cloud sandbox WITHOUT running a turn (the terminal pane's
    // "resume" affordance): the daemon reconnects and holds the worktree so the
    // terminal works again. An empty message means no agent turn is dispatched —
    // runCloudTask reattaches/wakes/creates as needed.
    app.post("/api/sandboxes/resume", requireAuth(auth.sessions), async (c) => {
      const userId = c.get("userId");
      const body = (await c.req.json().catch(() => ({}))) as { taskId?: string; workspaceId?: string };
      if (!body.taskId || !body.workspaceId) return c.json({ error: "taskId and workspaceId required" }, 400);
      if (!(await workspaces.isMember(userId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
      const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
      if (!task) return c.json({ error: "not_found" }, 404);
      if (task.archivedAt || task.cardStatus === "done" || task.cardStatus === "canceled") {
        return c.json({ error: "task_complete" }, 409); // reconciler would just reap it
      }
      // Resume must only WAKE an existing cloud sandbox, never migrate a task into
      // Daytona: runCloudTask would otherwise create a box (and flip workerVenue to
      // daytona) for a laptop/unstarted task. Require the task to already be a
      // daytona venue that isn't already live.
      if (task.workerVenue !== "daytona") return c.json({ error: "not_a_cloud_task" }, 409);
      if (task.venueStatus === "active" || task.venueStatus === "provisioning") {
        return c.json({ ok: true }); // already up / coming up — nothing to wake
      }
      void runCloudTask(task, ""); // fire-and-forget; the daemon dials back when up
      return c.json({ ok: true });
    });

    // Move a cloud (Daytona) task back onto the owner's laptop daemon — the popup's
    // "Move to local" button. Stops the cloud sandbox (revokes its token, frees
    // billing) and re-dispatches the task to the laptop venue, re-running the
    // original request there. Laptop-only: we pre-check that the owner has a
    // connected worker so we can 409 cleanly, and spawnWorker(forceLaptop) makes a
    // dispatch race land in Needs Help instead of bouncing back to a fresh box.
    app.post("/api/sandboxes/move-to-local", requireAuth(auth.sessions), async (c) => {
      const userId = c.get("userId");
      const body = (await c.req.json().catch(() => ({}))) as { taskId?: string; workspaceId?: string };
      if (!body.taskId || !body.workspaceId) return c.json({ error: "taskId and workspaceId required" }, 400);
      if (!(await workspaces.isMember(userId, body.workspaceId))) return c.json({ error: "forbidden" }, 403);
      const task = await tasks.get({ workspaceId: body.workspaceId }, body.taskId);
      if (!task) return c.json({ error: "not_found" }, 404);
      if (task.archivedAt || task.cardStatus === "done" || task.cardStatus === "canceled") {
        return c.json({ error: "task_complete" }, 409);
      }
      if (task.workerVenue !== "daytona") return c.json({ error: "not_a_cloud_task" }, 409);
      // The task routes to its creator's laptop daemon; ownerless (automation) tasks
      // have no laptop to move to, and we won't migrate to a worker that isn't there.
      if (!task.createdBy) return c.json({ error: "no_owner" }, 409);
      if (availableWorkerCount(task.createdBy) <= 0) return c.json({ error: "no_local_worker" }, 409);
      // Re-run the original request (the first user message) on the laptop, not the
      // short card title — the title is a summary and may drop the detail the worker
      // needs. Fall back to the title if there's somehow no user message.
      const firstUserMsg = await prisma.message.findFirst({
        where: { workspaceId: body.workspaceId, channel: task.id, role: "user" },
        orderBy: { seq: "asc" },
        select: { content: true },
      });
      const message = firstUserMsg?.content?.trim() || task.title;
      // Only hand the task to a laptop worker once the cloud box is confirmed
      // stopped — otherwise a stop failure would leave the Daytona worker alive
      // AND start a laptop worker on the same task/branch (two venues, racing
      // pushes). Bail with 502 so the user can retry or stop it manually.
      const stopped = await stopCloudSandbox({ id: task.id, workspaceId: body.workspaceId });
      if (!stopped) return c.json({ error: "stop_failed" }, 502);
      spawnWorker(task, message, { messageAlreadyPersisted: true, forceLaptop: true });
      return c.json({ ok: true });
    });

    // Direct-terminal endpoint discovery. If the worker holding this task's
    // worktree exposes a loopback port, mint a short-lived token, tell the worker
    // to accept it (terminal_grant), and hand the browser a direct ws://127.0.0.1
    // target. A same-machine browser then connects straight to the worker (no
    // server hop); otherwise (no port, or the connect fails) it falls back to the
    // /terminal relay. The token is an opaque nonce the worker string-matches — no
    // shared signing secret leaves the server.
    app.get("/api/tasks/:taskId/terminal-endpoint", requireAuth(auth.sessions), async (c) => {
      const userId = c.get("userId");
      const taskId = c.req.param("taskId");
      const workspaceId = c.req.query("workspaceId");
      const terminalId = c.req.query("terminalId") || "default";
      if (!workspaceId || !(await workspaces.isMember(userId, workspaceId))) {
        return c.json({ error: "not_a_member" }, 403);
      }
      const task = await tasks.get({ workspaceId }, taskId);
      if (!task) return c.json({ error: "not_found" }, 404);

      if (task.workerVenue !== "daytona" && !task.archivedAt && !getTaskWorkerSend(taskId)) {
        reconnectTaskHome(task.id, task.createdBy);
      }
      const info = getTaskWorkerInfo(taskId);
      const send = getTaskWorkerSend(taskId);
      if (!info || info.terminalPort == null || !send) return c.json({ direct: null });

      const token = randomBytes(32).toString("hex");
      const exp = deps.now().getTime() + 60_000;
      send({ type: "terminal_grant", taskId, terminalId, token, exp });
      return c.json({ direct: { host: "127.0.0.1", port: info.terminalPort, token }, exp });
    });

    // Reconnect a local task terminal without starting a worker turn. If the
    // owner's daemon is online again, bind this task's terminal routing to it;
    // the daemon resolves the actual worktree from its remembered/on-disk state
    // when the terminal opens.
    app.post("/api/tasks/:taskId/reconnect-terminal", requireAuth(auth.sessions), async (c) => {
      const userId = c.get("userId");
      const taskId = c.req.param("taskId");
      const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string };
      if (!body.workspaceId || !(await workspaces.isMember(userId, body.workspaceId))) {
        return c.json({ error: "not_a_member" }, 403);
      }
      const task = await tasks.get({ workspaceId: body.workspaceId }, taskId);
      if (!task) return c.json({ error: "not_found" }, 404);
      if (task.workerVenue === "daytona") return c.json({ error: "use_resume_sandbox" }, 409);
      if (task.archivedAt) return c.json({ error: "task_archived" }, 409);
      if (!reconnectTaskHome(task.id, task.createdBy)) return c.json({ error: "no_local_worker" }, 409);
      return c.json({ ok: true });
    });
  }

  if (deps.slack) {
    app.route("/api/slack", createSlackRoutes(deps.slack));
  }

  // Linear integration: per-workspace bring-your-own-app OAuth + webhook ingress.
  // The /setup admin route is auth-gated; pass sessions when auth is configured.
  app.route(
    "/api/linear",
    createLinearRoutes({
      sessions: deps.auth?.sessions,
      webAppUrl: deps.auth?.webAppUrl ?? "http://localhost:5173",
      secureCookies: deps.auth?.secureCookies ?? false,
      ...(deps.brain
        ? {
            brain: {
              brainBackend: deps.brain.brainBackend,
              brainBackendId: deps.brain.brainBackendId,
              brainTools: deps.brain.brainTools,
              defaultBrainPrompt: deps.brain.defaultBrainPrompt,
            },
          }
        : {}),
    }),
  );

  app.route(
    "/api/notion",
    createNotionRoutes({
      sessions: deps.auth?.sessions,
      webAppUrl: deps.auth?.webAppUrl ?? "http://localhost:5173",
      secureCookies: deps.auth?.secureCookies ?? false,
    }),
  );

  // Worker daemon HTTP API (authenticated with a per-user worker token).
  app.route("/api/worker", createWorkerRoutes(deps.brain ? { brain: deps.brain } : undefined));

  // TODO(Phase 2+): mount kanban, chat, webhook, ws route modules here.

  // Serve the built web SPA last so it never shadows /api, /ws, or worker routes
  // (those match above and return first). Real asset requests are served from
  // disk; any other non-API GET falls back to index.html so client-side routes
  // resolve on a hard refresh.
  if (deps.webRoot) {
    const root = deps.webRoot;
    // Cache policy that survives rolling deploys: the HTML entry point and the
    // service worker must never be cached (always revalidate) so a client always
    // discovers the *current* content-hashed asset names. The hashed assets
    // themselves (/assets/index-XXXX.js) are immutable — their name changes on
    // every content change — so they can be cached forever. Without this, a
    // client holding a stale index.html requests an old bundle that no longer
    // exists in the freshly deployed container and gets a 404.
    const setCacheHeaders = (_path: string, c: Context) => {
      const reqPath = c.req.path;
      if (reqPath.startsWith("/assets/")) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        // index.html, sw.js, manifest, icons, etc.: revalidate every time.
        c.header("Cache-Control", "no-cache");
      }
    };
    app.use("*", serveStatic({ root, onFound: setCacheHeaders }));
    app.notFound(async (c) => {
      // SPA fallback for client-side routes only: a GET that isn't /api and
      // doesn't look like a file request (no extension in the last segment).
      // A missing asset (e.g. /assets/x.js) then 404s instead of silently
      // returning index.html with a 200.
      const path = c.req.path;
      const looksLikeFile = path.lastIndexOf(".") > path.lastIndexOf("/");
      if (c.req.method === "GET" && !path.startsWith("/api") && !looksLikeFile) {
        const res = await serveStatic({ root, path: "index.html", onFound: setCacheHeaders })(c, async () => undefined);
        if (res) return res;
      }
      return c.json({ error: "not_found" }, 404);
    });
  }

  return app;
}
