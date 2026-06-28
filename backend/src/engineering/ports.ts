/**
 * The orchestrator's "ports" — the external effects it depends on, behind interfaces so the whole
 * stage machine (budget caps, escalation, gate enforcement, lifecycle advancement) is unit-testable
 * with fakes (mirrors the existing `FakePushSender` / `fake-source.ts` pattern). The real adapters
 * (Claude Code, git, GitHub REST, SSH deploy) implement these; tests substitute scripted fakes.
 */
import type { EngTask, ReviewComment, Stage } from "../domain/eng-task.ts";

export interface AgentRunResult {
  ok: boolean;
  /** The session id the run used (assigned, or a fresh one on cold-start). */
  sessionId: string;
  /** Final assistant text — the plan (plan stage) or change summary (execute stage). Redacted. */
  finalText: string;
  usdCents: number;
  numTurns: number | null;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export interface AgentRunArgs {
  taskId: string;
  stage: Stage;
  /** Assigned up front (deterministic, crash-proof). The runner cold-starts if resume fails. */
  sessionId: string;
  /** Immutable cwd for the task's whole life — the Claude-session anchor. */
  worktreePath: string;
  mode: "plan" | "execute";
  /** Whether to attempt `--resume` (false on the first plan run). */
  resume: boolean;
  prompt: string;
  /** Fallback prompt (approved plan + branch state) used when `--resume` fails (cold-start, P0-2). */
  coldStartPrompt?: string;
  /**
   * Called once the Claude process is spawned, with a function that kills its process group.
   * The orchestrator registers this in the cancel registry so the worker can kill on demand.
   */
  onCancelRegistered?: (kill: () => void) => void;
}

export interface AgentRunner {
  run(args: AgentRunArgs): Promise<AgentRunResult>;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface CommitResult {
  sha: string | null;
  pushed: boolean;
  filesChanged: number;
  /** Paths of the changed files (for a clean PR body). */
  files: string[];
}

/** Per-task git worktree lifecycle (one mirror clone + a worktree per task branch). */
export interface Workspace {
  /** Create (or reuse) the task's branch + worktree. Idempotent. */
  ensure(task: EngTask): Promise<WorktreeInfo>;
  /** Commit any changes and push the branch. Idempotent (push -u is safe to repeat). */
  commitAndPush(task: EngTask, message: string): Promise<CommitResult>;
  /** Short summary of commits on the branch (for cold-start prompts). */
  branchLog(task: EngTask): Promise<string>;
  /** Create a revert of `sha` on a fresh `rollback/*` branch off the default branch + push it (rollback). */
  revert(task: EngTask, sha: string): Promise<{ revertSha: string; branch: string }>;
  remove(task: EngTask): Promise<void>;
}

export interface TestOutcome {
  passed: boolean;
  total: number | null;
  failed: number | null;
  /** Redacted tail of the test output. */
  summary: string;
}

/** Runs the repo's unit tests deterministically (by exit code), not via the agent. */
export interface Tester {
  run(worktreePath: string): Promise<TestOutcome>;
}

export interface PullRequest {
  number: number;
  url: string;
}

export interface PrState {
  number: number;
  url: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  merged: boolean;
  comments: ReviewComment[];
}

/** A GitHub Actions run observed for the deploy stage (CD). Status/conclusion mirror the Actions API. */
export interface DeployRun {
  /** Run status: `queued` | `in_progress` | `completed`. */
  status: string;
  /** Set once completed: `success` | `failure` | `cancelled` | `timed_out` | `skipped` | `null`. */
  conclusion: string | null;
  htmlUrl: string | null;
  /** Per-job status — typically the `verify` (CI) and `deploy` (CD) jobs of the run. */
  jobs: { name: string; status: string; conclusion: string | null }[];
}

/** GitHub REST operations (backend-initiated: create / poll / merge / observe CD). Reconcile-before-act. */
export interface GithubPort {
  findOpenPr(repo: string, head: string): Promise<PullRequest | null>;
  createPr(args: { repo: string; head: string; base: string; title: string; body: string }): Promise<PullRequest>;
  getPr(repo: string, num: number): Promise<PrState>;
  merge(repo: string, num: number, method: "merge" | "squash" | "rebase"): Promise<{ sha: string; merged: boolean }>;
  /** Latest GitHub Actions deploy run for a commit (CD observation). `null` if no run exists yet. */
  getDeployRun(repo: string, sha: string): Promise<DeployRun | null>;
}

export interface DeployOutcome {
  ok: boolean;
  sha: string | null;
  /** Redacted redeploy log tail. */
  logTail: string | null;
}

/** Triggers the SSH redeploy on the prod host (worker-owned). */
export interface DeployerPort {
  redeploy(): Promise<DeployOutcome>;
}
