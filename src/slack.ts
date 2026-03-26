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

/** Slack file object (subset of fields we use). */
export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  url_private: string;
  permalink: string;
  permalink_public?: string;
}

/** Subset of the Slack message event fields we actually use. */
interface SlackMessage {
  channel: string;
  user?: string;
  text?: string;
  ts?: string;
  subtype?: string;
  bot_id?: string;
  thread_ts?: string;
  files?: SlackFile[];
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

// ── Debounce ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 3000;
const debounceTimers = new Map<string, NodeJS.Timeout>();
const debouncedContexts = new Map<string, { message: SlackMessage; say: Function; client: any }>();

/**
 * Debounce message processing. Groups by thread_ts (for replies) or
 * user ID (for top-level messages). Waits DEBOUNCE_MS after the last
 * message before processing, so rapid-fire messages are batched.
 */
function debounceMessage(
  key: string,
  message: SlackMessage,
  say: Function,
  client: any
): void {
  // Always keep the latest message context
  debouncedContexts.set(key, { message, say, client });

  // Clear existing timer and set a new one
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    key,
    setTimeout(async () => {
      debounceTimers.delete(key);
      const ctx = debouncedContexts.get(key);
      debouncedContexts.delete(key);
      if (!ctx) return;

      try {
        await processMessage(ctx.message, ctx.say, ctx.client);
      } catch (err) {
        console.error("[slack] Error handling debounced message:", err);
      }
    }, DEBOUNCE_MS)
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetch recent top-level messages from the same user within a short window
 * (to combine rapid-fire messages like "bug in lead scoring" + "for eragon").
 * Returns combined text and any files from all messages.
 */
async function getRecentUserMessages(
  client: any,
  channel: string,
  userId: string,
  latestTs: string
): Promise<{ text: string; files: SlackFile[] } | null> {
  const result = await client.conversations.history({
    channel,
    latest: latestTs,
    limit: 5,
    inclusive: true,
  });
  const messages: any[] = result.messages ?? [];
  // Collect consecutive messages from the same user (no thread, no bot)
  const cutoff = parseFloat(latestTs) - 30; // 30-second window
  const userMessages: { text: string; files: SlackFile[] }[] = [];
  for (const m of messages) {
    if (m.user !== userId) break;
    if (m.bot_id || m.thread_ts) break;
    if (parseFloat(m.ts) < cutoff) break;
    userMessages.push({ text: m.text ?? "", files: m.files ?? [] });
  }
  if (userMessages.length <= 1) return null;
  // Messages come newest-first, reverse to chronological
  userMessages.reverse();
  return {
    text: userMessages.map((m) => m.text).join("\n"),
    files: userMessages.flatMap((m) => m.files),
  };
}

/** Fetch recent non-bot replies in a thread, joined into a single string. */
async function getRecentUserReplies(
  client: any,
  channel: string,
  threadTs: string
): Promise<string> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: 10,
  });
  const messages: any[] = result.messages ?? [];
  return messages
    .filter((m: any) => !m.bot_id && m.ts !== threadTs)
    .map((m: any) => m.text ?? "")
    .join("\n");
}

/** Collect all non-bot files from a thread (original message + replies). */
async function getThreadFiles(
  client: any,
  channel: string,
  threadTs: string
): Promise<SlackFile[]> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: 20,
  });
  const messages: any[] = result.messages ?? [];
  return messages
    .filter((m: any) => !m.bot_id)
    .flatMap((m: any) => m.files ?? []);
}

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
    if (!(await hasPendingThread(message.thread_ts!))) return;
    // Debounce by thread
    debounceMessage(message.thread_ts!, message, say, client);
    return;
  }

  // Debounce top-level messages by user
  debounceMessage(`user:${message.user}`, message, say, client);
}

/** Called after the debounce window closes. */
async function processMessage(
  message: SlackMessage,
  say: Function,
  client: any
): Promise<void> {
  const isThreadReply = !!(
    message.thread_ts && message.thread_ts !== message.ts
  );

  if (isThreadReply) {
    await handleThreadFollowUp(message, say, client);
    return;
  }

  // For top-level messages, fetch recent messages from the user to combine rapid-fire posts
  const recent = await getRecentUserMessages(client, message.channel, message.user!, message.ts!);
  const text = recent?.text || message.text!;
  const files: SlackFile[] = recent?.files || message.files || [];
  const hasFiles = files.length > 0;
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

  await createTicketAndConfirm(result.suggested_title, text, files, message.ts!, say, client, undefined);
}

async function handleThreadFollowUp(
  message: SlackMessage,
  say: Function,
  client: any
): Promise<void> {
  const threadTs = message.thread_ts!;
  const threadFiles = await getThreadFiles(client, message.channel, threadTs);
  const hasFiles = threadFiles.length > 0;
  const ts = new Date().toISOString();
  const stored = (await getPendingThread(threadTs))!;

  console.log(
    `[${ts}] 🧵 Follow-up in pending thread ${threadTs} from ${message.user}`
  );

  // Handle dupe-dispute threads
  if (stored.startsWith("DUPE:")) {
    const originalText = stored.slice(5);
    // Fetch recent non-bot replies for context (user might split across messages)
    const recentReplies = await getRecentUserReplies(client, message.channel, threadTs);
    const disputing = await isDisputingDupe(recentReplies);
    if (!disputing) {
      console.log(`  → Reply in dupe thread is not a dispute. Ignoring.`);
      return;
    }

    console.log(`  → Dupe disputed! Creating new ticket.`);
    await deletePendingThread(threadTs);
    const classResult = await classifyMessage(originalText, hasFiles);
    const title = classResult.suggested_title || originalText.slice(0, 100);
    await createTicketAndConfirm(title, originalText, threadFiles, threadTs, say, client, threadTs);
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
  await createTicketAndConfirm(result.suggested_title, combinedText, threadFiles, threadTs, say, client, threadTs);
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
  files: SlackFile[],
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

  // Make Slack files public so they can be embedded in Notion
  const publicFiles = await makeFilesPublic(client, files);

  const ticket = await createBugTicket(title, slackLink, text, publicFiles);

  console.log(`  → ✅ Created Notion ticket: ${ticket.url}`);

  await say({
    text: `:bug: Added to <${config.notion.databaseUrl}|Bug Tracker>: *"${title}"* — Not started.`,
    thread_ts: threadTs ?? messageTs,
  });
}

/** Make Slack files publicly accessible for embedding in Notion. */
async function makeFilesPublic(
  client: any,
  files: SlackFile[]
): Promise<SlackFile[]> {
  const results: SlackFile[] = [];
  for (const file of files) {
    try {
      const resp = await client.files.sharedPublicURL({ file: file.id });
      results.push({ ...file, permalink_public: resp.file?.permalink_public });
    } catch (err: any) {
      const code = err?.data?.error;
      if (code === "already_public") {
        results.push(file);
      } else {
        console.warn(`[slack] Could not make file ${file.id} public: ${code ?? err}`);
        results.push(file); // Still include — we'll fall back to permalink
      }
    }
  }
  return results;
}
