import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { workspaceSecrets } from "@manta/db";
import { decryptJson, encryptJson } from "../secrets/crypto.ts";
import { createLogger } from "../logger.ts";
import { NOTION_MCP_RESOURCE, type NotionOAuthCredential } from "./oauth.ts";

const logger = createLogger("Manta:Notion");
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_RESULT_CHARS = 40_000;

export class NotionNotConnectedError extends Error {
  constructor() { super("Notion is not connected for this workspace"); }
}

export async function storeNotionCredential(workspaceId: string, credential: NotionOAuthCredential): Promise<void> {
  await workspaceSecrets.upsert({ workspaceId }, "notion_oauth", encryptJson(credential));
}

async function loadNotionCredential(workspaceId: string): Promise<NotionOAuthCredential | null> {
  const stored = await workspaceSecrets.get({ workspaceId }, "notion_oauth");
  if (!stored) return null;
  try {
    return decryptJson<NotionOAuthCredential>(Buffer.from(stored.ciphertext));
  } catch (err) {
    logger.error("failed to decrypt Notion credential", { workspaceId, err });
    return null;
  }
}

async function refreshNotionCredential(workspaceId: string, credential: NotionOAuthCredential): Promise<NotionOAuthCredential> {
  if (!credential.refresh || !credential.expires || credential.expires > Date.now() + REFRESH_SKEW_MS) return credential;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: credential.clientId,
    refresh_token: credential.refresh,
    resource: NOTION_MCP_RESOURCE,
  });
  if (credential.clientSecret) body.set("client_secret", credential.clientSecret);
  const response = await fetch(credential.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Notion OAuth refresh failed (${response.status})`);
  const json = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof json.access_token !== "string" || !json.access_token) throw new Error("Notion OAuth refresh returned no access token");
  const refreshed: NotionOAuthCredential = {
    ...credential,
    access: json.access_token,
    refresh: typeof json.refresh_token === "string" ? json.refresh_token : credential.refresh,
    expires: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1000 : credential.expires,
  };
  await storeNotionCredential(workspaceId, refreshed);
  return refreshed;
}

export async function notionConnected(workspaceId: string): Promise<boolean> {
  return Boolean(await loadNotionCredential(workspaceId));
}

export async function disconnectNotion(workspaceId: string): Promise<void> {
  await workspaceSecrets.remove({ workspaceId }, "notion_oauth");
}

function boundedResult(result: unknown): unknown {
  const json = JSON.stringify(result ?? null);
  return json.length <= MAX_RESULT_CHARS ? result : { truncated: true, preview: json.slice(0, MAX_RESULT_CHARS) };
}

export async function callNotionTool(workspaceId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const stored = await loadNotionCredential(workspaceId);
  if (!stored) throw new NotionNotConnectedError();
  const credential = await refreshNotionCredential(workspaceId, stored).catch((err) => {
    logger.warn("Notion OAuth refresh failed; trying the stored access token", { workspaceId, err });
    return stored;
  });
  const transport = new StreamableHTTPClientTransport(new URL(NOTION_MCP_RESOURCE), {
    requestInit: { headers: { Authorization: `Bearer ${credential.access}` } },
  });
  const client = new Client({ name: "manta", version: "1" });
  try {
    await client.connect(transport);
    return boundedResult(await client.callTool({ name, arguments: args }));
  } finally {
    await transport.close().catch(() => undefined);
  }
}
