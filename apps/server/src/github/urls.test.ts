import { describe, expect, it } from "vitest";
import { parseGitHubPrUrl } from "./urls.ts";

describe("parseGitHubPrUrl", () => {
  it("extracts the repo slug and PR number from GitHub PR URLs", () => {
    expect(parseGitHubPrUrl("https://github.com/acme/manta/pull/123")).toEqual({
      orgRepo: "acme/manta",
      prNumber: 123,
    });
  });

  it("rejects non-PR or non-GitHub URLs", () => {
    expect(parseGitHubPrUrl("https://github.com/acme/manta/issues/123")).toBeNull();
    expect(parseGitHubPrUrl("https://example.com/acme/manta/pull/123")).toBeNull();
    expect(parseGitHubPrUrl("not a url")).toBeNull();
  });
});
