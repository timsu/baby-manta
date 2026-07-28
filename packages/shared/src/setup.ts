// Runs a repo's "Setup commands" in a freshly provisioned worktree (e.g.
// `pnpm install`). Shared by the in-process cloud bot and the BYO-laptop worker
// daemon so both provision identically. The caller decides how to surface
// output (stream live, persist a transcript message) via `onChunk`.

import { spawn } from "node:child_process";

/** Hard cap so a hung setup command (e.g. an interactive prompt) can't wedge a
 * worker forever. Ten minutes comfortably covers a cold `pnpm install`. */
export const SETUP_TIMEOUT_MS = 10 * 60_000;

export interface SetupResult {
  /** Exit code, or null if the process was killed (timeout/signal) or failed to spawn. */
  code: number | null;
  ok: boolean;
  /** Combined stdout+stderr, tail-truncated to keep transcripts bounded. */
  output: string;
  timedOut: boolean;
}

/**
 * Run `commands` in a shell with `cwd` as the working directory. Streams
 * combined stdout+stderr to `onChunk` as it arrives. Never throws — a spawn
 * error or non-zero exit is reported via the returned result so callers can
 * surface it rather than crash the worker.
 */
export function runSetupCommands(
  cwd: string,
  commands: string,
  onChunk: (text: string) => void,
  opts: { timeoutMs?: number; maxOutput?: number } = {},
): Promise<SetupResult> {
  const script = commands.trim();
  const timeoutMs = opts.timeoutMs ?? SETUP_TIMEOUT_MS;
  const maxOutput = opts.maxOutput ?? 16_000;

  return new Promise<SetupResult>((resolve) => {
    if (!script) {
      resolve({ code: 0, ok: true, output: "", timedOut: false });
      return;
    }
    let output = "";
    let timedOut = false;
    const append = (chunk: string) => {
      output += chunk;
      if (output.length > maxOutput) output = output.slice(-maxOutput);
      onChunk(chunk);
    };

    // `bash -lc` so multi-line scripts, &&, pipes, and PATH from the login
    // profile all behave as the user expects when typing them in the UI.
    // `detached` puts the shell in its own process group so a timeout can kill
    // the whole tree (`pnpm` → `node` → …), not just the bash leader.
    const child = spawn("bash", ["-lc", script], {
      cwd,
      detached: true,
      env: {
        ...process.env,
        // pnpm 10.x can crash in fresh git worktrees while destructuring the
        // store integrity verification result. The repo .npmrc disables this,
        // but setup commands may run before/without pnpm discovering .npmrc, so
        // force the same workaround for every setup shell. pnpm reads npm_config_*
        // env vars as config even when no repo-local .npmrc is discovered.
        npm_config_verify_store_integrity: "false",
      },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // Negative pid signals the whole process group. Fall back to the bare
      // child if it's already gone (ESRCH) or group signalling is unavailable.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => append(d.toString()));
    child.stderr.on("data", (d: Buffer) => append(d.toString()));
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      append(`\n${err.message}\n`);
      resolve({ code: null, ok: false, output, timedOut });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) append(`\n⏱️ Setup timed out after ${Math.round(timeoutMs / 1000)}s; killed.\n`);
      resolve({ code, ok: code === 0 && !timedOut, output, timedOut });
    });
  });
}

/** Format a setup run as a transcript message body (fenced output + header). */
export function formatSetupTranscript(script: string, result: SetupResult): string {
  const header = result.ok
    ? "✅ Setup commands completed."
    : result.timedOut
      ? "⏱️ Setup commands timed out."
      : `⚠️ Setup commands failed (exit ${result.code ?? "killed"}).`;
  return `${header}\n\n\`\`\`\n$ ${script.trim()}\n\n${result.output.trim()}\n\`\`\``;
}
