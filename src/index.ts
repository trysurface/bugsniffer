import { validateConfig, config } from "./config.js";
import { createSlackApp } from "./slack.js";
import { startHealthServer } from "./health.js";

async function main(): Promise<void> {
  validateConfig();

  startHealthServer();

  const app = createSlackApp();
  await app.start();

  console.log("⚡ bugsniffer is live!");
  console.log(`   Watching: #surface_product_feedback (${config.slack.channelId})`);
  console.log(`   Notion DB: ${config.notion.databaseId}`);
  console.log(`   Classifier: ${config.anthropic.model}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
