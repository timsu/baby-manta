import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import type { ToolDefinition } from "@manta/agent";
import {
  verifySignature,
  shouldAutoRespond,
  autoRespondSkipReason,
  cardPolicySuffix,
  defaultRepoInstruction,
  errorMessage,
  formatSlackThreadMessages,
  leadsWithForeignMention,
  mentionedRepos,
  resolveSlackToolRepo,
  restrictToolsForUnlinkedSlackUser,
  slackUserMessageForTurn,
  unlinkedSlackUserSuffix,
  unlinkedTaskCreationMessage,
  relevanceSuffix,
  autoChannelRelevanceSuffix,
} from "./index.ts";

/** Produce the v0 signature Slack would send for a body signed with `secret`. */
function sign(secret: string, body: string, timestamp: string): string {
  const hmac = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return `v0=${hmac}`;
}

describe("verifySignature (per-bot secret selection)", () => {
  const body = JSON.stringify({ type: "event_callback", api_app_id: "A123" });
  const ts = "1700000000";

  it("accepts a signature made with the matching bot's secret", () => {
    const sig = sign("secretA", body, ts);
    expect(verifySignature("secretA", body, ts, sig)).toBe(true);
  });

  it("rejects a signature when verified against a different bot's secret", () => {
    // A's payload must NOT validate under B's signing secret — this is what keeps
    // multi-bot routing safe: each bot verifies only its own traffic.
    const sigFromA = sign("secretA", body, ts);
    expect(verifySignature("secretB", body, ts, sigFromA)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const sig = sign("secretA", body, ts);
    expect(verifySignature("secretA", body + "x", ts, sig)).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    expect(verifySignature("secretA", body, ts, "")).toBe(false);
    expect(verifySignature("secretA", body, ts, "v0=deadbeef")).toBe(false);
  });
});

describe("shouldAutoRespond (channel gating + app_mention dedupe)", () => {
  const bot = { autoRespondChannels: ["C_WATCHED"], botUserId: "U_BOT" };

  it("responds in a watched channel", () => {
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", text: "help please" })).toBe(true);
  });

  it("ignores channels not on the allowlist", () => {
    expect(shouldAutoRespond(bot, { channel: "C_OTHER", text: "help please" })).toBe(false);
  });

  it("skips messages that @-mention the bot (app_mention handles those)", () => {
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", text: "hey <@U_BOT> help" })).toBe(false);
  });

  it("skips messages addressed to another user (leading @mention that isn't the bot)", () => {
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", text: "<@U_SOMEONE> can you look at this?" })).toBe(false);
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", text: "  <@U_SOMEONE> ping" })).toBe(false);
  });

  it("skips bot messages, subtypes, and empty text", () => {
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", text: "hi", bot_id: "B1" })).toBe(false);
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", text: "hi", subtype: "message_changed" })).toBe(false);
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED" })).toBe(false);
  });

  it("responds to a screenshot post (file_share subtype), even without a caption", () => {
    // Support reports are usually a screenshot with a short caption — or no caption
    // at all. Slack tags these `file_share`; they must NOT be treated as noise.
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", subtype: "file_share", text: "this looks wrong", files: [{ id: "F1" }] })).toBe(true);
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", subtype: "file_share", files: [{ id: "F1" }] })).toBe(true);
  });

  it("with an empty allowlist, never auto-responds (mention/DM only)", () => {
    expect(shouldAutoRespond({ autoRespondChannels: [], botUserId: "U_BOT" }, { channel: "C_WATCHED", text: "hi" })).toBe(false);
  });

  it("responds to a top-level message (thread root: thread_ts === ts)", () => {
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", text: "help please", ts: "100.1", thread_ts: "100.1" })).toBe(true);
  });

  it("skips thread followups unless they @-mention the bot", () => {
    // A reply in an existing thread — stay out of the back-and-forth.
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", text: "any update?", ts: "200.2", thread_ts: "100.1" })).toBe(false);
    // ...unless re-summoned by name (routed via mentions_bot → app_mention).
    expect(shouldAutoRespond(bot, { channel: "C_WATCHED", text: "<@U_BOT> any update?", ts: "200.2", thread_ts: "100.1" })).toBe(false);
  });
});

describe("autoRespondSkipReason (why a channel message was dropped)", () => {
  const bot = { autoRespondChannels: ["C_WATCHED"], botUserId: "U_BOT" };

  it("returns null when the message should be auto-responded", () => {
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", text: "help please" })).toBeNull();
  });

  it("names the gate that dropped each message", () => {
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", text: "hi", bot_id: "B1" })).toBe("bot_message");
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", text: "hi", subtype: "message_changed" })).toBe("subtype");
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED" })).toBe("empty");
    expect(autoRespondSkipReason(bot, { channel: "C_OTHER", text: "help" })).toBe("not_allowlisted");
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", text: "hey <@U_BOT> help" })).toBe("mentions_bot");
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", text: "<@U_SOMEONE> can you look?" })).toBe("foreign_mention");
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", text: "any update?", ts: "200.2", thread_ts: "100.1" })).toBe("thread_reply");
  });

  it("does not skip file_share (screenshot) messages", () => {
    // A captioned screenshot and a bare screenshot both pass the gate.
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", subtype: "file_share", text: "see this", files: [{ id: "F1" }] })).toBeNull();
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", subtype: "file_share", files: [{ id: "F1" }] })).toBeNull();
    // …but a file_share with neither text nor files is still empty.
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", subtype: "file_share" })).toBe("empty");
    // The usual gates still apply to a screenshot post.
    expect(autoRespondSkipReason(bot, { channel: "C_OTHER", subtype: "file_share", files: [{ id: "F1" }] })).toBe("not_allowlisted");
    expect(autoRespondSkipReason(bot, { channel: "C_WATCHED", subtype: "file_share", text: "<@U_SOMEONE> look", files: [{ id: "F1" }] })).toBe("foreign_mention");
  });
});

describe("leadsWithForeignMention", () => {
  it("is true when the message opens by @-mentioning someone else", () => {
    expect(leadsWithForeignMention("<@U_ALICE> can you look at this?", "U_BOT")).toBe(true);
    expect(leadsWithForeignMention("  <@U_ALICE|alice> ping", "U_BOT")).toBe(true);
  });
  it("is false when it opens by mentioning the bot, or doesn't lead with a mention", () => {
    expect(leadsWithForeignMention("<@U_BOT> help", "U_BOT")).toBe(false);
    expect(leadsWithForeignMention("hey <@U_ALICE>", "U_BOT")).toBe(false);
    expect(leadsWithForeignMention("just a plain message", "U_BOT")).toBe(false);
    expect(leadsWithForeignMention(undefined, "U_BOT")).toBe(false);
  });
});

describe("relevance suffixes", () => {
  it("the default suffix tells the brain to bow out of messages not for it", () => {
    expect(relevanceSuffix).toContain("When NOT to reply");
    expect(relevanceSuffix).toContain("Only respond when there's a clear ask for you");
  });

  it("the auto-respond-channel suffix does NOT require being addressed and leans toward acting", () => {
    // The regression we guard against: the conservative ignore-by-default rule
    // overriding a channel's own triage instructions. The auto-channel suffix
    // must invert that — engage even when not addressed by name.
    expect(autoChannelRelevanceSuffix).not.toContain("Only respond when there's a clear ask for you");
    expect(autoChannelRelevanceSuffix).toContain("addressed to you by name");
    expect(autoChannelRelevanceSuffix.toLowerCase()).toContain("lean toward acting");
    // It defers triage policy to per-channel instructions rather than restating it.
    expect(autoChannelRelevanceSuffix).toContain("channel instructions above");
  });
});

describe("cardPolicySuffix", () => {
  it("forbids card creation when policy is 'never'", () => {
    const s = cardPolicySuffix("never");
    expect(s).toContain("Do NOT create cards");
    expect(s).toContain("Never call create_task");
  });

  it("permits the brain to decide when policy is 'auto'", () => {
    const s = cardPolicySuffix("auto");
    expect(s).toContain("create_task");
    expect(s).not.toContain("Do NOT create cards");
  });
});

describe("defaultRepoInstruction", () => {
  it("uses an explicitly configured default repo", () => {
    const s = defaultRepoInstruction("acme/platform", [
      { orgRepo: "acme/manta", enabled: true },
      { orgRepo: "acme/platform", enabled: true },
    ]);
    expect(s).toContain("acme/platform");
    expect(s).not.toContain("acme/manta");
  });

  it("does nothing without an explicit default repo", () => {
    expect(defaultRepoInstruction(null, [{ orgRepo: "acme/platform", enabled: true }])).toBe("");
  });
});

describe("resolveSlackToolRepo", () => {
  const repos = [
    { orgRepo: "acme/manta", enabled: true },
    { orgRepo: "acme/platform", enabled: true },
  ];

  it("uses the Slack bot default repo when the user does not name a repo", () => {
    expect(resolveSlackToolRepo("acme/manta", "acme/platform", repos, "please fix the failing workflow")).toBe("acme/platform");
    expect(resolveSlackToolRepo(undefined, "acme/platform", repos, "please fix the failing workflow")).toBe("acme/platform");
  });

  it("honors a configured repo explicitly named by the user", () => {
    expect(resolveSlackToolRepo("acme/platform", "acme/platform", repos, "please fix acme/manta")).toBe("acme/manta");
    expect(resolveSlackToolRepo("acme/platform", "acme/platform", repos, "please fix manta")).toBe("acme/manta");
  });

  it("does not treat the bot mention label as a repo mention", () => {
    expect(mentionedRepos("<@U123|manta> please fix the failing workflow", repos)).toEqual([]);
    expect(resolveSlackToolRepo("acme/manta", "acme/platform", repos, "<@U123|manta> please fix the failing workflow")).toBe("acme/platform");
  });
});

describe("formatSlackThreadMessages", () => {
  it("formats the full Slack thread and marks the triggering message", () => {
    expect(
      formatSlackThreadMessages(
        [
          { user: "U_ALICE", ts: "1.000", text: "Can someone look at this?" },
          { user: "U_BOB", ts: "2.000", text: "I think it is a frontend issue." },
          { user: "U_CAROL", ts: "3.000", text: "<@U_BOT> can you fix it?" },
        ],
        "3.000",
      ),
    ).toBe(
      [
        "- <@U_ALICE> ts=1.000: Can someone look at this?",
        "- <@U_BOB> ts=2.000: I think it is a frontend issue.",
        "- <@U_CAROL> ts=3.000 (triggering message): <@U_BOT> can you fix it?",
      ].join("\n"),
    );
  });

  it("includes stored Slack images as markdown image references", () => {
    expect(
      formatSlackThreadMessages([
        {
          user: "U_ALICE",
          ts: "1.000",
          text: "Screenshot attached",
          files: [{ title: "failing state.png", mimetype: "image/png", mantaUrl: "/api/images/img_123" }],
        },
      ]),
    ).toBe("- <@U_ALICE> ts=1.000: Screenshot attached ![failing state.png](/api/images/img_123)");
  });
});

describe("slackUserMessageForTurn", () => {
  it("promotes screenshot context into the actual model turn", () => {
    const message = slackUserMessageForTurn("this looks wrong", {
      hasFiles: true,
      threadMessages: "- <@U_ALICE> ts=1.000: this looks wrong ![bug.png](/api/images/img_123)",
    });

    expect(message).toContain("this looks wrong");
    expect(message).toContain("Slack thread context");
    expect(message).toContain("![bug.png](/api/images/img_123)");
  });

  it("gives bare screenshot posts a non-empty user prompt", () => {
    const message = slackUserMessageForTurn("", {
      hasFiles: true,
      threadMessages: "- <@U_ALICE> ts=1.000: ![bug.png](/api/images/img_123)",
    });

    expect(message).toContain("Please triage this Slack message");
    expect(message).toContain("![bug.png](/api/images/img_123)");
  });

  it("still sends a non-empty prompt if Slack file context could not be fetched", () => {
    expect(slackUserMessageForTurn("", { hasFiles: true })).toContain("attached files/screenshots");
  });

  it("leaves ordinary text-only messages unchanged", () => {
    expect(slackUserMessageForTurn("plain question", { hasFiles: false })).toBe("plain question");
  });
});

describe("errorMessage", () => {
  it("includes the error detail, truncated", () => {
    const msg = errorMessage(new Error("boom: upstream 500"));
    expect(msg).toContain("Something went wrong");
    expect(msg).toContain("boom: upstream 500");
  });

  it("handles non-Error throwables", () => {
    expect(errorMessage("plain string")).toContain("plain string");
  });
});

describe("unlinked Slack user handling", () => {
  it("uses invite copy that only gates task spawning", () => {
    const message = unlinkedTaskCreationMessage({ email: "alex@example.com" });
    expect(message).toContain("spawning a worker task needs a linked Manta account");
    expect(message).toContain("alex@example.com");
  });

  it("tells the brain to help fully but not spawn worker tasks", () => {
    const suffix = unlinkedSlackUserSuffix({ email: "alex@example.com" });
    // Full help is allowed — answers and Linear writes included.
    expect(suffix).toContain("Help them fully");
    expect(suffix).toContain("Linear");
    // …only spawning a worker task is gated.
    expect(suffix).toContain("create_task");
    expect(suffix).toContain(unlinkedTaskCreationMessage({ email: "alex@example.com" }));
  });

  it("blocks only worker-spawning tools, leaving answers and Linear writes available", async () => {
    const calls = new Set<string>();
    const make = (name: string): ToolDefinition => ({
      name,
      description: name,
      parameters: { type: "object" },
      handler: async () => {
        calls.add(name);
        return { ok: name };
      },
    });
    const tools = ["create_task", "resurrect_worker", "answer_question", "create_linear_issue", "comment_on_linear_issue"].map(make);

    const restricted = restrictToolsForUnlinkedSlackUser(tools, { email: "alex@example.com" });
    const blocked = { error: "manta_account_required", message: unlinkedTaskCreationMessage({ email: "alex@example.com" }) };
    const run = (name: string) => restricted.find((t) => t.name === name)!.handler({}, { workspaceId: "w", channel: "c" });

    // Worker-spawning tools are blocked.
    await expect(run("create_task")).resolves.toEqual(blocked);
    await expect(run("resurrect_worker")).resolves.toEqual(blocked);
    // Answering and Linear writes go through.
    await expect(run("answer_question")).resolves.toEqual({ ok: "answer_question" });
    await expect(run("create_linear_issue")).resolves.toEqual({ ok: "create_linear_issue" });
    await expect(run("comment_on_linear_issue")).resolves.toEqual({ ok: "comment_on_linear_issue" });
    expect(calls).toEqual(new Set(["answer_question", "create_linear_issue", "comment_on_linear_issue"]));
  });
});
