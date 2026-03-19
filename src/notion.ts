import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
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

function isFullPage(page: { object: string }): page is PageObjectResponse {
  return page.object === "page" && "url" in page && "properties" in page;
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

  if (!isFullPage(page)) throw new Error("Notion returned a partial page response");
  return { id: page.id, url: page.url };
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
