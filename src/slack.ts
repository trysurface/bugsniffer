import { App, type BlockAction, type ButtonAction } from "@slack/bolt";
import { config } from "./config.js";
import { classifyMessage, findDuplicate, isProvidingBugDetail, isDisputingDupe } from "./classifier.js";
import { createBugTicket, getOpenBugsForDedup, appendSlackLink, appendThreadUpdate, slackUserToNotionId } from "./notion.js";
import {
  hasPendingThread,
  getPendingThread,
  setPendingThread,
  deletePendingThread,
  listPendingThreads,
} from "./store.js";

/** Slack file object (subset of fields we use). */
export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  url_private: string;
  permalink: string;
}

/**
 * Pending-store value prefixes — they mark what kind of interaction a thread
 * is waiting on (see docs/slack-processing.md). No prefix = needs-detail.
 */
const DUPE_PREFIX = "DUPE:";
const CONFIRM_PREFIX = "CONFIRM:";
const TICKET_PREFIX = "TICKET:";

// Where we point people for substantial feature requests (self-serve)
const LEAD_OPS_ROADMAP_URL =
  "https://app.notion.com/p/withsurface/Lead-Ops-Roadmap-38444c625b9f8063a196edd6ddc5b498";
const CONTENT_OPS_ROADMAP_URL =
  "https://app.notion.com/p/withsurface/Content-Ops-Roadmap-38344c625b9f80948b9fea03f1f4bc00";

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

  // Yes/No buttons on the "not sure this is a bug" confirmation prompt.
  // Requires Interactivity enabled in the Slack app config (delivered over
  // the Socket Mode connection — no Request URL needed).
  app.action<BlockAction<ButtonAction>>("bug_confirm_yes", async ({ ack, body, action, client }) => {
    await ack();
    try {
      await handleTicketConfirm(body, action, client, true);
    } catch (err) {
      console.error("[slack] Error handling ticket confirmation:", err);
    }
  });

  app.action<BlockAction<ButtonAction>>("bug_confirm_no", async ({ ack, body, action, client }) => {
    await ack();
    try {
      await handleTicketConfirm(body, action, client, false);
    } catch (err) {
      console.error("[slack] Error handling ticket decline:", err);
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

/** Get the Slack user ID of the thread's root (original) message author. */
async function getThreadRootAuthor(
  client: any,
  channel: string,
  threadTs: string
): Promise<string | undefined> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: 1,
  });
  return (result.messages?.[0] as any)?.user;
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
    if (result.is_ambiguous) {
      console.log(`  → Ambiguous (borderline bug / improvement). Asking whether to file a ticket.`);
      await askTicketConfirmation(result.suggested_title, text, message.ts!, say, message.user);
      return;
    }
    if (result.is_feature_request) {
      // Larger feature requests: point at the roadmaps, end the conversation
      // there — no ticket, no buttons, no thread tracking.
      console.log(`  → Feature request. Pointing at the roadmaps.`);
      await say({
        text: `:bulb: This looks like a feature request rather than a bug, so I haven't filed it in the Bug Tracker. To get it on the roadmap, add it to the <${LEAD_OPS_ROADMAP_URL}|Lead Ops Roadmap> or the <${CONTENT_OPS_ROADMAP_URL}|Content Ops Roadmap> — whichever fits best.`,
        thread_ts: message.ts,
      });
      return;
    }
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

  await createTicketAndConfirm(result.suggested_title, text, files, message.ts!, say, client, undefined, message.user);
}

async function handleThreadFollowUp(
  message: SlackMessage,
  say: Function,
  client: any
): Promise<void> {
  const threadTs = message.thread_ts!;
  const ts = new Date().toISOString();
  // May have been cleared between the debounce being scheduled and firing
  // (e.g. a confirmation button was clicked in the meantime)
  const stored = await getPendingThread(threadTs);
  if (!stored) return;

  console.log(
    `[${ts}] 🧵 Follow-up in pending thread ${threadTs} from ${message.user}`
  );

  // Threads awaiting a Yes/No ticket confirmation — the buttons are the
  // interface; text replies are ignored.
  if (stored.startsWith(CONFIRM_PREFIX)) {
    console.log(`  → Thread is awaiting ticket confirmation buttons. Ignoring reply.`);
    return;
  }

  // Threads that already have a ticket — append useful follow-ups to it
  if (stored.startsWith(TICKET_PREFIX)) {
    await handleTicketThreadUpdate(message, client, threadTs, stored);
    return;
  }

  const threadFiles = await getThreadFiles(client, message.channel, threadTs);
  const hasFiles = threadFiles.length > 0;
  // Reporter is whoever started the thread, not the follow-up replier
  const reporterSlackId = await getThreadRootAuthor(client, message.channel, threadTs);

  // Handle dupe-dispute threads
  if (stored.startsWith(DUPE_PREFIX)) {
    const originalText = stored.slice(DUPE_PREFIX.length);
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
    await createTicketAndConfirm(title, originalText, threadFiles, threadTs, say, client, threadTs, reporterSlackId, message.ts);
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

  // Check for duplicate before creating a new ticket. On a match,
  // checkForDuplicate replaces this thread's pending entry with a DUPE:
  // one — don't delete it, or the reporter can't dispute.
  const duplicate = await checkForDuplicate(combinedText, threadTs, say, client, threadTs);
  if (duplicate) return;

  await deletePendingThread(threadTs);
  await createTicketAndConfirm(result.suggested_title, combinedText, threadFiles, threadTs, say, client, threadTs, reporterSlackId, message.ts);
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
  const existingBugs = await getOpenBugsForDedup();
  const dupResult = await findDuplicate(text, existingBugs);

  if (!dupResult.is_duplicate || !dupResult.matching_bug_id) return false;

  const match = existingBugs.find((b) => b.id === dupResult.matching_bug_id);
  if (!match) return false;

  console.log(
    `  → Duplicate of existing ${match.inProgress ? "in-progress" : "unassigned"} ticket: "${match.title}" (${match.id})`
  );

  const permalinkResponse = await client.chat.getPermalink({
    channel: config.slack.channelId,
    message_ts: messageTs,
  });
  const slackLink = permalinkResponse.permalink as string;

  await appendSlackLink(match.id, slackLink);

  // In-progress tickets (an owner has picked them up) get a distinct reply that
  // names who's on it; unassigned tickets get the standard duplicate reply.
  const dupeText = match.inProgress
    ? `:hourglass_flowing_sand: This looks like a bug we're already on: *"${match.title}"* — currently being worked on by ${match.ownerNames.join(", ") || "someone"}. I've linked your message to the <${match.url}|Notion ticket>; no new ticket created. If it's actually a different issue, let me know and I'll create a separate ticket.`
    : `:link: Looks like this bug has already been reported: *"${match.title}"*\n\nThe <${match.url}|Notion ticket> has been updated with a link to this message — no new ticket created. If this is actually a different issue, let me know and I'll create a separate ticket.`;

  await say({
    text: dupeText,
    thread_ts: threadTs ?? messageTs,
  });

  // Track this thread so we can handle disputes
  const replyTo = threadTs ?? messageTs;
  await setPendingThread(replyTo, DUPE_PREFIX + text);

  return true;
}

async function createTicketAndConfirm(
  suggestedTitle: string | null,
  text: string,
  files: SlackFile[],
  messageTs: string,
  say: Function,
  client: any,
  threadTs?: string,
  reporterSlackId?: string,
  watchSinceTs?: string
): Promise<void> {
  const permalinkResponse = await client.chat.getPermalink({
    channel: config.slack.channelId,
    message_ts: messageTs,
  });
  const slackLink = permalinkResponse.permalink as string;
  const title = suggestedTitle || text.slice(0, 100);

  // Resolve the reporter (Slack sender) to a Notion member for the Reporter field
  const reporterNotionId = reporterSlackId
    ? await slackUserToNotionId(reporterSlackId, client)
    : null;

  const ticket = await createBugTicket(title, slackLink, text, files, reporterNotionId);

  console.log(`  → ✅ Created Notion ticket: ${ticket.url}`);

  // Keep watching the thread: later replies that add useful detail get
  // appended to the ticket. lastTs is the watermark — only replies newer
  // than it are considered, so nothing is appended twice.
  await setPendingThread(
    threadTs ?? messageTs,
    TICKET_PREFIX + JSON.stringify({ pageId: ticket.id, lastTs: watchSinceTs ?? messageTs })
  );

  await say({
    text: `:bug: Added to Bug Tracker: <${ticket.url}|${title}>`,
    thread_ts: threadTs ?? messageTs,
  });
}

// ── Ambiguous-report confirmation buttons ───────────────────────────────────

/**
 * For borderline messages (labeled "Bug" but reads like a missing feature,
 * improvements to existing functionality, etc.) — instead of silently
 * skipping, ask in-thread with Yes/No buttons whether to file a ticket.
 */
async function askTicketConfirmation(
  suggestedTitle: string | null,
  text: string,
  messageTs: string,
  say: Function,
  reporter?: string
): Promise<void> {
  await setPendingThread(
    messageTs,
    CONFIRM_PREFIX + JSON.stringify({ text, title: suggestedTitle, reporter, reminders: 0 })
  );

  const prompt =
    ":thinking_face: This reads more like an improvement/feature request than a bug, so I haven't filed it automatically. Want a ticket anyway?";

  await say({
    text: `${prompt} Reply isn't monitored — use the buttons.`,
    thread_ts: messageTs,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: prompt } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Yes, create a ticket" },
            style: "primary",
            action_id: "bug_confirm_yes",
            value: messageTs,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "No, skip it" },
            action_id: "bug_confirm_no",
            value: messageTs,
          },
        ],
      },
    ],
  });
}

// Unanswered Yes/No prompts get the reporter pinged in-thread every
// CONFIRM_REMINDER_INTERVAL_MS, at most CONFIRM_MAX_REMINDERS times.
const CONFIRM_REMINDER_INTERVAL_MS = 4 * 60 * 60_000; // 4 hours
const CONFIRM_MAX_REMINDERS = 3;

interface ConfirmMeta {
  text: string;
  title: string | null;
  reporter?: string;
  reminders?: number;
  lastRemindAt?: number;
}

/**
 * Sweep pending CONFIRM: threads and ping the reporter on ones where the
 * Yes/No buttons have sat unanswered. Called periodically from index.ts.
 */
export async function remindStaleConfirmations(client: any): Promise<void> {
  const pending = await listPendingThreads();
  for (const { threadTs, value } of pending) {
    if (!value.startsWith(CONFIRM_PREFIX)) continue;

    let meta: ConfirmMeta;
    try {
      meta = JSON.parse(value.slice(CONFIRM_PREFIX.length));
    } catch {
      continue;
    }

    const reminders = meta.reminders ?? 0;
    if (reminders >= CONFIRM_MAX_REMINDERS) continue;

    // Time since the last ping, or since the report itself (its ts is the key)
    const anchor = meta.lastRemindAt ?? parseFloat(threadTs) * 1000;
    if (Date.now() - anchor < CONFIRM_REMINDER_INTERVAL_MS) continue;

    // Entries written before reminders existed don't carry the reporter
    let reporter = meta.reporter;
    if (!reporter) {
      try {
        reporter = await getThreadRootAuthor(client, config.slack.channelId, threadTs);
      } catch {
        // transient Slack error — retry next sweep
      }
    }
    if (!reporter) continue;

    const n = reminders + 1;
    const tail =
      n >= CONFIRM_MAX_REMINDERS ? " — last reminder, I'll leave it alone after this" : "";
    try {
      await client.chat.postMessage({
        channel: config.slack.channelId,
        thread_ts: threadTs,
        text: `:wave: <@${reporter}> — still waiting on an answer here: should I file this as a ticket? Use the Yes/No buttons above. (reminder ${n}/${CONFIRM_MAX_REMINDERS}${tail})`,
      });
    } catch (err) {
      console.error(`[remind] Failed to post reminder in ${threadTs}:`, err);
      continue; // don't advance the counter for a ping that never landed
    }

    // A button click mid-sweep deletes the entry (or moves it to TICKET:) —
    // writing our stale copy back would resurrect dead buttons. Skip if changed.
    const current = await getPendingThread(threadTs);
    if (current !== value) continue;

    await setPendingThread(
      threadTs,
      CONFIRM_PREFIX +
        JSON.stringify({ ...meta, reporter, reminders: n, lastRemindAt: Date.now() })
    );
    console.log(`[remind] Pinged reporter in ${threadTs} (${n}/${CONFIRM_MAX_REMINDERS})`);
  }
}

/** Handle a click on the Yes/No ticket confirmation buttons. */
async function handleTicketConfirm(
  body: BlockAction<ButtonAction>,
  action: ButtonAction,
  client: any,
  confirmed: boolean
): Promise<void> {
  const rootTs = action.value; // ts of the original report message
  const channel = body.channel?.id;
  const promptTs = body.message?.ts;
  if (!rootTs || !channel || !promptTs) return;

  const clicker = body.user.id;
  const stored = await getPendingThread(rootTs);
  await deletePendingThread(rootTs);

  // Replace the button message so the buttons can't be clicked twice
  const finalize = (text: string) =>
    client.chat.update({
      channel,
      ts: promptTs,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    });

  if (!confirmed) {
    console.log(`  → Ticket declined by ${clicker} for ${rootTs}`);
    await finalize(`:+1: Got it — no ticket created (dismissed by <@${clicker}>).`);
    return;
  }

  console.log(`  → Ticket confirmed by ${clicker} for ${rootTs}. Creating.`);

  // Prefer the text/title captured at classification time (may combine
  // rapid-fire messages); fall back to re-reading the thread if the store
  // was lost (e.g. in-memory fallback across a restart).
  let text: string | null = null;
  let title: string | null = null;
  if (stored?.startsWith(CONFIRM_PREFIX)) {
    const parsed = JSON.parse(stored.slice(CONFIRM_PREFIX.length));
    text = parsed.text;
    title = parsed.title;
  }

  const result = await client.conversations.replies({
    channel,
    ts: rootTs,
    limit: 50,
  });
  const threadMessages: any[] = result.messages ?? [];
  const root = threadMessages[0];
  if (!text) text = root?.text ?? "";
  if (!text) {
    await finalize(":warning: Couldn't recover the original message — please repost the report.");
    return;
  }

  const files: SlackFile[] = threadMessages
    .filter((m) => !m.bot_id)
    .flatMap((m) => m.files ?? []);
  const reporterSlackId = root?.user;
  // Watermark for follow-up appends: everything currently in the thread is
  // already part of the ticket (or predates it) — only newer replies append.
  const latestTs = threadMessages.reduce(
    (max, m) => (parseFloat(m.ts) > parseFloat(max) ? m.ts : max),
    rootTs
  );

  const sayInThread = (args: any) => client.chat.postMessage({ channel, ...args });
  await createTicketAndConfirm(title, text, files, rootTs, sayInThread, client, rootTs, reporterSlackId, latestTs);
  await finalize(`:white_check_mark: <@${clicker}> confirmed — ticket created.`);
}

// ── Ticket-thread follow-up appends ─────────────────────────────────────────

/**
 * A reply arrived in a thread that already has a ticket. If the replies since
 * the last append add useful detail (per Claude), append them — text and
 * screenshots — to the Notion page and advance the watermark.
 */
async function handleTicketThreadUpdate(
  message: SlackMessage,
  client: any,
  threadTs: string,
  stored: string
): Promise<void> {
  const meta = JSON.parse(stored.slice(TICKET_PREFIX.length)) as {
    pageId: string;
    lastTs: string;
  };

  const result = await client.conversations.replies({
    channel: message.channel,
    ts: threadTs,
    limit: 50,
  });
  const fresh: any[] = (result.messages ?? []).filter(
    (m: any) =>
      !m.bot_id && m.ts !== threadTs && parseFloat(m.ts) > parseFloat(meta.lastTs)
  );
  if (fresh.length === 0) return;

  const text = fresh.map((m) => m.text ?? "").filter(Boolean).join("\n");
  const files: SlackFile[] = fresh.flatMap((m) => m.files ?? []);

  // Advance the watermark either way: conversational replies shouldn't be
  // re-evaluated (and possibly appended) alongside a later detail reply.
  const latestTs = fresh[fresh.length - 1].ts;
  await setPendingThread(
    threadTs,
    TICKET_PREFIX + JSON.stringify({ pageId: meta.pageId, lastTs: latestTs })
  );

  const providingDetail = await isProvidingBugDetail(text, files.length > 0);
  if (!providingDetail) {
    console.log(`  → Reply in ticket thread is conversation, not detail. Ignoring.`);
    return;
  }

  let authorName: string | undefined;
  try {
    const info = await client.users.info({ user: message.user });
    authorName = info.user?.profile?.display_name || info.user?.real_name || undefined;
  } catch {
    // attribution is nice-to-have
  }

  await appendThreadUpdate(meta.pageId, text, files, authorName);
  console.log(`  → 📎 Appended thread update to ticket ${meta.pageId}`);

  // Acknowledge with a reaction rather than a reply to keep the thread quiet.
  // Needs reactions:write; degrades to a log line without it.
  try {
    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: "memo",
    });
  } catch (err) {
    console.warn("[slack] Could not add reaction (missing reactions:write scope?):", err);
  }
}
