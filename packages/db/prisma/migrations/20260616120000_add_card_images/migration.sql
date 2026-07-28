-- CreateTable
CREATE TABLE "card_images" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "card_images_workspaceId_idx" ON "card_images"("workspaceId");

-- AddForeignKey
ALTER TABLE "card_images" ADD CONSTRAINT "card_images_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
