// Production entrypoint. Starts the Hono app on Node. Guarded so importing this
// module in tests does not bind a port.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebClient } from "@slack/web-api";
import { PiBackend, pickBrainBackendId, ensureConfiguredPiExtensionsInstalled, setPiExtensionEnvDefaults } from "@manta/agent";
import { workspaceAuthStorage, saveWorkspaceAuth, brainBackendIdFor, reportBrainAuthFailure } from "./models/service.ts";
import { createApp } from "./app.ts";
import { createLogger } from "./logger.ts";
import { config } from "./config.ts";
import { buildAuthDeps } from "./auth/build.ts";
import { brainTaskTools, type SlackDriver } from "./brain/tools.ts";
import type { SlackDeps } from "./slack/index.ts";
import { spawnWorker } from "./worker/dispatch.ts";
import { acceptTaskMessage } from "./worker/taskMessages.ts";
import { setupWebSocket, gracefulShutdown } from "./ws.ts";
import { flushSnapshotsNow } from "./worker/snapshot.ts";
import { startPoller } from "./poller.ts";
import { startSandboxReconciler } from "./worker/reconciler.ts";
import { askWorkerQuestion } from "./worker/questions.ts";
import { loadUsHolidays } from "./slack/holidays.ts";

const DEFAULT_BRAIN_PROMPT =
  "You are Manta, an engineering orchestrator. You don't write code — you spawn and " +
  "monitor workers via your tools, and keep the engineer informed.\n\n" +
  "## Core Principle: The Kanban Is The Source Of Truth\n" +
  "The kanban board is what the engineer is working on. Bot cards are user-owned and sticky. " +
  "The user creates and curates kanban cards — you don't. Never spawn a replacement for a failed card; use resurrect_worker instead. " +
  "Don't chain work. When one task finishes, stop. Don't look for the next obvious step.\n\n" +
  "## Tools\n" +
  "Task management: create_task (spawn worker + ticket), list_tasks/get_task (inspect state), " +
  "check_worker (last messages + status), message_worker (nudge live worker), " +
  "resurrect_worker (revive stopped worker on same card), transition_status (move kanban card), " +
  "update_task (edit title/description/checklist), archive_task (soft-delete).\n" +
  "Questions: answer_question (repo, question) delegates a read-only agent run to a worker in a real checkout and returns an answer — use for code questions, no card. create_task is for CHANGING code.\n" +
  "Communication: reply_to_slack (post to a Slack channel or thread).\n" +
  "Linear: list_linear_teams (get teamId), list_linear_members (get assigneeId), list_linear_issues (read board), list_linear_view (enumerate a custom view by UUID), get_linear_issue (fetch by id/identifier), find_duplicate_linear_issue (verified duplicate lookup), create_linear_issue (create ticket, labels, optional assignee, Slack permalink), attach_slack_permalink_to_linear_issue, assign_linear_issue (handoff to engineer), comment_on_linear_issue (post status/results back to Linear), update_linear_issue (apply labels or move status).\n" +
  "Notion: read_notion_instructions (important workspace docs/guidance), search_notion, fetch_notion, create_notion_pages, update_notion_page, create_notion_comment. Read the Notion instructions before broad documentation work.\n" +
  "Memory: append_team_memory (record a durable fact — convention, decision, gotcha — that future brain sessions should know).\n\n" +
  "## Style\n" +
  "Always call get_task or check_worker before acting on a task. " +
  "If you mention a card you just created, quote only the exact fields returned by create_task (especially repo/title/id/taskNumber); never infer or restate the repo from memory. " +
  "Never ask 'would you like me to...' — just do it. Be direct and concise. " +
  "For support requests from Slack, follow channel-specific instructions when present. Triage with list_linear_teams → find_duplicate_linear_issue (only use verified same-issue matches) → create_linear_issue (after duplicate lookup, Slack support labels, including Bug/Support/On-call triage, are applied automatically and the Slack thread is attached) or attach_slack_permalink_to_linear_issue for an existing issue → reply_to_slack with the issue link; for bugs, start a worker to investigate/fix if possible, then assign the Linear issue to the most relevant engineer.";

export function start(port = config.port()): void {
  const logger = createLogger("Manta:Server");
  // Install Pi extensions (including the claude-bridge provider) so they're
  // ready if the brain is configured to use a Claude Code subscription model.
  setPiExtensionEnvDefaults();
  void ensureConfiguredPiExtensionsInstalled().catch((e) => logger.error("Pi extension install failed", { e }));
  const backgroundJobsEnabled = config.backgroundJobsEnabled();
  if (backgroundJobsEnabled) {
    void loadUsHolidays().catch((e) => logger.error("US holiday load failed", { e }));
  } else {
    logger.info("background cron jobs disabled", { env: process.env["NODE_ENV"] ?? "development" });
  }
  const auth = buildAuthDeps();
  const brainBackendId = pickBrainBackendId();
  logger.info("brain backend selected", { brainBackendId });
  // Linear tools resolve their per-workspace actor=app OAuth token from ctx at
  // call time (see brain/tools.ts), so no shared Linear driver is built here.

  // Delegate read-only repo questions to an online worker (any workspace member's
  // daemon), returning the answer to the brain — no Task/card. The daemon runs the
  // workspace's configured model (resolved here) with its own local Pi auth.
  const questionDriver = {
    ask: async (workspaceId: string, repo: string, question: string, onUpdate?: (text: string) => void) =>
      askWorkerQuestion({ workspaceId, repo, question, backendId: await brainBackendIdFor(workspaceId, brainBackendId) }, onUpdate),
  };

  // The brain runs in-server but credentials are per-workspace: resolveAuth loads
  // the workspace's stored Codex/API-key blob; onAuthChanged persists any OAuth
  // tokens Pi rotates mid-turn.
  // extensions: true loads the claude-bridge Pi provider (and others) so the
  // brain can use a Claude Code subscription model if the workspace selects one.
  // onAuthFailure blacklists a member's dead/exhausted subscription so the next
  // brain turn round-robins to a different one (or another provider).
  //
  // cwd must be writable: some extensions (pi-loop) store state under `<cwd>/.pi`,
  // and the prod container's WORKDIR (/app) is root-owned while the process runs
  // as `node` (→ EACCES mkdir '/app/.pi/tasks'). The brain has no worktree, so a
  // dedicated scratch dir is correct; workers already use their writable worktree.
  const brainCwd = join(tmpdir(), "manta-brain");
  mkdirSync(brainCwd, { recursive: true });
  const brainBackend = new PiBackend({
    cwd: brainCwd,
    extensions: true,
    resolveAuth: workspaceAuthStorage,
    onAuthChanged: saveWorkspaceAuth,
    onAuthFailure: reportBrainAuthFailure,
  });

  // Global brain tools for board chat / WS / poller. Slack posting here uses the
  // optional env-level token (legacy/board context); per-bot Slack turns use the
  // factory below instead.
  const globalSlackToken = config.slack().botToken;
  const globalSlackClient = globalSlackToken ? new WebClient(globalSlackToken) : null;
  const globalSlackDriver: SlackDriver | undefined = globalSlackClient
    ? { postMessage: async (ch, text, ts) => { await globalSlackClient.chat.postMessage({ channel: ch, text, ...(ts ? { thread_ts: ts } : {}) }); } }
    : undefined;

  const brain = {
    brainBackend,
    brainBackendId,
    brainTools: brainTaskTools({ worker: { spawnWorker, acceptTaskMessage }, slack: globalSlackDriver, question: questionDriver }),
    defaultBrainPrompt: DEFAULT_BRAIN_PROMPT,
  };

  // Per-bot Slack wiring: bind the brain tools to whichever bot's client is
  // handling the inbound event, so reply_to_slack/create_task use its token.
  const slackDeps: SlackDeps = {
    brainBackend,
    brainBackendId,
    defaultBrainPrompt: DEFAULT_BRAIN_PROMPT,
    brainToolsFactory: (slackDriver) =>
      brainTaskTools({ worker: { spawnWorker, acceptTaskMessage }, slack: slackDriver, question: questionDriver }),
  };

  const webRoot = config.webRoot() || undefined;
  const app = createApp({ auth, brain, slack: slackDeps, webRoot });
  const injectWebSocket = setupWebSocket(app, { sessions: auth.sessions, brain });
  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info("manta-server listening", { port: info.port, login: "/api/auth/google" });
  });
  // A port-bind failure at startup is fatal: another server already owns the
  // port. Exit instead of letting the catch-all uncaughtException handler keep a
  // half-initialized zombie alive (no HTTP listener, but a duplicate poller).
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error("port already in use — another server is running; exiting", { port });
      process.exit(1);
    }
    throw err;
  });
  injectWebSocket(server);
  if (backgroundJobsEnabled) {
    startPoller({ backend: brain.brainBackend, backendId: brain.brainBackendId, defaultBrainPrompt: DEFAULT_BRAIN_PROMPT, tools: brain.brainTools });
    // Sweep for cost-leaking sandboxes (running boxes whose task is terminal/gone).
    startSandboxReconciler();
  }

  // Graceful shutdown for zero-disruption deploys. ECS sends SIGTERM before
  // replacing the task; we ask connected workers to reconnect to the new process
  // (close 1001) instead of letting their sockets die with 1006 — which would
  // otherwise flip their in-flight tasks to needs_help. The worker daemons keep
  // running across the deploy, so their turns continue; the new process rebuilds
  // routing/presence from their re-register. A hard cap guarantees we never hang
  // the rollout if close/flush stalls.
  let shuttingDownProc = false;
  const shutdown = (signal: string): void => {
    if (shuttingDownProc) return;
    shuttingDownProc = true;
    logger.info(`${signal} received — graceful shutdown`);
    gracefulShutdown();
    const hardExit = setTimeout(() => process.exit(0), 3_000);
    hardExit.unref();
    void flushSnapshotsNow().finally(() => {
      server.close(() => {
        clearTimeout(hardExit);
        logger.info("server closed — exiting");
        process.exit(0);
      });
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only auto-start when run directly (node src/server.ts), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const logger = createLogger("Manta:Process");

  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException — continuing", { err });
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection — continuing", { reason });
  });

  start();
}
