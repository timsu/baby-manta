-- CreateTable
CREATE TABLE "worker_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "worker_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "worker_credentials_tokenHash_key" ON "worker_credentials"("tokenHash");

-- CreateIndex
CREATE INDEX "worker_credentials_userId_idx" ON "worker_credentials"("userId");

-- AddForeignKey
ALTER TABLE "worker_credentials" ADD CONSTRAINT "worker_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
