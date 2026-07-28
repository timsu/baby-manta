// PTY terminal sessions, hosted wherever the git worktree physically lives —
// the worker daemon (and the future Daytona single-task worker), NOT the server.
// One long-lived PTY per task terminal; multiple viewers can attach to the same shell
// (broadcast output; first writer wins stdin via shared stdin). Re-connecting
// after a page reload resumes the live session if the shell is still running.
//
// This module is transport-agnostic: callers pass a `TerminalSink` and decide
// how frames reach the viewer (relayed over the daemon's /worker-ws socket, or
// written straight to a direct loopback WebSocket). The PTY itself, the replay
// buffer, and the multi-viewer broadcast live here.

import { accessSync, constants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import type { IPty } from "node-pty";

const SHELL_DIR = join(dirname(fileURLToPath(import.meta.url)), "shell");

/** A frame emitted by a PTY toward a single viewer. Transport decides framing. */
export type TerminalFrame =
  | { type: "output"; data: string }
  | { type: "ready" }
  | { type: "exit"; code?: number };

/** A viewer attached to a PTY. The caller adapts these to its wire format. */
export interface TerminalSink {
  send: (frame: TerminalFrame) => void;
  close: (code?: number, reason?: string) => void;
}

/** Input from a viewer: keystrokes (stdin) or a terminal resize. */
export type TerminalInput =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Thrown by `attach` when the requested worktree path doesn't exist on disk.
 * The caller surfaces this to the viewer instead of silently landing them in a
 * fallback directory (which would look like success but be the wrong shell). */
export class WorktreeMissingError extends Error {
  constructor(public readonly cwd: string) {
    super(`worktree path does not exist: ${cwd}`);
    this.name = "WorktreeMissingError";
  }
}

interface PtySession {
  ptyProcess: IPty;
  outputBuffer: string; // recent output for replay on connect (last 10k chars)
  /** Attached viewers, keyed by sessionId so a specific viewer can detach. */
  clients: Map<string, TerminalSink>;
}

/** Parse `ps` rows and return every descendant pid for a root process. */
export function collectDescendantPids(psOutput: string, rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid <= 0) continue;
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }

  const descendants: number[] = [];
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function getDescendantPids(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    return collectDescendantPids(execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 1024 * 1024,
    }), rootPid);
  } catch {
    return [];
  }
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch { /* already dead or unavailable */ }
}

function killProcessTree(ptyProcess: IPty): void {
  const rootPid = ptyProcess.pid;
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    try { ptyProcess.kill(); } catch { /* already dead */ }
    return;
  }

  const descendantPids = getDescendantPids(rootPid);
  const terminate = (signal: NodeJS.Signals): void => {
    // Kill descendants first so servers started by the shell do not survive when
    // the shell exits without forwarding the signal. Then kill the PTY's process
    // group, which catches normal foreground/background jobs on POSIX systems.
    for (const pid of [...descendantPids].reverse()) killPid(pid, signal);
    if (process.platform !== "win32") killPid(-rootPid, signal);
    killPid(rootPid, signal);
  };

  terminate("SIGTERM");
  try { ptyProcess.kill(); } catch { /* already dead */ }

  const timer = setTimeout(() => terminate("SIGKILL"), 1_000);
  timer.unref?.();
}

// The PTY is an interactive shell any authenticated workspace member can type
// into. It must NOT inherit the host's full environment, or a member could run
// `env` and read worker credentials, provider keys, Slack tokens, etc. Pass only
// the handful of vars a shell legitimately needs to function.
const SAFE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ",
  "TMPDIR", "PWD", "COLORTERM", "TERM_PROGRAM",
];

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOnPath(command: string): string | null {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (canExecute(candidate)) return candidate;
  }
  return null;
}

function resolveShell(): string {
  const configured = process.env["SHELL"]?.trim();
  if (configured) {
    const resolved = configured.includes("/")
      ? (canExecute(configured) ? configured : null)
      : resolveOnPath(configured);
    if (resolved) return resolved;
  }

  for (const candidate of ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh", "sh"]) {
    const resolved = candidate.includes("/")
      ? (canExecute(candidate) ? candidate : null)
      : resolveOnPath(candidate);
    if (resolved) return resolved;
  }

  return "/bin/sh";
}

function buildShellEnv(shell: string, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // Pass through locale (LC_*) which is safe and improves UTF-8 handling.
  for (const [key, v] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && v !== undefined) env[key] = v;
  }
  env["TERM"] = "xterm-256color";
  env["SHELL"] = shell;
  if (shell.endsWith("zsh")) env["ZDOTDIR"] = SHELL_DIR;
  env["MANTA_WORKTREE_ROOT"] = cwd;
  return env;
}

/** Owns the PTYs for one host. Instantiate one per process (the daemon). */
export class TerminalManager {
  private readonly sessions = new Map<string, PtySession>();

  private sessionKey(taskId: string, terminalId = "default"): string {
    return `${taskId}:${terminalId || "default"}`;
  }

  private spawn(taskId: string, cwd: string, terminalId = "default", dims?: { cols: number; rows: number }): PtySession {
    if (!existsSync(cwd)) throw new WorktreeMissingError(cwd);

    const shell = resolveShell();
    // Spawn at the client's actual size so zsh draws its very first prompt at the
    // right width. Spawning at a fixed size and resizing afterward makes zsh issue
    // a relative SIGWINCH redraw that permanently desyncs the client's cursor
    // column (cursor parks on the prompt; completions redraw doubled). Fall back to
    // a conventional 80×24 only when the client didn't supply dimensions.
    const ptyCols = dims && dims.cols >= 1 && dims.cols <= 65535 ? Math.floor(dims.cols) : 80;
    const ptyRows = dims && dims.rows >= 1 && dims.rows <= 65535 ? Math.floor(dims.rows) : 24;
    const session: PtySession = {
      ptyProcess: pty.spawn(shell, [], {
        name: "xterm-256color",
        cwd,
        env: buildShellEnv(shell, cwd),
        cols: ptyCols,
        rows: ptyRows,
      }),
      outputBuffer: "",
      clients: new Map(),
    };
    this.sessions.set(this.sessionKey(taskId, terminalId), session);

    session.ptyProcess.onData((chunk) => {
      session.outputBuffer = (session.outputBuffer + chunk).slice(-10_000);
      for (const sink of session.clients.values()) {
        try { sink.send({ type: "output", data: chunk }); } catch { /* closed */ }
      }
    });

    session.ptyProcess.onExit(({ exitCode }) => {
      this.sessions.delete(this.sessionKey(taskId, terminalId));
      for (const sink of session.clients.values()) {
        try { sink.send({ type: "exit", code: exitCode }); } catch { /* closed */ }
        try { sink.close(1000, "pty exited"); } catch { /* already closed */ }
      }
      session.clients.clear();
    });

    return session;
  }

  /** Attach a viewer to the task's PTY (spawning it on first attach), replay the
   * recent buffer, and send `ready`. Returns a cleanup that detaches this viewer.
   * Throws `WorktreeMissingError` if `cwd` doesn't exist. */
  attach(sink: TerminalSink, taskId: string, cwd: string, sessionId: string, terminalId = "default", dims?: { cols: number; rows: number }): () => void {
    const key = this.sessionKey(taskId, terminalId);
    const session = this.sessions.get(key) ?? this.spawn(taskId, cwd, terminalId, dims);

    if (session.outputBuffer) sink.send({ type: "output", data: session.outputBuffer });
    sink.send({ type: "ready" });
    session.clients.set(sessionId, sink);

    return () => this.detach(taskId, sessionId, terminalId);
  }

  input(taskId: string, msg: TerminalInput, terminalId = "default"): void {
    const session = this.sessions.get(this.sessionKey(taskId, terminalId));
    if (!session) return;
    if (msg.type === "input") {
      session.ptyProcess.write(msg.data);
    } else if (msg.type === "resize") {
      // Dimensions arrive from the client over the wire — validate before handing
      // them to node-pty (winsize fields are unsigned shorts). Reject anything that
      // isn't a positive integer in range, and guard the call since resize can throw.
      const cols = Math.floor(msg.cols);
      const rows = Math.floor(msg.rows);
      if (cols >= 1 && cols <= 65535 && rows >= 1 && rows <= 65535) {
        try { session.ptyProcess.resize(cols, rows); } catch { /* bad geometry / dead pty */ }
      }
    }
  }

  /** Detach one viewer. The PTY stays alive so a reconnecting viewer resumes. */
  detach(taskId: string, sessionId: string, terminalId = "default"): void {
    this.sessions.get(this.sessionKey(taskId, terminalId))?.clients.delete(sessionId);
  }

  /** Kill all of a task's PTYs (e.g. on task completion). */
  killTask(taskId: string): void {
    for (const [key, session] of [...this.sessions]) {
      if (key === taskId || key.startsWith(`${taskId}:`)) {
        for (const sink of session.clients.values()) {
          try { sink.send({ type: "exit" }); } catch { /* closed */ }
          try { sink.close(1000, "task disposed"); } catch { /* already closed */ }
        }
        session.clients.clear();
        killProcessTree(session.ptyProcess);
        this.sessions.delete(key);
      }
    }
  }

  /** Kill every PTY (process shutdown). */
  killAll(): void {
    for (const taskId of [...this.sessions.keys()]) this.killTask(taskId);
  }
}
