import { Client } from "@notionhq/client";
import { config } from "./config.js";

const notion = new Client({ auth: config.notion.apiKey });

export interface NotionTicket {
  id: string;
  url: string;
}

export interface ExistingBug {
  id: string;
  title: string;
  url: string;
}

export async function createBugTicket(
  title: string,
  slackThreadUrl: string
): Promise<NotionTicket> {
  const page = await notion.pages.create({
    parent: { database_id: config.notion.databaseId },
    properties: {
      Name: { title: [{ text: { content: title } }] },
      Status: { status: { name: "Not started" } },
      "Slack Thread URL": { url: slackThreadUrl },
    },
  });

  return { id: page.id, url: (page as any).url as string };
}

/** Fetch all unresolved bugs (Status != "Done") from the Notion database. */
export async function getUnresolvedBugs(): Promise<ExistingBug[]> {
  const response = await (notion as any).databases.query({
    database_id: config.notion.databaseId,
    filter: {
      property: "Status",
      status: { does_not_equal: "Done" },
    },
  });

  return response.results.map((page: any) => ({
    id: page.id,
    title:
      page.properties.Name?.title?.[0]?.text?.content ?? "(untitled)",
    url: page.url as string,
  }));
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
      } as any,
    ],
  });
}
