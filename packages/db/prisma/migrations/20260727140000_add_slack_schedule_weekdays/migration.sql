ALTER TABLE "slack_message_schedules"
ADD COLUMN "daysOfWeek" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

UPDATE "slack_message_schedules"
SET "daysOfWeek" = ARRAY["dayOfWeekUtc"]
WHERE "dayOfWeekUtc" IS NOT NULL;

-- Keep the legacy column during the rolling deploy so older server tasks remain compatible.
CREATE OR REPLACE FUNCTION sync_slack_schedule_weekdays()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF cardinality(NEW."daysOfWeek") > 0 THEN
      NEW."dayOfWeekUtc" := NEW."daysOfWeek"[1];
    ELSIF NEW."dayOfWeekUtc" IS NOT NULL THEN
      NEW."daysOfWeek" := ARRAY[NEW."dayOfWeekUtc"];
    END IF;
  ELSIF NEW."daysOfWeek" IS DISTINCT FROM OLD."daysOfWeek" THEN
    NEW."dayOfWeekUtc" := NEW."daysOfWeek"[1];
  ELSIF NEW."dayOfWeekUtc" IS DISTINCT FROM OLD."dayOfWeekUtc" THEN
    IF NEW."cadence" = 'daily' THEN
      NEW."daysOfWeek" := ARRAY[]::INTEGER[];
    ELSIF cardinality(OLD."daysOfWeek") > 1 THEN
      -- Legacy servers cannot represent a multi-day selection, so do not let
      -- their single-day field silently collapse a newer schedule.
      NEW."dayOfWeekUtc" := OLD."daysOfWeek"[1];
    ELSE
      NEW."daysOfWeek" := CASE
        WHEN NEW."dayOfWeekUtc" IS NULL THEN ARRAY[]::INTEGER[]
        ELSE ARRAY[NEW."dayOfWeekUtc"]
      END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_slack_schedule_weekdays_trigger
BEFORE INSERT OR UPDATE OF "dayOfWeekUtc", "daysOfWeek"
ON "slack_message_schedules"
FOR EACH ROW
EXECUTE FUNCTION sync_slack_schedule_weekdays();
