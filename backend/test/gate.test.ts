import { describe, expect, it } from "vitest";
import { defaultForcePass, gate, isNoise, scoreMessage } from "../src/gate.ts";
import type { NormalizedMessage } from "../src/domain/message.ts";

function msg(sourceRef: string, text: string, timestamp = "2026-06-24T10:00:00+05:30", sourceLabel?: string): NormalizedMessage {
  return {
    channel: "slack",
    tenant: "T_TEST",
    sourceRef,
    permalink: `https://slack.example/${sourceRef}`,
    author: "Someone",
    ...(sourceLabel ? { sourceLabel } : {}),
    fromMe: false,
    timestamp,
    sourceTimezone: "Asia/Kolkata",
    text,
  };
}

const dm = (sourceRef: string, text: string, timestamp?: string): NormalizedMessage => msg(sourceRef, text, timestamp, "DM");

describe("scoreMessage", () => {
  it("scores a commitment with a deadline highly", () => {
    const { score, signals } = scoreMessage("I'll send the deck tomorrow");
    expect(score).toBeGreaterThanOrEqual(4);
    expect(signals).toContain("commitment");
    expect(signals).toContain("deadline");
  });

  it("scores a bare request", () => {
    expect(scoreMessage("can you review this?").score).toBe(2);
  });

  it("scores a deadline-only line", () => {
    expect(scoreMessage("the report is due by Friday").score).toBeGreaterThanOrEqual(2);
  });

  it("scores Hinglish commitment", () => {
    expect(scoreMessage("haan main kal report bhej dunga").score).toBeGreaterThanOrEqual(2);
  });

  it("ignores chatter", () => {
    expect(scoreMessage("lunch?").score).toBe(0);
    expect(scoreMessage("thanks, looks good!").score).toBe(0);
  });
});

describe("gate", () => {
  it("keeps only messages with signal", () => {
    const out = gate([
      msg("a", "can you review the RFC by Friday?"),
      msg("b", "lunch?"),
      msg("c", "thanks!"),
    ]);
    expect(out.map((c) => c.message.sourceRef)).toEqual(["a"]);
  });

  it("caps to maxCandidates, highest score first", () => {
    const out = gate(
      [
        msg("low", "can you check this?"), // request only = 2
        msg("high", "I'll send it by EOD tomorrow"), // commitment + deadline = 4
        msg("mid", "due by Monday"), // deadline = 2
      ],
      { maxCandidates: 2 },
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.message.sourceRef).toBe("high");
  });

  it("catches @channel broadcasts with imperatives + soft deadlines (recall)", () => {
    expect(scoreMessage("@channel I expect everyone to update their completion certificates as early as possible").score).toBeGreaterThanOrEqual(1);
    expect(scoreMessage("@channel Windows users, please update the sheet. Please complete this activity tomorrow morning.").score).toBeGreaterThanOrEqual(1);
    const out = gate([msg("x", "@channel I expect everyone to update their certificates as early as possible")]);
    expect(out).toHaveLength(1);
  });

  it("breaks score ties by most recent", () => {
    const out = gate([
      msg("older", "can you review this?", "2026-06-20T10:00:00+05:30"),
      msg("newer", "can you confirm this?", "2026-06-24T10:00:00+05:30"),
    ]);
    expect(out[0]?.message.sourceRef).toBe("newer");
  });
});

describe("isNoise", () => {
  it("flags one-word acks, greetings, and emoji-only lines", () => {
    for (const t of ["thanks!", "ok", "got it", "lol", "hey", "👍", "🎉🎉", "  "]) expect(isNoise(t)).toBe(true);
  });

  it("does not flag a real ask or a Hinglish line", () => {
    expect(isNoise("mind taking a look at the contract?")).toBe(false);
    expect(isNoise("kal report bhej dena")).toBe(false);
  });
});

describe("forcePass (DMs + mentions bypass scoring and the cap)", () => {
  it("passes an indirect DM ask that scores zero on the regex gate", () => {
    expect(scoreMessage("mind taking a look at the contract before our call?").score).toBe(0);
    const out = gate([dm("d1", "mind taking a look at the contract before our call?")]);
    expect(out.map((c) => c.message.sourceRef)).toEqual(["d1"]);
  });

  it("still drops trivial DM noise", () => {
    expect(defaultForcePass(dm("d2", "thanks!"))).toBe(false);
    expect(gate([dm("d2", "thanks!")])).toHaveLength(0);
  });

  it("never caps force-passed DMs even below maxCandidates", () => {
    const dms = Array.from({ length: 5 }, (_, i) => dm(`d${i}`, `quick question number ${i} for you to answer`));
    const out = gate(dms, { maxCandidates: 2 });
    expect(out).toHaveLength(5);
  });
});
