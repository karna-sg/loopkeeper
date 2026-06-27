import type { OpenLoop } from "./domain/open-loop.ts";

/** Reliability / throughput / ROI metrics derived purely from the loop columns. */
export interface Stats {
  generatedAt: string;
  open: { total: number; owe: number; owed: number; overdue: number };
  closed: { total: number; last7: number; last30: number };
  dismissed: { total: number };
  /** Of closed loops that had a due date, the fraction closed on/before it (null if none). */
  onTimeRate: number | null;
  /** Median hours from capture to close (null if none). */
  medianTimeToCloseHours: number | null;
  /** Open owe-loops older than 7 days still not closed. */
  carryOver: number;
  /** Consecutive most-recent closed-with-due loops that were on time. */
  onTimeStreak: number;
  /** Closed counts for the last ≤8 ISO weeks, oldest first. */
  byWeek: Array<{ week: string; closed: number }>;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ACTIVE = new Set(["open", "nudged", "closed_candidate"]);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** ISO-8601 week key `YYYY-Www` for a date (UTC). */
function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function buildStats(loops: readonly OpenLoop[], nowIso: string): Stats {
  const now = new Date(nowIso).getTime();
  const today = nowIso.slice(0, 10);

  const active = loops.filter((l) => ACTIVE.has(l.status));
  const closed = loops.filter((l) => l.status === "closed");
  const dismissed = loops.filter((l) => l.status === "dismissed");

  const overdue = active.filter((l) => l.direction === "owe" && l.dueDate !== null && l.dueDate < today).length;
  const carryOver = active.filter((l) => l.direction === "owe" && now - new Date(l.createdTs).getTime() > 7 * DAY).length;
  const closedSince = (days: number): number =>
    closed.filter((l) => l.resolvedTs !== undefined && now - new Date(l.resolvedTs).getTime() <= days * DAY).length;

  const withDue = closed.filter((l): l is OpenLoop & { resolvedTs: string; dueDate: string } => l.resolvedTs !== undefined && l.dueDate !== null);
  const onTimeRate = withDue.length === 0 ? null : withDue.filter((l) => l.resolvedTs.slice(0, 10) <= l.dueDate).length / withDue.length;

  const ttc = closed
    .filter((l) => l.resolvedTs !== undefined)
    .map((l) => (new Date(l.resolvedTs as string).getTime() - new Date(l.createdTs).getTime()) / HOUR)
    .filter((h) => h >= 0);

  // streak: from the most-recently-closed loop with a due date, count consecutive on-time ones.
  const recent = [...withDue].sort((a, b) => (a.resolvedTs < b.resolvedTs ? 1 : -1));
  let onTimeStreak = 0;
  for (const l of recent) {
    if (l.resolvedTs.slice(0, 10) <= l.dueDate) onTimeStreak += 1;
    else break;
  }

  const weekCounts = new Map<string, number>();
  for (const l of closed) {
    if (l.resolvedTs === undefined) continue;
    const key = isoWeek(new Date(l.resolvedTs));
    weekCounts.set(key, (weekCounts.get(key) ?? 0) + 1);
  }
  const byWeek = [...weekCounts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-8)
    .map(([week, count]) => ({ week, closed: count }));

  return {
    generatedAt: nowIso,
    open: {
      total: active.length,
      owe: active.filter((l) => l.direction === "owe").length,
      owed: active.filter((l) => l.direction === "owed").length,
      overdue,
    },
    closed: { total: closed.length, last7: closedSince(7), last30: closedSince(30) },
    dismissed: { total: dismissed.length },
    onTimeRate,
    medianTimeToCloseHours: median(ttc),
    carryOver,
    onTimeStreak,
    byWeek,
  };
}
