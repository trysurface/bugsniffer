import { App } from "@slack/bolt";
import { config } from "./config.js";
import { classifyMessage, findDuplicate, isProvidingBugDetail, isDisputingDupe } from "./classifier.js";
import { createBugTicket, getUnresolvedBugs, appendSlackLink } from "./notion.js";
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

  // Check for duplicate before creating a new ticket or asking for detail
  const duplicate = await checkForDuplicate(text, message.ts!, say, client);
  if (duplicate) return;

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
  const hasFiles = !!(message.files?.length);
  const ts = new Date().toISOString();
  const stored = (await getPendingThread(threadTs))!;

  console.log(
    `[${ts}] 🧵 Follow-up in pending thread ${threadTs} from ${message.user}`
  );

  // Handle dupe-dispute threads
  if (stored.startsWith("DUPE:")) {
    const originalText = stored.slice(5);
    const disputing = await isDisputingDupe(message.text ?? "");
    if (!disputing) {
      console.log(`  → Reply in dupe thread is not a dispute. Ignoring.`);
      return;
    }

    console.log(`  → Dupe disputed! Creating new ticket.`);
    await deletePendingThread(threadTs);
    const classResult = await classifyMessage(originalText, hasFiles);
    const title = classResult.suggested_title || originalText.slice(0, 100);
    await createTicketAndConfirm(title, originalText, threadTs, say, client, threadTs);
    return;
  }

  // Only process if the reply is actually adding bug detail, not just conversation
  const providingDetail = await isProvidingBugDetail(message.text ?? "", hasFiles);
  if (!providingDetail) {
    console.log(`  → Reply is conversation, not bug detail. Ignoring.`);
    return;
  }

  const combinedText = `${stored}\n\nFollow-up from reporter: ${message.text}`;

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

  // Check for duplicate before creating a new ticket
  const duplicate = await checkForDuplicate(combinedText, threadTs, say, client, threadTs);
  if (duplicate) {
    await deletePendingThread(threadTs);
    return;
  }

  await deletePendingThread(threadTs);
  await createTicketAndConfirm(result.suggested_title, combinedText, threadTs, say, client, threadTs);
}

/**
 * Check if the message matches an existing unresolved bug.
 * If so, append the new Slack link to the existing ticket and reply.
 * Returns true if a duplicate was found and handled.
 */
async function checkForDuplicate(
  text: string,
  messageTs: string,
  say: Function,
  client: any,
  threadTs?: string
): Promise<boolean> {
  const existingBugs = await getUnresolvedBugs();
  const dupResult = await findDuplicate(text, existingBugs);

  if (!dupResult.is_duplicate || !dupResult.matching_bug_id) return false;

  const match = existingBugs.find((b) => b.id === dupResult.matching_bug_id);
  if (!match) return false;

  console.log(`  → Duplicate of existing ticket: "${match.title}" (${match.id})`);

  const permalinkResponse = await client.chat.getPermalink({
    channel: config.slack.channelId,
    message_ts: messageTs,
  });
  const slackLink = permalinkResponse.permalink as string;

  await appendSlackLink(match.id, slackLink);

  await say({
    text: `:link: Looks like this bug has already been reported: *"${match.title}"*\n\nThe <${match.url}|Notion ticket> has been updated with a link to this message — no new ticket created. If this is actually a different issue, let me know and I'll create a separate ticket.`,
    thread_ts: threadTs ?? messageTs,
  });

  // Track this thread so we can handle disputes
  const replyTo = threadTs ?? messageTs;
  await setPendingThread(replyTo, `DUPE:${text}`);

  return true;
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
