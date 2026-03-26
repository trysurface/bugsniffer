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

**Stack:** TypeScript, Node.js 20, Slack Bolt, Notion SDK, Anthropic SDK

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

### Bug Tracker → Eng Task Tracker sync

Bug Tracker has a two-way relation ("Task Tracker Link" ↔ "Bug Tracker") with the Eng Task Tracker. Every 60s, we poll for bugs with an Owner but no Task Tracker Link. For each, we create an Eng Task Tracker ticket (🪲-prefixed title, same assignee, Ticket Type: Bug, page content with reported date + Slack link). Then we post a threaded reply in the original Slack thread (@-ing the assigned engineer and the reporter) with `reply_broadcast` so it shows in the channel. Notion→Slack user mapping uses email lookup (cached). See `syncBugsToEngTasks()` in `src/notion.ts`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | Bot token (xoxb-...). Scopes: channels:history, channels:read, chat:write, users:read, users:read.email |
| `SLACK_APP_TOKEN` | ✅ | App-level token (xapp-...) for Socket Mode. Scope: connections:write |
| `NOTION_API_KEY` | ✅ | Internal integration token (ntn_...) |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key (sk-ant-...) |
| `SLACK_CHANNEL_ID` | ❌ | Override channel (default: C0880RJL3SL) |
| `NOTION_DATABASE_ID` | ❌ | Override Bug Tracker database (default: 32744c625b9f804db76ee0aa3d82499d) |
| `ENG_TASK_TRACKER_DATABASE_ID` | ❌ | Override Eng Task Tracker database (default: 1b544c625b9f80d2a4c1d571160b1b67) |
| `ENG_TASK_TRACKER_DATA_SOURCE_ID` | ❌ | Override Eng Task Tracker data source (default: 1b544c62-5b9f-809d-8948-000bc8be13ed) |
| `CLASSIFIER_MODEL` | ❌ | Override Claude model (default: claude-sonnet-4-20250514) |
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
- Bug reports checked for duplicates against unresolved Notion tickets (via Claude)
- Duplicates link to existing ticket; reporter can dispute to force a new ticket
- Thread follow-ups only processed if providing bug detail; conversation is ignored
- Pending store: Redis (30-day TTL, in-memory fallback). `DUPE:` prefix for dupe-dispute vs needs-detail threads

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
- The bot must be invited to the channel (`/invite @BotName`) or it won't receive messages
- The Notion integration must be shared with both the Bug Tracker and Eng Task Tracker databases (database ⋯ → Connections → Add)
- Always use `client.chat.getPermalink()` for Slack URLs — never construct them manually (workspace subdomain varies)

## Changelog

- **2026-03-26** — Eng Task Tracker sync: auto-create linked eng tasks when bug Owner assigned; Slack notifications @-ing engineer + reporter.
- **2026-03-19** — Debounce: all bot responses wait 3s; rapid-fire messages from same user combined.
- **2026-03-19** — Dupe dispute: users can reply "that's a different bug" to override duplicate classification.
- **2026-03-19** — Thread follow-up filter: bot only responds to replies that provide bug detail.
- **2026-03-19** — Duplicate detection: new bug reports matched against unresolved Notion tickets via Claude.
- **2026-03-19** — Fixed Slack permalink generation: replaced manual URL builder with `chat.getPermalink` API.
- **2026-03-18** — Initial TypeScript rewrite. Socket Mode bot, Claude classifier, Notion integration, Railway deployment.
