#!/usr/bin/env node
// Manta worker daemon. Connects to a Manta server, registers as a worker, and
// runs coding tasks via the Pi agent on local git worktrees.
//
// Usage:
//   MANTA_SERVER_URL=wss://manta.example.com node --experimental-transform-types src/daemon.ts
//
// On first run with no stored credential, the daemon opens a browser to pair
// with your Manta account (one-time). The resulting per-user token is saved to
// ~/.manta/worker-credentials.json and reused on every subsequent start. Tasks
// you create route to your own daemon; everyone else's fall back to the bot.
//
// Environment variables:
//   MANTA_SERVER_URL  WebSocket URL of the Manta server (default: wss://manta.example.com)
//   WORKER_ID         Override the daemon's id (default: <username>-<hostname>, with
//                     a -N suffix if another daemon on this box already holds it)

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, openSync, closeSync, writeSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile, rm, rename } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  PiBackend,
  ProcessIsolatedPiBackend,
  defineTool,
  loginCodex,
  ensureConfiguredPiExtensionsInstalled,
  setPiExtensionEnvDefaults,
  authStorageFromBlob,
  usesClaudeBridgeBackend,
  type AgentBackend,
  type AuthBlob,
} from "@manta/agent";
import { getGitHash } from "@manta/shared/buildInfo";
import { runSetupCommands, formatSetupTranscript } from "@manta/shared/setup";
import { formatPrTitleWithLinearIssue } from "@manta/shared/prTitle";
import { createTerminalHost } from "./terminalHost.ts";
import {
  resolveProvisionTarget,
  taskIdCandidatesFromWorktreeName,
  worktreeDirSlug,
} from "./worktreeOwnership.ts";
import { gitRemoteMatchesRepo, isCorruptRepoError } from "./repoIdentity.ts";
import { turnAbandonDeadline, whenAborted } from "./wedgeWatchdog.ts";
import { isBranchAlreadyCheckedOutError } from "./worktreeGit.ts";
import { WORKER_SAFETY_INSTRUCTIONS } from "./workerSafety.ts";

const exec = promisify(execFile);

// Never let a git subprocess block on an interactive credential prompt. The
// daemon has no TTY, so a failed auth (expired token, missing helper) otherwise
// hangs the turn FOREVER on a "Username for 'https://github.com':" stdin read —
// invisible, no output, looks like the agent died (see manta-24). Process-wide so
// every git invocation inherits it: provisioning, pushes, and the agent's own
// `git` via the bash tool. Credential helpers still work; only the hang is gone —
// auth now fails fast with a real error.
process.env["GIT_TERMINAL_PROMPT"] = "0";

/** Bump this integer whenever the server protocol changes incompatibly. */
export const WORKER_VERSION = "20";

const SERVER_URL = (process.env["MANTA_SERVER_URL"] ?? "wss://manta.example.com").replace(/\/$/, "");
const SERVER_HTTP = SERVER_URL.replace(/^wss?/, (m) => m === "wss" ? "https" : "http");
const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const PR_TITLE_GUIDANCE =
  "Use a concise, implementation-focused title based on the actual changes (ideally 50-72 characters). " +
  "Do not reuse the raw card title when it is conversational, profane, a question, or truncated; never end with an unfinished word or ellipsis.";
/** Tool set for ephemeral questions. Includes `bash` so the investigator can
 * actually answer real questions — `git log` for history, `psql` for DB schema,
 * `jq`/`rg`/`wc` etc. — but NOT edit/write, keeping it read-only by intent. The
 * checkout is throwaway and detached, so the risk surface is the prompt's
 * read-only instruction, not the filesystem. */
const QUESTION_TOOLS = ["read", "bash", "grep", "find", "ls"];
// Ephemeral questions use the workspace's configured brain model. When that is
// a Codex-style model, it expects the extension-provided `exec_command` shell
// surface; without it the agent can only report "Exec is unavailable" and often
// returns no useful answer. Keep the extension surface tight so read-only
// question turns don't inherit write-capable tools such as `apply_patch`.
// Reasoning adjustment is safe for read-only turns and lets the question agent
// increase effort when investigation becomes more complex.
const QUESTION_EXTENSION_TOOLS = ["exec_command", "change_reasoning"];
// pi-loop's monitor/loop/task tools arm re-wakes on its scheduler, which only
// fires inside a persistent pi session. Worker turns are one-shot — runTurn ends
// at end_turn and nothing ever services a later wake — so a model that arms a
// monitor and ends its turn "waiting" stalls the card forever, and the orphaned
// wait wedges tool-result delivery for the follow-up turns too. Opus 4.8 reaches
// for MonitorCreate by name (it mirrors its native harness's Monitor tool), so
// hide the whole pi-loop surface from task turns.
const PERSISTENT_SESSION_EXTENSION_TOOLS = [
  "MonitorCreate", "MonitorList", "MonitorStop",
  "LoopCreate", "LoopList", "LoopDelete",
  "TaskCreate", "TaskList", "TaskUpdate", "TaskDelete",
];
const WORKTREE_ROOT = join(homedir(), ".manta", "worktrees");
/** Records which task owns each worktree dir (dirName -> taskId). Lets recovery
 * bind a worktree to its task by identity instead of parsing the dir name, which
 * is ambiguous (a name slug ending in hex can match a different task's id) and
 * could otherwise bind a card to a foreign worktree/branch. */
const WORKTREE_OWNERS_FILE = join(WORKTREE_ROOT, ".owners.json");
const REPO_CACHE_ROOT = join(homedir(), ".manta", "repos");
const DAY_MS = 24 * 60 * 60 * 1000;
const WORKTREE_CLEANUP_MAX_AGE_MS = 3 * DAY_MS;
const WORKTREE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SELF_UPDATE_GIT_TIMEOUT_MS = 2 * 60 * 1000;
/** Reused, read-only per-repo checkouts for answering questions (default branch). */
const QUESTIONS_ROOT = join(homedir(), ".manta", "questions");
const CRED_PATH = join(homedir(), ".manta", "worker-credentials.json");
const LOCK_DIR = join(homedir(), ".manta", "locks");

/** Strip anything that isn't safe in a filename / registry key. */
const sanitizeId = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64) || "worker";
const currentUser = (): string => { try { return userInfo().username; } catch { return "user"; } };

/** Stable per-(user, host) base id. Unlike the old hostname+pid id this is the
 * SAME across restarts, so the server treats a reconnect as the same worker (its
 * connId guard handles the takeover) instead of a brand-new daemon. A second live
 * daemon on the same box gets a `-N` suffix via the lockfile below. */
const WORKER_ID_BASE = sanitizeId(`${currentUser()}-${hostname()}`);
/** Resolved at startup by acquireWorkerSlot(); an explicit WORKER_ID env var
 * overrides it (and skips slot locking). */
let WORKER_ID = process.env["WORKER_ID"] ?? WORKER_ID_BASE;

/** Warm repo clones baked into a cloud sandbox image, as `repo=path` pairs (env
 * MANTA_SEED_REPOS, e.g. "acme/platform=/opt/repo-cache/platform"). Empty for
 * a laptop daemon. When a task's repo has a seed, the worktree is added off that
 * warm clone (fetched first — so a periodically-baked image still gets current
 * code) instead of cloning fresh. */
const SEED_REPOS: Record<string, string> = Object.fromEntries(
  (process.env["MANTA_SEED_REPOS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.includes("="))
    .map((pair) => [pair.slice(0, pair.indexOf("=")).trim(), pair.slice(pair.indexOf("=") + 1).trim()]),
);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Per-user token presented on connect; populated by bootstrap() before connecting. */
let WORKER_TOKEN = "";

/** Timestamped logging. The worker id is printed once at startup, so per-line we
 * show a wall-clock time (HH:MM:SS.mmm) instead — far more useful for diagnosing
 * connection drops than repeating the worker name on every line. Use LOCAL time:
 * the daemon runs on a developer's laptop, so logs are read against the local
 * clock (UTC here is a real foot-gun when correlating with what you just saw). */
const ts = (): string => {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
const wlog = (msg: string): void => console.log(`[${ts()}] ${msg}`);
const werr = (msg: string, ...rest: unknown[]): void => console.error(`[${ts()}] ${msg}`, ...rest);

/** Local session state across turns for a task. */
interface TaskState {
  worktreePath?: string;
  branch?: string;
  sessionKey?: string;
  skillExtensionPath?: string;
  skillPrompt?: string;
  skillReposKey?: string;
  // Set for exactly one turn after a wedged turn was abandoned: the most-recent
  // session in this worktree is the wedged one, so the next turn must start a
  // BRAND-NEW session rather than resume it. Cleared once a fresh session starts.
  avoidResumeAfterAbandon?: boolean;
}
const taskState = new Map<string, TaskState>();
const provisioningWorktrees = new Set<string>();
let worktreeCleanupInFlight: Promise<void> | null = null;
let selfUpdateCheckInFlight: Promise<void> | null = null;
let pendingServerUpdateReason: string | null = null;
// When the server asks an outdated-but-busy worker to update, retry on this
// cadence until the worker goes idle — rather than waiting for the daily 4am
// self-update window — so a new protocol version is picked up within minutes.
const SERVER_UPDATE_RETRY_MS = 5 * 60_000;
let serverUpdateRetryTimer: ReturnType<typeof setInterval> | undefined;


function isWithinDir(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function rootEntryForPath(root: string, path: string): string | undefined {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  if (!isWithinDir(absoluteRoot, absolutePath) || absoluteRoot === absolutePath) return undefined;
  const [entry] = relative(absoluteRoot, absolutePath).split(/[\\/]+/);
  return entry ? resolve(absoluteRoot, entry) : undefined;
}

function worktreesInUse(): Set<string> {
  const active = new Set<string>();
  const root = resolve(WORKTREE_ROOT);
  const activeTaskIds = new Set([...draining, ...pendingRuns.keys(), ...turnAborts.keys()]);
  for (const taskId of activeTaskIds) {
    const worktree = taskState.get(taskId)?.worktreePath;
    const entry = worktree ? rootEntryForPath(root, worktree) : undefined;
    if (entry) active.add(entry);
  }
  for (const worktree of provisioningWorktrees) {
    const entry = rootEntryForPath(root, worktree);
    if (entry) active.add(entry);
  }
  const cwdEntry = rootEntryForPath(root, process.cwd());
  if (cwdEntry) active.add(cwdEntry);
  return active;
}

async function cleanupOldWorktrees(now = Date.now()): Promise<void> {
  await mkdir(WORKTREE_ROOT, { recursive: true });
  const root = resolve(WORKTREE_ROOT);
  const active = worktreesInUse();
  const cutoff = now - WORKTREE_CLEANUP_MAX_AGE_MS;
  let removed = 0;

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (!isWithinDir(root, path) || active.has(path)) continue;
    if (path === resolve(WORKTREE_OWNERS_FILE)) continue; // not a worktree

    const info = await lstat(path).catch(() => null);
    if (!info || info.mtimeMs >= cutoff) continue;

    await rm(path, { recursive: true, force: true });
    removed++;
  }

  // Drop ownership entries whose worktree dir is gone, so the index doesn't grow
  // unbounded and a recycled dir name can't inherit a stale owner.
  const owners = readWorktreeOwners();
  let ownersChanged = false;
  for (const name of Object.keys(owners)) {
    if (!existsSync(join(root, name))) {
      delete owners[name];
      ownersChanged = true;
    }
  }
  if (ownersChanged) writeWorktreeOwners(owners);

  if (removed > 0) wlog(`cleaned up ${removed} worktree entr${removed === 1 ? "y" : "ies"} older than 3 days`);
}

function runWorktreeCleanup(reason: string): void {
  if (worktreeCleanupInFlight) return;
  worktreeCleanupInFlight = cleanupOldWorktrees()
    .catch((err: unknown) => werr(`worktree cleanup (${reason}) failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => { worktreeCleanupInFlight = null; });
}

function startWorktreeCleanup(): void {
  runWorktreeCleanup("startup");
  const timer = setInterval(() => runWorktreeCleanup("periodic"), WORKTREE_CLEANUP_INTERVAL_MS);
  timer.unref?.();
}

// ── Terminal hosting ─────────────────────────────────────────────────────────
// The PTY for a task lives HERE, next to the worktree — not on the server. Two
// transports reach it: frames relayed over the existing /worker-ws socket (works
// everywhere, incl. cloud), and a direct loopback WebSocket for a browser on the
// SAME machine (no server hop).
/** The worktree dir's name under WORKTREE_ROOT (the ownership-index key), or
 * undefined when the path isn't a direct child of the root. */
function worktreeDirName(worktree: string): string | undefined {
  const root = resolve(WORKTREE_ROOT);
  const entry = rootEntryForPath(root, worktree);
  if (!entry) return undefined;
  const name = relative(root, entry);
  return name && !name.includes("/") && !name.includes("\\") ? name : undefined;
}

function readWorktreeOwners(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(WORKTREE_OWNERS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeWorktreeOwners(owners: Record<string, string>): void {
  try {
    mkdirSync(WORKTREE_ROOT, { recursive: true });
    writeFileSync(WORKTREE_OWNERS_FILE, JSON.stringify(owners, null, 2));
  } catch (err) {
    werr("failed to persist worktree owners:", err instanceof Error ? err.message : String(err));
  }
}

/** Record that `taskId` owns `worktree`. The daemon is single-process, so the
 * synchronous read-modify-write is race-free within a daemon. */
function setWorktreeOwner(worktree: string, taskId: string): void {
  const name = worktreeDirName(worktree);
  if (!name) return;
  const owners = readWorktreeOwners();
  if (owners[name] === taskId) return;
  owners[name] = taskId;
  writeWorktreeOwners(owners);
}

/** The task that owns the worktree dir named `name`, per the ownership index. */
function getWorktreeOwner(name: string): string | undefined {
  return readWorktreeOwners()[name];
}

function rememberWorktree(taskId: string, worktreePath: string): void {
  const existing = taskState.get(taskId) ?? {};
  if (existing.worktreePath && existsSync(existing.worktreePath)) return;
  taskState.set(taskId, { ...existing, worktreePath });
}

function recoverTaskStateFromDisk(): void {
  if (!existsSync(WORKTREE_ROOT)) return;
  try {
    const owners = readWorktreeOwners();
    for (const entry of readdirSync(WORKTREE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const worktreePath = join(WORKTREE_ROOT, entry.name);
      // Prefer the recorded owner — unambiguous, binds the worktree to exactly
      // the task that provisioned it.
      const owner = owners[entry.name];
      if (owner) {
        rememberWorktree(owner, worktreePath);
        continue;
      }
      // Back-compat for dirs created before ownership stamping: fall back to the
      // (ambiguous) name parse. These age out under the 3-day cleanup.
      for (const taskId of taskIdCandidatesFromWorktreeName(entry.name)) {
        rememberWorktree(taskId, worktreePath);
      }
    }
  } catch (err) {
    werr("failed to recover held worktrees:", err instanceof Error ? err.message : err);
  }
}

function getTaskWorktree(taskId: string): string | undefined {
  const known = taskState.get(taskId)?.worktreePath;
  if (known && existsSync(known)) return known;
  recoverTaskStateFromDisk();
  const recovered = taskState.get(taskId)?.worktreePath;
  return recovered && existsSync(recovered) ? recovered : undefined;
}

const terminalHost = createTerminalHost({
  getWorktree: getTaskWorktree,
  log: wlog,
  error: werr,
});

/** Task ids whose worktree this daemon still holds on disk. Sent on register so
 * the server can rebuild terminal routing after a deploy/daemon restart without
 * re-dispatching. */
function heldTaskIds(): string[] {
  recoverTaskStateFromDisk();
  const ids: string[] = [];
  for (const [taskId, state] of taskState) {
    if (state.worktreePath && existsSync(state.worktreePath)) ids.push(taskId);
  }
  return ids;
}

/** Per-task turn serialization with abort-and-coalesce. A new run_task while a turn
 * is in flight aborts that turn (so the user isn't stuck waiting) but is NOT
 * dropped: it's queued and folded into the next turn, so every message a user sends
 * reaches the agent. Turns never overlap — concurrent turns would open two Pi
 * sessions on one worktree + session JSONL and wedge both (symptom: the UI sits on
 * "working…" forever).
 *
 * `turnAborts` holds the controller of the turn running now; `pendingRuns` holds the
 * messages waiting to be folded into the next turn; `draining` marks tasks with an
 * active drain loop (exactly one per task) so concurrent messages only enqueue. */
const turnAborts = new Map<string, AbortController>();
const pendingRuns = new Map<string, RunTaskMsg[]>();
const draining = new Set<string>();

/** After a new message aborts the running turn, how long we wait for that turn to
 * actually unwind before giving up on it. A healthy turn honors the abort signal
 * within a second or two; one that never returns is WEDGED (e.g. a hung subprocess
 * a plain abort can't kill, or a session-resume that never yields after a socket
 * blip). Past this grace we ABANDON the wedged turn — leave it running orphaned in
 * the background and move the single per-task drain loop on to the queued message
 * with a fresh session — so a re-dispatch (the user reopening the card or chatting)
 * can actually take over instead of queueing behind a turn that will never finish.
 *
 * Claude-bridge turns run in disposable child processes, so aborting one kills
 * its whole process tree instead of leaving bridge or Claude CLI state behind.
 *
 * See wedgeWatchdog.ts for the abandon logic (turnAbandonDeadline). */
const TURN_ABORT_GRACE_MS = 20_000;

/** A turn that streams NO events for this long is treated as WEDGED and abandoned
 * even without a new message to abort it — the SILENT-wedge case the abort-grace
 * path never caught (e.g. an over-context model call that can't proceed, or a
 * subagent that never returns, leaving the UI on "working…" forever). Generous by
 * default so a legitimately long-quiet tool (a big test run, a slow subagent)
 * isn't killed mid-flight; override with MANTA_STUCK_TURN_MS, 0 to disable. */
const STUCK_TURN_MS = Number(process.env["MANTA_STUCK_TURN_MS"] ?? 20 * 60_000);

/** How long an `ask_user_question` prompt waits for a human before the tool gives
 * the turn control back. Waiting suspends the inactivity watchdog (a blocked turn
 * is not a wedged one), so this is what keeps an unanswered question from pinning
 * the task's drain loop forever. Generous — a question asked at 5pm should still
 * be answerable the next morning. */
const USER_QUESTION_TIMEOUT_MS = Number(process.env["MANTA_USER_QUESTION_TIMEOUT_MS"] ?? 18 * 60 * 60_000);

const taskDisposals = new Set<string>();
const activeQuestions = new Set<string>();

/** taskId → number of `ask_user_question` prompts awaiting a human answer.
 *
 * A turn parked on one streams NO events — by design, it is blocked on a person,
 * not broken. Without this the inactivity watchdog above counted that silence as
 * a wedge and killed a perfectly healthy turn ~20 minutes after it asked, which
 * both lost the question and left the card looking stuck. */
const awaitingUserAnswer = new Map<string, number>();

function taskAwaitingUserAnswer(taskId: string): boolean {
  return (awaitingUserAnswer.get(taskId) ?? 0) > 0;
}

function beginAwaitingUserAnswer(taskId: string): void {
  awaitingUserAnswer.set(taskId, (awaitingUserAnswer.get(taskId) ?? 0) + 1);
}

function endAwaitingUserAnswer(taskId: string): void {
  const next = (awaitingUserAnswer.get(taskId) ?? 0) - 1;
  if (next > 0) awaitingUserAnswer.set(taskId, next);
  else awaitingUserAnswer.delete(taskId);
}

async function cleanupTaskNodeModules(taskId: string): Promise<void> {
  const worktree = taskState.get(taskId)?.worktreePath;
  if (!worktree) return;

  const root = resolve(WORKTREE_ROOT);
  const worktreeRoot = rootEntryForPath(root, worktree);
  if (!worktreeRoot) return;
  if (rootEntryForPath(root, process.cwd()) === worktreeRoot) return;

  const nodeModules = resolve(worktreeRoot, "node_modules");
  if (!isWithinDir(worktreeRoot, nodeModules) || !existsSync(nodeModules)) return;

  await rm(nodeModules, { recursive: true, force: true });
  wlog(`cleaned node_modules for disposed task ${taskId}: ${nodeModules}`);
}

function scheduleTaskNodeModulesCleanup(taskId: string): void {
  void cleanupTaskNodeModules(taskId).catch((err: unknown) => {
    werr(`node_modules cleanup for ${taskId} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function disposeTask(taskId: string): void {
  if (!taskId) return;
  taskDisposals.add(taskId);
  pendingRuns.delete(taskId);
  terminalHost.disposeTask(taskId);
  turnAborts.get(taskId)?.abort();
  if (!draining.has(taskId) && !turnAborts.has(taskId)) {
    taskDisposals.delete(taskId);
    scheduleTaskNodeModulesCleanup(taskId);
  }
}

async function syncPiAuth(authJson: unknown): Promise<boolean> {
  if (!authJson || typeof authJson !== "object") return false;
  const authDir = join(homedir(), ".pi", "agent");
  const authPath = join(authDir, "auth.json");
  await mkdir(authDir, { recursive: true });
  await writeFile(authPath, JSON.stringify(authJson, null, 2), { mode: 0o600 });
  return true;
}

/** Fold a batch of queued messages into a single turn: concatenate their texts
 * (so nothing the user typed is lost) and carry the newest task payload (freshest
 * worktree / branch / session key). A single-message batch is returned as-is. */
function coalesceRuns(batch: RunTaskMsg[]): RunTaskMsg {
  const last = batch[batch.length - 1]!;
  if (batch.length === 1) return last;
  const message = batch.map((m) => m.message).filter((t) => t && t.trim()).join("\n\n");
  return { ...last, message };
}

interface SkillRepoConfig {
  repo: string;
  path?: string;
}

interface TaskPayload {
  id: string;
  name: string;
  repo: string;
  title: string;
  cardType?: string;
  backgroundMode?: string | null;
  executionMode?: "task" | "background" | "background_readonly";
  workerBackend: string;
  worktreePath?: string;
  branch?: string;
  defaultBranch?: string;
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  linearIssueIdentifier?: string;
  /** True when the card was spawned from Slack and can report final findings there. */
  slackOriginated?: boolean;
  sessionKey?: string;
  /** Repo "Setup commands" to run once on first provision (server has the DB). */
  setupCommands?: string;
  /** Workspace-wide durable context to include in every worker turn. */
  teamMemory?: string;
  /** Enabled repos in this workspace, used so workers can detect likely repo mismatches. */
  workspaceRepos?: string[];
  /** Skill repos to clone alongside the main repo and register with Pi. */
  skillRepos?: SkillRepoConfig[];
  /** Workspace Linear app token for Linear automation workers. */
  linearApiKey?: string;
}

interface RunTaskMsg {
  type: "run_task";
  taskId: string;
  workspaceId: string;
  message: string;
  task: TaskPayload;
  /** Optional Pi auth.json blob vended by the server for this task/workspace. */
  authJson?: unknown;
}

interface RunQuestionMsg {
  type: "run_question";
  questionId: string;
  workspaceId: string;
  repo: string;
  question: string;
  backendId: string;
  /** Short-lived server grant for curated repo-chat board tools. Delegated brain
   * questions receive no grant and remain read-only. */
  workspaceToolToken?: string;
  /** Pi auth.json blob vended by the server for the requested model. Applied
   * in-memory for this turn only — NOT written to disk — because questions run on
   * arbitrary members' daemons and must not clobber the owner's personal login. */
  authJson?: unknown;
}

/** Single-task (cloud sandbox) mode: the daemon is launched inside a Daytona
 * sandbox with a single-task token + task payload in its env. It skips browser
 * pairing, runs that one task on connect, then stays for follow-up turns. The
 * server manages the sandbox's lifecycle (stop on idle / done) around it. */
interface SingleTaskConfig {
  token: string;
  workspaceId: string;
  message: string;
  task: TaskPayload;
}

function parseSingleTask(): SingleTaskConfig | null {
  const token = process.env["MANTA_SANDBOX_TOKEN"];
  const taskJson = process.env["MANTA_TASK"];
  if (!token || !taskJson) return null;
  const parsed = JSON.parse(taskJson) as TaskPayload & { workspaceId: string };
  return {
    token,
    workspaceId: parsed.workspaceId,
    message: process.env["MANTA_TASK_MESSAGE"] ?? "",
    task: parsed,
  };
}

/** Populated in main() when sandbox env is present; null for a normal daemon. */
let SINGLE_TASK: SingleTaskConfig | null = null;
let singleTaskStarted = false;

function workerHasCurrentWork(): boolean {
  return draining.size > 0 || pendingRuns.size > 0 || turnAborts.size > 0 || provisioningWorktrees.size > 0 || activeQuestions.size > 0;
}

function requestWorkerUpdateRestart(reason: string): never {
  wlog(`${reason}, restarting via worker update path...`);
  process.exit(42);
}

/** Tail the pi-claude-bridge debug log into the daemon's stdout so a stalled
 * Claude Code turn (the "stream idle timeout … no assistant/tool output" case)
 * surfaces the SDK's real error in the worker log stream → ECS, instead of dying
 * with the box before anyone can read ~/.pi/agent/claude-bridge.log by hand. The
 * server sets CLAUDE_BRIDGE_DEBUG=1 in cloud boxes so this file actually gets
 * written. Best-effort: no `tail`, an unwritten log, or a spawn failure is fine. */
function streamBridgeDebugLog(): void {
  try {
    const logPath = process.env["CLAUDE_BRIDGE_DEBUG_PATH"] || join(homedir(), ".pi", "agent", "claude-bridge.log");
    // -F follows across the file being created/rotated; -n0 skips backlog so we
    // only stream lines written from here on. Inherit nothing else.
    const child = spawn("tail", ["-n0", "-F", logPath], { stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", () => {}); // tail missing / spawn failed — nothing to do
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) wlog(`[claude-bridge] ${line}`);
    });
    child.unref();
  } catch {
    /* best-effort diagnostics only */
  }
}

async function gitInWorkerRepo(args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", REPO_ROOT, ...args], { timeout: SELF_UPDATE_GIT_TIMEOUT_MS });
  return stdout.trim();
}

async function workerRepoRemote(): Promise<string | null> {
  const remotes = (await gitInWorkerRepo(["remote"]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return remotes.find((remote) => remote === "origin") ?? remotes[0] ?? null;
}

function stripRemotePrefix(ref: string, remote: string): string {
  const prefix = `${remote}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

async function workerRepoRemoteDefaultBranch(remote: string): Promise<string> {
  try {
    const ref = await gitInWorkerRepo(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
    const branch = stripRemotePrefix(ref, remote).trim();
    if (branch) return branch;
  } catch { /* fall through */ }

  try {
    const output = await gitInWorkerRepo(["remote", "show", remote]);
    const branch = output
      .split("\n")
      .map((line) => line.match(/HEAD branch:\s*(.+)$/)?.[1]?.trim())
      .find((value): value is string => !!value && value !== "(unknown)");
    if (branch) return branch;
  } catch { /* fall through */ }

  const output = await gitInWorkerRepo(["ls-remote", "--symref", remote, "HEAD"]);
  const branch = output
    .split("\n")
    .map((line) => line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/)?.[1]?.trim())
    .find((value): value is string => !!value);
  if (!branch) throw new Error(`could not determine ${remote}'s default branch`);
  return branch;
}

async function workerRepoNeedsUpdate(remote: string): Promise<{ needsUpdate: boolean; target: string }> {
  const defaultBranch = await workerRepoRemoteDefaultBranch(remote);
  const target = `${remote}/${defaultBranch}`;
  const targetCommit = await gitInWorkerRepo(["rev-parse", "--verify", `refs/remotes/${remote}/${defaultBranch}^{commit}`]);
  const headCommit = await gitInWorkerRepo(["rev-parse", "HEAD"]);
  if (headCommit === targetCommit) return { needsUpdate: false, target };

  const alreadyContainsTarget = await exec("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", targetCommit, "HEAD"], { timeout: SELF_UPDATE_GIT_TIMEOUT_MS })
    .then(() => true, () => false);
  return { needsUpdate: !alreadyContainsTarget, target };
}

async function checkForSelfUpdate(reason: string): Promise<void> {
  if (SINGLE_TASK) return; // cloud sandboxes refresh at boot and are not wrapped by start-worker's restart loop.

  const remote = await workerRepoRemote();
  if (!remote) {
    wlog(`self-update check (${reason}) skipped: no git remote configured`);
    return;
  }

  wlog(`self-update check (${reason}): fetching ${remote}`);
  if (remote === "origin") await ensureRemoteTrackingFetchRefspec(REPO_ROOT);
  await gitInWorkerRepo(["fetch", "--prune", remote]);
  const { needsUpdate, target } = await workerRepoNeedsUpdate(remote);
  if (!needsUpdate) return;

  if (workerHasCurrentWork()) {
    wlog(`self-update available at ${target}, but current work is active — will retry later`);
    return;
  }

  requestWorkerUpdateRestart(`self-update available at ${target}`);
}

function runSelfUpdateCheck(reason: string): void {
  if (selfUpdateCheckInFlight) return;
  if (pendingServerUpdateReason && !workerHasCurrentWork()) {
    const pending = pendingServerUpdateReason;
    pendingServerUpdateReason = null;
    requestWorkerUpdateRestart(pending);
  }
  selfUpdateCheckInFlight = checkForSelfUpdate(reason)
    .catch((err: unknown) => werr(`self-update check (${reason}) failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => { selfUpdateCheckInFlight = null; });
}

/** A server `update` nudge arrived while the worker was busy. Re-check on a short
 * cadence instead of waiting for the daily 4am window: `runSelfUpdateCheck`
 * restarts (exit 42 → start-worker git-pulls and relaunches) as soon as the
 * worker is idle with a pending update. The interval is unref'd and the process
 * exits on update, so it self-cleans; idempotent so repeated nudges don't stack. */
function scheduleServerUpdateRetry(): void {
  if (serverUpdateRetryTimer) return;
  serverUpdateRetryTimer = setInterval(() => runSelfUpdateCheck("server-update-retry"), SERVER_UPDATE_RETRY_MS);
  serverUpdateRetryTimer.unref?.();
}

function msUntilLocalHour(hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

function startSelfUpdateChecks(): void {
  const scheduleNext = () => {
    const delay = msUntilLocalHour(4);
    const timer = setTimeout(() => {
      runSelfUpdateCheck("daily-4am");
      const repeat = setInterval(() => runSelfUpdateCheck("daily-4am"), 24 * 60 * 60 * 1000);
      repeat.unref?.();
    }, delay);
    timer.unref?.();
  };
  scheduleNext();
}

async function workerApi(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${SERVER_HTTP}/api/worker${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WORKER_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

const pendingUserQuestionResolvers = new Map<string, (answer: string) => void>();

function buildWorkerTools(
  taskId: string,
  workspaceId: string,
  task: TaskPayload,
  send: (msg: unknown) => void,
  signal?: AbortSignal,
) {
  const readonlyBackground = task.executionMode === "background_readonly";
  const scheduledSlackBackground = task.backgroundMode === "scheduled_slack";
  const linearPrTitleGuidance = task.linearIssueIdentifier
    ? ` Since this card is linked to Linear issue ${task.linearIssueIdentifier}, the PR title must include "${task.linearIssueIdentifier}".`
    : "";
  const renameCard = defineTool<{ title: string }>({
    name: "rename_card",
    description: "Rename this card to a short, useful title at the beginning of brand-new work.",
    parameters: {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" } },
    },
    handler: async (args) => workerApi(`/tasks/${taskId}/rename-card`, { ...args, workspaceId }),
  });

  const reportPr = defineTool<{ prNumber: number; prUrl: string; prTitle: string; branch: string }>({
    name: "report_pr",
    description: "Report the pull request this task updated. For existing-PR cards, report the existing PR after pushing commits; for new work, call after create_github_pr succeeds.",
    parameters: {
      type: "object",
      required: ["prNumber", "prUrl", "prTitle", "branch"],
      properties: {
        prNumber: { type: "number" },
        prUrl: { type: "string" },
        prTitle: { type: "string" },
        branch: { type: "string" },
      },
    },
    handler: async (args) => workerApi(`/tasks/${taskId}/report-pr`, { ...args, workspaceId }),
  });

  const updateChecklist = defineTool<{ items: { id: string; text: string; checked: boolean }[] }>({
    name: "update_checklist",
    description: "Update the task checklist to track your progress.",
    parameters: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "text", "checked"],
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              checked: { type: "boolean" },
            },
          },
        },
      },
    },
    handler: async (args) => workerApi(`/tasks/${taskId}/update-checklist`, { ...args, workspaceId }),
  });

  const sendCardToNeedsHelp = defineTool<{ reason: string }>({
    name: "send_card_to_needs_help",
    description: "Move this card to Needs Help with a short reason when you cannot safely continue, for example if it appears to target the wrong repo.",
    parameters: {
      type: "object",
      required: ["reason"],
      properties: { reason: { type: "string" } },
    },
    handler: async (args) => workerApi(`/tasks/${taskId}/needs-help`, { ...args, workspaceId }),
  });

  const switchCardRepo = defineTool<{ targetRepo: string; reason: string }>({
    name: "switch_card_repo",
    description:
      "Switch this card to a different enabled repo in the same workspace when the request clearly belongs there. " +
      "Use this instead of Needs Help for wrong-repo cards. It creates a replacement card in the target repo and cancels this one.",
    parameters: {
      type: "object",
      required: ["targetRepo", "reason"],
      properties: {
        targetRepo: { type: "string", description: "The enabled workspace repo in org/repo format." },
        reason: { type: "string", description: "Short explanation for why the card belongs in the target repo." },
      },
    },
    handler: async (args) => workerApi(`/tasks/${taskId}/switch-repo`, { ...args, workspaceId }),
  });

  const planReady = defineTool<{ plan: string }>({
    name: "plan_ready",
    description:
      "Submit the final markdown plan for a plan-mode card. This saves the plan, stops active work, and moves the card to Needs Help for human review.",
    parameters: {
      type: "object",
      required: ["plan"],
      properties: {
        plan: { type: "string", description: "A concise markdown implementation plan with scope, steps, risks, and validation notes." },
      },
    },
    handler: async (args) => workerApi(`/tasks/${taskId}/plan-ready`, { ...args, workspaceId }),
  });

  const getGithubToken = defineTool<{ orgRepo: string }>({
    name: "get_github_token",
    description: "Get a short-lived GitHub token for pushing to the repo.",
    parameters: {
      type: "object",
      required: ["orgRepo"],
      properties: { orgRepo: { type: "string" } },
    },
    handler: async (args) => workerApi("/github-token", { ...args, taskId, workspaceId }),
  });

  const createGithubPr = defineTool<{ title: string; body?: string; head: string; base: string }>({
    name: "create_github_pr",
    description:
      "Create a GitHub pull request for this task, using the card creator's linked GitHub account when available; " +
      "falling back to the Manta GitHub App when no creator GitHub exists. " +
      PR_TITLE_GUIDANCE + linearPrTitleGuidance,
    parameters: {
      type: "object",
      required: ["title", "head", "base"],
      properties: {
        title: { type: "string", description: PR_TITLE_GUIDANCE + linearPrTitleGuidance },
        body: { type: "string" },
        head: { type: "string" },
        base: { type: "string" },
      },
    },
    handler: async (args) => workerApi("/github-pr", { ...args, title: formatPrTitleWithLinearIssue(args.title, task.linearIssueIdentifier), taskId, workspaceId }),
  });

  const getLinearIssue = defineTool<{ issueId: string }>({
    name: "get_linear_issue",
    description: "Read a Linear ticket by UUID or identifier (for example ENG-1234) using the workspace's Linear connection.",
    parameters: {
      type: "object",
      required: ["issueId"],
      properties: { issueId: { type: "string" } },
    },
    handler: async (args) => workerApi("/linear-issue", { ...args, workspaceId }),
  });

  const readNotionInstructions = defineTool({
    name: "read_notion_instructions",
    description: "Read this workspace's Notion instructions, including important document links and guidance configured in Settings.",
    parameters: { type: "object", properties: {} },
    handler: async () => workerApi("/notion-tool", { workspaceId, taskId, action: "instructions" }),
  });

  const searchNotion = defineTool<{ query: string }>({
    name: "search_notion",
    description: "Search the connected Notion workspace and return matching pages and sources.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    handler: async (args) => workerApi("/notion-tool", { workspaceId, taskId, action: "search", args }),
  });

  const fetchNotion = defineTool<{ id: string }>({
    name: "fetch_notion",
    description: "Fetch a Notion page, database, or data source by URL or ID.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string", description: "Notion URL, page ID, database ID, or data source ID" } } },
    handler: async (args) => workerApi("/notion-tool", { workspaceId, taskId, action: "fetch", args }),
  });

  const createNotionPages = defineTool<{ parent?: Record<string, unknown>; pages: Record<string, unknown>[] }>({
    name: "create_notion_pages",
    description: "Create one or more Notion pages. Use fetch_notion first when creating pages in a database so you have its schema.",
    parameters: {
      type: "object",
      required: ["pages"],
      properties: {
        parent: { type: "object", additionalProperties: true, description: "Optional parent, for example {page_id: ...} or {data_source_id: ...}." },
        pages: { type: "array", items: { type: "object", additionalProperties: true }, description: "Pages with properties and optional Markdown content." },
      },
    },
    handler: async (args) => workerApi("/notion-tool", { workspaceId, taskId, action: "create_pages", args }),
  });

  const updateNotionPage = defineTool<{ pageId: string; command: string; properties?: Record<string, unknown>; newString?: string; selectionWithEllipsis?: string }>({
    name: "update_notion_page",
    description: "Update a Notion page's properties or Markdown content. Fetch the page first before targeted content edits.",
    parameters: {
      type: "object",
      required: ["pageId", "command"],
      properties: {
        pageId: { type: "string" },
        command: { type: "string", description: "Notion update command such as update_properties, replace_content, replace_content_range, or insert_content_after." },
        properties: { type: "object", additionalProperties: true },
        newString: { type: "string", description: "Markdown content used by content update commands." },
        selectionWithEllipsis: { type: "string", description: "Existing content selection for targeted edits." },
      },
    },
    handler: async (args) => workerApi("/notion-tool", {
      workspaceId,
      taskId,
      action: "update_page",
      args: {
        page_id: args.pageId,
        command: args.command,
        ...(args.properties ? { properties: args.properties } : {}),
        ...(args.newString !== undefined ? { new_str: args.newString } : {}),
        ...(args.selectionWithEllipsis ? { selection_with_ellipsis: args.selectionWithEllipsis } : {}),
      },
    }),
  });

  const createNotionComment = defineTool<{ pageId: string; body: string }>({
    name: "create_notion_comment",
    description: "Add a text comment to a Notion page.",
    parameters: { type: "object", required: ["pageId", "body"], properties: { pageId: { type: "string" }, body: { type: "string" } } },
    handler: async (args) => workerApi("/notion-tool", {
      workspaceId,
      taskId,
      action: "create_comment",
      args: { parent: { page_id: args.pageId }, markdown: args.body },
    }),
  });

  const notionReadTools = [readNotionInstructions, searchNotion, fetchNotion];
  const notionWriteTools = [createNotionPages, updateNotionPage, createNotionComment];

  const listLinearView = defineTool<{ viewId: string; limit?: number }>({
    name: "list_linear_view",
    description:
      "Enumerate all issues in a Linear custom view by the view's UUID (from the view's URL). " +
      "Use this to triage a saved set of issues (e.g. an automation's aging-candidates view) that " +
      "get_linear_issue cannot reach one ticket at a time. Returns each issue's identifier, title, " +
      "state, assignee, and description.",
    parameters: {
      type: "object",
      required: ["viewId"],
      properties: {
        viewId: { type: "string", description: "Linear custom view UUID, e.g. dd09f28b-3173-4c83-8580-2452078d1a3b." },
        limit: { type: "number", description: "Max issues to return (default 100, capped at 500)." },
      },
    },
    handler: async (args) => workerApi("/linear-list", { ...args, workspaceId }),
  });

  const listLinearIssues = defineTool<{ teamId: string; stateFilter?: string; limit?: number }>({
    name: "list_linear_issues",
    description:
      "List a Linear team's open issues (optionally filtered to a workflow state by name, e.g. 'Todo'). " +
      "Each issue includes its assignee, so this is enough to break a column down per engineer. " +
      "The teamId comes from a known issue's team (get_linear_issue) or a custom view entry; " +
      "for a saved custom view, use list_linear_view instead.",
    parameters: {
      type: "object",
      required: ["teamId"],
      properties: {
        teamId: { type: "string", description: "Linear team UUID or key." },
        stateFilter: { type: "string", description: "Optional workflow state name to filter by, e.g. 'Todo'." },
        limit: { type: "number", description: "Max issues to return (default 25). Ask for what you need — the server pages Linear internally; values above 500 are clamped to 500, not rejected." },
      },
    },
    handler: async (args) => workerApi("/linear-list", { ...args, workspaceId }),
  });

  const commentOnLinearIssue = defineTool<{ issueId?: string; body: string }>({
    name: "comment_on_linear_issue",
    description: "Post an investigation result or status update to this card's linked Linear issue using the workspace's Linear connection. Omit issueId to use the linked issue.",
    parameters: {
      type: "object",
      required: ["body"],
      properties: {
        issueId: { type: "string", description: "Optional Linear issue UUID or identifier; defaults to this card's linked issue." },
        body: { type: "string", description: "Markdown comment body to post to Linear." },
      },
    },
    handler: async (args) => workerApi("/linear-comment", { ...args, taskId, workspaceId }),
  });

  const reportSlackResult = defineTool<{ body: string }>({
    name: "report_slack_result",
    description:
      "Post the final findings for this Slack-originated investigation back to the originating Slack thread. " +
      "Use this instead of moving the card to Needs Help when the work is an investigation or answer that produced no PR.",
    parameters: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "string", description: "Concise final findings to post to Slack. Markdown is okay; do not include secrets." },
      },
    },
    handler: async (args) => workerApi("/slack-result", { ...args, taskId, workspaceId }),
  });

  const postToSlack = defineTool<{ text: string; bot?: string; channelId?: string; userId?: string; threadTs?: string }>({
    name: "post_to_slack",
    description:
      "Post a message using an enabled Slack bot configured for this Manta workspace. Provide exactly one of channelId (channel or thread reply) or userId (DM). " +
      "Set threadTs with channelId to reply to a thread. If multiple bots are enabled, identify one by configured name or ID in bot.",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Message text using Slack mrkdwn. Do not include secrets." },
        bot: { type: "string", description: "Configured Slack bot name or ID. Optional when exactly one bot is enabled." },
        channelId: { type: "string", description: "Slack channel or conversation ID for a channel post or thread reply." },
        userId: { type: "string", description: "Slack user ID to DM." },
        threadTs: { type: "string", description: "Parent message timestamp for a thread reply; use with channelId." },
      },
    },
    handler: async (args) => workerApi("/slack-post", { ...args, taskId, workspaceId }),
  });

  const completeInvestigation = defineTool<{ body: string }>({
    name: "complete_investigation",
    description:
      "Complete this investigation card when there is no Slack or Linear destination to report to. " +
      "Saves the final findings on the card and marks it Investigation Complete.",
    parameters: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "string", description: "Concise final investigation findings to save on the card." },
      },
    },
    handler: async (args) => workerApi("/investigation-complete", { ...args, taskId, workspaceId }),
  });

  const listLinearMembers = defineTool({
    name: "list_linear_members",
    description: "List active Linear members so you can find an engineer's assigneeId before assigning the linked Linear issue.",
    parameters: { type: "object", properties: {} },
    handler: async () => workerApi("/linear-members", { taskId, workspaceId }),
  });

  const assignLinearIssue = defineTool<{ assigneeId: string; issueId?: string }>({
    name: "assign_linear_issue",
    description: "Assign this card's linked Linear issue to an engineer and move it back to Todo for their review work. Use list_linear_members first to find the assigneeId. Omit issueId to use the linked issue.",
    parameters: {
      type: "object",
      required: ["assigneeId"],
      properties: {
        assigneeId: { type: "string", description: "Linear user ID from list_linear_members." },
        issueId: { type: "string", description: "Optional Linear issue UUID or identifier; defaults to this card's linked issue." },
      },
    },
    handler: async (args) => workerApi("/linear-assign", { ...args, taskId, workspaceId }),
  });

  const messageBrain = defineTool<{ message: string }>({
    name: "message_brain",
    description: "Send an orchestration request to the Manta brain for this workspace. Use when follow-up work should be handled by Manta orchestration, such as spawning a fix card or assigning a Linear issue to an engineer. The brain receives this as a background inbox item and decides which tools to call.",
    parameters: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string", description: "Concise request with context, desired follow-up, and any relevant files/PR/Linear issue." },
      },
    },
    handler: async (args) => workerApi("/brain-message", { ...args, taskId, workspaceId }),
  });

  const askUserQuestion = defineTool<{ questions: { question: string; header: string; options: { label: string; description?: string; preview?: string }[]; multiSelect?: boolean }[] }>({
    name: "ask_user_question",
    description:
      "Ask the user one or more structured questions during execution. The prompts appear as persistent dismissible menus in Manta and the tool returns the user's answer.",
    parameters: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            required: ["question", "header", "options"],
            properties: {
              question: { type: "string" },
              header: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  required: ["label"],
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                    preview: { type: "string" },
                  },
                },
              },
              multiSelect: { type: "boolean" },
            },
          },
        },
      },
    },
    handler: async (args) => {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      if (questions.length === 0) return { error: "questions required" };
      const userQuestionId = `${taskId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
      const TIMED_OUT = Symbol("unanswered");
      const answer = await new Promise<string | null | typeof TIMED_OUT>((resolve) => {
        let settled = false;
        const finish = (value: string | null | typeof TIMED_OUT) => {
          if (settled) return;
          settled = true;
          clearTimeout(unanswered);
          pendingUserQuestionResolvers.delete(userQuestionId);
          endAwaitingUserAnswer(taskId);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onAbort = () => finish(null);
        // Waiting on a person suspends the inactivity watchdog, so bound the wait
        // here instead: a question nobody ever answers must not pin this task's
        // drain loop (and the daemon's pending self-update) forever.
        const unanswered = setTimeout(() => {
          wlog(`task ${taskId} question ${userQuestionId} went unanswered — giving the turn control back`);
          finish(TIMED_OUT);
        }, USER_QUESTION_TIMEOUT_MS);
        unanswered.unref?.();
        if (signal?.aborted) return finish(null);
        pendingUserQuestionResolvers.set(userQuestionId, (value) => finish(value));
        // Mark BEFORE sending: the turn is now blocked on a human, so the
        // inactivity watchdog must stop counting this silence against it.
        beginAwaitingUserAnswer(taskId);
        signal?.addEventListener("abort", onAbort, { once: true });
        send({ type: "ask_user_question", taskId, workspaceId, userQuestionId, questions });
      });
      if (answer === TIMED_OUT) return { error: "the user did not answer; proceed with your best judgment or stop and summarize what you need" };
      return answer === null ? { error: "turn aborted while waiting for the user" } : { answer };
    },
  });

  const tools = [
    renameCard,
    reportPr,
    updateChecklist,
    sendCardToNeedsHelp,
    switchCardRepo,
    ...(task.cardType === "plan" ? [planReady] : []),
    getGithubToken,
    createGithubPr,
    getLinearIssue,
    ...notionReadTools,
    ...notionWriteTools,
    listLinearView,
    listLinearIssues,
    commentOnLinearIssue,
    postToSlack,
    ...(task.slackOriginated ? [reportSlackResult] : []),
    ...(task.cardType === "investigation" ? [completeInvestigation] : []),
    listLinearMembers,
    assignLinearIssue,
    messageBrain,
    askUserQuestion,
  ];
  if (readonlyBackground) return [getLinearIssue, listLinearView, listLinearIssues, listLinearMembers, ...notionReadTools, ...(scheduledSlackBackground ? notionWriteTools : [])];
  return tools;
}

function workerPrompt(task: TaskPayload, worktree: string, branch: string, skillPrompt?: string): string {
  const isPlanMode = task.cardType === "plan";
  const isInvestigationMode = task.cardType === "investigation";
  const isBackgroundMode = task.executionMode === "background";
  const isReadonlyBackgroundMode = task.executionMode === "background_readonly";
  const isScheduledSlackBackground = task.backgroundMode === "scheduled_slack";
  const completionInstructions = isInvestigationMode
    ? [
      "INVESTIGATION MODE: Do not edit files, commit changes, push branches, or create a PR unless the user later explicitly asks for implementation work.",
      "Use read-only inspection tools to investigate and produce concrete findings with file paths/line numbers where useful.",
      "When the investigation is complete, report the final findings exactly once: use report_slack_result for Slack-originated cards, comment_on_linear_issue for Linear-linked cards, or complete_investigation when there is no external destination. This marks the card Investigation Complete.",
      "If the investigation shows follow-up implementation is needed, mention that in the final findings or call message_brain for orchestration; do not implement it in this investigation card.",
    ]
    : task.prNumber
    ? [
      `This card tracks an existing PR #${task.prNumber}${task.prUrl ? ` (${task.prUrl})` : ""}.`,
      `Push commits to the existing PR branch with \`git push origin ${branch}\`.`,
      "Do NOT create a new PR or run `gh pr create` unless the user explicitly asks for a new PR.",
      `When done, call report_pr with prNumber ${task.prNumber}, prUrl ${task.prUrl ?? "the existing PR URL"}, prTitle ${task.prTitle ?? task.title}, and branch ${branch}.`,
    ]
    : [
      "When done: commit with `git add -A && git commit -m '<summary>'`,",
      `push with \`git push --set-upstream origin ${branch}\`,`,
      `create a PR with create_github_pr using a fresh, concise title that summarizes the actual changes (do not blindly reuse the card title), head \`${branch}\`, and base \`${task.defaultBranch ?? "main"}\`. ${PR_TITLE_GUIDANCE}`,
      "then call report_pr with the prNumber and prUrl.",
    ];

  const planModeInstructions = [
    "PLAN MODE: Do not edit files, commit changes, push branches, or create a PR unless the user later explicitly approves implementation.",
    "Use read-only inspection tools to understand the codebase and produce a concrete markdown plan document.",
    "The plan should include: goal, relevant files/areas, proposed implementation steps, validation/testing plan, risks/open questions, and any suggested follow-up.",
    "When the plan is complete, call plan_ready with the full markdown plan. That tool will move the card to Needs Help for human review.",
  ];

  const linearInstructions = task.linearIssueIdentifier
    ? [
      `This card is linked to Linear issue ${task.linearIssueIdentifier}.`,
      `Use get_linear_issue with issueId "${task.linearIssueIdentifier}" before coding so you can read the ticket details.`,
      ...(task.linearApiKey ? [`This worker also has LINEAR_API_KEY set to the workspace Linear app token. You may use Linear's GraphQL API directly from bash/curl or scripts to read or mutate Linear issues, statuses, labels, and comments as needed. Do not print the token.`] : []),
      `When creating a GitHub PR, include "${task.linearIssueIdentifier}" in the PR title so Linear can link it automatically.`,
      "When you finish an investigation, plan, or fix for this Linear-linked card, call comment_on_linear_issue with a concise summary of the findings and outcome so the requester sees the result in Linear. If you created a PR, include the PR URL in that comment.",
      "If the outcome should be owned by an engineer, use list_linear_members to find the assigneeId, then assign_linear_issue to assign the linked Linear issue.",
      "If the next step is orchestration rather than code changes in this checkout — for example spawning a separate fix card — call message_brain with a concise handoff request. Do not try to create cards yourself.",
    ]
    : [];
  const readonlyLinearInstructions = task.linearIssueIdentifier
    ? [`This background run is linked to Linear issue ${task.linearIssueIdentifier}; you may call get_linear_issue to read it.`]
    : [];
  const linearAutomationInstructions = !task.linearIssueIdentifier && task.linearApiKey
    ? ["This worker has LINEAR_API_KEY set to the workspace Linear app token. Use Linear's GraphQL API directly from bash/curl or scripts to read or mutate the Linear issues named in the task instructions. Do not print the token."]
    : [];

  const slackInvestigationInstructions = task.slackOriginated
    ? [
      "This card was spawned from Slack and is linked to its originating Slack thread.",
      "If this is an investigation/question-answering task that does not produce a PR, finish by calling report_slack_result with a concise summary of your findings for the requester. That tool posts to the original Slack thread and completes the card.",
      "Do not move the card to Needs Help merely because you do not know the Slack channel; the report_slack_result tool handles the destination.",
    ]
    : [];

  const otherRepos = (task.workspaceRepos ?? []).filter((repo) => repo && repo !== task.repo);
  const repoMismatchInstructions = otherRepos.length > 0
    ? [
      `Other enabled repos in this workspace: ${otherRepos.join(", ")}.`,
      `If the user's request clearly belongs to one of those repos instead of ${task.repo}, do not make code changes; call switch_card_repo with targetRepo set to the correct repo and a concise reason. That tool creates a replacement card in the correct repo and cancels this one; stop working after it succeeds.`,
    ]
    : [];

  const sections = [[
    `You are a Manta coding worker operating in a git worktree at ${worktree}`,
    `on branch ${branch} of ${task.repo}.`,
    ...WORKER_SAFETY_INSTRUCTIONS,
    "Before calling any tools, briefly acknowledge the task and describe your approach in 2-3 sentences.",
    ...(task.prNumber || isBackgroundMode || isReadonlyBackgroundMode ? [] : ["At the beginning of brand-new work, call rename_card once with a concise, useful title after you understand the request."]),
    ...(isBackgroundMode || isReadonlyBackgroundMode ? [
      "BACKGROUND RUN: Do not create commits, branches, or pull requests, and do not call report_pr.",
      ...(isReadonlyBackgroundMode ? [
        isScheduledSlackBackground
          ? "SCHEDULED SLACK MODE: Do not modify repository, card, GitHub, Linear, or Slack state. You may write to Notion only when the scheduled prompt explicitly requests Notion work."
          : "READ-ONLY MODE: Do not modify files or state. You have only read-oriented tools for repository and workspace inspection.",
      ] : [
        "Use the repository checkout, environment, and available read-only or orchestration tools to answer the requested background check.",
        "If follow-up work should be created or assigned, call message_brain with a concise request instead of creating visible cards directly.",
      ]),
      "Finish by writing the requested final answer in the assistant response.",
    ] : isPlanMode ? planModeInstructions : [
      "Then use your tools (read/edit/write/bash/grep/find/ls) to implement the changes.",
      "If multi-step, call update_checklist to track progress.",
    ]),
    "Keep changes focused and minimal.",
    ...(isReadonlyBackgroundMode ? [] : repoMismatchInstructions),
    ...(isReadonlyBackgroundMode ? readonlyLinearInstructions : linearInstructions),
    ...(isReadonlyBackgroundMode ? [] : linearAutomationInstructions),
    ...(isReadonlyBackgroundMode ? [] : slackInvestigationInstructions),
    ...(isPlanMode || isBackgroundMode || isReadonlyBackgroundMode ? [] : completionInstructions),
  ].join(" ")];

  if (task.teamMemory?.trim()) {
    sections.push(`## Team Memory\n\n${task.teamMemory.trim()}`);
  }

  if (skillPrompt?.trim()) {
    sections.push(skillPrompt.trim());
  }

  return sections.join("\n\n");
}

/** Download any `![alt](/api/images/<id>)` URLs in the message to the worktree
 * and replace them with local file paths so Pi's context receives file paths
 * instead of opaque URLs (and never raw base64 blobs). */
async function resolveMessageImages(message: string, worktree: string): Promise<string> {
  const IMAGE_URL_RE = /!\[([^\]]*)\]\(((?:https?:\/\/[^/]+)?\/api\/images\/([a-z0-9]+))\)/g;
  const matches = [...message.matchAll(IMAGE_URL_RE)];
  if (matches.length === 0) return message;

  const imgDir = join(worktree, ".manta-images");
  await mkdir(imgDir, { recursive: true });

  let result = message;
  for (const [full, alt, rawUrl, id] of matches) {
    if (!rawUrl || !id) continue;
    const url = rawUrl.startsWith("http") ? rawUrl : `${SERVER_HTTP}${rawUrl}`;
    try {
      const res = await fetch(url);
      if (!res.ok) { wlog(`image download failed for ${id}: ${res.status}`); continue; }
      const mimeType = res.headers.get("content-type") ?? "image/png";
      const ext = mimeType.split("/")[1]?.split(";")[0]?.replace("+xml", "") ?? "png";
      const dest = join(imgDir, `${id}.${ext}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      result = result.replaceAll(full, `![${alt}](${dest})`);
    } catch (err) {
      wlog(`image download error for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

function repoCachePath(repo: string, suffix?: string): string {
  const base = `${repo.replace(/[^A-Za-z0-9._-]+/g, "__")}.git`;
  return join(REPO_CACHE_ROOT, suffix ? `${base}.${suffix}` : base);
}

async function originUrl(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repoDir, "remote", "get-url", "origin"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitDirMatchesTaskRepo(repoDir: string, repo: string): Promise<boolean> {
  const url = await originUrl(repoDir);
  return Boolean(url && gitRemoteMatchesRepo(url, repo));
}

async function usableRepoCachePath(repo: string, taskId: string): Promise<string> {
  const canonical = repoCachePath(repo);
  if (!existsSync(join(canonical, "HEAD"))) return canonical;

  const url = await originUrl(canonical);
  if (!url || gitRemoteMatchesRepo(url, repo)) return canonical;

  // A developer's local cache can be poisoned (for example, a platform cache dir
  // that actually points at manta). Do not paper over that by `remote set-url` on
  // the wrong object database: stale branches/HEAD can yield a worktree for the
  // wrong repo, and the agent then "fixes" the card by sending it to Needs Help.
  // Route this task through an isolated cache path instead; the bad cache remains
  // untouched for the human to inspect/clean up.
  const suffix = taskId.replace(/[^A-Za-z0-9._-]+/g, "-");
  const fallback = repoCachePath(repo, suffix);
  console.warn(`[worker] repo cache ${canonical} has origin ${url}, expected ${repo}; using ${fallback}`);
  return fallback;
}

function safeBranchSegment(value: string): string {
  const segment = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/[.]{2,}/g, ".")
    .replace(/^-+|-+$/g, "")
    .replace(/^[.]+|[.]+$/g, "");
  if (!segment || segment === "@" || segment.endsWith(".lock")) return "task";
  return segment;
}

function taskBranch(task: TaskPayload): string {
  const existingBranch = task.branch?.trim();
  if (existingBranch) return existingBranch;
  return `manta/${safeBranchSegment(task.name)}-${safeBranchSegment(task.id)}`;
}

async function currentBranch(worktree: string, fallback: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", worktree, "branch", "--show-current"]);
    return stdout.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function hasRef(repoDir: string, ref: string): Promise<boolean> {
  return exec("git", ["-C", repoDir, "show-ref", "--verify", "--quiet", ref])
    .then(() => true)
    .catch(() => false);
}

const REMOTE_TRACKING_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/** Bare repo caches created by `git clone --bare` do not always get the normal
 * remote-tracking fetch refspec that non-bare clones have. Without it, `git
 * fetch origin` in a Manta-created worktree only updates FETCH_HEAD, leaving
 * origin/main stale and confusing agents that compare against the default
 * branch. Ensure the shared repo config has the standard wildcard mapping
 * before any plain fetches run against the cache or its worktrees. */
async function ensureRemoteTrackingFetchRefspec(repoDir: string): Promise<void> {
  const refs: string[] = await exec("git", ["-C", repoDir, "config", "--get-all", "remote.origin.fetch"])
    .then(({ stdout }) => stdout.split("\n").map((line) => line.trim()).filter(Boolean))
    .catch(() => []);
  if (refs.includes(REMOTE_TRACKING_FETCH_REFSPEC)) return;
  await exec("git", ["-C", repoDir, "config", "--add", "remote.origin.fetch", REMOTE_TRACKING_FETCH_REFSPEC]);
}

/** Explicitly refresh the branch a new worktree will start from. `git fetch
 * origin main` only updates FETCH_HEAD in some call patterns, so fetch into the
 * remote-tracking ref we later pass to `git worktree add`. That keeps Manta-
 * spawned branches from starting at a stale local origin/main. */
async function fetchRemoteBranch(repoDir: string, branch: string): Promise<boolean> {
  return exec("git", [
    "-C", repoDir,
    "fetch",
    "--prune",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]).then(() => true, () => false);
}

/** The remote ref new worktrees should start from, or "HEAD" if unknown. A seed
 * clone's local HEAD can be stale after a fetch, so new branches base off an
 * explicitly fetched origin ref to pick up the latest code and avoid inheriting
 * local conflicts. */
async function worktreeBaseRef(repoDir: string, defaultBranch?: string): Promise<string> {
  const configured = defaultBranch?.trim();
  if (configured) {
    await fetchRemoteBranch(repoDir, configured);
    if (await hasRef(repoDir, `refs/remotes/origin/${configured}`)) return `origin/${configured}`;
  }

  await fetchRemoteBranch(repoDir, "main");
  if (await hasRef(repoDir, "refs/remotes/origin/main")) return "origin/main";

  try {
    const { stdout } = await exec("git", ["-C", repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    return stdout.trim() || "HEAD";
  } catch {
    try {
      const { stdout } = await exec("git", ["-C", repoDir, "symbolic-ref", "--short", "HEAD"]);
      return stdout.trim() || "HEAD";
    } catch {
      return "HEAD";
    }
  }
}

async function addWorktree(cachedRepo: string, branch: string, worktree: string, baseRef = "HEAD"): Promise<void> {
  await exec("git", ["-C", cachedRepo, "worktree", "prune"]);
  const hasBranch = await hasRef(cachedRepo, `refs/heads/${branch}`);
  if (hasBranch) {
    try {
      await exec("git", ["-C", cachedRepo, "worktree", "add", worktree, branch]);
    } catch (error) {
      if (!isBranchAlreadyCheckedOutError(error)) throw error;
      // Existing-PR cards must work on the PR's fixed branch. That branch may
      // still be registered to an older or user-created worktree, so create the
      // card's isolated checkout without requiring manual worktree cleanup.
      await exec("git", ["-C", cachedRepo, "worktree", "add", "--force", worktree, branch]);
    }
    return;
  }

  const remoteBranch = `origin/${branch}`;
  const hasRemoteBranch = await hasRef(cachedRepo, `refs/remotes/${remoteBranch}`);
  await exec(
    "git",
    ["-C", cachedRepo, "worktree", "add", "-b", branch, worktree, hasRemoteBranch ? remoteBranch : baseRef],
  );
}

/** Make the daemon's git authenticate the way the developer already does — via
 * their GitHub CLI login — instead of the machine's HTTPS credential store, which
 * is commonly EMPTY when the dev uses SSH for their own repos. The daemon always
 * clones the repo cache over https://github.com/…, so without this a laptop whose
 * keychain has no github HTTPS entry fails every clone/fetch/push with
 * "could not read Username" (and, pre-GIT_TERMINAL_PROMPT, hung on the prompt).
 *
 * We deliberately do NOT mint a server/App token: a laptop worker should act AS
 * the user — their own credentials, correct PR authorship. Registered via
 * GIT_CONFIG_* env so it applies to worktree provisioning AND the agent's own
 * `git`/`gh` in the bash tool, without touching the user's global git config.
 * No-op in a sandbox (the server vends credentials) or when gh isn't installed /
 * logged in (we then leave git to whatever it already does). */
async function setupNativeGitAuth(): Promise<void> {
  if (SINGLE_TASK) return; // sandbox: server vends .git-credentials
  let ghPath: string;
  try {
    await exec("gh", ["auth", "token"]); // throws if gh is missing or not logged in
    ghPath = (await exec("which", ["gh"]).then((r) => r.stdout.trim())) || "gh";
  } catch {
    wlog("git auth: gh CLI not logged in — using the machine's own git credentials (github.com clones may fail if it has none over https)");
    return;
  }
  // Point github.com at gh's credential helper. The empty value first RESETS any
  // inherited helper (e.g. osxkeychain) for this URL so gh is the one that answers.
  const cfg: [string, string][] = [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", `!${ghPath} auth git-credential`],
  ];
  cfg.forEach(([key, value], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = key;
    process.env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  process.env["GIT_CONFIG_COUNT"] = String(cfg.length);
  wlog("git auth: using your GitHub CLI login (gh) for https://github.com");
}

const SKILL_REPOS_ROOT = join(homedir(), ".manta", "skill-repos");
const SKILL_EXTENSIONS_ROOT = join(SKILL_REPOS_ROOT, ".extensions");

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-") || "task";
}

function resolveSkillRoot(cloneDir: string, cfg: SkillRepoConfig): string | null {
  const cloneRoot = resolve(cloneDir);
  const skillRoot = cfg.path?.trim() ? resolve(cloneRoot, cfg.path.trim()) : cloneRoot;
  const rel = relative(cloneRoot, skillRoot);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return skillRoot;
}

async function findSkillMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findSkillMdFiles(full)));
    } else if (entry.name === "SKILL.md") {
      results.push(full);
    }
  }
  return results;
}

interface SkillRepoExtensionResult {
  extensionDir: string;
  prompt: string;
  key: string;
}

interface SkillPromptEntry {
  name: string;
  description: string;
  location: string;
}

function skillReposKey(configs: SkillRepoConfig[]): string {
  return JSON.stringify(configs.map((cfg) => ({ repo: cfg.repo.trim(), path: cfg.path?.trim() || undefined })).filter((cfg) => cfg.repo));
}

function frontmatterValue(frontmatter: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(frontmatter);
  if (!match) return null;
  return (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
}

async function readSkillPromptEntry(filePath: string): Promise<SkillPromptEntry | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    const frontmatter = match?.[1] ?? "";
    const name = frontmatterValue(frontmatter, "name") || filePath.split("/").at(-2) || "skill";
    const description = frontmatterValue(frontmatter, "description");
    if (!description) return null;
    return { name, description, location: filePath };
  } catch {
    return null;
  }
}

async function buildSkillPrompt(skillPaths: string[]): Promise<string> {
  const entries = (await Promise.all(skillPaths.map(readSkillPromptEntry))).filter((entry): entry is SkillPromptEntry => Boolean(entry));
  if (entries.length === 0) return "";
  return [
    "## Skill repos",
    "",
    "The following workspace-configured skill repositories provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's SKILL.md file when the task matches its description. When a skill file references relative paths, resolve them against that skill directory.",
    "",
    ...entries.map((entry) => `- ${entry.name}: ${entry.description} (file: ${entry.location})`),
  ].join("\n");
}

/**
 * Clone (or fetch) each configured skill repo and generate a local Pi
 * extension that registers the discovered SKILL.md files via
 * resources_discover plus a fallback prompt summary (or null if no skill repos
 * are configured or all clones fail).
 *
 * Repos referenced by multiple configs are cloned only once.
 */
async function ensureSkillRepoExtension(taskId: string, configs: SkillRepoConfig[]): Promise<SkillRepoExtensionResult | null> {
  configs = configs
    .map((cfg) => ({ repo: cfg.repo.trim(), path: cfg.path?.trim() || undefined }))
    .filter((cfg) => cfg.repo);
  if (configs.length === 0) return null;
  const key = skillReposKey(configs);
  await mkdir(SKILL_REPOS_ROOT, { recursive: true });

  // Clone each unique repo once.
  const cloneDirByRepo = new Map<string, string>();
  for (const repoSlug of [...new Set(configs.map((c) => c.repo))]) {
    const slug = repoSlug.replace(/\//g, "-");
    const cloneDir = join(SKILL_REPOS_ROOT, slug);
    try {
      if (existsSync(join(cloneDir, ".git")) || existsSync(join(cloneDir, "HEAD"))) {
        await exec("git", ["-C", cloneDir, "pull", "--ff-only", "--quiet"]);
      } else {
        await mkdir(cloneDir, { recursive: true });
        await exec("git", ["clone", "--depth=1", "--quiet", `https://github.com/${repoSlug}.git`, cloneDir]);
      }
      cloneDirByRepo.set(repoSlug, cloneDir);
    } catch (err) {
      werr(`[skill-repos] failed to clone/fetch ${repoSlug}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Discover SKILL.md files from each config's path within its cloned repo.
  const skillPaths: string[] = [];
  for (const cfg of configs) {
    const cloneDir = cloneDirByRepo.get(cfg.repo);
    if (!cloneDir) continue;
    const skillRoot = resolveSkillRoot(cloneDir, cfg);
    if (!skillRoot) {
      werr(`[skill-repos] ignoring ${cfg.repo}${cfg.path ? `/${cfg.path}` : ""}: path escapes cloned repo`);
      continue;
    }
    const found = await findSkillMdFiles(skillRoot);
    skillPaths.push(...found);
    wlog(`[skill-repos] ${cfg.repo}${cfg.path ? `/${cfg.path}` : ""}: ${found.length} skill file(s)`);
  }

  if (skillPaths.length === 0) return null;
  const skillPrompt = await buildSkillPrompt(skillPaths);

  // Write a tiny per-task Pi extension that returns the discovered skill paths.
  // The skill repo clones are shared, but extension files cannot be: concurrent
  // tasks may have different configured roots and would otherwise overwrite the
  // single generated index.js while another task's Pi backend is loading it.
  const extensionDir = join(SKILL_EXTENSIONS_ROOT, safePathSegment(taskId));
  await mkdir(extensionDir, { recursive: true });
  const pathsJson = JSON.stringify(skillPaths);
  await writeFile(
    join(extensionDir, "index.js"),
    `const SKILL_PATHS = ${pathsJson};\nexport default function(pi) {\n  pi.on("resources_discover", async () => ({ skillPaths: SKILL_PATHS, promptPaths: [] }));\n}\n`,
    "utf-8",
  );
  await writeFile(
    join(extensionDir, "package.json"),
    JSON.stringify({ name: "manta-skill-repos", version: "1.0.0", type: "module", main: "index.js", private: true }, null, 2),
    "utf-8",
  );
  return { extensionDir, prompt: skillPrompt, key };
}

/** Bring the bare cache at `cachedRepo` up to date, self-healing a corrupt one.
 * The canonical cache backs EVERY task/question worktree for `repo`, so a rotted
 * object store wedges all of them identically (the "git fetch … object <sha> not
 * found" card that never leaves "Preparing worktree…"). When the refresh fetch
 * fails with a corruption signature, quarantine the poisoned cache aside (left for
 * a human to inspect, mirroring usableRepoCachePath) and clone a fresh one so the
 * next fetch — and every waiting card — recovers on its own. Transient fetch
 * failures (network/auth) are re-thrown unchanged so a flaky network doesn't
 * trigger a needless full re-clone. */
async function refreshOrRecloneBareCache(repo: string, cachedRepo: string): Promise<void> {
  const cloneUrl = `https://github.com/${repo}.git`;
  if (existsSync(join(cachedRepo, "HEAD"))) {
    try {
      await gitq(`git remote set-url for ${repo}`, ["-C", cachedRepo, "remote", "set-url", "origin", cloneUrl]);
      await ensureRemoteTrackingFetchRefspec(cachedRepo);
      await gitq(`git fetch for ${repo}`, ["-C", cachedRepo, "fetch", "--prune", "origin"]);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isCorruptRepoError(message)) throw err;
      const quarantine = `${cachedRepo}.corrupt-${Date.now()}`;
      console.warn(`[worker] bare cache ${cachedRepo} is corrupt (${message}); quarantining to ${quarantine} and re-cloning`);
      await rename(cachedRepo, quarantine).catch(async () => {
        await rm(cachedRepo, { recursive: true, force: true });
      });
    }
  }
  await gitq(`git clone of ${repo}`, ["clone", "--bare", "--filter=blob:none", cloneUrl, cachedRepo]);
  await ensureRemoteTrackingFetchRefspec(cachedRepo);
}

async function provisionWorktree(task: TaskPayload): Promise<{ worktree: string; branch: string }> {
  await mkdir(WORKTREE_ROOT, { recursive: true });
  await mkdir(REPO_CACHE_ROOT, { recursive: true });
  const baseBranch = taskBranch(task);
  // Slug the card title: a raw name with spaces/colons ("Spot check: Sentry New
  // Issues") produces a worktree path that breaks node-gyp's from-source builds
  // (see worktreeDirSlug). Must match resolveProvisionTarget, which slugs `name`
  // the same way, so the canonical dir we probe for ownership is the one it returns.
  const canonicalDir = `${worktreeDirSlug(task.name)}-${task.id}`;
  const canonicalPath = join(WORKTREE_ROOT, canonicalDir);
  const dirExists = existsSync(canonicalPath);
  // Only adopt an existing dir when this task owns it. Adopting a dir owned by a
  // *different* task would put this card on the other card's worktree and branch
  // (the core collision bug); resolveProvisionTarget diverts to a fresh, unique
  // path + branch in that case so two cards never share a checkout.
  let target = resolveProvisionTarget({
    root: WORKTREE_ROOT,
    name: task.name,
    taskId: task.id,
    baseBranch,
    dirExists,
    owner: dirExists ? getWorktreeOwner(canonicalDir) : undefined,
    makeSuffix: () => randomBytes(3).toString("hex"),
  });
  if (target.reuse) {
    if (!(await gitDirMatchesTaskRepo(target.worktree, task.repo))) {
      const suffix = randomBytes(3).toString("hex");
      const diverted = join(WORKTREE_ROOT, `${canonicalDir}-${suffix}`);
      console.warn(`[worker] existing worktree ${target.worktree} does not match ${task.repo}; provisioning ${diverted} instead`);
      target = { worktree: diverted, branch: `${baseBranch}-${suffix}`, reuse: false };
    }
  }

  if (target.reuse) {
    const worktree = target.worktree;
    provisioningWorktrees.add(resolve(worktree));
    try {
      await ensureRemoteTrackingFetchRefspec(worktree).catch((err: unknown) => {
        werr(`[worker] failed to configure existing worktree fetch refspec for ${task.repo}:`, err instanceof Error ? err.message : String(err));
      });
      setWorktreeOwner(worktree, task.id);
      return { worktree, branch: await currentBranch(worktree, target.branch) };
    } finally {
      provisioningWorktrees.delete(resolve(worktree));
    }
  }
  const worktree = target.worktree;
  const branch = target.branch;
  if (dirExists && worktree !== canonicalPath) {
    werr(`[worker] canonical worktree ${canonicalPath} is unavailable for this task; provisioning ${worktree} on branch ${branch} instead`);
  }

  provisioningWorktrees.add(resolve(worktree));
  try {

    // Prefer a warm seed baked into the sandbox image (manta, platform): fetch it so
    // a periodically-baked image still gets current code, then add the worktree off
    // it. Falls back to a fresh blobless bare clone for un-seeded repos (and for the
    // laptop daemon, which has no seeds).
    const seed = SEED_REPOS[task.repo];
    if (seed && existsSync(seed)) {
      // A seed clone baked by the base image may ship a repo-local
      // `credential.helper=` (empty) in its .git/config. An empty value RESETS
      // git's helper list, discarding the global `store` helper — so the vended
      // ~/.git-credentials is ignored and the fetch dies with "could not read
      // Username … terminal prompts disabled". Drop the override so the seed
      // inherits the global store + useHttpPath config and authenticates.
      await exec("git", ["-C", seed, "config", "--unset-all", "credential.helper"]).catch(() => {});
      await ensureRemoteTrackingFetchRefspec(seed).catch((err: unknown) => {
        werr(`[worker] failed to configure seed fetch refspec for ${task.repo}:`, err instanceof Error ? err.message : String(err));
      });
      // Best-effort: a seed whose fetch fails (un-seeded repo, a network stall,
      // or a base-image seed shipping a broken credential config) falls through
      // to the fresh bare clone below. gitq bounds the fetch so a stalled network
      // can't hang provisioning indefinitely.
      const fetched = await gitq(`seed fetch for ${task.repo}`, ["-C", seed, "fetch", "--prune", "origin"]).then(
        () => true,
        (e) => {
          console.warn(`[worker] seed fetch failed for ${task.repo}, falling back to bare clone:`, e);
          return false;
        },
      );
      if (fetched) {
        // Task provisioning runs concurrently across cards (only the agent turn
        // is gated), and `git worktree` locks the repo's worktree list — so
        // serialize add/prune per repo, same as question provisioning.
        const seedBaseRef = await worktreeBaseRef(seed, task.defaultBranch);
        await withRepoWorktreeLock(task.repo, () => addWorktree(seed, branch, worktree, seedBaseRef));
        setWorktreeOwner(worktree, task.id);
        console.log(`[worker] worktree from seed ${seed}: ${worktree}`);
        return { worktree, branch };
      }
    }

    // Fallback path. Use gitq (hard timeout + phase-labeled error) so a failure
    // here — most often a clone that can't authenticate — throws a clear message
    // the task handler surfaces on the card, instead of a raw "Command failed"
    // dump or a silent hang that only ever shows up as "worker disconnected".
    const cachedRepo = await usableRepoCachePath(task.repo, task.id);
    await refreshOrRecloneBareCache(task.repo, cachedRepo);

    const cacheBaseRef = await worktreeBaseRef(cachedRepo, task.defaultBranch);
    await withRepoWorktreeLock(task.repo, () => addWorktree(cachedRepo, branch, worktree, cacheBaseRef));
    setWorktreeOwner(worktree, task.id);
    console.log(`[worker] worktree from cached repo: ${worktree}`);
    return { worktree, branch };
  } finally {
    provisioningWorktrees.delete(resolve(worktree));
  }
}

/** Run the repo's setup commands in a freshly provisioned worktree. Streams
 * output live to the server (which relays to the browser) and reports a final
 * transcript line so a failing setup is visible rather than silent. Never throws. */
async function runDaemonSetup(
  send: (msg: unknown) => void,
  taskId: string,
  workspaceId: string,
  worktree: string,
  commands: string | undefined,
): Promise<void> {
  const script = commands?.trim();
  if (!script) return;
  send({ type: "worker_setup", taskId, workspaceId, chunk: "⚙️ Running setup commands…\n" });
  const result = await runSetupCommands(worktree, script, (chunk) =>
    send({ type: "worker_setup", taskId, workspaceId, chunk }),
  );
  if (!result.ok) console.error(`[worker] setup commands failed for ${taskId} (exit ${result.code})`);
  send({ type: "worker_setup", taskId, workspaceId, content: formatSetupTranscript(script, result) });
}

async function runTask(send: (msg: unknown) => void, msg: RunTaskMsg): Promise<void> {
  const { taskId } = msg;

  // Queue the message, then abort any in-flight turn so it unwinds and the new
  // message gets folded into the next turn (abort, but never drop).
  const queue = pendingRuns.get(taskId) ?? [];
  queue.push(msg);
  pendingRuns.set(taskId, queue);
  const running = turnAborts.get(taskId);
  if (running) {
    wlog(`new message for ${taskId} — aborting current turn to fold it in`);
    running.abort();
  }

  // Exactly one drain loop per task processes the queue; a concurrent message just
  // enqueued above and the loop will pick it up. The loop runs turns strictly one
  // at a time, so two never overlap on the shared worktree + session file.
  if (draining.has(taskId)) return;
  draining.add(taskId);
  try {
    // Re-read the queue each iteration: messages that arrive (and abort) mid-turn
    // are appended, then folded into the following turn. No await sits between the
    // empty-check that ends the loop and `draining.delete`, so a message can't slip
    // in unprocessed — it would start a fresh loop instead.
    for (let batch = pendingRuns.get(taskId); batch?.length; batch = pendingRuns.get(taskId)) {
      pendingRuns.delete(taskId);
      if (batch.length > 1) wlog(`folding ${batch.length} queued messages into one turn for ${taskId}`);
      const ctrl = new AbortController();
      turnAborts.set(taskId, ctrl);
      let delivered = false;
      let prompted = false;
      let abandoned = false;
      try {
        const run = coalesceRuns(batch);
        // Race the turn against an abandon deadline (wedgeWatchdog.ts). A turn is
        // given up on two ways: a NEWER message aborts ctrl and the turn refuses to
        // unwind within the grace, OR the turn streams no events for STUCK_TURN_MS —
        // a SILENT wedge with no message to abort it (an over-context model call
        // that can't proceed, or a subagent that never returns). Either way we
        // abandon it so this single per-task drain loop folds the queued message
        // into a fresh turn instead of going silent forever (the "working…" wedge).
        // `progress.lastEventAt` is stamped by runTaskTurn on every streamed event.
        const progress = { lastEventAt: Date.now() };
        const runningTurn = runTaskTurn(
          // An abandoned turn continues running in the background. Do not let
          // any of its late events (including sessions or tool output) leak
          // into the replacement turn's stream.
          (event) => { if (!abandoned) send(event); },
          run,
          ctrl.signal,
          () => { prompted = true; },
          progress,
        ).then((d): { delivered: boolean } => ({ delivered: d }));
        const outcome = await Promise.race<"abandoned" | { delivered: boolean }>([
          runningTurn,
          // On the inactivity trigger, abort ctrl so runTaskTurn breaks its stream
          // loop and tears the wedged generator down. (The abort trigger's ctrl is
          // already aborted by the incoming message.)
          turnAbandonDeadline(
            ctrl.signal,
            // A turn blocked on `ask_user_question` is waiting on a person, not
            // wedged: report it as continuously active so the inactivity trigger
            // never fires while a prompt is outstanding.
            () => (taskAwaitingUserAnswer(taskId) ? Date.now() : progress.lastEventAt),
            { graceMs: TURN_ABORT_GRACE_MS, inactivityMs: STUCK_TURN_MS },
            () => ctrl.abort(),
          ),
        ]);
        if (outcome === "abandoned") {
          abandoned = true;
          // A bridge turn owns an isolated process, so its abort has a bounded
          // hard-kill path. Wait for that process tree to be gone before this
          // task starts a replacement against the same worktree/session file.
          if (usesClaudeBridgeBackend(run.task.workerBackend)) await runningTurn;
          wlog(`task ${taskId} turn wedged (no unwind after abort, or no progress for ${Math.round(STUCK_TURN_MS / 1000)}s) — abandoning it and starting fresh`);
          // Force the next turn onto a brand-new session: the orphaned turn may
          // still hold the most-recent session's JSONL, and two turns on one
          // session file wedge both. The orphan keeps running in the background;
          // its late finally is a no-op because turnAborts holds a newer ctrl.
          const st = taskState.get(taskId) ?? {};
          taskState.set(taskId, { ...st, sessionKey: undefined, avoidResumeAfterAbandon: true });
        } else {
          delivered = outcome.delivered;
        }
      } finally {
        if (turnAborts.get(taskId) === ctrl) turnAborts.delete(taskId);
      }
      // Aborted before the agent saw it (e.g. during first-turn provisioning) —
      // put it back at the front, ahead of anything that arrived meanwhile, so the
      // next turn folds it in instead of losing it. A turn can be abandoned during
      // provisioning too, before the model receives its message, so use the
      // synchronous prompt marker rather than assuming every abandoned turn ran.
      if ((!abandoned ? !delivered : !prompted) && !taskDisposals.has(taskId)) {
        pendingRuns.set(taskId, [...batch, ...(pendingRuns.get(taskId) ?? [])]);
      }
      // An abandoned turn deliberately suppresses its own done/error so the
      // REPLACEMENT turn owns the terminator. When nothing is queued there is no
      // replacement — so without this the server never learns the turn ended: the
      // card sits on "working…" forever and the task stays in the worker's
      // server-side active set, where the next unrelated socket blip (a deploy,
      // a proxy reset) converts it into a bogus "worker disconnected mid-task →
      // Needs Help". Report the abandonment explicitly instead.
      if (abandoned && !pendingRuns.get(taskId)?.length && !taskDisposals.has(taskId)) {
        send({
          type: "worker_error",
          taskId,
          workspaceId: batch[0]?.workspaceId ?? "",
          message: "The turn stopped making progress and was abandoned. Use Retry Worker to start a fresh turn.",
        });
      }
    }
  } finally {
    draining.delete(taskId);
    if (taskDisposals.has(taskId)) scheduleTaskNodeModulesCleanup(taskId);
    taskDisposals.delete(taskId);
  }
}

/** Commit + push any uncommitted work in a task's worktree before its cloud
 * sandbox is stopped (server-driven idle spindown). Best-effort: a worktree with
 * nothing to commit, or a push with no remote yet, is fine — the point is to lose
 * nothing when the box sleeps. Always acks so the server doesn't wait the full
 * timeout. */
async function commitWip(send: (msg: unknown) => void, taskId: string, workspaceId: string): Promise<void> {
  try {
    const state = taskState.get(taskId);
    const worktree = state?.worktreePath;
    if (worktree && existsSync(worktree)) {
      await exec("git", ["-C", worktree, "add", "-A"]);
      // `commit` fails when there's nothing staged — that's not an error here.
      await exec("git", ["-C", worktree, "commit", "-m", "WIP: auto-save before sleep"]).catch(() => {});
      const branch = state?.branch ?? (await currentBranch(worktree, ""));
      if (branch) {
        await exec("git", ["-C", worktree, "push", "--set-upstream", "origin", branch]).catch(() => {});
      }
    }
  } catch (err) {
    werr(`commit_wip failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    send({ type: "worker_wip_committed", taskId, workspaceId });
  }
}

/** Run one turn. Returns whether the message was *delivered* to the agent (i.e.
 * the turn actually started). A `false` result means we were aborted during
 * provisioning before the agent ever saw the message, so the caller must re-queue
 * it rather than drop it.
 *
 * Claude-bridge turns run in one disposable child process per turn. Other
 * backends remain in-process. */
async function runTaskTurn(
  send: (msg: unknown) => void,
  msg: RunTaskMsg,
  signal: AbortSignal,
  onPrompt?: () => void,
  // Stamped with Date.now() on every streamed event so the drain loop's
  // inactivity watchdog (turnAbandonDeadline) can tell a silently-wedged turn
  // from a healthy one. Optional so direct callers/tests can omit it.
  progress?: { lastEventAt: number },
): Promise<boolean> {
  const { taskId, workspaceId, message, task } = msg;

  // Merge server-provided state with locally-remembered state.
  const remembered = taskState.get(taskId) ?? {};
  // Right after abandoning a wedged turn, ignore BOTH the server-sent and
  // remembered session keys (the server's DB copy still points at the wedged
  // session) and don't resume-recent — force a brand-new session for this one turn.
  const avoidResume = remembered.avoidResumeAfterAbandon === true;
  const state: TaskState = {
    worktreePath: task.worktreePath ?? remembered.worktreePath,
    branch: task.branch ?? remembered.branch,
    sessionKey: avoidResume ? undefined : (task.sessionKey ?? remembered.sessionKey),
    skillExtensionPath: remembered.skillExtensionPath,
    ...(avoidResume ? { avoidResumeAfterAbandon: true } : {}),
  };

  // Flips true once the agent has been prompted (the turn started). Until then an
  // abort means the message was never delivered and must be re-queued.
  let prompted = false;
  try {
    // Provision worktree if needed.
    if (!state.worktreePath || !existsSync(state.worktreePath)) {
      send({ type: "worker_setup", taskId, workspaceId, chunk: "⚙️ Preparing worktree…\n" });
      const provisioned = await provisionWorktree(task);
      state.worktreePath = provisioned.worktree;
      state.branch = provisioned.branch;
      // Clone skill repos (if configured) and generate the Pi extension once.
      if (task.skillRepos?.length) {
        const skillExtension = await ensureSkillRepoExtension(taskId, task.skillRepos);
        state.skillExtensionPath = skillExtension?.extensionDir;
        state.skillPrompt = skillExtension?.prompt;
        state.skillReposKey = skillExtension?.key;
      }
      taskState.set(taskId, state);
      // Report worktree to server so it can persist to DB and show on the board.
      send({ type: "worker_worktree", taskId, workspaceId, worktreePath: state.worktreePath, branch: state.branch });
      // Run the repo's setup commands once, on this fresh worktree.
      await runDaemonSetup(send, taskId, workspaceId, state.worktreePath, task.setupCommands);
    }

    // Record the resolved worktree before running. The provision branch above
    // already does this, but a RESUMED turn (worktree exists on disk, e.g. after
    // a daemon restart) skips provisioning and `onSession` doesn't fire on resume
    // (pi-backend only reports a fresh session) — so without this the terminal's
    // getTaskWorktree falls back to fragile name-based disk recovery and can fail
    // to map the worktree dir back to this task id. Keep taskState authoritative.
    taskState.set(taskId, state);

    // Skill repo settings can be added or changed after a task already has a
    // worktree. Refresh the generated extension/prompt when the server payload's
    // config differs from the locally remembered one so follow-up turns see the
    // newly configured skills without requiring a fresh card.
    const currentSkillReposKey = task.skillRepos?.length ? skillReposKey(task.skillRepos) : undefined;
    if (currentSkillReposKey && (!state.skillExtensionPath || state.skillReposKey !== currentSkillReposKey)) {
      const skillExtension = await ensureSkillRepoExtension(taskId, task.skillRepos!);
      state.skillExtensionPath = skillExtension?.extensionDir;
      state.skillPrompt = skillExtension?.prompt;
      state.skillReposKey = skillExtension?.key;
      taskState.set(taskId, state);
    } else if (!currentSkillReposKey && (state.skillExtensionPath || state.skillPrompt || state.skillReposKey)) {
      state.skillExtensionPath = undefined;
      state.skillPrompt = undefined;
      state.skillReposKey = undefined;
      taskState.set(taskId, state);
    }

    // Aborted during provisioning — the agent never saw the message; re-queue it.
    if (signal.aborted) return false;

    const worktree = state.worktreePath;
    const branch = state.branch!;

    // Download image attachments — pure IO before the turn.
    const resolvedMessage = await resolveMessageImages(message, worktree);

    // Re-check abort: setup (worktree, image download) may have been aborted.
    if (signal.aborted) return prompted;

    const runAgentTurn = async (): Promise<boolean> => {
      if (signal.aborted) return prompted;

      const skillExtensionPaths = state.skillExtensionPath ? [state.skillExtensionPath] : [];
      const builtinTools = task.executionMode === "background_readonly" ? QUESTION_TOOLS : CODING_TOOLS;
      let turnAuthBlob = msg.authJson && typeof msg.authJson === "object"
        ? msg.authJson as AuthBlob
        : undefined;
      const backendOptions = {
        cwd: worktree,
        builtinTools,
        extensions: true,
        extensionToolDenylist: PERSISTENT_SESSION_EXTENSION_TOOLS,
        additionalExtensionPaths: skillExtensionPaths,
        env: task.linearApiKey ? { LINEAR_API_KEY: task.linearApiKey } : undefined,
        // Use the credentials vended with this dispatch in-memory. In particular,
        // isolated Claude children must not race through the daemon-global
        // ~/.pi/agent/auth.json when cards from different workspaces overlap.
        ...(turnAuthBlob
          ? { resolveAuth: async () => ({ storage: authStorageFromBlob(turnAuthBlob!) }) }
          : {}),
        onAuthChanged: (authWorkspaceId: string, blob: AuthBlob) => {
          // Pi may retry this same turn on another model after an overload. Keep
          // OAuth refreshes in the turn-local resolver so the retry does not
          // reconstruct the original stale dispatch credential.
          turnAuthBlob = blob;
          pushRefreshedAuthToServer(authWorkspaceId, blob);
        },
      };
      const backend: AgentBackend = usesClaudeBridgeBackend(task.workerBackend)
        ? new ProcessIsolatedPiBackend(backendOptions)
        : new PiBackend(backendOptions);
      const systemPrompt = workerPrompt(task, worktree, branch, state.skillPrompt);
      const workerTools = buildWorkerTools(taskId, workspaceId, task, send, signal);

      prompted = true;
      onPrompt?.();

      // Local progress visibility. The agent's events stream to the SERVER, not to
      // this console — so without these lines the daemon log is silent between
      // "starting task" and the next dispatch, making a long turn look identical to
      // a hung one (exactly the manta-24 confusion). Log each tool call, a heartbeat
      // while the turn is quiet, and a completion line with elapsed + reason.
      const startedAt = Date.now();
      let eventCount = 0;
      let lastEventAt = startedAt;
      let doneReason: string | undefined;
      const heartbeat = setInterval(() => {
        const elapsed = ((Date.now() - startedAt) / 60_000).toFixed(1);
        const quiet = Math.round((Date.now() - lastEventAt) / 1000);
        wlog(`task ${taskId} still running — ${elapsed}m elapsed, ${eventCount} events, last activity ${quiet}s ago`);
      }, 60_000);
      // Streaming starts now — reset the inactivity clock so long provisioning
      // above isn't charged against the turn's progress watchdog.
      if (progress) progress.lastEventAt = Date.now();
      const iterator = backend.runTurn({
        systemPrompt,
        message: resolvedMessage,
        tools: workerTools,
        backend: task.workerBackend,
        ctx: { workspaceId, channel: taskId },
        signal,
        ...(state.sessionKey ? { resumeFrom: state.sessionKey } : {}),
        // The task's worktree is a cwd unique to this one card, so if the session
        // key was lost (e.g. a redeploy/daemon-reconnect between turns dropped the
        // not-yet-persisted key), resume the latest session that already lives in
        // this worktree rather than forking a blank one. The exception is a
        // post-abandon turn: the recent session IS the wedged one, so start fresh.
        resumeRecentForCwd: !avoidResume,
        onSession: (key) => {
          state.sessionKey = key;
          // A fresh session is now established — the post-abandon avoidance is done.
          const prev = taskState.get(taskId) ?? state;
          taskState.set(taskId, { ...prev, sessionKey: key, avoidResumeAfterAbandon: false });
          send({ type: "worker_session", taskId, workspaceId, sessionKey: key });
        },
      })[Symbol.asyncIterator]();
      // Manual iteration (not `for await`) so an abort can BREAK a turn whose
      // generator is suspended on a hung await — an over-context model call that
      // can't proceed, or a subagent that never returns. `for await` would stay
      // parked on the pending next() forever, sailing past the signal.aborted
      // checks below; racing next() against the abort lets us stop pulling and tear
      // the generator down in the finally instead of orphaning it (an orphan pinned
      // the wedged session's JSONL and re-wedged every resume).
      const ABORT = Symbol("abort");
      const aborted: Promise<typeof ABORT> = whenAborted(signal).then(() => ABORT);
      try {
        while (true) {
          const nextP = iterator.next();
          // If the abort wins the race we stop awaiting nextP; swallow its late
          // rejection so it isn't an unhandledRejection. If nextP rejects and wins,
          // the rejection still propagates through the race to the catch below.
          void nextP.catch(() => {});
          const result = await Promise.race([nextP, aborted]);
          if (result === ABORT) break;
          if (result.done) break;
          const event = result.value;
          eventCount++;
          lastEventAt = Date.now();
          if (progress) progress.lastEventAt = lastEventAt;
          if (event.type === "tool_use") wlog(`task ${taskId} → ${event.toolName}`);
          else if (event.type === "error") werr(`task ${taskId} agent error: ${event.message}`);
          else if (event.type === "done") doneReason = event.reason;
          // An aborted turn must not emit its terminal done/error: the replacement
          // turn owns the terminator, and a stray `done` here would free the worker
          // server-side mid-restart. Partial events before abort are harmless.
          if (signal.aborted && (event.type === "done" || event.type === "error")) continue;
          send({ type: "worker_event", taskId, workspaceId, event });
        }
      } finally {
        clearInterval(heartbeat);
        // An isolated bridge backend bounds return() by killing its child process
        // tree, so wait for that teardown before the same task can start another
        // turn against its session JSONL. In-process Pi can still hang inside an
        // uninterruptible extension await, so preserve the old fire-and-forget
        // behavior there and let the wedge watchdog move on.
        const teardown = Promise.resolve(iterator.return?.()).catch(() => {});
        if (usesClaudeBridgeBackend(task.workerBackend)) await teardown;
        else void teardown;
      }
      wlog(`task ${taskId} turn complete (${doneReason ?? "ok"}) — ${((Date.now() - startedAt) / 60_000).toFixed(1)}m, ${eventCount} events`);
      return true;
    };

    return await runAgentTurn();
  } catch (err) {
    // Aborted: re-queue only if the agent never saw the message (still in
    // provisioning); once prompted, the message reached the agent and the next
    // turn resumes the session.
    if (signal.aborted) return prompted;
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] task ${taskId} error:`, errorMsg);
    send({ type: "worker_event", taskId, workspaceId, event: { type: "error", message: errorMsg } });
    send({ type: "worker_event", taskId, workspaceId, event: { type: "done", reason: "error" } });
    return true;
  }
}

// ── Ephemeral questions (read-only agent run, no task/worktree-per-question) ──

/** How long a bare-cache refresh stays "fresh": back-to-back questions about the
 * same repo within this window skip the network entirely and reuse the cache. */
const QUESTION_REPO_FRESH_MS = 30_000;
/** Hard cap on any single git op while provisioning a question worktree, so a
 * stalled fetch/checkout fails fast instead of pinning the worker for the whole
 * turn (which is what made one slow checkout reject every later question). */
const QUESTION_GIT_TIMEOUT_MS = 90_000;

/** repo → timestamp (ms) of the last successful bare-cache refresh. */
const repoCacheFreshAt = new Map<string, number>();
/** repo → in-flight refresh, so concurrent questions coalesce into ONE fetch. */
const repoCacheRefreshing = new Map<string, Promise<void>>();
/** repo → chained git-worktree mutation, serialized per repo. `git worktree`
 * locks the bare repo's worktree list, so concurrent add/prune/remove on one
 * repo can fail; this lock is held only for the fast local op, never the turn.
 * Shared by question AND task provisioning (both key by orgRepo name), since
 * task worktrees now provision concurrently too. */
const repoWorktreeLock = new Map<string, Promise<unknown>>();

/** Run a git step with a hard timeout, throwing a clear, phase-labeled error on
 * failure — so a question failure says WHICH git op broke and why (timeout vs.
 * auth vs. other) instead of a raw `Command failed: git …` dump. */
async function gitq(phase: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec("git", args, { timeout: QUESTION_GIT_TIMEOUT_MS });
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; stderr?: string; message?: string };
    if (e.killed || e.signal === "SIGTERM") {
      throw new Error(`${phase} timed out after ${QUESTION_GIT_TIMEOUT_MS / 1000}s (network or GitHub stall)`);
    }
    const detail =
      (e.stderr || e.message || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() || "unknown git error";
    throw new Error(`${phase} failed: ${detail}`);
  }
}

/** Serialize `fn` against other worktree mutations on the same `repo`. */
function withRepoWorktreeLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoWorktreeLock.get(repo) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoWorktreeLock.set(repo, next.then(() => {}, () => {}));
  return next;
}

/** Ensure a bare, blobless cache of `repo` exists and is reasonably current.
 * Concurrent callers share one fetch; a refresh from the last few seconds is
 * reused as-is so a burst of questions doesn't hit the network repeatedly. */
async function ensureQuestionRepoCache(repo: string): Promise<string> {
  const cachedRepo = repoCachePath(repo);
  const inFlight = repoCacheRefreshing.get(repo);
  if (inFlight) {
    await inFlight;
    return cachedRepo;
  }
  const cloned = existsSync(join(cachedRepo, "HEAD"));
  if (cloned && Date.now() - (repoCacheFreshAt.get(repo) ?? 0) < QUESTION_REPO_FRESH_MS) {
    return cachedRepo;
  }
  const refresh = (async () => {
    await mkdir(REPO_CACHE_ROOT, { recursive: true });
    await refreshOrRecloneBareCache(repo, cachedRepo);
    repoCacheFreshAt.set(repo, Date.now());
  })();
  repoCacheRefreshing.set(repo, refresh);
  try {
    await refresh;
  } finally {
    repoCacheRefreshing.delete(repo);
  }
  return cachedRepo;
}

/** Provision a throwaway, read-only checkout of `repo` at its default branch for
 * a SINGLE question. Each question gets its own worktree (keyed by questionId),
 * so concurrent questions about the same repo never collide — they share the bare
 * cache's objects, making the checkout cheap. Detached HEAD so it never clashes
 * with a task worktree that has a branch checked out. Caller removes it. */
async function provisionQuestionWorktree(repo: string, questionId: string): Promise<string> {
  await mkdir(QUESTIONS_ROOT, { recursive: true });
  const cachedRepo = await ensureQuestionRepoCache(repo);
  const baseRef = await worktreeBaseRef(cachedRepo);
  const slug = repo.replace(/[^A-Za-z0-9._-]+/g, "__");
  const worktree = join(QUESTIONS_ROOT, `${slug}-${questionId}`);
  await withRepoWorktreeLock(repo, async () => {
    await gitq("git worktree prune", ["-C", cachedRepo, "worktree", "prune"]);
    await gitq(`git checkout of ${repo}`, ["-C", cachedRepo, "worktree", "add", "--detach", worktree, baseRef]);
  });
  return worktree;
}

/** Tear down a question's throwaway worktree (best-effort — never throws). */
async function removeQuestionWorktree(repo: string, worktree: string): Promise<void> {
  await withRepoWorktreeLock(repo, () =>
    gitq("git worktree remove", ["-C", repoCachePath(repo), "worktree", "remove", "--force", worktree]).catch(() => {}),
  );
  await rm(worktree, { recursive: true, force: true }).catch(() => {});
}

/** Tools available to the question agent beyond its read-only builtins. Today
 * just `post_update`: a way to send the user a short progress note mid-turn (it
 * surfaces in the originating Slack thread), so a multi-step investigation isn't
 * silent until the final answer lands. The frame is relayed by the server to
 * whatever sink the question came from; for non-Slack questions it's dropped. */
function buildQuestionTools(
  send: (msg: unknown) => void,
  questionId: string,
  workspaceId: string,
  repo: string,
  backendId: string,
  repoChatToken: string,
) {
  const postUpdate = defineTool<{ text: string }>({
    name: "post_update",
    description:
      "Send the user a SHORT, one-line progress update while you keep investigating (e.g. \"Checking the migration history…\"). " +
      "Use it when a question takes several steps, so they aren't left waiting. This does NOT end your turn — keep working and give your full answer at the end. Don't use it for the final answer.",
    parameters: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", description: "one-line progress note for the user" } },
    },
    handler: async ({ text }) => {
      const note = (typeof text === "string" ? text : String(text ?? "")).trim();
      if (note) send({ type: "question_update", questionId, text: note.slice(0, 500) });
      return { ok: true };
    },
  });
  const listCards = defineTool<Record<string, never>>({
    name: "list_cards",
    description: "List the active cards in this Manta workspace. Use this to check existing work before creating a duplicate card.",
    parameters: { type: "object", properties: {} },
    handler: async () => workerApi("/repo-chat/list-cards", { workspaceId, repoChatToken }),
  });
  const createCard = defineTool<{
    description: string;
    title?: string;
    repo?: string;
    cardType?: "bot" | "investigation" | "interactive" | "backlog" | "plan";
    workerBackend?: string;
  }>({
    name: "create_card",
    description:
      "Create a Manta card in this workspace when the user asks to delegate or track work. " +
      "Defaults to this chat's repository and model. Check list_cards first when duplicate work is plausible.",
    parameters: {
      type: "object",
      required: ["description"],
      properties: {
        description: { type: "string", description: "Complete instructions for the card's worker" },
        title: { type: "string", description: "Concise card title" },
        repo: { type: "string", description: "Enabled org/repo; defaults to the current chat repo" },
        cardType: { type: "string", enum: ["bot", "investigation", "interactive", "backlog", "plan"] },
        workerBackend: { type: "string", description: "Model backend id; defaults to the current chat model" },
      },
    },
    handler: async (args) => workerApi("/repo-chat/create-card", {
      ...args,
      workspaceId,
      repoChatToken,
      repo: args.repo || repo,
      workerBackend: args.workerBackend || backendId,
    }),
  });
  return [postUpdate, listCards, createCard];
}

function questionPrompt(repo: string, worktree: string, workspaceTools: boolean): string {
  return [
    `You are a Manta read-only investigator in a checkout of ${repo} at ${worktree} (default branch).`,
    "Answer the user's question about THIS codebase. You have read/grep/find/ls and a shell " +
      "(`bash` or `exec_command`, depending on the model) —",
    "use whatever read-only command answers the question: `git log`/`git show`/`git blame` for history,",
    "`psql`/`sqlite3` (with the repo's own connection settings) for database questions, `rg`/`jq`/`wc` for code and data.",
    "STRICTLY READ-ONLY: do NOT modify files, create branches/commits, push, run migrations or writes, or run any",
    "destructive or state-changing command. If a question can only be answered by changing something, say so instead.",
    "If the investigation will take several steps, call post_update with a one-line note so the user sees progress (don't overuse it).",
    ...(workspaceTools
      ? ["You may use list_cards and create_card when the user asks you to inspect, delegate, or track Manta board work. Never create a card unless the user asks for work to be tracked or performed."]
      : []),
    "Be concrete — cite file paths (and line numbers where useful) or command output. If the answer isn't available, say so plainly.",
    "Finish with a direct, self-contained answer; it will be relayed to the user.",
  ].join(" ");
}

async function runQuestion(send: (msg: unknown) => void, msg: RunQuestionMsg): Promise<void> {
  const { questionId, workspaceId, repo, question, backendId, authJson, workspaceToolToken } = msg;
  activeQuestions.add(questionId);
  const startedAt = Date.now();
  // Which step we're in, so a failure says whether the CHECKOUT broke or the
  // agent failed mid-ANSWER — the two need very different follow-ups.
  let phase: "checkout" | "answer" = "checkout";
  let worktree: string | undefined;
  try {
    worktree = await provisionQuestionWorktree(repo, questionId);
    wlog(`question ${questionId} checkout ready in ${Date.now() - startedAt}ms (${repo})`);
    phase = "answer";
    const backendOptions = {
      cwd: worktree,
      builtinTools: QUESTION_TOOLS,
      extensions: true,
      extensionToolAllowlist: QUESTION_EXTENSION_TOOLS,
      // Run on the workspace-vended credentials for the requested model, applied
      // in-memory so we don't overwrite this daemon owner's personal ~/.pi login
      // (questions land on arbitrary members' daemons). Falls back to local auth
      // when the server vended none (dev/single-tenant, or no workspace creds).
      // Intentionally no onAuthChanged here: these creds aren't the daemon
      // owner's, so a rotation must not be pushed back under their identity.
      ...(authJson && typeof authJson === "object"
        ? { resolveAuth: async () => ({ storage: authStorageFromBlob(authJson as AuthBlob) }) }
        : {}),
    };
    const backend: AgentBackend = usesClaudeBridgeBackend(backendId)
      ? new ProcessIsolatedPiBackend(backendOptions)
      : new PiBackend(backendOptions);
    const runAnswerTurn = async (): Promise<string> => {
      let answer = "";
      for await (const event of backend.runTurn({
        systemPrompt: questionPrompt(repo, worktree!, Boolean(workspaceToolToken)),
        message: question,
        tools: workspaceToolToken
          ? buildQuestionTools(send, questionId, workspaceId, repo, backendId, workspaceToolToken)
          : buildQuestionTools(send, questionId, workspaceId, repo, backendId, "").slice(0, 1),
        backend: backendId,
        ctx: { workspaceId, channel: `question:${questionId}` },
      })) {
        if (event.type === "text") answer += event.text;
        send({ type: "question_event", questionId, event });
      }
      return answer;
    };
    const answer = await runAnswerTurn();
    wlog(`question ${questionId} answered in ${Date.now() - startedAt}ms (${repo})`);
    send({ type: "question_done", questionId, answer });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A user-facing, actionable message that names the repo and the failing step.
    const message =
      phase === "checkout"
        ? `couldn't check out ${repo}: ${detail}`
        : `failed while investigating ${repo}: ${detail}`;
    werr(`question ${questionId} failed during ${phase} after ${Date.now() - startedAt}ms: ${detail}`);
    send({ type: "question_error", questionId, message });
  } finally {
    if (worktree) await removeQuestionWorktree(repo, worktree);
    activeQuestions.delete(questionId);
  }
}

// ── One-time pairing ────────────────────────────────────────────────────────

type CredFile = Record<string, { token: string; name?: string }>;

async function loadCredentials(): Promise<CredFile> {
  try { return JSON.parse(await readFile(CRED_PATH, "utf8")) as CredFile; }
  catch { return {}; }
}

async function saveCredential(server: string, token: string): Promise<void> {
  const all = await loadCredentials();
  all[server] = { token, name: hostname() };
  await mkdir(dirname(CRED_PATH), { recursive: true });
  await writeFile(CRED_PATH, JSON.stringify(all, null, 2), { mode: 0o600 });
}

async function clearCredential(server: string): Promise<void> {
  const all = await loadCredentials();
  delete all[server];
  await writeFile(CRED_PATH, JSON.stringify(all, null, 2), { mode: 0o600 }).catch(() => {});
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  exec(cmd, args).catch(() => { /* headless — the URL is printed for manual open */ });
}

/** Run the one-time browser pairing flow. Returns the minted per-user token. */
function pair(): Promise<string> {
  const state = randomBytes(16).toString("hex");
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/cb") { res.writeHead(404); res.end(); return; }
      const token = u.searchParams.get("token");
      if (!token || u.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>Pairing failed</h2><p>Invalid response — you can close this tab.</p>");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>Worker paired ✅</h2><p>You can close this tab and return to the terminal.</p>");
      server.close();
      resolve(token);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const callback = `http://127.0.0.1:${port}/cb`;
      const pairUrl =
        `${SERVER_HTTP}/pair-worker?callback=${encodeURIComponent(callback)}` +
        `&state=${state}&name=${encodeURIComponent(hostname())}`;
      console.log(`\n[worker] One-time pairing — approve in your browser:\n  ${pairUrl}\n`);
      openBrowser(pairUrl);
    });
    setTimeout(() => { server.close(); reject(new Error("pairing timed out after 5 min")); }, 5 * 60_000);
  });
}

/** Populate WORKER_TOKEN from a stored credential, pairing once if absent. */
async function ensureToken(): Promise<void> {
  const creds = await loadCredentials();
  const stored = creds[SERVER_URL]?.token;
  if (stored) {
    WORKER_TOKEN = stored;
    wlog(`using stored credential for ${SERVER_URL}`);
  } else {
    WORKER_TOKEN = await pair();
    await saveCredential(SERVER_URL, WORKER_TOKEN);
    wlog(`paired ✅ — credential saved to ${CRED_PATH}`);
  }
}

/** Acquire a token (pairing if needed), then connect and serve tasks. */
// ── Worker slot (stable id + same-box conflict suffix) ───────────────────────

/** Path of the lockfile this process holds, so we can release it on exit. */
let lockPath: string | null = null;

function releaseWorkerSlot(): void {
  if (!lockPath) return;
  try { unlinkSync(lockPath); } catch { /* already gone */ }
  lockPath = null;
}

function readLockPid(path: string): number {
  try { return parseInt(readFileSync(path, "utf8").trim(), 10) || 0; } catch { return 0; }
}

/** True if a process with this pid is still running (so its lock is real). */
function isPidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; } // exists, just not ours
}

/** Write our pid into `path` with O_EXCL semantics. Returns true on success. */
function tryClaim(path: string): boolean {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    lockPath = path;
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  }
}

/** Claim a stable worker id. Normally returns WORKER_ID_BASE; if another *live*
 * daemon on this box already holds it, suffixes -1, -2… A lock left behind by a
 * dead process (crash, or our own previous run) is reclaimed. An explicit
 * WORKER_ID env override skips locking entirely. */
function acquireWorkerSlot(): string {
  const override = process.env["WORKER_ID"];
  if (override) return override;
  try { mkdirSync(LOCK_DIR, { recursive: true }); } catch { /* best-effort */ }
  for (let i = 0; i < 100; i++) {
    const id = i === 0 ? WORKER_ID_BASE : `${WORKER_ID_BASE}-${i}`;
    const path = join(LOCK_DIR, `${id}.lock`);
    if (tryClaim(path)) return id;
    // Lock exists — reclaim it if its owner is gone, otherwise try the next suffix.
    if (!isPidAlive(readLockPid(path))) {
      try { unlinkSync(path); } catch { /* raced */ }
      if (tryClaim(path)) return id;
    }
  }
  // Should never happen; fall back to a process-unique id rather than block startup.
  return `${WORKER_ID_BASE}-${process.pid}`;
}

async function bootstrap(): Promise<void> {
  WORKER_ID = acquireWorkerSlot();
  if (WORKER_ID !== WORKER_ID_BASE && !process.env["WORKER_ID"]) {
    wlog(`worker id ${WORKER_ID_BASE} already in use on this box — using ${WORKER_ID}`);
  }
  // Release the slot on any clean exit (incl. the self-update exit(42)) so the
  // restarted process reclaims the same id.
  process.on("exit", releaseWorkerSlot);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { releaseWorkerSlot(); process.exit(0); });
  }
  await ensureToken();
  await terminalHost.start();
  connect();
}

// ── `login` command: connect a provider credential (e.g. Codex) ──────────────

/** Read a line from stdin (for OAuth manual-paste fallback / workspace pick). */
async function prompt(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

/** Pick the workspace a captured credential attaches to: MANTA_WORKSPACE_ID,
 * else the user's only workspace, else an interactive choice. */
async function resolveWorkspaceId(): Promise<string> {
  const fromEnv = process.env["MANTA_WORKSPACE_ID"];
  if (fromEnv) return fromEnv;
  const res = await fetch(`${SERVER_HTTP}/api/worker/workspaces`, {
    headers: { "Authorization": `Bearer ${WORKER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`could not list workspaces (${res.status})`);
  const { workspaces } = (await res.json()) as { workspaces: { id: string; name: string }[] };
  if (workspaces.length === 0) throw new Error("you are not a member of any workspace");
  if (workspaces.length === 1) return workspaces[0]!.id;
  console.log("\nSelect a workspace:");
  workspaces.forEach((w, i) => console.log(`  ${i + 1}. ${w.name} (${w.id})`));
  const chosen = workspaces[Number(await prompt("Workspace number: ")) - 1];
  if (!chosen) throw new Error("invalid selection");
  return chosen.id;
}

/** `daemon login codex` — run the ChatGPT Codex OAuth flow on this machine and
 * upload the captured credential to the server (encrypted per workspace). The
 * brain and your workers then run on your Codex subscription. */
async function runCodexLogin(): Promise<void> {
  const workspaceId = await resolveWorkspaceId();
  console.log("\n[worker] Starting ChatGPT Codex login — a browser window will open.");
  const cred = await loginCodex({
    onAuth: ({ url }) => {
      console.log(`\nIf it doesn't open automatically, visit:\n  ${url}\n`);
      openBrowser(url);
    },
    onPrompt: ({ message }) => prompt(`${message} `),
    onProgress: (m) => console.log(`[worker] ${m}`),
  });
  const res = await fetch(`${SERVER_HTTP}/api/worker/providers/openai-codex`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${WORKER_TOKEN}` },
    body: JSON.stringify({ workspaceId, authJson: cred }),
  });
  if (!res.ok) {
    throw new Error(`upload failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  console.log(`\n[worker] ✅ Codex subscription connected for workspace ${workspaceId}.`);
  console.log("[worker] The brain and your workers will use it. Start the daemon normally to serve tasks.");
}

// Reconnect backoff. The cap is deliberately low: a deploy gap is short (the new
// server is reachable within seconds of becoming healthy), so a tall cap just
// makes the worker sleep through dead air after the server is already back — the
// single biggest contributor to the "worker offline for a minute or two after a
// deploy" window. Jitter spreads a fleet's reconnect attempts so they don't
// thunder the ALB in lockstep.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5000;
let globalRetryDelay = RECONNECT_BASE_MS;

// ── Outbound buffer (deploy resilience) ──────────────────────────────────────
// A turn's agent loop captures `send` for its whole life, but the socket under it
// can drop and be replaced mid-turn (server deploy). Buffering progress messages
// at module scope — bound to the *current* socket, not the one a turn captured —
// means events emitted during the ~1-2s reconnect gap are flushed once we
// re-register, instead of being silently dropped (the old `send` no-op'd them).
// Ping and terminal frames are ephemeral and intentionally not buffered (a stale
// terminal session is torn down server-side on disconnect anyway).
let activeSocket: WebSocket | null = null;
// Whether the current socket has completed registration (server knows our owner).
// Messages the server can only act on post-registration (e.g. pi_auth_refreshed,
// which it attributes to the registered owner) must wait for this.
let registeredWithServer = false;
const outbox: unknown[] = [];
/** Cap the buffer so a long outage can't grow it without bound (drop oldest). */
const OUTBOX_MAX = 5000;

/** Append to the reconnect outbox (dropping the oldest past the cap). */
function bufferForServer(msg: unknown): void {
  outbox.push(msg);
  if (outbox.length > OUTBOX_MAX) outbox.shift();
}

function isBufferable(msg: unknown): boolean {
  const type = (msg as { type?: string } | null)?.type ?? "";
  return type !== "ping" && !type.startsWith("terminal_");
}

function sendToServer(msg: unknown): void {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(msg));
  } else if (isBufferable(msg)) {
    bufferForServer(msg);
  }
}

/** Push a rotated OAuth blob back to the server (PiBackend.onAuthChanged). The
 * server persists it to the owning user so its vended copy doesn't go stale and
 * clobber this machine's fresh token on the next dispatch. Buffered until the
 * socket is registered — the server attributes it to the registered owner, so a
 * send before registration would be dropped; flushOutbox replays it after the
 * `registered` ack. */
function pushRefreshedAuthToServer(_workspaceId: string, blob: AuthBlob): void {
  const msg = { type: "pi_auth_refreshed", blob };
  if (registeredWithServer && activeSocket?.readyState === WebSocket.OPEN) sendToServer(msg);
  else bufferForServer(msg);
}

/** Flush buffered messages over the freshly-registered socket, in order. */
function flushOutbox(): void {
  if (outbox.length === 0) return;
  const pending = outbox.splice(0, outbox.length);
  wlog(`flushing ${pending.length} buffered message(s) after reconnect`);
  for (let i = 0; i < pending.length; i++) {
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(JSON.stringify(pending[i]));
    } else {
      // Socket died mid-flush — re-buffer the unsent remainder, in order.
      outbox.unshift(...pending.slice(i));
      break;
    }
  }
}

function connect(): void {
  const wsUrl = `${SERVER_URL}/worker-ws`;
  wlog(`connecting to ${wsUrl}`);
  const ws = new WebSocket(wsUrl);
  activeSocket = ws;
  registeredWithServer = false;
  let connected = false;
  let registered = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  // Route all sends through the module-level buffer so a mid-turn reconnect
  // doesn't lose progress events (see sendToServer above).
  const send = sendToServer;

  const stopHeartbeat = (): void => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  ws.onopen = () => {
    connected = true;
    globalRetryDelay = RECONNECT_BASE_MS;
    wlog("connected — registering");
    void getGitHash(REPO_ROOT).then((gitHash) => {
      send({ type: "register", token: WORKER_TOKEN, workerId: WORKER_ID, version: WORKER_VERSION, gitHash, terminalPort: terminalHost.port, heldTasks: heldTaskIds(), activeTasks: [...draining], caps: ["run_question", "repo_chat"] });
    });
    // Keep the connection from going fully idle. An idle worker sends no traffic,
    // so a proxy in the path (Cloudflare ~100s, ALB idle timeout) would silently
    // drop the socket. A periodic ping keeps it alive; the server replies pong.
    stopHeartbeat();
    heartbeat = setInterval(() => send({ type: "ping" }), 30_000);
  };

  ws.onmessage = (evt: MessageEvent) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof evt.data === "string" ? evt.data : String(evt.data)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg["type"] === "pong") return;

    if (msg["type"] === "registered") {
      registered = true;
      registeredWithServer = true;
      // Flush any progress events buffered while the socket was down (deploy gap).
      flushOutbox();
      // Cloud sandbox: self-start our one task on first registration (the server
      // doesn't dispatch it — the task arrived via env). Follow-up turns still
      // come over the ws as `run_task`, handled below. Guard against re-running
      // on a transient reconnect.
      //
      // Resume/wake mode (MANTA_SANDBOX_RESUME): a previously-stopped box being
      // restarted for a NEW message. The env still holds the ORIGINAL message, so
      // we must NOT replay it — the server forwards the fresh run_task instead
      // (flushed from its pending queue on register). Skip self-start.
      //
      // An empty MANTA_TASK_MESSAGE means we were launched just to wake the box
      // (e.g. the terminal "resume" with no turn) — connect and wait, don't run an
      // empty turn.
      if (SINGLE_TASK && !singleTaskStarted && !process.env["MANTA_SANDBOX_RESUME"] && SINGLE_TASK.message) {
        singleTaskStarted = true;
        const cfg = SINGLE_TASK;
        wlog(`registered — starting task ${cfg.task.id} — "${cfg.task.title}"`);
        runTask(send, { type: "run_task", taskId: cfg.task.id, workspaceId: cfg.workspaceId, message: cfg.message, task: cfg.task })
          .catch((err: unknown) => werr("initial runTask crashed:", err));
        return;
      }
      // Reflect in-flight work on (re)register: after a mid-turn drop the agent
      // keeps running locally and its events buffer until now — so "waiting for
      // tasks" would be a lie. Show what's actually still running.
      const inflight = [...draining];
      wlog(
        inflight.length
          ? `registered — ${inflight.length} task(s) still running locally: ${inflight.join(", ")}`
          : "registered — waiting for tasks",
      );
      return;
    }

    if (msg["type"] === "error") {
      werr(`server error: ${String(msg["message"] ?? "unknown")}`);
      return;
    }

    if (msg["type"] === "sync_pi_auth") {
      syncPiAuth(msg["authJson"])
        .then((synced) => { if (synced) wlog("synced Pi credentials from server"); })
        .catch((err: unknown) => werr("failed to sync Pi credentials:", err));
      return;
    }

    if (msg["type"] === "answer_user_question") {
      const id = String(msg["userQuestionId"] ?? "");
      const resolve = pendingUserQuestionResolvers.get(id);
      if (resolve) {
        pendingUserQuestionResolvers.delete(id);
        resolve(String(msg["answer"] ?? ""));
      }
      return;
    }

    if (msg["type"] === "update") {
      const updateReason = `server requested update (min version: ${String(msg["minVersion"] ?? "?")})`;
      if (workerHasCurrentWork()) {
        wlog(`${updateReason} — worker is busy, will retry update every ${Math.round(SERVER_UPDATE_RETRY_MS / 60_000)}min until idle`);
        pendingServerUpdateReason = updateReason;
        scheduleServerUpdateRetry();
      } else {
        requestWorkerUpdateRestart(updateReason);
      }
      return;
    }

    if (msg["type"] === "run_task" && registered) {
      const runMsg = msg as unknown as RunTaskMsg;
      // Ack receipt immediately so the server can tell a real dispatch landed vs.
      // vanished into a dead socket (the "dispatched but never started" ghost).
      send({ type: "run_task_ack", taskId: runMsg.taskId });
      wlog(`starting task ${runMsg.taskId} — "${runMsg.task.title}"`);
      // Fire-and-forget: the registry marks us busy; done event will free us.
      void (async () => {
        try {
          if (await syncPiAuth(runMsg.authJson)) wlog("synced Pi credentials for task");
        } catch (err) {
          werr("failed to sync Pi credentials for task:", err);
        }
        await runTask(send, runMsg);
      })().catch((err: unknown) => {
        werr(`runTask crashed:`, err);
      });
      return;
    }

    if (msg["type"] === "commit_wip" && registered) {
      const tId = String(msg["taskId"] ?? "");
      const wId = String(msg["workspaceId"] ?? "");
      if (tId) {
        wlog(`commit_wip requested for ${tId} (sandbox spindown)`);
        void commitWip(send, tId, wId).catch((err: unknown) => werr("commitWip crashed:", err));
      }
      return;
    }

    if (msg["type"] === "dispose_task" && registered) {
      const taskId = String(msg["taskId"] ?? "");
      if (taskId) {
        wlog(`disposing task ${taskId} by server request`);
        disposeTask(taskId);
      }
      return;
    }

    if (msg["type"] === "run_question" && registered) {
      const qMsg = msg as unknown as RunQuestionMsg;
      wlog(`answering question ${qMsg.questionId} about ${qMsg.repo}`);
      send({ type: "question_ack", questionId: qMsg.questionId });
      runQuestion(send, qMsg).catch((err: unknown) => {
        werr(`runQuestion crashed:`, err);
        send({ type: "question_error", questionId: qMsg.questionId, message: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    // ── Terminal relay (PTY lives here; frames relayed over /worker-ws) ───────
    if (terminalHost.handleRelayMessage(msg, send)) return;
  };

  ws.onerror = (evt: Event) => {
    // undici surfaces the underlying cause on `.error`; the bare `.message` is
    // usually empty for a proxy-side reset, so log both to see the real cause.
    const err = (evt as { error?: unknown }).error;
    const message = "message" in evt ? (evt as ErrorEvent).message : "";
    werr(`websocket error${message ? `: ${message}` : ""}`, err ?? "");
  };

  ws.onclose = (evt: CloseEvent) => {
    stopHeartbeat();
    // Stop targeting this dead socket; subsequent sends buffer until reconnect.
    if (activeSocket === ws) activeSocket = null;
    registeredWithServer = false;
    // Close code + reason are the single most useful signal for diagnosing drops
    // (1006 = abnormal/no close frame → proxy or network killed it; 1008 = policy).
    wlog(`socket closed (code ${evt.code}${evt.reason ? `, reason: ${evt.reason}` : ""})`);
    if (connected && !registered) {
      // A policy close (1008) is a rejection — EXCEPT version_outdated, which is
      // not an auth problem: the daemon updates itself via the `update` message
      // (or self-update check) instead. Treating it as a rejection here would wipe
      // a perfectly good credential and drop into a human-gated re-pair loop. A
      // transient drop before registration (e.g. 1006 from a proxy) is also not a
      // rejection: fall through to reconnect rather than give up.
      const rejected = evt.code === 1008 && evt.reason !== "version_outdated";
      if (SINGLE_TASK) {
        if (rejected) {
          // Sandbox token revoked (venue spun down) / expired. No pairing to fall
          // back to; exit so Daytona reaps us.
          werr("sandbox token rejected/revoked — exiting");
          process.exit(1);
        }
        // transient pre-registration drop — reconnect below.
      } else if (rejected) {
        // Stored token invalid/revoked — drop it and re-pair (needs a human, so
        // it won't busy-loop).
        werr("registration rejected — re-pairing");
        void (async () => {
          await clearCredential(SERVER_URL);
          WORKER_TOKEN = "";
          await bootstrap();
        })();
        return;
      }
      // else: transient drop before registering — reconnect below.
    }
    // Equal jitter over the current backoff ceiling: half fixed, half random, so
    // attempts land in [ceiling/2, ceiling] — never 0 (no hammering), never all
    // at once (no thundering herd across the fleet).
    const ceiling = globalRetryDelay;
    globalRetryDelay = Math.min(globalRetryDelay * 2, RECONNECT_MAX_MS);
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    wlog(`disconnected — reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
  };
}

const COMMAND = process.argv[2];

async function main(): Promise<void> {
  if (COMMAND === "login") {
    // `node daemon.ts login [codex]` — connect a provider credential, then exit.
    // Only Codex is supported today; the optional second arg is ignored.
    await ensureToken();
    await runCodexLogin();
    process.exit(0);
  }
  // Install Manta's Pi worker extensions once, here at startup — not per turn
  // (passing npm: sources to Pi reinstalls them under /tmp on every reload).
  // Best-effort: a failed install just means workers run with built-in tools.
  setPiExtensionEnvDefaults();
  await ensureConfiguredPiExtensionsInstalled();
  // Cloud sandbox mode: token + task come from env, no pairing.
  SINGLE_TASK = parseSingleTask();
  if (SINGLE_TASK) {
    WORKER_TOKEN = SINGLE_TASK.token;
    startWorktreeCleanup();
    streamBridgeDebugLog();
    console.log(`[worker:${WORKER_ID}] single-task (sandbox) mode — task ${SINGLE_TASK.task.id}, workspace ${SINGLE_TASK.workspaceId}`);
    connect();
    return;
  }
  startWorktreeCleanup();
  // Laptop daemon: wire git to the developer's gh login before any clone/fetch.
  await setupNativeGitAuth();
  startSelfUpdateChecks();
  await bootstrap();
}

console.log(`Manta worker daemon — id: ${WORKER_ID}, server: ${SERVER_URL}`);
void main().catch((err: unknown) => {
  const what = COMMAND === "login" ? "login" : "pairing";
  werr(`${what} failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
