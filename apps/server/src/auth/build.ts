// Build the real AuthDeps from config + the db layer. Kept separate from
// createApp so the app factory stays pure/testable; the dev/prod entrypoint
// (server.ts) calls this once env is loaded (via dotenvx).

import { users } from "@manta/db";
import { config } from "../config.ts";
import { createGoogleAuth } from "./google.ts";
import { createSessions } from "./session.ts";
import type { AuthDeps } from "./routes.ts";

export function buildAuthDeps(now: () => Date = () => new Date()): AuthDeps {
  const g = config.google();
  return {
    googleAuth: createGoogleAuth(g),
    sessions: createSessions(config.sessionSecret(), now),
    upsertUser: (p) => users.upsertByGoogle(p),
    memberships: (userId) => users.membershipsFor(userId),
    now,
    webAppUrl: config.webAppUrl(),
    secureCookies: config.isProd(),
  };
}
