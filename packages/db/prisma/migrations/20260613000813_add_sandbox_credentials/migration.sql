-- CreateTable
CREATE TABLE "sandbox_credentials" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "sandbox_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_credentials_tokenHash_key" ON "sandbox_credentials"("tokenHash");

-- CreateIndex
CREATE INDEX "sandbox_credentials_taskId_idx" ON "sandbox_credentials"("taskId");
