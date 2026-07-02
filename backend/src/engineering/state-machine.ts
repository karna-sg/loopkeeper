/**
 * The pure engineering state machine (PRD §7). No I/O — it only computes; `EngStore` persists.
 * Fully unit-testable like `Scheduler.tick`.
 *
 * Encodes the happy path (§7.3) + both loops (§7.2): the test-failure loop
 * (`test:failed → dev:in_progress`, budget-gated by the orchestrator) and the review loop
 * (`review:comments_addressed → review:awaiting_review`).
 *
 * Gate safety (the §8 hard rule "the agent never authors AND merges without a human in between")
 * is enforced HERE and in the store, not by route discipline: only `actor:"user"` may cross a
 * gated transition (and the store additionally requires `gateApproved===true`). It is impossible
 * to express an agent/system-driven gate crossing.
 */

import type { Actor, JobKind, StageStatus } from "../domain/eng-task.ts";
import { statusKey } from "../domain/eng-task.ts";

/**
 * Adjacency on composite "stage:status" keys (internal only, never serialized). Cross-cutting
 * `blocked`/`cancelled` transitions are handled specially in {@link canTransition}.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  "plan:not_started": ["plan:in_progress" /* user taps Prepare Plan (FR-9) */],
  "plan:in_progress": ["plan:completed_unapproved"],
  "plan:completed_unapproved": ["plan:in_progress" /* send back for revision */, "plan:approved" /* GATE 1 */],
  "plan:approved": ["dev:in_progress"],
  "dev:in_progress": ["dev:done"],
  "dev:done": ["test:in_progress"],
  "test:in_progress": ["test:passed", "test:failed"],
  "test:failed": ["dev:in_progress" /* fix loop §7.2, budget-gated */],
  "test:passed": ["pr:proposed"],
  "pr:proposed": ["pr:creating" /* GATE 2 */],
  "pr:creating": ["pr:created"],
  "pr:created": ["review:awaiting_review"],
  "review:awaiting_review": ["review:comments_received", "review:approved"],
  "review:comments_received": ["review:comments_addressed"],
  "review:comments_addressed": ["review:awaiting_review" /* re-review loop §7.2 */, "review:approved"],
  "review:approved": ["merge:ready"],
  "merge:ready": ["merge:merging" /* GATE 3 */],
  "merge:merging": ["merge:merged"],
  "merge:merged": ["deploy:deploying"],
  "deploy:deploying": ["deploy:deployed", "deploy:failed"],
  "deploy:failed": ["deploy:deploying" /* cd_infra re-run; route asserts a recorded merge gate */, "dev:in_progress" /* ci_build fix-forward loop */, "rollback:ready" /* undo a bad deploy */],
  "deploy:deployed": ["verify:in_progress" /* post-deploy smoke + sign-off */],
  "verify:in_progress": ["verify:awaiting_review", "verify:failed"],
  "verify:awaiting_review": ["verify:verified" /* GATE 4 */, "rollback:ready"],
  "verify:failed": ["verify:in_progress" /* retry smoke */, "rollback:ready"],
  "verify:verified": [] /* success terminal */,
  "rollback:ready": ["rollback:in_progress" /* GATE 5 */],
  "rollback:in_progress": ["rollback:rolled_back", "rollback:failed"],
  "rollback:failed": ["rollback:in_progress" /* retry */, "rollback:ready"],
  "rollback:rolled_back": [] /* recovered terminal */,
};

/** The exact gated transitions (composite `from → to`). Crossing these requires a human tap. */
export const GATED_TRANSITIONS: ReadonlySet<string> = new Set([
  "plan:completed_unapproved -> plan:approved",
  "pr:proposed -> pr:creating",
  "merge:ready -> merge:merging",
  "verify:awaiting_review -> verify:verified", // GATE 4: human confirms the deployed change is good
  "rollback:ready -> rollback:in_progress", // GATE 5: human confirms the rollback (revert + redeploy)
]);

/** Statuses that mean "this task is waiting on a person" (drives Home badge + FR-25 push). */
const NEEDS_HUMAN_KEYS: ReadonlySet<string> = new Set([
  "plan:completed_unapproved",
  "pr:proposed",
  "review:comments_received",
  "merge:ready",
  "deploy:failed",
  "verify:awaiting_review",
  "verify:failed",
  "rollback:ready",
  "rollback:failed",
]);

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

/** A terminal position — no further automated progress (cancelled, verified, or rolled back). */
export function isTerminal(s: StageStatus): boolean {
  return (
    s.status === "cancelled" ||
    (s.stage === "verify" && s.status === "verified") ||
    (s.stage === "rollback" && s.status === "rolled_back")
  );
}

/** Whether crossing `from → to` consumes a human approval gate. */
export function transitionNeedsGate(from: StageStatus, to: StageStatus): boolean {
  return GATED_TRANSITIONS.has(`${statusKey(from)} -> ${statusKey(to)}`);
}

/**
 * Whether `from → to` is legal for `actor`. Pure. Does NOT check `gateApproved` (the store does);
 * it does enforce that only `actor:"user"` may cross a gated transition.
 */
export function canTransition(from: StageStatus, to: StageStatus, actor: Actor): TransitionResult {
  // No-op (idempotent) — caller treats as success without emitting an event.
  if (from.stage === to.stage && from.status === to.status) return { ok: true };

  // User abandon — allowed from any non-terminal position, keeps the stage, terminal.
  if (to.status === "cancelled") {
    if (actor !== "user") return { ok: false, reason: "only a user can cancel a task" };
    if (isTerminal(from)) return { ok: false, reason: "task already terminal" };
    if (to.stage !== from.stage) return { ok: false, reason: "cancel keeps the current stage" };
    return { ok: true };
  }

  // Escalation — the orchestrator parks a stuck/over-budget task as blocked (never a user action),
  // keeping the stage so a later retry resumes the right place.
  if (to.status === "blocked") {
    if (actor === "user") return { ok: false, reason: "blocked is an escalation, not a user action" };
    if (isTerminal(from)) return { ok: false, reason: "task already terminal" };
    if (to.stage !== from.stage) return { ok: false, reason: "blocking keeps the current stage" };
    return { ok: true };
  }

  // Recovery from blocked — the user raises the budget and resumes (the orchestrator picks the
  // resume point; the machine permits resuming plan/dev or re-addressing review).
  if (from.status === "blocked") {
    if (actor !== "user") return { ok: false, reason: "only a user resumes a blocked task" };
    const resumable =
      (to.status === "in_progress" && (to.stage === "dev" || to.stage === "plan")) ||
      (to.stage === "review" && to.status === "comments_addressed");
    return resumable ? { ok: true } : { ok: false, reason: `cannot resume blocked → ${statusKey(to)}` };
  }

  const allowed = ALLOWED_TRANSITIONS[statusKey(from)] ?? [];
  if (!allowed.includes(statusKey(to))) {
    return { ok: false, reason: `illegal transition ${statusKey(from)} → ${statusKey(to)}` };
  }
  if (transitionNeedsGate(from, to) && actor !== "user") {
    return { ok: false, reason: `gate ${statusKey(from)} → ${statusKey(to)} requires a user approval` };
  }
  return { ok: true };
}

/** Allowed next composite keys from a position (normal graph only; excludes blocked/cancelled). */
export function nextStatuses(from: StageStatus): readonly string[] {
  return ALLOWED_TRANSITIONS[statusKey(from)] ?? [];
}

/** Whether a position is waiting on a human (gate ready, or escalated/blocked). */
export function needsHuman(s: StageStatus): boolean {
  return s.status === "blocked" || NEEDS_HUMAN_KEYS.has(statusKey(s));
}

// --- Side-effect descriptors. The machine returns INTENTS; the caller enqueues/sends. ---

export const NOTIFY_REASONS = [
  "plan_ready",
  "pr_ready",
  "comments_arrived",
  "merge_ready",
  "deployed",
  "deploy_failed",
  "blocked",
  "verify_ready",
  "verified",
  "verify_failed",
  "rollback_ready",
  "rolled_back",
  "rollback_failed",
] as const;
export type NotifyReason = (typeof NOTIFY_REASONS)[number];

export type TransitionEffect =
  | { kind: "enqueue_job"; job: JobKind }
  | { kind: "notify"; reason: NotifyReason };

const EFFECTS_BY_TARGET: Readonly<Record<string, readonly TransitionEffect[]>> = {
  // Reaching plan:in_progress (via Prepare Plan or a revise) enqueues the worker's plan job.
  "plan:in_progress": [{ kind: "enqueue_job", job: "plan" }],
  "plan:completed_unapproved": [{ kind: "notify", reason: "plan_ready" }],
  "plan:approved": [{ kind: "enqueue_job", job: "dev_test" }],
  "pr:proposed": [{ kind: "notify", reason: "pr_ready" }, { kind: "enqueue_job", job: "pre_review" }],
  "pr:creating": [{ kind: "enqueue_job", job: "create_pr" }],
  "review:comments_received": [{ kind: "notify", reason: "comments_arrived" }],
  "merge:ready": [{ kind: "notify", reason: "merge_ready" }],
  "merge:merging": [{ kind: "enqueue_job", job: "merge" }],
  "merge:merged": [{ kind: "enqueue_job", job: "deploy" }],
  // Deploy succeeded → kick the post-deploy verify (smoke + change summary); the verify job advances the stage.
  "deploy:deployed": [{ kind: "enqueue_job", job: "verify" }],
  "deploy:failed": [{ kind: "notify", reason: "deploy_failed" }],
  "verify:awaiting_review": [{ kind: "notify", reason: "verify_ready" }],
  "verify:verified": [{ kind: "notify", reason: "verified" }],
  "verify:failed": [{ kind: "notify", reason: "verify_failed" }],
  "rollback:ready": [{ kind: "notify", reason: "rollback_ready" }],
  "rollback:in_progress": [{ kind: "enqueue_job", job: "rollback" }],
  "rollback:rolled_back": [{ kind: "notify", reason: "rolled_back" }],
  "rollback:failed": [{ kind: "notify", reason: "rollback_failed" }],
};

/** What the orchestrator should DO when a task arrives at `to` (enqueue work / notify). */
export function effectsFor(to: StageStatus): readonly TransitionEffect[] {
  if (to.status === "blocked") return [{ kind: "notify", reason: "blocked" }];
  if (to.status === "cancelled") return [];
  return EFFECTS_BY_TARGET[statusKey(to)] ?? [];
}

// --- Pure budget guards (PRD §7.2/§8). The ONLY thing that gates the retry edges. ---

export interface BudgetView {
  maxIterations: number;
  iterationsUsed: number;
  maxUsdCents: number;
  usdCentsUsed: number;
  maxReviewRounds: number;
  reviewRoundsUsed: number;
}

/** After a test failure, may we spend another dev/test iteration, or must we escalate to blocked? */
export function shouldRetryAfterTestFailure(b: BudgetView): boolean {
  return b.iterationsUsed < b.maxIterations && b.usdCentsUsed < b.maxUsdCents;
}

/** After review comments, may we spend another address/re-review round? */
export function shouldRetryReview(b: BudgetView): boolean {
  return b.reviewRoundsUsed < b.maxReviewRounds && b.usdCentsUsed < b.maxUsdCents;
}

/** Entering the post-deploy build-fix loop spends a dev iteration — same pool as the test-fix loop. */
export function shouldRetryAfterBuildFailure(b: BudgetView): boolean {
  return shouldRetryAfterTestFailure(b);
}
