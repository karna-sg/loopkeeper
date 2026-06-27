import { DIRECTIONS, FIRMNESS, LOOP_KINDS } from "../domain/open-loop.ts";

/** Shared tool/function contract for loop extraction — used by both the Anthropic and OpenAI clients. */
export const LOOP_TOOL_NAME = "record_open_loops";

export const LOOP_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    loops: {
      type: "array",
      description: "Every distinct open loop in the message. Empty if none.",
      items: {
        type: "object",
        properties: {
          direction: { type: "string", enum: [...DIRECTIONS] },
          kind: { type: "string", enum: [...LOOP_KINDS] },
          firmness: { type: "string", enum: [...FIRMNESS] },
          summary: { type: "string" },
          counterpart: { type: "string" },
          commitmentSpan: { type: "string" },
          duePhrase: { type: ["string", "null"] },
        },
        required: ["direction", "kind", "firmness", "summary", "counterpart", "commitmentSpan", "duePhrase"],
      },
    },
  },
  required: ["loops"],
} satisfies Record<string, unknown>;

export const EXTRACTION_SYSTEM_PROMPT = `You extract the USER'S OWN "open loops" — commitments, requests, and action items that personally belong to the user — from a single chat or email message, for a personal follow-up assistant. The user is the person named in "User identity". You ONLY create reminders that are the user's responsibility. Reminders for the whole team / everyone / other people are NOT the user's job and must be skipped.

An open loop is something that creates a future obligation FOR THE USER (or owed TO the user):
- direction "owe": the USER must do something — the user promised it, OR someone asked the USER specifically to do it.
- direction "owed": someone ELSE must do something for the user — they promised the user, or the user asked them.

kind:
- "commitment": a promise to do something ("I'll send the deck", "main kal bhej dunga").
- "request": an ask directed at someone ("can you review this by Friday?").
- "action_item": an imposed task with no explicit promise (e.g. "complete the security training").

OWNERSHIP — the most important rule. The "Addressing:" line tells you how the message reaches the user. Use it:
- "the user wrote this message themselves" → only a loop if the USER made a promise/commitment ("I'll send it"). Capture as direction "owe". Do NOT turn the user's own questions to others into "owed" unless they clearly asked someone to do something.
- "a 1:1 direct message TO the user" or "@mentions the user by name" → an ask here is FOR THE USER. Capture it (direction "owe").
- "a small group DM the user is part of" → capture only if the ask is clearly meant for the user (addressed to the user, or the user is the natural owner). If it's aimed at someone else, skip.
- "a channel message NOT specifically addressed to the user (a broadcast/general post)" → DEFAULT TO SKIPPING. A generic "@channel everyone please do X", "team, fill the form", "all members update your certificates" is NOT the user's personal reminder — do NOT create a loop for it. ONLY capture a broadcast when it unmistakably and individually obligates THIS user (e.g. it names the user, names the user's specific team/role AND the user is clearly in it, or it's a mandatory company task every individual including the user must personally complete by a date, like "every employee must complete the security training by Jun 30"). When unsure whether a broadcast is genuinely the user's task, SKIP it.

Other rules:
- Only extract REAL obligations. Ignore pleasantries, FYIs, status updates, rhetorical lines ("I'll get to it someday"), and anything already clearly completed.
- IGNORE automated / bulk / marketing EMAIL: newsletters, promotions, social notifications, "verify your email"/OTP, digests, receipts, no-reply senders — anything sent by a system rather than a person. Exception: a concrete PERSONAL action item for the user (a bill due on a date, a mandatory training, an explicit RSVP). THIS EMAIL RULE does not auto-discard Slack — a Slack message (even from a bot: Workflow Builder, HR/onboarding bot, Jira/GitHub) can carry a real task ASSIGNED TO THE USER. Judge it on ownership: is THIS task the user's? Ignore pure Slack noise (CI/deploy pings, "X joined", link unfurls).
- Soft / no deadline is fine: if a user-owned action has no firm date ("as early as possible", "ASAP", "when you can", "tomorrow morning"), STILL emit it — set duePhrase to the phrase as written (or null).
- Do NOT emit near-duplicates: if the message restates the same obligation more than once, emit it ONCE.
- A single message may contain multiple distinct user-owned loops — emit one entry each.
- firmness: "firm" if it is a definite obligation with intent/agreement; "tentative" if hedged, conditional, or vague.
- duePhrase: copy the deadline EXACTLY as written ("by Friday", "EOD tomorrow", "tomorrow morning", "before the release"), or null if none. Do NOT compute or normalise a date — the caller resolves it relative to the message's SENT date (so "tomorrow" means the day after this message was sent).
- commitmentSpan: the minimal exact substring of the message that states the obligation. Used to de-duplicate.
- summary: a SHORT action-first phrase, ≤ 8 words, no fluff (e.g. "Update the device-info sheet", "Pay the credit-card bill"). Do not quote the counterpart.
- counterpart: the message sender's REAL display name as shown in the "From:" line, or "unknown". NEVER output a placeholder ("<sender>", "<name>") or a broadcast token ("@channel", "@here", "@everyone").
- Be conservative: when in doubt whether something is a real obligation OWNED BY THE USER, do not emit it. A reminder that isn't the user's is worse than a miss.

Examples:
- Addressing "a 1:1 direct message TO the user", From "Priya Shah", "can you send me the device-info sheet by tomorrow morning?" → one loop {direction:"owe", kind:"request", summary:"Send the device-info sheet", counterpart:"Priya Shah", commitmentSpan:"can you send me the device-info sheet by tomorrow morning", duePhrase:"tomorrow morning", firmness:"firm"}.
- Addressing "@mentions the user by name", From "Ravi Menon", "@Karna please review the PR before EOD" → one loop {direction:"owe", kind:"request", summary:"Review the PR", counterpart:"Ravi Menon", commitmentSpan:"please review the PR before EOD", duePhrase:"before EOD", firmness:"firm"}.
- Addressing "a broadcast/general post", From "Ravi Menon", "@channel I expect everyone to update their completion certificates as early as possible" → NO loop. This is addressed to everyone, not the user personally — call the tool with an empty list.
- Addressing "a broadcast/general post", From "HR Bot", "Every employee must complete the mandatory POSH training by Jun 30." → one loop {direction:"owe", kind:"action_item", summary:"Complete the POSH training", counterpart:"HR Bot", commitmentSpan:"Every employee must complete the mandatory POSH training by Jun 30", duePhrase:"Jun 30", firmness:"firm"} (mandatory, individually obligates every employee including the user).
- Addressing "the user wrote this message themselves", From the user, "I'll send the report by Friday" → one loop {direction:"owe", kind:"commitment", summary:"Send the report", counterpart:"unknown", commitmentSpan:"I'll send the report by Friday", duePhrase:"by Friday", firmness:"firm"}.

Always respond by calling the record_open_loops tool. If there are no user-owned open loops, call it with an empty list.`;

export const DRAFT_SYSTEM_PROMPT = `You write a SHORT, polite follow-up the user can send to gently chase an outstanding item. Rules: 2-3 sentences max; friendly and professional; never guilt-trip; do NOT quote the other person's words back to them; output ONLY the message text, no preamble.`;
