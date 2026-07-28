// Normalized event protocol shared across the agent runtime (Pi / Claude),
// the server, and the web client. The sandbox/agent emits AgentEvents; the
// server persists + fans them out; the web client renders them. `done` is the
// universal terminator (the sandbox service invariant) — never emit a stream without it.

import type { CardStatus, PrCache } from "./kanban.ts";

/** A single streamed event from an agent turn (brain or worker). */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolName: string; argsPreview: string; id?: string }
  | { type: "tool_result"; id?: string; ok: boolean; preview?: string }
  | { type: "context_usage"; tokens: number; contextWindow: number; percent: number }
  | { type: "done"; reason?: TerminalReason; costUsd?: number; durationMs?: number; numTurns?: number }
  | { type: "error"; message: string };

export type TerminalReason =
  | "end_turn"
  | "max_turns"
  | "error"
  | "interrupted"
  | "unknown";

/** Channel identifier for WS multiplexing + message storage. */
export type Channel =
  | "brain"
  | "scout"
  | "support"
  | "style"
  | `perm-${string}`
  | (string & {}); // `<taskId>` for worker channels

/** Client → server WS messages (spec §11.16). */
export type ClientMessage =
  | { type: "switch_target"; target: Channel }
  | { type: "message"; target: Channel; message: string; images?: ChatImage[] }
  | { type: "interrupt"; target: Channel }
  | { type: "answer_question"; target: Channel; answer: string }
  | { type: "set_theme"; themeId: string }
  | { type: "viewing_pr"; prNumber: number; repo: string }
  | { type: "send_peer_dm"; recipientLogin: string; message: string };

/** Server → client WS messages (selected; spec §11.16). */
export type ServerMessage =
  | { type: "history"; channel: Channel; messages: StoredMessage[] }
  | { type: "user_ack"; channel: Channel; message: string }
  | { type: "assistant_chunk"; channel: Channel; text: string }
  | { type: "assistant_done"; channel: Channel; text: string; timestamp: number }
  | { type: "tool_use"; channel: Channel; toolName: string; text: string }
  | { type: "thinking"; channel: Channel; text: string }
  | { type: "worker_message"; taskId: string; message: StoredMessage }
  | { type: "worker_notification"; taskId: string }
  | { type: "ask_user_question"; channel: Channel; questions: AskQuestion[] }
  | { type: "interrupted"; channel: Channel }
  | { type: "error"; channel: Channel; message: string }
  | { type: "task_update"; tasks: unknown[] }
  | { type: "kanban_transition"; taskId: string; cardStatus: CardStatus }
  | { type: "kanban_card_created"; taskId: string }
  | { type: "kanban_pr_refresh"; taskId: string; cardStatus: CardStatus; prCache?: PrCache }
  | { type: "kanban_refreshed" }
  | { type: "update_available"; commits: number }
  | { type: "context_usage_update"; channel: Channel; tokens: number; contextWindow: number; percent: number };

export interface ChatImage {
  /** S3 key (at rest) or data URL (in flight). */
  url: string;
  type?: string;
}

export interface StoredMessage {
  role: "user" | "assistant" | "status" | "system";
  content: string;
  timestamp: number;
  images?: ChatImage[];
}

export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}
