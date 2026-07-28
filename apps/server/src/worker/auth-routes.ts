// Worker pairing: the browser half of the one-time device-pairing flow.
//
// A worker daemon with no stored credential opens
//   <web>/?pair-worker=1&callback=http://127.0.0.1:<port>/cb&state=<nonce>&name=<host>
// in the user's browser. The (logged-in) web page POSTs here to mint a token
// bound to that user, then redirects the browser to the loopback callback with
// the token. The daemon captures it and stores it forever.
//
// Minting requires a valid session, so a token can only ever be created for the
// authenticated user — there is no shared secret to spoof.

import { Hono } from "hono";
import { workerCredentials } from "@manta/db";
import { requireAuth, type AuthVars } from "../auth/routes.ts";
import type { Sessions } from "../auth/session.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("Manta:WorkerAuth");

export function createWorkerAuthRoutes(deps: { sessions: Sessions }): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  // Mint a worker credential for the authenticated user. Returns the plaintext
  // token exactly once — the caller (web pairing page) hands it to the daemon.
  app.post("/pair", requireAuth(deps.sessions), async (c) => {
    const userId = c.get("userId");
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const name = (body.name ?? "worker").slice(0, 80);
    const { id, token } = await workerCredentials.mint(userId, name);
    logger.info("worker credential minted", { userId, credentialId: id, name });
    return c.json({ token, name, email: c.get("email") });
  });

  return app;
}
