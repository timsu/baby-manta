import { authStorageFromBlob, PiBackend } from "./pi-backend.ts";
import type { ToolDefinition } from "./index.ts";
import {
  errorMessage,
  type IsolatedTurnRpc,
  type IsolatedTurnStart,
  type IsolatedTurnToParentMessage,
  type ParentToIsolatedTurnMessage,
  type SerializedResolvedAuth,
} from "./pi-process-protocol.ts";

let nextRpcId = 1;
const pendingRpc = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const abortController = new AbortController();
let started = false;

function send(message: IsolatedTurnToParentMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("isolated Pi parent IPC channel is closed"));
      return;
    }
    // A false return means the IPC backlog crossed its high-water mark, not that
    // the message was dropped. The callback is the delivery/error signal.
    try {
      process.send(message, (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

function rpc<T>(request: IsolatedTurnRpc): Promise<T> {
  const id = nextRpcId++;
  return new Promise<T>((resolve, reject) => {
    pendingRpc.set(id, { resolve: resolve as (value: unknown) => void, reject });
    void send({ type: "rpc", id, request }).catch((error) => {
      pendingRpc.delete(id);
      reject(error);
    });
  });
}

async function run(start: IsolatedTurnStart): Promise<void> {
  const { options, input } = start;
  const tools: ToolDefinition[] = input.tools.map((tool) => ({
    ...tool,
    handler: (args) => rpc({ kind: "tool", name: tool.name, args }),
  }));
  const backend = new PiBackend({
    cwd: options.cwd,
    builtinTools: options.builtinTools,
    extensions: options.extensions,
    extensionToolAllowlist: options.extensionToolAllowlist,
    extensionToolDenylist: options.extensionToolDenylist,
    additionalExtensionPaths: options.additionalExtensionPaths,
    env: options.env,
    ...(options.hasResolveAuth
      ? {
          resolveAuth: async (workspaceId: string, exclude?: string[]) => {
            const resolved = await rpc<SerializedResolvedAuth | null>({ kind: "resolve_auth", workspaceId, exclude });
            return resolved ? { storage: authStorageFromBlob(resolved.blob), credentialKeys: resolved.credentialKeys } : null;
          },
        }
      : {}),
    ...(options.hasOnAuthChanged
      ? { onAuthChanged: (workspaceId, blob, credentialKeys) => rpc({ kind: "auth_changed", workspaceId, blob, credentialKeys }) }
      : {}),
    ...(options.hasOnAuthFailure
      ? { onAuthFailure: (workspaceId, backendId, credentialKeys, reason) => rpc({ kind: "auth_failure", workspaceId, backendId, credentialKeys, reason }) }
      : {}),
  });

  for await (const event of backend.runTurn({
    systemPrompt: input.systemPrompt,
    message: input.message,
    tools,
    backend: input.backend,
    ctx: input.ctx,
    resumeFrom: input.resumeFrom,
    resumeRecentForCwd: input.resumeRecentForCwd,
    signal: abortController.signal,
    ...(input.hasOnSession
      ? { onSession: (sessionKey: string) => rpc({ kind: "session", sessionKey }) }
      : {}),
  })) {
    await send({ type: "event", event });
  }
}

process.on("message", (raw: ParentToIsolatedTurnMessage) => {
  if (raw.type === "abort") {
    abortController.abort();
    return;
  }
  if (raw.type === "rpc_result" || raw.type === "rpc_error") {
    const pending = pendingRpc.get(raw.id);
    if (!pending) return;
    pendingRpc.delete(raw.id);
    if (raw.type === "rpc_error") pending.reject(new Error(raw.error));
    else pending.resolve(raw.value);
    return;
  }
  if (raw.type !== "start" || started) return;
  started = true;
  void run(raw)
    .then(() => send({ type: "complete" }))
    .catch((error) => send({ type: "fatal", error: errorMessage(error) }))
    .finally(() => {
      process.disconnect?.();
      process.exit(0);
    });
});

process.on("disconnect", () => {
  abortController.abort();
  for (const pending of pendingRpc.values()) pending.reject(new Error("isolated Pi parent disconnected"));
  pendingRpc.clear();
});
