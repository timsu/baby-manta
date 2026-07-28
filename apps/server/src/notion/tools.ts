import { defineTool, type ToolDefinition } from "@manta/agent";
import { workspaces } from "@manta/db";
import { callNotionTool, NotionNotConnectedError } from "./client.ts";

export type NotionToolMode = "read" | "all";

async function invoke(workspaceId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await callNotionTool(workspaceId, name, args);
  } catch (err) {
    if (err instanceof NotionNotConnectedError) return { error: "notion_not_connected", message: err.message };
    return { error: "notion_request_failed", message: err instanceof Error ? err.message : "Notion request failed" };
  }
}

export function buildNotionTools(mode: NotionToolMode = "all"): ToolDefinition[] {
  const instructions = defineTool({
    name: "read_notion_instructions",
    description: "Read this workspace's Notion instructions, including important document links and guidance configured in Settings.",
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      const settings = await workspaces.getSettings(ctx.workspaceId);
      return { instructions: settings.notionInstructions ?? "" };
    },
  });
  const search = defineTool<{ query: string }>({
    name: "search_notion",
    description: "Search the connected Notion workspace and return matching pages and sources.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    handler: (args, ctx) => invoke(ctx.workspaceId, "notion-search", { query: args.query }),
  });
  const fetch = defineTool<{ id: string }>({
    name: "fetch_notion",
    description: "Fetch a Notion page, database, or data source by URL or ID.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string", description: "Notion URL, page ID, database ID, or data source ID" } } },
    handler: (args, ctx) => invoke(ctx.workspaceId, "notion-fetch", { id: args.id }),
  });
  if (mode === "read") return [instructions, search, fetch];

  const createPages = defineTool<{ parent?: Record<string, unknown>; pages: Record<string, unknown>[] }>({
    name: "create_notion_pages",
    description: "Create one or more Notion pages. Use fetch_notion first when creating pages in a database so you have its schema.",
    parameters: {
      type: "object",
      required: ["pages"],
      properties: {
        parent: { type: "object", additionalProperties: true, description: "Optional parent, for example {page_id: ...} or {data_source_id: ...}." },
        pages: { type: "array", items: { type: "object", additionalProperties: true }, description: "Pages with properties and optional Markdown content." },
      },
    },
    handler: (args, ctx) => invoke(ctx.workspaceId, "notion-create-pages", { ...(args.parent ? { parent: args.parent } : {}), pages: args.pages }),
  });
  const updatePage = defineTool<{ pageId: string; command: string; properties?: Record<string, unknown>; newString?: string; selectionWithEllipsis?: string }>({
    name: "update_notion_page",
    description: "Update a Notion page's properties or Markdown content. Fetch the page first before targeted content edits.",
    parameters: {
      type: "object",
      required: ["pageId", "command"],
      properties: {
        pageId: { type: "string" },
        command: { type: "string", description: "Notion update command such as update_properties, replace_content, replace_content_range, or insert_content_after." },
        properties: { type: "object", additionalProperties: true },
        newString: { type: "string", description: "Markdown content used by content update commands." },
        selectionWithEllipsis: { type: "string", description: "Existing content selection for targeted edits." },
      },
    },
    handler: (args, ctx) => invoke(ctx.workspaceId, "notion-update-page", {
      page_id: args.pageId,
      command: args.command,
      ...(args.properties ? { properties: args.properties } : {}),
      ...(args.newString !== undefined ? { new_str: args.newString } : {}),
      ...(args.selectionWithEllipsis ? { selection_with_ellipsis: args.selectionWithEllipsis } : {}),
    }),
  });
  const createComment = defineTool<{ pageId: string; body: string }>({
    name: "create_notion_comment",
    description: "Add a text comment to a Notion page.",
    parameters: { type: "object", required: ["pageId", "body"], properties: { pageId: { type: "string" }, body: { type: "string" } } },
    handler: (args, ctx) => invoke(ctx.workspaceId, "notion-create-comment", {
      parent: { page_id: args.pageId },
      markdown: args.body,
    }),
  });
  return [instructions, search, fetch, createPages, updatePage, createComment];
}
