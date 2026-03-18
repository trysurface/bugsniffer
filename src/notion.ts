import { Client } from "@notionhq/client";
import { config } from "./config.js";

const notion = new Client({ auth: config.notion.apiKey });

export interface NotionTicket {
  id: string;
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
