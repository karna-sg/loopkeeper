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
    expect(t.id).toBe(taskId("10001")); // id derives from jiraId, not jiraKey
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

  it("key rename: same jira_id + new jira_key updates key and preserves pipeline state", () => {
    store.upsertFromJira([input({ jiraKey: "LK-1", jiraId: "10001" })], NOW);
    const idBefore = store.getByKey("LK-1")!.id;
    store.transition({ taskId: idBefore, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });

    // Same issue, new project key after rename (jiraId unchanged).
    store.upsertFromJira([input({ jiraKey: "LP-1", jiraId: "10001" })], NOW);

    expect(store.count()).toBe(1); // no duplicate row
    const after = store.get(idBefore)!;
    expect(after.jiraKey).toBe("LP-1"); // display key updated
    expect(after.status).toBe("in_progress"); // pipeline state preserved
    expect(store.getByKey("LP-1")).not.toBeNull();
  });

  it("reconcile: prunes not_started stale rows, flags in-flight ones, skips terminal", () => {
    store.upsertFromJira(
      [
        input({ jiraKey: "LK-1", jiraId: "10001" }), // will be pruned
        input({ jiraKey: "LK-2", jiraId: "10002" }), // will be flagged
        input({ jiraKey: "LK-3", jiraId: "10003" }), // still live
        input({ jiraKey: "LK-4", jiraId: "10004" }), // terminal — silently skipped
      ],
      NOW,
    );
    const id2 = taskId("10002");
    const id4 = taskId("10004");
    store.transition({ taskId: id2, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    // Drive LK-4 to a terminal state
    store.transition({ taskId: id4, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    store.transition({ taskId: id4, to: { stage: "plan", status: "cancelled" }, actor: "user", ts: NOW });

    const result = store.reconcile(new Set(["10003"]), NOW);
    expect(result.pruned).toBe(1); // LK-1 deleted
    expect(result.flagged).toBe(1); // LK-2 warned
    expect(store.count()).toBe(3); // LK-1 gone; LK-2, LK-3, LK-4 remain
    expect(store.getByKey("LK-1")).toBeNull();
    expect(store.get(id2)?.lastError).toContain("no longer assigned");
    expect(store.getByKey("LK-3")).not.toBeNull();
    expect(store.getByKey("LK-4")).not.toBeNull(); // terminal row kept, no flag
    expect(store.get(id4)?.lastError).toBeNull();
  });

  it("reconcile: cascades deletes for pruned rows to child tables", () => {
    store.upsertFromJira([input({ jiraKey: "LK-1", jiraId: "10001" })], NOW);
    const t = taskId("10001");
    store.enqueue({ taskId: t, kind: "plan", dedupeKey: `${t}:plan` }, NOW);

    store.reconcile(new Set<string>(), NOW);

    expect(store.getByKey("LK-1")).toBeNull();
    expect(store.runningJobForTask(t)).toBeNull();
  });
});

describe("EngStore: transitions + audit", () => {
  let store: EngStore;
  let id: string;
  beforeEach(() => {
    store = new EngStore(":memory:");
    store.upsertFromJira([input()], NOW);
    id = taskId("10001");
  });

  it("idempotent no-op leaves no event", () => {
    const r = store.transition({ taskId: id, to: { stage: "plan", status: "not_started" }, actor: "system", ts: NOW });
    expect(r).toEqual({ ok: true, changed: false });
    expect(store.events(id)).toHaveLength(0);
  });

  it("rejects an illegal transition", () => {
    const r = store.transition({ taskId: id, to: { stage: "merge", status: "merged" }, actor: "user", gateApproved: true, ts: NOW });
    expect(r.ok).toBe(false);
    expect(store.get(id)!.status).toBe("not_started");
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
    id = taskId("10001");
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
    const t = taskId("10001");
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
    const t = taskId("10001");
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
    const t = taskId("10001");
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
    id = taskId("10001");
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
    id = taskId("10001");
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

describe("EngStore: labels", () => {
  let store: EngStore;
  beforeEach(() => {
    store = new EngStore(":memory:");
  });

  it("creates and lists labels", () => {
    const lbl = store.createLabel("P0", "#EB5A46");
    expect(lbl.id).toMatch(/^lbl_/);
    expect(lbl.name).toBe("P0");
    expect(lbl.color).toBe("#EB5A46");

    const list = store.listLabels();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(lbl.id);
  });

  it("updateLabel patches name and color", () => {
    const lbl = store.createLabel("P0", "#EB5A46");
    const updated = store.updateLabel(lbl.id, { name: "P1", color: "#61BD4F" });
    expect(updated?.name).toBe("P1");
    expect(updated?.color).toBe("#61BD4F");
    expect(store.listLabels()[0]!.name).toBe("P1");
  });

  it("updateLabel returns null for unknown id", () => {
    expect(store.updateLabel("unknown", { name: "X" })).toBeNull();
  });

  it("deleteLabel cascades to eng_task_labels", () => {
    store.upsertFromJira([input()], NOW);
    const task = store.getByKey("LK-1")!;
    const lbl = store.createLabel("P0", "#EB5A46");
    store.attachLabel(lbl.id, task.jiraId);
    expect(store.get(task.id)!.labelIds).toContain(lbl.id);

    store.deleteLabel(lbl.id);
    expect(store.listLabels()).toHaveLength(0);
    expect(store.get(task.id)!.labelIds).toHaveLength(0);
  });

  it("name uniqueness constraint throws on duplicate", () => {
    store.createLabel("P0", "#EB5A46");
    expect(() => store.createLabel("P0", "#61BD4F")).toThrow();
  });

  it("attachLabel appends at max(position)+1, idempotent on duplicate", () => {
    store.upsertFromJira(
      [input({ jiraKey: "LK-1", jiraId: "10001" }), input({ jiraKey: "LK-2", jiraId: "10002" })],
      NOW,
    );
    const t1 = store.getByKey("LK-1")!;
    const t2 = store.getByKey("LK-2")!;
    const lbl = store.createLabel("Sprint", "#0079BF");

    store.attachLabel(lbl.id, t1.jiraId);
    store.attachLabel(lbl.id, t2.jiraId);
    store.attachLabel(lbl.id, t1.jiraId); // duplicate — INSERT OR IGNORE is a no-op

    const order = store.labelTaskOrder(lbl.id);
    expect(order).toEqual([t1.jiraId, t2.jiraId]);
    expect(store.get(t1.id)!.labelIds).toContain(lbl.id);
    expect(store.get(t2.id)!.labelIds).toContain(lbl.id);
  });

  it("detachLabel removes the attachment", () => {
    store.upsertFromJira([input()], NOW);
    const task = store.getByKey("LK-1")!;
    const lbl = store.createLabel("P0", "#EB5A46");
    store.attachLabel(lbl.id, task.jiraId);
    store.detachLabel(lbl.id, task.jiraId);
    expect(store.get(task.id)!.labelIds).toHaveLength(0);
    expect(store.labelTaskOrder(lbl.id)).toHaveLength(0);
  });

  it("reorderLabel updates positions and labelTaskOrder reflects new order", () => {
    store.upsertFromJira(
      [
        input({ jiraKey: "LK-1", jiraId: "10001" }),
        input({ jiraKey: "LK-2", jiraId: "10002" }),
        input({ jiraKey: "LK-3", jiraId: "10003" }),
      ],
      NOW,
    );
    const lbl = store.createLabel("Sprint", "#0079BF");
    store.attachLabel(lbl.id, "10001");
    store.attachLabel(lbl.id, "10002");
    store.attachLabel(lbl.id, "10003");

    store.reorderLabel(lbl.id, ["10003", "10001", "10002"]);
    expect(store.labelTaskOrder(lbl.id)).toEqual(["10003", "10001", "10002"]);
  });

  it("list() populates labelIds on all tasks in one query", () => {
    store.upsertFromJira(
      [input({ jiraKey: "LK-1", jiraId: "10001" }), input({ jiraKey: "LK-2", jiraId: "10002" })],
      NOW,
    );
    const lbl1 = store.createLabel("P0", "#EB5A46");
    const lbl2 = store.createLabel("P1", "#61BD4F");
    store.attachLabel(lbl1.id, "10001");
    store.attachLabel(lbl2.id, "10001");
    store.attachLabel(lbl2.id, "10002");

    const tasks = store.list();
    const t1 = tasks.find((t) => t.jiraId === "10001")!;
    const t2 = tasks.find((t) => t.jiraId === "10002")!;
    expect(t1.labelIds).toContain(lbl1.id);
    expect(t1.labelIds).toContain(lbl2.id);
    expect(t2.labelIds).toContain(lbl2.id);
    expect(t2.labelIds).not.toContain(lbl1.id);
  });

  it("labelIds survive a Jira re-sync / key rename", () => {
    store.upsertFromJira([input({ jiraKey: "LK-1", jiraId: "10001" })], NOW);
    const lbl = store.createLabel("Track", "#0079BF");
    store.attachLabel(lbl.id, "10001");

    store.upsertFromJira([input({ jiraKey: "LP-1", jiraId: "10001" })], NOW);

    const task = store.getByKey("LP-1")!;
    expect(task.jiraKey).toBe("LP-1");
    expect(task.labelIds).toContain(lbl.id);
  });

  it("tasks with no labels get labelIds: []", () => {
    store.upsertFromJira([input()], NOW);
    const task = store.get(taskId("10001"))!;
    expect(task.labelIds).toEqual([]);
  });
});

describe("EngStore: transitionEmitter (LP-71)", () => {
  let store: EngStore;
  beforeEach(() => {
    store = new EngStore(":memory:");
  });

  it("emits { taskId, stage, status } after a successful CAS", () => {
    store.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    const received: unknown[] = [];
    store.transitionEmitter.on("transition", (evt) => received.push(evt));

    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ taskId: id, stage: "plan", status: "in_progress" });
  });

  it("does NOT emit when the CAS loses the race (idempotent re-apply is a no-op, not an emit)", () => {
    store.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    const received: unknown[] = [];
    store.transitionEmitter.on("transition", (evt) => received.push(evt));

    // Idempotent re-apply: task is already at plan:not_started, so no change → no emit.
    store.transition({ taskId: id, to: { stage: "plan", status: "not_started" }, actor: "user", ts: NOW });

    expect(received).toHaveLength(0);
  });

  it("does NOT emit when the gate is not approved", () => {
    store.upsertFromJira([input()], NOW);
    const id = taskId("10001");
    // Advance to the plan gate: plan:not_started → plan:in_progress → plan:completed_unapproved
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    store.transition({ taskId: id, to: { stage: "plan", status: "completed_unapproved" }, actor: "worker", ts: NOW });

    const received: unknown[] = [];
    store.transitionEmitter.on("transition", (evt) => received.push(evt));

    // Gate crossing without gateApproved — must be rejected without emitting.
    const outcome = store.transition({ taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", ts: NOW });
    expect(outcome.ok).toBe(false);
    expect(received).toHaveLength(0);
  });
});
