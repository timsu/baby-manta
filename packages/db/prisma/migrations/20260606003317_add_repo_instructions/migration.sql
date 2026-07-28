-- AlterTable
ALTER TABLE "repos" ADD COLUMN     "globalInstructions" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "setupCommands" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "repo_personal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "repo_personal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repo_personal_userId_repoId_key" ON "repo_personal"("userId", "repoId");

-- AddForeignKey
ALTER TABLE "repo_personal" ADD CONSTRAINT "repo_personal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_personal" ADD CONSTRAINT "repo_personal_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
