// Build the real AuthDeps from config + the db layer. Kept separate from
// createApp so the app factory stays pure/testable; the dev/prod entrypoint
// (server.ts) calls this once env is loaded (via dotenvx).

import { users } from "@manta/db";
import { config } from "../config.ts";
import { createGoogleAuth } from "./google.ts";
import { createSessions } from "./session.ts";
import type { AuthDeps } from "./routes.ts";

export function buildAuthDeps(now: () => Date = () => new Date()): AuthDeps {
  // Google is optional: with no OAuth client configured the server still boots
  // and serves passwordless email sign-in, so a fresh checkout runs with no
  // third-party setup at all.
  return {
    googleAuth: config.googleConfigured() ? createGoogleAuth(config.google()) : null,
    sessions: createSessions(config.sessionSecret(), now),
    upsertUser: (p) => users.upsertByGoogle(p),
    upsertUserByEmail: (p) => users.upsertByEmail(p),
    emailLoginEnabled: config.emailLoginEnabled(),
    memberships: (userId) => users.membershipsFor(userId),
    now,
    webAppUrl: config.webAppUrl(),
    secureCookies: config.isProd(),
  };
}
