-- AlterTable
ALTER TABLE "users" ADD COLUMN     "linearName" TEXT,
ADD COLUMN     "linearUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_linearUserId_key" ON "users"("linearUserId");

