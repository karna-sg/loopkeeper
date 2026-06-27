import { redactSecrets } from "../../redact.ts";
import type { Tester, TestOutcome } from "../ports.ts";
import { runProcess } from "./spawn.ts";

export interface VitestTesterConfig {
  /** Test command + args run in the worktree (default: pnpm vitest for the backend workspace). */
  testCmd: string;
  testArgs: readonly string[];
  /** Install deps first (a fresh worktree has no node_modules). */
  installCmd: string;
  installArgs: readonly string[];
  timeoutMs: number;
}

export const DEFAULT_VITEST_CONFIG: Omit<VitestTesterConfig, "timeoutMs"> = {
  installCmd: "pnpm",
  installArgs: ["install", "--prefer-offline"],
  testCmd: "pnpm",
  testArgs: ["--filter", "@loopkeeper/backend", "test"],
};

/** Parse vitest's summary line, e.g. "Tests  12 passed (12)" / "Tests  2 failed | 10 passed (12)". */
export function parseVitestSummary(output: string): { total: number | null; failed: number | null } {
  const failed = output.match(/Tests\s+.*?(\d+)\s+failed/i);
  const total = output.match(/Tests\s+.*?\((\d+)\)/);
  return {
    failed: failed?.[1] ? Number(failed[1]) : null,
    total: total?.[1] ? Number(total[1]) : null,
  };
}

const ESC = String.fromCharCode(27);
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"); // colors, cursor moves
const ANSI_OTHER = new RegExp(`${ESC}[@-Z\\\\-_]`, "g"); // other single-char escapes

/** Strip ANSI / terminal control sequences (vitest colorizes output) so stored summaries are clean. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, "").replace(ANSI_OTHER, "");
}

/** Runs the repo's unit tests by exit code (deterministic) — never via the agent. */
export class VitestTester implements Tester {
  readonly #cfg: VitestTesterConfig;
  constructor(cfg: VitestTesterConfig) {
    this.#cfg = cfg;
  }

  async run(worktreePath: string): Promise<TestOutcome> {
    await runProcess(this.#cfg.installCmd, this.#cfg.installArgs, { cwd: worktreePath, timeoutMs: this.#cfg.timeoutMs });
    const res = await runProcess(this.#cfg.testCmd, this.#cfg.testArgs, { cwd: worktreePath, timeoutMs: this.#cfg.timeoutMs });
    const combined = stripAnsi(`${res.stdout}\n${res.stderr}`);
    const { total, failed } = parseVitestSummary(combined);
    return {
      passed: res.code === 0 && !res.timedOut,
      total,
      failed,
      summary: redactSecrets(combined.slice(-1500)),
    };
  }
}
