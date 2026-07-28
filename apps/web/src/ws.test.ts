import { beforeEach, describe, expect, it } from "vitest";
import { acknowledgeWorkerChat, handle, hasActiveTurn, openTask, type ServerMsg } from "./ws.ts";
import {
  $chat,
  $thinking,
  $openTaskId,
  $taskChats,
  $taskThinkingByCard,
  getTaskChat,
  getTaskThinking,
} from "./stores.ts";

describe("hasActiveTurn", () => {
  it("treats missing or completed live events as inactive", () => {
    expect(hasActiveTurn(undefined)).toBe(false);
    expect(hasActiveTurn([])).toBe(false);
    expect(hasActiveTurn([{ type: "text", text: "done" }, { type: "done" }])).toBe(false);
    expect(hasActiveTurn([{ type: "tool_use", toolName: "x", argsPreview: "{}" }, { type: "error", message: "failed" }])).toBe(false);
  });

  it("treats unterminated activity events as active", () => {
    expect(hasActiveTurn([{ type: "thinking", text: "hmm" }])).toBe(true);
    expect(hasActiveTurn([{ type: "text", text: "hello" }, { type: "tool_use", toolName: "x", argsPreview: "{}" }])).toBe(true);
  });

  it("ignores non-activity task update events", () => {
    expect(hasActiveTurn([{ type: "task_updated" }])).toBe(false);
  });
});

// ── Card/chat modularity ─────────────────────────────────────────────────────
// Cards and their chats must be absolutely modular: an event for one card may
// never appear in another card's transcript, regardless of which card is open.
// These tests drive the WS router (`handle`) and `openTask` directly against the
// per-card stores. `openTask` only touches store state here (no socket is open,
// so its subscribe call is a no-op).

const ackMsg = (channel: string, text: string): ServerMsg => ({ type: "user_ack", channel, text });
const textEvent = (channel: string, text: string): ServerMsg => ({ type: "event", channel, event: { type: "text", text } });
const historyMsg = (channel: string, contents: string[]): ServerMsg => ({
  type: "history",
  channel,
  messages: contents.map((content) => ({ role: "assistant", content, meta: null })),
});

function assistantTexts(lines: ReturnType<typeof getTaskChat>): string[] {
  return lines.filter((l) => l.role === "assistant").map((l) => l.text);
}

describe("card/chat modularity", () => {
  beforeEach(() => {
    $taskChats.set({});
    $taskThinkingByCard.set({});
    $chat.set([]);
    $thinking.set(false);
    $openTaskId.set(null);
  });

  it("routes a task's stream only into that task's slot, never another card's", () => {
    openTask("A");
    handle(ackMsg("A", "hi A"));
    handle(textEvent("A", "answer for A"));

    // Switch to B. Only B's slot is reset; A keeps its transcript.
    openTask("B");
    expect(getTaskChat("B")).toEqual([]);

    // Late events for A (its worker is still streaming) arrive while B is open.
    handle(textEvent("A", " — still going"));

    // The leak the user reported: A's messages showing up on B. They must NOT.
    expect(getTaskChat("B")).toEqual([]);
    // And A's transcript is intact (and even kept accumulating) in its own slot,
    // so switching back to A shows A's full conversation.
    expect(assistantTexts(getTaskChat("A"))).toEqual(["answer for A — still going"]);
    expect(getTaskChat("A")[0]).toEqual({ role: "user", text: "hi A" });
  });

  it("keeps two cards' in-flight transcripts independent at the same time", () => {
    openTask("A");
    handle(ackMsg("A", "msg A"));
    handle(textEvent("A", "reply A"));

    openTask("B");
    handle(ackMsg("B", "msg B"));
    handle(textEvent("B", "reply B"));

    expect(getTaskChat("A")).toEqual([
      { role: "user", text: "msg A" },
      { role: "assistant", text: "reply A" },
    ]);
    expect(getTaskChat("B")).toEqual([
      { role: "user", text: "msg B" },
      { role: "assistant", text: "reply B" },
    ]);
  });

  it("scopes thinking flags per card", () => {
    handle(textEvent("A", "streaming")); // sets A thinking
    expect(getTaskThinking("A")).toBe(true);
    expect(getTaskThinking("B")).toBe(false);

    handle({ type: "chat_done", channel: "A" });
    expect(getTaskThinking("A")).toBe(false);
  });

  it("shows a durably accepted HTTP message in its card transcript", () => {
    acknowledgeWorkerChat("A", "accepted before navigation");

    expect(getTaskChat("A")).toEqual([{ role: "user", text: "accepted before navigation" }]);
    expect(getTaskThinking("A")).toBe(true);
  });

  it("replaces only the opened card's slot when its history arrives", () => {
    openTask("A");
    handle(ackMsg("A", "old A line"));
    openTask("B");
    handle(ackMsg("B", "B line"));

    // Re-open A; its history is the source of truth and repopulates only A.
    openTask("A");
    handle(historyMsg("A", ["A history one", "A history two"]));

    expect(assistantTexts(getTaskChat("A"))).toEqual(["A history one", "A history two"]);
    // B is untouched by A's history replay.
    expect(getTaskChat("B")).toEqual([{ role: "user", text: "B line" }]);
  });

  it("keeps the brain transcript separate from task transcripts", () => {
    openTask("A");
    handle(ackMsg("brain", "brain question"));
    handle(textEvent("brain", "brain answer"));
    handle(textEvent("A", "task answer"));

    expect($chat.get()).toEqual([
      { role: "user", text: "brain question" },
      { role: "assistant", text: "brain answer" },
    ]);
    expect(assistantTexts(getTaskChat("A"))).toEqual(["task answer"]);
  });
});
