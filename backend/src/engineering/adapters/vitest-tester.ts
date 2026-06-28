import { redactSecrets } from "../../redact.ts";
import type { Tester, TestOutcome } from "../ports.ts";
import { runProcess } from "./spawn.ts";

export interface VerifyCheck {
  name: string;
  cmd: string;
  args: readonly string[];
}

export interface VitestTesterConfig {
  /** The verification checks run in the worktree, in order — MUST mirror CI (deploy.yml `verify`):
   *  typecheck + lint + test. Run sequentially, short-circuit on the first failure. */
  checks: readonly VerifyCheck[];
  /** Install deps first (a fresh worktree has no node_modules). */
  installCmd: string;
  installArgs: readonly string[];
  timeoutMs: number;
}

export const DEFAULT_VITEST_CONFIG: Omit<VitestTesterConfig, "timeoutMs"> = {
  installCmd: "pnpm",
  installArgs: ["install", "--prefer-offline"],
  // Same checks as .github/workflows/{ci,deploy}.yml so the local gate catches what CI catches
  // (typecheck/lint failures — e.g. a port method added without updating the test fakes).
  checks: [
    { name: "typecheck", cmd: "pnpm", args: ["-r", "typecheck"] },
    { name: "lint", cmd: "pnpm", args: ["-r", "lint"] },
    { name: "test", cmd: "pnpm", args: ["-r", "test"] },
  ],
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

/**
 * Runs the repo's CI verification checks (typecheck → lint → test) by exit code — never via the agent.
 * Installs once, then runs each check in order and short-circuits on the first failure, so the local
 * gate matches CI exactly and broken code never reaches a PR. (`vitest` alone does NOT typecheck.)
 */
export class VitestTester implements Tester {
  readonly #cfg: VitestTesterConfig;
  constructor(cfg: VitestTesterConfig) {
    this.#cfg = cfg;
  }

  async run(worktreePath: string): Promise<TestOutcome> {
    await runProcess(this.#cfg.installCmd, this.#cfg.installArgs, { cwd: worktreePath, timeoutMs: this.#cfg.timeoutMs });
    let combined = "";
    let total: number | null = null;
    let failed: number | null = null;
    let failedCheck: string | null = null;

    for (const check of this.#cfg.checks) {
      const res = await runProcess(check.cmd, check.args, { cwd: worktreePath, timeoutMs: this.#cfg.timeoutMs });
      const out = stripAnsi(`${res.stdout}\n${res.stderr}`);
      combined += `\n=== ${check.name} ===\n${out}`;
      if (check.name === "test") {
        const parsed = parseVitestSummary(out);
        total = parsed.total;
        failed = parsed.failed;
      }
      if (res.code !== 0 || res.timedOut) {
        failedCheck = check.name;
        break; // short-circuit — no point running later checks once one fails
      }
    }

    const tail = redactSecrets(combined.slice(-1600));
    return {
      passed: failedCheck === null,
      total,
      failed,
      summary: failedCheck ? `verification failed at: ${failedCheck}\n${tail}` : tail,
    };
  }
}
