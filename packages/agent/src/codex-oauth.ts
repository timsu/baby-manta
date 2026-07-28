// OpenAI Codex (ChatGPT Plus/Pro subscription) OAuth login.
//
// Runs the official Codex CLI OAuth flow (PKCE; binds localhost:1455 and opens
// the browser) and returns the credential blob to store under the "openai-codex"
// provider in a Pi auth.json. This is the programmatic equivalent of `pi /login`
// for the Codex subscription.
//
// Node-only: the pi-ai flow uses a local loopback callback server, so the
// redirect lands on the machine running this code. It's invoked by the worker
// daemon (which runs on a user's laptop / VM), never the hosted server — a
// hosted server can't receive OpenAI's localhost redirect. The captured blob is
// uploaded to the server and stored encrypted per workspace; once in a Pi
// CredentialStore the access token auto-refreshes from `refresh`.

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Provider id Pi uses for the ChatGPT Codex subscription. */
export const CODEX_PROVIDER_ID = "openai-codex";

/** A stored auth.json credential for the openai-codex provider. */
export interface CodexCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

export interface CodexLoginCallbacks {
  /** Open this URL in the browser (the ChatGPT consent screen). */
  onAuth: (info: { url: string; instructions?: string }) => void;
  /** Prompt for a pasted code / redirect URL (fallback when the loopback
   * callback can't be reached, e.g. a headless host). */
  onPrompt: (info: { message: string }) => Promise<string>;
  onProgress?: (message: string) => void;
}

/**
 * Run the Codex OAuth flow and return the credential to upload/store. The caller
 * persists it (the daemon POSTs it to the server, which encrypts it per
 * workspace). Returns the tagged `{ type: "oauth", ... }` shape that
 * `setProvider`'s authJson path accepts directly.
 */
export async function loginCodex(callbacks: CodexLoginCallbacks): Promise<CodexCredential> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const creds = await runtime.login(CODEX_PROVIDER_ID, "oauth", {
    prompt: (prompt) => callbacks.onPrompt({ message: prompt.message }),
    notify: (event) => {
      if (event.type === "auth_url") callbacks.onAuth({ url: event.url, instructions: event.instructions });
      else if (event.type === "progress" || event.type === "info") callbacks.onProgress?.(event.message);
      else if (event.type === "device_code") {
        callbacks.onAuth({ url: event.verificationUri, instructions: `Enter code ${event.userCode}` });
      }
    },
  });
  if (creds.type !== "oauth" || typeof creds.accountId !== "string") {
    throw new Error("Codex OAuth returned an invalid credential");
  }
  return {
    type: "oauth",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    // pi-ai types extra fields through an index signature (unknown); the Codex
    // flow guarantees accountId is a string (it throws otherwise).
    accountId: creds.accountId as string,
  };
}
