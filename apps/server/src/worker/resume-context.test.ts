import { describe, expect, it } from "vitest";
import { buildWorkerResumeMessage } from "./resume-context.ts";

const task = {
  title: "Fix admin project links",
  repo: "acme/platform",
  prNumber: null,
  prUrl: null,
  linearIssueIdentifier: null,
};

describe("buildWorkerResumeMessage", () => {
  it("re-sends prior user instructions when resuming a stuck card", () => {
    const msg = buildWorkerResumeMessage(task, [
      { role: "user", content: "Original detailed requirements with /admin/projects specifics" },
      { role: "assistant", content: "Working on it" },
      { role: "user", content: "Also exclude Finished projects from typeahead" },
    ]);

    expect(msg).toContain("previous worker may have disconnected");
    expect(msg).toContain("Current instruction:\nPlease continue where you left off.");
    expect(msg).toContain("Card title: Fix admin project links");
    expect(msg).toContain("### User instruction 1\nOriginal detailed requirements");
    expect(msg).toContain("### User instruction 2\nAlso exclude Finished projects");
  });

  it("includes explicit retry instructions without dropping prior context", () => {
    const msg = buildWorkerResumeMessage(task, [
      { role: "user", content: "Initial task brief" },
    ], "Focus on the failing tests first");

    expect(msg).toContain("Current instruction:\nFocus on the failing tests first");
    expect(msg).toContain("### User instruction 1\nInitial task brief");
  });

  it("does not recursively include prior generated resume prompts", () => {
    const firstResume = buildWorkerResumeMessage(task, [
      { role: "user", content: "Original task brief" },
    ], "Retry with a narrower focus");

    const secondResume = buildWorkerResumeMessage(task, [
      { role: "user", content: "Original task brief" },
      { role: "user", content: firstResume },
    ]);

    expect(secondResume.match(/previous worker may have disconnected/g)).toHaveLength(1);
    expect(secondResume).toContain("### User instruction 1\nOriginal task brief");
    expect(secondResume).toContain("### User instruction 2\nResume instruction: Retry with a narrower focus");
  });
});
