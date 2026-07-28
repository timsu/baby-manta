import { describe, expect, it } from "vitest";
import { linearHandoffCommentBody } from "./handoff.ts";

describe("linearHandoffCommentBody", () => {
  it("attributes merged PR handoffs to the exact Manta card and repo", () => {
    expect(linearHandoffCommentBody({
      id: "c-123",
      title: "Fix the worker lifecycle",
      repo: "acme/manta",
      prUrl: "https://github.com/acme/manta/pull/42",
      doneReason: "merged",
    })).toBe(
      'Manta card "Fix the worker lifecycle" (c-123, acme/manta) was marked done after its PR merged: https://github.com/acme/manta/pull/42',
    );
  });

  it("does not claim generic task completion for manually done cards", () => {
    expect(linearHandoffCommentBody({
      id: "c-456",
      title: "Investigate flaky tests",
      repo: "acme/manta",
      prUrl: null,
      doneReason: null,
    })).toBe('Manta card "Investigate flaky tests" (c-456, acme/manta) is marked done in Manta.');
  });
});
