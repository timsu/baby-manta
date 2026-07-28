-- Add explicit investigation typing and completion reason for read-only investigations.
ALTER TYPE "CardType" ADD VALUE IF NOT EXISTS 'investigation';
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'investigation';
ALTER TYPE "DoneReason" ADD VALUE IF NOT EXISTS 'investigation_complete';
