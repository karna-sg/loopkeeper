import type { NormalizedMessage } from "./domain/message.ts";

/**
 * Deterministic, high-recall pre-LLM gate. Its only job is to drop clearly non-actionable chatter
 * (reactions, greetings, "thanks"); anything with a hint of a request, commitment, deadline, or a
 * broadcast (@channel/@here/@everyone) passes to the model, which is the precise judge. Because the
 * scan only ever sends each message to the model ONCE (see seen-tracking), the gate can be generous.
 */

interface SignalGroup {
  readonly label: string;
  readonly weight: number;
  readonly patterns: readonly RegExp[];
}

/** First-person commitments ("I'll send it", "on it", Hinglish "bhej dunga"). */
const COMMITMENT: SignalGroup = {
  label: "commitment",
  weight: 2,
  patterns: [
    /\bi['’]?ll\b/i,
    /\bi will\b/i,
    /\bi['’]?m going to\b/i,
    /\bi can (?:send|do|get|take|handle|share|review|fix|finish|complete|update)\b/i,
    /\blet me (?:send|get|check|share|take|handle|look|do)\b/i,
    /\b(?:will do|on it|i got it|i['’]?ll handle|i['’]?ll take care|i['’]?ll get (?:it|that) (?:done|over))\b/i,
    /\b(?:kar|bhej|de|dekh|complete kar)\s?(?:dunga|dena|lunga|du|denge)\b/i,
    /\bho j(?:a|aa)yega\b/i,
  ],
};

/** Requests / imperatives directed at the user or the group. */
const REQUEST: SignalGroup = {
  label: "request",
  weight: 2,
  patterns: [
    /\b(?:can|could|would|will) you\b/i,
    /\bcan u\b/i,
    /\bpls\b|\bplz\b|\bplease\b|\bkindly\b/i,
    /\b(?:need|want|expect|request)\s+(?:you|everyone|all|the team|us|members?)\s+to\b/i,
    /\b(?:everyone|all|folks|team|members?)\s+(?:please|must|should|need to|are requested to|kindly)\b/i,
    /\bmake sure\b|\bensure\b|\bdon['’]?t forget\b|\bremember to\b|\breminder\b/i,
    /\baction (?:required|item|needed)\b|\bmandatory\b|\brequired\b/i,
    /\bget back to me\b|\blet me know\b|\bfollow up\b/i,
    // bare imperative verbs commonly used in asks (update the sheet / complete the course / fill the form…)
    /\b(?:please\s+)?(?:complete|update|fill(?:\s*out|\s*in)?|submit|upload|register|enroll|sign|review|approve|confirm|respond|reply|share|send|add|provide|finish)\b\s+(?:your|the|this|these|all|in|out|it|on)\b/i,
    /\b(?:kar|bhej|de)\s?(?:do|dena|dijiye|de do)\b/i,
  ],
};

/** Deadline / due-date language, incl. soft deadlines. */
const DEADLINE: SignalGroup = {
  label: "deadline",
  weight: 2,
  patterns: [
    /\bby (?:eod|cob|eow|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|next week|end of)\b/i,
    /\b(?:eod|cob|eow)\b/i,
    /\b(?:today|tonight|tomorrow)\b/i,
    /\b(?:kal|parso|aaj)\b/i,
    /\b(?:this|next) (?:week|month)\b/i,
    /\bdue\b|\bdeadline\b/i,
    /\bbefore (?:the|next|end|eod|tomorrow|friday|monday|tuesday|wednesday|thursday|we|it)\b/i,
    /\bend of (?:day|week|month|business)\b/i,
    /\bby \d{1,2}(?:st|nd|rd|th)?\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i,
    /\b\d{1,2}[-\s](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i,
    /\basap\b|\bas (?:early|soon) as possible\b|\bat your earliest\b|\bearliest convenience\b/i,
    /\bkal tak\b/i,
  ],
};

/** Broadcasts always merit a look (Slack text is normalized to @channel/@here/@everyone upstream). */
const BROADCAST: SignalGroup = {
  label: "broadcast",
  weight: 3,
  patterns: [/(^|\s)@(channel|here|everyone)\b/i, /<!(channel|here|everyone)>/i],
};

/** RSVP / invitation language. */
const RSVP: SignalGroup = {
  label: "rsvp",
  weight: 1,
  patterns: [
    /\bare you (?:coming|joining|attending|free|available)\b/i,
    /\bwill you (?:join|attend|be there|make it)\b/i,
    /\brsvp\b/i,
    /\bcan you make it\b/i,
    /\bcount me in\b/i,
    /\bsee you (?:at|on|there)\b/i,
  ],
};

const GROUPS: readonly SignalGroup[] = [COMMITMENT, REQUEST, DEADLINE, BROADCAST, RSVP];

export interface GateCandidate {
  message: NormalizedMessage;
  score: number;
  signals: string[];
}

export interface GateOptions {
  /** Max SCORED channel candidates per run (token-cost cap). Force-passed messages are never capped. Default 60. */
  maxCandidates?: number;
  /** Minimum score to qualify. Default 1 (any actionable signal) — high recall. */
  minScore?: number;
  /** Predicate for messages that bypass scoring + the cap entirely. Default {@link defaultForcePass}. */
  forcePass?: (message: NormalizedMessage) => boolean;
}

export const DEFAULT_MAX_CANDIDATES = 60;
const DEFAULT_MIN_SCORE = 1;

/** Trivial chatter that never creates an obligation, so it's dropped even from a DM. */
const NOISE =
  /^(?:\+1|ok(?:ay)?|kk|thanks?|thank you|thx|ty|cool|nice|great|gotcha|got it|sounds good|sg|np|no problem|lol|ha(?:ha)+|hm+|hi+|hello|hey+|yo|gm|good morning|good night|gn|welcome|congrats|congratulations|same|done|yes|yep|no|nope|sure|will do|👍|👀|✅|🙏|👌|🎉)\W*$/i;

/** True for one-word acks, greetings, and emoji/punctuation-only lines. */
export function isNoise(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (NOISE.test(t)) return true;
  // No letters/digits in any expected script (Latin or Devanagari for Hinglish) → emoji/punctuation only.
  return !/[a-z0-9ऀ-ॿ]/i.test(t);
}

function isDirectMessage(message: NormalizedMessage): boolean {
  return message.sourceLabel === "DM" || message.sourceLabel === "Group DM";
}

function hasMentionOrBroadcast(text: string): boolean {
  return /(^|\s)@(channel|here|everyone)\b/i.test(text) || /(^|\s)@\w/.test(text);
}

/**
 * Messages we send to the model regardless of regex score: every non-trivial DM / group-DM
 * (high-signal, low-volume) and every @mention / broadcast. Affordable because seen-tracking
 * sends each message to the model only once, ever.
 */
export function defaultForcePass(message: NormalizedMessage): boolean {
  if (isNoise(message.text)) return false;
  return isDirectMessage(message) || hasMentionOrBroadcast(message.text);
}

export function scoreMessage(text: string): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];
  for (const group of GROUPS) {
    if (group.patterns.some((p) => p.test(text))) {
      score += group.weight;
      signals.push(group.label);
    }
  }
  return { score, signals };
}

/**
 * Filter + rank messages into LLM candidates. Force-passed messages (DMs + mentions/broadcasts)
 * always qualify and are never capped; remaining scored channel messages fill up to maxCandidates,
 * highest score first, ties broken by recency.
 */
export function gate(messages: readonly NormalizedMessage[], options: GateOptions = {}): GateCandidate[] {
  const max = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const forcePass = options.forcePass ?? defaultForcePass;

  const byRank = (a: GateCandidate, b: GateCandidate): number => {
    if (b.score !== a.score) return b.score - a.score;
    return b.message.timestamp.localeCompare(a.message.timestamp);
  };

  const forced: GateCandidate[] = [];
  const scored: GateCandidate[] = [];
  for (const message of messages) {
    const { score, signals } = scoreMessage(message.text);
    if (forcePass(message)) {
      forced.push({ message, score, signals: signals.length > 0 ? signals : ["forced"] });
    } else if (score >= minScore) {
      scored.push({ message, score, signals });
    }
  }

  forced.sort(byRank);
  scored.sort(byRank);
  const capacity = Math.max(0, max - forced.length);
  return [...forced, ...scored.slice(0, capacity)];
}
