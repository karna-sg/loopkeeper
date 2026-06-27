import { describe, expect, it } from "vitest";
import { commitmentHash, dedupeLoops, loopId, onlyNew } from "../src/dedupe.ts";
import { loopDedupeKey } from "../src/domain/open-loop.ts";
import type { OpenLoop } from "../src/domain/open-loop.ts";

function loop(overrides: Partial<OpenLoop> = {}): OpenLoop {
  const base: OpenLoop = {
    id: "x",
    direction: "owe",
    kind: "commitment",
    summary: "Send the deck",
    counterpart: "Anil",
    channel: "slack",
    sourceRef: "C1:1",
    permalink: "https://slack.example/C1/1",
    commitmentHash: commitmentHash("send the deck"),
    dueDate: "2026-06-26",
    dueConfidence: "explicit",
    firmness: "firm",
    status: "open",
    tenant: "T",
    createdTs: "2026-06-25T04:00:00Z",
  };
  return { ...base, ...overrides, id: loopId({ ...base, ...overrides }) };
}

describe("commitmentHash", () => {
  it("is stable across whitespace and case", () => {
    expect(commitmentHash("Send  the   Deck")).toBe(commitmentHash("send the deck"));
  });

  it("differs for different spans", () => {
    expect(commitmentHash("send the deck")).not.toBe(commitmentHash("review the rfc"));
  });
});

describe("loopId", () => {
  it("is deterministic for the same key", () => {
    const key = { channel: "slack", sourceRef: "C1:1", direction: "owe", commitmentHash: "abc" } as const;
    expect(loopId(key)).toBe(loopId(key));
  });
});

describe("dedupeLoops", () => {
  it("keeps two distinct commitments from the same message", () => {
    const a = loop({ commitmentHash: commitmentHash("send the deck") });
    const b = loop({ commitmentHash: commitmentHash("follow up with legal"), summary: "Follow up" });
    const out = dedupeLoops([a, b]);
    expect(out).toHaveLength(2);
  });

  it("collapses the same key and prefers the higher due confidence", () => {
    const vague = loop({ dueDate: null, dueConfidence: "none" });
    const dated = loop({ dueDate: "2026-06-26", dueConfidence: "explicit" });
    const out = dedupeLoops([vague, dated]);
    expect(out).toHaveLength(1);
    expect(out[0]?.dueConfidence).toBe("explicit");
  });
});

describe("onlyNew", () => {
  it("filters out loops already seen", () => {
    const a = loop();
    const seen = new Set([loopDedupeKey(a)]);
    expect(onlyNew([a], seen)).toHaveLength(0);
  });
});
