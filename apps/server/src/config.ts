// The single sanctioned place to read process.env (the platform convention: app code
// uses these typed getters, never process.env directly). Values are read lazily
// so importing this module never throws; a getter throws only if a required var
// is missing when actually used — which keeps tests (that inject fakes and never
// touch real config) free of env setup.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: () => Number(optional("PORT", "3020")),
  isProd: () => process.env["NODE_ENV"] === "production",
  /** Background cron-style jobs (poller, sandbox reconciler, schedule runners).
   * Default off in development so local servers don't mutate shared state or
   * post scheduled Slack messages; set MANTA_BACKGROUND_JOBS=true to opt in. */
  backgroundJobsEnabled: () => optional("MANTA_BACKGROUND_JOBS", process.env["NODE_ENV"] === "production" ? "true" : "false") === "true",
  google: () => ({
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    redirectUri: optional("GOOGLE_REDIRECT_URI", "http://localhost:5173/api/auth/google/callback"),
  }),
  sessionSecret: () => required("SESSION_SECRET"),
  /**
   * Key for encrypting workspace secrets at rest (provider API keys, Codex
   * OAuth tokens). Any string; a 32-byte AES key is derived from it. Falls back
   * to SESSION_SECRET so dev works without extra config — set a dedicated
   * SECRETS_KEY in production so rotating the session secret doesn't orphan
   * stored credentials.
   */
  secretsKey: () => optional("SECRETS_KEY", ""),
  daytonaApiKey: () => required("DAYTONA_API_KEY"),
  /** Daytona API endpoint. Empty → the SDK default (Daytona Cloud). */
  daytonaApiUrl: () => optional("DAYTONA_API_URL", ""),
  /** Daytona snapshot name the cloud worker venue boots from (the registered
   * `manta-sandbox` image). Empty → fall back to a base image (dev/smoke only). */
  sandboxSnapshot: () => optional("MANTA_SANDBOX_SNAPSHOT", ""),
  /** Cost backstop: Daytona auto-stops an idle box after this many minutes, then
   * archives it, then deletes it. Stopped boxes are cheap; a follow-up resumes by
   * provisioning a fresh box off the pushed branch + session. */
  sandboxAutoStopMinutes: () => Number(optional("MANTA_SANDBOX_AUTOSTOP_MIN", "30")),
  sandboxAutoArchiveMinutes: () => Number(optional("MANTA_SANDBOX_AUTOARCHIVE_MIN", "1440")),
  sandboxAutoDeleteMinutes: () => Number(optional("MANTA_SANDBOX_AUTODELETE_MIN", "4320")),
  /** Warm grace: minutes a cloud sandbox stays alive (idle) after a turn before
   * the server commits WIP and stops it. A follow-up within the window reuses the
   * warm box; after it, the next message wakes a restarted/fresh box. */
  sandboxGraceMinutes: () => Number(optional("MANTA_SANDBOX_GRACE_MIN", "10")),
  /** Public wss:// URL a cloud sandbox uses to dial back to this server's
   * /worker-ws. Defaults to the single-origin prod host. */
  publicWsUrl: () => optional("MANTA_PUBLIC_WS_URL", "wss://manta.example.com"),
  /** Warm repo clones baked into the sandbox image, as `repo=path` pairs. The
   * daemon builds a task's worktree off the matching seed (fetched first) instead
   * of cloning fresh; the server vends a pull/push token for each seed repo. */
  sandboxSeedRepos: () =>
    optional("MANTA_SANDBOX_SEED_REPOS", "acme/manta=/opt/manta,acme/platform=/opt/repo-cache/platform"),
  /** Names of env vars on this server to forward verbatim into every cloud
   * sandbox (comma-separated). Only vars actually present on the server are
   * forwarded. Keep this to dotenvx bootstrap keys: a seed repo's
   * `.env.shared` (holding shared service tokens like SHARED_SENTRY_TOKEN, and
   * the read-only database URL its CLIs validate at startup) is unlocked by
   * `DOTENV_PRIVATE_KEY_SHARED`, and an agent runs `dotenvx run -f
   * .env.shared -- …` for the plaintext. Anything the sandbox needs belongs in
   * that encrypted file — one source of truth that cannot drift — rather than
   * copied here as a second decrypted credential. */
  sandboxForwardEnvNames: () =>
    optional("MANTA_SANDBOX_FORWARD_ENV", "DOTENV_PRIVATE_KEY_SHARED")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  /** Optional `target=source` aliases publishing a forwarded value under a second
   * name in the sandbox. Empty by default.
   *
   * Never alias a dotenvx *private key* to another environment's label. Those
   * loaders are key-gated: publishing any value under, say,
   * `DOTENV_PRIVATE_KEY_DEVELOPMENT` makes every repo CLI decrypt
   * `.env.development` with a key that cannot work, so its vars arrive as
   * ciphertext and validation fails with WRONG_PRIVATE_KEY — which reads like a
   * broken credential but is self-inflicted. */
  sandboxForwardEnvAliases: () =>
    optional("MANTA_SANDBOX_FORWARD_ENV_ALIASES", "")
      .split(",")
      .map((pair) => pair.split("=").map((s) => s.trim()))
      .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[0] && pair[1])),
  /** Resolved `{name: value}` for the forwarded sandbox env vars set on this server. */
  sandboxForwardEnv: (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const name of config.sandboxForwardEnvNames()) {
      const v = process.env[name];
      if (v) out[name] = v;
    }
    // Publish a forwarded value under any second name the sandbox expects.
    for (const [target, source] of config.sandboxForwardEnvAliases()) {
      if (out[source] && !out[target]) out[target] = out[source];
    }
    return out;
  },
  /** Minimum accepted worker version integer. Workers below this are told to update. */
  minWorkerVersion: () => Number(optional("MIN_WORKER_VERSION", "20")),
  /** Upstash Redis (REST). Used as a survives-restart cache for worker presence
   * and in-flight turn state so a deploy doesn't drop the worker from the UI or
   * truncate a mid-turn message. Empty → Redis disabled (dev/tests run without it). */
  redis: () => ({
    url: optional("UPSTASH_REDIS_REST_URL", ""),
    token: optional("UPSTASH_REDIS_REST_TOKEN", ""),
  }),
  /** Ably API key. Used purely as a cross-instance backplane for the live event
   * bus (see bus.ts) so worker and browser sockets that land on different
   * replicas still rendezvous. Empty → backplane disabled, bus stays in-process
   * (correct for a single instance and for dev/tests). */
  ablyKey: () => optional("ABLY_API_KEY", ""),
  /** Optional OpenAI-compatible endpoint for the retro Black Manta board commentator. */
  blackMantaCommentary: () => ({
    apiKey: optional("WAFER_API_KEY", ""),
    baseUrl: optional("WAFER_OPENAI_BASE_URL", "https://pass.wafer.ai/v1"),
    model: optional("BLACK_MANTA_MODEL", "Qwen3.5-397B-A17B"),
  }),
  /** Where to send the browser after a successful login. */
  webAppUrl: () => optional("WEB_APP_URL", "http://localhost:5173"),
  /** Directory of the built web SPA to serve on the same origin (production
   * single-origin). Empty string = don't serve (dev uses the Vite server). */
  webRoot: () => optional("WEB_ROOT", ""),
  slack: () => ({
    botToken: optional("SLACK_BOT_TOKEN", ""),
    signingSecret: optional("SLACK_SIGNING_SECRET", ""),
    defaultTeamId: optional("SLACK_TEAM_ID", ""),
  }),
  /**
   * GitHub App config (single shared App for the whole deployment). appId +
   * privateKey mint installation tokens; appSlug builds the install URL;
   * clientId/clientSecret drive the per-user "Link GitHub" OAuth; webhookSecret
   * verifies inbound App webhooks.
   */
  github: () => ({
    appId: optional("GITHUB_APP_ID", ""),
    privateKey: optional("GITHUB_APP_PRIVATE_KEY", "").replace(/\\n/g, "\n"),
    appSlug: optional("GITHUB_APP_SLUG", ""),
    clientId: optional("GITHUB_APP_CLIENT_ID", ""),
    clientSecret: optional("GITHUB_APP_CLIENT_SECRET", ""),
    webhookSecret: optional("GITHUB_WEBHOOK_SECRET", ""),
  }),
  // Linear is a per-workspace connector: each workspace stores its own OAuth app
  // credentials (clientId/clientSecret/webhookSecret) in the DB, not in env. See
  // linear/app-config.ts.
};
