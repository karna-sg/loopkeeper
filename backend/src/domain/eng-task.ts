/**
 * The `eng_task` — Loopkeeper Phase 2's core primitive for the engineering pipeline.
 *
 * A Jira issue assigned to the user, tracked through a 7-stage lifecycle
 * (plan → dev → test → pr → review → merge → deploy) driven by Claude Code on a cloud
 * machine, with three mandatory human approval gates (plan, PR creation, merge).
 *
 * Jira owns the task *metadata* (summary/description/AC/status); the orchestration layer
 * owns everything in here (stage state, Claude session, per-stage artifacts, budgets) in a
 * separate database (`eng.db`). Engineering state is NEVER written back to Jira.
 *
 * Strict-TS house rules: literal unions via `as const` (no `enum`), no `any`. This file is the
 * single frozen wire contract — the backend SQLite columns, the JSON the iOS app decodes, and
 * the pure state machine all agree on these exact tokens (PRD §7.1 wording).
 */

import { createHash } from "node:crypto";

/** The lifecycle stages, in order (PRD §7.1 + post-deploy verify/rollback). */
export const STAGES = ["plan", "dev", "test", "pr", "review", "merge", "deploy", "verify", "rollback"] as const;
export type Stage = (typeof STAGES)[number];

// Per-stage status literal unions — exact PRD §7.1 wording. `creating`/`merging` are internal
// transient statuses set by a gate route's compare-and-swap before the worker performs the
// (irreversible) external action; the UI treats them as "running". `not_started` is the initial
// state of a freshly imported task, before the user taps "Prepare Plan" (FR-9).
export const PLAN_STATUSES = ["not_started", "in_progress", "completed_unapproved", "approved"] as const;
export const DEV_STATUSES = ["in_progress", "done"] as const;
export const TEST_STATUSES = ["in_progress", "passed", "failed"] as const;
export const PR_STATUSES = ["proposed", "creating", "created"] as const;
export const REVIEW_STATUSES = ["awaiting_review", "comments_received", "comments_addressed", "approved"] as const;
export const MERGE_STATUSES = ["ready", "merging", "merged"] as const;
export const DEPLOY_STATUSES = ["deploying", "deployed", "failed"] as const;
// Post-deploy: collect a result bundle (smoke + change summary) and wait for the operator to confirm
// the change is live and good (a 4th gate) — or hand off to rollback.
export const VERIFY_STATUSES = ["in_progress", "awaiting_review", "verified", "failed"] as const;
// Undo a bad deploy: revert the merge + redeploy the previous good state. `ready` is armed-but-unconfirmed;
// `ready → in_progress` is the (user-gated) execution, like merge.
export const ROLLBACK_STATUSES = ["ready", "in_progress", "rolled_back", "failed"] as const;

/**
 * Cross-cutting statuses reachable from any active stage. `blocked` = budget/iteration exhausted
 * or the agent got stuck (escalation; recoverable by raising the cap and retrying — distinct from
 * `test:failed`, which auto-retries, so escalation never push-storms). `cancelled` = user abandon
 * (terminal). Both keep the `stage` they occurred in.
 */
export const TASK_STATUSES = ["blocked", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUSES_BY_STAGE = {
  plan: PLAN_STATUSES,
  dev: DEV_STATUSES,
  test: TEST_STATUSES,
  pr: PR_STATUSES,
  review: REVIEW_STATUSES,
  merge: MERGE_STATUSES,
  deploy: DEPLOY_STATUSES,
  verify: VERIFY_STATUSES,
  rollback: ROLLBACK_STATUSES,
} as const satisfies Record<Stage, readonly string[]>;

/** Any valid status string (per-stage tokens plus the cross-cutting ones). */
export type Status =
  | (typeof PLAN_STATUSES)[number]
  | (typeof DEV_STATUSES)[number]
  | (typeof TEST_STATUSES)[number]
  | (typeof PR_STATUSES)[number]
  | (typeof REVIEW_STATUSES)[number]
  | (typeof MERGE_STATUSES)[number]
  | (typeof DEPLOY_STATUSES)[number]
  | (typeof VERIFY_STATUSES)[number]
  | (typeof ROLLBACK_STATUSES)[number]
  | TaskStatus;

/** A (stage, status) position in the machine. Serialized as two top-level fields. */
export interface StageStatus {
  stage: Stage;
  status: Status;
}

/** The three stages whose exit requires an explicit human approval (PRD §8). */
export const GATED_STAGES = ["plan", "pr", "merge"] as const;
export type GatedStage = (typeof GATED_STAGES)[number];

/** Who/what caused a transition (FR-7 audit). Only `user` may cross a gate. */
export const ACTORS = ["user", "agent", "system", "jira_sync"] as const;
export type Actor = (typeof ACTORS)[number];

/** Worker job kinds (the orchestration queue). */
export const JOB_KINDS = ["plan", "dev_test", "create_pr", "address_comments", "merge", "deploy", "verify", "rollback"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Job lifecycle in `eng_jobs`. */
export const JOB_STATES = ["queued", "claimed", "running", "done", "failed", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];

// --- Per-stage artifacts (FR-8). camelCase field names are the frozen client contract. ---

export interface PlanArtifact {
  /** Full generated plan markdown (FR-12, readable/approvable). */
  text: string;
  /** User annotations/edits applied before approval; the worker resumes from this when present (FR-13). */
  editedText: string | null;
  /** The Claude Code session id this plan was produced under (FR-14). */
  sessionId: string | null;
  /** Number of "send back for revision" cycles. */
  revision: number;
  generatedTs: string;
  approvedTs: string | null;
  approvedBy: string | null;
}

export interface DevArtifact {
  /** Summary of the changes the agent made (FR-8). */
  summary: string;
  branch: string;
  /** GitHub branch/compare link. */
  branchURL: string | null;
  filesChanged: number | null;
  /** Dev/test fix-loop iteration count (budget). */
  iterations: number;
  lastIterationTs: string;
}

export interface TestRun {
  ts: string;
  passed: boolean;
  total: number | null;
  failed: number | null;
  /** Human pass/fail summary. Redacted at capture. */
  summary: string;
}

export interface TestArtifact {
  runs: TestRun[];
  lastPassed: boolean | null;
}

export interface PrArtifact {
  title: string;
  /** PR description (proposed before creation, FR-18). */
  body: string;
  diffSummary: string;
  /** null while `proposed`/`creating`; set on `created` (FR-19). */
  url: string | null;
  number: number | null;
  proposedTs: string;
  createdTs: string | null;
  approvedBy: string | null;
}

export interface ReviewComment {
  /** GitHub review-comment id — idempotency key for redelivery. */
  externalId: string;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  receivedTs: string;
  /** How the agent addressed it (FR-21); null until resolved. */
  resolution: string | null;
  resolvedTs: string | null;
  resolvedCommitSha: string | null;
}

export interface ReviewArtifact {
  comments: ReviewComment[];
  approved: boolean;
  /** Re-review iterations (loop). */
  rounds: number;
}

export interface MergeArtifact {
  commitSha: string | null;
  mergedTs: string | null;
  mergedBy: string | null;
  method: "merge" | "squash" | "rebase" | null;
}

export interface DeployArtifact {
  env: string;
  status: (typeof DEPLOY_STATUSES)[number];
  startedTs: string | null;
  finishedTs: string | null;
  commitSha: string | null;
  /** GitHub Actions deploy-run URL (CD pipeline observed for the merge commit). */
  runUrl: string | null;
  /** CI (verify) job conclusion — `success` | `failure` | `null` while running. */
  ci: string | null;
  /** CD (deploy) job conclusion. */
  cd: string | null;
  /** Why a deploy failed: `ci_build` (verify job — code/build broken, needs a fix-forward), `cd_infra`
   *  (deploy job — transient, re-run the workflow), `no_run` (no run found / timeout). Null otherwise. */
  failureKind: "ci_build" | "cd_infra" | "no_run" | null;
  /** Redacted tail of the failing CI job's log — the actual build error, for fix-forward + display. */
  ciError: string | null;
  /** Truncated, redacted redeploy output (ssh mode) or a status note (github-actions mode). */
  logTail: string | null;
}

/** Post-deploy verification: the result bundle the operator confirms (smoke + what shipped). */
export interface VerifyArtifact {
  /** The deployed commit (= merge sha). */
  deployedSha: string | null;
  /** One-line summary of what shipped (from the dev/PR artifacts). */
  changeSummary: string;
  /** Whether the post-deploy smoke check (e.g. prod /healthz) passed. */
  healthOk: boolean;
  /** Individual post-deploy checks. */
  checks: { name: string; ok: boolean; detail: string | null }[];
  /** Redacted smoke output / status note. */
  output: string | null;
  /** GitHub Actions deploy-run URL (for cross-reference). */
  runUrl: string | null;
  verifiedBy: string | null;
  verifiedTs: string | null;
}

/** Rollback: revert the merge + redeploy the previous good state (code-only). */
export interface RollbackArtifact {
  /** The merge commit being undone. */
  targetSha: string | null;
  /** The revert commit created. */
  revertSha: string | null;
  /** The revert PR opened (then merged → triggers the redeploy). */
  prUrl: string | null;
  status: (typeof ROLLBACK_STATUSES)[number];
  startedTs: string | null;
  finishedTs: string | null;
  triggeredBy: string | null;
  logTail: string | null;
}

export interface TaskArtifacts {
  plan: PlanArtifact | null;
  dev: DevArtifact | null;
  test: TestArtifact | null;
  pr: PrArtifact | null;
  review: ReviewArtifact | null;
  merge: MergeArtifact | null;
  deploy: DeployArtifact | null;
  verify: VerifyArtifact | null;
  rollback: RollbackArtifact | null;
}

export const EMPTY_ARTIFACTS: TaskArtifacts = {
  plan: null,
  dev: null,
  test: null,
  pr: null,
  review: null,
  merge: null,
  deploy: null,
  verify: null,
  rollback: null,
};

/** Per-task cost + iteration caps (PRD §8/§9). All counters accumulate; the worker escalates at a cap. */
export interface TaskBudget {
  maxIterations: number;
  iterationsUsed: number;
  maxUsdCents: number;
  usdCentsUsed: number;
  maxReviewRounds: number;
  reviewRoundsUsed: number;
}

export const DEFAULT_BUDGET: TaskBudget = {
  maxIterations: 6,
  iterationsUsed: 0,
  maxUsdCents: 500,
  usdCentsUsed: 0,
  maxReviewRounds: 5,
  reviewRoundsUsed: 0,
};

/** A persisted engineering task. */
export interface EngTask {
  /** Internal id `task_<sha(jiraKey)>` — the id used in every `/tasks/:id` route and push payload. */
  id: string;
  /** Jira issue key, e.g. "LK-123" (UNIQUE; idempotency key for import). */
  jiraKey: string;
  /** Numeric Jira id (kept for completeness; v1 does not write back). */
  jiraId: string;
  jiraUrl: string;
  /** Cached Jira metadata (refreshed by sync / live fetch; Jira is the source of truth). */
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  labels: string[];
  components: string[];
  /** Jira accountId of the assignee (FR-2 import filter; assignee-only gate auth). */
  assignee: string;
  /** Jira status name (advisory/display only; the LK stage is independent — PRD §7). */
  jiraStatus: string;

  /** Configured target repo "owner/name" (dogfood: the LoopKeeper repo itself). */
  repo: string;
  defaultBranch: string;
  /** "LK-123-slug"; null until the plan is approved and the worker creates the worktree. */
  branch: string | null;
  /** Absolute path of the task's permanent git worktree — the immutable Claude-session anchor. */
  worktreePath: string | null;
  /** Claude Code session id (FR-14); dev/review `--resume` it, cold-start from the plan if gone. */
  claudeSessionId: string | null;
  /** Per-task model override (e.g. "claude-opus-4-8"). Null → use the global ENG_CLAUDE_MODEL default. */
  claudeModel: string | null;

  /** Current position in the machine. */
  stage: Stage;
  status: Status;

  artifacts: TaskArtifacts;
  budget: TaskBudget;

  /** Last status we pushed a notification for, to avoid double-push (FR-25). */
  lastNotifiedStatus: string | null;
  /** Last failure reason surfaced to the user on escalation. Redacted at capture. */
  lastError: string | null;

  createdTs: string;
  updatedTs: string;
}

/** Fields needed to create/import a task; the store fills in id/stage/status/artifacts/budget. */
export interface EngTaskInput {
  jiraKey: string;
  jiraId: string;
  jiraUrl: string;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  labels: string[];
  components: string[];
  assignee: string;
  jiraStatus: string;
  repo: string;
  defaultBranch: string;
}

/** One immutable audit-log entry (mirrors `loop_events`). FR-7 timeline. */
export interface StageEvent {
  seq: number;
  taskId: string;
  fromStage: Stage | null;
  fromStatus: Status | null;
  toStage: Stage;
  toStatus: Status;
  actor: Actor;
  /** user id / agent run id / sync detail. */
  actorDetail: string | null;
  note: string | null;
  /** 1 when this transition consumed a human gate approval (the §8 invariant marker). */
  gateApproved: boolean;
  ts: string;
}

/** A worker queue job. */
export interface EngJob {
  id: string;
  taskId: string;
  kind: JobKind;
  payload: string | null;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  claimedBy: string | null;
  leaseUntil: string | null;
  availableAt: string;
  dedupeKey: string | null;
  result: string | null;
  error: string | null;
  createdTs: string;
  updatedTs: string;
}

/** One Claude Code headless invocation. */
export const AGENT_RUN_STATUSES = ["running", "succeeded", "failed", "aborted", "budget_exceeded"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface AgentRun {
  id: string;
  taskId: string;
  stage: Stage;
  sessionId: string | null;
  status: AgentRunStatus;
  startedTs: string;
  finishedTs: string | null;
  exitCode: number | null;
  iteration: number;
  usdCents: number;
  numTurns: number | null;
  resultSummary: string | null;
  error: string | null;
  logPath: string | null;
}

/** Deterministic task id derived from the immutable Jira numeric id — same issue → same id across key renames. */
export function taskId(jiraId: string): string {
  return `task_${createHash("sha256").update(jiraId).digest("hex").slice(0, 20)}`;
}

/** The internal composite key the state machine reasons over. Never serialized. */
export function statusKey(s: StageStatus): string {
  return `${s.stage}:${s.status}`;
}

/** Branch name for a task: `LK-123-add-jira-oauth` (slugified, bounded). */
export function branchNameFor(jiraKey: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `${jiraKey}-${slug}` : jiraKey;
}

/** Whether a status is one a status-token string belongs to a given stage. */
export function isStatusForStage(stage: Stage, status: string): boolean {
  return (STATUSES_BY_STAGE[stage] as readonly string[]).includes(status) || (TASK_STATUSES as readonly string[]).includes(status);
}
