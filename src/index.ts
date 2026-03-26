import { validateConfig, config } from "./config.js";
import { createSlackApp } from "./slack.js";
import { startHealthServer } from "./health.js";
import { syncBugsToEngTasks } from "./notion.js";

const ENG_TASK_SYNC_INTERVAL_MS = 60_000; // 1 minute

async function main(): Promise<void> {
  validateConfig();

  startHealthServer();

  const app = createSlackApp();
  await app.start();

  // Start polling for bugs that need eng task tracker tickets
  const slackClient = app.client;
  setInterval(() => syncBugsToEngTasks(slackClient), ENG_TASK_SYNC_INTERVAL_MS);
  // Run once immediately on startup
  syncBugsToEngTasks(slackClient);

  console.log("⚡ bugsniffer is live!");
  console.log(`   Watching: #surface_product_feedback (${config.slack.channelId})`);
  console.log(`   Notion DB: ${config.notion.databaseId}`);
  console.log(`   Eng Task Tracker: ${config.notion.engTaskTracker.databaseId}`);
  console.log(`   Classifier: ${config.anthropic.model}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
