#!/usr/bin/env node
import { loadConfig } from "./server/config.ts";
import { LoopsStore } from "./store/loops-store.ts";
import { loopId } from "./dedupe.ts";
import { todayInTz } from "./clock.ts";
import type { Direction, LoopKind, OpenLoop } from "./domain/open-loop.ts";

/**
 * Dev-only: drop a handful of demo loops into the configured store so the iOS app shows a
 * populated brief without needing live Slack/Gmail/Anthropic credentials. Idempotent.
 *
 *   pnpm --filter @loopkeeper/backend seed
 */

const config = loadConfig();
const now = new Date().toISOString();
const today = todayInTz(now, config.identity.timezone);

function shift(days: number): string {
  return new Date(new Date(`${today}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

interface Demo {
  summary: string;
  counterpart: string;
  direction: Direction;
  kind: LoopKind;
  dueDate: string | null;
  firmness: OpenLoop["firmness"];
  channel: OpenLoop["channel"];
}

const demos: Demo[] = [
  { summary: "Send the postmortem doc to Boss", counterpart: "Boss", direction: "owe", kind: "action_item", dueDate: shift(-1), firmness: "firm", channel: "slack" },
  { summary: "Pay the ICICI credit card bill", counterpart: "ICICI Bank", direction: "owe", kind: "action_item", dueDate: today, firmness: "firm", channel: "gmail" },
  { summary: "Send Anil the deck", counterpart: "Anil", direction: "owe", kind: "commitment", dueDate: shift(2), firmness: "firm", channel: "slack" },
  { summary: "Follow up on the signed contract", counterpart: "Legal", direction: "owe", kind: "commitment", dueDate: null, firmness: "tentative", channel: "gmail" },
  { summary: "Priya to send the Q2 numbers", counterpart: "Priya", direction: "owed", kind: "request", dueDate: shift(1), firmness: "firm", channel: "slack" },
];

const loops: OpenLoop[] = demos.map((d, i) => {
  const sourceRef = `DEMO:${i}`;
  const commitmentHash = `demo-${i}`;
  return {
    id: loopId({ channel: d.channel, sourceRef, direction: d.direction, commitmentHash }),
    direction: d.direction,
    kind: d.kind,
    summary: d.summary,
    counterpart: d.counterpart,
    channel: d.channel,
    sourceRef,
    permalink: "https://example.com/demo",
    commitmentHash,
    dueDate: d.dueDate,
    dueConfidence: d.dueDate ? "explicit" : "none",
    firmness: d.firmness,
    status: "open",
    tenant: "DEMO",
    createdTs: now,
  };
});

const store = new LoopsStore(config.dbPath);
const { inserted, updated } = store.upsertMany(loops);
store.close();
console.log(`Seeded ${loops.length} demo loops into ${config.dbPath} (inserted ${inserted}, updated ${updated}).`);
console.log("Start the server (pnpm dev) and open the app — pull to refresh to see them.");
