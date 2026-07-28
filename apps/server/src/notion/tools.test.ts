import { beforeEach, describe, expect, it, vi } from "vitest";

const { callNotionTool, getSettings } = vi.hoisted(() => ({
  callNotionTool: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("./client.ts", () => ({
  callNotionTool,
  NotionNotConnectedError: class NotionNotConnectedError extends Error {
    constructor() { super("Notion is not connected for this workspace"); }
  },
}));
vi.mock("@manta/db", () => ({ workspaces: { getSettings } }));

import { buildNotionTools } from "./tools.ts";

describe("buildNotionTools", () => {
  beforeEach(() => {
    callNotionTool.mockReset();
    getSettings.mockReset();
  });

  it("limits read-only surfaces to instructions, search, and fetch", () => {
    expect(buildNotionTools("read").map((tool) => tool.name)).toEqual([
      "read_notion_instructions",
      "search_notion",
      "fetch_notion",
    ]);
  });

  it("reads workspace Notion instructions without requiring a connection", async () => {
    getSettings.mockResolvedValue({ notionInstructions: "Important docs: https://notion.so/handbook" });
    const tool = buildNotionTools().find((candidate) => candidate.name === "read_notion_instructions")!;
    await expect(tool.handler({}, { workspaceId: "ws-1" } as never)).resolves.toEqual({
      instructions: "Important docs: https://notion.so/handbook",
    });
    expect(getSettings).toHaveBeenCalledWith("ws-1");
  });

  it("maps the friendly comment tool to the hosted Notion MCP schema", async () => {
    callNotionTool.mockResolvedValue({ ok: true });
    const tool = buildNotionTools().find((candidate) => candidate.name === "create_notion_comment")!;
    await tool.handler({ pageId: "page-1", body: "Ship **today**" }, { workspaceId: "ws-1" } as never);
    expect(callNotionTool).toHaveBeenCalledWith("ws-1", "notion-create-comment", {
      parent: { page_id: "page-1" },
      markdown: "Ship **today**",
    });
  });

  it("returns a stable not-connected error for agents", async () => {
    const NotionNotConnectedError = (await import("./client.ts")).NotionNotConnectedError;
    callNotionTool.mockRejectedValue(new NotionNotConnectedError());
    const tool = buildNotionTools().find((candidate) => candidate.name === "search_notion")!;
    await expect(tool.handler({ query: "handbook" }, { workspaceId: "ws-1" } as never)).resolves.toEqual({
      error: "notion_not_connected",
      message: "Notion is not connected for this workspace",
    });
  });
});
