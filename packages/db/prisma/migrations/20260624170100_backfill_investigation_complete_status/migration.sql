UPDATE "tasks"
SET "cardStatus" = 'investigation_complete'
WHERE "cardStatus" = 'done'
  AND "doneReason" = 'investigation_complete'
  AND "cardType" = 'investigation'
  AND "prNumber" IS NULL;
