// Cloud worker venue — runs a task's coding work in an isolated Daytona sandbox
// instead of on a developer's laptop or (the now-removed) in-process bot.
//
// The sandbox boots the SAME worker-daemon as the laptop path, in single-task
// mode: we mint a per-task token, inject it + the task payload via env, vend the
// workspace's Pi credentials into the box, and launch the daemon. It dials back
// to /worker-ws exactly like a laptop daemon (live event streaming, follow-up
// turns) — see worker/payload.ts and apps/worker-daemon single-task mode.
//
// Ownership/reattach mirrors the sandbox service: sandboxes are labelled by workspace+task,
// so the control plane stays stateless and can rediscover live boxes by label
// after an ECS roll (listByLabel). Daytona is the source of truth, not memory.

import type { Task } from "@manta/db";
import { prisma, tasks, repos, sandboxCredentials } from "@manta/db";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { bus, kanbanTopic } from "../bus.ts";
import { noteOnCard } from "../notices.ts";
import { getSandboxes } from "../sandbox/factory.ts";
import { getTaskAuthBlob, resolveCloudTaskBackend } from "../models/service.ts";
import { mintInstallationToken, isConfigured as githubAppConfigured } from "../github/app.ts";
import { forwardToTaskWorker } from "./registry.ts";
import { buildTaskPayload } from "./payload.ts";
import { appendSandboxLog, clearSandboxLog } from "./sandboxLog.ts";

const logger = createLogger("Manta:CloudWorker");

// Follow-up turns that arrive while a sandbox is still provisioning (its daemon
// not yet connected) are queued here and flushed when the daemon registers (see
// drainSandboxRuns, called from ws.ts), so a fast second message isn't dropped.
const pendingSandboxRuns = new Map<string, unknown[]>();

function queueSandboxRun(taskId: string, runMsg: unknown): void {
  const q = pendingSandboxRuns.get(taskId) ?? [];
  q.push(runMsg);
  pendingSandboxRuns.set(taskId, q);
}

/** Remove a single queued run by identity (not the whole queue) — used to undo a
 * specific enqueue (e.g. a failed wake) without dropping other follow-ups that
 * raced into the same task's queue. */
function dequeueSandboxRun(taskId: string, runMsg: unknown): void {
  const q = pendingSandboxRuns.get(taskId);
  if (!q) return;
  const i = q.indexOf(runMsg);
  if (i >= 0) q.splice(i, 1);
  if (q.length === 0) pendingSandboxRuns.delete(taskId);
}

/** Take (and clear) any run_task messages queued for a task while its sandbox was
 * provisioning. Called once the sandbox's daemon registers. */
export function drainSandboxRuns(taskId: string): unknown[] {
  const q = pendingSandboxRuns.get(taskId);
  if (q) pendingSandboxRuns.delete(taskId);
  return q ?? [];
}

// Contract with the manta-sandbox image (see docker/manta-sandbox/). Built on
// the base-sandbox base, it runs as user `ubuntu`; its entrypoint keeps the
// box alive, and the server launches the daemon via START_CMD once credentials
// are vended into place.
const SANDBOX_HOME = "/home/ubuntu";
// The pi SDK reads credentials from getAgentDir()/auth.json = ~/.pi/agent/auth.json
// (NOT ~/.pi/auth.json) — vend there or the agent runs with empty auth.
const PI_AUTH_DIR = `${SANDBOX_HOME}/.pi/agent`;
const PI_AUTH_PATH = `${PI_AUTH_DIR}/auth.json`;
const GIT_CREDENTIALS_PATH = `${SANDBOX_HOME}/.git-credentials`;
const START_CMD = "/opt/manta/start-sandbox-worker";

function sandboxLabels(task: Task): Record<string, string> {
  return { app: "manta", workspace: task.workspaceId, task: task.id };
}

function shouldRunSetupCommands(task: Pick<Task, "backgroundMode">): boolean {
  return task.backgroundMode !== "scheduled_slack";
}

/** Env injected into the sandbox at create. The single-task daemon reads these
 * (MANTA_SANDBOX_TOKEN gates single-task mode) and self-starts on connect. */
async function buildSandboxEnv(task: Task, token: string, message: string, setupCommands?: string): Promise<Record<string, string>> {
  const payload = { ...(await buildTaskPayload(task, { setupCommands })), workspaceId: task.workspaceId };
  return {
    MANTA_SERVER_URL: config.publicWsUrl(),
    MANTA_SANDBOX_TOKEN: token,
    MANTA_TASK: JSON.stringify(payload),
    MANTA_TASK_MESSAGE: message,
    WORKER_ID: `sandbox-${task.id}`,
    // Warm repo clones baked into the image — the daemon builds worktrees off
    // these (fetched first) instead of cloning fresh. See config.sandboxSeedRepos.
    MANTA_SEED_REPOS: config.sandboxSeedRepos(),
    // Capture the Claude Code SDK's own stderr in cloud boxes. The pi-claude-bridge
    // otherwise swallows Claude Code's internal view ("CC's internal view of the
    // world is invisible to us"), so a stalled turn surfaces only as an opaque
    // "stream idle timeout after 90s with no assistant/tool output" — with no way
    // to tell a model-availability/quota stall from a real hang. With this on, the
    // bridge tees CC's stderr + a per-query debug log to
    // ~/.pi/agent/claude-bridge.log (and cc-cli-logs/) for post-mortem diagnosis.
    CLAUDE_BRIDGE_DEBUG: "1",
    // Forward configured bootstrap secrets (e.g. the dotenvx key that decrypts a
    // seed repo's `.env.shared`) so in-box commands can decrypt team-shared
    // secrets like SHARED_SENTRY_TOKEN. Spread last, but these are distinct names
    // from the keys above so nothing here overwrites them. See config.sandboxForwardEnv.
    ...config.sandboxForwardEnv(),
  };
}

/** The org/repo of every seed clone — the server vends a git token for each so
 * the daemon can fetch/push them (the boot pull + worktree provisioning). */
function seedRepoSlugs(): string[] {
  return config
    .sandboxSeedRepos()
    .split(",")
    .map((pair) => pair.split("=")[0]?.trim())
    .filter((s): s is string => Boolean(s));
}

/** Vend the workspace's credentials into a sandbox: Pi auth (so the in-box
 * backend runs on the workspace subscription) + GitHub tokens in
 * a git credential store (image sets credential.useHttpPath=true → matched per
 * repo path) for each seed repo (boot `git pull` + worktree fetches) and the
 * task's target repo (clone + push). PR creation itself goes through the server
 * so it can use the card creator's linked GitHub account without exposing that
 * broader OAuth token to the sandbox.
 *
 * Re-run on every (re)launch, including wake: the GitHub tokens are short-lived
 * (~1h) so a box stopped longer than that needs fresh ones, and the workspace's
 * Pi credential may have rotated. A 15-min in-life refresh is a follow-up (P3). */
async function vendSandboxCredentials(
  sandboxes: ReturnType<typeof getSandboxes>,
  sandboxId: string,
  task: Task,
): Promise<void> {
  const blob = await getTaskAuthBlob(task.workspaceId, task.createdBy, task.workerBackend);
  if (blob) {
    await sandboxes.exec(sandboxId, `mkdir -p ${PI_AUTH_DIR}`);
    await sandboxes.pushFile(sandboxId, PI_AUTH_PATH, JSON.stringify(blob), "600");
  } else {
    logger.warn("no workspace Pi credentials to vend — sandbox will rely on image defaults", { taskId: task.id });
  }

  if (githubAppConfigured()) {
    const lines: string[] = [];
    for (const repoSlug of new Set([...seedRepoSlugs(), task.repo])) {
      const tok = await mintInstallationToken(repoSlug).catch((err) => {
        logger.warn("mint github token for sandbox failed", { taskId: task.id, repoSlug, err });
        return null;
      });
      // Store BOTH the bare and `.git`-suffixed URL. The image's gitconfig sets
      // credential.useHttpPath=true so git matches the stored entry's path
      // EXACTLY — and the daemon clones `https://github.com/<repo>.git`, whose
      // path (`<repo>.git`) doesn't match a bare `<repo>` entry. Without the
      // `.git` line the clone falls through to a username prompt and dies with
      // "could not read Username for '…/<repo>.git': terminal prompts disabled".
      if (tok) {
        lines.push(`https://x-access-token:${tok}@github.com/${repoSlug}`);
        lines.push(`https://x-access-token:${tok}@github.com/${repoSlug}.git`);
      }
    }
    if (lines.length) {
      await sandboxes.pushFile(sandboxId, GIT_CREDENTIALS_PATH, lines.join("\n") + "\n", "600");
    }
  }
}

/** Wake a stopped sandbox in place rather than recreating it: start the box,
 * vend fresh credentials, mint a fresh single-task token (the old one was revoked
 * on spindown), and relaunch the daemon in RESUME mode so it waits for the
 * forwarded message instead of replaying the box's original env message. The
 * fresh token + resume flag are injected as command-line env overrides since the
 * box's baked env still holds the stale values. The follow-up `runMsg` (built by
 * the caller so it can undo this exact enqueue on failure) is queued and flushed
 * to the daemon when it re-registers (drainSandboxRuns). Throws on failure so the
 * caller can fall back to a fresh create. */
async function wakeCloudSandbox(
  sandboxes: ReturnType<typeof getSandboxes>,
  sandboxId: string,
  task: Task,
  runMsg: unknown | null,
): Promise<void> {
  const scope = { workspaceId: task.workspaceId };
  await sandboxes.start(sandboxId);
  await tasks.setWorker(scope, task.id, { sandboxId, venueStatus: "active", venueStoppedAt: null });
  bus.publish(kanbanTopic(task.workspaceId), {});
  await vendSandboxCredentials(sandboxes, sandboxId, task);
  const { token } = await sandboxCredentials.mint(task.id, task.workspaceId);

  // Queue the follow-up BEFORE launching so it's guaranteed in place before the
  // resumed daemon (resume mode → no self-start) can register and drain — a
  // post-launch queue could race the register and drop the message. If the launch
  // then throws, the caller dequeues this exact message before falling back to
  // create (so the create path's env self-start doesn't replay it). See runCloudTask.
  if (runMsg) queueSandboxRun(task.id, runMsg);

  // env-prefix the launcher with the fresh token + resume flag (the opaque msb_
  // token is shell-safe; the message never goes on the command line).
  const command = `env MANTA_SANDBOX_TOKEN=${token} MANTA_SANDBOX_RESUME=1 ${START_CMD}`;
  await sandboxes.streamLogs({
    id: sandboxId,
    command,
    onChunk: (chunk) => {
      appendSandboxLog(task.id, chunk);
      logger.debug("sandbox(wake)", { taskId: task.id, chunk: chunk.slice(0, 500) });
    },
    onClose: () => logger.info("sandbox launcher closed (wake)", { taskId: task.id }),
    onError: (err) => logger.warn("sandbox launcher error (wake)", { taskId: task.id, err }),
  });
  logger.info("woke stopped sandbox", { taskId: task.id, sandboxId });
}

/** Provision (or reattach) a Daytona sandbox for a task and run a turn in it.
 * Called by spawnWorker when no laptop daemon is available for the task's owner.
 * Returns once the sandbox is launched — the turn streams back over /worker-ws. */
export async function runCloudTask(task: Task, message: string): Promise<void> {
  const scope = { workspaceId: task.workspaceId };
  try {
    const resolvedBackend = await resolveCloudTaskBackend(task.workspaceId, task.createdBy, task.workerBackend);
    if (resolvedBackend.changed) {
      logger.warn("cloud task backend unavailable for vended credentials; switching to available backend", {
        taskId: task.id,
        requestedBackend: task.workerBackend,
        selectedBackend: resolvedBackend.backend,
        availableModelCount: resolvedBackend.availableModels.length,
      });
      await prisma.task.updateMany({
        where: { id: task.id, workspaceId: task.workspaceId },
        data: { workerBackend: resolvedBackend.backend },
      });
      task = { ...task, workerBackend: resolvedBackend.backend };
    }

    await tasks.setWorker(scope, task.id, {
      workerVenue: "daytona",
      venueStatus: "provisioning",
      venueStoppedAt: null,
      workerActive: true,
      workerStatus: "running",
    });
    bus.publish(kanbanTopic(task.workspaceId), {});

    const sandboxes = getSandboxes();
    const labels = sandboxLabels(task);
    const repo = shouldRunSetupCommands(task) ? await repos.byOrgRepo(scope, task.repo).catch(() => null) : null;

    // Reattach to a still-running box (e.g. after a server restart), or wake a
    // stopped one in place (after an idle-spindown / Daytona auto-stop). The box's
    // filesystem — worktree + git history + Pi session — survives a stop, so a
    // wake resumes far faster than a fresh clone; only if it's archived/deleted
    // (or the wake fails) do we provision fresh and resume off the pushed branch.
    const existing = await sandboxes.listByLabel(labels);
    const running = existing.find((s) => s.state === undefined || s.state === "started");
    if (running) {
      // A live sandbox already holds this task — its daemon is (re)connecting on
      // its own. Don't relaunch; just record the binding and mark it active.
      const id = running.id;
      await tasks.setWorker(scope, task.id, { sandboxId: id, venueStatus: "active" });
      bus.publish(kanbanTopic(task.workspaceId), {});
      // The daemon self-starts only the first (env) message, so this follow-up
      // would otherwise be lost. Forward it if the daemon is already connected,
      // else queue it to flush when it registers.
      if (message) {
        const runMsg = {
          type: "run_task",
          taskId: task.id,
          workspaceId: task.workspaceId,
          message,
          task: await buildTaskPayload(task, { setupCommands: repo?.setupCommands?.trim() || undefined }),
        };
        if (!forwardToTaskWorker(task.id, runMsg)) queueSandboxRun(task.id, runMsg);
      }
      logger.info("reattached to live sandbox", { taskId: task.id, sandboxId: id });
      return;
    }

    // A stopped box still holds this task's worktree + session — wake it in place.
    // If the wake fails (box archived/deleted, start error), fall through to a
    // fresh create, which resumes off the pushed branch + session blob anyway.
    const stopped = existing.find((s) => s.state === "stopped");
    if (stopped) {
      // Build the run message here so we hold its reference: on a wake failure we
      // can dequeue this exact message (not the whole queue, which may hold other
      // follow-ups that raced in for this task) before falling back to create.
      const runMsg = message
        ? {
            type: "run_task",
            taskId: task.id,
            workspaceId: task.workspaceId,
            message,
            task: await buildTaskPayload(task, { setupCommands: repo?.setupCommands?.trim() || undefined }),
          }
        : null;
      try {
        await wakeCloudSandbox(sandboxes, stopped.id, task, runMsg);
        return;
      } catch (err) {
        logger.warn("wake failed — provisioning fresh", { taskId: task.id, sandboxId: stopped.id, err });
        // Undo only this wake's enqueue: the fresh-create path below delivers this
        // message via the daemon's env self-start, so a leftover queued copy would
        // replay the same turn twice — but other queued follow-ups must survive.
        if (runMsg) dequeueSandboxRun(task.id, runMsg);
      }
    }

    // Fresh provision: mint the single-task token + build the env the daemon
    // self-starts from (only needed on this path — reattach/wake don't use it).
    const { token } = await sandboxCredentials.mint(task.id, task.workspaceId);
    const env = await buildSandboxEnv(task, token, message, repo?.setupCommands?.trim() || undefined);

    const snapshot = config.sandboxSnapshot();
    const created = await sandboxes.create({
      labels,
      env,
      ...(snapshot ? { snapshot } : {}),
      autoStopMinutes: config.sandboxAutoStopMinutes(),
      autoArchiveMinutes: config.sandboxAutoArchiveMinutes(),
      autoDeleteMinutes: config.sandboxAutoDeleteMinutes(),
    });
    await tasks.setWorker(scope, task.id, { sandboxId: created.id });
    logger.info("sandbox created", { taskId: task.id, sandboxId: created.id, snapshot: snapshot || "(base image)" });

    await vendSandboxCredentials(sandboxes, created.id, task);

    // Launch the single-task daemon. It connects back over /worker-ws and
    // self-starts the task; its agent events stream over that socket, not here —
    // we relay the launcher's stdout only for server-side visibility.
    await sandboxes.streamLogs({
      id: created.id,
      command: START_CMD,
      onChunk: (chunk) => {
        appendSandboxLog(task.id, chunk);
        logger.debug("sandbox", { taskId: task.id, chunk: chunk.slice(0, 500) });
      },
      onClose: () => logger.info("sandbox launcher closed", { taskId: task.id }),
      onError: (err) => logger.warn("sandbox launcher error", { taskId: task.id, err }),
    });

    await tasks.setWorker(scope, task.id, { venueStatus: "active" });
    bus.publish(kanbanTopic(task.workspaceId), {});
  } catch (err) {
    logger.error("cloud task failed", { taskId: task.id, err });
    // Tear down any half-provisioned sandbox and revoke its token so a failure
    // doesn't leave a live box billing or a usable credential behind. Then mark
    // failed (stopCloudSandbox would otherwise leave venueStatus "stopped").
    await stopCloudSandbox(task);
    await tasks.setWorker(scope, task.id, {
      workerActive: false,
      workerStatus: "failed",
      venueStatus: "failed",
    });
    await tasks
      .transition(scope, task.id, "needs_help", "worker", { reason: "Cloud worker failed to start" })
      .catch(() => {});
    // Persist the failure (with detail) so the card carries a record of why it
    // stalled — the bus event alone is live-only, leaving an empty transcript.
    const detail = err instanceof Error ? err.message : String(err);
    await noteOnCard(scope, task.id, `🚨 Cloud worker failed to start — moved to Needs Help.\n\n${detail}`);
    bus.publish(kanbanTopic(task.workspaceId), {});
  }
}

/** Stop a task's cloud sandbox and revoke its token. Used on idle-spindown,
 * task completion, and venue migration (laptop⇄daytona). Best-effort; never
 * throws. Leaves the branch on GitHub — the durable artifact survives.
 *
 * Returns true only if every box was actually stopped (or there were none). On a
 * stop failure we do NOT claim a clean stop: a lingering box is still running
 * (and billing), so we leave venueStatus `failed` and keep sandboxId so it stays
 * tracked for a retry — and callers migrating venues (move-to-local) can tell the
 * box is still alive and avoid starting a second worker on the same task. */
export async function stopCloudSandbox(task: Pick<Task, "id" | "workspaceId">): Promise<boolean> {
  const scope = { workspaceId: task.workspaceId };
  try {
    const sandboxes = getSandboxes();
    const live = await sandboxes.listByLabel({ app: "manta", workspace: task.workspaceId, task: task.id });
    const results = await Promise.allSettled(live.map((s) => sandboxes.stop(s.id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    results.forEach((r, i) => {
      if (r.status === "rejected") logger.warn("stop failed", { id: live[i]?.id, err: r.reason });
    });
    // Revoke regardless — even if a box lingers, neutralize its token.
    await sandboxCredentials.revokeForTask(task.id);

    if (failed > 0) {
      // Don't claim a clean stop: keep sandboxId, mark failed so the box stays
      // tracked for a retry rather than being reported gone while still billing.
      await tasks.setWorker(scope, task.id, { workerActive: false, venueStatus: "failed" });
      bus.publish(kanbanTopic(task.workspaceId), {});
      logger.warn("cloud sandbox stop incomplete — boxes remain", { taskId: task.id, failed, total: live.length });
      return false;
    }

    await tasks.setWorker(scope, task.id, {
      venueStatus: "stopped",
      venueStoppedAt: new Date(),
      workerActive: false,
      sandboxId: null,
    });
    clearSandboxLog(task.id); // box gone (or about to wake fresh) — drop stale output
    bus.publish(kanbanTopic(task.workspaceId), {});
    logger.info("cloud sandbox stopped", { taskId: task.id, count: live.length });
    return true;
  } catch (err) {
    logger.warn("stopCloudSandbox failed", { taskId: task.id, err });
    return false;
  }
}

/** Permanently DELETE a task's cloud sandbox(es) and revoke its token — full
 * cleanup, not a stoppable-then-wakeable stop. Used when the task is terminal
 * (done/canceled/archived) or on a manual "remove" from the worker popup, so the
 * box stops billing and disappears from the list instead of lingering as a
 * stopped box until Daytona's auto-delete. Best-effort; never throws. The branch
 * on GitHub is the durable artifact and is untouched.
 *
 * Returns true only if every box was actually deleted. On a delete failure we do
 * NOT mark the task cleanly stopped — a lingering box keeps billing, so we leave
 * venueStatus `failed` (and keep sandboxId) so it's still tracked for a retry (the
 * reconciler for terminal tasks, or the user clicking Remove again) instead of
 * silently reporting success. */
export async function removeCloudSandbox(task: Pick<Task, "id" | "workspaceId">): Promise<boolean> {
  const scope = { workspaceId: task.workspaceId };
  try {
    const sandboxes = getSandboxes();
    const live = await sandboxes.listByLabel({ app: "manta", workspace: task.workspaceId, task: task.id });
    const results = await Promise.allSettled(live.map((s) => sandboxes.delete(s.id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    results.forEach((r, i) => {
      if (r.status === "rejected") logger.warn("delete failed", { id: live[i]?.id, err: r.reason });
    });
    // Revoke regardless — even if a box lingers, neutralize its token.
    await sandboxCredentials.revokeForTask(task.id);

    if (failed > 0) {
      // Don't claim a clean removal: keep sandboxId, mark failed so the box stays
      // tracked for a retry rather than being reported gone while still billing.
      await tasks.setWorker(scope, task.id, { workerActive: false, venueStatus: "failed" });
      bus.publish(kanbanTopic(task.workspaceId), {});
      logger.warn("cloud sandbox removal incomplete — boxes remain", { taskId: task.id, failed, total: live.length });
      return false;
    }

    await tasks.setWorker(scope, task.id, {
      venueStatus: "stopped",
      venueStoppedAt: new Date(),
      workerActive: false,
      sandboxId: null,
    });
    clearSandboxLog(task.id);
    bus.publish(kanbanTopic(task.workspaceId), {});
    logger.info("cloud sandbox removed", { taskId: task.id, count: live.length });
    return true;
  } catch (err) {
    logger.warn("removeCloudSandbox failed", { taskId: task.id, err });
    return false;
  }
}
