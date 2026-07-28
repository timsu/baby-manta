import { describe, it, expect } from "vitest";
import { isQualifying } from "./prComments.ts";

describe("isQualifying", () => {
  it("counts human reviewers", () => {
    expect(isQualifying({ user: { login: "alice", type: "User" } })).toBe(true);
  });

  it("counts the cubic-dev-ai review bot despite being a Bot", () => {
    expect(isQualifying({ user: { login: "cubic-dev-ai[bot]", type: "Bot" } })).toBe(true);
    expect(isQualifying({ user: { login: "cubic-dev-ai", type: "Bot" } })).toBe(true);
  });

  it("excludes other bots (CI, dependabot, our own app replies)", () => {
    expect(isQualifying({ user: { login: "dependabot[bot]", type: "Bot" } })).toBe(false);
    expect(isQualifying({ user: { login: "github-actions[bot]", type: "Bot" } })).toBe(false);
    expect(isQualifying({ user: { login: "manta[bot]", type: "Bot" } })).toBe(false);
  });

  it("excludes unrelated bots whose login merely contains 'cubic'", () => {
    expect(isQualifying({ user: { login: "cubicle-ci[bot]", type: "Bot" } })).toBe(false);
    expect(isQualifying({ user: { login: "my-cubic-helper[bot]", type: "Bot" } })).toBe(false);
  });

  it("excludes comments with no user", () => {
    expect(isQualifying({ user: null })).toBe(false);
    expect(isQualifying({})).toBe(false);
  });
});
