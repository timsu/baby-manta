import type { AgentEvent } from "@manta/shared";
import type { AuthBlob, AuthFailureReason } from "./pi-backend.ts";
import type { ToolContext } from "./index.ts";

export interface SerializablePiBackendOptions {
  cwd: string;
  builtinTools?: string[];
  extensions?: boolean;
  extensionToolAllowlist?: string[];
  extensionToolDenylist?: string[];
  additionalExtensionPaths?: string[];
  env?: Record<string, string>;
  hasResolveAuth: boolean;
  hasOnAuthChanged: boolean;
  hasOnAuthFailure: boolean;
}

export interface SerializableToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface IsolatedTurnStart {
  type: "start";
  options: SerializablePiBackendOptions;
  input: {
    systemPrompt: string;
    message: string;
    tools: SerializableToolDefinition[];
    backend: string;
    ctx: ToolContext;
    resumeFrom?: string;
    resumeRecentForCwd?: boolean;
    hasOnSession: boolean;
  };
}

export type ParentToIsolatedTurnMessage =
  | IsolatedTurnStart
  | { type: "rpc_result"; id: number; value: unknown }
  | { type: "rpc_error"; id: number; error: string }
  | { type: "abort" };

export type IsolatedTurnRpc =
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "resolve_auth"; workspaceId: string; exclude?: string[] }
  | { kind: "auth_changed"; workspaceId: string; blob: AuthBlob; credentialKeys?: string[] }
  | { kind: "auth_failure"; workspaceId: string; backendId: string; credentialKeys: string[]; reason: AuthFailureReason }
  | { kind: "session"; sessionKey: string };

export type IsolatedTurnToParentMessage =
  | { type: "event"; event: AgentEvent }
  | { type: "rpc"; id: number; request: IsolatedTurnRpc }
  | { type: "complete" }
  | { type: "fatal"; error: string };

export interface SerializedResolvedAuth {
  blob: AuthBlob;
  credentialKeys?: string[];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
