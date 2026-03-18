import { App } from "@slack/bolt";
import { config } from "./config.js";
import { classifyMessage } from "./classifier.js";
import { createBugTicket } from "./notion.js";

/** Subset of the Slack message event fields we actually use. */
interface SlackMessage {
  channel: string;
  user?: string;
  text?: string;
  ts?: string;
  subtype?: string;
  bot_id?: string;
  thread_ts?: string;
  files?: unknown[];
}

export function createSlackApp(): App {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  app.message(async ({ message, say }) => {
    try {
      await handleMessage(message as SlackMessage, say);
    } catch (err) {
      console.error("[slack] Error handling message:", err);
    }
  });

  return app;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildSlackPermalink(channelId: string, messageTs: string): string {
  const tsNoDot = messageTs.replace(".", "");
  return `https://slack.com/archives/${channelId}/p${tsNoDot}`;
}

function shouldSkipMessage(message: SlackMessage): boolean {
  // Wrong channel
  if (message.channel !== config.slack.channelId) return true;

  // Bot messages
  if (message.bot_id || message.subtype === "bot_message")
    return true;

  // System subtypes (joins, topic changes, etc.)
  const skipSubtypes = new Set([
    "channel_join",
    "channel_leave",
    "channel_purpose",
    "channel_topic",
    "message_changed",
    "message_deleted",
  ]);
  if (message.subtype && skipSubtypes.has(message.subtype)) return true;

  // Thread replies (only process top-level messages)
  if (
    message.thread_ts &&
    message.thread_ts !== message.ts
  )
    return true;

  // Empty
  if (!message.text?.trim()) return true;

  return false;
}

async function handleMessage(
  message: SlackMessage,
  say: Function
): Promise<void> {
  if (shouldSkipMessage(message)) return;

  const text = message.text!;
  const hasFiles = !!(message.files?.length);
  const ts = new Date().toISOString();

  console.log(
    `[${ts}] 📩 New message from ${message.user}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`
  );

  // Classify with Claude
  const result = await classifyMessage(text, hasFiles);

  console.log(`[${ts}] 🔍 Classification:`, JSON.stringify(result));

  if (!result.is_bug) {
    console.log(`  → Not a bug. Skipping.`);
    return;
  }

  if (!result.has_sufficient_detail) {
    console.log(`  → Bug but insufficient detail. Skipping.`);
    return;
  }

  // Create Notion ticket
  const slackLink = buildSlackPermalink(config.slack.channelId, message.ts!);
  const title = result.suggested_title || text.slice(0, 100);
  const ticket = await createBugTicket(title, slackLink);

  console.log(`  → ✅ Created Notion ticket: ${ticket.url}`);

  // Confirm in-thread
  await say({
    text: `:bug: Added to <${config.notion.databaseUrl}|Bug Tracker>: *"${title}"* — Not started.`,
    thread_ts: message.ts,
  });
}
