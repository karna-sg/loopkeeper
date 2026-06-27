import { redactSecrets } from "../../redact.ts";
import type { DeployerPort, DeployOutcome } from "../ports.ts";
import { runProcess } from "./spawn.ts";

export interface SshDeployerConfig {
  host: string;
  user: string;
  keyPath: string;
  timeoutMs: number;
}

/**
 * Parse the redeploy script's final status line. The script (run via an SSH forced command) prints
 * `REDEPLOY_OK <sha>` or `REDEPLOY_FAIL <reason>`. Pure + unit-tested.
 */
export function parseRedeployOutput(output: string): { ok: boolean; sha: string | null } {
  const ok = output.match(/REDEPLOY_OK\s+(\S+)/);
  if (ok?.[1]) return { ok: true, sha: ok[1] };
  if (/REDEPLOY_FAIL/.test(output)) return { ok: false, sha: null };
  return { ok: false, sha: null };
}

/**
 * Triggers the prod redeploy over SSH. The host's `authorized_keys` pins this key to a forced
 * command (`redeploy.sh`), so the client command is ignored — blast radius is "redeploy the merged
 * main", nothing else. Worker-owned (the api never tears itself down).
 */
export class SshDeployer implements DeployerPort {
  readonly #cfg: SshDeployerConfig;
  constructor(cfg: SshDeployerConfig) {
    this.#cfg = cfg;
  }

  async redeploy(): Promise<DeployOutcome> {
    const res = await runProcess(
      "ssh",
      ["-i", this.#cfg.keyPath, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", `${this.#cfg.user}@${this.#cfg.host}`],
      { timeoutMs: this.#cfg.timeoutMs },
    );
    const combined = `${res.stdout}\n${res.stderr}`;
    const parsed = parseRedeployOutput(combined);
    return {
      ok: parsed.ok && res.code === 0 && !res.timedOut,
      sha: parsed.sha,
      logTail: redactSecrets(combined.slice(-1500)),
    };
  }
}
