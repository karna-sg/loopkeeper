import { describe, expect, it } from "vitest";
import { parseRedeployOutput } from "../../../src/engineering/adapters/ssh-deployer.ts";
import { parseVitestSummary, stripAnsi } from "../../../src/engineering/adapters/vitest-tester.ts";

describe("parseRedeployOutput", () => {
  it("parses the OK line with the deployed sha", () => {
    expect(parseRedeployOutput("pulling...\nbuilding...\nREDEPLOY_OK abc1234\n")).toEqual({ ok: true, sha: "abc1234" });
  });
  it("parses the FAIL line", () => {
    expect(parseRedeployOutput("oops\nREDEPLOY_FAIL build error\n")).toEqual({ ok: false, sha: null });
  });
  it("treats missing markers as failure", () => {
    expect(parseRedeployOutput("random output")).toEqual({ ok: false, sha: null });
  });
});

describe("parseVitestSummary", () => {
  it("reads total from the passed line", () => {
    expect(parseVitestSummary("Tests  196 passed (196)")).toEqual({ total: 196, failed: null });
  });
  it("reads failed + total", () => {
    expect(parseVitestSummary("Tests  2 failed | 10 passed (12)")).toEqual({ total: 12, failed: 2 });
  });
  it("tolerates no summary line", () => {
    expect(parseVitestSummary("compile error")).toEqual({ total: null, failed: null });
  });
  it("parses a summary even when vitest colorizes it", () => {
    const esc = String.fromCharCode(27);
    const colored = `${esc}[32mTests  ${esc}[1m12 passed${esc}[22m (12)${esc}[0m`;
    expect(parseVitestSummary(stripAnsi(colored))).toEqual({ total: 12, failed: null });
  });
});

describe("stripAnsi", () => {
  const esc = String.fromCharCode(27);
  it("removes color + style CSI sequences", () => {
    expect(stripAnsi(`${esc}[31mred${esc}[0m`)).toBe("red");
  });
  it("leaves plain text untouched", () => {
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
  });
});
