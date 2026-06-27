import { spawn } from "node:child_process";

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpawnOpts {
  cwd?: string;
  /** Explicit, minimal env (NOT merged with process.env) — blast-radius control for agent runs. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Written to stdin then closed (e.g. piping a script to `bash -s`). */
  input?: string;
  /** Called per stdout line (for NDJSON streaming). */
  onLine?: (line: string) => void;
}

/**
 * Run a child process to completion, capturing stdout/stderr. Argv is an array (never a shell
 * string) — no injection. SIGTERM → SIGKILL on timeout. Used for `claude`, `git`, `gh`, `ssh`.
 */
export function runProcess(cmd: string, args: readonly string[], opts: SpawnOpts = {}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let buffer = "";

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stdout += text;
      if (opts.onLine) {
        buffer += text;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          opts.onLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (opts.onLine && buffer.length > 0) opts.onLine(buffer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}
