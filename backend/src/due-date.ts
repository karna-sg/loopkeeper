import type { DueConfidence } from "./domain/open-loop.ts";

/**
 * Deterministic due-date resolution. The model never parses dates — it surfaces the raw
 * `duePhrase` ("by Friday", "EOD tomorrow", "before the release") and this resolver
 * turns it into an ISO `YYYY-MM-DD` pinned to the user's timezone (default IST), or
 * `null` with confidence `none` when the phrase has no resolvable date. We never nudge
 * on a `none`, so under-resolving is safe; fabricating a date is not.
 */

export interface ResolvedDueDate {
  dueDate: string | null;
  dueConfidence: DueConfidence;
}

const NONE: ResolvedDueDate = { dueDate: null, dueConfidence: "none" };

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/** Vague references that explicitly resolve to "no date" — never nudge on these. */
const VAGUE = [
  "asap",
  "as soon as possible",
  "as early as possible",
  "as soon as you can",
  "at the earliest",
  "at your earliest",
  "earliest convenience",
  "first thing",
  "soon",
  "shortly",
  "sometime",
  "later",
  "when i get a chance",
  "when i can",
  "the release",
  "the launch",
  "the meeting",
  "the demo",
  "the call",
  "next sprint",
  "whenever",
];

/** Calendar date (timezone-independent, since we only ever output Y-M-D). */
interface PlainDate {
  y: number;
  m: number; // 0-based
  d: number;
}

/** The calendar date "now" falls on in the given IANA timezone. */
function plainDateInTz(nowIso: string, timezone: string): PlainDate {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(nowIso));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), m: get("month") - 1, d: get("day") };
}

function toIso(date: PlainDate): string {
  const utc = new Date(Date.UTC(date.y, date.m, date.d));
  return utc.toISOString().slice(0, 10);
}

function weekdayOf(date: PlainDate): number {
  return new Date(Date.UTC(date.y, date.m, date.d)).getUTCDay();
}

function addDays(date: PlainDate, n: number): PlainDate {
  const utc = new Date(Date.UTC(date.y, date.m, date.d) + n * 86_400_000);
  return { y: utc.getUTCFullYear(), m: utc.getUTCMonth(), d: utc.getUTCDate() };
}

/** Next occurrence of `target` weekday on or after `from` (0 = same day if it matches). */
function nextWeekday(from: PlainDate, target: number): PlainDate {
  const delta = (target - weekdayOf(from) + 7) % 7;
  return addDays(from, delta);
}

function lastDayOfMonth(date: PlainDate): PlainDate {
  const utc = new Date(Date.UTC(date.y, date.m + 1, 0));
  return { y: utc.getUTCFullYear(), m: utc.getUTCMonth(), d: utc.getUTCDate() };
}

/** Two-digit years map to 2000+ ("26" -> 2026). */
function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

/** Pick the year for a bare month/day: this year, or next year if the date already passed. */
function inferYear(today: PlainDate, month: number, day: number): number {
  return month < today.m || (month === today.m && day < today.d) ? today.y + 1 : today.y;
}

function explicit(date: PlainDate): ResolvedDueDate {
  return { dueDate: toIso(date), dueConfidence: "explicit" };
}

function inferred(date: PlainDate): ResolvedDueDate {
  return { dueDate: toIso(date), dueConfidence: "inferred" };
}

/**
 * Resolve a natural-language due phrase to a date.
 * @param duePhrase  Raw phrase the model surfaced, or null.
 * @param nowIso     The reference instant (ISO). Pass the run time; deterministic for tests.
 * @param timezone   IANA tz the relative phrase is anchored to (e.g. "Asia/Kolkata").
 */
export function resolveDueDate(duePhrase: string | null, nowIso: string, timezone: string): ResolvedDueDate {
  if (!duePhrase) return NONE;
  const raw = duePhrase.toLowerCase().trim();
  if (!raw) return NONE;

  // ISO date wins outright.
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return explicit({ y: Number(iso[1]), m: Number(iso[2]) - 1, d: Number(iso[3]) });
  }

  const today = plainDateInTz(nowIso, timezone);

  // Strip leading prepositions; remember if it was a "before <X>" phrasing.
  let phrase = raw.replace(/^(?:by|due|due by|due on|before|on or before|no later than)\s+/i, "").trim();
  phrase = phrase.replace(/^the\s+/, "");

  // Vague / unresolvable references → none (covers "before the release", "asap", etc.).
  if (VAGUE.some((v) => phrase === v || phrase.startsWith(`${v} `) || phrase === `end of ${v}`)) {
    return NONE;
  }

  // Day-after-tomorrow / Hinglish "parso".
  if (/\b(day after tomorrow|parso)\b/.test(phrase)) return explicit(addDays(today, 2));

  // Tomorrow / Hinglish "kal" (also "eod tomorrow", "by tomorrow", "kal tak").
  if (/\b(tomorrow|kal)\b/.test(phrase)) return explicit(addDays(today, 1));

  // Tonight / today / standalone EOD/COB / end of (business) day.
  if (/\b(today|tonight)\b/.test(phrase) || /\b(eod|cob)\b/.test(phrase) || /\bend of (?:the )?(?:business )?day\b/.test(phrase)) {
    // ...unless a weekday is also present ("eod friday"); fall through to weekday handling.
    if (!Object.keys(WEEKDAYS).some((w) => new RegExp(`\\b${w}\\b`).test(phrase))) {
      return explicit(today);
    }
  }

  // Explicit weekday ("friday", "by mon", "eod thursday").
  for (const [name, idx] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(phrase)) return explicit(nextWeekday(today, idx));
  }

  // Day-Month(-Year), hyphen or space separated: "29-Jun-26", "29 June 2026", "1 july", "29-jun".
  const dmy = phrase.match(/\b(\d{1,2})(?:st|nd|rd|th)?[-\s]([a-z]{3,9})\.?(?:[-\s](\d{2,4}))?\b/);
  if (dmy?.[1] && dmy[2] && dmy[2] in MONTHS) {
    const d = Number(dmy[1]);
    const m = MONTHS[dmy[2]] as number;
    const y = dmy[3] ? normalizeYear(Number(dmy[3])) : inferYear(today, m, d);
    return explicit({ y, m, d });
  }
  // Month-Day(-Year): "Jul 1", "july 1st", "jun-29-2026".
  const mdy = phrase.match(/\b([a-z]{3,9})\.?[-\s](\d{1,2})(?:st|nd|rd|th)?(?:[-\s](\d{2,4}))?\b/);
  if (mdy?.[1] && mdy[2] && mdy[1] in MONTHS) {
    const m = MONTHS[mdy[1]] as number;
    const d = Number(mdy[2]);
    const y = mdy[3] ? normalizeYear(Number(mdy[3])) : inferYear(today, m, d);
    return explicit({ y, m, d });
  }

  // Week / month buckets — resolvable but coarse → inferred.
  if (/\b(eow|end of (?:the )?week|this week)\b/.test(phrase)) return inferred(nextWeekday(today, 5));
  if (/\bnext week\b/.test(phrase)) return inferred(nextWeekday(addDays(today, 7), 5));
  if (/\b(end of (?:the )?month|month end)\b/.test(phrase)) return inferred(lastDayOfMonth(today));

  return NONE;
}
