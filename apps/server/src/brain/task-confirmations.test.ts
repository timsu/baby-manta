import { describe, it, expect } from "vitest";
import { taskCreationConfirmation } from "./task-confirmations.ts";

describe("taskCreationConfirmation", () => {
  it("uses the canonical repo from the created task instead of any prior assistant wording", () => {
    const text = taskCreationConfirmation([
      {
        id: "c-123abc",
        title: "Fix ENG-5929 confirmation",
        repo: "acme/platform",
        cardStatus: "bot_working",
        taskNumber: 7,
      },
    ]);
    expect(text).toBe("Started worker card #7 (c-123abc) in acme/platform: Fix ENG-5929 confirmation");
    expect(text).not.toContain("acme/manta");
  });

  it("summarizes multiple created cards deterministically", () => {
    const text = taskCreationConfirmation([
      { id: "c-1", title: "One", repo: "acme/api", cardStatus: "bot_working", taskNumber: 1 },
      { id: "c-2", title: "Two", repo: "acme/web", cardStatus: "backlog", taskNumber: 2 },
    ]);
    expect(text).toBe(["Created 2 cards:", "- #1 (c-1) in acme/api: One", "- #2 (c-2) in acme/web: Two"].join("\n"));
  });

  it("reports when an existing card was reused", () => {
    const text = taskCreationConfirmation([
      { id: "c-1", title: "Fix ENG-5994", repo: "acme/api", cardStatus: "needs_help", taskNumber: 3, reusedExisting: true },
    ]);
    expect(text).toBe("Reusing existing worker card #3 (c-1) in acme/api: Fix ENG-5994");
  });
});
