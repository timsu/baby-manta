-- AddForeignKey
ALTER TABLE "sandbox_credentials" ADD CONSTRAINT "sandbox_credentials_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
