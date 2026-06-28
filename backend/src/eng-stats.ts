import type { EngTask } from "./domain/eng-task.ts";

/** Engineering throughput / velocity / cost metrics derived purely from task state. */
export interface EngStats {
  generatedAt: string;
  shipped: { total: number; last7: number; last30: number };
  inFlight: { total: number };
  /** Median hours from task creation to PR creation (null if no PRs yet). */
  medianTimeToPrHours: number | null;
  /** Median hours from task creation to merge (null if nothing merged yet). */
  medianTimeToMergeHours: number | null;
  /** Median review rounds (null if no review data). */
  medianReviewRounds: number | null;
  spend: {
    /** Sum of usdCentsUsed for tasks merged in the last 7 days. */
    last7UsdCents: number;
    /** Sum of usdCentsUsed for tasks merged in the last 30 days. */
    last30UsdCents: number;
    /** Sum of iterationsUsed across all non-cancelled tasks (subscription proxy). */
    totalIterations: number;
  };
  /** Shipped counts + spend per ISO week, last ≤8 weeks, oldest first. */
  byWeek: Array<{ week: string; shipped: number; spendUsdCents: number }>;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function buildEngStats(tasks: readonly EngTask[], nowIso: string): EngStats {
  const now = new Date(nowIso).getTime();

  const shipped = tasks.filter((t) => t.artifacts.merge?.mergedTs != null);
  const inFlight = tasks.filter((t) => t.status !== "cancelled" && t.artifacts.merge?.mergedTs == null);

  const mergedSince = (days: number): number =>
    shipped.filter((t) => now - new Date(t.artifacts.merge!.mergedTs!).getTime() <= days * DAY).length;

  // time-to-PR: tasks that have a PR creation timestamp
  const ttPr = tasks
    .filter((t) => t.artifacts.pr?.createdTs != null)
    .map((t) => (new Date(t.artifacts.pr!.createdTs!).getTime() - new Date(t.createdTs).getTime()) / HOUR)
    .filter((h) => h >= 0);

  // time-to-merge: shipped tasks only
  const ttMerge = shipped
    .map((t) => (new Date(t.artifacts.merge!.mergedTs!).getTime() - new Date(t.createdTs).getTime()) / HOUR)
    .filter((h) => h >= 0);

  // review rounds: tasks that entered review (review artifact exists)
  const reviewRounds = tasks.filter((t) => t.artifacts.review != null).map((t) => t.artifacts.review!.rounds);

  // spend: attribute to merge week so windows are clean and meaningful
  const spendSince = (days: number): number =>
    shipped
      .filter((t) => now - new Date(t.artifacts.merge!.mergedTs!).getTime() <= days * DAY)
      .reduce((acc, t) => acc + t.budget.usdCentsUsed, 0);

  const totalIterations = tasks
    .filter((t) => t.status !== "cancelled")
    .reduce((acc, t) => acc + t.budget.iterationsUsed, 0);

  // byWeek: last 8 ISO weeks grouped by merge date
  const weekMap = new Map<string, { shipped: number; spendUsdCents: number }>();
  for (const t of shipped) {
    const key = isoWeek(new Date(t.artifacts.merge!.mergedTs!));
    const entry = weekMap.get(key) ?? { shipped: 0, spendUsdCents: 0 };
    entry.shipped += 1;
    entry.spendUsdCents += t.budget.usdCentsUsed;
    weekMap.set(key, entry);
  }
  const byWeek = [...weekMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-8)
    .map(([week, v]) => ({ week, ...v }));

  return {
    generatedAt: nowIso,
    shipped: { total: shipped.length, last7: mergedSince(7), last30: mergedSince(30) },
    inFlight: { total: inFlight.length },
    medianTimeToPrHours: median(ttPr),
    medianTimeToMergeHours: median(ttMerge),
    medianReviewRounds: median(reviewRounds),
    spend: { last7UsdCents: spendSince(7), last30UsdCents: spendSince(30), totalIterations },
    byWeek,
  };
}
