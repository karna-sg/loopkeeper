import { randomUUID } from "node:crypto";
import type { EngStore, TransitionArgs, TransitionOutcome } from "../store/eng-store.ts";
import type { EngJob, EngTask, PrArtifact, ReviewComment, StageStatus } from "../domain/eng-task.ts";
import { effectsFor, shouldRetryAfterTestFailure } from "./state-machine.ts";
import { redactSecrets } from "../redact.ts";
import { renderAddressCommentsPrompt, renderColdStartPrompt, renderDevPrompt, renderFixPrompt, renderPlanPrompt } from "./prompts.ts";
import type { AgentRunner, DeployerPort, GithubPort, TestOutcome, Tester, Workspace } from "./ports.ts";

export interface OrchestratorDeps {
  engStore: EngStore;
  agentRunner: AgentRunner;
  workspace: Workspace;
  tester: Tester;
  github: GithubPort | null;
  deployer: DeployerPort | null;
  deployEnabled: boolean;
  /** `github-actions` = CD runs in GH Actions and the deploy-status job observes it; `ssh` = legacy worker redeploy. */
  deployMode: "github-actions" | "ssh";
  deployEnv: string;
  now: () => string;
  /** Shared map; the orchestrator registers kill callbacks here so the worker cancel-watcher can signal them. */
  cancelRegistry?: Map<string, () => void>;
}

/**
 * Transition a task AND fire the resulting effects (enqueue follow-on jobs). The single path used
 * by both the gate routes (human approvals) and the orchestrator (system advances), so the lifecycle
 * flows consistently. Notify effects are handled out-of-band by the `eng-notify` scheduler job.
 */
export function applyTransition(engStore: EngStore, args: TransitionArgs, now: string): TransitionOutcome {
  const outcome = engStore.transition(args);
  if (outcome.ok && outcome.changed) {
    for (const eff of effectsFor(args.to)) {
      if (eff.kind === "enqueue_job") {
        engStore.enqueue({ taskId: args.taskId, kind: eff.job, dedupeKey: `${args.taskId}:${eff.job}` }, now);
      }
    }
  }
  return outcome;
}

function truncate(s: string, n = 72): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

/**
 * Runs one queued job to completion, advancing the task through its stages. Pure orchestration over
 * the ports — no direct git/claude/github/ssh calls — so the whole lifecycle is unit-tested with
 * fakes. A thrown error bubbles to the worker, which escalates the task to `blocked`.
 */
export class Orchestrator {
  readonly #d: OrchestratorDeps;
  constructor(deps: OrchestratorDeps) {
    this.#d = deps;
  }

  async runJob(job: EngJob): Promise<void> {
    switch (job.kind) {
      case "plan":
        return this.#handlePlan(job.taskId);
      case "dev_test":
        return this.#handleDevTest(job.taskId);
      case "create_pr":
        return this.#handleCreatePr(job.taskId);
      case "address_comments":
        return this.#handleAddressComments(job.taskId);
      case "merge":
        return this.#handleMerge(job.taskId, this.#mergeMethod(job));
      case "deploy":
        return this.#handleDeploy(job.taskId);
    }
  }

  /** Escalate a stuck task to `blocked` (called by the worker when a job throws). */
  escalate(taskId: string, reason: string): void {
    const task = this.#d.engStore.get(taskId);
    if (!task) return;
    const now = this.#d.now();
    this.#d.engStore.setProgress(taskId, { lastError: redactSecrets(reason) }, now);
    applyTransition(this.#d.engStore, { taskId, to: { stage: task.stage, status: "blocked" }, actor: "system", note: truncate(reason), ts: now }, now);
  }

  /** Returns an `onCancelRegistered` callback that stores the kill fn in the shared registry. */
  #onCancelRegistered(taskId: string): ((kill: () => void) => void) | undefined {
    const registry = this.#d.cancelRegistry;
    if (!registry) return undefined;
    return (kill) => registry.set(taskId, kill);
  }

  #require(taskId: string): EngTask {
    const task = this.#d.engStore.get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    return task;
  }

  #advance(taskId: string, to: StageStatus, note?: string): void {
    const now = this.#d.now();
    applyTransition(this.#d.engStore, { taskId, to, actor: "system", ...(note ? { note } : {}), ts: now }, now);
  }

  #mergeMethod(job: EngJob): "merge" | "squash" | "rebase" {
    if (!job.payload) return "squash";
    try {
      const p = JSON.parse(job.payload) as { method?: string };
      return p.method === "merge" || p.method === "rebase" ? p.method : "squash";
    } catch {
      return "squash";
    }
  }

  async #handlePlan(taskId: string): Promise<void> {
    const { engStore, agentRunner, workspace, now } = this.#d;
    let task = this.#require(taskId);
    const ws = await workspace.ensure(task);
    engStore.setBranchAndWorktree(taskId, ws.branch, ws.path, now());
    // A plan (or re-plan via revise) always starts a FRESH Claude session — reusing an existing id
    // with `--session-id` collides. Dev/review later resume THIS session.
    const sessionId = randomUUID();
    engStore.setClaudeSession(taskId, sessionId, now());
    task = this.#require(taskId);

    const runId = engStore.startAgentRun({ taskId, stage: "plan", sessionId, iteration: 0, startedTs: now() });
    const run = await agentRunner.run({ taskId, stage: "plan", sessionId, worktreePath: ws.path, mode: "plan", resume: false, prompt: renderPlanPrompt(task), onCancelRegistered: this.#onCancelRegistered(taskId) });
    this.#d.cancelRegistry?.delete(taskId);
    engStore.finishAgentRun(runId, {
      status: run.ok ? "succeeded" : "failed",
      finishedTs: now(),
      exitCode: run.exitCode,
      usdCents: run.usdCents,
      numTurns: run.numTurns,
      resultSummary: truncate(run.finalText, 200),
      sessionId: run.sessionId,
      ...(run.error ? { error: run.error } : {}),
    });
    if (run.sessionId !== sessionId) engStore.setClaudeSession(taskId, run.sessionId, now());
    engStore.addBudgetUsage(taskId, { usdCents: run.usdCents }, now());
    if (!run.ok) throw new Error(run.error ?? "plan run failed");

    engStore.setArtifact(
      taskId,
      { plan: { text: redactSecrets(run.finalText), editedText: null, sessionId: run.sessionId, revision: task.artifacts.plan?.revision ?? 0, generatedTs: now(), approvedTs: null, approvedBy: null } },
      now(),
    );
    this.#advance(taskId, { stage: "plan", status: "completed_unapproved" });
  }

  async #handleDevTest(taskId: string): Promise<void> {
    const { engStore, agentRunner, workspace, tester, now } = this.#d;
    const base = this.#require(taskId);
    const ws = await workspace.ensure(base);
    const branchLog = await workspace.branchLog(base);
    let sessionId = base.claudeSessionId ?? randomUUID();
    if (!base.claudeSessionId) engStore.setClaudeSession(taskId, sessionId, now());

    let lastTestSummary = "";
    let first = true;
    for (;;) {
      this.#advance(taskId, { stage: "dev", status: "in_progress" });
      const budget = engStore.addBudgetUsage(taskId, { iterations: 1 }, now());
      const task = this.#require(taskId);
      const prompt = first ? renderDevPrompt(task) : renderFixPrompt(lastTestSummary);
      const runId = engStore.startAgentRun({ taskId, stage: "dev", sessionId, iteration: budget?.iterationsUsed ?? 0, startedTs: now() });
      const run = await agentRunner.run({ taskId, stage: "dev", sessionId, worktreePath: ws.path, mode: "execute", resume: true, prompt, coldStartPrompt: renderColdStartPrompt(task, branchLog), onCancelRegistered: this.#onCancelRegistered(taskId) });
      this.#d.cancelRegistry?.delete(taskId);
      engStore.finishAgentRun(runId, {
        status: run.ok ? "succeeded" : "failed",
        finishedTs: now(),
        exitCode: run.exitCode,
        usdCents: run.usdCents,
        numTurns: run.numTurns,
        resultSummary: truncate(run.finalText, 200),
        sessionId: run.sessionId,
        ...(run.error ? { error: run.error } : {}),
      });
      if (run.sessionId !== sessionId) {
        sessionId = run.sessionId;
        engStore.setClaudeSession(taskId, sessionId, now());
      }
      const budget2 = engStore.addBudgetUsage(taskId, { usdCents: run.usdCents }, now());
      if (!run.ok) throw new Error(run.error ?? "dev run failed");

      const commit = await workspace.commitAndPush(task, `${task.jiraKey}: ${task.title}`);
      engStore.setArtifact(
        taskId,
        { dev: { summary: redactSecrets(run.finalText), branch: ws.branch, branchURL: this.#branchUrl(task, ws.branch), filesChanged: commit.filesChanged, iterations: budget?.iterationsUsed ?? 0, lastIterationTs: now() } },
        now(),
      );
      this.#advance(taskId, { stage: "dev", status: "done" });
      this.#advance(taskId, { stage: "test", status: "in_progress" });

      const result = await tester.run(ws.path);
      const prevRuns = this.#require(taskId).artifacts.test?.runs ?? [];
      engStore.setArtifact(
        taskId,
        { test: { runs: [...prevRuns, { ts: now(), passed: result.passed, total: result.total, failed: result.failed, summary: redactSecrets(result.summary) }], lastPassed: result.passed } },
        now(),
      );

      if (result.passed) {
        this.#advance(taskId, { stage: "test", status: "passed" });
        engStore.setArtifact(taskId, { pr: this.#proposePr(this.#require(taskId), result, commit.files) }, now());
        this.#advance(taskId, { stage: "pr", status: "proposed" });
        return;
      }

      this.#advance(taskId, { stage: "test", status: "failed" });
      lastTestSummary = result.summary;
      first = false;
      if (!budget2 || !shouldRetryAfterTestFailure(budget2)) {
        engStore.setProgress(taskId, { lastError: "tests failing; iteration/budget cap reached" }, now());
        this.#advance(taskId, { stage: "test", status: "blocked" }, "budget exhausted");
        return;
      }
    }
  }

  async #handleCreatePr(taskId: string): Promise<void> {
    const { engStore, workspace, github, now } = this.#d;
    if (!github) throw new Error("GitHub not configured");
    const task = this.#require(taskId);
    const ws = await workspace.ensure(task);
    await workspace.commitAndPush(task, `${task.jiraKey}: ${task.title}`);
    const proposed = task.artifacts.pr;
    const title = proposed?.title ?? `${task.jiraKey}: ${task.title}`;
    const body = proposed?.body ?? `${task.jiraUrl}`;
    const existing = await github.findOpenPr(task.repo, ws.branch);
    const pr = existing ?? (await github.createPr({ repo: task.repo, head: ws.branch, base: task.defaultBranch, title, body }));
    const artifact: PrArtifact = {
      title,
      body,
      diffSummary: proposed?.diffSummary ?? "",
      url: pr.url,
      number: pr.number,
      proposedTs: proposed?.proposedTs ?? now(),
      createdTs: now(),
      approvedBy: proposed?.approvedBy ?? null,
    };
    engStore.setArtifact(taskId, { pr: artifact }, now());
    this.#advance(taskId, { stage: "pr", status: "created" });
    this.#advance(taskId, { stage: "review", status: "awaiting_review" });
  }

  async #handleAddressComments(taskId: string): Promise<void> {
    const { engStore, agentRunner, workspace, now } = this.#d;
    const task = this.#require(taskId);
    const ws = await workspace.ensure(task);
    const sessionId = task.claudeSessionId ?? randomUUID();
    const comments = task.artifacts.review?.comments ?? [];
    engStore.addBudgetUsage(taskId, { reviewRounds: 1 }, now());

    const runId = engStore.startAgentRun({ taskId, stage: "review", sessionId, iteration: task.artifacts.review?.rounds ?? 0, startedTs: now() });
    const run = await agentRunner.run({
      taskId,
      stage: "review",
      sessionId,
      worktreePath: ws.path,
      mode: "execute",
      resume: true,
      prompt: renderAddressCommentsPrompt(comments),
      coldStartPrompt: renderColdStartPrompt(task, await workspace.branchLog(task)),
      onCancelRegistered: this.#onCancelRegistered(taskId),
    });
    this.#d.cancelRegistry?.delete(taskId);
    engStore.finishAgentRun(runId, {
      status: run.ok ? "succeeded" : "failed",
      finishedTs: now(),
      exitCode: run.exitCode,
      usdCents: run.usdCents,
      numTurns: run.numTurns,
      resultSummary: truncate(run.finalText, 200),
      sessionId: run.sessionId,
      ...(run.error ? { error: run.error } : {}),
    });
    if (run.sessionId !== sessionId) engStore.setClaudeSession(taskId, run.sessionId, now());
    engStore.addBudgetUsage(taskId, { usdCents: run.usdCents }, now());
    if (!run.ok) throw new Error(run.error ?? "address-comments run failed");

    const commit = await workspace.commitAndPush(task, `${task.jiraKey}: address review comments`);
    const resolved: ReviewComment[] = comments.map((c) => (c.resolution ? c : { ...c, resolution: redactSecrets(truncate(run.finalText, 120)), resolvedTs: now(), resolvedCommitSha: commit.sha }));
    engStore.setArtifact(taskId, { review: { comments: resolved, approved: task.artifacts.review?.approved ?? false, rounds: (task.artifacts.review?.rounds ?? 0) + 1 } }, now());
    this.#advance(taskId, { stage: "review", status: "comments_addressed" });
    this.#advance(taskId, { stage: "review", status: "awaiting_review" });
  }

  async #handleMerge(taskId: string, method: "merge" | "squash" | "rebase"): Promise<void> {
    const { engStore, github, now } = this.#d;
    if (!github) throw new Error("GitHub not configured");
    const task = this.#require(taskId);
    const num = task.artifacts.pr?.number;
    if (!num) throw new Error("no PR number to merge");
    const state = await github.getPr(task.repo, num);
    let sha = task.artifacts.merge?.commitSha ?? null;
    if (!state.merged) {
      const r = await github.merge(task.repo, num, method);
      sha = r.sha;
    }
    engStore.setArtifact(taskId, { merge: { commitSha: sha, mergedTs: now(), mergedBy: task.artifacts.merge?.mergedBy ?? null, method } }, now());
    this.#advance(taskId, { stage: "merge", status: "merged" });
  }

  async #handleDeploy(taskId: string): Promise<void> {
    const { engStore, deployer, deployEnabled, deployMode, deployEnv, now } = this.#d;
    if (!deployEnabled) return; // deploy disabled — leave at merge:merged (manual deploy)

    if (deployMode === "github-actions") {
      // CD is owned by GitHub Actions (triggered by the merge → push to main). We only OBSERVE:
      // record the merge commit + mark deploying; the `deploy-status` scheduler polls the GH run and
      // finalizes deployed/failed. No SSH, no deploy key on the worker.
      const sha = this.#require(taskId).artifacts.merge?.commitSha ?? null;
      this.#advance(taskId, { stage: "deploy", status: "deploying" });
      engStore.setDeployArtifact(
        taskId,
        { env: deployEnv, status: "deploying", startedTs: now(), finishedTs: null, commitSha: sha, runUrl: null, ci: null, cd: null, logTail: "waiting for GitHub Actions deploy run" },
        now(),
      );
      return;
    }

    // Legacy ssh mode: the worker triggers the redeploy directly.
    if (!deployer) return;
    this.#advance(taskId, { stage: "deploy", status: "deploying" });
    const out = await deployer.redeploy();
    engStore.setDeployArtifact(
      taskId,
      { env: deployEnv, status: out.ok ? "deployed" : "failed", startedTs: now(), finishedTs: now(), commitSha: out.sha, runUrl: null, ci: null, cd: null, logTail: out.logTail ? redactSecrets(out.logTail) : null },
      now(),
    );
    this.#advance(taskId, { stage: "deploy", status: out.ok ? "deployed" : "failed" });
  }

  #branchUrl(task: EngTask, branch: string): string | null {
    return task.repo ? `https://github.com/${task.repo}/tree/${branch}` : null;
  }

  /** Build a clean, GitHub-rendered PR body: real summary, changed-file list, a one-line test result,
   *  and the plan tucked in a collapsible section. No raw agent ramble or ANSI dumps. */
  #proposePr(task: EngTask, test: TestOutcome, files: readonly string[]): PrArtifact {
    const plan = task.artifacts.plan?.editedText ?? task.artifacts.plan?.text ?? "";
    const fileList = files.length > 0 ? files.map((f) => `- \`${f}\``).join("\n") : `_${files.length} files changed_`;
    const testLine = test.passed
      ? `✅ ${test.total ?? "all"} tests passed`
      : `❌ ${test.failed ?? "?"}${test.total ? ` of ${test.total}` : ""} tests failing`;
    const body = [
      `Implements **${task.jiraKey}** — ${task.title}.`,
      task.jiraUrl ? `\n\n${task.jiraUrl}` : "",
      `\n\n## Changes\n${fileList}`,
      `\n\n## Tests\n${testLine}`,
      task.acceptanceCriteria ? `\n\n## Acceptance criteria\n${redactSecrets(task.acceptanceCriteria)}` : "",
      plan ? `\n\n<details>\n<summary>Implementation plan</summary>\n\n${redactSecrets(plan)}\n\n</details>` : "",
      `\n\n---\n🤖 Generated by LoopKeeper`,
    ].join("");
    return {
      title: `${task.jiraKey}: ${task.title}`,
      body,
      diffSummary: `${files.length} file${files.length === 1 ? "" : "s"} changed`,
      url: null,
      number: null,
      proposedTs: this.#d.now(),
      createdTs: null,
      approvedBy: null,
    };
  }
}
