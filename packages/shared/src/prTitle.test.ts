import { describe, expect, it } from "vitest";
import { formatPrTitleWithLinearIssue } from "./prTitle.ts";

describe("formatPrTitleWithLinearIssue", () => {
  it("prefixes a PR title with the linked Linear issue identifier", () => {
    expect(formatPrTitleWithLinearIssue("Add webhook retry handling", "MANTA-123"))
      .toBe("MANTA-123: Add webhook retry handling");
  });

  it("does not duplicate an identifier already present in the title", () => {
    expect(formatPrTitleWithLinearIssue("[MANTA-123] Add webhook retry handling", "MANTA-123"))
      .toBe("[MANTA-123] Add webhook retry handling");
  });

  it("leaves unlinked PR titles unchanged", () => {
    expect(formatPrTitleWithLinearIssue("Add webhook retry handling", null))
      .toBe("Add webhook retry handling");
  });
});
