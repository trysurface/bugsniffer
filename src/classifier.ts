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

export interface DuplicateResult {
  is_duplicate: boolean;
  matching_bug_id: string | null;
  reasoning: string;
}

/**
 * Check if a new bug report matches an existing unresolved bug.
 * Returns the matching bug ID if found, null otherwise.
 */
export async function findDuplicate(
  messageText: string,
  existingBugs: { id: string; title: string }[]
): Promise<DuplicateResult> {
  if (existingBugs.length === 0) {
    return { is_duplicate: false, matching_bug_id: null, reasoning: "No existing bugs to compare against." };
  }

  const bugList = existingBugs
    .map((b, i) => `${i + 1}. [${b.id}] ${b.title}`)
    .join("\n");

  const prompt = `You are a duplicate bug detector. Given a new Slack message reporting a bug and a list of existing unresolved bug tickets, determine if the new message is about the same issue as any existing ticket.

A match means the message is clearly describing the same underlying problem — even if worded differently. For example:
- "can u pls fix lead scoring issue for eragon form" matches "[Eragon] Lead scoring broken — Score column not showing"
- "the logo keeps flickering on mobile" matches "[Eragon] Logo image flickering on mobile across form steps"

Do NOT match if the message is about a different feature or a different aspect of the same feature.

Existing unresolved bugs:
${bugList}

New Slack message:
"""
${messageText}
"""

Respond with ONLY a valid JSON object (no markdown, no backticks):
{
  "is_duplicate": true/false,
  "matching_bug_id": "the [id] of the matching bug if duplicate, otherwise null",
  "reasoning": "Brief explanation"
}`;

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const raw =
      response.content[0].type === "text" ? response.content[0].text.trim() : "";
    return JSON.parse(raw) as DuplicateResult;
  } catch (err) {
    console.error("[classifier] Failed to check for duplicates:", err);
    return { is_duplicate: false, matching_bug_id: null, reasoning: "Duplicate check failed — defaulting to new ticket." };
  }
}
