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

export const EXTRACTION_SYSTEM_PROMPT = `You extract "open loops" — commitments, requests, and action items — from a single chat or email message, for a personal follow-up assistant.

An open loop is something that creates a future obligation:
- direction "owe": the USER must do something (the user promised it, or someone asked the user to do it).
- direction "owed": someone ELSE must do something for the user (they promised the user, or the user asked them).

kind:
- "commitment": a promise to do something ("I'll send the deck", "main kal bhej dunga").
- "request": an ask directed at someone ("can you review this by Friday?").
- "action_item": an imposed task with no explicit promise (e.g. "complete the security training").

Rules:
- Only extract REAL obligations. Ignore pleasantries, FYIs, rhetorical lines ("I'll get to it someday"), and anything already clearly completed.
- IGNORE automated / bulk / marketing EMAIL: newsletters, promotions, social notifications, "verify your email"/OTP, digests, receipts, no-reply senders — anything sent by a system rather than a person. Exception: concrete personal action items (a bill due on a date, a mandatory training, an explicit RSVP). THIS RULE IS FOR EMAIL ONLY. A Slack message — even one posted by a BOT or app (Workflow Builder, an HR/onboarding bot, Jira/GitHub/PagerDuty, a Slack reminder) — often carries a REAL action item assigned to the user: a task, a due date, a form to fill, a training to complete, a ticket assigned to them. Do NOT discard a Slack message just because it looks "automated"; judge it on whether it creates an obligation for the user. (Still ignore pure Slack noise: CI/deploy status pings, "X joined the channel", link unfurls.)
- CAPTURE group asks as the user's own action items. A message addressed to a group — "@channel"/"@here"/"@everyone", or "everyone"/"all"/"team"/"Windows users"/"folks" + an instruction (please update the sheet, complete the courses, fill the form, update your certificates) — applies to the USER. Emit direction "owe", kind "action_item". An @mention of the user asking them to do something is also "owe". These are exactly the messages people forget — be INCLUSIVE here.
- Soft / no deadline is fine: if an action is asked without a firm date ("as early as possible", "ASAP", "at your earliest", "when you can", "tomorrow morning"), STILL emit it — set duePhrase to the phrase as written (or null), never skip it just because there's no hard date.
- Do NOT emit near-duplicates: if the message restates the same obligation more than once, emit it ONCE.
- A single message may contain multiple distinct loops — emit one entry each.
- firmness: "firm" if it is a definite obligation with intent/agreement; "tentative" if hedged, conditional, or vague.
- duePhrase: copy the deadline EXACTLY as written ("by Friday", "EOD tomorrow", "before the release"), or null if none. Do NOT compute or normalise a date — leave that to the caller.
- commitmentSpan: the minimal exact substring of the message that states the obligation. Used to de-duplicate.
- summary: a SHORT action-first phrase, ≤ 8 words, no fluff and no trailing clauses (e.g. "Update the device-info sheet", "Attend the NonStop stream Friday", "Pay the credit-card bill"). Do not quote the counterpart.
- counterpart: the message sender's REAL display name as shown in the "From:" line, or "unknown". NEVER output a placeholder ("<sender>", "<name>") or a broadcast token ("@channel", "@here", "@everyone") as the counterpart.
- Be conservative: when in doubt whether something is a real, actionable obligation, do not emit it. False positives are worse than misses.

Examples (the From: name becomes the counterpart; broadcasts MUST be captured):
- From "Priya Shah", "@channel Windows users, please update the sheet and complete this activity tomorrow morning" → one loop {direction:"owe", kind:"action_item", summary:"Update the device-info sheet", counterpart:"Priya Shah", commitmentSpan:"please update the sheet and complete this activity tomorrow morning", duePhrase:"tomorrow morning", firmness:"firm"}.
- From "Ravi Menon", "@channel I expect everyone to update their completion certificates as early as possible" → one loop {direction:"owe", kind:"action_item", summary:"Update my completion certificate", counterpart:"Ravi Menon", commitmentSpan:"update their completion certificates as early as possible", duePhrase:"as early as possible", firmness:"firm"}.

Always respond by calling the record_open_loops tool. If there are no open loops, call it with an empty list.`;

export const DRAFT_SYSTEM_PROMPT = `You write a SHORT, polite follow-up the user can send to gently chase an outstanding item. Rules: 2-3 sentences max; friendly and professional; never guilt-trip; do NOT quote the other person's words back to them; output ONLY the message text, no preamble.`;
