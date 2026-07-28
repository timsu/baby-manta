import { describe, it, expect } from "vitest";
import {
  composeBrainPrompt,
  drainInbox,
  buildTurnInput,
  computeWake,
  shouldCancelSleep,
  planCompaction,
  applyCompaction,
  MAX_SLEEP_SECONDS,
  ATTACHMENT_GROUNDING_PROMPT,
  visibleAttachmentUrls,
  isAmbiguousAttachmentRequest,
  type InboxItem,
  type CompactableMessage,
} from "./lifecycle.ts";

describe("composeBrainPrompt", () => {
  it("includes only non-empty sections, in order", () => {
    const out = composeBrainPrompt({
      basePrompt: "BASE",
      teamMemory: "  ",
      personalMemory: "PERSONAL",
    });
    expect(out).toBe(`BASE\n\n${ATTACHMENT_GROUNDING_PROMPT}\n\n## Personal Preferences (this engineer)\n\nPERSONAL`);
    expect(out).not.toContain("Team Memory");
  });

  it("appends slack context last", () => {
    const out = composeBrainPrompt({
      basePrompt: "BASE",
      slackContext: { channel: "C1", threadTs: "123.45", user: "U9" },
    });
    expect(out.endsWith("[Slack context: channel=C1, thread_ts=123.45, user=U9]")).toBe(true);
  });

  it("includes Slack thread history when available", () => {
    const out = composeBrainPrompt({
      basePrompt: "BASE",
      slackContext: { channel: "C1", threadTs: "123.45", user: "U9", threadMessages: "- <@U1>: context\n- <@U9>: question" },
    });
    expect(out).toContain("[Slack context: channel=C1, thread_ts=123.45, user=U9]");
    expect(out).toContain("## Slack thread history\n\n- <@U1>: context\n- <@U9>: question");
  });

  it("orders base → team → personal → theme → slack", () => {
    const out = composeBrainPrompt({
      basePrompt: "BASE",
      teamMemory: "TEAM",
      personalMemory: "PERSONAL",
      themeBlock: "THEME",
      slackContext: { channel: "C", threadTs: "t", user: "u" },
    });
    const idx = (s: string) => out.indexOf(s);
    expect(idx("BASE")).toBeLessThan(idx("attachment grounding"));
    expect(idx("attachment grounding")).toBeLessThan(idx("TEAM"));
    expect(idx("BASE")).toBeLessThan(idx("TEAM"));
    expect(idx("TEAM")).toBeLessThan(idx("PERSONAL"));
    expect(idx("PERSONAL")).toBeLessThan(idx("THEME"));
    expect(idx("THEME")).toBeLessThan(idx("Slack context"));
  });

  it("includes enabled workspace repositories as actionable context", () => {
    const out = composeBrainPrompt({
      basePrompt: "BASE",
      workspaceRepos: [
        { orgRepo: "acme/api", defaultBranch: "main" },
        { orgRepo: "acme/web", defaultBranch: "develop" },
      ],
    });
    expect(out).toContain("## Workspace repository inventory");
    expect(out).toContain("- acme/api (default branch main)");
    expect(out).toContain("- acme/web (default branch develop)");
    expect(out).toContain("do not ask for a repo that is already identifiable here");
  });
});

describe("drainInbox", () => {
  const item = (id: string, createdAt: number, body = id): InboxItem => ({
    id,
    body,
    source: "poller",
    createdAt,
  });

  it("returns empty for no items", () => {
    expect(drainInbox([])).toEqual({ prependText: "", consumedIds: [] });
  });

  it("orders oldest-first, tie-broken by id, and lists consumed ids", () => {
    const drained = drainInbox([item("b", 200), item("a", 100), item("c", 100)]);
    // a(100) and c(100) tie -> id order a,c ; then b(200)
    expect(drained.consumedIds).toEqual(["a", "c", "b"]);
    expect(drained.prependText).toContain("[Hidden background context from background poller");
    expect(drained.prependText).toContain("lower priority than the current visible user message and attachments");
    expect(drained.prependText).toMatch(/\na\n\n\[Hidden background context[\s\S]*\nc\n\n\[Hidden background context[\s\S]*\nb$/);
  });

  it("buildTurnInput prepends inbox before the user message", () => {
    const drained = drainInbox([item("x", 1, "[STALL] c-1")]);
    expect(buildTurnInput(drained, "hello")).toContain("[STALL] c-1\n\nhello");
    expect(buildTurnInput({ prependText: "", consumedIds: [] }, "hello")).toBe("hello");
  });
});

describe("visible attachment grounding", () => {
  it("detects visible attachment markdown and ambiguous references", () => {
    const message = "looks like it happened again ![screenshot](https://files.example/x.png)";
    expect(visibleAttachmentUrls(message)).toEqual(["https://files.example/x.png"]);
    expect(isAmbiguousAttachmentRequest(message)).toBe(true);
  });

  it("does not flag plain ambiguous text without a visible attachment", () => {
    expect(isAmbiguousAttachmentRequest("looks like it happened again")).toBe(false);
  });
});

describe("computeWake / sleep", () => {
  const now = new Date("2026-05-28T00:00:00.000Z");

  it("clamps to [1, MAX] and computes wake time", () => {
    expect(computeWake(now, 30).seconds).toBe(30);
    expect(computeWake(now, 0).seconds).toBe(1);
    expect(computeWake(now, 99999).seconds).toBe(MAX_SLEEP_SECONDS);
    expect(computeWake(now, 30).wakeAt.toISOString()).toBe("2026-05-28T00:00:30.000Z");
  });

  it("user messages and inbox pushes cancel sleep; wake timer does not", () => {
    expect(shouldCancelSleep("user_message")).toBe(true);
    expect(shouldCancelSleep("inbox_push")).toBe(true);
    expect(shouldCancelSleep("wake_timer")).toBe(false);
  });
});

describe("compaction (§14.3)", () => {
  const mk = (n: number): CompactableMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));

  it("does not compact at or below threshold", () => {
    const plan = planCompaction(mk(150), { threshold: 150, collapse: 50 });
    expect(plan.shouldCompact).toBe(false);
    expect(plan.tail).toHaveLength(150);
  });

  it("collapses oldest N when over threshold and preserves the tail", () => {
    const msgs = mk(151);
    const plan = planCompaction(msgs, { threshold: 150, collapse: 50 });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.toSummarize).toHaveLength(50);
    expect(plan.tail).toHaveLength(101);
    expect(plan.toSummarize[0]?.content).toBe("m0");
    expect(plan.tail[0]?.content).toBe("m50");
  });

  it("applyCompaction prepends a single summary message", () => {
    const plan = planCompaction(mk(151), { threshold: 150, collapse: 50 });
    const out = applyCompaction(plan, "did stuff");
    expect(out).toHaveLength(102); // 1 summary + 101 tail
    expect(out[0]).toEqual({ role: "assistant", content: "## Session summary\n\ndid stuff" });
    expect(out[1]?.content).toBe("m50");
  });

  it("applyCompaction is a no-op passthrough when not compacting", () => {
    const plan = planCompaction(mk(10));
    expect(applyCompaction(plan, "unused")).toHaveLength(10);
  });
});
