# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# bugsniffer

## ⚠️ Maintaining this file

**You MUST keep this file up to date.** This is the single source of truth for anyone (human or AI) picking up this project.

**Hard rule: this file must stay under 150 lines.** If an update would push it over, cut something — merge sections, shorten descriptions, or remove info that's obvious from the code. Brevity is a feature.

After every task that changes behavior, structure, deps, or config:

1. **Update the relevant section** — don't just append, replace stale info.
2. **Add a changelog entry** at the bottom (date + one-liner). Keep max 10 entries; drop the oldest.
3. **Delete, don't accumulate.** Renamed a file? Update Source layout and remove the old name. Removed a feature? Remove its docs. Outdated info is actively harmful.
4. **Document *why* and *where*, not *how*.** The code is the how. If you're explaining logic that's readable in the source, delete the explanation.
5. **No section should exceed ~15 lines.** If it does, you're over-documenting — refactor or split.
6. **Overflow to `docs/*.md` only if absolutely necessary.** If a topic (e.g. a complex API schema, migration guide) genuinely can't fit within the 150-line budget without gutting other essential sections, create a separate markdown file in `docs/` and link to it from here. This should be rare — most things belong in this file or in code comments.

---

## What this project is

bugsniffer is a background service that monitors the `#surface_product_feedback` Slack channel for bug reports and automatically creates tickets in a Notion database. It runs 24/7 on Railway via Slack Socket Mode (persistent WebSocket — no webhooks, no cron).

## Architecture

```
Slack (Socket Mode) → Message handler → Claude classifier → Notion ticket creator → Slack thread reply
```

**Stack:** TypeScript 7 (native compiler), Node.js 20, Slack Bolt, Notion SDK, Anthropic SDK

**Source layout:**
- `src/index.ts` — entry point, starts health server + Slack app + eng task sync polling
- `src/config.ts` — env var loading and validation
- `src/classifier.ts` — Claude-powered message classification
- `src/slack.ts` — Slack Bolt app, message event handler, orchestration
- `src/notion.ts` — Notion ticket creation + Bug→Eng Task Tracker sync
- `src/store.ts` — pending thread persistence (Redis or in-memory fallback)
- `src/health.ts` — HTTP health check server (Railway needs a PORT listener)

## How the classification works

Every new top-level message in #surface_product_feedback gets sent to Claude Sonnet for classification. The classifier answers two questions:

1. **Is it a bug report?** — Must be an actual bug, not a feature request ("we need a way to archive forms"), design feedback ("don't like how this page looks"), general question, or chit-chat.
2. **Does it have sufficient detail?** — Needs at least one of: steps to reproduce, a Loom video, screenshots, or a specific enough description that an engineer could investigate.

Only if BOTH are true does a Notion ticket get created.

The classifier prompt is in `src/classifier.ts` → `buildPrompt()`. If classification accuracy needs tuning, that's the place to edit.

## Key IDs and constants

- **Slack channel:** `#surface_product_feedback` → `C0880RJL3SL`
- **Bug Tracker DB:** `32744c625b9f804db76ee0aa3d82499d` / data source `32744c62-5b9f-8062-9558-000b7f139468`
- **Eng Task Tracker DB:** `1b544c625b9f80d2a4c1d571160b1b67` / data source `1b544c62-5b9f-809d-8948-000bc8be13ed`
- **Bug Tracker URL:** `https://www.notion.so/withsurface/32744c625b9f804db76ee0aa3d82499d?v=32744c625b9f8033b00d000cec98e078`
- **Bug Tracker schema:** `Name` (title), `Owner` (person), `Reporter` (person — the Slack message author, mapped by email), `Slack Thread URL` (url), `Task Tracker Link` (relation), `Bug Report Created On` (created_time). ⚠️ Property names are read by exact string in `src/notion.ts` — a rename in Notion silently breaks the code (`.type` on `undefined` throws and kills the sync). Access defensively (`prop?.type`). ⚠️ **No `Status` property** — bug status is derived from the linked Eng Task's status (`Eng Sprint Status (Linked)` rollup). Do not add `Status` filters/props to Bug Tracker queries. (The Eng Task Tracker *does* have `Status`.)

### Bug Tracker → Eng Task Tracker sync

Bug Tracker has a two-way relation ("Task Tracker Link" ↔ "Bug Tracker") with the Eng Task Tracker. Every 10s (self-scheduling loop in `src/index.ts` — waits 10s *after* each run finishes, so runs never overlap; overlap would double-create tasks since the relation isn't populated until a run completes), we poll for bugs with an Owner but no Task Tracker Link. For each, we verify no eng task already exists (dedup check against Eng Task Tracker), then create one (🪲-prefixed title, same assignee, Ticket Type: Bug, page content with reported date + Slack link). Sync is capped at 5 bugs per cycle to limit blast radius. We post a threaded reply in the original Slack thread (@-ing the assigned engineer and the reporter). Every 12 hours, a digest of all assignments since the last report is posted to the main channel. Notion→Slack user mapping uses email lookup (cached). See `syncBugsToEngTasks()` and `postAssignmentDigest()` in `src/notion.ts`. When a bug's linked eng task flips to **Done** (treated as "merged"), the same 10s loop posts a one-time congratulation in the original thread thanking the assignee (`notifyMergedBugs()`; deduped via a `bugsniffer:merged:<bugId>` store marker, and floored at process start so a deploy never backfills old threads).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | Bot token (xoxb-...). Scopes: channels:history, channels:read, chat:write, users:read, users:read.email, files:read (authenticated file download for Notion upload), reactions:write (📝 ack on ticket-thread appends) |
| `SLACK_APP_TOKEN` | ✅ | App-level token (xapp-...) for Socket Mode. Scope: connections:write |
| `NOTION_API_KEY` | ✅ | Internal integration token (ntn_...) |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key (sk-ant-...) |
| `SLACK_CHANNEL_ID` | ❌ | Override channel (default: C0880RJL3SL) |
| `NOTION_DATABASE_ID` | ❌ | Override Bug Tracker database (default: 32744c625b9f804db76ee0aa3d82499d) |
| `ENG_TASK_TRACKER_DATABASE_ID` | ❌ | Override Eng Task Tracker database (default: 1b544c625b9f80d2a4c1d571160b1b67) |
| `ENG_TASK_TRACKER_DATA_SOURCE_ID` | ❌ | Override Eng Task Tracker data source (default: 1b544c62-5b9f-809d-8948-000bc8be13ed) |
| `CLASSIFIER_MODEL` | ❌ | Override Claude model (default: claude-sonnet-5). ⚠️ Model IDs get retired — a retired ID makes every classification 404 and the bot goes silently dead. Verify against the current model list if changing. |
| `REDIS_URL` | ❌ | Redis connection URL for pending thread persistence (falls back to in-memory if unset) |
| `PORT` | ❌ | Health check port (default: 3000) |

## Commands

```bash
npm run dev        # Run locally with hot-reload (tsx watch)
npm run build      # Compile TypeScript to dist/
npm run start      # Run compiled JS (production)
npm run typecheck  # Type-check without emitting
```

## Deployment

Deployed on Railway. Pushes to main auto-deploy via GitHub integration.

The Dockerfile uses a multi-stage build: compile TS in a builder stage, copy only dist + production deps to the final image.

Railway env vars are set in the Railway dashboard (not committed).

**Debugging:** Railway CLI is linked to the `bugsniffer` service. Use `railway logs -n 80` to fetch recent logs, or `railway logs` to stream live. Always check logs after deploying new features.

## Message filtering & thread loop

See [`docs/slack-processing.md`](docs/slack-processing.md) for the full flow. Key points:

- All responses debounced (3s); rapid-fire messages from same user combined (30s window)
- Bug reports checked for duplicates against all non-Done Notion tickets (via Claude) — see `getOpenBugsForDedup()`. "Done" is derived from the linked eng task's `Eng Sprint Status (Linked)` rollup (`isBugDone`); Done bugs are excluded so a re-emerged bug can file a fresh ticket. Matches against an in-progress ticket (has an Owner) get a distinct "already being worked on by X" reply.
- Duplicates link to existing ticket; reporter can dispute to force a new ticket
- Ambiguous reports (borderline bug, improvement to existing functionality, or small UX affordance on existing UI — but slow performance is always a bug) aren't skipped — bot asks in-thread with Yes/No buttons (`bug_confirm_yes`/`_no` actions); Yes files a ticket directly (no dedup — human decided). Unanswered prompts ping the reporter every 4h, max 3 times (`remindStaleConfirmations`)
- Larger feature requests get a one-off reply pointing at the Lead Ops / Content Ops Roadmaps (self-serve; URLs in `src/slack.ts`) — no ticket, no thread tracking
- Thread follow-ups only processed if providing bug detail; conversation is ignored
- After a ticket is created its thread stays watched: replies adding detail are appended to the Notion page (`appendThreadUpdate`), acked with a 📝 reaction
- Pending store: Redis (30-day TTL, in-memory fallback). Value prefixes route thread replies: none = needs-detail, `DUPE:` dispute, `CONFIRM:` awaiting buttons, `TICKET:` ticket exists (pageId + lastTs watermark)

## Future work

- **Tune classification:** Edit prompt in `src/classifier.ts` → `buildPrompt()`
- **New Notion fields:** Update `src/notion.ts` → `createBugTicket()` + DB schema
- **Emoji triage:** `reaction_added` event already subscribed — implement handler in `src/slack.ts`

## Manual data fixes via MCP

Notion and Slack MCP servers are configured for this project. Use them in Claude Code to query and fix data directly (e.g. correcting Slack Thread URLs, backfilling missed tickets, fixing bot replies in wrong threads). See `claude mcp list` for configured servers.

**When manual fixes are needed, always review app code to diagnose why.** Manual intervention (wrong Notion data, missed bug reports, bot replying in the wrong place, not responding at all) signals a code bug — fix the root cause, not just the data.

## Gotchas

- **Never use `as any` to silence type errors.** If the SDK types don't match, check the SDK version's actual API surface (e.g. Notion SDK v5 moved `databases.query` → `dataSources.query`). Casting hides runtime errors.
- Slack Socket Mode requires the `SLACK_APP_TOKEN` (app-level token), separate from the bot token
- The Yes/No buttons require **Interactivity** toggled on in the Slack app config (payloads arrive via Socket Mode; no Request URL) — without it, clicks silently do nothing
- The bot must be invited to the channel (`/invite @BotName`) or it won't receive messages
- The Notion integration must be shared with both the Bug Tracker and Eng Task Tracker databases (database ⋯ → Connections → Add)
- Always use `client.chat.getPermalink()` for Slack URLs — never construct them manually (workspace subdomain varies)

## Changelog

- **2026-07-31** — classifier: slow performance is always a bug (was ambiguous → Yes/No prompt); perf complaints auto-file. Unanswered Yes/No prompts now nag: `remindStaleConfirmations()` (1min sweep from index.ts) pings the reporter in-thread every 4h, max 3 times; state in the `CONFIRM:` JSON, new `listPendingThreads()` in store.
- **2026-07-22** — Bug reporters get told when their bug ships: `notifyMergedBugs()` polls (same 10s loop) for Done bug-type eng tasks and posts a one-time "your bug got merged" thread reply thanking the assignee. Deduped via a `bugsniffer:merged:` store marker + floored at process start (no backfill spam). Also bumped TypeScript 5.9 → 7.0 (native compiler); tsconfig unchanged, commonjs emit + declarations verified.

- **2026-07-14** — Fixed silent eng-task sync outage: the Bug Tracker's `created` property was renamed to `Bug Report Created On` in Notion. `getBugsNeedingEngTask()` read `page.properties.created` → `undefined.type` → threw every cycle, so no eng tasks were created for any assigned bug. Updated both references (`getBugsNeedingEngTask`, `getNewBugsSince` digest filter) to the new name and made the `.type` read optional-chained. Also: sync poll 60s→10s and switched from `setInterval` to a self-scheduling loop so runs can't overlap (overlap → duplicate eng tasks).
- **2026-07-13** — Ambiguity widened: small UX affordances on existing UI ("X should be clickable", hover info) now also trigger the Yes/No prompt. Larger feature requests (`is_feature_request`) get a reply pointing at the Lead Ops / Content Ops Roadmaps instead of a silent skip; design opinions, questions, chit-chat stay silent.
- **2026-07-10** — Ambiguous reports (borderline bug / improvement) now get in-thread Yes/No buttons instead of a silent skip (`is_ambiguous` in classifier, `CONFIRM:` store prefix; needs Interactivity enabled in the Slack app). Ticket threads stay watched (`TICKET:` prefix): detail-adding replies are appended to the Notion page with screenshots (`appendThreadUpdate`), 📝 reaction ack (needs `reactions:write`). Also fixed needs-detail→dupe path deleting the `DUPE:` entry, which broke dispute handling.
- **2026-07-07** — Dedup no longer uses a 90-day recency window (too many false positives — bugs re-emerge). `getRecentBugs()` → `getOpenBugsForDedup()`: compares against all non-Done bugs (Done derived from `Eng Sprint Status (Linked)` rollup via `isBugDone`), tagging each with `ownerNames`/`inProgress`. Duplicate replies now branch — in-progress matches (has Owner) say "already being worked on by X", unassigned matches get the standard reply.
- **2026-07-07** — Bug screenshots are now uploaded into Notion (self-hosted) instead of hotlinked to Slack. `uploadSlackFileToNotion()` in `src/notion.ts` downloads the file with the bot token (needs `files:read`) and uses Notion's Direct File Upload API (`fileUploads.create`/`send`, single-part ≤20MB); falls back to a bookmark link if upload fails. Videos/non-images stay bookmarks. Removed `makeFilesPublic`/`sharedPublicURL` (needs a user token — always failed with the bot token).
- **2026-07-07** — Added `Reporter` (person) to Bug Tracker, auto-set to the Slack message author. `slackUserToNotionId()` in `src/notion.ts` maps Slack sender → Notion member by email (reverse of `notionUserToSlackId`, cached via workspace member list). For thread follow-ups the reporter is the thread's root author, not the replier.
- **2026-07-01** — Fixed 2-week silent outage: classifier model `claude-sonnet-4-20250514` had been retired (404 → swallowed → bot classified everything as "not a bug"). Switched default to `claude-sonnet-5`. Also removed stale `Status` references from Bug Tracker queries (property was deleted from the DB); dedup now scopes by recency (`getRecentBugs`, 90d) instead of status. Hardened classifier text extraction to scan for the text block and strip ```json markdown fences (sonnet-5 fences inconsistently, which broke JSON.parse). Ticket-created Slack reply now links the created bug page instead of the DB "Everything" view.