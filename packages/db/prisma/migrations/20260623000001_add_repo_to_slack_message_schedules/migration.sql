-- Scheduled Slack worker runs need an explicit checkout repo in multi-repo workspaces.
ALTER TABLE "slack_message_schedules" ADD COLUMN "repo" TEXT;
