import { validateConfig, config } from "./config.js";
import { createSlackApp } from "./slack.js";
import { startHealthServer } from "./health.js";
import { syncBugsToEngTasks, notifyMergedBugs, postAssignmentDigest } from "./notion.js";

const ENG_TASK_SYNC_INTERVAL_MS = 10_000; // 10 seconds (gap between runs, not a fixed clock)
const DIGEST_INTERVAL_MS = 12 * 60 * 60_000; // 12 hours

/**
 * Self-scheduling sync loop: waits ENG_TASK_SYNC_INTERVAL_MS *after* each run
 * finishes before starting the next. Unlike setInterval, this guarantees runs
 * never overlap — overlapping runs would double-create eng tasks, since the
 * Task Tracker Link relation isn't populated until a run's createEngTask
 * completes (nothing else guards against the race).
 */
function startEngTaskSyncLoop(slackClient: Parameters<typeof syncBugsToEngTasks>[0]): void {
  const tick = async (): Promise<void> => {
    try {
      await syncBugsToEngTasks(slackClient); // catches internally today; guard anyway
      await notifyMergedBugs(slackClient); // congratulate threads for bugs that merged
    } catch (err) {
      console.error("[sync] Unexpected error in sync loop:", err);
    } finally {
      setTimeout(tick, ENG_TASK_SYNC_INTERVAL_MS); // reschedule even if a run threw
    }
  };
  tick();
}

async function main(): Promise<void> {
  validateConfig();

  startHealthServer();

  const app = createSlackApp();
  await app.start();

  // Start polling for bugs that need eng task tracker tickets
  const slackClient = app.client;
  startEngTaskSyncLoop(slackClient);

  // Post assignment digest to channel every 12 hours
  setInterval(() => postAssignmentDigest(slackClient), DIGEST_INTERVAL_MS);

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
