import { describe, expect, it } from "vitest";
import { EngStore } from "../../src/store/eng-store.ts";
import { Orchestrator, applyTransition } from "../../src/engineering/orchestrator.ts";
import { WorkerRunner } from "../../src/engineering/worker.ts";
import { branchNameFor, taskId } from "../../src/domain/eng-task.ts";
import type { EngTask, EngTaskInput } from "../../src/domain/eng-task.ts";
import type { AgentRunArgs, AgentRunResult, CommitResult, DeployOutcome, DeployRun, GithubPort, PrState, PullRequest, TestOutcome, WorktreeInfo } from "../../src/engineering/ports.ts";

const NOW = "2026-06-27T00:00:00Z";

function input(over: Partial<EngTaskInput> = {}): EngTaskInput {
  return {
    jiraKey: "LK-1",
    jiraId: "10001",
    jiraUrl: "https://x.atlassian.net/browse/LK-1",
    title: "Add a thing",
    description: "Do the thing.",
    acceptanceCriteria: "It works.",
    labels: [],
    components: [],
    assignee: "acct-1",
    jiraStatus: "To Do",
    repo: "karna/loopkeeper",
    defaultBranch: "main",
    ...over,
  };
}

class FakeAgentRunner {
  calls: AgentRunArgs[] = [];
  constructor(public ok = true) {}
  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    this.calls.push(args);
    return { ok: this.ok, sessionId: args.sessionId, finalText: `did ${args.stage}`, usdCents: 10, numTurns: 1, exitCode: this.ok ? 0 : 1, timedOut: false, ...(this.ok ? {} : { error: "agent failed" }) };
  }
}

class FakeWorkspace {
  async ensure(task: EngTask): Promise<WorktreeInfo> {
    return { path: `/wt/${task.jiraKey}`, branch: task.branch ?? branchNameFor(task.jiraKey, task.title) };
  }
  async commitAndPush(): Promise<CommitResult> {
    return { sha: "commitsha", pushed: true, filesChanged: 3, files: ["backend/src/server/routes/version.ts", "backend/src/server/app.ts", "backend/test/server/app.test.ts"] };
  }
  async branchLog(): Promise<string> {
    return "";
  }
  async remove(): Promise<void> {}
}

class FakeTester {
  constructor(public passing = true) {}
  async run(): Promise<TestOutcome> {
    return this.passing ? { passed: true, total: 10, failed: 0, summary: "10/10 passed" } : { passed: false, total: 10, failed: 2, summary: "2 failing" };
  }
}

class FakeGithub implements GithubPort {
  merged = false;
  async findOpenPr(): Promise<PullRequest | null> {
    return null;
  }
  async createPr(): Promise<PullRequest> {
    return { number: 7, url: "https://github.com/karna/loopkeeper/pull/7" };
  }
  async getPr(_repo: string, num: number): Promise<PrState> {
    return { number: num, url: "https://github.com/karna/loopkeeper/pull/7", reviewDecision: "APPROVED", merged: this.merged, comments: [] };
  }
  async merge(): Promise<{ sha: string; merged: boolean }> {
    this.merged = true;
    return { sha: "mergesha", merged: true };
  }
  deployRun: DeployRun | null = {
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/karna/loopkeeper/actions/runs/1",
    jobs: [
      { name: "verify", status: "completed", conclusion: "success" },
      { name: "deploy", status: "completed", conclusion: "success" },
    ],
  };
  async getDeployRun(): Promise<DeployRun | null> {
    return this.deployRun;
  }
}

class FakeDeployer {
  async redeploy(): Promise<DeployOutcome> {
    return { ok: true, sha: "deploysha", logTail: "REDEPLOY_OK deploysha" };
  }
}

function harness(opts: { tester?: FakeTester; runner?: FakeAgentRunner; deployEnabled?: boolean; deployMode?: "github-actions" | "ssh" } = {}) {
  const engStore = new EngStore(":memory:");
  const runner = opts.runner ?? new FakeAgentRunner();
  const tester = opts.tester ?? new FakeTester(true);
  const github = new FakeGithub();
  const orchestrator = new Orchestrator({
    engStore,
    agentRunner: runner,
    workspace: new FakeWorkspace(),
    tester,
    github,
    deployer: new FakeDeployer(),
    deployEnabled: opts.deployEnabled ?? true,
    deployMode: opts.deployMode ?? "ssh",
    deployEnv: "prod",
    now: () => NOW,
  });
  const worker = new WorkerRunner({ engStore, orchestrator, workerId: "w1", now: () => NOW, leaseMs: 60_000 });
  return { engStore, runner, tester, github, orchestrator, worker };
}

async function drain(worker: WorkerRunner): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (!(await worker.tick())) break;
  }
}

describe("orchestrator: full happy-path lifecycle through the worker", () => {
  it("drives plan → deploy with the three human gates", async () => {
    const { engStore, worker } = harness();
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("LK-1");

    // Prepare Plan (user, not a gate) → enqueues the plan job.
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "plan", status: "completed_unapproved" });
    expect(engStore.get(id)!.artifacts.plan?.text).toContain("did plan");
    expect(engStore.get(id)!.claudeSessionId).toBeTruthy();

    // Gate 1: approve plan → dev/test loop → proposed PR.
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "pr", status: "proposed" });
    expect(engStore.get(id)!.artifacts.test?.lastPassed).toBe(true);
    expect(engStore.get(id)!.artifacts.pr?.url).toBeNull(); // proposed, not opened
    // PR body is clean + structured: summary line, file list, test verdict, collapsible plan — not raw agent text.
    const prBody = engStore.get(id)!.artifacts.pr?.body ?? "";
    expect(prBody).toContain("## Changes");
    expect(prBody).toContain("backend/src/server/routes/version.ts");
    expect(prBody).toContain("## Tests");
    expect(prBody).toContain("<details>");
    expect(prBody).not.toContain("did dev"); // the raw agent finalText must NOT leak into the PR body

    // Gate 2: approve PR creation → PR opened → awaiting review.
    applyTransition(engStore, { taskId: id, to: { stage: "pr", status: "creating" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "review", status: "awaiting_review" });
    expect(engStore.get(id)!.artifacts.pr?.number).toBe(7);

    // pr-monitor sees comments, then approval (simulated as system transitions).
    engStore.setArtifact(id, { review: { comments: [{ externalId: "c1", author: "rev", body: "rename x", path: "a.ts", line: 1, receivedTs: NOW, resolution: null, resolvedTs: null, resolvedCommitSha: null }], approved: false, rounds: 0 } }, NOW);
    applyTransition(engStore, { taskId: id, to: { stage: "review", status: "comments_received" }, actor: "system", ts: NOW }, NOW);
    engStore.enqueue({ taskId: id, kind: "address_comments", dedupeKey: `${id}:address_comments` }, NOW);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "review", status: "awaiting_review" });
    expect(engStore.get(id)!.artifacts.review?.comments[0]?.resolution).toBeTruthy();

    // pr-monitor detects approval.
    applyTransition(engStore, { taskId: id, to: { stage: "review", status: "approved" }, actor: "system", ts: NOW }, NOW);
    applyTransition(engStore, { taskId: id, to: { stage: "merge", status: "ready" }, actor: "system", ts: NOW }, NOW);

    // Gate 3: approve merge → merged → deploy.
    applyTransition(engStore, { taskId: id, to: { stage: "merge", status: "merging" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "deploy", status: "deployed" });
    expect(engStore.get(id)!.artifacts.merge?.commitSha).toBe("mergesha");
    expect(engStore.get(id)!.artifacts.deploy?.status).toBe("deployed");

    // The audit log records the three gate crossings (gateApproved=1, actor user).
    const gateEvents = engStore.events(id).filter((e) => e.gateApproved);
    expect(gateEvents.map((e) => `${e.toStage}:${e.toStatus}`)).toEqual(["plan:approved", "pr:creating", "merge:merging"]);
    expect(gateEvents.every((e) => e.actor === "user")).toBe(true);
    expect(engStore.hasGatedMerge(id)).toBe(true);
  });
});

describe("orchestrator: budget escalation", () => {
  it("stops the dev/test loop at the iteration cap and escalates to blocked", async () => {
    const runner = new FakeAgentRunner();
    const { engStore, worker } = harness({ tester: new FakeTester(false), runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("LK-1");
    engStore.raiseBudget(id, { maxIterations: 2 }, NOW);

    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);

    const task = engStore.get(id)!;
    expect(task.status).toBe("blocked");
    expect(task.stage).toBe("test");
    expect(task.budget.iterationsUsed).toBe(2);
    expect(task.lastError).toContain("budget");
    // 1 plan run + 2 dev iterations = 3 agent runs.
    expect(runner.calls.filter((c) => c.stage === "dev")).toHaveLength(2);
  });

  it("a user can raise the budget and retry from blocked", async () => {
    const { engStore, worker } = harness({ tester: new FakeTester(false) });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("LK-1");
    engStore.raiseBudget(id, { maxIterations: 1 }, NOW);
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);
    expect(engStore.get(id)!.status).toBe("blocked");

    // Retry: raise the cap, resume to dev, re-enqueue.
    engStore.raiseBudget(id, { maxIterations: 3 }, NOW);
    const ok = applyTransition(engStore, { taskId: id, to: { stage: "dev", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    expect(ok.ok).toBe(true);
    engStore.enqueue({ taskId: id, kind: "dev_test", dedupeKey: `${id}:dev_test` }, NOW);
    await drain(worker);
    // Still failing, but now blocked at the higher cap (3 total iterations).
    expect(engStore.get(id)!.budget.iterationsUsed).toBe(3);
  });
});

describe("worker: cancel-watcher integration", () => {
  it("does not escalate when a task is cancelled mid-job (already blocked by cancel route)", async () => {
    // Simulate the cancel route setting cancel_pending + blocked before/during job execution.
    // The fake runner succeeds but the task is already blocked — escalate must NOT overwrite it.
    const { engStore, worker } = harness();
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("LK-1");

    // Drive to plan:in_progress and enqueue a plan job.
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    // Simulate the cancel route: set cancel_pending + transition to blocked + cancel queued jobs.
    engStore.setCancelPending(id, NOW);
    engStore.cancelJobsForTask(id, NOW);
    engStore.transition({ taskId: id, to: { stage: "plan", status: "blocked" }, actor: "system", note: "user cancel", ts: NOW });
    engStore.setProgress(id, { lastError: "Cancelled by user." }, NOW);

    // No jobs remain in the queue — tick does nothing.
    expect(await worker.tick()).toBe(false);
    // Task stays blocked with the cancel error.
    const task = engStore.get(id)!;
    expect(task.status).toBe("blocked");
    expect(task.lastError).toBe("Cancelled by user.");
  });

  it("cancel registry: kill callback is registered during the run and cleaned up after", async () => {
    // Verify the orchestrator populates cancelRegistry during agentRunner.run() and deletes on completion.
    const cancelRegistry = new Map<string, () => void>();
    const timeline: string[] = [];
    const engStore = new EngStore(":memory:");
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("LK-1");

    // Fake runner that checks the registry is populated during the run (before cleanup).
    class CapturingRunner {
      async run(args: AgentRunArgs): Promise<AgentRunResult> {
        if (args.onCancelRegistered) {
          args.onCancelRegistered(() => {}); // register a no-op kill
        }
        // Registry must be set synchronously by onCancelRegistered before we reach this line.
        if (cancelRegistry.has(args.taskId)) timeline.push("registered");
        return { ok: true, sessionId: args.sessionId, finalText: "done", usdCents: 5, numTurns: 1, exitCode: 0, timedOut: false };
      }
    }
    const orchestrator = new Orchestrator({
      engStore,
      agentRunner: new CapturingRunner(),
      workspace: new FakeWorkspace(),
      tester: new FakeTester(true),
      github: new FakeGithub(),
      deployer: new FakeDeployer(),
      deployEnabled: false,
      deployMode: "ssh",
      deployEnv: "prod",
      now: () => NOW,
      cancelRegistry,
    });

    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    const job = engStore.claimNext("w1", NOW, "2030-01-01T00:00:00Z")!;
    engStore.markJobRunning(job.id, NOW);
    await orchestrator.runJob(job);
    // Registry is cleaned up after the run.
    expect(cancelRegistry.has(id)).toBe(false);
    // Kill was registered during the run.
    expect(timeline).toEqual(["registered"]);
  });
});

describe("orchestrator: deploy disabled is a no-op", () => {
  it("leaves the task at merged when deploy is disabled", async () => {
    const { engStore, worker } = harness({ deployEnabled: false });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("LK-1");
    // Jump to merge:merging via the documented path is long; seed straight to merging for this unit.
    engStore.upsertFromJira([input()], NOW);
    // Walk minimal path to merge:merging.
    const path: Array<{ stage: EngTask["stage"]; status: EngTask["status"]; gate?: boolean; actor: "user" | "system" }> = [
      { stage: "plan", status: "in_progress", actor: "user" },
      { stage: "plan", status: "completed_unapproved", actor: "system" },
      { stage: "plan", status: "approved", gate: true, actor: "user" },
      { stage: "dev", status: "in_progress", actor: "system" },
      { stage: "dev", status: "done", actor: "system" },
      { stage: "test", status: "in_progress", actor: "system" },
      { stage: "test", status: "passed", actor: "system" },
      { stage: "pr", status: "proposed", actor: "system" },
      { stage: "pr", status: "creating", gate: true, actor: "user" },
      { stage: "pr", status: "created", actor: "system" },
      { stage: "review", status: "awaiting_review", actor: "system" },
      { stage: "review", status: "approved", actor: "system" },
      { stage: "merge", status: "ready", actor: "system" },
      { stage: "merge", status: "merging", gate: true, actor: "user" },
    ];
    engStore.setArtifact(id, { pr: { title: "t", body: "b", diffSummary: "", url: "u", number: 7, proposedTs: NOW, createdTs: NOW, approvedBy: null } }, NOW);
    for (const s of path) {
      const r = engStore.transition({ taskId: id, to: { stage: s.stage, status: s.status }, actor: s.actor, ...(s.gate ? { gateApproved: true } : {}), ts: NOW });
      expect(r.ok, `${s.stage}:${s.status}`).toBe(true);
    }
    engStore.enqueue({ taskId: id, kind: "merge", dedupeKey: `${id}:merge` }, NOW);
    await drain(worker);
    // Merged, then the deploy job runs but is a no-op (disabled) → stays at merge:merged.
    expect(engStore.get(id)).toMatchObject({ stage: "merge", status: "merged" });
  });
});

describe("orchestrator: github-actions deploy mode observes (no SSH)", () => {
  it("advances to deploy:deploying and records the merge sha; the run is finalized by the monitor", async () => {
    const { engStore, worker } = harness({ deployMode: "github-actions" });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("LK-1");
    const path: Array<{ stage: EngTask["stage"]; status: EngTask["status"]; gate?: boolean; actor: "user" | "system" }> = [
      { stage: "plan", status: "in_progress", actor: "user" },
      { stage: "plan", status: "completed_unapproved", actor: "system" },
      { stage: "plan", status: "approved", gate: true, actor: "user" },
      { stage: "dev", status: "in_progress", actor: "system" },
      { stage: "dev", status: "done", actor: "system" },
      { stage: "test", status: "in_progress", actor: "system" },
      { stage: "test", status: "passed", actor: "system" },
      { stage: "pr", status: "proposed", actor: "system" },
      { stage: "pr", status: "creating", gate: true, actor: "user" },
      { stage: "pr", status: "created", actor: "system" },
      { stage: "review", status: "awaiting_review", actor: "system" },
      { stage: "review", status: "approved", actor: "system" },
      { stage: "merge", status: "ready", actor: "system" },
      { stage: "merge", status: "merging", gate: true, actor: "user" },
    ];
    engStore.setArtifact(id, { pr: { title: "t", body: "b", diffSummary: "", url: "u", number: 7, proposedTs: NOW, createdTs: NOW, approvedBy: null } }, NOW);
    for (const s of path) {
      const r = engStore.transition({ taskId: id, to: { stage: s.stage, status: s.status }, actor: s.actor, ...(s.gate ? { gateApproved: true } : {}), ts: NOW });
      expect(r.ok, `${s.stage}:${s.status}`).toBe(true);
    }
    engStore.enqueue({ taskId: id, kind: "merge", dedupeKey: `${id}:merge` }, NOW);
    await drain(worker);
    // Merged → deploy job → observe-mode: deploying (NOT deployed — GitHub Actions + the monitor finalize it).
    expect(engStore.get(id)).toMatchObject({ stage: "deploy", status: "deploying" });
    expect(engStore.get(id)!.artifacts.merge?.commitSha).toBe("mergesha");
    expect(engStore.get(id)!.artifacts.deploy).toMatchObject({ status: "deploying", commitSha: "mergesha" });
  });
});
