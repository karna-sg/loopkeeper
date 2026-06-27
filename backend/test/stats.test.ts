import { describe, expect, it } from "vitest";
import { buildStats } from "../src/stats.ts";
import type { OpenLoop } from "../src/domain/open-loop.ts";

const NOW = "2026-06-25T00:00:00.000Z";

function loop(o: Partial<OpenLoop> & Pick<OpenLoop, "id" | "status" | "direction">): OpenLoop {
  return {
    kind: "commitment",
    summary: "x",
    counterpart: "Y",
    channel: "slack",
    sourceRef: o.id,
    permalink: "p",
    commitmentHash: o.id,
    dueDate: null,
    dueConfidence: "none",
    firmness: "firm",
    tenant: "T",
    createdTs: NOW,
    ...o,
  } as OpenLoop;
}

describe("buildStats", () => {
  const loops: OpenLoop[] = [
    // closed on time: created 06-20, due 06-24, resolved 06-23 (72h)
    loop({ id: "a", status: "closed", direction: "owe", dueDate: "2026-06-24", createdTs: "2026-06-20T10:00:00.000Z", resolvedTs: "2026-06-23T10:00:00.000Z" }),
    // closed late: created 06-22, due 06-20, resolved 06-24 (48h) — most recent close
    loop({ id: "b", status: "closed", direction: "owe", dueDate: "2026-06-20", createdTs: "2026-06-22T10:00:00.000Z", resolvedTs: "2026-06-24T10:00:00.000Z" }),
    // open owe, overdue (due before today)
    loop({ id: "c", status: "open", direction: "owe", dueDate: "2026-06-24" }),
    // open owe, old (carry-over): created 12 days ago
    loop({ id: "d", status: "open", direction: "owe", createdTs: "2026-06-13T00:00:00.000Z" }),
    // open owed (awaiting)
    loop({ id: "e", status: "open", direction: "owed" }),
    // dismissed
    loop({ id: "f", status: "dismissed", direction: "owe", resolvedTs: "2026-06-24T00:00:00.000Z" }),
  ];

  const s = buildStats(loops, NOW);

  it("counts open / owe / owed / overdue", () => {
    expect(s.open.total).toBe(3); // c, d, e
    expect(s.open.owe).toBe(2);
    expect(s.open.owed).toBe(1);
    expect(s.open.overdue).toBe(1); // c
  });

  it("counts closed + dismissed with recency windows", () => {
    expect(s.closed.total).toBe(2);
    expect(s.closed.last7).toBe(2);
    expect(s.dismissed.total).toBe(1);
  });

  it("computes on-time rate, median time-to-close, carry-over", () => {
    expect(s.onTimeRate).toBe(0.5); // a on time, b late
    expect(s.medianTimeToCloseHours).toBe(60); // median(72, 48)
    expect(s.carryOver).toBe(1); // d (open owe > 7 days old)
  });

  it("breaks the on-time streak at the most recent late close", () => {
    expect(s.onTimeStreak).toBe(0); // most recent closed-with-due (b) was late
    expect(s.byWeek.length).toBeGreaterThanOrEqual(1);
  });

  it("handles an empty set", () => {
    const empty = buildStats([], NOW);
    expect(empty.open.total).toBe(0);
    expect(empty.onTimeRate).toBeNull();
    expect(empty.medianTimeToCloseHours).toBeNull();
  });
});
