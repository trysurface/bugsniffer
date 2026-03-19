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
- `src/index.ts` — entry point, starts health server + Slack app
- `src/config.ts` — env var loading and validation
- `src/classifier.ts` — Claude-powered message classification
- `src/slack.ts` — Slack Bolt app, message event handler, orchestration
- `src/notion.ts` — Notion ticket creation
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
- **Notion database:** Bug Tracker → `32744c625b9f804db76ee0aa3d82499d`
- **Notion data source ID:** `32744c62-5b9f-8062-9558-000b7f139468`
- **Notion DB URL:** `https://www.notion.so/withsurface/32744c625b9f804db76ee0aa3d82499d?v=32744c625b9f8033b00d000cec98e078`

### Notion database schema

The Bug Tracker database has these properties:
| Property | Type | Notes |
|---|---|---|
| Name | title | Bug title (required) |
| Status | status | "Not started", "In progress", "Done" |
| Owner | person | Assignee |
| Slack Thread URL | url | Link back to the original Slack message |
| Completed At | date | When bug was resolved |
| created | created_time | Auto-set by Notion |

When creating tickets, we set: Name, Status ("Not started"), and Slack Thread URL.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | Bot token (xoxb-...). Scopes: channels:history, channels:read, chat:write |
| `SLACK_APP_TOKEN` | ✅ | App-level token (xapp-...) for Socket Mode. Scope: connections:write |
| `NOTION_API_KEY` | ✅ | Internal integration token (ntn_...) |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key (sk-ant-...) |
| `SLACK_CHANNEL_ID` | ❌ | Override channel (default: C0880RJL3SL) |
| `NOTION_DATABASE_ID` | ❌ | Override database (default: 32744c625b9f804db76ee0aa3d82499d) |
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

## Message filtering & thread loop

Top-level messages are classified immediately. If a message is a bug but lacks detail, the bot replies in-thread asking for more, and persists the thread via `src/store.ts`. Replies in pending threads are re-classified with combined context; on success a ticket is created and the thread is removed from pending.

Non-bot, non-empty, correct-channel messages only. See `shouldSkipMessage()` in `src/slack.ts`. Thread replies are only processed if their `thread_ts` is in the pending store.

Pending threads stored in Redis with a 30-day TTL. Falls back to in-memory Map if `REDIS_URL` is not set.

## Future work

- **Tune classification:** Edit prompt in `src/classifier.ts` → `buildPrompt()`
- **New Notion fields:** Update `src/notion.ts` → `createBugTicket()` + DB schema
- **Emoji triage:** `reaction_added` event already subscribed — implement handler in `src/slack.ts`
- **Priority detection:** Extend classifier JSON → map to Notion property

## Manual data fixes via MCP

Notion and Slack MCP servers are configured for this project. Use them in Claude Code to query and fix data directly (e.g. correcting Slack Thread URLs, backfilling missed tickets, fixing bot replies in wrong threads). See `claude mcp list` for configured servers.

**When manual fixes are needed, always review app code to diagnose why.** Manual intervention (wrong Notion data, missed bug reports, bot replying in the wrong place, not responding at all) signals a code bug — fix the root cause, not just the data.

## Gotchas

- The Notion SDK typing for `pages.create()` response doesn't include `.url` directly — we cast through `any` in `src/notion.ts`
- Slack Socket Mode requires the `SLACK_APP_TOKEN` (app-level token), separate from the bot token
- The bot must be invited to the channel (`/invite @BotName`) or it won't receive messages
- The Notion integration must be shared with the Bug Tracker database (database ⋯ → Connections → Add)
- Always use `client.chat.getPermalink()` for Slack URLs — never construct them manually (workspace subdomain varies)

## Changelog

- **2026-03-19** — Fixed Slack permalink generation: replaced manual URL builder with `chat.getPermalink` API. Manual URL was missing workspace subdomain.
- **2026-03-18** — Initial TypeScript rewrite. Socket Mode bot, Claude classifier, Notion integration, Railway deployment.
- **2026-03-18** — Thread follow-up loop: bot asks for detail on thin reports, re-classifies replies, creates ticket when sufficient.
- **2026-03-18** — Redis persistence for pending threads via `src/store.ts` (ioredis); falls back to in-memory if `REDIS_URL` unset.
