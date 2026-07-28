-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "createdBy" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "githubLogin" TEXT,
ADD COLUMN     "githubUserId" TEXT;
