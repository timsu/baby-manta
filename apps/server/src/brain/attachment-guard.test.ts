import { describe, expect, it } from "vitest";
import { brainTaskTools } from "./tools.ts";

const guardedCtx = {
  workspaceId: "w1",
  channel: "brain",
  currentUserMessage: "looks like it happened again ![screenshot](https://files.example/s.png)",
  visibleAttachmentUrls: ["https://files.example/s.png"],
  ambiguousAttachmentRequest: true,
};

describe("ambiguous attachment escalation guard", () => {
  it("blocks creating worker cards before visible attachment grounding", async () => {
    const tool = brainTaskTools().find((t) => t.name === "create_task")!;
    const res = await tool.handler(
      { repo: "acme/app", title: "It happened again", description: "Please fix it." },
      guardedCtx,
    );
    expect(res).toEqual(expect.objectContaining({ error: expect.stringContaining("visible attachment") }));
  });

  it("blocks Linear issue creation before visible attachment grounding", async () => {
    const tool = brainTaskTools().find((t) => t.name === "create_linear_issue")!;
    const res = await tool.handler(
      { teamId: "team", title: "It happened again", description: "User says it happened again." },
      guardedCtx,
    );
    expect(res).toEqual(expect.objectContaining({ error: expect.stringContaining("visible attachment") }));
  });

});
