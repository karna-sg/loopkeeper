import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunArgs, AgentRunResult, AgentRunner } from "../ports.ts";
import { redactSecrets } from "../../redact.ts";
import { runProcess } from "./spawn.ts";

export interface ClaudeRunnerConfig {
  claudeBin: string;
  model: string | null;
  anthropicApiKey: string;
  timeoutMs: number;
  logDir: string;
  /** Repo-scoped token the agent may use for git operations on its branch (never the deploy key). */
  githubToken: string | null;
}

interface StreamResult {
  sessionId: string;
  finalText: string;
  isError: boolean;
  sawResult: boolean;
  usdCents: number;
  numTurns: number | null;
}

/**
 * Runs Claude Code headless. Session id is ASSIGNED up front (`--session-id`) so it's crash-proof;
 * dev/review `--resume` it, and on resume failure (cwd drift / expiry / version quirk) it cold-starts
 * a fresh session with the plan+branch context (P0-2). `--allowedTools` is intentionally NOT passed
 * (it broke `--resume` on CLI 2.1.158) — blast radius is bounded by the worktree cwd, a repo-scoped
 * token, and branch protection on main. The spawn env is minimal (no prod secrets, no deploy key).
 */
export class ClaudeAgentRunner implements AgentRunner {
  readonly #cfg: ClaudeRunnerConfig;
  constructor(cfg: ClaudeRunnerConfig) {
    this.#cfg = cfg;
  }

  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    const result = await this.#invoke(args, args.resume);
    const resumeBroke = args.resume && !result.ok && /No conversation found|No deferred tool marker|session/i.test(result.error ?? "");
    if (resumeBroke) {
      const freshId = randomUUID();
      return this.#invoke({ ...args, sessionId: freshId, resume: false, prompt: args.coldStartPrompt ?? args.prompt }, false);
    }
    return result;
  }

  async #invoke(args: AgentRunArgs, resume: boolean): Promise<AgentRunResult> {
    const argv = ["-p", "--output-format", "stream-json", "--verbose"];
    if (resume) argv.push("--resume", args.sessionId);
    else argv.push("--session-id", args.sessionId);
    argv.push("--permission-mode", args.mode === "plan" ? "plan" : "acceptEdits");
    if (this.#cfg.model) argv.push("--model", this.#cfg.model);
    argv.push(args.prompt);

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ANTHROPIC_API_KEY: this.#cfg.anthropicApiKey,
    };
    if (this.#cfg.githubToken) {
      env.GH_TOKEN = this.#cfg.githubToken;
      env.GITHUB_TOKEN = this.#cfg.githubToken;
    }

    const logPath = this.#openLog(args);
    const parsed: StreamResult = { sessionId: args.sessionId, finalText: "", isError: false, sawResult: false, usdCents: 0, numTurns: null };

    const proc = await runProcess(this.#cfg.claudeBin, argv, {
      cwd: args.worktreePath,
      env,
      timeoutMs: this.#cfg.timeoutMs,
      onLine: (line) => {
        if (logPath) this.#appendLog(logPath, line);
        this.#consume(line, parsed);
      },
    });

    const ok = proc.code === 0 && !proc.timedOut && !parsed.isError && parsed.sawResult;
    return {
      ok,
      sessionId: parsed.sessionId,
      finalText: redactSecrets(parsed.finalText),
      usdCents: parsed.usdCents,
      numTurns: parsed.numTurns,
      exitCode: proc.code,
      timedOut: proc.timedOut,
      ...(ok ? {} : { error: redactSecrets((proc.stderr || parsed.finalText || "agent run failed").slice(-500)) }),
    };
  }

  #consume(line: string, out: StreamResult): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON partials
    }
    if (typeof evt.session_id === "string") out.sessionId = evt.session_id;
    if (evt.type === "result") {
      out.sawResult = true;
      out.isError = evt.is_error === true;
      if (typeof evt.result === "string") out.finalText = evt.result;
      if (typeof evt.total_cost_usd === "number") out.usdCents = Math.round(evt.total_cost_usd * 100);
      if (typeof evt.num_turns === "number") out.numTurns = evt.num_turns;
    }
  }

  #openLog(args: AgentRunArgs): string | null {
    if (!this.#cfg.logDir) return null;
    try {
      const dir = join(this.#cfg.logDir, args.taskId);
      mkdirSync(dir, { recursive: true });
      return join(dir, `${args.stage}-${args.sessionId}.jsonl`);
    } catch {
      return null;
    }
  }

  #appendLog(path: string, line: string): void {
    try {
      appendFileSync(path, `${redactSecrets(line)}\n`);
    } catch {
      // best-effort logging
    }
  }
}
