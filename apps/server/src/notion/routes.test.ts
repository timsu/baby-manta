import { describe, expect, it, vi } from "vitest";

const { isMember, startNotionOAuth, exchangeNotionCode, storeNotionCredential } = vi.hoisted(() => ({
  isMember: vi.fn(async () => true),
  startNotionOAuth: vi.fn(),
  exchangeNotionCode: vi.fn(),
  storeNotionCredential: vi.fn(),
}));

vi.mock("@manta/db", () => ({
  workspaces: {
    isMember,
    getSettings: vi.fn(async () => ({})),
    updateSettings: vi.fn(),
  },
}));
vi.mock("./oauth.ts", () => ({ startNotionOAuth, exchangeNotionCode }));
vi.mock("./client.ts", () => ({
  storeNotionCredential,
  notionConnected: vi.fn(async () => false),
  disconnectNotion: vi.fn(),
}));
vi.mock("../secrets/crypto.ts", () => ({
  encryptJson: (value: unknown) => Buffer.from(JSON.stringify(value)),
  decryptJson: (value: Buffer) => JSON.parse(value.toString("utf8")),
}));

import { createNotionRoutes } from "./routes.ts";

const sessions = {
  verify: vi.fn(async (token: string) => token === "session" ? { sub: "user-1", email: "u@example.com", exp: 9_999_999_999 } : null),
} as never;

describe("Notion OAuth routes", () => {
  it("carries encrypted PKCE state in a cookie so callbacks work across server instances", async () => {
    startNotionOAuth.mockResolvedValue({
      authUrl: "https://notion.example/authorize?state=state-1",
      session: {
        verifier: "verifier",
        clientId: "client",
        redirectUri: "https://manta.example/api/notion/oauth/callback",
        tokenEndpoint: "https://notion.example/token",
        expires: Date.now() + 60_000,
      },
    });
    exchangeNotionCode.mockResolvedValue({ access: "access", clientId: "client", tokenEndpoint: "https://notion.example/token" });

    const firstInstance = createNotionRoutes({ sessions, webAppUrl: "https://manta.example", secureCookies: true });
    const connect = await firstInstance.request("/oauth/connect?ws=ws-1", { headers: { Cookie: "manta_session=session" } });
    expect(connect.status).toBe(302);
    const oauthCookie = connect.headers.get("set-cookie")!;
    const state = startNotionOAuth.mock.calls[0]![0].state as string;

    const secondInstance = createNotionRoutes({ sessions, webAppUrl: "https://manta.example", secureCookies: true });
    const callback = await secondInstance.request(`/oauth/callback?state=${encodeURIComponent(state)}&code=code-1`, {
      headers: { Cookie: `manta_session=session; ${oauthCookie.split(";")[0]}` },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://manta.example/?notion=connected");
    expect(exchangeNotionCode).toHaveBeenCalledWith("code-1", expect.objectContaining({ verifier: "verifier", workspaceId: "ws-1" }));
    expect(storeNotionCredential).toHaveBeenCalledWith("ws-1", expect.objectContaining({ access: "access" }));
    expect(isMember).toHaveBeenCalledWith("user-1", "ws-1");
  });
});
