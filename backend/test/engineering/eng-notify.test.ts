import { beforeEach, describe, expect, it } from "vitest";
import { EngStore } from "../../src/store/eng-store.ts";
import { EngNotifier } from "../../src/engineering/eng-notify.ts";
import { FakePushSender } from "../../src/push/push-sender.ts";
import { taskId } from "../../src/domain/eng-task.ts";
import type { EngTaskInput } from "../../src/domain/eng-task.ts";

const NOW = "2026-06-27T00:00:00Z";

function input(jiraKey: string, jiraId = "1"): EngTaskInput {
  return { jiraKey, jiraId, jiraUrl: "u", title: `Task ${jiraKey}`, description: "", acceptanceCriteria: null, labels: [], components: [], assignee: "acct-1", jiraStatus: "To Do", repo: "karna/loopkeeper", defaultBranch: "main" };
}

describe("EngNotifier", () => {
  let store: EngStore;
  let push: FakePushSender;
  beforeEach(() => {
    store = new EngStore(":memory:");
    push = new FakePushSender();
  });

  it("pushes once per needs-human status, deep-linking by taskId", async () => {
    store.upsertFromJira([input("LK-1", "10001")], NOW);
    const id = taskId("10001");
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    store.transition({ taskId: id, to: { stage: "plan", status: "completed_unapproved" }, actor: "agent", ts: NOW });

    const notifier = new EngNotifier(store, push, () => ["devtok"]);
    const first = await notifier.run();
    expect(first.sent).toBe(1);
    expect(push.sent[0]?.payload).toMatchObject({ taskId: id, stage: "plan", title: "Plan ready · LK-1" });

    // Second run: same status → no duplicate push.
    expect((await notifier.run()).sent).toBe(0);

    // Advance to a new needs-human status → pushes again.
    store.transition({ taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW });
    store.setArtifact(id, { pr: { title: "LK-1: do it", body: "b", diffSummary: "", url: null, number: null, proposedTs: NOW, createdTs: null, approvedBy: null, selfReview: null } }, NOW);
    // Drive to pr:proposed (needs-human).
    for (const s of [
      { stage: "dev", status: "in_progress" },
      { stage: "dev", status: "done" },
      { stage: "test", status: "in_progress" },
      { stage: "test", status: "passed" },
      { stage: "pr", status: "proposed" },
    ] as const) {
      store.transition({ taskId: id, to: s, actor: "system", ts: NOW });
    }
    expect((await notifier.run()).sent).toBe(1);
    expect(push.sent.at(-1)?.payload.title).toBe("PR ready to open · LK-1");
  });

  it("does not push for non-needs-human tasks", async () => {
    store.upsertFromJira([input("LK-9", "10009")], NOW); // plan:not_started
    const notifier = new EngNotifier(store, push, () => ["devtok"]);
    expect((await notifier.run()).sent).toBe(0);
  });

  it("includes quality score in plan-ready notification title when present (LP-101)", async () => {
    store.upsertFromJira([input("LK-2", "10002")], NOW);
    const id = taskId("10002");
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    store.setArtifact(id, { plan: { text: "the plan", editedText: null, sessionId: null, revision: 0, generatedTs: NOW, approvedTs: null, approvedBy: null, qualityScore: 0.87 } }, NOW);
    store.transition({ taskId: id, to: { stage: "plan", status: "completed_unapproved" }, actor: "agent", ts: NOW });

    const notifier = new EngNotifier(store, push, () => ["devtok"]);
    await notifier.run();
    expect(push.sent[0]?.payload.title).toBe("Plan ready (0.87) · LK-2");
  });

  it("omits score from plan-ready title when judge did not run (LP-101)", async () => {
    store.upsertFromJira([input("LK-3", "10003")], NOW);
    const id = taskId("10003");
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    store.transition({ taskId: id, to: { stage: "plan", status: "completed_unapproved" }, actor: "agent", ts: NOW });

    const notifier = new EngNotifier(store, push, () => ["devtok"]);
    await notifier.run();
    expect(push.sent[0]?.payload.title).toBe("Plan ready · LK-3");
  });
});
