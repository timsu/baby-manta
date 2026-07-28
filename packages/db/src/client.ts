// Prisma singleton. the platform convention: use the global prisma singleton
// directly (don't inject it); reuse across hot-reloads in dev to avoid
// exhausting connections. The generated client lives outside src/ (gitignored)
// and is produced by `pnpm --filter @manta/db generate`.

import { PrismaClient } from "../generated/client/index.js";

const globalForPrisma = globalThis as unknown as { __mantaPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__mantaPrisma ?? new PrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.__mantaPrisma = prisma;
}

export * from "../generated/client/index.js";
