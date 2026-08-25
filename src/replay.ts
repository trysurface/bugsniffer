/**
 * Re-run the bot's message pipeline for specific Slack messages that were
 * missed (e.g. during an outage). Runs against prod env via:
 *   railway run npx tsx src/replay.ts <message_ts> [<message_ts> ...]
 * Uses the exact same processMessage() as the live bot, so dedup, reporter
 * mapping, screenshot upload, thread replies and store entries all match.
 */
import { WebClient } from "@slack/web-api";
import { config } from "./config.js";
import { processMessage } from "./slack.js";

async function main() {
  const tsList = process.argv.slice(2);
  if (tsList.length === 0) {
    console.error("Usage: tsx src/replay.ts <message_ts> ...");
    process.exit(1);
  }
  const client = new WebClient(config.slack.botToken);
  const channel = config.slack.channelId;

  for (const ts of tsList) {
    const res = await client.conversations.history({ channel, latest: ts, oldest: ts, inclusive: true, limit: 1 });
    const msg = res.messages?.[0];
    if (!msg || msg.ts !== ts) {
      console.error(`[replay] Message ${ts} not found in ${channel}`);
      continue;
    }
    const say = (args: { text: string; [k: string]: unknown }) => client.chat.postMessage({ channel, ...args });
    console.log(`[replay] Reprocessing ${ts}`);
    await processMessage({ ...(msg as object), channel } as Parameters<typeof processMessage>[0], say, client);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
