import { describe, expect, it } from "vitest";
import { detectClosures } from "../../src/nudge/closure.ts";
import type { NormalizedMessage } from "../../src/domain/message.ts";
import type { OpenLoop } from "../../src/domain/open-loop.ts";

function msg(over: Partial<NormalizedMessage> & Pick<NormalizedMessage, "sourceRef" | "text" | "fromMe">): NormalizedMessage {
  return {
    channel: "slack",
    tenant: "T",
    permalink: "p",
    author: "x",
    timestamp: "2026-06-25T10:00:00+05:30",
    sourceTimezone: "Asia/Kolkata",
    ...over,
  };
}

function loop(over: Partial<OpenLoop> & Pick<OpenLoop, "id" | "sourceRef">): OpenLoop {
  return {
    direction: "owe",
    kind: "commitment",
    summary: "Send the deck",
    counterpart: "Anil",
    channel: "slack",
    permalink: "p",
    commitmentHash: "h",
    dueDate: null,
    dueConfidence: "none",
    firmness: "firm",
    status: "open",
    tenant: "T",
    createdTs: "2026-06-24T00:00:00Z",
    ...over,
  };
}

describe("detectClosures", () => {
  it("flags an owe loop when the user says it's done in the SAME thread", () => {
    const messages = [msg({ sourceRef: "C1:200", threadTs: "100", text: "sent it just now", fromMe: true })];
    const loops = [loop({ id: "L1", sourceRef: "C1:100", threadTs: "100" })];
    expect(detectClosures(messages, loops)).toEqual(["L1"]);
  });

  it("flags an owe loop when the user says it's done in the SAME DM conversation", () => {
    const messages = [msg({ sourceRef: "D1:200", sourceLabel: "DM", text: "done, sent it", fromMe: true })];
    const loops = [loop({ id: "L1", sourceRef: "D1:100", sourceLabel: "DM" })];
    expect(detectClosures(messages, loops)).toEqual(["L1"]);
  });

  it("matches Hinglish completion in a thread", () => {
    const messages = [msg({ sourceRef: "C1:200", threadTs: "100", text: "ho gaya, kar diya", fromMe: true })];
    expect(detectClosures(messages, [loop({ id: "L1", sourceRef: "C1:100", threadTs: "100" })])).toEqual(["L1"]);
  });

  it("does NOT mis-close every loop in a busy channel from a top-level 'done' (the bug fix)", () => {
    const messages = [msg({ sourceRef: "C1:300", text: "done!", fromMe: true })]; // no thread, not a DM
    const loops = [
      loop({ id: "L1", sourceRef: "C1:100", summary: "Send the deck" }),
      loop({ id: "L2", sourceRef: "C1:200", summary: "Review the PR" }),
    ];
    expect(detectClosures(messages, loops)).toEqual([]);
  });

  it("ignores completion language from someone else", () => {
    const messages = [msg({ sourceRef: "C1:200", threadTs: "100", text: "is it done?", fromMe: false })];
    expect(detectClosures(messages, [loop({ id: "L1", sourceRef: "C1:100", threadTs: "100" })])).toEqual([]);
  });

  it("does not flag across different threads", () => {
    const messages = [msg({ sourceRef: "C1:200", threadTs: "999", text: "done", fromMe: true })];
    expect(detectClosures(messages, [loop({ id: "L1", sourceRef: "C1:100", threadTs: "100" })])).toEqual([]);
  });

  it("does not flag a non-completion reply", () => {
    const messages = [msg({ sourceRef: "C1:200", threadTs: "100", text: "still working on it", fromMe: true })];
    expect(detectClosures(messages, [loop({ id: "L1", sourceRef: "C1:100", threadTs: "100" })])).toEqual([]);
  });

  it("only considers open owe loops", () => {
    const messages = [msg({ sourceRef: "C1:200", threadTs: "100", text: "done", fromMe: true })];
    const loops = [
      loop({ id: "L1", sourceRef: "C1:100", threadTs: "100", status: "closed" }),
      loop({ id: "L2", sourceRef: "C1:100", threadTs: "100", direction: "owed" }),
    ];
    expect(detectClosures(messages, loops)).toEqual([]);
  });
});
