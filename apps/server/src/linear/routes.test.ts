import { describe, expect, it } from "vitest";
import {
  filterLinearIssuesWithoutOwnedCards,
  isLinearBrainInboxEvent,
  isSelfAuthoredLinearWebhook,
  isSlackSyncedLinearComment,
} from "./routes.ts";

describe("filterLinearIssuesWithoutOwnedCards", () => {
  const issues = [
    { identifier: "ENG-1", title: "Mine in Manta" },
    { identifier: "ENG-2", title: "Someone else's Manta card" },
    { identifier: "ENG-3", title: "Unassigned Manta card" },
    { identifier: "ENG-4", title: "No Manta card" },
  ];

  it("only hides Linear issues represented by the current user's Manta cards", () => {
    const filtered = filterLinearIssuesWithoutOwnedCards(issues, [
      { linearIssueIdentifier: "ENG-1", createdBy: "user-1" },
      { linearIssueIdentifier: "ENG-2", createdBy: "user-2" },
      { linearIssueIdentifier: "ENG-3", createdBy: null },
    ], "user-1");

    expect(filtered.map((issue) => issue.identifier)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
  });

  it("hides an issue when any matching card belongs to the current user", () => {
    const filtered = filterLinearIssuesWithoutOwnedCards(issues, [
      { linearIssueIdentifier: "ENG-2", createdBy: "user-2" },
      { linearIssueIdentifier: "ENG-2", createdBy: "user-1" },
    ], "user-1");

    expect(filtered.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-3", "ENG-4"]);
  });
});

describe("isSelfAuthoredLinearWebhook", () => {
  it("detects events whose actor is the Manta Linear app", () => {
    expect(
      isSelfAuthoredLinearWebhook(
        "Issue",
        "create",
        { actor: { id: "app-user" } },
        { title: "Created from Slack" },
        "app-user",
      ),
    ).toBe(true);
  });

  it("detects app-authored comments when Linear omits actor", () => {
    expect(
      isSelfAuthoredLinearWebhook(
        "Comment",
        "create",
        {},
        { body: "Done", user: { id: "app-user" } },
        "app-user",
      ),
    ).toBe(true);
  });

  it("does not treat external actors as self-authored", () => {
    expect(
      isSelfAuthoredLinearWebhook(
        "Issue",
        "update",
        { actor: { id: "human-user" } },
        { creator: { id: "human-user" } },
        "app-user",
      ),
    ).toBe(false);
  });

  it("is disabled when the app user id is unknown", () => {
    expect(
      isSelfAuthoredLinearWebhook(
        "Issue",
        "update",
        { actor: { id: "app-user" } },
        {},
        undefined,
      ),
    ).toBe(false);
  });

  it("does not use immutable issue creator to classify updates", () => {
    expect(
      isSelfAuthoredLinearWebhook(
        "Issue",
        "update",
        { actor: { id: "human-user" } },
        { creator: { id: "app-user" } },
        "app-user",
      ),
    ).toBe(false);
  });
});

describe("isSlackSyncedLinearComment", () => {
  it("detects comments mirrored from a synced Slack thread", () => {
    expect(
      isSlackSyncedLinearComment(
        "Comment",
        "create",
        { actor: { id: "human-user", type: "user", name: "Tim" } },
        {
          body: "@Manta can you take a look?",
          syncedWith: { type: "slack", channelId: "C123", threadTs: "123.45" },
        },
      ),
    ).toBe(true);
  });

  it("detects Slack bot actors serialized by Linear", () => {
    expect(
      isSlackSyncedLinearComment(
        "Comment",
        "create",
        {},
        {
          body: "@Manta can you take a look?",
          botActor: JSON.stringify({ type: "slack", name: "Slack", userDisplayName: "Alex Kim" }),
        },
      ),
    ).toBe(true);
  });

  it("does not classify normal Linear comments as Slack-synced", () => {
    expect(
      isSlackSyncedLinearComment(
        "Comment",
        "create",
        { actor: { id: "human-user", type: "user", name: "Tim" } },
        { body: "@Manta can you take a look?", user: { id: "human-user" } },
      ),
    ).toBe(false);
  });

  it("only applies to created comments", () => {
    expect(
      isSlackSyncedLinearComment(
        "Issue",
        "update",
        { actor: { type: "slack", name: "Slack" } },
        { syncedWith: { type: "slack" } },
      ),
    ).toBe(false);
  });
});

describe("isLinearBrainInboxEvent", () => {
  it("summarizes issue and label changes into the brain inbox", () => {
    expect(isLinearBrainInboxEvent("Issue", "create")).toBe(true);
    expect(isLinearBrainInboxEvent("Issue", "update")).toBe(true);
    expect(isLinearBrainInboxEvent("IssueLabel", "create")).toBe(true);
  });

  it("does not summarize comments without the explicit mention path", () => {
    expect(isLinearBrainInboxEvent("Comment", "create")).toBe(false);
  });
});
