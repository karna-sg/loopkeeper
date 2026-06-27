import { describe, expect, it, beforeEach } from "vitest";
import { LoopsStore } from "../../src/store/loops-store.ts";
import { loopId } from "../../src/dedupe.ts";
import type { OpenLoop } from "../../src/domain/open-loop.ts";

function loop(over: Partial<OpenLoop> = {}): OpenLoop {
  const channel = over.channel ?? "slack";
  const sourceRef = over.sourceRef ?? "C1:1";
  const direction = over.direction ?? "owe";
  const commitmentHash = over.commitmentHash ?? "h1";
  const base: OpenLoop = {
    id: loopId({ channel, sourceRef, direction, commitmentHash }),
    direction,
    kind: "commitment",
    summary: "Send the deck",
    counterpart: "Anil",
    channel,
    sourceRef,
    permalink: "https://x/1",
    commitmentHash,
    dueDate: "2026-06-26",
    dueConfidence: "explicit",
    firmness: "firm",
    status: "open",
    tenant: "T",
    createdTs: "2026-06-25T00:00:00Z",
  };
  return { ...base, ...over };
}

describe("LoopsStore", () => {
  let store: LoopsStore;
  beforeEach(() => {
    store = new LoopsStore(":memory:");
  });

  it("inserts then upserts idempotently", () => {
    expect(store.upsertMany([loop()])).toEqual({ inserted: 1, updated: 0 });
    expect(store.upsertMany([loop({ summary: "Send the updated deck" })])).toEqual({ inserted: 0, updated: 1 });
    expect(store.count()).toBe(1);
    expect(store.list()[0]?.summary).toBe("Send the updated deck");
  });

  it("keeps two distinct commitments from one message", () => {
    store.upsertMany([loop({ commitmentHash: "h1" }), loop({ commitmentHash: "h2", summary: "Follow up" })]);
    expect(store.count()).toBe(2);
  });

  it("never resurrects a closed loop on re-scan", () => {
    store.upsertMany([loop()]);
    const id = store.list()[0]!.id;
    store.setStatus(id, "closed", { resolution: "manual", resolvedTs: "2026-06-25T05:00:00Z" });
    store.upsertMany([loop({ status: "open" })]); // a re-scan sees it as open again
    expect(store.get(id)?.status).toBe("closed");
  });

  it("filters by status and hides snoozed loops", () => {
    store.upsertMany([loop()]);
    const id = store.list()[0]!.id;
    store.snooze(id, "2026-06-30T00:00:00Z");
    expect(store.list({ notSnoozedAfter: "2026-06-26T00:00:00Z" })).toHaveLength(0);
    expect(store.list({ notSnoozedAfter: "2026-07-01T00:00:00Z" })).toHaveLength(1);
  });

  it("purges closed loops past the TTL cutoff", () => {
    store.upsertMany([loop()]);
    const id = store.list()[0]!.id;
    store.setStatus(id, "closed", { resolvedTs: "2026-05-01T00:00:00Z" });
    expect(store.purgeClosedOlderThan("2026-06-01T00:00:00Z")).toBe(1);
    expect(store.count()).toBe(0);
  });

  it("purges by counterpart (erasure path)", () => {
    store.upsertMany([loop({ counterpart: "Priya" })]);
    expect(store.purgeByCounterpart("Priya")).toBe(1);
    expect(store.count()).toBe(0);
  });

  it("reset() wipes loops + seen-message tracking", () => {
    store.upsertMany([loop()]);
    store.markSeen(["C1:1"], "2026-06-26T00:00:00Z");
    expect(store.filterUnseen(["C1:1"])).toEqual([]); // seen
    expect(store.reset()).toBe(1); // returns prior count
    expect(store.count()).toBe(0);
    expect(store.filterUnseen(["C1:1"])).toEqual(["C1:1"]); // seen-tracking cleared
  });

  it("returns default source config, then merges updates", () => {
    expect(store.getSourceConfig().gmailQuery).toContain("category:primary");
    expect(store.getSourceConfig().slackChannelIds).toEqual([]);
    store.setSourceConfig({ slackChannelIds: ["C1", "C2"] });
    expect(store.getSourceConfig().slackChannelIds).toEqual(["C1", "C2"]);
    expect(store.getSourceConfig().gmailQuery).toContain("category:primary"); // unchanged
    store.setSourceConfig({ gmailQuery: "in:inbox is:important newer_than:7d" });
    expect(store.getSourceConfig().gmailQuery).toBe("in:inbox is:important newer_than:7d");
    expect(store.getSourceConfig().slackChannelIds).toEqual(["C1", "C2"]); // unchanged
  });

  it("registers, lists, and removes device tokens idempotently", () => {
    store.registerDevice("tok1", "2026-06-25T00:00:00Z");
    store.registerDevice("tok1", "2026-06-25T01:00:00Z"); // duplicate is a no-op
    store.registerDevice("tok2", "2026-06-25T00:00:00Z");
    expect(store.listDeviceTokens().sort()).toEqual(["tok1", "tok2"]);
    expect(store.removeDevice("tok1")).toBe(true);
    expect(store.listDeviceTokens()).toEqual(["tok2"]);
    expect(store.removeDevice("nope")).toBe(false);
  });

  it("setStatus is idempotent (re-applying the same status logs no undoable event)", () => {
    store.upsertMany([loop({ id: "L1", sourceRef: "C1:1" })]);
    const id = store.list()[0]!.id;
    expect(store.setStatus(id, "closed", { resolution: "manual", resolvedTs: "2026-06-25T01:00:00Z" })).toBe(true);
    expect(store.setStatus(id, "closed")).toBe(true); // no-op
    expect(store.setStatus("missing", "closed")).toBe(false);
    // only the real transition is undoable: one undo reopens, the next finds nothing
    expect(store.undoLastStatusChange()).toBe(id);
    expect(store.get(id)?.status).toBe("open");
    expect(store.get(id)?.resolvedTs).toBeUndefined();
    expect(store.undoLastStatusChange()).toBeNull();
  });

  it("audit:false transitions are not undoable", () => {
    store.upsertMany([loop()]);
    const id = store.list()[0]!.id;
    store.setStatus(id, "nudged", { audit: false });
    expect(store.get(id)?.status).toBe("nudged");
    expect(store.undoLastStatusChange()).toBeNull(); // no event logged
  });

  it("spawnNext advances the due date and clamps month-end for monthly", () => {
    const weekly = store.spawnNext(loop({ recurrence: "weekly", dueDate: "2026-06-26" }), "2026-06-25T00:00:00Z");
    expect(weekly?.dueDate).toBe("2026-07-03");
    expect(weekly?.status).toBe("open");
    expect(weekly?.recurrence).toBe("weekly");

    const jan = store.spawnNext(loop({ id: "M1", sourceRef: "C9:9", commitmentHash: "hm", recurrence: "monthly", dueDate: "2026-01-31" }), "2026-01-31T00:00:00Z");
    expect(jan?.dueDate).toBe("2026-02-28"); // not a month-skipping rollover
  });
});
