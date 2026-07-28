import { describe, expect, it } from "vitest";
import { githubPrTokenSourceForTask, type GithubUserTokenResult } from "./userTokens.ts";

describe("githubPrTokenSourceForTask", () => {
  it("falls back to the Manta App when a GitHub-linked creator has no saved token", () => {
    const status: GithubUserTokenResult = { token: null, linked: true, reason: "missing" };

    expect(githubPrTokenSourceForTask({ createdBy: "user-1" }, status)).toBe("automation_app");
  });

  it("falls back to the Manta App when the card creator has no linked GitHub", () => {
    const status: GithubUserTokenResult = { token: null, linked: false, reason: "missing" };

    expect(githubPrTokenSourceForTask({ createdBy: "user-1" }, status)).toBe("automation_app");
  });

  it("falls back to the Manta App for ownerless automation tasks", () => {
    const status: GithubUserTokenResult = { token: null, linked: false, reason: "missing" };

    expect(githubPrTokenSourceForTask({ createdBy: null }, status)).toBe("automation_app");
  });

  it("uses the creator user token when available", () => {
    const status: GithubUserTokenResult = { token: "ghu_token", linked: true };

    expect(githubPrTokenSourceForTask({ createdBy: "user-1" }, status)).toBe("creator_user");
  });
});
