import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSecret, decryptJson, connect, callTool, closeTransport, transportOptions } = vi.hoisted(() => ({
  getSecret: vi.fn(),
  decryptJson: vi.fn(),
  connect: vi.fn(),
  callTool: vi.fn(),
  closeTransport: vi.fn(),
  transportOptions: [] as unknown[],
}));

vi.mock("@manta/db", () => ({
  workspaceSecrets: {
    get: getSecret,
    upsert: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("../secrets/crypto.ts", () => ({ decryptJson, encryptJson: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = connect;
    callTool = callTool;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    close = closeTransport;
    constructor(_url: URL, options: unknown) { transportOptions.push(options); }
  },
}));

import { callNotionTool } from "./client.ts";

describe("callNotionTool", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    transportOptions.length = 0;
    getSecret.mockResolvedValue({ ciphertext: new Uint8Array([1]), meta: {} });
    decryptJson.mockReturnValue({
      access: "stored-access",
      refresh: "refresh-token",
      expires: Date.now() - 1,
      clientId: "client-id",
      tokenEndpoint: "https://notion.example/token",
    });
    connect.mockResolvedValue(undefined);
    callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    closeTransport.mockResolvedValue(undefined);
  });

  it("falls back to the stored access token when refresh fails transiently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    await expect(callNotionTool("ws-1", "notion-search", { query: "handbook" })).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(callTool).toHaveBeenCalledWith({ name: "notion-search", arguments: { query: "handbook" } });
    expect(transportOptions[0]).toEqual({ requestInit: { headers: { Authorization: "Bearer stored-access" } } });
  });
});
