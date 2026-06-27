import { describe, expect, it } from "vitest";
import { loopsFromToolArguments } from "../src/openai-extractor.ts";

const valid = JSON.stringify({
  loops: [
    {
      direction: "owe",
      kind: "request",
      summary: "Review the RFC",
      counterpart: "Priya",
      commitmentSpan: "can you review the RFC by Friday",
      duePhrase: "by Friday",
      firmness: "firm",
    },
  ],
});

describe("loopsFromToolArguments", () => {
  it("parses + validates a well-formed function-call payload", () => {
    const loops = loopsFromToolArguments(valid);
    expect(loops).toHaveLength(1);
    expect(loops[0]?.duePhrase).toBe("by Friday");
  });

  it("drops malformed loops via validateExtracted", () => {
    const bad = JSON.stringify({ loops: [{ direction: "maybe", kind: "request", summary: "x", counterpart: "y", commitmentSpan: "z", duePhrase: null, firmness: "firm" }] });
    expect(loopsFromToolArguments(bad)).toHaveLength(0);
  });

  it("returns [] for undefined / bad JSON / missing loops / non-object", () => {
    expect(loopsFromToolArguments(undefined)).toEqual([]);
    expect(loopsFromToolArguments("{not json")).toEqual([]);
    expect(loopsFromToolArguments(JSON.stringify({}))).toEqual([]);
    expect(loopsFromToolArguments(JSON.stringify({ loops: "nope" }))).toEqual([]);
    expect(loopsFromToolArguments(JSON.stringify(42))).toEqual([]);
  });
});
