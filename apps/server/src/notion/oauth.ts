import { generatePKCE } from "../models/codex-oauth.ts";

export const NOTION_MCP_RESOURCE = "https://mcp.notion.com/mcp";
// RFC 9728: the well-known segment is inserted at the host root with the
// resource path appended, e.g. https://mcp.notion.com/.well-known/oauth-protected-resource/mcp
const PROTECTED_RESOURCE_METADATA_URL = (() => {
  const resource = new URL(NOTION_MCP_RESOURCE);
  const path = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
})();

export interface NotionOAuthSession {
  verifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  tokenEndpoint: string;
  expires: number;
}

export interface NotionOAuthCredential {
  access: string;
  refresh?: string;
  expires?: number;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Notion OAuth request failed (${response.status}): ${detail || response.statusText}`);
  }
  return await response.json() as T;
}

export async function startNotionOAuth(input: { state: string; redirectUri: string }): Promise<{
  authUrl: string;
  session: NotionOAuthSession;
}> {
  const resource = await fetchJson<{ authorization_servers?: unknown }>(PROTECTED_RESOURCE_METADATA_URL);
  const authorizationServer = Array.isArray(resource.authorization_servers) && typeof resource.authorization_servers[0] === "string"
    ? resource.authorization_servers[0]
    : null;
  if (!authorizationServer) throw new Error("Notion OAuth discovery returned no authorization server");

  const metadata = await fetchJson<{
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
    registration_endpoint?: unknown;
  }>(`${authorizationServer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  if (typeof metadata.authorization_endpoint !== "string" || typeof metadata.token_endpoint !== "string" || typeof metadata.registration_endpoint !== "string") {
    throw new Error("Notion OAuth discovery returned incomplete metadata");
  }

  const registered = await fetchJson<{ client_id?: unknown; client_secret?: unknown }>(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Manta",
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (typeof registered.client_id !== "string" || !registered.client_id) {
    throw new Error("Notion OAuth registration returned no client ID");
  }

  const { verifier, challenge } = await generatePKCE();
  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", registered.client_id);
  authUrl.searchParams.set("redirect_uri", input.redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", input.state);
  authUrl.searchParams.set("resource", NOTION_MCP_RESOURCE);

  return {
    authUrl: authUrl.toString(),
    session: {
      verifier,
      clientId: registered.client_id,
      ...(typeof registered.client_secret === "string" ? { clientSecret: registered.client_secret } : {}),
      redirectUri: input.redirectUri,
      tokenEndpoint: metadata.token_endpoint,
      expires: Date.now() + 10 * 60 * 1000,
    },
  };
}

export async function exchangeNotionCode(code: string, session: NotionOAuthSession): Promise<NotionOAuthCredential> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: session.clientId,
    code,
    code_verifier: session.verifier,
    redirect_uri: session.redirectUri,
    resource: NOTION_MCP_RESOURCE,
  });
  if (session.clientSecret) body.set("client_secret", session.clientSecret);
  const response = await fetch(session.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Notion OAuth token exchange failed (${response.status})`);
  const json = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof json.access_token !== "string" || !json.access_token) throw new Error("Notion OAuth returned no access token");
  return {
    access: json.access_token,
    ...(typeof json.refresh_token === "string" ? { refresh: json.refresh_token } : {}),
    ...(typeof json.expires_in === "number" ? { expires: Date.now() + json.expires_in * 1000 } : {}),
    clientId: session.clientId,
    ...(session.clientSecret ? { clientSecret: session.clientSecret } : {}),
    tokenEndpoint: session.tokenEndpoint,
  };
}
