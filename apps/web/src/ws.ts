// WebSocket client (Phase 5). One socket per active workspace. Routes streamed
// events by channel: "brain" → the brain chat; "<taskId>" → the open task's
// worker transcript. Refreshes the board on kanban pings.

import { $chat, $thinking, $openTaskId, $lastTaskUpdated, $brainContextUsage, $taskContextUsage, $pendingUserQuestions, getTaskChat, setTaskChat, setTaskThinking, type ChatLine, type ContextUsage } from "./stores.ts";
import { clearTaskNotification, noteTaskNotification } from "./lib/appBadge.ts";
import type { AskQuestion } from "@manta/shared";

type TranscriptEntry =
  | { type: "assistant"; text: string }
  | { type: "tool"; tool: string; args: string }
  | { type: "status"; text: string }
  | { type: "thinking"; text: string };

export type ServerMsg =
  | { type: "history"; channel: string; messages: { role: ChatLine["role"]; content: string; meta: { tools?: { tool: string; args: string }[]; transcript?: TranscriptEntry[] } | null }[]; liveEvents?: AgentEventMsg[] }
  | { type: "user_ack"; channel: string; text: string }
  | { type: "event"; channel: string; event: AgentEventMsg }
  | { type: "kanban" }
  | { type: "ask_user_question"; taskId: string; questionId: string; ownerUserId?: string | null; questions: AskQuestion[] }
  | { type: "user_question_resolved"; questionId: string }
  | { type: "history_cleared"; channel: string }
  | { type: "chat_done"; channel: string }
  | { type: "error"; message: string }
  | { type: "context_usage_update"; channel: string; tokens: number; contextWindow: number; percent: number };

type AgentEventMsg =
  | { type: "text"; text: string }
  | { type: "setup"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolName: string; argsPreview: string }
  | { type: "tool_result"; ok: boolean; preview?: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "task_updated" }
  | { type: "worker_notification"; taskId: string }
  | { type: "context_usage"; tokens: number; contextWindow: number; percent: number };

export function hasActiveTurn(liveEvents: AgentEventMsg[] | undefined): boolean {
  if (!liveEvents?.length) return false;
  const lastTerminal = liveEvents.findLast((ev) => ev.type === "done" || ev.type === "error");
  const lastActive = liveEvents.findLast((ev) =>
    ev.type === "text" || ev.type === "thinking" || ev.type === "tool_use" || ev.type === "tool_result"
  );
  return lastActive !== undefined && (lastTerminal === undefined || liveEvents.indexOf(lastActive) > liveEvents.indexOf(lastTerminal));
}

let socket: WebSocket | null = null;
let workspaceId = "";
let onKanban: () => void = () => {};
const subscribed = new Set<string>();
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Per-channel index of the assistant bubble being streamed (-1 = none). */
const streamingIdx: Record<string, number> = {};
/** Per-channel index of the thinking bubble being streamed (-1 = none). */
const streamingThinkingIdx: Record<string, number> = {};
/** Per-channel index of live setup output being streamed (-1 = none). */
const streamingSetupIdx: Record<string, number> = {};

/**
 * Channel-addressed accessors for a transcript. "brain" maps to the single
 * brain atom; every other channel is a task id whose transcript lives in its
 * OWN slot of $taskChats / $taskThinkingByCard. Because each task writes only
 * to its own slot, an event for one card can never mutate another card's view
 * — chats are modular by construction, independent of which card is open.
 */
function target(channel: string) {
  if (channel === "brain") {
    return {
      get: () => $chat.get(),
      set: (lines: ChatLine[]) => $chat.set(lines),
      setThinking: (v: boolean) => $thinking.set(v),
    };
  }
  return {
    get: () => getTaskChat(channel),
    set: (lines: ChatLine[]) => setTaskChat(channel, lines),
    setThinking: (v: boolean) => setTaskThinking(channel, v),
  };
}

export function connectWs(wsId: string, kanbanCb: () => void) {
  workspaceId = wsId;
  onKanban = kanbanCb;
  reconnectDelay = 1_000;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) {
    // Detach onclose first so closing the old socket doesn't schedule a
    // reconnect that races with the fresh connection below (duplicate sockets).
    socket.onclose = null;
    socket.close();
  }
  openSocket();
}

function openSocket() {
  subscribed.clear();
  for (const k of Object.keys(streamingIdx)) delete streamingIdx[k];
  for (const k of Object.keys(streamingThinkingIdx)) delete streamingThinkingIdx[k];
  for (const k of Object.keys(streamingSetupIdx)) delete streamingSetupIdx[k];
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const s = new WebSocket(`${proto}://${location.host}/ws`);
  socket = s;
  s.onopen = () => {
    reconnectDelay = 1_000;
    subscribe("brain");
    const openTaskId = $openTaskId.get();
    if (openTaskId) subscribe(openTaskId);
  };
  s.onmessage = (e) => handle(JSON.parse(e.data as string) as ServerMsg);
  s.onclose = () => scheduleReconnect();
  s.onerror = () => s.close();
}

function scheduleReconnect() {
  if (!workspaceId) return; // never connected
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }, reconnectDelay);
}

function subscribe(channel: string) {
  if (!socket || subscribed.has(channel)) return;
  subscribed.add(channel);
  const fire = () => socket!.send(JSON.stringify({ type: "subscribe", workspaceId, channel }));
  socket.readyState === WebSocket.OPEN ? fire() : socket.addEventListener("open", fire, { once: true });
}

/** Open a task's detail: subscribe to its channel; events route to this card's
 *  own transcript slot. Only this card's state is reset — other cards keep their
 *  in-flight transcripts so switching away and back never loses or mixes them. */
export function openTask(taskId: string) {
  $openTaskId.set(taskId);
  clearTaskNotification(taskId);
  // Reset only THIS card's slot; the incoming history message is the source of
  // truth and will repopulate it. Other cards' slots are untouched.
  setTaskChat(taskId, []);
  setTaskThinking(taskId, false);
  streamingIdx[taskId] = -1;
  streamingThinkingIdx[taskId] = -1;
  streamingSetupIdx[taskId] = -1;
  // Always re-subscribe so history is re-fetched even on repeated opens.
  subscribed.delete(taskId);
  subscribe(taskId);
}

/** Exported for unit tests that drive the router directly. Production code reaches
 *  this only via the socket `onmessage` handler. */
export function handle(m: ServerMsg) {
  if (m.type === "kanban") return onKanban();
  if (m.type === "error") return; // surfaced per-channel via event errors
  if (m.type === "ask_user_question") {
    const existing = $pendingUserQuestions.get().filter((q) => q.questionId !== m.questionId);
    $pendingUserQuestions.set([...existing, { questionId: m.questionId, taskId: m.taskId, ownerUserId: m.ownerUserId ?? null, questions: m.questions }]);
    return;
  }
  if (m.type === "user_question_resolved") {
    $pendingUserQuestions.set($pendingUserQuestions.get().filter((q) => q.questionId !== m.questionId));
    return;
  }
  // Route by channel into that channel's own transcript slot. A previously
  // opened task keeps streaming from the server (we never unsubscribe), but its
  // events land in ITS slot — never the open card's — so nothing leaks across
  // cards regardless of which one is currently in view.
  const t = target(m.channel);
  switch (m.type) {
    case "history": {
      const lines: ChatLine[] = [];
      for (const x of m.messages) {
        if (x.meta?.transcript?.length) {
          for (const entry of x.meta.transcript) {
            if (entry.type === "tool") lines.push({ role: "tool", text: entry.tool, argsPreview: entry.args });
            else if (entry.text) lines.push({ role: entry.type, text: entry.text });
          }
          continue;
        }
        for (const tc of x.meta?.tools ?? []) {
          lines.push({ role: "tool", text: tc.tool, argsPreview: tc.args });
        }
        if (x.content) lines.push({ role: x.role, text: x.content });
      }
      t.set(lines);
      streamingIdx[m.channel] = -1;
      streamingThinkingIdx[m.channel] = -1;
      streamingSetupIdx[m.channel] = -1;
      t.setThinking(hasActiveTurn(m.liveEvents));
      for (const ev of m.liveEvents ?? []) handleEvent(m.channel, ev);
      return;
    }
    case "user_ack":
      t.set([...t.get(), { role: "user", text: m.text }]);
      streamingIdx[m.channel] = -1;
      streamingThinkingIdx[m.channel] = -1;
      streamingSetupIdx[m.channel] = -1;
      return;
    case "history_cleared":
      t.set([]);
      streamingIdx[m.channel] = -1;
      streamingThinkingIdx[m.channel] = -1;
      streamingSetupIdx[m.channel] = -1;
      t.setThinking(false);
      return;
    case "chat_done":
      t.setThinking(false);
      streamingIdx[m.channel] = -1;
      streamingThinkingIdx[m.channel] = -1;
      streamingSetupIdx[m.channel] = -1;
      return;
    case "context_usage_update":
      if (m.channel === "brain") {
        $brainContextUsage.set({ tokens: m.tokens, contextWindow: m.contextWindow, percent: m.percent });
      } else {
        $taskContextUsage.set({
          ...$taskContextUsage.get(),
          [m.channel]: { tokens: m.tokens, contextWindow: m.contextWindow, percent: m.percent },
        });
      }
      return;
    case "event":
      handleEvent(m.channel, m.event);
      return;
  }
}

function handleEvent(channel: string, ev: AgentEventMsg) {
  const t = target(channel);
  const push = (line: ChatLine) => t.set([...t.get(), line]);
  const setTaskContextUsage = (usage: ContextUsage) => {
    if (channel === "brain") return;
    $taskContextUsage.set({ ...$taskContextUsage.get(), [channel]: usage });
  };
  const appendStream = (
    indexMap: Record<string, number>,
    role: Extract<ChatLine["role"], "assistant" | "thinking" | "setup">,
    text: string,
  ) => {
    const lines = t.get();
    const idx = indexMap[channel] ?? -1;
    // Stream indices can become stale when a task is re-opened and history is
    // replaced under us. Only append when the target line is still the same
    // role; otherwise start a fresh bubble/block so setup logs, user acks, and
    // assistant output never bleed into one another.
    if (idx >= 0 && lines[idx]?.role === role) {
      const next = lines.slice();
      next[idx] = { role, text: lines[idx].text + text };
      t.set(next);
    } else {
      indexMap[channel] = lines.length;
      push({ role, text });
    }
  };

  if (ev.type === "thinking") {
    t.setThinking(true);
    streamingSetupIdx[channel] = -1;
    appendStream(streamingThinkingIdx, "thinking", ev.text);
  } else if (ev.type === "text") {
    t.setThinking(true);
    streamingThinkingIdx[channel] = -1;
    streamingSetupIdx[channel] = -1;
    appendStream(streamingIdx, "assistant", ev.text);
  } else if (ev.type === "setup") {
    streamingIdx[channel] = -1;
    streamingThinkingIdx[channel] = -1;
    appendStream(streamingSetupIdx, "setup", ev.text);
  } else if (ev.type === "tool_use") {
    t.setThinking(true);
    streamingThinkingIdx[channel] = -1;
    streamingSetupIdx[channel] = -1;
    push({ role: "tool", text: ev.toolName, argsPreview: ev.argsPreview });
    streamingIdx[channel] = -1;
  } else if (ev.type === "tool_result") {
    const preview = ev.preview?.trim();
    push({ role: "status", text: `Tool result: ${ev.ok ? "ok" : "failed"}${preview ? ` — ${preview}` : ""}` });
    streamingIdx[channel] = -1;
    streamingThinkingIdx[channel] = -1;
    streamingSetupIdx[channel] = -1;
  } else if (ev.type === "done") {
    t.setThinking(false);
    streamingIdx[channel] = -1;
    streamingThinkingIdx[channel] = -1;
    streamingSetupIdx[channel] = -1;
  } else if (ev.type === "error") {
    push({ role: "status", text: `⚠️ ${ev.message}` });
    streamingIdx[channel] = -1;
    streamingThinkingIdx[channel] = -1;
    streamingSetupIdx[channel] = -1;
    t.setThinking(false);
  } else if (ev.type === "task_updated") {
    $lastTaskUpdated.set(channel);
  } else if (ev.type === "worker_notification") {
    noteTaskNotification(ev.taskId);
  } else if (ev.type === "context_usage") {
    setTaskContextUsage({ tokens: ev.tokens, contextWindow: ev.contextWindow, percent: ev.percent });
  }
}

/** Returns false (and sends nothing) when the socket isn't open, so callers can
 *  keep the unsent text in the input instead of silently dropping it. */
export function sendChatWs(message: string): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  $thinking.set(true);
  socket.send(JSON.stringify({ type: "chat", workspaceId, message }));
  return true;
}

/** Reflect a task message accepted by the durable HTTP endpoint in the live
 * transcript. HTTP is used for delivery so navigation cannot close the socket
 * before the server persists the message. */
export function acknowledgeWorkerChat(taskId: string, message: string): void {
  handle({ type: "user_ack", channel: taskId, text: message });
  setTaskThinking(taskId, true);
}

export function answerUserQuestionWs(questionId: string, taskId: string, answer: string): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: "answer_user_question", workspaceId, questionId, taskId, answer }));
  return true;
}

export function dismissUserQuestionWs(questionId: string, taskId: string): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: "dismiss_user_question", workspaceId, questionId, taskId }));
  return true;
}
