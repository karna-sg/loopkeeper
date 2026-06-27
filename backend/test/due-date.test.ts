import { describe, expect, it } from "vitest";
import { resolveDueDate } from "../src/due-date.ts";

const TZ = "Asia/Kolkata";
// 09:30 IST on 2026-06-25, a Thursday.
const THU = "2026-06-25T04:00:00Z";
// 09:30 IST on 2026-06-27, a Saturday.
const SAT = "2026-06-27T04:00:00Z";

describe("resolveDueDate", () => {
  it("returns none for a null phrase", () => {
    expect(resolveDueDate(null, THU, TZ)).toEqual({ dueDate: null, dueConfidence: "none" });
  });

  it("resolves an ISO date explicitly", () => {
    expect(resolveDueDate("2026-07-15", THU, TZ)).toEqual({ dueDate: "2026-07-15", dueConfidence: "explicit" });
  });

  it("'by Friday' on a Thursday -> the next day", () => {
    expect(resolveDueDate("by Friday", THU, TZ)).toEqual({ dueDate: "2026-06-26", dueConfidence: "explicit" });
  });

  it("'Friday' on a Saturday -> the following Friday (6 days out)", () => {
    expect(resolveDueDate("Friday", SAT, TZ)).toEqual({ dueDate: "2026-07-03", dueConfidence: "explicit" });
  });

  it("'EOD tomorrow' -> tomorrow", () => {
    expect(resolveDueDate("EOD tomorrow", THU, TZ)).toEqual({ dueDate: "2026-06-26", dueConfidence: "explicit" });
  });

  it("'today' and bare 'EOD' -> today", () => {
    expect(resolveDueDate("today", THU, TZ).dueDate).toBe("2026-06-25");
    expect(resolveDueDate("by EOD", THU, TZ).dueDate).toBe("2026-06-25");
  });

  it("Hinglish 'kal' -> tomorrow", () => {
    expect(resolveDueDate("kal", THU, TZ)).toEqual({ dueDate: "2026-06-26", dueConfidence: "explicit" });
  });

  it("'day after tomorrow' -> +2", () => {
    expect(resolveDueDate("day after tomorrow", THU, TZ).dueDate).toBe("2026-06-27");
  });

  it("'before 30 June 2026' -> that date", () => {
    expect(resolveDueDate("before 30 June 2026", THU, TZ)).toEqual({
      dueDate: "2026-06-30",
      dueConfidence: "explicit",
    });
  });

  it("'Jul 1' month-day form, rolls to next year only if already past", () => {
    expect(resolveDueDate("Jul 1", THU, TZ).dueDate).toBe("2026-07-01");
  });

  it("Indian DD-Mon-YY bank format '29-Jun-26' -> that date (real-inbox regression)", () => {
    expect(resolveDueDate("29-Jun-26", THU, TZ)).toEqual({ dueDate: "2026-06-29", dueConfidence: "explicit" });
  });

  it("hyphenated DD-Mon-YYYY '29-Jun-2026'", () => {
    expect(resolveDueDate("29-Jun-2026", THU, TZ).dueDate).toBe("2026-06-29");
  });

  it("'before the release' is unresolvable -> none (never nudge)", () => {
    expect(resolveDueDate("before the release", THU, TZ)).toEqual({ dueDate: null, dueConfidence: "none" });
  });

  it("'asap' is urgency, not a date -> none", () => {
    expect(resolveDueDate("asap", THU, TZ).dueConfidence).toBe("none");
  });

  it("'this week' -> upcoming Friday, inferred", () => {
    expect(resolveDueDate("this week", THU, TZ)).toEqual({ dueDate: "2026-06-26", dueConfidence: "inferred" });
  });

  it("'next week' -> Friday of next week, inferred", () => {
    expect(resolveDueDate("next week", THU, TZ)).toEqual({ dueDate: "2026-07-03", dueConfidence: "inferred" });
  });

  it("'end of month' -> last day, inferred", () => {
    expect(resolveDueDate("end of month", THU, TZ)).toEqual({ dueDate: "2026-06-30", dueConfidence: "inferred" });
  });
});
