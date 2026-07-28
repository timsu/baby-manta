import { describe, expect, it } from "vitest";
import { prFieldsForReport } from "./prReport.ts";

describe("prFieldsForReport", () => {
  it("adopts the PR title as the card title when a PR is first reported", () => {
    expect(prFieldsForReport("  Fix card title sync  ")).toEqual({
      title: "Fix card title sync",
      prTitle: "Fix card title sync",
    });
  });

  it("keeps the card title synced when re-reporting an existing PR", () => {
    expect(prFieldsForReport("Update PR title")).toEqual({
      title: "Update PR title",
      prTitle: "Update PR title",
    });
  });

  it("rejects blank PR titles", () => {
    expect(prFieldsForReport("   ")).toBeNull();
  });
});
