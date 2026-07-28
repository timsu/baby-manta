import { describe, expect, it } from "vitest";
import { linearIssueLabelNamesForCreate } from "./tools.ts";

describe("Slack support Linear issue labels", () => {
  it("adds Bug, Support, and On-call triage labels during support triage issue creation", () => {
    expect(linearIssueLabelNamesForCreate({}, true)).toEqual([
      "Bug",
      "Support",
      "On-call triage",
    ]);
  });

  it("preserves additional labels and deduplicates default Slack labels", () => {
    expect(linearIssueLabelNamesForCreate({ labelNames: ["bug", "Billing"] }, true)).toEqual([
      "bug",
      "Billing",
      "Support",
      "On-call triage",
    ]);
  });

  it("does not add support defaults without the support-triage signal", () => {
    expect(linearIssueLabelNamesForCreate({}, false)).toBeUndefined();
    expect(linearIssueLabelNamesForCreate({ labelNames: ["Chore"] }, false)).toEqual(["Chore"]);
  });
});
