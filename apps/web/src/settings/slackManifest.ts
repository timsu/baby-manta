// Generates a Slack app manifest the user can paste into
// https://api.slack.com/apps?new_app=1 → "From a manifest". This pre-fills every
// scope + event subscription + the Events Request URL, so registering a new bot
// is one paste instead of a dozen toggles. Kept assistant-feature-free so the
// manifest imports without the extra "Agents & Assistants" setup step.

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:read",
  "chat:write",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "users:read.email",
  "reactions:write",
] as const;

export const SLACK_BOT_EVENTS = ["app_mention", "message.im", "message.channels"] as const;

/** The Events API Request URL all bots point at (single multi-bot endpoint). */
export function slackEventsUrl(): string {
  return `${window.location.origin}/api/slack/events`;
}

export function buildSlackManifest(botName: string): string {
  const name = botName.trim() || "Manta Bot";
  const manifest = {
    display_information: { name },
    features: {
      // Enable the Messages tab so users can DM the bot. Without this, Slack
      // shows "Sending messages to this app has been turned off" in the DM.
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: {
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        request_url: slackEventsUrl(),
        bot_events: [...SLACK_BOT_EVENTS],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  return JSON.stringify(manifest, null, 2);
}
