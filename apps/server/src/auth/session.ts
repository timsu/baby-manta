// Session tokens — HMAC-signed JWTs (hono/jwt) stored in an HttpOnly cookie.
// Injectable so routes/middleware take a Sessions instance and tests can pass a
// fake. The real impl signs with SESSION_SECRET.

import { sign, verify } from "hono/jwt";

export interface SessionClaims {
  /** Manta user id. */
  sub: string;
  email: string;
  /** Expiry (unix seconds). */
  exp: number;
}

export interface Sessions {
  issue(input: { userId: string; email: string }): Promise<string>;
  verify(token: string): Promise<SessionClaims | null>;
}

export const SESSION_COOKIE = "manta_session";
const TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export function createSessions(secret: string, now: () => Date = () => new Date()): Sessions {
  return {
    async issue({ userId, email }) {
      const exp = Math.floor(now().getTime() / 1000) + TTL_SECONDS;
      return sign({ sub: userId, email, exp }, secret, "HS256");
    },
    async verify(token) {
      try {
        const payload = (await verify(token, secret, "HS256")) as unknown as SessionClaims;
        if (!payload?.sub) return null;
        return payload;
      } catch {
        return null; // expired or tampered
      }
    },
  };
}
