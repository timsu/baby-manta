import { afterEach, describe, expect, it, vi } from "vitest";
import { startNotionOAuth } from "./oauth.ts";

describe("startNotionOAuth discovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches protected-resource metadata from the host-root well-known path", async () => {
    const requested: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      requested.push(url);
      if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return new Response(JSON.stringify({ authorization_servers: ["https://mcp.notion.com"] }), { status: 200 });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(JSON.stringify({
          authorization_endpoint: "https://mcp.notion.com/authorize",
          token_endpoint: "https://mcp.notion.com/token",
          registration_endpoint: "https://mcp.notion.com/register",
        }), { status: 200 });
      }
      if (url.endsWith("/register")) {
        return new Response(JSON.stringify({ client_id: "client-123" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await startNotionOAuth({ state: "state-1", redirectUri: "https://app.example/api/notion/oauth/callback" });

    expect(requested[0]).toBe("https://mcp.notion.com/.well-known/oauth-protected-resource/mcp");
    expect(result.authUrl).toContain("https://mcp.notion.com/authorize");
    expect(result.session.clientId).toBe("client-123");
    fetchMock.mockRestore();
  });
});
