-- AlterTable
ALTER TABLE "slack_message_schedules"
ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN "includeWeekendsAndHolidays" BOOLEAN NOT NULL DEFAULT false;
