import { App } from "@slack/bolt";
import { config } from "./config.js";
import { classifyMessage } from "./classifier.js";
import { createBugTicket } from "./notion.js";
import {
  hasPendingThread,
  getPendingThread,
  setPendingThread,
  deletePendingThread,
} from "./store.js";

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

  app.message(async ({ message, say, client }) => {
    try {
      await handleMessage(message as SlackMessage, say, client);
    } catch (err) {
      console.error("[slack] Error handling message:", err);
    }
  });

  return app;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function shouldSkipMessage(message: SlackMessage): boolean {
  // Wrong channel
  if (message.channel !== config.slack.channelId) return true;

  // Bot messages
  if (message.bot_id || message.subtype === "bot_message") return true;

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

  // Thread replies — only allow if we're waiting on this thread (checked async below)
  // Actual pending check happens in handleMessage after this sync guard.

  // Empty
  if (!message.text?.trim()) return true;

  return false;
}

async function handleMessage(
  message: SlackMessage,
  say: Function,
  client: any
): Promise<void> {
  if (shouldSkipMessage(message)) return;

  const isThreadReply = !!(
    message.thread_ts && message.thread_ts !== message.ts
  );

  if (isThreadReply) {
    // Only process replies in threads we're waiting on
    if (!(await hasPendingThread(message.thread_ts!))) return;
    await handleThreadFollowUp(message, say, client);
    return;
  }

  const text = message.text!;
  const hasFiles = !!(message.files?.length);
  const ts = new Date().toISOString();

  console.log(
    `[${ts}] 📩 New message from ${message.user}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`
  );

  const result = await classifyMessage(text, hasFiles);
  console.log(`[${ts}] 🔍 Classification:`, JSON.stringify(result));

  if (!result.is_bug) {
    console.log(`  → Not a bug. Skipping.`);
    return;
  }

  if (!result.has_sufficient_detail) {
    console.log(`  → Bug but insufficient detail. Asking for more info.`);
    await setPendingThread(message.ts!, text);
    await say({
      text: "Thanks for the report! To create a ticket I need a bit more detail — could you share steps to reproduce, a screenshot, or a Loom video?",
      thread_ts: message.ts,
    });
    return;
  }

  await createTicketAndConfirm(result.suggested_title, text, message.ts!, say, client, undefined);
}

async function handleThreadFollowUp(
  message: SlackMessage,
  say: Function,
  client: any
): Promise<void> {
  const threadTs = message.thread_ts!;
  const originalText = (await getPendingThread(threadTs))!;
  const combinedText = `${originalText}\n\nFollow-up from reporter: ${message.text}`;
  const hasFiles = !!(message.files?.length);
  const ts = new Date().toISOString();

  console.log(
    `[${ts}] 🧵 Follow-up in pending thread ${threadTs} from ${message.user}`
  );

  const result = await classifyMessage(combinedText, hasFiles);
  console.log(`[${ts}] 🔍 Re-classification:`, JSON.stringify(result));

  if (!result.is_bug || !result.has_sufficient_detail) {
    console.log(`  → Still insufficient detail.`);
    await say({
      text: "Still a bit light on detail — steps to reproduce or a screenshot would really help!",
      thread_ts: threadTs,
    });
    return;
  }

  await deletePendingThread(threadTs);
  await createTicketAndConfirm(result.suggested_title, combinedText, threadTs, say, client, threadTs);
}

async function createTicketAndConfirm(
  suggestedTitle: string | null,
  text: string,
  messageTs: string,
  say: Function,
  client: any,
  threadTs?: string
): Promise<void> {
  const permalinkResponse = await client.chat.getPermalink({
    channel: config.slack.channelId,
    message_ts: messageTs,
  });
  const slackLink = permalinkResponse.permalink as string;
  const title = suggestedTitle || text.slice(0, 100);
  const ticket = await createBugTicket(title, slackLink);

  console.log(`  → ✅ Created Notion ticket: ${ticket.url}`);

  await say({
    text: `:bug: Added to <${config.notion.databaseUrl}|Bug Tracker>: *"${title}"* — Not started.`,
    thread_ts: threadTs ?? messageTs,
  });
}
