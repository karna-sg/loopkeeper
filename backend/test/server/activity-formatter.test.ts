import { describe, expect, it } from "vitest";
import { formatActivityLine } from "../../src/server/routes/engineering.ts";

describe("formatActivityLine", () => {
  it("returns null for empty / whitespace lines", () => {
    expect(formatActivityLine("")).toBeNull();
    expect(formatActivityLine("   ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(formatActivityLine("{not json")).toBeNull();
    expect(formatActivityLine("just text")).toBeNull();
  });

  it("returns null for system / user type lines", () => {
    expect(formatActivityLine(JSON.stringify({ type: "system", subtype: "init" }))).toBeNull();
    expect(formatActivityLine(JSON.stringify({ type: "user", message: { content: [] } }))).toBeNull();
  });

  it("formats assistant text block", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "I will plan the feature." }] },
    });
    expect(formatActivityLine(line)).toBe("text: I will plan the feature.");
  });

  it("truncates long assistant text to 200 chars", () => {
    const long = "x".repeat(300);
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: long }] },
    });
    const result = formatActivityLine(line);
    expect(result).toBe(`text: ${"x".repeat(200)}`);
  });

  it("formats assistant tool_use block with first input key", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/src/foo.ts" } }],
      },
    });
    expect(formatActivityLine(line)).toBe("tool: Read /src/foo.ts");
  });

  it("formats assistant tool_use block with no input keys", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "ExitPlanMode", input: {} }] },
    });
    expect(formatActivityLine(line)).toBe("tool: ExitPlanMode");
  });

  it("formats multi-block assistant message (text + tool) joined with newline", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the file." },
          { type: "tool_use", name: "Read", input: { file_path: "/src/bar.ts" } },
        ],
      },
    });
    expect(formatActivityLine(line)).toBe("text: Reading the file.\ntool: Read /src/bar.ts");
  });

  it("skips blank text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "   " }] },
    });
    expect(formatActivityLine(line)).toBeNull();
  });

  it("formats result: ok with turns and cost", () => {
    const line = JSON.stringify({ type: "result", is_error: false, result: "", num_turns: 12, total_cost_usd: 0.042 });
    expect(formatActivityLine(line)).toBe("result: ok 12 turns $0.04");
  });

  it("formats result: ok without optional fields", () => {
    const line = JSON.stringify({ type: "result", is_error: false, result: "" });
    expect(formatActivityLine(line)).toBe("result: ok");
  });

  it("formats result: error with message", () => {
    const line = JSON.stringify({ type: "result", is_error: true, result: "Something went wrong" });
    expect(formatActivityLine(line)).toBe("result: error Something went wrong");
  });

  it("truncates long error result to 120 chars", () => {
    const long = "e".repeat(200);
    const line = JSON.stringify({ type: "result", is_error: true, result: long });
    const result = formatActivityLine(line);
    expect(result).toBe(`result: error ${"e".repeat(120)}`);
  });

  it("returns null for assistant message with no recognisable content blocks", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "image" }] } });
    expect(formatActivityLine(line)).toBeNull();
  });
});
