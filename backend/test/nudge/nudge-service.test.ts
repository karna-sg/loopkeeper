import { describe, expect, it } from "vitest";
import { NudgeService } from "../../src/nudge/nudge-service.ts";
import { FakePushSender } from "../../src/push/push-sender.ts";
import { LoopsStore } from "../../src/store/loops-store.ts";
import { loopId } from "../../src/dedupe.ts";
import type { OpenLoop } from "../../src/domain/open-loop.ts";

const NOW = "2026-06-25T04:00:00Z"; // 2026-06-25 in IST
const TZ = "Asia/Kolkata";

let counter = 0;
function loop(over: Partial<OpenLoop>): OpenLoop {
  counter += 1;
  const commitmentHash = over.commitmentHash ?? `h${counter}`;
  const channel = "slack";
  const sourceRef = over.sourceRef ?? `C:${counter}`;
  const direction = over.direction ?? "owe";
  return {
    id: loopId({ channel, sourceRef, direction, commitmentHash }),
    direction,
    kind: "commitment",
    summary: "Send the deck",
    counterpart: "Anil",
    channel,
    sourceRef,
    permalink: "p",
    commitmentHash,
    dueDate: "2026-06-25",
    dueConfidence: "explicit",
    firmness: "firm",
    status: "open",
    tenant: "T",
    createdTs: NOW,
    ...over,
  };
}

describe("NudgeService", () => {
  it("nudges overdue + due-within-window owe loops once per device, then stops", async () => {
    const store = new LoopsStore(":memory:");
    store.upsertMany([
      loop({ dueDate: "2026-06-24" }), // overdue
      loop({ dueDate: "2026-06-25" }), // today
      loop({ dueDate: "2026-06-26" }), // tomorrow (within window 1)
      loop({ dueDate: "2026-06-28" }), // beyond window
      loop({ dueDate: "2026-06-24", direction: "owed" }), // owed-to-me, skip
      loop({ dueDate: null }), // no date, skip
      loop({ dueDate: "2026-06-24", snoozedUntil: "2026-06-30T00:00:00Z" }), // snoozed, skip
    ]);
    store.registerDevice("tok1", NOW);

    const push = new FakePushSender();
    const nudge = new NudgeService(store, push);
    const result = await nudge.run({ nowIso: NOW, timezone: TZ });

    expect(result).toEqual({ candidates: 3, devices: 1, sent: 3, nudged: 3 });
    expect(push.sent).toHaveLength(3);
    expect(store.list({ status: ["nudged"] })).toHaveLength(3);
    // The 4 skipped loops remain open.
    expect(store.list({ status: ["open"] })).toHaveLength(4);

    // Re-running nudges nothing (already nudged).
    expect(await nudge.run({ nowIso: NOW, timezone: TZ })).toMatchObject({ candidates: 0, sent: 0 });
  });

  it("sends one push per registered device", async () => {
    const store = new LoopsStore(":memory:");
    store.upsertMany([loop({ dueDate: "2026-06-24" })]);
    store.registerDevice("tokA", NOW);
    store.registerDevice("tokB", NOW);
    const push = new FakePushSender();
    const result = await new NudgeService(store, push).run({ nowIso: NOW, timezone: TZ });
    expect(result.sent).toBe(2);
    expect(new Set(push.sent.map((s) => s.token))).toEqual(new Set(["tokA", "tokB"]));
  });

  it("payload carries the summary, never a raw quote", async () => {
    const store = new LoopsStore(":memory:");
    store.upsertMany([loop({ dueDate: "2026-06-25", summary: "Pay the ICICI bill" })]);
    store.registerDevice("tok1", NOW);
    const push = new FakePushSender();
    await new NudgeService(store, push).run({ nowIso: NOW, timezone: TZ });
    expect(push.sent[0]?.payload.body).toBe("Pay the ICICI bill");
    expect(push.sent[0]?.payload.title).toContain("Due today");
  });
});
