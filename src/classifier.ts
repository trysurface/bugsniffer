import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

export interface ClassificationResult {
  is_bug: boolean;
  has_sufficient_detail: boolean;
  suggested_title: string | null;
  reasoning: string;
}

function buildPrompt(
  messageText: string,
  hasFiles: boolean,
  hasLoomLink: boolean
): string {
  return `You are a bug report classifier for a SaaS product called Surface (a forms/survey builder).

Analyze the following Slack message and determine:
1. Is this a bug report? (NOT a feature request, design feedback, general question, or chit-chat)
2. If it IS a bug report, does it have sufficient detail to act on? Sufficient means at least one of:
   - Steps to reproduce or a description of what happened vs what was expected
   - A Loom video link
   - Screenshots showing the bug (the message has attachments: ${hasFiles ? "YES" : "NO"})
   - Specific enough description that an engineer could investigate (e.g. mentions specific feature, page, or error)

A message like "things are broken" is NOT sufficient.
A message like "the logic flow nodes aren't connected by default" with a screenshot IS sufficient.
A message like "lead scoring is not working — no column for Score is being shown" with a screenshot IS sufficient.
A message like "really don't like how this page looks" is design feedback, NOT a bug.
A message like "we need a way to archive forms" is a feature request, NOT a bug.

The message contains a Loom link: ${hasLoomLink ? "YES" : "NO"}

Respond with ONLY a valid JSON object (no markdown, no backticks):
{
  "is_bug": true/false,
  "has_sufficient_detail": true/false,
  "suggested_title": "Short descriptive title for the bug ticket (only if is_bug && has_sufficient_detail, otherwise null)",
  "reasoning": "Brief explanation of your classification"
}

Slack message:
"""
${messageText}
"""`;
}

const FALLBACK: ClassificationResult = {
  is_bug: false,
  has_sufficient_detail: false,
  suggested_title: null,
  reasoning: "Classification failed — defaulting to skip.",
};

export async function classifyMessage(
  text: string,
  hasFiles: boolean
): Promise<ClassificationResult> {
  const hasLoomLink = /loom\.com\/share/i.test(text);

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 500,
      messages: [
        { role: "user", content: buildPrompt(text, hasFiles, hasLoomLink) },
      ],
    });

    const raw =
      response.content[0].type === "text" ? response.content[0].text.trim() : "";
    return JSON.parse(raw) as ClassificationResult;
  } catch (err) {
    console.error("[classifier] Failed to classify message:", err);
    return FALLBACK;
  }
}
