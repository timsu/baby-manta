// Prisma singleton. the platform convention: use the global prisma singleton
// directly (don't inject it); reuse across hot-reloads in dev to avoid
// exhausting connections. The generated client lives outside src/ (gitignored)
// and is produced by `pnpm --filter @manta/db generate`.

import { fileURLToPath } from "node:url";
import { PrismaClient } from "../generated/client/index.js";

// A fresh checkout should run with no configuration at all, so default the
// SQLite file to the one `prisma migrate` creates. Absolute, because a relative
// `file:` URL resolves against the schema directory rather than the cwd, and the
// server and the Prisma CLI are invoked from different places. An explicit
// DATABASE_URL (production, tests, a shared file) always wins.
process.env["DATABASE_URL"] ??= `file:${fileURLToPath(new URL("../prisma/dev.db", import.meta.url))}`;

const globalForPrisma = globalThis as unknown as { __mantaPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__mantaPrisma ?? new PrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.__mantaPrisma = prisma;
}

export * from "../generated/client/index.js";
