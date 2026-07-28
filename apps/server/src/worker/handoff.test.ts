import { describe, expect, it } from "vitest";
import { workerHandoffBody } from "./handoff.ts";

describe("workerHandoffBody", () => {
  it("instructs orchestration to keep work when Linear creation fails", () => {
    const body = workerHandoffBody({
      id: "task-1",
      title: "Investigate Sentry issue",
      repo: "acme/platform",
    }, "Create a follow-up issue for the new regression.");

    expect(body).toContain("call create_task with cardType investigation and no Linear identifier");
    expect(body).toContain("Create a follow-up issue for the new regression.");
  });
});
