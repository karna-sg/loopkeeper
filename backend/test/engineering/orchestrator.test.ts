import { describe, expect, it } from "vitest";
import { EngStore } from "../../src/store/eng-store.ts";
import { Orchestrator, applyTransition } from "../../src/engineering/orchestrator.ts";
import { WorkerRunner } from "../../src/engineering/worker.ts";
import { branchNameFor, taskId } from "../../src/domain/eng-task.ts";
import type { EngTask, EngTaskInput } from "../../src/domain/eng-task.ts";
import { DiffGuardError } from "../../src/engineering/diff-guard.ts";
import type { AgentRunArgs, AgentRunResult, CommitResult, DeployOutcome, DeployRun, DiffFile, GithubPort, PrState, PullRequest, TestOutcome, Workspace, WorktreeInfo } from "../../src/engineering/ports.ts";

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
  async revert(_task: EngTask, sha: string): Promise<{ revertSha: string; branch: string }> {
    return { revertSha: `revert-${sha}`, branch: "rollback/lk-1" };
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
    id: 1,
    jobs: [
      { id: 1, name: "verify", status: "completed", conclusion: "success" },
      { id: 2, name: "deploy", status: "completed", conclusion: "success" },
    ],
  };
  async getDeployRun(): Promise<DeployRun | null> {
    return this.deployRun;
  }
  async getDiff(): Promise<DiffFile[]> {
    return [];
  }
  async getRunLog(): Promise<string | null> {
    return null;
  }
  async rerunDeploy(): Promise<void> {}
}

class FakeDeployer {
  async redeploy(): Promise<DeployOutcome> {
    return { ok: true, sha: "deploysha", logTail: "REDEPLOY_OK deploysha" };
  }
}

function harness(opts: { tester?: FakeTester; runner?: FakeAgentRunner; workspace?: Workspace; deployEnabled?: boolean; deployMode?: "github-actions" | "ssh"; verifyUrl?: string | null } = {}) {
  const engStore = new EngStore(":memory:");
  const runner = opts.runner ?? new FakeAgentRunner();
  const tester = opts.tester ?? new FakeTester(true);
  const github = new FakeGithub();
  const orchestrator = new Orchestrator({
    engStore,
    agentRunner: runner,
    workspace: opts.workspace ?? new FakeWorkspace(),
    tester,
    github,
    deployer: new FakeDeployer(),
    deployEnabled: opts.deployEnabled ?? true,
    deployMode: opts.deployMode ?? "ssh",
    deployEnv: "prod",
    verifyUrl: opts.verifyUrl ?? null,
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
    const id = taskId("10001");

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

    // Gate 3: approve merge → merged → deploy → auto post-deploy verify.
    applyTransition(engStore, { taskId: id, to: { stage: "merge", status: "merging" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);
    // Deploy succeeded → verify ran (no verify URL → smoke skipped, healthOk) → awaiting human sign-off.
    expect(engStore.get(id)).toMatchObject({ stage: "verify", status: "awaiting_review" });
    expect(engStore.get(id)!.artifacts.merge?.commitSha).toBe("mergesha");
    expect(engStore.get(id)!.artifacts.deploy?.status).toBe("deployed");
    expect(engStore.get(id)!.artifacts.verify?.deployedSha).toBeTruthy();

    // Gate 4: confirm the deployed change is good → terminal.
    applyTransition(engStore, { taskId: id, to: { stage: "verify", status: "verified" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    expect(engStore.get(id)).toMatchObject({ stage: "verify", status: "verified" });

    // The audit log records the four gate crossings (gateApproved=1, actor user).
    const gateEvents = engStore.events(id).filter((e) => e.gateApproved);
    expect(gateEvents.map((e) => `${e.toStage}:${e.toStatus}`)).toEqual(["plan:approved", "pr:creating", "merge:merging", "verify:verified"]);
    expect(gateEvents.every((e) => e.actor === "user")).toBe(true);
    expect(engStore.hasGatedMerge(id)).toBe(true);
  });
});

describe("orchestrator: budget escalation", () => {
  it("stops the dev/test loop at the iteration cap and escalates to blocked", async () => {
    const runner = new FakeAgentRunner();
    const { engStore, worker } = harness({ tester: new FakeTester(false), runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");
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
    const id = taskId("10001");
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
    const id = taskId("10001");

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
    const id = taskId("10001");

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
      verifyUrl: null,
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
    const id = taskId("10001");
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
    const id = taskId("10001");
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

describe("orchestrator: verify + rollback stages", () => {
  const PATH_TO_MERGING: Array<{ stage: EngTask["stage"]; status: EngTask["status"]; gate?: boolean; actor: "user" | "system" }> = [
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
  function seedToMerging(engStore: EngStore, id: string): void {
    engStore.setArtifact(id, { pr: { title: "t", body: "b", diffSummary: "", url: "u", number: 7, proposedTs: NOW, createdTs: NOW, approvedBy: null } }, NOW);
    for (const s of PATH_TO_MERGING) {
      const r = engStore.transition({ taskId: id, to: { stage: s.stage, status: s.status }, actor: s.actor, ...(s.gate ? { gateApproved: true } : {}), ts: NOW });
      expect(r.ok, `${s.stage}:${s.status}`).toBe(true);
    }
    engStore.enqueue({ taskId: id, kind: "merge", dedupeKey: `${id}:merge` }, NOW);
  }

  it("auto-runs verify after deploy (no verify URL → awaiting manual sign-off)", async () => {
    const { engStore, worker } = harness(); // ssh deploy mode, verifyUrl null
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");
    seedToMerging(engStore, id);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "verify", status: "awaiting_review" });
    expect(engStore.get(id)!.artifacts.verify?.healthOk).toBe(true);
  });

  it("routes a failed post-deploy smoke to verify:failed", async () => {
    const { engStore, worker } = harness({ verifyUrl: "http://127.0.0.1:1/healthz" }); // refused → smoke fails
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");
    seedToMerging(engStore, id);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "verify", status: "failed" });
    expect(engStore.get(id)!.artifacts.verify?.healthOk).toBe(false);
  });

  it("rolls back via a revert PR → rolled_back", async () => {
    const { engStore, worker } = harness();
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");
    seedToMerging(engStore, id);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "verify", status: "awaiting_review" });
    // User rolls back (arm → gated execute → enqueue).
    engStore.transition({ taskId: id, to: { stage: "rollback", status: "ready" }, actor: "user", ts: NOW });
    engStore.transition({ taskId: id, to: { stage: "rollback", status: "in_progress" }, actor: "user", gateApproved: true, ts: NOW });
    engStore.enqueue({ taskId: id, kind: "rollback", dedupeKey: `${id}:rollback` }, NOW);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "rollback", status: "rolled_back" });
    const rb = engStore.get(id)!.artifacts.rollback!;
    expect(rb.targetSha).toBe("mergesha");
    expect(rb.revertSha).toContain("revert-");
    expect(rb.prUrl).toBeTruthy();
  });
});

describe("orchestrator: build fix-forward (seedFix)", () => {
  const PATH_TO_DEPLOY_FAILED: Array<[string, string, "user" | "system", boolean]> = [
    ["plan", "in_progress", "user", false], ["plan", "completed_unapproved", "system", false], ["plan", "approved", "user", true],
    ["dev", "in_progress", "system", false], ["dev", "done", "system", false],
    ["test", "in_progress", "system", false], ["test", "passed", "system", false],
    ["pr", "proposed", "system", false], ["pr", "creating", "user", true], ["pr", "created", "system", false],
    ["review", "awaiting_review", "system", false], ["review", "approved", "system", false],
    ["merge", "ready", "system", false], ["merge", "merging", "user", true], ["merge", "merged", "system", false],
    ["deploy", "deploying", "system", false], ["deploy", "failed", "system", false],
  ];

  it("re-enters dev seeded with the CI error and drives back to a proposed PR", async () => {
    const runner = new FakeAgentRunner();
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");
    engStore.setArtifact(id, { merge: { commitSha: "mergesha", mergedTs: NOW, mergedBy: null, method: "squash" } }, NOW);
    for (const [stage, status, actor, gate] of PATH_TO_DEPLOY_FAILED) {
      engStore.transition({ taskId: id, to: { stage: stage as never, status: status as never }, actor, gateApproved: gate, ts: NOW });
    }
    engStore.setDeployArtifact(id, { env: "prod", status: "failed", startedTs: NOW, finishedTs: NOW, commitSha: "mergesha", runUrl: "u", ci: "failure", cd: null, failureKind: "ci_build", ciError: "error TS2420 missing getDiff on FakeGithub", logTail: null }, NOW);

    // fix-build: back to dev + a seedFix dev_test job (what POST /tasks/:id/fix-build does).
    engStore.transition({ taskId: id, to: { stage: "dev", status: "in_progress" }, actor: "user", ts: NOW });
    engStore.enqueue({ taskId: id, kind: "dev_test", payload: { seedFix: true }, dedupeKey: `${id}:dev_test` }, NOW);
    await drain(worker);

    const firstDev = runner.calls.find((c) => c.stage === "dev");
    expect(firstDev?.prompt).toContain("TS2420"); // seeded with the captured CI error, not a re-implementation
    expect(engStore.get(id)).toMatchObject({ stage: "pr", status: "proposed" }); // local verify passed → re-proposes
  });
});

describe("orchestrator: logPath propagation (LP-42)", () => {
  it("persists logPath from plan runner result to eng_agent_runs", async () => {
    const LOG_PATH = "/var/log/lk/plan-sess-abc.jsonl";
    class LogPathRunner {
      async run(args: AgentRunArgs): Promise<AgentRunResult> {
        return { ok: true, sessionId: args.sessionId, finalText: "plan done", usdCents: 5, numTurns: 1, exitCode: 0, timedOut: false, logPath: LOG_PATH };
      }
    }
    const engStore = new EngStore(":memory:");
    const orchestrator = new Orchestrator({
      engStore,
      agentRunner: new LogPathRunner(),
      workspace: new FakeWorkspace(),
      tester: new FakeTester(true),
      github: new FakeGithub(),
      deployer: new FakeDeployer(),
      deployEnabled: false,
      deployMode: "ssh",
      deployEnv: "prod",
      verifyUrl: null,
      now: () => NOW,
    });
    const worker = new WorkerRunner({ engStore, orchestrator, workerId: "w1", now: () => NOW, leaseMs: 60_000 });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);

    const runs = engStore.agentRuns(id);
    // The plan stage produces two runs: the plan generation run and the quality-judge run (LP-101).
    const planRun = runs.find((r) => r.logPath === LOG_PATH);
    expect(planRun).toBeDefined();
    expect(planRun!.logPath).toBe(LOG_PATH);
  });

  it("persists logPath from dev runner result to eng_agent_runs", async () => {
    const LOG_PATH = "/var/log/lk/dev-sess-xyz.jsonl";
    class LogPathRunner {
      async run(args: AgentRunArgs): Promise<AgentRunResult> {
        return { ok: true, sessionId: args.sessionId, finalText: "dev done", usdCents: 5, numTurns: 1, exitCode: 0, timedOut: false, logPath: LOG_PATH };
      }
    }
    const engStore = new EngStore(":memory:");
    const orchestrator = new Orchestrator({
      engStore,
      agentRunner: new LogPathRunner(),
      workspace: new FakeWorkspace(),
      tester: new FakeTester(true),
      github: new FakeGithub(),
      deployer: new FakeDeployer(),
      deployEnabled: false,
      deployMode: "ssh",
      deployEnv: "prod",
      verifyUrl: null,
      now: () => NOW,
    });
    const worker = new WorkerRunner({ engStore, orchestrator, workerId: "w1", now: () => NOW, leaseMs: 60_000 });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);

    const runs = engStore.agentRuns(id);
    const devRun = runs.find((r) => r.stage === "dev");
    expect(devRun?.logPath).toBe(LOG_PATH);
  });

  it("activity API returns lines when logPath is persisted (end-to-end store check)", async () => {
    // This verifies the full chain: logPath in AgentRunResult → stored in DB → activity endpoint can read it.
    // (Activity endpoint logic is tested in app.test.ts; this test validates the DB side of the fix.)
    const LOG_PATH = "/tmp/plan-sess-e2e.jsonl";
    const engStore = new EngStore(":memory:");
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    const runId = engStore.startAgentRun({ taskId: id, stage: "plan", sessionId: "sess-e2e", iteration: 1, startedTs: NOW });
    engStore.finishAgentRun(runId, { status: "succeeded", finishedTs: NOW, exitCode: 0, usdCents: 5, numTurns: 2, resultSummary: "done", logPath: LOG_PATH });

    const runs = engStore.agentRuns(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.logPath).toBe(LOG_PATH);
  });
});

describe("orchestrator: per-task model selection (LP-27)", () => {
  it("passes null model to the runner when no per-task override is set", async () => {
    const runner = new FakeAgentRunner();
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);

    const planCall = runner.calls.find((c) => c.stage === "plan");
    expect(planCall?.model).toBeNull();
  });

  it("passes the per-task claudeModel to the runner for all agent stages", async () => {
    const runner = new FakeAgentRunner();
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");
    engStore.setModel(id, "claude-opus-4-8", NOW);

    // plan stage
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);
    const planCall = runner.calls.find((c) => c.stage === "plan");
    expect(planCall?.model).toBe("claude-opus-4-8");

    // dev stage
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);
    const devCall = runner.calls.find((c) => c.stage === "dev");
    expect(devCall?.model).toBe("claude-opus-4-8");
  });

  it("picks up a model change between plan and dev runs", async () => {
    const runner = new FakeAgentRunner();
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    // Plan with sonnet
    engStore.setModel(id, "claude-sonnet-4-6", NOW);
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);
    expect(runner.calls.find((c) => c.stage === "plan")?.model).toBe("claude-sonnet-4-6");

    // Switch to opus before approving — dev should pick it up
    engStore.setModel(id, "claude-opus-4-8", NOW);
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);
    expect(runner.calls.find((c) => c.stage === "dev")?.model).toBe("claude-opus-4-8");
  });
});

// ─── LP-33: AC check at the PR gate ──────────────────────────────────────────

class AcCheckRunner {
  ok = true; // required to match FakeAgentRunner's structural type for harness()
  calls: AgentRunArgs[] = [];
  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    this.calls.push(args);
    if (args.stage === "pr") {
      const json = JSON.stringify([
        { criterion: "It works.", pass: true, evidence: "The implementation satisfies the requirement." },
      ]);
      return { ok: true, sessionId: args.sessionId, finalText: json, usdCents: 5, numTurns: 1, exitCode: 0, timedOut: false };
    }
    return { ok: true, sessionId: args.sessionId, finalText: `did ${args.stage}`, usdCents: 10, numTurns: 1, exitCode: 0, timedOut: false };
  }
}

async function advanceToPrProposed(engStore: EngStore, worker: WorkerRunner, id: string): Promise<void> {
  applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
  await drain(worker);
  applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
  await drain(worker);
}

describe("orchestrator: AC check on pr:proposed (LP-33)", () => {
  it("stores acCheck artifact when tests pass", async () => {
    const runner = new AcCheckRunner();
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input({ acceptanceCriteria: "It works." })], NOW);
    const id = taskId("10001");

    await advanceToPrProposed(engStore, worker, id);

    expect(engStore.get(id)).toMatchObject({ stage: "pr", status: "proposed" });
    const acCheck = engStore.get(id)!.artifacts.acCheck;
    expect(acCheck).not.toBeNull();
    expect(acCheck).toHaveLength(1);
    const item = acCheck![0];
    expect(item).toBeDefined();
    expect(item).toMatchObject({ criterion: "It works.", pass: true });
    expect(item!.evidence).toBeTruthy();
  });

  it("AC check run is always fresh (resume: false, stage: pr)", async () => {
    const runner = new AcCheckRunner();
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    await advanceToPrProposed(engStore, worker, id);

    const prRun = runner.calls.find((c) => c.stage === "pr");
    expect(prRun).toBeDefined();
    expect(prRun!.resume).toBe(false);
  });

  it("advances to pr:proposed even when AC check returns malformed JSON", async () => {
    // Default FakeAgentRunner returns "did pr" for the pr stage — not valid JSON.
    const { engStore, worker } = harness();
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    await advanceToPrProposed(engStore, worker, id);

    expect(engStore.get(id)).toMatchObject({ stage: "pr", status: "proposed" });
    expect(engStore.get(id)!.artifacts.acCheck).toEqual([]);
  });

  it("bills the AC check run to the task budget", async () => {
    const runner = new AcCheckRunner();
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");
    const budgetBefore = engStore.get(id)!.budget.usdCentsUsed;

    await advanceToPrProposed(engStore, worker, id);

    const budgetAfter = engStore.get(id)!.budget.usdCentsUsed;
    // plan (10¢) + dev (10¢) + ac-check (5¢) = 25¢ total; at minimum more than plan alone
    expect(budgetAfter).toBeGreaterThan(budgetBefore + 10);
  });

  it("stores empty acCheck when task has no acceptanceCriteria", async () => {
    const { engStore, worker } = harness();
    engStore.upsertFromJira([input({ acceptanceCriteria: null })], NOW);
    const id = taskId("10001");

    await advanceToPrProposed(engStore, worker, id);

    expect(engStore.get(id)).toMatchObject({ stage: "pr", status: "proposed" });
    // FakeAgentRunner returns non-JSON "did pr", so parse fails gracefully → []
    expect(engStore.get(id)!.artifacts.acCheck).toEqual([]);
  });
});

// ─── LP-101: inline plan quality judge ───────────────────────────────────────

/** Runner whose second call (the judge) returns a valid JSON score. */
class PlanJudgeRunner {
  ok = true; // required to match FakeAgentRunner's structural type for harness()
  calls: AgentRunArgs[] = [];
  readonly #judgeScore: number;
  readonly #judgeThrows: boolean;
  readonly #judgeJson: string | null;
  constructor(opts: { score?: number; throws?: boolean; json?: string } = {}) {
    this.#judgeScore = opts.score ?? 0.85;
    this.#judgeThrows = opts.throws ?? false;
    this.#judgeJson = opts.json ?? null;
  }
  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    this.calls.push(args);
    const planCalls = this.calls.filter((c) => c.stage === "plan");
    // First plan call = actual plan generation; subsequent plan calls = judge.
    if (planCalls.length >= 2) {
      if (this.#judgeThrows) throw new Error("judge exploded");
      const json = this.#judgeJson ?? JSON.stringify({ score: this.#judgeScore, reasons: "good coverage" });
      return { ok: true, sessionId: args.sessionId, finalText: json, usdCents: 1, numTurns: 1, exitCode: 0, timedOut: false };
    }
    return { ok: true, sessionId: args.sessionId, finalText: `did ${args.stage}`, usdCents: 10, numTurns: 1, exitCode: 0, timedOut: false };
  }
}

async function advanceToPlanCompleted(engStore: EngStore, worker: WorkerRunner, id: string): Promise<void> {
  applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
  await drain(worker);
}

describe("orchestrator: plan quality judge (LP-101)", () => {
  it("plan flow completes unchanged when judge throws", async () => {
    const runner = new PlanJudgeRunner({ throws: true });
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    await advanceToPlanCompleted(engStore, worker, id);

    expect(engStore.get(id)).toMatchObject({ stage: "plan", status: "completed_unapproved" });
    expect(engStore.get(id)!.artifacts.plan?.qualityScore).toBeNull();
  });

  it("persists score on plan artifact when judge succeeds", async () => {
    const runner = new PlanJudgeRunner({ score: 0.85 });
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    await advanceToPlanCompleted(engStore, worker, id);

    expect(engStore.get(id)).toMatchObject({ stage: "plan", status: "completed_unapproved" });
    expect(engStore.get(id)!.artifacts.plan?.qualityScore).toBe(0.85);
  });

  it("score is null and plan advances when judge returns malformed JSON", async () => {
    const runner = new PlanJudgeRunner({ json: "not valid json" });
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    await advanceToPlanCompleted(engStore, worker, id);

    expect(engStore.get(id)).toMatchObject({ stage: "plan", status: "completed_unapproved" });
    expect(engStore.get(id)!.artifacts.plan?.qualityScore).toBeNull();
  });

  it("clamps out-of-range scores to [0,1]", async () => {
    const runner = new PlanJudgeRunner({ json: JSON.stringify({ score: 1.5, reasons: "too high" }) });
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    await advanceToPlanCompleted(engStore, worker, id);

    expect(engStore.get(id)!.artifacts.plan?.qualityScore).toBe(1);
  });

  it("judge uses a fresh session and Haiku model, never resumes", async () => {
    const runner = new PlanJudgeRunner({ score: 0.9 });
    const { engStore, worker } = harness({ runner });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    await advanceToPlanCompleted(engStore, worker, id);

    const judgeCall = runner.calls.filter((c) => c.stage === "plan")[1];
    expect(judgeCall).toBeDefined();
    expect(judgeCall!.resume).toBe(false);
    expect(judgeCall!.model).toBe("claude-haiku-4-5-20251001");
  });
});

// ─── LP-53: DiffGuard secret-scan + dependency-change flag before commitAndPush ───────────────

/** Workspace whose commitAndPush hard-fails (as GitWorkspace does on a planted secret). */
class SecretBlockingWorkspace extends FakeWorkspace {
  override async commitAndPush(): Promise<CommitResult> {
    throw new DiffGuardError([{ path: "backend/src/config.ts", reason: "secret-shaped staged content" }]);
  }
}

/** Workspace whose commitAndPush returns a soft dependency-change flag (a manifest changed). */
class DepFlaggingWorkspace extends FakeWorkspace {
  override async commitAndPush(): Promise<CommitResult> {
    return { sha: "commitsha", pushed: true, filesChanged: 1, files: ["package.json"], diffGuard: { newDeps: 2, flaggedPaths: ["package.json"] } };
  }
}

describe("orchestrator: DiffGuard (LP-53)", () => {
  it("a planted secret skips the commit and escalates the task to blocked (actor system)", async () => {
    const { engStore, worker } = harness({ workspace: new SecretBlockingWorkspace() });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);

    const task = engStore.get(id)!;
    // Commit skipped → never reached a proposed PR; blocked in the stage it occurred in (dev).
    expect(task.status).toBe("blocked");
    expect(task.stage).toBe("dev");
    expect(task.artifacts.pr).toBeNull();
    // The escalation note is redacted and attributed to the system actor (no gate crossed).
    expect(task.lastError).toContain("DiffGuard");
    const blockEvent = engStore.events(id).find((e) => e.toStatus === "blocked");
    expect(blockEvent?.actor).toBe("system");
  });

  it("persists a soft dep-change flag onto the dev and PR artifacts (merge-gate surface)", async () => {
    const { engStore, worker } = harness({ workspace: new DepFlaggingWorkspace() });
    engStore.upsertFromJira([input()], NOW);
    const id = taskId("10001");

    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW }, NOW);
    await drain(worker);
    applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);

    // Soft flag → commit proceeds → proposed PR, with the flag on both artifacts.
    expect(engStore.get(id)).toMatchObject({ stage: "pr", status: "proposed" });
    expect(engStore.get(id)!.artifacts.dev?.diffGuard).toEqual({ newDeps: 2, flaggedPaths: ["package.json"] });
    expect(engStore.get(id)!.artifacts.pr?.diffGuard).toEqual({ newDeps: 2, flaggedPaths: ["package.json"] });

    // The flag survives PR creation (Gate 2 → create_pr rebuilds the PR artifact).
    applyTransition(engStore, { taskId: id, to: { stage: "pr", status: "creating" }, actor: "user", gateApproved: true, ts: NOW }, NOW);
    await drain(worker);
    expect(engStore.get(id)).toMatchObject({ stage: "review", status: "awaiting_review" });
    expect(engStore.get(id)!.artifacts.pr?.diffGuard).toEqual({ newDeps: 2, flaggedPaths: ["package.json"] });
  });
});
