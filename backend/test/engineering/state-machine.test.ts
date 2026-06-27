import { describe, expect, it } from "vitest";
import type { Actor, StageStatus } from "../../src/domain/eng-task.ts";
import { GATED_STAGES } from "../../src/domain/eng-task.ts";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  effectsFor,
  isTerminal,
  needsHuman,
  nextStatuses,
  shouldRetryAfterTestFailure,
  shouldRetryReview,
  transitionNeedsGate,
} from "../../src/engineering/state-machine.ts";

const ss = (stage: StageStatus["stage"], status: StageStatus["status"]): StageStatus => ({ stage, status });

describe("state-machine: happy path", () => {
  it("walks the full lifecycle", () => {
    const path: Array<[StageStatus, StageStatus, Actor]> = [
      [ss("plan", "not_started"), ss("plan", "in_progress"), "user"],
      [ss("plan", "in_progress"), ss("plan", "completed_unapproved"), "agent"],
      [ss("plan", "completed_unapproved"), ss("plan", "approved"), "user"],
      [ss("plan", "approved"), ss("dev", "in_progress"), "system"],
      [ss("dev", "in_progress"), ss("dev", "done"), "agent"],
      [ss("dev", "done"), ss("test", "in_progress"), "system"],
      [ss("test", "in_progress"), ss("test", "passed"), "system"],
      [ss("test", "passed"), ss("pr", "proposed"), "system"],
      [ss("pr", "proposed"), ss("pr", "creating"), "user"],
      [ss("pr", "creating"), ss("pr", "created"), "system"],
      [ss("pr", "created"), ss("review", "awaiting_review"), "system"],
      [ss("review", "awaiting_review"), ss("review", "approved"), "system"],
      [ss("review", "approved"), ss("merge", "ready"), "system"],
      [ss("merge", "ready"), ss("merge", "merging"), "user"],
      [ss("merge", "merging"), ss("merge", "merged"), "system"],
      [ss("merge", "merged"), ss("deploy", "deploying"), "system"],
      [ss("deploy", "deploying"), ss("deploy", "deployed"), "system"],
    ];
    for (const [from, to, actor] of path) {
      expect(canTransition(from, to, actor), `${from.stage}:${from.status} → ${to.stage}:${to.status}`).toEqual({ ok: true });
    }
  });

  it("idempotent no-op is allowed", () => {
    expect(canTransition(ss("dev", "in_progress"), ss("dev", "in_progress"), "agent")).toEqual({ ok: true });
  });

  it("rejects illegal jumps", () => {
    expect(canTransition(ss("plan", "approved"), ss("merge", "merged"), "user").ok).toBe(false);
    expect(canTransition(ss("test", "passed"), ss("deploy", "deploying"), "system").ok).toBe(false);
  });
});

describe("state-machine: loops", () => {
  it("test failure loops back to dev", () => {
    expect(canTransition(ss("test", "failed"), ss("dev", "in_progress"), "system")).toEqual({ ok: true });
  });
  it("review loops until approved", () => {
    expect(canTransition(ss("review", "comments_received"), ss("review", "comments_addressed"), "agent")).toEqual({ ok: true });
    expect(canTransition(ss("review", "comments_addressed"), ss("review", "awaiting_review"), "system")).toEqual({ ok: true });
  });
});

describe("state-machine: gate safety (§8)", () => {
  const gates: Array<[StageStatus, StageStatus]> = [
    [ss("plan", "completed_unapproved"), ss("plan", "approved")],
    [ss("pr", "proposed"), ss("pr", "creating")],
    [ss("merge", "ready"), ss("merge", "merging")],
  ];

  it("identifies exactly the three gated transitions", () => {
    for (const [from, to] of gates) expect(transitionNeedsGate(from, to)).toBe(true);
    expect(transitionNeedsGate(ss("dev", "in_progress"), ss("dev", "done"))).toBe(false);
  });

  it("only a user may cross a gate", () => {
    for (const [from, to] of gates) {
      for (const actor of ["agent", "system", "jira_sync"] as Actor[]) {
        expect(canTransition(from, to, actor).ok, `${actor} must not cross ${from.stage} gate`).toBe(false);
      }
      expect(canTransition(from, to, "user").ok).toBe(true);
    }
  });

  it("GATED_STAGES matches the gated source stages", () => {
    expect([...GATED_STAGES].sort()).toEqual(["merge", "plan", "pr"]);
  });
});

describe("state-machine: blocked / cancelled", () => {
  it("agent/system may escalate to blocked, user may not", () => {
    expect(canTransition(ss("test", "failed"), ss("test", "blocked"), "system")).toEqual({ ok: true });
    expect(canTransition(ss("dev", "in_progress"), ss("dev", "blocked"), "agent")).toEqual({ ok: true });
    expect(canTransition(ss("dev", "in_progress"), ss("dev", "blocked"), "user").ok).toBe(false);
  });

  it("blocking keeps the current stage", () => {
    expect(canTransition(ss("dev", "in_progress"), ss("plan", "blocked"), "system").ok).toBe(false);
  });

  it("user resumes a blocked task to dev/plan", () => {
    expect(canTransition(ss("test", "blocked"), ss("dev", "in_progress"), "user")).toEqual({ ok: true });
    expect(canTransition(ss("test", "blocked"), ss("dev", "in_progress"), "system").ok).toBe(false);
  });

  it("user may cancel any non-terminal task", () => {
    expect(canTransition(ss("dev", "in_progress"), ss("dev", "cancelled"), "user")).toEqual({ ok: true });
    expect(canTransition(ss("dev", "in_progress"), ss("dev", "cancelled"), "agent").ok).toBe(false);
  });

  it("cannot transition out of a terminal state", () => {
    expect(isTerminal(ss("deploy", "deployed"))).toBe(true);
    expect(isTerminal(ss("dev", "cancelled"))).toBe(true);
    expect(canTransition(ss("deploy", "deployed"), ss("deploy", "deploying"), "user").ok).toBe(false);
    expect(canTransition(ss("dev", "cancelled"), ss("dev", "in_progress"), "user").ok).toBe(false);
  });
});

describe("state-machine: needsHuman", () => {
  it("flags the gate-ready + escalation states", () => {
    expect(needsHuman(ss("plan", "completed_unapproved"))).toBe(true);
    expect(needsHuman(ss("pr", "proposed"))).toBe(true);
    expect(needsHuman(ss("review", "comments_received"))).toBe(true);
    expect(needsHuman(ss("merge", "ready"))).toBe(true);
    expect(needsHuman(ss("deploy", "failed"))).toBe(true);
    expect(needsHuman(ss("dev", "blocked"))).toBe(true);
  });
  it("does not flag in-progress / auto-retry states", () => {
    expect(needsHuman(ss("dev", "in_progress"))).toBe(false);
    expect(needsHuman(ss("test", "failed"))).toBe(false); // auto-retries; escalation uses blocked
    expect(needsHuman(ss("deploy", "deployed"))).toBe(false);
  });
});

describe("state-machine: effects", () => {
  it("enqueues the right jobs and notifies", () => {
    expect(effectsFor(ss("plan", "in_progress"))).toEqual([{ kind: "enqueue_job", job: "plan" }]);
    expect(effectsFor(ss("plan", "approved"))).toEqual([{ kind: "enqueue_job", job: "dev_test" }]);
    expect(effectsFor(ss("pr", "creating"))).toEqual([{ kind: "enqueue_job", job: "create_pr" }]);
    expect(effectsFor(ss("merge", "merging"))).toEqual([{ kind: "enqueue_job", job: "merge" }]);
    expect(effectsFor(ss("merge", "merged"))).toEqual([{ kind: "enqueue_job", job: "deploy" }]);
    expect(effectsFor(ss("plan", "completed_unapproved"))).toEqual([{ kind: "notify", reason: "plan_ready" }]);
    expect(effectsFor(ss("merge", "ready"))).toEqual([{ kind: "notify", reason: "merge_ready" }]);
    expect(effectsFor(ss("dev", "blocked"))).toEqual([{ kind: "notify", reason: "blocked" }]);
    expect(effectsFor(ss("dev", "cancelled"))).toEqual([]);
  });
});

describe("state-machine: budget guards", () => {
  const base = { maxIterations: 6, iterationsUsed: 0, maxUsdCents: 500, usdCentsUsed: 0, maxReviewRounds: 5, reviewRoundsUsed: 0 };
  it("retries dev/test under budget, stops at a cap", () => {
    expect(shouldRetryAfterTestFailure(base)).toBe(true);
    expect(shouldRetryAfterTestFailure({ ...base, iterationsUsed: 6 })).toBe(false);
    expect(shouldRetryAfterTestFailure({ ...base, usdCentsUsed: 500 })).toBe(false);
  });
  it("retries review under budget", () => {
    expect(shouldRetryReview(base)).toBe(true);
    expect(shouldRetryReview({ ...base, reviewRoundsUsed: 5 })).toBe(false);
  });
});

describe("state-machine: graph integrity", () => {
  it("every transition target is itself a known key (or terminal)", () => {
    const keys = new Set(Object.keys(ALLOWED_TRANSITIONS));
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const t of targets) {
        expect(keys.has(t), `${from} → ${t} has no outgoing entry`).toBe(true);
      }
    }
  });
  it("nextStatuses returns the adjacency list", () => {
    expect(nextStatuses(ss("test", "in_progress"))).toEqual(["test:passed", "test:failed"]);
  });
});
