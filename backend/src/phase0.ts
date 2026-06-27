#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedMessage, UserIdentity } from "./domain/message.ts";
import type { ExtractedLoop, OpenLoop, UserLabel } from "./domain/open-loop.ts";
import { gate } from "./gate.ts";
import { extractLoops, AnthropicExtractionClient } from "./extractor.ts";
import type { ExtractionClient } from "./extractor.ts";
import { StubExtractionClient } from "./stub-extraction-client.ts";

/**
 * Phase-0 runner — the extraction precision spike. Loads fixture messages, runs the
 * gate → extractor pipeline, and prints a readable report. No channel is contacted and
 * nothing is sent. With `--live` it uses the real Claude client (needs ANTHROPIC_API_KEY);
 * otherwise it uses the deterministic fixture-backed stub.
 *
 * The point of this phase: eyeball false positives and, with a labels file, measure
 * firm-bucket precision before advancing to the app. Gate to Phase 1 at ~80%.
 */

const IDENTITY: UserIdentity = {
  displayName: "Karna",
  aliases: ["karna.personal@example.com", "@karna"],
  timezone: "Asia/Kolkata",
};

/** Deterministic default reference instant (09:30 IST, 2026-06-25) for reproducible output. */
const DEFAULT_NOW = "2026-06-25T04:00:00Z";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function todayIso(nowIso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowIso));
}

function bucketOf(loop: OpenLoop, today: string): "overdue" | "today" | "upcoming" | "no-date" {
  if (loop.dueDate === null) return "no-date";
  if (loop.dueDate < today) return "overdue";
  if (loop.dueDate === today) return "today";
  return "upcoming";
}

function countBy<T extends string>(loops: readonly OpenLoop[], pick: (l: OpenLoop) => T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of loops) {
    const k = pick(l);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function fmtCounts(counts: Record<string, number>): string {
  return (
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ") || "(none)"
  );
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const fixturesDir = argValue("--fixtures") ?? join(process.cwd(), "test", "fixtures");
  const nowIso = process.env.LOOPKEEPER_NOW ?? DEFAULT_NOW;
  const today = todayIso(nowIso, IDENTITY.timezone);

  const messages = await loadJson<NormalizedMessage[]>(join(fixturesDir, "messages.json"));

  let client: ExtractionClient;
  if (live) {
    client = new AnthropicExtractionClient();
  } else {
    const map = await loadJson<Record<string, ExtractedLoop[]>>(join(fixturesDir, "extractions.json"));
    client = new StubExtractionClient(map);
  }

  const candidates = gate(messages);
  const loops = await extractLoops(candidates, client, { nowIso, identity: IDENTITY });

  // ---- Report ----
  console.log(`\nLoopkeeper · Phase-0 extraction report`);
  console.log(`  mode:        ${live ? "live (Claude)" : "stub (fixtures)"}`);
  console.log(`  reference:   ${nowIso}  (today ${today} ${IDENTITY.timezone})`);
  console.log(`  messages:    ${messages.length}`);
  console.log(`  gated:       ${candidates.length}  (dropped by gate: ${messages.length - candidates.length})`);
  console.log(`  loops:       ${loops.length}`);
  console.log(`  direction:   ${fmtCounts(countBy(loops, (l) => l.direction))}`);
  console.log(`  firmness:    ${fmtCounts(countBy(loops, (l) => l.firmness))}`);
  console.log(`  due:         ${fmtCounts(countBy(loops, (l) => l.dueConfidence))}`);

  const buckets: Record<string, OpenLoop[]> = { overdue: [], today: [], upcoming: [], "no-date": [] };
  for (const l of loops) (buckets[bucketOf(l, today)] ??= []).push(l);

  for (const name of ["overdue", "today", "upcoming", "no-date"] as const) {
    const group = buckets[name] ?? [];
    if (group.length === 0) continue;
    console.log(`\n  ── ${name.toUpperCase()} (${group.length}) ──`);
    for (const l of group) {
      const due = l.dueDate ?? "—";
      console.log(
        `   [${l.firmness === "firm" ? "FIRM" : "tent"}] ${l.direction}/${l.kind}: ${l.summary}` +
          ` · ${l.counterpart} · due ${due} (${l.dueConfidence}) · ${l.channel} · ${l.id}`,
      );
    }
  }

  // ---- Precision (if a labels file is present) ----
  const labelsPath = join(fixturesDir, "labels.json");
  if (existsSync(labelsPath)) {
    const labels = await loadJson<Record<string, UserLabel>>(labelsPath);
    const firm = loops.filter((l) => l.firmness === "firm");
    const labelled = firm.filter((l) => labels[l.id] !== undefined);
    const truePos = labelled.filter((l) => labels[l.id] === "true").length;
    const precision = labelled.length ? ((truePos / labelled.length) * 100).toFixed(0) : "n/a";
    console.log(`\n  firm-bucket precision: ${precision}% (${truePos}/${labelled.length} labelled)`);
    console.log(`  Phase-1 gate: advance at ~80%.`);
  } else {
    console.log(`\n  No labels.json — label loop ids true/false there to compute firm-bucket precision.`);
  }
  console.log("");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
