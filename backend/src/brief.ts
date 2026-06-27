import type { OpenLoop } from "./domain/open-loop.ts";

/** The daily brief: loops you owe, bucketed by urgency, plus what you're awaiting from others. */
export interface Brief {
  date: string;
  overdue: OpenLoop[];
  today: OpenLoop[];
  upcoming: OpenLoop[];
  noDate: OpenLoop[];
  awaiting: OpenLoop[];
}

/**
 * Group loops into the brief sections relative to `today` (YYYY-MM-DD). Loops you are OWED
 * go into `awaiting`; loops you OWE are bucketed overdue / today / upcoming / no-date.
 */
/** Drop loops that restate the same obligation (same direction + counterpart + normalized summary). */
function dedupeBySummary(loops: readonly OpenLoop[]): OpenLoop[] {
  const seen = new Set<string>();
  const out: OpenLoop[] = [];
  for (const loop of loops) {
    const key = `${loop.direction}|${loop.counterpart.toLowerCase().trim()}|${loop.summary.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loop);
  }
  return out;
}

export function buildBrief(allLoops: readonly OpenLoop[], today: string): Brief {
  const brief: Brief = { date: today, overdue: [], today: [], upcoming: [], noDate: [], awaiting: [] };
  for (const loop of dedupeBySummary(allLoops)) {
    if (loop.direction === "owed") {
      brief.awaiting.push(loop);
      continue;
    }
    if (loop.dueDate === null) brief.noDate.push(loop);
    else if (loop.dueDate < today) brief.overdue.push(loop);
    else if (loop.dueDate === today) brief.today.push(loop);
    else brief.upcoming.push(loop);
  }
  return brief;
}
