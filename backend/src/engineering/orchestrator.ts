import { randomUUID } from "node:crypto";
import type { EngStore, TransitionArgs, TransitionOutcome } from "../store/eng-store.ts";
import type { AcCheckItem, EngJob, EngTask, PrArtifact, ReviewComment, StageStatus } from "../domain/eng-task.ts";
import { effectsFor, shouldRetryAfterTestFailure } from "./state-machine.ts";
import { redactSecrets } from "../redact.ts";
import { renderAcCheckPrompt, renderAddressCommentsPrompt, renderBuildFixPrompt, renderColdStartPrompt, renderDevPrompt, renderFixPrompt, renderPlanJudgePrompt, renderPlanPrompt } from "./prompts.ts";
import type { AgentRunner, DeployerPort, DiffFile, GithubPort, TestOutcome, Tester, Workspace } from "./ports.ts";

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
  /** Prod URL the post-deploy verify stage smoke-checks (e.g. https://host/healthz). Null → skip the auto check. */
  verifyUrl: string | null;
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
        return this.#handleDevTest(job.taskId, this.#seedFix(job));
      case "create_pr":
        return this.#handleCreatePr(job.taskId);
      case "address_comments":
        return this.#handleAddressComments(job.taskId);
      case "merge":
        return this.#handleMerge(job.taskId, this.#mergeMethod(job));
      case "deploy":
        return this.#handleDeploy(job.taskId);
      case "verify":
        return this.#handleVerify(job.taskId);
      case "rollback":
        return this.#handleRollback(job.taskId);
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

  /** dev_test enqueued from a post-deploy CI/build failure carries `{ seedFix: true }` so the loop's
   *  first iteration is a BUILD-FIX (seeded with the CI error), not a re-implementation. */
  #seedFix(job: EngJob): boolean {
    if (!job.payload) return false;
    try {
      return (JSON.parse(job.payload) as { seedFix?: boolean }).seedFix === true;
    } catch {
      return false;
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
    const run = await agentRunner.run({ taskId, stage: "plan", sessionId, worktreePath: ws.path, mode: "plan", resume: false, prompt: renderPlanPrompt(task), model: task.claudeModel, onCancelRegistered: this.#onCancelRegistered(taskId) });
    this.#d.cancelRegistry?.delete(taskId);
    engStore.finishAgentRun(runId, {
      status: run.ok ? "succeeded" : "failed",
      finishedTs: now(),
      exitCode: run.exitCode,
      usdCents: run.usdCents,
      numTurns: run.numTurns,
      resultSummary: truncate(run.finalText, 200),
      sessionId: run.sessionId,
      logPath: run.logPath,
      ...(run.error ? { error: run.error } : {}),
    });
    if (run.sessionId !== sessionId) engStore.setClaudeSession(taskId, run.sessionId, now());
    engStore.addBudgetUsage(taskId, { usdCents: run.usdCents }, now());
    if (!run.ok) throw new Error(run.error ?? "plan run failed");

    const planArt = { text: redactSecrets(run.finalText), editedText: null, sessionId: run.sessionId, revision: task.artifacts.plan?.revision ?? 0, generatedTs: now(), approvedTs: null, approvedBy: null, qualityScore: null as number | null };
    engStore.setArtifact(taskId, { plan: planArt }, now());

    // Best-effort quality judge (LP-101): never throws, never blocks the advance.
    try {
      const score = await this.#runPlanJudge(planArt.text, task, ws.path);
      if (score != null) {
        engStore.setArtifact(taskId, { plan: { ...planArt, qualityScore: score } }, now());
      }
    } catch {
      // Advisory only; plan flow continues unchanged.
    }

    this.#advance(taskId, { stage: "plan", status: "completed_unapproved" });
  }

  async #handleDevTest(taskId: string, seedFix = false): Promise<void> {
    const { engStore, agentRunner, workspace, tester, now } = this.#d;
    const base = this.#require(taskId);
    const ws = await workspace.ensure(base);
    const branchLog = await workspace.branchLog(base);
    let sessionId = base.claudeSessionId ?? randomUUID();
    if (!base.claudeSessionId) engStore.setClaudeSession(taskId, sessionId, now());

    // Entered from a post-deploy CI/build failure (fix-forward): iteration 1 is a build-fix seeded
    // with the CI error, not a re-implementation. Later iterations fall back to the normal fix prompt.
    let lastTestSummary = seedFix ? base.artifacts.deploy?.ciError ?? "CI/build failed on main." : "";
    let first = !seedFix;
    let buildSeed = seedFix;
    for (;;) {
      this.#advance(taskId, { stage: "dev", status: "in_progress" });
      const budget = engStore.addBudgetUsage(taskId, { iterations: 1 }, now());
      const task = this.#require(taskId);
      const prompt = first ? renderDevPrompt(task) : buildSeed ? renderBuildFixPrompt(lastTestSummary) : renderFixPrompt(lastTestSummary);
      buildSeed = false;
      const runId = engStore.startAgentRun({ taskId, stage: "dev", sessionId, iteration: budget?.iterationsUsed ?? 0, startedTs: now() });
      const run = await agentRunner.run({ taskId, stage: "dev", sessionId, worktreePath: ws.path, mode: "execute", resume: true, prompt, coldStartPrompt: renderColdStartPrompt(task, branchLog), model: task.claudeModel, onCancelRegistered: this.#onCancelRegistered(taskId) });
      this.#d.cancelRegistry?.delete(taskId);
      engStore.finishAgentRun(runId, {
        status: run.ok ? "succeeded" : "failed",
        finishedTs: now(),
        exitCode: run.exitCode,
        usdCents: run.usdCents,
        numTurns: run.numTurns,
        resultSummary: truncate(run.finalText, 200),
        sessionId: run.sessionId,
        logPath: run.logPath,
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
        await this.#runAcCheck(this.#require(taskId), ws.path);
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
      model: task.claudeModel,
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
      logPath: run.logPath,
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
        { env: deployEnv, status: "deploying", startedTs: now(), finishedTs: null, commitSha: sha, runUrl: null, ci: null, cd: null, failureKind: null, ciError: null, logTail: "waiting for GitHub Actions deploy run" },
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
      { env: deployEnv, status: out.ok ? "deployed" : "failed", startedTs: now(), finishedTs: now(), commitSha: out.sha, runUrl: null, ci: null, cd: null, failureKind: out.ok ? null : "cd_infra", ciError: null, logTail: out.logTail ? redactSecrets(out.logTail) : null },
      now(),
    );
    this.#advance(taskId, { stage: "deploy", status: out.ok ? "deployed" : "failed" });
  }

  /** Post-deploy verify (stage 8): smoke-check prod + bundle what shipped, then wait for human sign-off. */
  async #handleVerify(taskId: string): Promise<void> {
    const { engStore, verifyUrl, now } = this.#d;
    this.#advance(taskId, { stage: "verify", status: "in_progress" });
    const task = this.#require(taskId);
    const deployedSha = task.artifacts.deploy?.commitSha ?? task.artifacts.merge?.commitSha ?? null;
    const changeSummary = truncate(task.artifacts.pr?.title ?? task.artifacts.dev?.summary ?? task.title, 140);
    const runUrl = task.artifacts.deploy?.runUrl ?? null;

    const checks: { name: string; ok: boolean; detail: string | null }[] = [];
    let healthOk = true;
    let output: string | null = null;
    if (verifyUrl) {
      try {
        const res = await fetch(verifyUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
        healthOk = res.ok;
        checks.push({ name: "health", ok: res.ok, detail: `HTTP ${res.status}` });
        output = `GET ${verifyUrl} → ${res.status}`;
      } catch (err) {
        healthOk = false;
        const msg = err instanceof Error ? err.message : "request failed";
        checks.push({ name: "health", ok: false, detail: msg });
        output = redactSecrets(`GET ${verifyUrl} failed: ${msg}`);
      }
    } else {
      checks.push({ name: "health", ok: true, detail: "no verify URL configured — confirm manually" });
    }

    engStore.setArtifact(taskId, { verify: { deployedSha, changeSummary, healthOk, checks, output, runUrl, verifiedBy: null, verifiedTs: null } }, now());
    this.#advance(taskId, { stage: "verify", status: healthOk ? "awaiting_review" : "failed" });
  }

  /** Rollback (stage 9): revert the merge on a fresh branch, open + merge a revert PR → CD redeploys the good state. */
  async #handleRollback(taskId: string): Promise<void> {
    const { engStore, workspace, github, now } = this.#d;
    if (!github) throw new Error("GitHub not configured");
    const task = this.#require(taskId);
    const targetSha = task.artifacts.merge?.commitSha ?? null;
    if (!targetSha) throw new Error("no merge commit to roll back");

    const revert = await workspace.revert(task, targetSha);
    const title = `Rollback ${task.jiraKey}: revert ${truncate(task.title, 60)}`;
    const body = `Auto-rollback of ${task.jiraKey}. Reverts ${targetSha} and redeploys the previous good state.${task.jiraUrl ? `\n\n${task.jiraUrl}` : ""}`;
    const existing = await github.findOpenPr(task.repo, revert.branch);
    const pr = existing ?? (await github.createPr({ repo: task.repo, head: revert.branch, base: task.defaultBranch, title, body }));
    const state = await github.getPr(task.repo, pr.number);
    let mergeSha: string | null = state.merged ? null : null;
    if (!state.merged) {
      const merged = await github.merge(task.repo, pr.number, "squash");
      mergeSha = merged.sha;
    }
    engStore.setArtifact(
      taskId,
      {
        rollback: {
          targetSha,
          revertSha: revert.revertSha,
          prUrl: pr.url,
          status: "rolled_back",
          startedTs: task.artifacts.rollback?.startedTs ?? now(),
          finishedTs: now(),
          triggeredBy: task.artifacts.rollback?.triggeredBy ?? null,
          logTail: mergeSha ? `reverted ${targetSha} via #${pr.number} (${mergeSha})` : `revert #${pr.number} already merged`,
        },
      },
      now(),
    );
    this.#advance(taskId, { stage: "rollback", status: "rolled_back" });
  }

  #branchUrl(task: EngTask, branch: string): string | null {
    return task.repo ? `https://github.com/${task.repo}/tree/${branch}` : null;
  }

  /**
   * LP-101: Fresh Haiku judge call that scores the plan on coverage / localization / scope-fit.
   * Returns a clamped [0,1] score, or null when the run fails or the response is not parseable.
   * The caller wraps this in try/catch so any exception also degrades gracefully.
   */
  async #runPlanJudge(planText: string, task: EngTask, worktreePath: string): Promise<number | null> {
    const { agentRunner, engStore, now } = this.#d;
    const sessionId = randomUUID();
    const runId = engStore.startAgentRun({ taskId: task.id, stage: "plan", sessionId, iteration: 0, startedTs: now() });

    let run: Awaited<ReturnType<AgentRunner["run"]>>;
    try {
      run = await agentRunner.run({
        taskId: task.id,
        stage: "plan",
        sessionId,
        worktreePath,
        mode: "plan",
        resume: false,
        prompt: renderPlanJudgePrompt(planText, task),
        model: "claude-haiku-4-5-20251001",
      });
    } catch (err) {
      engStore.finishAgentRun(runId, { status: "failed", finishedTs: now(), error: String(err) });
      return null;
    }

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
    engStore.addBudgetUsage(task.id, { usdCents: run.usdCents }, now());

    if (!run.ok || !run.finalText) return null;

    try {
      const parsed = JSON.parse(run.finalText.trim()) as { score?: unknown };
      const score = Number(parsed.score);
      if (!Number.isFinite(score)) return null;
      return Math.max(0, Math.min(1, score));
    } catch {
      return null;
    }
  }

  /**
   * LP-33: Fresh AC-check agent run seeded with the branch diff + acceptance criteria.
   * Never throws — all errors are caught so pr:proposed always advances.
   * Bills iterations + usdCents to the task budget; redacts all evidence strings.
   */
  async #runAcCheck(task: EngTask, worktreePath: string): Promise<void> {
    const { engStore, agentRunner, github, now } = this.#d;

    let diff: DiffFile[] = [];
    if (github) {
      try {
        diff = await github.getDiff(task.repo, { base: task.defaultBranch, head: task.branch ?? "HEAD" });
      } catch {
        // Network/GitHub error — proceed with empty diff.
      }
    }

    engStore.addBudgetUsage(task.id, { iterations: 1 }, now());

    const sessionId = randomUUID(); // always fresh — never resume; task claudeSessionId is NOT updated
    const runId = engStore.startAgentRun({ taskId: task.id, stage: "pr", sessionId, iteration: 0, startedTs: now() });

    let run: Awaited<ReturnType<AgentRunner["run"]>>;
    try {
      run = await agentRunner.run({
        taskId: task.id,
        stage: "pr",
        sessionId,
        worktreePath,
        mode: "execute",
        resume: false,
        prompt: renderAcCheckPrompt(task, diff),
        model: task.claudeModel,
      });
    } catch (err) {
      engStore.finishAgentRun(runId, { status: "failed", finishedTs: now(), error: String(err) });
      return;
    }

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
    engStore.addBudgetUsage(task.id, { usdCents: run.usdCents }, now());

    let items: AcCheckItem[] = [];
    if (run.ok && run.finalText) {
      try {
        const raw = JSON.parse(run.finalText.trim()) as unknown;
        if (Array.isArray(raw)) {
          items = raw
            .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
            .map((x) => ({
              criterion: typeof x.criterion === "string" ? x.criterion : String(x.criterion ?? ""),
              pass: x.pass === true,
              evidence: redactSecrets(typeof x.evidence === "string" ? x.evidence : String(x.evidence ?? "")),
            }));
        }
      } catch {
        // Malformed JSON — store [] rather than crashing or blocking.
      }
    }

    engStore.setArtifact(task.id, { acCheck: items }, now());
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
