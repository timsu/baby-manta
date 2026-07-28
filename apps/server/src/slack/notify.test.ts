import { describe, expect, it } from "vitest";
import { buildSlackNotificationMessage } from "./notify.ts";

describe("buildSlackNotificationMessage", () => {
  it("posts a linked PR merge follow-up for Slack-originated merged cards", () => {
    expect(
      buildSlackNotificationMessage({
        status: "done",
        title: "Fix worker lifecycle",
        prUrl: "https://github.com/acme/manta/pull/42",
        prTitle: "Fix worker lifecycle notifications",
        doneReason: "merged",
      }),
    ).toBe(":white_check_mark: PR <https://github.com/acme/manta/pull/42|Fix worker lifecycle notifications> was merged");
  });

  it("falls back to the card title when a merged PR title is unavailable", () => {
    expect(
      buildSlackNotificationMessage({
        status: "done",
        title: "Fix worker lifecycle",
        prUrl: "https://github.com/acme/manta/pull/42",
        prTitle: null,
        doneReason: "merged",
      }),
    ).toBe(":white_check_mark: PR <https://github.com/acme/manta/pull/42|Fix worker lifecycle> was merged");
  });

  it("keeps the existing done message for non-merge completions", () => {
    expect(
      buildSlackNotificationMessage({
        status: "done",
        title: "Write release notes",
        prUrl: "https://github.com/acme/manta/pull/43",
        prTitle: "Release notes",
        doneReason: "completed",
      }),
    ).toBe(":white_check_mark: *Write release notes* is done! PR: https://github.com/acme/manta/pull/43");
  });
});
