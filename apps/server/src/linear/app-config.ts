// Per-workspace Linear OAuth *app* credentials.
//
// Linear is a bring-your-own-app connector: each workspace registers its own
// Linear OAuth application (in its own Linear workspace, with actor=app) and
// stores the resulting clientId / clientSecret / webhookSecret here. These drive
// that workspace's "Connect Linear" OAuth flow, token refresh, and webhook
// signature verification. Stored encrypted in WorkspaceSecret(kind=linear_app);
// the per-workspace OAuth *token* is a separate secret (kind=linear_oauth).

import { workspaceSecrets } from "@manta/db";
import { encryptJson, decryptJson } from "../secrets/crypto.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:Linear");
const KIND = "linear_app" as const;

export interface LinearAppConfig {
  clientId: string;
  clientSecret: string;
  /** Webhook signing secret; optional (a workspace may not use webhooks). */
  webhookSecret?: string;
}

/** Decrypt the workspace's Linear app credentials, or null when not configured. */
export async function getLinearAppConfig(workspaceId: string): Promise<LinearAppConfig | null> {
  const row = await workspaceSecrets.get({ workspaceId }, KIND);
  if (!row) return null;
  try {
    return decryptJson<LinearAppConfig>(Buffer.from(row.ciphertext));
  } catch (err) {
    logger.error("failed to decrypt linear app config", { workspaceId, err });
    return null;
  }
}

/** Store/replace a workspace's Linear app credentials. */
export async function setLinearAppConfig(workspaceId: string, cfg: LinearAppConfig): Promise<void> {
  // meta carries only the non-secret clientId so the UI/status can confirm which
  // app is wired without decrypting the blob.
  await workspaceSecrets.upsert({ workspaceId }, KIND, encryptJson(cfg), {
    clientId: cfg.clientId,
    hasWebhookSecret: Boolean(cfg.webhookSecret),
  });
}

/** Forget a workspace's Linear app credentials. */
export async function clearLinearAppConfig(workspaceId: string): Promise<void> {
  await workspaceSecrets.remove({ workspaceId }, KIND);
}
