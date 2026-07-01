import { describe, expect, it } from "vitest";
import { parsePlanSpec } from "../../../src/engineering/adapters/claude-runner.ts";

describe("parsePlanSpec", () => {
  it("returns null for empty string", () => {
    expect(parsePlanSpec("")).toBeNull();
  });

  it("returns null when no ```json fence is present", () => {
    expect(parsePlanSpec("Here is the plan:\n- step 1\n- step 2")).toBeNull();
  });

  it("returns null when fence is unclosed", () => {
    expect(parsePlanSpec("```json\n{\"summary\": \"foo\"}")).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    expect(parsePlanSpec("```json\n{ bad json }\n```")).toBeNull();
  });

  it("parses a full valid spec", () => {
    const text = [
      "Here is my plan.",
      "```json",
      JSON.stringify({
        summary: "Add feature X",
        steps: ["Step 1", "Step 2"],
        changedFiles: ["src/foo.ts", "src/bar.ts"],
        newTests: ["test/foo.test.ts"],
        riskFlags: ["Touches auth"],
      }),
      "```",
    ].join("\n");

    expect(parsePlanSpec(text)).toEqual({
      summary: "Add feature X",
      steps: ["Step 1", "Step 2"],
      changedFiles: ["src/foo.ts", "src/bar.ts"],
      newTests: ["test/foo.test.ts"],
      riskFlags: ["Touches auth"],
    });
  });

  it("handles partial spec with only summary and steps", () => {
    const text = "```json\n" + JSON.stringify({ summary: "Short plan", steps: ["Only step"] }) + "\n```";
    expect(parsePlanSpec(text)).toEqual({
      summary: "Short plan",
      steps: ["Only step"],
      changedFiles: null,
      newTests: null,
      riskFlags: null,
    });
  });

  it("returns null fields for keys that are not present", () => {
    const text = "```json\n{}\n```";
    expect(parsePlanSpec(text)).toEqual({
      summary: null,
      steps: null,
      changedFiles: null,
      newTests: null,
      riskFlags: null,
    });
  });

  it("uses the LAST fence when multiple ```json fences appear", () => {
    // Prose contains an inline example, the real spec comes last
    const text = [
      "Example return value: ```json\n{\"summary\": \"wrong\"}\n```",
      "The actual plan spec:",
      "```json",
      JSON.stringify({ summary: "correct", steps: ["do it"] }),
      "```",
    ].join("\n");

    const result = parsePlanSpec(text);
    expect(result?.summary).toBe("correct");
  });

  it("drops non-string array elements and keeps string ones", () => {
    const text =
      "```json\n" +
      JSON.stringify({ steps: ["valid", 42, null, "also valid"], changedFiles: [1, 2, 3] }) +
      "\n```";
    const result = parsePlanSpec(text);
    expect(result?.steps).toEqual(["valid", "also valid"]);
    expect(result?.changedFiles).toEqual([]);
  });

  it("returns null summary when summary is not a string", () => {
    const text = "```json\n" + JSON.stringify({ summary: 123, steps: [] }) + "\n```";
    expect(parsePlanSpec(text)?.summary).toBeNull();
  });
});
