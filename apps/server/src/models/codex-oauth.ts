// Server-side Codex OAuth helpers. Generates PKCE + authorization URL and
// exchanges the authorization code for tokens. The redirect URI is the Pi CLI's
// registered loopback — the user copies it from the browser's address bar after
// OpenAI redirects and the connection is refused, then pastes it back into the UI.

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

export interface CodexOAuthSession {
  verifier: string;
  expires: number;
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const verifier = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  let bin2 = "";
  for (const b of new Uint8Array(hash)) bin2 += String.fromCharCode(b);
  const challenge = btoa(bin2).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return { verifier, challenge };
}

export function buildAuthUrl(challenge: string, state: string): string {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return url.toString();
}

export async function exchangeCode(code: string, verifier: string): Promise<{
  access: string; refresh: string; expires: number; accountId: string;
}> {
  const resp = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_REDIRECT_URI,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Token exchange failed (${resp.status}): ${text || resp.statusText}`);
  }
  const json = (await resp.json()) as { access_token: string; refresh_token: string; expires_in: number };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Unexpected token response from OpenAI");
  }
  const accountId = extractAccountId(json.access_token);
  if (!accountId) throw new Error("Could not extract account ID from token");
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

function extractAccountId(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
