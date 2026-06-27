import { describe, expect, it } from "vitest";
import { buildOpenLoops, extractLoops, validateExtracted } from "../src/extractor.ts";
import { StubExtractionClient } from "../src/stub-extraction-client.ts";
import { gate } from "../src/gate.ts";
import { REDACTION_PLACEHOLDER } from "../src/redact.ts";
import type { ExtractedLoop } from "../src/domain/open-loop.ts";
import type { NormalizedMessage, UserIdentity } from "../src/domain/message.ts";

const NOW = "2026-06-25T04:00:00Z";
const IDENTITY: UserIdentity = { displayName: "Karna", aliases: ["@karna"], timezone: "Asia/Kolkata" };

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    channel: "slack",
    tenant: "T",
    sourceRef: "C1:1",
    permalink: "https://slack.example/C1/1",
    author: "Priya",
    fromMe: false,
    timestamp: "2026-06-24T11:00:00+05:30",
    sourceTimezone: "Asia/Kolkata",
    text: "...",
    ...overrides,
  };
}

function extracted(overrides: Partial<ExtractedLoop> = {}): ExtractedLoop {
  return {
    direction: "owe",
    kind: "commitment",
    summary: "Send the deck",
    counterpart: "Anil",
    commitmentSpan: "I'll send the deck by EOD tomorrow",
    duePhrase: "by EOD tomorrow",
    firmness: "firm",
    ...overrides,
  };
}

describe("validateExtracted", () => {
  it("accepts a well-formed loop", () => {
    expect(validateExtracted(extracted())).toHaveLength(1);
  });

  it("accepts a null duePhrase", () => {
    expect(validateExtracted(extracted({ duePhrase: null }))).toHaveLength(1);
  });

  it("rejects a bad direction", () => {
    expect(validateExtracted({ ...extracted(), direction: "maybe" })).toHaveLength(0);
  });

  it("rejects an empty commitment span", () => {
    expect(validateExtracted({ ...extracted(), commitmentSpan: "   " })).toHaveLength(0);
  });

  it("rejects a non-string duePhrase", () => {
    expect(validateExtracted({ ...extracted(), duePhrase: 5 })).toHaveLength(0);
  });

  it("rejects non-objects", () => {
    expect(validateExtracted(null)).toHaveLength(0);
    expect(validateExtracted("nope")).toHaveLength(0);
  });
});

describe("buildOpenLoops", () => {
  it("maps two commitments in one message to two distinct rows", () => {
    const rows = buildOpenLoops(
      [
        extracted({ commitmentSpan: "I'll send the contract today", duePhrase: "today" }),
        extracted({ commitmentSpan: "I'll follow up with legal next week", duePhrase: "next week", summary: "Follow up" }),
      ],
      message(),
      IDENTITY,
      { nowIso: NOW },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.commitmentHash).not.toBe(rows[1]?.commitmentHash);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it("resolves the due date via the IST parser", () => {
    const [row] = buildOpenLoops([extracted({ duePhrase: "by EOD tomorrow" })], message(), IDENTITY, { nowIso: NOW });
    expect(row?.dueDate).toBe("2026-06-26");
    expect(row?.dueConfidence).toBe("explicit");
  });

  it("sets stable storage fields", () => {
    const [row] = buildOpenLoops([extracted()], message(), IDENTITY, { nowIso: NOW });
    expect(row?.status).toBe("open");
    expect(row?.tenant).toBe("T");
    expect(row?.permalink).toBe("https://slack.example/C1/1");
    expect(row?.createdTs).toBe(NOW);
  });

  it("redacts secret-shaped values BEFORE persist (must-fix guardrail)", () => {
    const [row] = buildOpenLoops(
      [extracted({ summary: "Send key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789", counterpart: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" })],
      message(),
      IDENTITY,
      { nowIso: NOW },
    );
    expect(row?.summary).toContain(REDACTION_PLACEHOLDER);
    expect(row?.summary).not.toContain("sk-ant-");
    expect(row?.counterpart).toBe(REDACTION_PLACEHOLDER);
  });

  it("omits quoteExcerpt by default and includes a redacted one when opted in", () => {
    const off = buildOpenLoops([extracted()], message(), IDENTITY, { nowIso: NOW });
    expect(off[0]?.quoteExcerpt).toBeUndefined();
    const on = buildOpenLoops([extracted()], message(), IDENTITY, { nowIso: NOW, includeQuoteExcerpt: true });
    expect(on[0]?.quoteExcerpt).toBe("I'll send the deck by EOD tomorrow");
  });
});

describe("extractLoops", () => {
  it("runs gate -> stub client -> deduped rows, preserving multi-commitment", async () => {
    const messages: NormalizedMessage[] = [
      message({ sourceRef: "C1:1", text: "I'll send the contract today and I'll follow up with legal next week." }),
      message({ sourceRef: "C2:2", text: "lunch?" }),
    ];
    const stub = new StubExtractionClient({
      "C1:1": [
        extracted({ commitmentSpan: "I'll send the contract today", duePhrase: "today", summary: "Send contract" }),
        extracted({ commitmentSpan: "I'll follow up with legal next week", duePhrase: "next week", summary: "Follow up" }),
      ],
    });
    const candidates = gate(messages);
    expect(candidates).toHaveLength(1); // "lunch?" dropped by the gate
    const loops = await extractLoops(candidates, stub, { nowIso: NOW, identity: IDENTITY });
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => l.summary).sort()).toEqual(["Follow up", "Send contract"]);
  });
});
