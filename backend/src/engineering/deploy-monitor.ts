import type { EngStore } from "../store/eng-store.ts";
import type { DeployRun, GithubPort } from "./ports.ts";
import { applyTransition } from "./orchestrator.ts";

/** Map a GitHub Actions deploy run to our deploy-stage status. A null run = not started yet → still deploying. */
export function deployStatusFromRun(run: DeployRun | null): "deploying" | "deployed" | "failed" {
  if (!run) return "deploying";
  if (run.status !== "completed") return "deploying"; // queued | in_progress
  return run.conclusion === "success" ? "deployed" : "failed";
}

/** Pull the conclusion of the job whose name matches a role (CI = verify/test/build, CD = deploy/release). */
export function jobConclusion(run: DeployRun | null, re: RegExp): string | null {
  return run?.jobs.find((j) => re.test(j.name))?.conclusion ?? null;
}

const CI_RE = /verify|\bci\b|test|build/i;
const CD_RE = /deploy|\bcd\b|release/i;

/**
 * Observes the GitHub Actions CD run for each task in `deploy:deploying` and finalizes the stage
 * (FR-24). LoopKeeper does NOT deploy — GitHub Actions does (on push to main); this polls the run for
 * the merge commit and maps it to `deployed` / `failed`, surfacing CI + CD job results, the run URL,
 * and a status note. Idempotent + self-healing (survives the api restart caused by the deploy itself).
 * Runs as an api-side scheduler job, mirroring `PrMonitor`.
 */
export class DeployMonitor {
  readonly #engStore: EngStore;
  readonly #github: GithubPort;
  readonly #now: () => string;
  readonly #timeoutMs: number;

  constructor(engStore: EngStore, github: GithubPort, now: () => string, timeoutMs: number) {
    this.#engStore = engStore;
    this.#github = github;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  async run(): Promise<{ checked: number }> {
    const tasks = this.#engStore.list().filter((t) => t.stage === "deploy" && t.status === "deploying");
    for (const task of tasks) {
      const sha = task.artifacts.merge?.commitSha ?? task.artifacts.deploy?.commitSha ?? null;
      if (!sha) continue;
      const run = await this.#github.getDeployRun(task.repo, sha);
      const now = this.#now();
      let status = deployStatusFromRun(run);

      // Timeout guard: if it never completes (no run appears, or stuck), fail rather than spin forever.
      const startedTs = task.artifacts.deploy?.startedTs ?? null;
      const timedOut = startedTs !== null && Date.parse(now) - Date.parse(startedTs) > this.#timeoutMs;
      if (status === "deploying" && timedOut) status = "failed";

      const note = status === "failed" && timedOut && !run ? "no deploy run found within timeout" : task.artifacts.deploy?.logTail ?? null;
      this.#engStore.setDeployArtifact(
        task.id,
        {
          env: task.artifacts.deploy?.env ?? "prod",
          status,
          startedTs: startedTs ?? now,
          finishedTs: status === "deploying" ? null : now,
          commitSha: sha,
          runUrl: run?.htmlUrl ?? task.artifacts.deploy?.runUrl ?? null,
          ci: jobConclusion(run, CI_RE),
          cd: jobConclusion(run, CD_RE),
          logTail: note,
        },
        now,
      );

      if (status === "deployed") applyTransition(this.#engStore, { taskId: task.id, to: { stage: "deploy", status: "deployed" }, actor: "system", ts: now }, now);
      else if (status === "failed") applyTransition(this.#engStore, { taskId: task.id, to: { stage: "deploy", status: "failed" }, actor: "system", ts: now }, now);
    }
    return { checked: tasks.length };
  }
}
