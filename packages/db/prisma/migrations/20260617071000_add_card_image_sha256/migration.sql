-- Add a content hash so identical uploaded images can be reused safely.
-- Existing rows remain NULL; Postgres unique constraints allow multiple NULLs,
-- while new writes populate sha256 and are deduplicated per workspace.
ALTER TABLE "card_images" ADD COLUMN "sha256" TEXT;

CREATE UNIQUE INDEX "card_images_workspaceId_sha256_key" ON "card_images"("workspaceId", "sha256");
