# Slack Message Processing

How bugsniffer processes messages from `#surface_product_feedback`.

## Debounce

All responses are debounced by 3 seconds (`DEBOUNCE_MS` in `src/slack.ts`). This handles users who send rapid-fire messages.

- **Top-level messages:** Debounced by user ID. Consecutive messages from the same user within a 30-second window are combined into a single text before classification.
- **Thread replies:** Debounced by `thread_ts`. All recent non-bot replies are available when processing fires.

## Top-level message flow

1. **Skip check** — bot messages, system subtypes, empty text, wrong channel are all filtered out (`shouldSkipMessage()`).
2. **Classification** — Claude determines: is it a bug? Is it ambiguous? Does it have enough detail?
3. **Not a bug, not ambiguous** → two sub-cases:
   - **Feature request** (substantial new functionality — new modes, pages, workflows, integrations) → filed on the product **Roadmap** database as `Type: Idea` (lands in the "Ideas from #product-feedback" view). `draftIdea()` in `src/classifier.ts` writes a Summary / Problem / Proposal / Open questions write-up; `createRoadmapIdea()` in `src/notion.ts` builds the page with a Slack-permalink callout, reporter name, the verbatim message and uploaded screenshots. One-off threaded reply links the new page. No dedup, no thread tracking.
   - **Everything else** (design opinions, questions, chit-chat) → silently ignored.
4. **Ambiguous** (borderline bug-vs-not, an improvement to existing functionality — "should also show X", "Improvement Needed" posts — or a small UX affordance on existing UI, e.g. "X should be clickable"; slow performance is NOT ambiguous, it's always a bug) → bot posts an in-thread prompt with **Yes/No buttons** asking whether to file a ticket (`askTicketConfirmation`). Thread stored with `CONFIRM:` prefix (JSON: text, suggested title, reporter, reminder state).
   - **Yes** → ticket created immediately (no dedup check — a human explicitly asked), buttons replaced with a confirmation. Thread transitions to `TICKET:` watching.
   - **No** → buttons replaced with a dismissal note, pending entry cleared.
   - Text replies in these threads are ignored — the buttons are the interface.
   - Requires **Interactivity** enabled in the Slack app config (payloads arrive over Socket Mode; no Request URL needed).
5. **Bug → duplicate check** — queries all non-Done Notion tickets (`getOpenBugsForDedup`; Done bugs excluded so re-emerged bugs can re-file), asks Claude if this matches an existing one.
   - **Duplicate found** → appends new Slack URL to existing ticket body, replies in-thread. Reply branches on ownership: in-progress tickets (have an Owner) say "already being worked on by X"; unassigned tickets get the standard reply. Thread is tracked for dispute (stored with `DUPE:` prefix).
   - **Not a duplicate** → continues to step 6.
6. **Insufficient detail** → bot replies in-thread asking for more info. Thread is stored in pending store with the original text.
7. **Sufficient detail** → creates Notion ticket, replies in-thread with confirmation and link. Thread stays watched (`TICKET:` prefix) so later replies can enrich the ticket.

## Thread reply flow

Thread replies are only processed if their `thread_ts` is in the pending store. Four cases:

### Confirmation threads (`CONFIRM:` prefix)
- Awaiting a Yes/No button click on the "is this worth a ticket?" prompt. Text replies are ignored.
- **Unanswered prompts get reminders:** a sweep loop (`remindStaleConfirmations`, every minute from `src/index.ts`) pings the reporter in-thread every 4 hours, up to 3 times (`CONFIRM_REMINDER_INTERVAL_MS` / `CONFIRM_MAX_REMINDERS` in `src/slack.ts`), then goes quiet. Reminder count and last-ping time live in the `CONFIRM:` JSON; the sweep re-checks the entry after posting so a button click mid-sweep isn't resurrected.

### Ticket threads (`TICKET:` prefix)
- The thread already has a Notion ticket (JSON value: `pageId` + `lastTs` watermark).
- On each reply burst, all non-bot replies newer than `lastTs` are collected; the watermark advances regardless of outcome (so conversational replies aren't re-evaluated later).
- If Claude judges the batch as adding useful detail (`isProvidingBugDetail`), text + screenshots are appended to the ticket body (`appendThreadUpdate` — same block builder as ticket creation, so images are uploaded into Notion) with a bolded "Thread update from <name>" attribution.
- Successful appends are acknowledged with a 📝 reaction (needs `reactions:write`; logs a warning without it).

### Dupe-dispute threads (`DUPE:` prefix)
- Fetches all recent non-bot replies in the thread (not just the latest message).
- Asks Claude if the combined replies are disputing the duplicate classification.
- **Disputing** → creates a new ticket, confirms in-thread.
- **Not disputing** → silently ignored (e.g. "ok thanks", general conversation).

### Needs-detail threads (no prefix)
- First checks if the reply is actually providing bug detail (via Claude). Conversational replies like "yea I'll get this in before lunch" are silently ignored.
- If providing detail: combines with original text, re-classifies.
  - Still insufficient → replies asking for more detail.
  - Sufficient → runs duplicate check, then creates ticket if no match.

## Pending store

- Backed by Redis (`REDIS_URL`) with 30-day TTL. Falls back to in-memory `Map` if unset.
- Keys: `thread_ts` of the parent message.
- Values by prefix: no prefix = needs-detail (original text); `DUPE:` = duplicate-dispute (original text); `CONFIRM:` = awaiting Yes/No buttons (JSON: text, title, reporter, reminders, lastRemindAt); `TICKET:` = ticket exists, watching for detail (JSON: pageId, lastTs watermark).
- Ticket creation transitions the thread to `TICKET:` (it stays watched for ~30 days via the TTL); a dismissed confirmation or resolved dispute clears the entry.
