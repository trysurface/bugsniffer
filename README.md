# 🐛 bugsniffer

AI-powered Slack bot that sniffs out bug reports from a feedback channel and auto-creates Notion tickets — so your team can stop playing ticket secretary.

## How it works

1. Watches `#surface_product_feedback` in Slack (via Socket Mode — always on, no webhooks)
2. Sends each new message to **Claude** to classify: is it a bug? is there enough detail?
3. If yes → creates a ticket in the **Notion Bug Tracker** with title, status, and a link back to the Slack thread
4. Posts a `:bug:` confirmation reply in-thread

Feature requests, design feedback, and vague "stuff is broken" messages get ignored.

## Setup

### Prerequisites

- A **Slack App** with Socket Mode enabled ([setup guide](https://api.slack.com/apis/connections/socket))
  - Bot scopes: `channels:history`, `channels:read`, `chat:write`
  - Event subscription: `message.channels`
  - App-level token scope: `connections:write`
- A **Notion integration** with access to your bug tracker database ([create one](https://www.notion.so/my-integrations))
- An **Anthropic API key** ([get one](https://console.anthropic.com))

### Environment variables

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
NOTION_API_KEY=ntn_...
ANTHROPIC_API_KEY=sk-ant-...
```

### Run locally

```bash
cp .env.example .env  # fill in your tokens
npm install
npm run dev
```

### Deploy to Railway

1. Push to GitHub
2. Create a Railway project → Deploy from GitHub
3. Add env vars in the Railway dashboard
4. Done — it auto-deploys on push

## Tech

TypeScript · Node.js · [Slack Bolt](https://slack.dev/bolt-js/) · [Notion SDK](https://github.com/makenotion/notion-sdk-js) · [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) · Railway

## License

MIT
