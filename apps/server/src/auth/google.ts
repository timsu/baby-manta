// Google OAuth — the single seam to Google. Injectable: routes take a GoogleAuth
// and tests pass a fake (no network). The real impl uses google-auth-library to
// build the consent URL, exchange the code, and verify the id_token.

import { OAuth2Client } from "google-auth-library";
import type { GoogleProfile } from "@manta/db";

export interface GoogleAuth {
  /** Build the consent-screen URL to redirect the browser to. */
  authUrl(state: string): string;
  /** Exchange an auth code and return the verified profile. */
  exchange(code: string): Promise<GoogleProfile>;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createGoogleAuth(cfg: GoogleConfig): GoogleAuth {
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
  return {
    authUrl(state) {
      return client.generateAuthUrl({
        access_type: "online",
        scope: ["openid", "email", "profile"],
        state,
        prompt: "select_account",
      });
    },
    async exchange(code) {
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) throw new Error("Google did not return an id_token");
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: cfg.clientId,
      });
      const p = ticket.getPayload();
      if (!p?.sub || !p.email) throw new Error("Google id_token missing sub/email");
      return {
        googleSub: p.sub,
        email: p.email,
        ...(p.name ? { name: p.name } : {}),
        ...(p.picture ? { avatarUrl: p.picture } : {}),
      };
    },
  };
}
