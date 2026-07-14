import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { WebClient } from "@slack/web-api";
import type { SlackFile } from "./slack.js";
import { config } from "./config.js";

const notion = new Client({ auth: config.notion.apiKey });

// Cache Notion user ID → Slack user ID mappings to avoid repeated lookups
const notionToSlackCache = new Map<string, string | null>();
// Cache Slack user ID → Notion user ID mappings (reverse direction, for Reporter)
const slackToNotionCache = new Map<string, string | null>();

export interface NotionTicket {
  id: string;
  url: string;
}

export interface ExistingBug {
  id: string;
  title: string;
  url: string;
  /** Owner display names (empty if unassigned). */
  ownerNames: string[];
  /** True if the bug has an owner and its linked eng task isn't Done. */
  inProgress: boolean;
}

function isFullPage(page: { object: string }): page is PageObjectResponse {
  return page.object === "page" && "url" in page && "properties" in page;
}

export async function createBugTicket(
  title: string,
  slackThreadUrl: string,
  messageText: string,
  files: SlackFile[],
  reporterNotionId?: string | null
): Promise<NotionTicket> {
  const properties: Record<string, any> = {
    Name: { title: [{ text: { content: title } }] },
    "Slack Thread URL": { url: slackThreadUrl },
  };
  if (reporterNotionId) {
    properties.Reporter = { people: [{ id: reporterNotionId }] };
  }

  const page = await notion.pages.create({
    parent: { database_id: config.notion.databaseId },
    properties,
  });

  if (!isFullPage(page)) throw new Error("Notion returned a partial page response");

  // Build page content from the Slack message
  const blocks = await buildBugContentBlocks(messageText, files);
  if (blocks.length > 0) {
    await notion.blocks.children.append({
      block_id: page.id,
      children: blocks,
    });
  }

  return { id: page.id, url: page.url };
}

/** Extract embeddable video URLs (Loom, Jam, YouTube) from text. */
function extractEmbedUrls(text: string): string[] {
  const pattern = /https?:\/\/(?:www\.)?(?:loom\.com\/share\/[a-zA-Z0-9]+|jam\.dev\/c\/[a-zA-Z0-9-]+|youtu(?:be\.com\/watch\?v=|\.be\/)[a-zA-Z0-9_-]+)/g;
  return [...text.matchAll(pattern)].map((m) => m[0]);
}

/** Clean Slack-formatted text for Notion (convert <url|label> to plain text). */
function cleanSlackText(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")  // <url|label> → label (url)
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")                   // <url> → url
    .replace(/<@([A-Z0-9]+)>/g, "@user")                       // <@U123> → @user
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Notion's single-request upload API accepts files up to 20 MB; larger files
// need multipart (rare for Slack screenshots, so we fall back to a link instead).
const NOTION_SINGLE_PART_UPLOAD_LIMIT = 20 * 1024 * 1024;

/**
 * Download a Slack file and upload the bytes into Notion, returning the
 * file_upload id to attach to a block. Notion then self-hosts the file, so it
 * survives the Slack file being deleted or its public link revoked.
 *
 * The Slack download is authenticated with the bot token (no need to make the
 * file public). Returns null on any failure so the caller can fall back to a
 * link — e.g. if the bot lacks `files:read` or the file exceeds the size limit.
 */
async function uploadSlackFileToNotion(file: SlackFile): Promise<string | null> {
  try {
    const res = await fetch(file.url_private, {
      headers: { Authorization: `Bearer ${config.slack.botToken}` },
    });
    if (!res.ok) {
      console.warn(`[upload] Slack download failed for ${file.name}: HTTP ${res.status}`);
      return null;
    }
    // An unauthorized download (e.g. missing files:read scope) returns a 200
    // HTML login page rather than the file bytes — detect and fall back.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      console.warn(`[upload] Slack returned HTML for ${file.name} (auth issue?) — falling back. Ensure the bot has files:read.`);
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > NOTION_SINGLE_PART_UPLOAD_LIMIT) {
      console.warn(`[upload] ${file.name} is ${bytes.byteLength} bytes (> 20MB) — falling back to link`);
      return null;
    }

    const upload = await notion.fileUploads.create({
      mode: "single_part",
      filename: file.name,
      content_type: file.mimetype,
    });
    await notion.fileUploads.send({
      file_upload_id: upload.id,
      file: { filename: file.name, data: new Blob([bytes], { type: file.mimetype }) },
    });
    return upload.id;
  } catch (err) {
    console.warn(`[upload] Failed to upload ${file.name} to Notion:`, err);
    return null;
  }
}

/** Build Notion blocks from Slack message text and files. */
async function buildBugContentBlocks(text: string, files: SlackFile[]): Promise<any[]> {
  const blocks: any[] = [];
  const embedUrls = extractEmbedUrls(text);

  // Message text as paragraphs (max 2000 chars per block)
  const cleaned = cleanSlackText(text);
  const lines = cleaned.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    const truncated = line.slice(0, 2000);
    blocks.push({
      paragraph: {
        rich_text: [{ text: { content: truncated } }],
      },
    });
  }

  // Loom/Jam/YouTube embeds (watchable inline in Notion)
  for (const url of embedUrls) {
    if (url.includes("loom.com") || url.includes("youtu")) {
      blocks.push({ video: { external: { url }, type: "external" } });
    } else {
      blocks.push({ embed: { url } });
    }
  }

  // Slack file attachments
  for (const file of files) {
    const isImage = file.mimetype?.startsWith("image/");

    if (isImage) {
      // Upload the actual bytes into Notion so the image is self-hosted.
      const uploadId = await uploadSlackFileToNotion(file);
      if (uploadId) {
        blocks.push({
          image: { type: "file_upload", file_upload: { id: uploadId } },
        });
        continue;
      }
      // Upload failed — fall through to a bookmark link below.
    }

    // Videos and other files — Notion only supports video embeds from
    // specific providers (Loom, YouTube, etc.), not raw file URLs.
    // Use a bookmark with the Slack permalink so users can click through.
    blocks.push({ bookmark: { url: file.permalink } });
  }

  return blocks;
}

/**
 * Read a bug's status from the "Eng Sprint Status (Linked)" rollup — an array
 * of the linked eng task's status. Empty = no task yet (unassigned/new).
 * Returns true only if a linked task is explicitly "Done".
 */
function isBugDone(page: PageObjectResponse): boolean {
  const rollup = page.properties["Eng Sprint Status (Linked)"];
  if (rollup?.type !== "rollup" || rollup.rollup.type !== "array") return false;
  return rollup.rollup.array.some(
    (item) => item.type === "status" && item.status?.name === "Done"
  );
}

/**
 * Fetch open bugs for duplicate detection. We compare a new report only against
 * bugs that aren't Done — split into unassigned (nobody's picked it up) and
 * in-progress (has an owner). Done bugs are excluded entirely: bugs can
 * re-emerge, so a fixed ticket shouldn't block a fresh report.
 *
 * The Bug Tracker has no Status property; "done" is derived from the linked eng
 * task via the "Eng Sprint Status (Linked)" rollup (see isBugDone).
 */
export async function getOpenBugsForDedup(): Promise<ExistingBug[]> {
  const bugs: ExistingBug[] = [];
  let cursor: string | undefined;
  do {
    const response = await notion.dataSources.query({
      data_source_id: config.notion.dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results.filter(isFullPage)) {
      if (isBugDone(page)) continue;

      const nameProp = page.properties.Name;
      const title =
        nameProp.type === "title"
          ? nameProp.title[0]?.plain_text ?? "(untitled)"
          : "(untitled)";

      const ownerProp = page.properties.Owner;
      const owners = ownerProp.type === "people" ? ownerProp.people : [];
      const ownerNames = owners.map(
        (p) => ("name" in p && p.name ? p.name : "someone")
      );

      bugs.push({
        id: page.id,
        title,
        url: page.url,
        ownerNames,
        inProgress: owners.length > 0,
      });
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return bugs;
}

// ── Slack helpers ───────────────────────────────────────────────────────────

/**
 * Parse a Slack message URL into channel + thread_ts.
 * URL format: https://<workspace>.slack.com/archives/<channel>/p<ts_without_dot>
 */
function parseSlackUrl(url: string): { channel: string; threadTs: string } | null {
  const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!match) return null;
  return { channel: match[1], threadTs: `${match[2]}.${match[3]}` };
}

/** Map a Notion user ID to a Slack user ID via email lookup. */
async function notionUserToSlackId(
  notionUserId: string,
  slackClient: WebClient
): Promise<string | null> {
  if (notionToSlackCache.has(notionUserId)) {
    return notionToSlackCache.get(notionUserId)!;
  }

  try {
    const notionUser = await notion.users.retrieve({ user_id: notionUserId });
    const email =
      notionUser.type === "person" ? notionUser.person.email : null;
    if (!email) {
      console.warn(`[sync] Notion user ${notionUserId} has no email — cannot map to Slack`);
      notionToSlackCache.set(notionUserId, null);
      return null;
    }

    const slackUser = await slackClient.users.lookupByEmail({ email });
    const slackId = slackUser.user?.id ?? null;
    notionToSlackCache.set(notionUserId, slackId);
    return slackId;
  } catch (err: any) {
    // Don't cache scope/auth errors — they may be fixed by adding scopes later
    const errorCode = err?.data?.error ?? err?.code;
    if (errorCode === "missing_scope" || errorCode === "not_authed" || errorCode === "token_revoked") {
      console.warn(`[sync] Slack scope error mapping user ${notionUserId}: ${errorCode}. Add users:read and users:read.email scopes.`);
      return null;
    }
    // users_not_found means the email doesn't match anyone in Slack — safe to cache
    console.warn(`[sync] Could not map Notion user ${notionUserId} to Slack: ${errorCode ?? err}`);
    notionToSlackCache.set(notionUserId, null);
    return null;
  }
}

/**
 * Lazily-built map of lowercased email → Notion user ID, from the workspace
 * member list. Cached for the process lifetime (membership changes rarely).
 */
let notionEmailMap: Map<string, string> | null = null;

async function getNotionEmailMap(): Promise<Map<string, string>> {
  if (notionEmailMap) return notionEmailMap;

  const map = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const resp = await notion.users.list({ start_cursor: cursor, page_size: 100 });
    for (const u of resp.results) {
      if (u.type === "person" && u.person.email) {
        map.set(u.person.email.toLowerCase(), u.id);
      }
    }
    cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
  } while (cursor);

  notionEmailMap = map;
  return map;
}

/**
 * Map a Slack user ID to a Notion user ID via email lookup (reverse of
 * notionUserToSlackId). Used to set the bug's Reporter to whoever posted
 * the Slack message. Returns null if the reporter isn't a Notion member.
 */
export async function slackUserToNotionId(
  slackUserId: string,
  slackClient: WebClient
): Promise<string | null> {
  if (slackToNotionCache.has(slackUserId)) {
    return slackToNotionCache.get(slackUserId)!;
  }

  try {
    const info = await slackClient.users.info({ user: slackUserId });
    const email = info.user?.profile?.email ?? null;
    if (!email) {
      console.warn(`[reporter] Slack user ${slackUserId} has no email — cannot map to Notion`);
      slackToNotionCache.set(slackUserId, null);
      return null;
    }

    const map = await getNotionEmailMap();
    const notionId = map.get(email.toLowerCase()) ?? null;
    if (!notionId) {
      console.warn(`[reporter] No Notion member matches Slack email ${email}`);
    }
    slackToNotionCache.set(slackUserId, notionId);
    return notionId;
  } catch (err: any) {
    // Don't cache scope/auth errors — they may be fixed by adding scopes later
    const errorCode = err?.data?.error ?? err?.code;
    if (errorCode === "missing_scope" || errorCode === "not_authed" || errorCode === "token_revoked") {
      console.warn(`[reporter] Slack scope error looking up user ${slackUserId}: ${errorCode}. Add users:read and users:read.email scopes.`);
      return null;
    }
    console.warn(`[reporter] Could not map Slack user ${slackUserId} to Notion: ${errorCode ?? err}`);
    slackToNotionCache.set(slackUserId, null);
    return null;
  }
}

// ── Sprint lookup ───────────────────────────────────────────────────────────

let currentSprintId: string | null = null;
let sprintCacheExpiry = 0;
const SPRINT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Get the current sprint's page ID (cached for 10 minutes). */
async function getCurrentSprintId(): Promise<string | null> {
  if (currentSprintId && Date.now() < sprintCacheExpiry) {
    return currentSprintId;
  }

  try {
    const response = await notion.dataSources.query({
      data_source_id: config.notion.engTaskTracker.sprintsDataSourceId,
      filter: {
        property: "Sprint status",
        status: { equals: "Current" },
      },
    });

    const sprint = response.results.filter(isFullPage)[0];
    if (sprint) {
      currentSprintId = sprint.id;
      sprintCacheExpiry = Date.now() + SPRINT_CACHE_TTL_MS;
      console.log(`[sync] Current sprint: ${sprint.id}`);
      return currentSprintId;
    }

    console.warn("[sync] No sprint with status 'Current' found");
    return null;
  } catch (err) {
    console.error("[sync] Failed to query current sprint:", err);
    return null;
  }
}

// ── Eng Task Tracker sync ───────────────────────────────────────────────────

const MAX_SYNC_BATCH = 5;

// Buffer of assignments made since the last digest was posted
const assignmentBuffer: { bugTitle: string; taskUrl: string; ownerIds: string[] }[] = [];

interface BugNeedingEngTask {
  id: string;
  title: string;
  ownerIds: string[];
  slackThreadUrl: string | null;
  createdAt: string;
}

/**
 * Find bug tickets that have an Owner assigned but no Task Tracker Link yet.
 * These need a corresponding Eng Task Tracker ticket created.
 */
export async function getBugsNeedingEngTask(): Promise<BugNeedingEngTask[]> {
  const response = await notion.dataSources.query({
    data_source_id: config.notion.dataSourceId,
    filter: {
      and: [
        { property: "Owner", people: { is_not_empty: true } },
        { property: "Task Tracker Link", relation: { is_empty: true } },
      ],
    },
  });

  return response.results.filter(isFullPage).map((page) => {
    const nameProp = page.properties.Name;
    const title =
      nameProp.type === "title"
        ? nameProp.title[0]?.plain_text ?? "(untitled)"
        : "(untitled)";

    const ownerProp = page.properties.Owner;
    const ownerIds =
      ownerProp.type === "people"
        ? ownerProp.people.map((p) => p.id)
        : [];

    const slackProp = page.properties["Slack Thread URL"];
    const slackThreadUrl =
      slackProp.type === "url" ? slackProp.url : null;

    const createdProp = page.properties["Bug Report Created On"];
    const createdAt =
      createdProp?.type === "created_time"
        ? createdProp.created_time.split("T")[0]
        : new Date().toISOString().split("T")[0];

    return { id: page.id, title, ownerIds, slackThreadUrl, createdAt };
  });
}

/**
 * Create an Eng Task Tracker ticket linked to a bug, with the same title and assignee.
 * The two-way relation auto-populates "Task Tracker Link" on the bug side.
 */
export async function createEngTask(
  bug: BugNeedingEngTask
): Promise<{ id: string; url: string }> {
  const sprintId = await getCurrentSprintId();

  const properties: Record<string, any> = {
    "Task name": { title: [{ text: { content: `🪲 ${bug.title}` } }] },
    Status: { status: { name: "Not started" } },
    Assignee: { people: bug.ownerIds.map((id) => ({ id })) },
    "Ticket Type": { multi_select: [{ name: "Bug" }] },
    "Bug Tracker": { relation: [{ id: bug.id }] },
  };
  if (sprintId) {
    properties.Sprint = { relation: [{ id: sprintId }] };
  }

  const page = await notion.pages.create({
    parent: { database_id: config.notion.engTaskTracker.databaseId },
    properties,
  });

  if (!isFullPage(page)) throw new Error("Notion returned a partial page response");

  // Add page content with bug details
  const contentBlocks: any[] = [
    {
      paragraph: {
        rich_text: [
          { text: { content: "Reported: " }, annotations: { bold: true } },
          { text: { content: bug.createdAt } },
        ],
      },
    },
  ];
  if (bug.slackThreadUrl) {
    contentBlocks.push({
      paragraph: {
        rich_text: [
          { text: { content: "Slack thread: " }, annotations: { bold: true } },
          { text: { content: bug.slackThreadUrl, link: { url: bug.slackThreadUrl } } },
        ],
      },
    });
  }
  await notion.blocks.children.append({
    block_id: page.id,
    children: contentBlocks,
  });

  return { id: page.id, url: page.url };
}

/** Check if an eng task already exists in the tracker for a given bug. */
async function engTaskExistsForBug(bugId: string): Promise<boolean> {
  const response = await notion.dataSources.query({
    data_source_id: config.notion.engTaskTracker.dataSourceId,
    filter: {
      property: "Bug Tracker",
      relation: { contains: bugId },
    },
  });
  return response.results.length > 0;
}

/**
 * Poll for bugs with an owner but no eng task, and create linked tasks.
 * Posts a Slack notification in the original thread when a task is created.
 */
export async function syncBugsToEngTasks(slackClient: WebClient): Promise<void> {
  try {
    const bugs = await getBugsNeedingEngTask();
    if (bugs.length === 0) return;

    console.log(`[sync] Found ${bugs.length} bug(s) needing eng tasks`);

    const batch = bugs.slice(0, MAX_SYNC_BATCH);
    if (bugs.length > MAX_SYNC_BATCH) {
      console.log(`[sync] Capping to ${MAX_SYNC_BATCH} of ${bugs.length} (rest will sync next cycle)`);
    }

    for (const bug of batch) {
      try {
        // Guard: Notion filters can return stale results — validate in code
        if (bug.ownerIds.length === 0) {
          console.log(`[sync] Bug "${bug.title}" (${bug.id}) has no owner — skipping`);
          continue;
        }
        if (await engTaskExistsForBug(bug.id)) {
          console.log(`[sync] Eng task already exists for "${bug.title}" (${bug.id}) — skipping`);
          continue;
        }
        const task = await createEngTask(bug);
        assignmentBuffer.push({ bugTitle: bug.title, taskUrl: task.url, ownerIds: bug.ownerIds });
        console.log(
          `[sync] Created eng task for "${bug.title}" → ${task.url}`
        );
        await replyInThreadWithEngTask(slackClient, bug, task);
      } catch (err) {
        console.error(`[sync] Failed to create eng task for "${bug.title}" (${bug.id}):`, err);
      }
    }
  } catch (err) {
    console.error("[sync] Failed to query bugs needing eng tasks:", err);
  }
}

/** Notify the original Slack thread that an eng task was created. */
async function replyInThreadWithEngTask(
  slackClient: WebClient,
  bug: BugNeedingEngTask,
  task: { id: string; url: string }
): Promise<void> {
  if (!bug.slackThreadUrl) return;

  const parsed = parseSlackUrl(bug.slackThreadUrl);
  if (!parsed) return;

  try {
    // Resolve assignee Slack IDs
    const slackMentions: string[] = [];
    for (const notionId of bug.ownerIds) {
      const slackId = await notionUserToSlackId(notionId, slackClient);
      if (slackId) slackMentions.push(`<@${slackId}>`);
    }

    // Get the original reporter from the thread
    const threadResult = await slackClient.conversations.replies({
      channel: parsed.channel,
      ts: parsed.threadTs,
      limit: 1,
    });
    const reporterUserId = (threadResult.messages?.[0] as any)?.user;

    const assigneeText = slackMentions.length > 0
      ? slackMentions.join(", ")
      : "an engineer";
    const reporterMention = reporterUserId ? `<@${reporterUserId}>` : "reporter";

    const text = `${reporterMention} your bug just got assigned\n\n• *Assigned to:* ${assigneeText}\n• *Reported by:* ${reporterMention}\n• *Eng ticket:* <${task.url}|${bug.title}>`;

    await slackClient.chat.postMessage({
      channel: parsed.channel,
      thread_ts: parsed.threadTs,
      text,
    });
  } catch (err) {
    console.error(`[sync] Failed to send Slack notification for "${bug.title}":`, err);
  }
}

/** Fetch bugs created in the Bug Tracker since the given cutoff. */
async function getNewBugsSince(cutoff: string): Promise<{ title: string; url: string }[]> {
  const response = await notion.dataSources.query({
    data_source_id: config.notion.dataSourceId,
    filter: {
      property: "Bug Report Created On",
      created_time: { on_or_after: cutoff },
    },
  });
  return response.results.filter(isFullPage).map((page) => {
    const nameProp = page.properties.Name;
    const title = nameProp.type === "title" ? nameProp.title[0]?.plain_text ?? "(untitled)" : "(untitled)";
    return { title, url: page.url };
  });
}

/** Fetch bug-type eng tasks completed since the given cutoff. */
async function getCompletedBugsSince(cutoff: string): Promise<{ title: string; url: string }[]> {
  const response = await notion.dataSources.query({
    data_source_id: config.notion.engTaskTracker.dataSourceId,
    filter: {
      and: [
        { property: "Ticket Type", multi_select: { contains: "Bug" } },
        { property: "Status", status: { equals: "Done" } },
        { property: "Completed At", date: { on_or_after: cutoff } },
      ],
    },
  });
  return response.results.filter(isFullPage).map((page) => {
    const nameProp = page.properties["Task name"];
    const title = nameProp.type === "title" ? nameProp.title[0]?.plain_text ?? "(untitled)" : "(untitled)";
    return { title, url: page.url };
  });
}

/** Post a 12-hour digest of new bugs, assignments, and completions to the main channel. */
export async function postAssignmentDigest(slackClient: WebClient): Promise<void> {
  const cutoff = new Date(Date.now() - 12 * 60 * 60_000).toISOString();

  const [assignments, newBugs, completedBugs] = await Promise.all([
    Promise.resolve(assignmentBuffer.splice(0)),
    getNewBugsSince(cutoff),
    getCompletedBugsSince(cutoff),
  ]);

  if (assignments.length === 0 && newBugs.length === 0 && completedBugs.length === 0) return;

  const sections: string[] = [];

  if (newBugs.length > 0) {
    const lines = newBugs.map((b) => `• <${b.url}|${b.title}>`);
    sections.push(`*Reported (${newBugs.length})*\n${lines.join("\n")}`);
  }

  if (assignments.length > 0) {
    const lines: string[] = [];
    for (const item of assignments) {
      const mentions: string[] = [];
      for (const notionId of item.ownerIds) {
        const slackId = await notionUserToSlackId(notionId, slackClient);
        if (slackId) mentions.push(`<@${slackId}>`);
      }
      const assignee = mentions.length > 0 ? mentions.join(", ") : "unlinked engineer";
      lines.push(`• <${item.taskUrl}|${item.bugTitle}> → ${assignee}`);
    }
    sections.push(`*Assigned (${assignments.length})*\n${lines.join("\n")}`);
  }

  if (completedBugs.length > 0) {
    const lines = completedBugs.map((b) => `• <${b.url}|${b.title}>`);
    sections.push(`*Completed (${completedBugs.length})*\n${lines.join("\n")}`);
  }

  const text = `*🪲 Bug Report — last 12 hours*\n\n${sections.join("\n\n")}`;

  await slackClient.chat.postMessage({
    channel: config.slack.channelId,
    text,
  });

  console.log(`[digest] Posted digest to channel: ${newBugs.length} new, ${assignments.length} assigned, ${completedBugs.length} completed`);
}

/**
 * Append a thread follow-up (text + files) to an existing ticket's body,
 * under a bolded attribution line. Used when someone adds useful detail in
 * the Slack thread after the ticket was created.
 */
export async function appendThreadUpdate(
  pageId: string,
  text: string,
  files: SlackFile[],
  authorName?: string
): Promise<void> {
  const header = {
    paragraph: {
      rich_text: [
        {
          text: { content: `Thread update${authorName ? ` from ${authorName}` : ""}:` },
          annotations: { bold: true },
        },
      ],
    },
  };
  const blocks = await buildBugContentBlocks(text, files);
  if (blocks.length === 0) return;
  await notion.blocks.children.append({
    block_id: pageId,
    children: [header, ...blocks],
  });
}

/** Append a "Also reported in: <slackUrl>" line to an existing ticket's body. */
export async function appendSlackLink(
  pageId: string,
  slackUrl: string
): Promise<void> {
  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        paragraph: {
          rich_text: [
            { text: { content: "Also reported in: " } },
            { text: { content: slackUrl, link: { url: slackUrl } } },
          ],
        },
      },
    ],
  });
}
