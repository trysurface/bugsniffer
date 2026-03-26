import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { WebClient } from "@slack/web-api";
import type { SlackFile } from "./slack.js";
import { config } from "./config.js";

const notion = new Client({ auth: config.notion.apiKey });

// Cache Notion user ID → Slack user ID mappings to avoid repeated lookups
const notionToSlackCache = new Map<string, string | null>();

export interface NotionTicket {
  id: string;
  url: string;
}

export interface ExistingBug {
  id: string;
  title: string;
  url: string;
}

function isFullPage(page: { object: string }): page is PageObjectResponse {
  return page.object === "page" && "url" in page && "properties" in page;
}

export async function createBugTicket(
  title: string,
  slackThreadUrl: string,
  messageText: string,
  files: SlackFile[]
): Promise<NotionTicket> {
  const page = await notion.pages.create({
    parent: { database_id: config.notion.databaseId },
    properties: {
      Name: { title: [{ text: { content: title } }] },
      Status: { status: { name: "Not started" } },
      "Slack Thread URL": { url: slackThreadUrl },
    },
  });

  if (!isFullPage(page)) throw new Error("Notion returned a partial page response");

  // Build page content from the Slack message
  const blocks = buildBugContentBlocks(messageText, files);
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

/**
 * Get a publicly accessible direct URL for a Slack file.
 * Uses permalink_public + pub_secret to construct a direct URL.
 */
function getPublicFileUrl(file: SlackFile): string | null {
  if (!file.permalink_public) return null;
  // Extract the pub_secret from permalink_public
  const match = file.permalink_public.match(/pub_secret=([a-f0-9]+)/);
  if (!match) return null;
  return `${file.url_private}?pub_secret=${match[1]}`;
}

/** Build Notion blocks from Slack message text and files. */
function buildBugContentBlocks(text: string, files: SlackFile[]): any[] {
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
    const publicUrl = getPublicFileUrl(file);
    const isImage = file.mimetype?.startsWith("image/");
    const isVideo = file.mimetype?.startsWith("video/");

    if (isImage && publicUrl) {
      blocks.push({
        image: {
          external: { url: publicUrl },
          type: "external",
        },
      });
    } else if (isVideo && publicUrl) {
      blocks.push({
        video: {
          external: { url: publicUrl },
          type: "external",
        },
      });
    } else if (publicUrl) {
      // Other file types — link as bookmark
      blocks.push({ bookmark: { url: file.permalink } });
    } else {
      // No public URL — fall back to Slack permalink
      blocks.push({ bookmark: { url: file.permalink } });
    }
  }

  return blocks;
}

/** Fetch all unresolved bugs (Status != "Done") from the Notion database. */
export async function getUnresolvedBugs(): Promise<ExistingBug[]> {
  const response = await notion.dataSources.query({
    data_source_id: config.notion.dataSourceId,
    filter: {
      property: "Status",
      status: { does_not_equal: "Done" },
    },
  });

  return response.results
    .filter(isFullPage)
    .map((page) => {
      const nameProp = page.properties.Name;
      const title =
        nameProp.type === "title"
          ? nameProp.title[0]?.plain_text ?? "(untitled)"
          : "(untitled)";
      return { id: page.id, title, url: page.url };
    });
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
        { property: "Status", status: { does_not_equal: "Done" } },
        { property: "Status", status: { does_not_equal: "Cancelled" } },
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

    const createdProp = page.properties.created;
    const createdAt =
      createdProp.type === "created_time"
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

/**
 * Poll for bugs with an owner but no eng task, and create linked tasks.
 * Posts a Slack notification in the original thread when a task is created.
 */
export async function syncBugsToEngTasks(slackClient: WebClient): Promise<void> {
  try {
    const bugs = await getBugsNeedingEngTask();
    if (bugs.length === 0) return;

    console.log(`[sync] Found ${bugs.length} bug(s) needing eng tasks`);

    for (const bug of bugs) {
      try {
        const task = await createEngTask(bug);
        console.log(
          `[sync] Created eng task for "${bug.title}" → ${task.url}`
        );
        await notifySlackOfEngTask(slackClient, bug, task);
      } catch (err) {
        console.error(`[sync] Failed to create eng task for "${bug.title}" (${bug.id}):`, err);
      }
    }
  } catch (err) {
    console.error("[sync] Failed to query bugs needing eng tasks:", err);
  }
}

/** Notify the original Slack thread that an eng task was created. */
async function notifySlackOfEngTask(
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
      reply_broadcast: true,
      text,
    });
  } catch (err) {
    console.error(`[sync] Failed to send Slack notification for "${bug.title}":`, err);
  }
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
