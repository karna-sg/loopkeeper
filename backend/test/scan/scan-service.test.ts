import { describe, expect, it } from "vitest";
import { ScanService } from "../../src/scan/scan-service.ts";
import { FakeSource } from "../../src/sources/fake-source.ts";
import { StubExtractionClient } from "../../src/stub-extraction-client.ts";
import { LoopsStore } from "../../src/store/loops-store.ts";
import type { MessageSource } from "../../src/sources/source.ts";
import type { ExtractedLoop } from "../../src/domain/open-loop.ts";
import type { NormalizedMessage, UserIdentity } from "../../src/domain/message.ts";
import { daysBefore } from "../../src/clock.ts";

const IDENTITY: UserIdentity = { displayName: "Karna", aliases: [], timezone: "Asia/Kolkata" };
const NOW = "2026-06-25T04:00:00Z";

const SEND_DECK: ExtractedLoop = {
  direction: "owe",
  kind: "commitment",
  summary: "Send the deck",
  counterpart: "Priya",
  commitmentSpan: "send the deck",
  duePhrase: null,
  firmness: "firm",
};

function msg(over: Partial<NormalizedMessage> & Pick<NormalizedMessage, "sourceRef" | "text">): NormalizedMessage {
  return {
    channel: "slack",
    tenant: "T_PERSONAL",
    permalink: "https://x",
    author: "Someone",
    fromMe: false,
    timestamp: "2026-06-24T10:00:00+05:30",
    sourceTimezone: "Asia/Kolkata",
    ...over,
  };
}

describe("ScanService", () => {
  it("ingests -> gates -> extracts -> stores", async () => {
    const store = new LoopsStore(":memory:");
    const messages: NormalizedMessage[] = [
      msg({ sourceRef: "C1:1", text: "can you review the RFC by Friday?" }),
      msg({ sourceRef: "C2:2", text: "lunch?" }),
    ];
    const stub = new StubExtractionClient({
      "C1:1": [
        { direction: "owe", kind: "request", summary: "Review the RFC", counterpart: "Priya", commitmentSpan: "review the RFC by Friday", duePhrase: "by Friday", firmness: "firm" },
      ],
    });
    const scan = new ScanService([new FakeSource("slack", messages)], stub, store, IDENTITY);
    const result = await scan.run({ sinceIso: "2026-06-23T00:00:00Z", nowIso: NOW });
    expect(result.fetched).toBe(2);
    expect(result.gated).toBe(1); // "lunch?" dropped
    expect(result.extracted).toBe(1);
    expect(result.inserted).toBe(1);
    expect(store.list()[0]?.dueDate).toBe("2026-06-26");
  });

  it("does not re-extract on a second scan (idempotent — no duplicates)", async () => {
    const store = new LoopsStore(":memory:");
    const messages: NormalizedMessage[] = [msg({ sourceRef: "C1:1", text: "can you review the RFC by Friday?" })];
    const stub = new StubExtractionClient({
      "C1:1": [
        { direction: "owe", kind: "request", summary: "Review the RFC", counterpart: "Priya", commitmentSpan: "review the RFC by Friday", duePhrase: "by Friday", firmness: "firm" },
      ],
    });
    const scan = new ScanService([new FakeSource("slack", messages)], stub, store, IDENTITY);

    const first = await scan.run({ sinceIso: "2026-06-23T00:00:00Z", nowIso: NOW });
    expect(first.fresh).toBe(1);
    expect(first.extracted).toBe(1);
    expect(store.count()).toBe(1);

    const second = await scan.run({ sinceIso: "2026-06-23T00:00:00Z", nowIso: NOW });
    expect(second.fresh).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.extracted).toBe(0);
    expect(store.count()).toBe(1); // no duplicate
  });

  it("honours the tenant allowlist", async () => {
    const store = new LoopsStore(":memory:");
    const messages: NormalizedMessage[] = [
      msg({ sourceRef: "C1:1", tenant: "T_WORK", text: "can you send the report by Monday?" }),
    ];
    const stub = new StubExtractionClient({
      "C1:1": [
        { direction: "owe", kind: "request", summary: "Send report", counterpart: "Boss", commitmentSpan: "send the report by Monday", duePhrase: "by Monday", firmness: "firm" },
      ],
    });
    const scan = new ScanService([new FakeSource("slack", messages)], stub, store, IDENTITY);
    const result = await scan.run({
      sinceIso: "2026-06-23T00:00:00Z",
      nowIso: NOW,
      allowedTenants: new Set(["T_PERSONAL"]),
    });
    expect(result.fetched).toBe(0); // work tenant excluded
    expect(store.count()).toBe(0);
  });

  it("re-extracts a message after it is edited (edit-aware seen key)", async () => {
    const store = new LoopsStore(":memory:");
    const stub = new StubExtractionClient({ "C1:1": [SEND_DECK] });
    const runOne = (m: NormalizedMessage) =>
      new ScanService([new FakeSource("slack", [m])], stub, store, IDENTITY).run({ sinceIso: "2026-06-23T00:00:00Z", nowIso: NOW });

    const first = await runOne(msg({ sourceRef: "C1:1", text: "send the deck" }));
    expect(first.fresh).toBe(1);

    const unchanged = await runOne(msg({ sourceRef: "C1:1", text: "send the deck" }));
    expect(unchanged.fresh).toBe(0); // already seen

    const edited = await runOne(msg({ sourceRef: "C1:1", text: "send the deck by Friday", editedTs: "1750000000.000001" }));
    expect(edited.fresh).toBe(1); // edit makes it look unseen → re-extracted
    expect(edited.extracted).toBe(1);
    expect(store.count()).toBe(1); // upsert dedupes — no duplicate row
  });

  it("extends the fetch window back to the last successful scan after downtime", async () => {
    const store = new LoopsStore(":memory:");
    const seenSince: string[] = [];
    const recorder: MessageSource = {
      channel: "slack",
      async fetchRecent({ sinceIso }) {
        seenSince.push(sinceIso);
        return [];
      },
    };
    const scan = new ScanService([recorder], new StubExtractionClient({}), store, IDENTITY);

    const t0 = "2026-06-01T00:00:00.000Z";
    await scan.run({ sinceIso: daysBefore(t0, 1), nowIso: t0 });
    expect(seenSince[0]).toBe(daysBefore(t0, 1)); // first scan: requested 1-day window

    // 4 days later, still a 1-day window, but we were down in between.
    const t1 = "2026-06-05T00:00:00.000Z";
    await scan.run({ sinceIso: daysBefore(t1, 1), nowIso: t1 });
    expect(seenSince[1]).toBe(t0); // extended back to the last successful scan, not just 1 day
  });

  it("never re-creates a suppressed (not-a-loop) commitment — suppression survives reset", async () => {
    const store = new LoopsStore(":memory:");
    const stub = new StubExtractionClient({ "C1:1": [SEND_DECK] });
    const scan = new ScanService([new FakeSource("slack", [msg({ sourceRef: "C1:1", text: "send the deck" })])], stub, store, IDENTITY);

    await scan.run({ sinceIso: "2026-06-23T00:00:00Z", nowIso: NOW });
    const hash = store.list()[0]!.commitmentHash;
    store.suppressHash(hash, NOW);
    store.reset(); // wipes loops + seen, but NOT suppressions

    const second = await scan.run({ sinceIso: "2026-06-23T00:00:00Z", nowIso: NOW });
    expect(second.fresh).toBe(1); // re-extracted (unseen after reset)
    expect(store.count()).toBe(0); // but suppressed → not stored
  });

  it("clears a snooze-until-reply when the counterpart replies in the thread", async () => {
    const store = new LoopsStore(":memory:");
    store.upsertMany([
      {
        id: "L1",
        direction: "owed",
        kind: "request",
        summary: "Review the doc",
        counterpart: "Priya",
        channel: "slack",
        sourceRef: "C1:100",
        permalink: "p",
        commitmentHash: "h",
        threadTs: "100",
        dueDate: null,
        dueConfidence: "none",
        firmness: "firm",
        status: "open",
        tenant: "T_PERSONAL",
        createdTs: NOW,
      },
    ]);
    store.snooze("L1", "9999-12-31T00:00:00.000Z", "reply");
    expect(store.snoozedUntilReply()).toHaveLength(1);

    const reply = msg({ sourceRef: "C1:150", text: "here you go", threadTs: "100", author: "Priya" });
    const scan = new ScanService([new FakeSource("slack", [reply])], new StubExtractionClient({}), store, IDENTITY);
    await scan.run({ sinceIso: daysBefore(NOW, 1), nowIso: NOW });

    expect(store.snoozedUntilReply()).toHaveLength(0); // reply cleared the snooze
  });

  it("clears a snooze-until-reply for a Gmail thread", async () => {
    const store = new LoopsStore(":memory:");
    store.upsertMany([
      { id: "G1", direction: "owed", kind: "request", summary: "Sign off", counterpart: "boss", channel: "gmail", sourceRef: "TH1:M1", permalink: "p", commitmentHash: "h", dueDate: null, dueConfidence: "none", firmness: "firm", status: "open", tenant: "T_PERSONAL", createdTs: NOW },
    ]);
    store.snooze("G1", "9999-12-31T00:00:00.000Z", "reply");
    const reply = msg({ sourceRef: "TH1:M2", text: "signed", author: "boss" });
    await new ScanService([new FakeSource("slack", [reply])], new StubExtractionClient({}), store, IDENTITY).run({ sinceIso: daysBefore(NOW, 1), nowIso: NOW });
    expect(store.snoozedUntilReply()).toHaveLength(0);
  });

  it("does not clear snooze-until-reply when identities are 'unknown'", async () => {
    const store = new LoopsStore(":memory:");
    store.upsertMany([
      { id: "U1", direction: "owed", kind: "request", summary: "x", counterpart: "unknown", channel: "slack", sourceRef: "C1:100", permalink: "p", commitmentHash: "h", threadTs: "100", dueDate: null, dueConfidence: "none", firmness: "firm", status: "open", tenant: "T_PERSONAL", createdTs: NOW },
    ]);
    store.snooze("U1", "9999-12-31T00:00:00.000Z", "reply");
    const reply = msg({ sourceRef: "C1:150", text: "hi", threadTs: "100", author: "unknown" });
    await new ScanService([new FakeSource("slack", [reply])], new StubExtractionClient({}), store, IDENTITY).run({ sinceIso: daysBefore(NOW, 1), nowIso: NOW });
    expect(store.snoozedUntilReply()).toHaveLength(1); // sentinel identities never match
  });

  it("surfaces source coverage warnings in the scan result", async () => {
    const store = new LoopsStore(":memory:");
    const warning = "Slack @mention search unavailable (not_allowed_token_type) — mention coverage degraded.";
    const flaky: MessageSource = {
      channel: "slack",
      async fetchRecent() {
        return [];
      },
      drainWarnings() {
        return [warning];
      },
    };
    const result = await new ScanService([flaky], new StubExtractionClient({}), store, IDENTITY).run({
      sinceIso: daysBefore(NOW, 1),
      nowIso: NOW,
    });
    expect(result.warnings).toContain(warning);
  });

  it("clears the catch-up watermark on reset so a deep re-scan honours its window", async () => {
    const store = new LoopsStore(":memory:");
    const seenSince: string[] = [];
    const recorder: MessageSource = {
      channel: "slack",
      async fetchRecent({ sinceIso }) {
        seenSince.push(sinceIso);
        return [];
      },
    };
    const scan = new ScanService([recorder], new StubExtractionClient({}), store, IDENTITY);
    await scan.run({ sinceIso: daysBefore(NOW, 1), nowIso: NOW });
    store.reset();
    const deep = daysBefore(NOW, 7);
    await scan.run({ sinceIso: deep, nowIso: NOW });
    expect(seenSince[1]).toBe(deep); // watermark cleared → full 7-day backfill respected
  });
});
