export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    channelId: process.env.SLACK_CHANNEL_ID || "C0880RJL3SL",
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY!,
    databaseId:
      process.env.NOTION_DATABASE_ID || "32744c625b9f804db76ee0aa3d82499d",
    databaseUrl:
      "https://www.notion.so/withsurface/32744c625b9f804db76ee0aa3d82499d?v=32744c625b9f8033b00d000cec98e078",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: process.env.CLASSIFIER_MODEL || "claude-sonnet-4-20250514",
  },
  port: parseInt(process.env.PORT || "3000", 10),
} as const;

/** Validate that all required env vars are present at startup. */
export function validateConfig(): void {
  const required: [string, string][] = [
    ["SLACK_BOT_TOKEN", config.slack.botToken],
    ["SLACK_APP_TOKEN", config.slack.appToken],
    ["NOTION_API_KEY", config.notion.apiKey],
    ["ANTHROPIC_API_KEY", config.anthropic.apiKey],
  ];
  const missing = required
    .filter(([, val]) => !val)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}
