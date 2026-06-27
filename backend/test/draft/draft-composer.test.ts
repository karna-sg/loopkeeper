import { describe, expect, it } from "vitest";
import { FakeDraftClient } from "../../src/draft/draft-composer.ts";
import type { OpenLoop } from "../../src/domain/open-loop.ts";

const loop: OpenLoop = {
  id: "L1",
  direction: "owed",
  kind: "request",
  summary: "the Q2 numbers",
  counterpart: "Priya",
  channel: "slack",
  sourceRef: "C1:1",
  permalink: "p",
  commitmentHash: "h",
  dueDate: "2026-06-26",
  dueConfidence: "explicit",
  firmness: "firm",
  status: "open",
  tenant: "T",
  createdTs: "2026-06-25T00:00:00Z",
};

describe("FakeDraftClient", () => {
  it("drafts a polite chaser referencing counterpart, item, and due date", async () => {
    const draft = await new FakeDraftClient().draftChaser(loop);
    expect(draft).toContain("Priya");
    expect(draft).toContain("the Q2 numbers");
    expect(draft).toContain("2026-06-26");
    expect(draft.toLowerCase()).toContain("following up");
  });
});
