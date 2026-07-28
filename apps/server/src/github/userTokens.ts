import { prisma, userSecrets, type Task } from "@manta/db";
import { config } from "../config.ts";
import { decrypt, encrypt } from "../secrets/crypto.ts";

interface GithubTokenMeta {
  login?: string;
  githubUserId?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
}

interface GithubTokenBundle {
  accessToken: string;
  refreshToken?: string;
}

export interface GithubUserTokenResult {
  token: string | null;
  /** True when the user has linked GitHub, even if the token is currently unusable. */
  linked: boolean;
  reason?: "missing" | "expired" | "decrypt_failed" | "refresh_failed";
}

export function githubPrTokenSourceForTask(
  task: Pick<Task, "createdBy">,
  status: GithubUserTokenResult,
): "creator_user" | "automation_app" {
  if (status.token) return "creator_user";
  void task;
  return "automation_app";
}

export function encryptGithubUserToken(accessToken: string, refreshToken?: string): Uint8Array {
  const bundle = { accessToken, ...(refreshToken ? { refreshToken } : {}) };
  return encrypt(JSON.stringify(bundle));
}

function decodeTokenBundle(ciphertext: Uint8Array): GithubTokenBundle {
  const plaintext = decrypt(Buffer.from(ciphertext));
  try {
    const parsed = JSON.parse(plaintext) as Partial<GithubTokenBundle>;
    if (typeof parsed.accessToken === "string" && parsed.accessToken) {
      return {
        accessToken: parsed.accessToken,
        ...(typeof parsed.refreshToken === "string" && parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
      };
    }
  } catch {
    // Backward compatibility: older rows encrypted the access token directly.
  }
  return { accessToken: plaintext };
}

export async function storeGithubUserToken(
  userId: string,
  accessToken: string,
  meta: GithubTokenMeta = {},
  refreshToken?: string,
): Promise<void> {
  await userSecrets.upsert(userId, encryptGithubUserToken(accessToken, refreshToken), meta, userSecrets.GITHUB_OAUTH_SECRET_KIND);
}

async function refreshGithubUserToken(userId: string, refreshToken: string): Promise<string | null> {
  const { clientId, clientSecret } = config.github();
  if (!clientId || !clientSecret) return null;
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  };
  if (!json.access_token) return null;
  await storeGithubUserToken(
    userId,
    json.access_token,
    {
      ...(json.expires_in ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
      ...(json.refresh_token_expires_in ? { refreshTokenExpiresAt: Date.now() + json.refresh_token_expires_in * 1000 } : {}),
    },
    json.refresh_token ?? refreshToken,
  );
  return json.access_token;
}

export async function githubUserTokenStatusForUser(userId: string): Promise<GithubUserTokenResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { githubLogin: true } });
  const linked = Boolean(user?.githubLogin);
  const stored = await userSecrets.get(userId, userSecrets.GITHUB_OAUTH_SECRET_KIND);
  if (!stored) return { token: null, linked, reason: "missing" };
  const meta = (stored.meta ?? {}) as GithubTokenMeta;
  let bundle: GithubTokenBundle;
  try {
    bundle = decodeTokenBundle(stored.ciphertext);
  } catch {
    return { token: null, linked, reason: "decrypt_failed" };
  }
  if (meta.expiresAt && meta.expiresAt <= Date.now()) {
    if (!bundle.refreshToken || (meta.refreshTokenExpiresAt && meta.refreshTokenExpiresAt <= Date.now())) {
      return { token: null, linked, reason: "expired" };
    }
    const refreshed = await refreshGithubUserToken(userId, bundle.refreshToken).catch(() => null);
    return refreshed ? { token: refreshed, linked: true } : { token: null, linked, reason: "refresh_failed" };
  }
  return { token: bundle.accessToken, linked: true };
}

export async function githubUserTokenForUser(userId: string): Promise<string | null> {
  return (await githubUserTokenStatusForUser(userId)).token;
}

/** Token that creates GitHub resources as the Manta user who owns the card. */
export async function githubUserTokenForTask(task: Pick<Task, "createdBy">): Promise<string | null> {
  return task.createdBy ? githubUserTokenForUser(task.createdBy) : null;
}

export async function githubUserTokenStatusForTask(task: Pick<Task, "createdBy">): Promise<GithubUserTokenResult> {
  return task.createdBy ? githubUserTokenStatusForUser(task.createdBy) : { token: null, linked: false, reason: "missing" };
}
