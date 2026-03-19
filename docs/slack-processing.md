# Slack Message Processing

How bugsniffer processes messages from `#surface_product_feedback`.

## Debounce

All responses are debounced by 3 seconds (`DEBOUNCE_MS` in `src/slack.ts`). This handles users who send rapid-fire messages.

- **Top-level messages:** Debounced by user ID. Consecutive messages from the same user within a 30-second window are combined into a single text before classification.
- **Thread replies:** Debounced by `thread_ts`. All recent non-bot replies are available when processing fires.

## Top-level message flow

1. **Skip check** — bot messages, system subtypes, empty text, wrong channel are all filtered out (`shouldSkipMessage()`).
2. **Classification** — Claude determines: is it a bug? Does it have enough detail?
3. **Not a bug** → silently ignored (feature requests, design feedback, chit-chat).
4. **Bug → duplicate check** — queries all unresolved Notion tickets, asks Claude if this matches an existing one.
   - **Duplicate found** → appends new Slack URL to existing ticket body, replies in-thread telling the reporter. Thread is tracked for dispute (stored with `DUPE:` prefix).
   - **Not a duplicate** → continues to step 5.
5. **Insufficient detail** → bot replies in-thread asking for more info. Thread is stored in pending store with the original text.
6. **Sufficient detail** → creates Notion ticket, replies in-thread with confirmation and link.

## Thread reply flow

Thread replies are only processed if their `thread_ts` is in the pending store. Two cases:

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
- Values: original message text. Prefixed with `DUPE:` for duplicate-dispute threads.
- Threads are removed from the store once a ticket is created or a dispute is resolved.
