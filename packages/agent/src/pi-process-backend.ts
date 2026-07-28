import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import type { AgentEvent } from "@manta/shared";
import type { AgentBackend, RunTurnInput } from "./index.ts";
import { authBlob, type PiBackendOptions } from "./pi-backend.ts";
import {
  errorMessage,
  type IsolatedTurnRpc,
  type IsolatedTurnToParentMessage,
  type ParentToIsolatedTurnMessage,
  type SerializedResolvedAuth,
} from "./pi-process-protocol.ts";

const CHILD_ENTRY = fileURLToPath(new URL("./pi-process-child.ts", import.meta.url));
const ABORT_GRACE_MS = 2_000;
const KILL_GRACE_MS = 2_000;
const activeChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

export interface IsolatedPiChild extends Pick<ChildProcess, "pid" | "connected" | "exitCode" | "signalCode"> {
  send(message: ParentToIsolatedTurnMessage, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "message", listener: (message: IsolatedTurnToParentMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeAllListeners(event?: string | symbol): this;
}

export type IsolatedPiChildFactory = (cwd: string) => IsolatedPiChild;

function signalProcessTree(child: Pick<ChildProcess, "pid" | "kill">, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (platform() !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of activeChildren) signalProcessTree(child, "SIGKILL");
  });
}

function childExecArgv(): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const arg = process.execArgv[index]!;
    // These flags describe the daemon's entrypoint mode and are invalid when
    // fork() launches a real module path. Keep runtime/loader/debug flags.
    if (arg === "--input-type" || arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print") {
      index++;
      continue;
    }
    if (arg.startsWith("--input-type=")) continue;
    args.push(arg);
  }
  if (!args.includes("--experimental-transform-types")) args.push("--experimental-transform-types");
  return args;
}

function defaultChildFactory(cwd: string): IsolatedPiChild {
  installExitHook();
  const env = { ...process.env };
  delete env["MANTA_SANDBOX_TOKEN"];
  delete env["MANTA_TASK"];
  delete env["MANTA_TASK_MESSAGE"];
  const child = fork(CHILD_ENTRY, [], {
    cwd,
    env,
    execArgv: childExecArgv(),
    detached: platform() !== "win32",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  activeChildren.add(child);
  const forgetChild = () => activeChildren.delete(child);
  child.once("exit", forgetChild);
  // A fork that fails during startup can emit error + close without exit.
  // Remove it from the daemon-wide shutdown set on either terminal event.
  child.once("close", forgetChild);
  return child as IsolatedPiChild;
}

function send(child: IsolatedPiChild, message: ParentToIsolatedTurnMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("isolated Pi child IPC channel is closed"));
      return;
    }
    // Like streams, child.send() returns false for backpressure. The callback,
    // not the boolean return, reports whether the queued message was delivered.
    try {
      child.send(message, (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Runs each Pi turn in a fresh OS process. This is used for claude-bridge turns,
 * whose provider registration, active query, CLI session pointer, and cwd are
 * process-global. A process per turn lets different cards run concurrently while
 * keeping those globals physically unable to cross-contaminate one another.
 */
export class ProcessIsolatedPiBackend implements AgentBackend {
  readonly id = "pi-process-isolated";

  constructor(
    private readonly options: PiBackendOptions = {},
    private readonly createChild: IsolatedPiChildFactory = defaultChildFactory,
  ) {}

  supports(backend: string): boolean {
    return backend.startsWith("pi-") || backend === "pi";
  }

  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent, void, void> {
    if (input.signal?.aborted) return;
    const cwd = this.options.cwd ?? process.cwd();
    let child: IsolatedPiChild;
    try {
      child = this.createChild(cwd);
    } catch (error) {
      yield { type: "error", message: `failed to start isolated Pi child: ${errorMessage(error)}` };
      return;
    }
    const events: AgentEvent[] = [];
    let ended = false;
    let completed = false;
    let failureQueued = false;
    let terminationStarted = false;
    let processSettled = false;
    let wake: (() => void) | undefined;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let resolveProcessDone!: () => void;
    const processDone = new Promise<void>((resolve) => { resolveProcessDone = resolve; });

    const notify = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    const queueError = (message: string) => {
      if (failureQueued) return;
      failureQueued = true;
      events.push({ type: "error", message });
      notify();
    };
    const terminateChild = (sendAbort: boolean, termDelayMs: number) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (sendAbort) void send(child, { type: "abort" }).catch(() => {});
      if (terminationStarted) return;
      terminationStarted = true;

      if (termDelayMs === 0) {
        signalProcessTree(child as ChildProcess, "SIGTERM");
      } else {
        termTimer = setTimeout(() => signalProcessTree(child as ChildProcess, "SIGTERM"), termDelayMs);
        termTimer.unref?.();
      }
      if (child.exitCode === null && child.signalCode === null) {
        killTimer = setTimeout(
          () => signalProcessTree(child as ChildProcess, "SIGKILL"),
          termDelayMs + KILL_GRACE_MS,
        );
        killTimer.unref?.();
      }
    };
    const reply = async (id: number, request: IsolatedTurnRpc) => {
      try {
        let value: unknown;
        if (request.kind === "tool") {
          const tool = input.tools.find((candidate) => candidate.name === request.name);
          if (!tool) throw new Error(`isolated Pi child requested unknown tool: ${request.name}`);
          value = await tool.handler(request.args, input.ctx);
        } else if (request.kind === "resolve_auth") {
          const resolved = await this.options.resolveAuth?.(request.workspaceId, request.exclude);
          value = resolved
            ? ({ blob: authBlob(resolved.storage), credentialKeys: resolved.credentialKeys } satisfies SerializedResolvedAuth)
            : null;
        } else if (request.kind === "auth_changed") {
          value = await this.options.onAuthChanged?.(request.workspaceId, request.blob, request.credentialKeys);
        } else if (request.kind === "auth_failure") {
          value = await this.options.onAuthFailure?.(
            request.workspaceId,
            request.backendId,
            request.credentialKeys,
            request.reason,
          );
        } else {
          value = await input.onSession?.(request.sessionKey);
        }
        await send(child, { type: "rpc_result", id, value });
      } catch (error) {
        await send(child, { type: "rpc_error", id, error: errorMessage(error) }).catch(() => {});
      }
    };

    child.on("message", (message) => {
      if (message.type === "event") {
        events.push(message.event);
        notify();
      } else if (message.type === "rpc") {
        void reply(message.id, message.request);
      } else if (message.type === "complete") {
        completed = true;
        // A protocol-level completion means the turn is flushed, but teardown is
        // not complete until the process exits. Terminate now and keep the hard
        // kill armed so descendants cannot overlap a replacement turn.
        terminateChild(false, 0);
      } else if (message.type === "fatal") {
        queueError(message.error);
        terminateChild(false, 0);
      }
    });
    child.on("error", (error) => {
      queueError(`isolated Pi child failed: ${error.message}`);
      terminateChild(false, 0);
    });
    const settleProcess = (code: number | null, signal: NodeJS.Signals | null) => {
      if (processSettled) return;
      processSettled = true;
      // The Node child is the process-group leader. SIGKILL the group before
      // declaring teardown complete so no surviving Claude/extension descendant
      // can keep touching this turn's worktree or session.
      if (platform() !== "win32") signalProcessTree(child as ChildProcess, "SIGKILL");
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (!completed && !failureQueued && !input.signal?.aborted) {
        events.push({
          type: "error",
          message: `isolated Pi child exited before completing (${signal ?? `code ${code ?? "unknown"}`})`,
        });
      }
      ended = true;
      notify();
      resolveProcessDone();
    };
    child.on("exit", settleProcess);
    // A spawn/IPC startup failure may emit error + close without exit. Treat
    // close as the teardown backstop so the event stream cannot hang forever.
    child.on("close", settleProcess);

    const forceStop = () => {
      terminateChild(true, ABORT_GRACE_MS);
    };
    input.signal?.addEventListener("abort", forceStop, { once: true });

    try {
      try {
        await send(child, {
          type: "start",
          options: {
            cwd,
            builtinTools: this.options.builtinTools,
            extensions: this.options.extensions,
            extensionToolAllowlist: this.options.extensionToolAllowlist,
            extensionToolDenylist: this.options.extensionToolDenylist,
            additionalExtensionPaths: this.options.additionalExtensionPaths,
            env: this.options.env,
            hasResolveAuth: Boolean(this.options.resolveAuth),
            hasOnAuthChanged: Boolean(this.options.onAuthChanged),
            hasOnAuthFailure: Boolean(this.options.onAuthFailure),
          },
          input: {
            systemPrompt: input.systemPrompt,
            message: input.message,
            tools: input.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
            backend: input.backend,
            ctx: input.ctx,
            resumeFrom: input.resumeFrom,
            resumeRecentForCwd: input.resumeRecentForCwd,
            hasOnSession: Boolean(input.onSession),
          },
        });
      } catch (error) {
        if (!input.signal?.aborted) queueError(`failed to start isolated Pi child: ${errorMessage(error)}`);
        terminateChild(false, 0);
      }

      while (!ended || events.length > 0) {
        if (events.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
        const event = events.shift();
        if (event) yield event;
      }
    } finally {
      input.signal?.removeEventListener("abort", forceStop);
      // A consumer can call iterator.return() while this generator is suspended
      // at `yield`. Do not clear an already-armed hard-kill deadline in that path;
      // wait until exit/close confirms teardown before resolving return().
      if (child.exitCode === null && child.signalCode === null) terminateChild(false, 0);
      await processDone;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
    }
  }
}
