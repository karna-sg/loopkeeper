import { createHash } from "node:crypto";
import type { OpenLoop } from "./domain/open-loop.ts";
import { loopDedupeKey } from "./domain/open-loop.ts";

/**
 * Dedupe is keyed on (channel, sourceRef, direction, commitmentHash) so that two distinct
 * commitments in a single message/thread are NOT collapsed into one row, while a re-scan
 * of the same commitment maps back to the same key (idempotent upsert).
 */

/** Stable short hash of the extracted commitment span. */
export function commitmentHash(span: string): string {
  const normalized = span.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Deterministic loop id derived from its dedupe key — same loop → same id across runs. */
export function loopId(loop: Pick<OpenLoop, "channel" | "sourceRef" | "direction" | "commitmentHash">): string {
  return `loop_${createHash("sha256").update(loopDedupeKey(loop)).digest("hex").slice(0, 20)}`;
}

/**
 * Collapse duplicates within a single batch, keeping the first occurrence of each key.
 * When duplicates differ, prefer the one with the most resolved due date
 * (explicit > inferred > none).
 */
export function dedupeLoops(loops: readonly OpenLoop[]): OpenLoop[] {
  const rank: Readonly<Record<OpenLoop["dueConfidence"], number>> = { explicit: 2, inferred: 1, none: 0 };
  const byKey = new Map<string, OpenLoop>();
  for (const loop of loops) {
    const key = loopDedupeKey(loop);
    const existing = byKey.get(key);
    if (!existing || rank[loop.dueConfidence] > rank[existing.dueConfidence]) {
      byKey.set(key, loop);
    }
  }
  return [...byKey.values()];
}

/** Filter a fresh batch down to loops whose key is not already present in `seenKeys`. */
export function onlyNew(loops: readonly OpenLoop[], seenKeys: ReadonlySet<string>): OpenLoop[] {
  return loops.filter((l) => !seenKeys.has(loopDedupeKey(l)));
}
