import { describe, expect, it } from "vitest";
import { parsePatch } from "../../../src/engineering/adapters/rest-github.ts";

describe("parsePatch", () => {
  const SIMPLE = [
    "@@ -1,4 +1,5 @@",
    " context line",
    "-removed line",
    "+added line",
    " another context",
    "+second addition",
  ].join("\n");

  it("parses a single hunk into header + typed lines", () => {
    const hunks = parsePatch(SIMPLE);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.header).toBe("@@ -1,4 +1,5 @@");
    expect(hunks[0]?.lines).toEqual([
      { type: " ", text: "context line" },
      { type: "-", text: "removed line" },
      { type: "+", text: "added line" },
      { type: " ", text: "another context" },
      { type: "+", text: "second addition" },
    ]);
  });

  it("parses multiple hunks from one patch", () => {
    const multiHunk = [
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "@@ -10,2 +10,2 @@",
      " ctx",
      "-gone",
    ].join("\n");
    const hunks = parsePatch(multiHunk);
    expect(hunks).toHaveLength(2);
    expect(hunks[1]?.header).toBe("@@ -10,2 +10,2 @@");
    expect(hunks[1]?.lines).toHaveLength(2);
  });

  it("returns empty array for an empty patch", () => {
    expect(parsePatch("")).toEqual([]);
  });

  it("redacts secrets from line content", () => {
    const patch = ["@@ -1,1 +1,1 @@", "+TOKEN=sk-ant-api03-supersecretkey1234567890abc"].join("\n");
    const hunks = parsePatch(patch);
    expect(hunks[0]?.lines[0]?.text).not.toContain("sk-ant-api03");
    expect(hunks[0]?.lines[0]?.text).toContain("[REDACTED:secret-shaped]");
  });

  it("caps lines at MAX_DIFF_LINES (300) per hunk", () => {
    const lines = ["@@ -1,350 +1,350 @@"];
    for (let i = 0; i < 350; i++) lines.push(` context line ${i}`);
    const hunks = parsePatch(lines.join("\n"));
    expect(hunks[0]?.lines.length).toBeLessThanOrEqual(300);
  });

  it("handles a patch with no leading hunk header gracefully", () => {
    const noHeader = " context\n-old\n+new";
    const hunks = parsePatch(noHeader);
    expect(hunks).toHaveLength(0);
  });
});
