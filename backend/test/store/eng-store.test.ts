import { beforeEach, describe, expect, it } from "vitest";
import { EngStore } from "../../src/store/eng-store.ts";
import type { EngTaskInput, PlanArtifact } from "../../src/domain/eng-task.ts";
import { taskId } from "../../src/domain/eng-task.ts";

const NOW = "2026-06-27T00:00:00Z";

function input(over: Partial<EngTaskInput> = {}): EngTaskInput {
  return {
    jiraKey: "LK-1",
    jiraId: "10001",
    jiraUrl: "https://x.atlassian.net/browse/LK-1",
    title: "Add Jira OAuth connector",
    description: "Wire Atlassian 3LO.",
    acceptanceCriteria: "Tokens stored in vault.",
    labels: ["backend"],
    components: ["api"],
    assignee: "acct-123",
    jiraStatus: "To Do",
    repo: "karna/loopkeeper",
    defaultBranch: "main",
    ...over,
  };
}

describe("EngStore: import", () => {
  let store: EngStore;
  beforeEach(() => {
    store = new EngStore(":memory:");
  });

  it("inserts at plan:not_started, then upserts metadata idempotently", () => {
    expect(store.upsertFromJira([input()], NOW)).toEqual({ inserted: 1, updated: 0 });
    const t = store.getByKey("LK-1")!;
    expect(t.id).toBe(taskId("LK-1"));
    expect(t.stage).toBe("plan");
    expect(t.status).toBe("not_started");

    // Advance the LK stage, then re-import with changed Jira metadata.
    store.transition({ taskId: t.id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    const r = store.upsertFromJira([input({ title: "Renamed", jiraStatus: "In Progress" })], NOW);
    expect(r).toEqual({ inserted: 0, updated: 1 });
    const after = store.getByKey("LK-1")!;
    expect(after.title).toBe("Renamed"); // Jira-owned metadata refreshed
    expect(after.jiraStatus).toBe("In Progress");
    expect(after.stage).toBe("plan");
    expect(after.status).toBe("in_progress"); // LK stage NEVER regressed by import
  });
});

describe("EngStore: transitions + audit", () => {
  let store: EngStore;
  let id: string;
  beforeEach(() => {
    store = new EngStore(":memory:");
    store.upsertFromJira([input()], NOW);
    id = taskId("LK-1");
  });

  it("idempotent no-op leaves no event", () => {
    const r = store.transition({ taskId: id, to: { stage: "plan", status: "not_started" }, actor: "system", ts: NOW });
    expect(r).toEqual({ ok: true, changed: false });
    expect(store.events(id)).toHaveLength(0);
  });

  it("rejects an illegal transition", () => {
    const r = store.transition({ taskId: id, to: { stage: "merge", status: "merged" }, actor: "user", gateApproved: true, ts: NOW });
    expect(r.ok).toBe(false);
    expect(store.getByKey("LK-1")!.status).toBe("not_started");
  });

  it("enforces the plan gate: needs user + gateApproved, and records it", () => {
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    store.transition({ taskId: id, to: { stage: "plan", status: "completed_unapproved" }, actor: "agent", ts: NOW });

    // agent cannot cross the gate
    expect(store.transition({ taskId: id, to: { stage: "plan", status: "approved" }, actor: "agent", gateApproved: true, ts: NOW }).ok).toBe(false);
    // user without approval cannot cross
    expect(store.transition({ taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", ts: NOW }).ok).toBe(false);
    // user + approval crosses
    expect(store.transition({ taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW, actorDetail: "acct-123" })).toEqual({
      ok: true,
      changed: true,
    });

    const events = store.events(id);
    const gateEvent = events.find((e) => e.toStatus === "approved")!;
    expect(gateEvent.gateApproved).toBe(true);
    expect(gateEvent.actor).toBe("user");
    expect(events.map((e) => e.toStatus)).toEqual(["in_progress", "completed_unapproved", "approved"]);
  });

  it("tracks the merge gate for the deploy-retry guard", () => {
    expect(store.hasGatedMerge(id)).toBe(false);
    // Drive to merge:ready then cross the merge gate.
    const steps: Array<[string, string, "user" | "agent" | "system", boolean]> = [
      ["plan", "in_progress", "user", false],
      ["plan", "completed_unapproved", "agent", false],
      ["plan", "approved", "user", true],
      ["dev", "in_progress", "system", false],
      ["dev", "done", "agent", false],
      ["test", "in_progress", "system", false],
      ["test", "passed", "system", false],
      ["pr", "proposed", "system", false],
      ["pr", "creating", "user", true],
      ["pr", "created", "system", false],
      ["review", "awaiting_review", "system", false],
      ["review", "approved", "system", false],
      ["merge", "ready", "system", false],
      ["merge", "merging", "user", true],
    ];
    for (const [stage, status, actor, gate] of steps) {
      const r = store.transition({ taskId: id, to: { stage: stage as never, status: status as never }, actor, gateApproved: gate, ts: NOW });
      expect(r.ok, `${stage}:${status}`).toBe(true);
    }
    expect(store.hasGatedMerge(id)).toBe(true);
  });
});

describe("EngStore: artifacts + budget", () => {
  let store: EngStore;
  let id: string;
  beforeEach(() => {
    store = new EngStore(":memory:");
    store.upsertFromJira([input()], NOW);
    id = taskId("LK-1");
  });

  it("merge-patches artifacts without clobbering other stages", () => {
    const plan: PlanArtifact = { text: "the plan", editedText: null, sessionId: "sess-1", revision: 0, generatedTs: NOW, approvedTs: null, approvedBy: null };
    store.setArtifact(id, { plan }, NOW);
    store.setArtifact(id, { test: { runs: [{ ts: NOW, passed: true, total: 42, failed: 0, summary: "42/42" }], lastPassed: true } }, NOW);
    const t = store.get(id)!;
    expect(t.artifacts.plan?.text).toBe("the plan");
    expect(t.artifacts.test?.lastPassed).toBe(true);
  });

  it("accumulates usage and raises caps", () => {
    const b1 = store.addBudgetUsage(id, { iterations: 1, usdCents: 50 }, NOW)!;
    expect(b1.iterationsUsed).toBe(1);
    expect(b1.usdCentsUsed).toBe(50);
    const b2 = store.raiseBudget(id, { maxIterations: 20 }, NOW)!;
    expect(b2.maxIterations).toBe(20);
    expect(b2.iterationsUsed).toBe(1); // preserved
  });
});

describe("EngStore: job queue", () => {
  let store: EngStore;
  beforeEach(() => {
    store = new EngStore(":memory:");
    store.upsertFromJira([input()], NOW);
  });

  it("enqueues, dedupes live jobs, and claims atomically", () => {
    const t = taskId("LK-1");
    const j1 = store.enqueue({ taskId: t, kind: "plan", dedupeKey: `${t}:plan` }, NOW);
    expect(j1).not.toBeNull();
    // a second live job with the same dedupe key is blocked
    expect(store.enqueue({ taskId: t, kind: "plan", dedupeKey: `${t}:plan` }, NOW)).toBeNull();

    const claimed = store.claimNext("worker-1", NOW, "2026-06-27T01:00:00Z")!;
    expect(claimed.id).toBe(j1);
    expect(claimed.state).toBe("claimed");
    expect(claimed.attempts).toBe(1);
    // nothing else queued
    expect(store.claimNext("worker-1", NOW, "2026-06-27T01:00:00Z")).toBeNull();

    store.completeJob(claimed.id, { sessionId: "sess-1" }, NOW);
    // after completion the dedupe key is free again
    expect(store.enqueue({ taskId: t, kind: "plan", dedupeKey: `${t}:plan` }, NOW)).not.toBeNull();
  });

  it("requeues a failed job with attempts left, fails it when exhausted", () => {
    const t = taskId("LK-1");
    const j = store.enqueue({ taskId: t, kind: "dev_test", maxAttempts: 2 }, NOW)!;
    const c = store.claimNext("w", NOW, "2026-06-27T01:00:00Z")!;
    expect(store.failJob(c.id, "boom", NOW, { requeueAt: NOW })).toBe(true);
    const again = store.claimNext("w", NOW, "2026-06-27T02:00:00Z")!;
    expect(again.id).toBe(j);
    expect(again.attempts).toBe(2);
    // attempts now exhausted → fail terminally
    store.failJob(again.id, "boom again", NOW, { requeueAt: NOW });
    expect(store.runningJobForTask(t)).toBeNull();
  });

  it("reaps expired leases back to the queue", () => {
    const t = taskId("LK-1");
    store.enqueue({ taskId: t, kind: "merge", maxAttempts: 3 }, NOW);
    store.claimNext("w", NOW, "2026-06-27T00:00:01Z"); // lease ends almost immediately
    const reaped = store.reapExpiredLeases("2026-06-27T01:00:00Z");
    expect(reaped).toBe(1);
    expect(store.claimNext("w", "2026-06-27T01:00:00Z", "2026-06-27T02:00:00Z")).not.toBeNull();
  });
});

describe("EngStore: agent runs", () => {
  let store: EngStore;
  let id: string;
  beforeEach(() => {
    store = new EngStore(":memory:");
    store.upsertFromJira([input()], NOW);
    id = taskId("LK-1");
  });

  it("records a run and reconciles crashed runs on restart", () => {
    const runId = store.startAgentRun({ taskId: id, stage: "plan", sessionId: "sess-1", iteration: 0, startedTs: NOW });
    store.finishAgentRun(runId, { status: "succeeded", finishedTs: NOW, exitCode: 0, usdCents: 12, numTurns: 5, resultSummary: "done" });
    expect(store.agentRuns(id)[0]?.status).toBe("succeeded");

    store.startAgentRun({ taskId: id, stage: "dev", sessionId: "sess-1", iteration: 1, startedTs: NOW });
    expect(store.reconcileRunningAgentRuns(NOW)).toBe(1);
    expect(store.agentRuns(id).find((r) => r.stage === "dev")?.status).toBe("aborted");
  });
});

describe("EngStore: cancel pending", () => {
  let store: EngStore;
  let id: string;
  beforeEach(() => {
    store = new EngStore(":memory:");
    store.upsertFromJira([input()], NOW);
    id = taskId("LK-1");
  });

  it("cancel_pending defaults to false and toggles via set/is", () => {
    expect(store.isTaskCancelPending(id)).toBe(false);
    store.setCancelPending(id, NOW);
    expect(store.isTaskCancelPending(id)).toBe(true);
  });

  it("raiseBudget clears the cancel_pending flag", () => {
    store.setCancelPending(id, NOW);
    expect(store.isTaskCancelPending(id)).toBe(true);
    store.raiseBudget(id, { maxIterations: 10 }, NOW);
    expect(store.isTaskCancelPending(id)).toBe(false);
  });

  it("setCancelPending returns false for unknown taskId", () => {
    expect(store.setCancelPending("unknown", NOW)).toBe(false);
  });

  it("isTaskCancelPending returns false for unknown taskId", () => {
    expect(store.isTaskCancelPending("unknown")).toBe(false);
  });
});
