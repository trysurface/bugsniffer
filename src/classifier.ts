import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Extract the text response from a Claude message by scanning for the first
 * text block, rather than assuming content[0]. Thinking-capable models (e.g.
 * the 5-series) may emit a thinking block first; assuming content[0] would
 * yield "" and silently break JSON parsing.
 */
function extractText(response: Anthropic.Message): string {
  // A truncated response is never valid JSON — fail loudly with the real cause
  // instead of an opaque "Unterminated string in JSON" from JSON.parse.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Claude response truncated at max_tokens (${response.usage.output_tokens} output tokens) — raise the budget`
    );
  }
  const block = response.content.find((b) => b.type === "text");
  let text = block?.type === "text" ? block.text.trim() : "";
  // Some models wrap JSON in a ```json … ``` markdown fence despite being told
  // not to; strip it so JSON.parse doesn't choke on the backticks.
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  return text;
}

export interface ClassificationResult {
  is_bug: boolean;
  /**
   * True when the message isn't clearly a bug but a reasonable person might
   * still want a ticket — borderline bug-vs-not calls and improvements to
   * existing functionality. Triggers a Yes/No confirmation prompt in Slack
   * instead of a silent skip.
   */
  is_ambiguous: boolean;
  /**
   * True for substantial new-functionality requests (new modes, pages,
   * integrations). These are filed on the product Roadmap as an Idea (see
   * draftIdea) instead of the Bug Tracker. Only consulted when is_bug and
   * is_ambiguous are both false.
   */
  is_feature_request: boolean;
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
   SLOW PERFORMANCE IS ALWAYS A BUG: any complaint that something is slow, laggy, or has slowed down (page load, tab switching, an action taking too long) is a bug report — never ambiguous, never a feature request.
2. If it is NOT clearly a bug report, is it ambiguous enough that a ticket might still be warranted? Set "is_ambiguous" to true when:
   - It's a borderline call between bug and not-bug (e.g. labeled "Bug:" but describes missing functionality, or it's unclear whether the behavior is broken or working-as-designed)
   - It describes an IMPROVEMENT to existing functionality — something that works but works poorly (confusing UX, "should also show X", "Improvement Needed" posts) — but NOT slow performance, which is always a bug
   - It suggests a small UX affordance on an EXISTING screen or element — making something clickable, linking to a related view, showing extra info on hover ("X should be clickable", "X should take you to Y")
   Do NOT set is_ambiguous for clear-cut non-bugs: major new features or product capabilities, design opinions, questions, or chit-chat.
3. If it is neither a bug nor ambiguous: is it a FEATURE REQUEST — a request for substantial new functionality or capability (new modes, new pages, new workflows, new integrations)? Set "is_feature_request" to true. Design opinions, general questions, and chit-chat are NOT feature requests.
4. If it IS a bug report, does it have sufficient detail to act on? Sufficient means at least one of:
   - Steps to reproduce or a description of what happened vs what was expected
   - A Loom video link
   - Screenshots showing the bug (the message has attachments: ${hasFiles ? "YES" : "NO"})
   - Specific enough description that an engineer could investigate (e.g. mentions specific feature, page, or error)

A message like "things are broken" is NOT sufficient.
A message like "the logic flow nodes aren't connected by default" with a screenshot IS sufficient.
A message like "lead scoring is not working — no column for Score is being shown" with a screenshot IS sufficient.
A message like "really don't like how this page looks" is design feedback, NOT a bug.
A message like "we need a way to archive forms" is a feature request, NOT a bug.
A message like "any way to make analytics load faster? takes 7+ seconds" is a performance complaint — is_bug true.
A message like "Bug: there is no custom meeting length setting" is labeled a bug but describes missing functionality — is_bug false, is_ambiguous true.
A message like "step names should be clickable and take you to the logic tab" is a UX affordance on existing UI — is_bug false, is_ambiguous true.
A message like "let's add an agent mode that turns form building into a chat" is a major new capability — is_bug false, is_ambiguous false, is_feature_request true.

The message contains a Loom link: ${hasLoomLink ? "YES" : "NO"}

Respond with ONLY a valid JSON object (no markdown, no backticks):
{
  "is_bug": true/false,
  "is_ambiguous": true/false,
  "is_feature_request": true/false,
  "has_sufficient_detail": true/false,
  "suggested_title": "Short descriptive title for the ticket (if is_bug, is_ambiguous or is_feature_request, otherwise null)",
  "reasoning": "Brief explanation of your classification"
}

Slack message:
"""
${messageText}
"""`;
}

const FALLBACK: ClassificationResult = {
  is_bug: false,
  is_ambiguous: false,
  is_feature_request: false,
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
      max_tokens: 1500,
      messages: [
        { role: "user", content: buildPrompt(text, hasFiles, hasLoomLink) },
      ],
    });

    const raw = extractText(response);
    return JSON.parse(raw) as ClassificationResult;
  } catch (err) {
    console.error("[classifier] Failed to classify message:", err);
    return FALLBACK;
  }
}

/**
 * Check if a thread reply is providing additional bug detail (screenshots,
 * steps to reproduce, etc.) vs just having a conversation. Returns true only
 * if the reply is clearly adding information relevant to diagnosing the bug.
 */
export async function isProvidingBugDetail(
  replyText: string,
  hasFiles: boolean
): Promise<boolean> {
  const prompt = `You are analyzing a reply in a Slack thread about a bug report. The bot previously asked for more detail (steps to reproduce, screenshots, or a Loom video).

Determine if this reply is actually providing additional information to help diagnose the bug — e.g. steps to reproduce, error messages, screenshots, Loom links, or a more specific description of the problem.

If the reply is just conversation, an acknowledgment, a question unrelated to the bug details, or chit-chat between teammates, answer false.

The reply has file attachments: ${hasFiles ? "YES" : "NO"}

Reply text:
"""
${replyText}
"""

Respond with ONLY a valid JSON object (no markdown, no backticks):
{
  "is_providing_detail": true/false,
  "reasoning": "Brief explanation"
}`;

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = extractText(response);
    const result = JSON.parse(raw);
    return result.is_providing_detail === true;
  } catch (err) {
    console.error("[classifier] Failed to check if reply provides detail:", err);
    return false;
  }
}

/**
 * Check if a thread reply is disputing the bot's duplicate classification.
 * E.g. "that's a different bug", "no this is a new issue", "not the same thing".
 */
export async function isDisputingDupe(replyText: string): Promise<boolean> {
  const prompt = `You are analyzing a reply in a Slack thread where a bot said a bug report was a duplicate of an existing ticket. Determine if this reply is disputing that classification — i.e. the person is saying it's NOT a duplicate and IS a different/new bug.

Examples of disputes: "that's a different bug", "no this is a new issue", "not the same", "this is separate", "wrong ticket"
Examples of NON-disputes: "ok thanks", "got it", "can you assign it to me?", general conversation

Reply text:
"""
${replyText}
"""

Respond with ONLY a valid JSON object (no markdown, no backticks):
{
  "is_disputing": true/false,
  "reasoning": "Brief explanation"
}`;

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = extractText(response);
    return JSON.parse(raw).is_disputing === true;
  } catch (err) {
    console.error("[classifier] Failed to check dupe dispute:", err);
    return false;
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
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = extractText(response);
    return JSON.parse(raw) as DuplicateResult;
  } catch (err) {
    console.error("[classifier] Failed to check for duplicates:", err);
    return { is_duplicate: false, matching_bug_id: null, reasoning: "Duplicate check failed — defaulting to new ticket." };
  }
}

/** Structured write-up of a feature request for the Roadmap "Idea" page. */
export interface IdeaDraft {
  title: string;
  /** One or two sentences: what is being asked for. */
  summary: string;
  /** The user problem / motivation behind the ask, as best it can be inferred. */
  problem: string;
  /** Concrete proposal — what the feature would do / look like. */
  proposal: string;
  /** Things product/eng would need to decide or clarify. */
  open_questions: string[];
}

/**
 * Turn a raw feature-request message into a write-up a product engineer can
 * act on. Only infers from what's in the message — no invented requirements.
 * Falls back to a minimal draft built from the raw text if Claude fails, so a
 * classifier hiccup never blocks filing the idea.
 */
export async function draftIdea(text: string, suggestedTitle: string | null): Promise<IdeaDraft> {
  const fallback: IdeaDraft = {
    title: suggestedTitle || text.slice(0, 100),
    summary: text.slice(0, 500),
    problem: "",
    proposal: "",
    open_questions: [],
  };

  const prompt = `You are helping a product engineering team at Surface (a forms/survey builder SaaS) triage a feature request posted in Slack.

Write it up so an engineer who has never seen the Slack message understands the ask. Be concrete and specific. Only use what is in the message (or can be reasonably inferred from it) — do NOT invent requirements, numbers, or customer names. If a section has no information, keep it to one short sentence saying so.

Respond with ONLY a valid JSON object (no markdown, no backticks):
{
  "title": "Short, specific title (imperative or noun phrase, max ~80 chars)",
  "summary": "1–2 sentences: what is being asked for",
  "problem": "What user problem or pain motivates this, who is affected",
  "proposal": "What the feature would concretely do / how it might work, based on the message",
  "open_questions": ["Things product/eng would need to clarify or decide (0–4 items)"]
}

Slack message:
"""
${text}
"""`;

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const parsed = JSON.parse(extractText(response)) as Partial<IdeaDraft>;
    return {
      title: parsed.title?.trim() || fallback.title,
      summary: parsed.summary?.trim() || fallback.summary,
      problem: parsed.problem?.trim() || "",
      proposal: parsed.proposal?.trim() || "",
      open_questions: Array.isArray(parsed.open_questions)
        ? parsed.open_questions.filter((q) => typeof q === "string" && q.trim())
        : [],
    };
  } catch (err) {
    console.error("[classifier] Failed to draft idea write-up, using raw text:", err);
    return fallback;
  }
}
