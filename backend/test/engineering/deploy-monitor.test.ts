import { describe, expect, it } from "vitest";
import { EngStore } from "../../src/store/eng-store.ts";
import { DeployMonitor, deployStatusFromRun, jobConclusion } from "../../src/engineering/deploy-monitor.ts";
import { taskId } from "../../src/domain/eng-task.ts";
import type { EngTaskInput } from "../../src/domain/eng-task.ts";
import type { DeployRun, GithubPort, PrState, PullRequest } from "../../src/engineering/ports.ts";

const NOW = "2026-06-28T00:00:00Z";

function input(): EngTaskInput {
  return {
    jiraKey: "LK-1", jiraId: "10001", jiraUrl: "https://x/browse/LK-1", title: "t", description: "d",
    acceptanceCriteria: "ac", labels: [], components: [], assignee: "acct-1", jiraStatus: "To Do",
    repo: "karna/loopkeeper", defaultBranch: "main",
  };
}

/** Walk a task to deploy:deploying with a recorded merge sha + deploy artifact (mirrors the real flow). */
function seedDeploying(engStore: EngStore, sha: string, startedTs = NOW): string {
  engStore.upsertFromJira([input()], NOW);
  const id = taskId("LK-1");
  const path: Array<[string, string, "user" | "system", boolean]> = [
    ["plan", "in_progress", "user", false], ["plan", "completed_unapproved", "system", false], ["plan", "approved", "user", true],
    ["dev", "in_progress", "system", false], ["dev", "done", "system", false],
    ["test", "in_progress", "system", false], ["test", "passed", "system", false],
    ["pr", "proposed", "system", false], ["pr", "creating", "user", true], ["pr", "created", "system", false],
    ["review", "awaiting_review", "system", false], ["review", "approved", "system", false],
    ["merge", "ready", "system", false], ["merge", "merging", "user", true], ["merge", "merged", "system", false],
    ["deploy", "deploying", "system", false],
  ];
  for (const [stage, status, actor, gate] of path) {
    const r = engStore.transition({ taskId: id, to: { stage: stage as never, status: status as never }, actor, gateApproved: gate, ts: NOW });
    if (!r.ok) throw new Error(`seed failed at ${stage}:${status}: ${r.reason}`);
  }
  engStore.setArtifact(id, { merge: { commitSha: sha, mergedTs: NOW, mergedBy: null, method: "squash" } }, NOW);
  engStore.setDeployArtifact(id, { env: "prod", status: "deploying", startedTs, finishedTs: null, commitSha: sha, runUrl: null, ci: null, cd: null, logTail: null }, NOW);
  return id;
}

class FakeGithub implements GithubPort {
  constructor(public run: DeployRun | null) {}
  async findOpenPr(): Promise<PullRequest | null> { return null; }
  async createPr(): Promise<PullRequest> { return { number: 1, url: "u" }; }
  async getPr(): Promise<PrState> { return { number: 1, url: "u", reviewDecision: null, merged: false, comments: [] }; }
  async merge(): Promise<{ sha: string; merged: boolean }> { return { sha: "s", merged: true }; }
  async getDeployRun(): Promise<DeployRun | null> { return this.run; }
}

function run(status: string, conclusion: string | null): DeployRun {
  return {
    status, conclusion, htmlUrl: "https://github.com/karna/loopkeeper/actions/runs/42",
    jobs: [
      { name: "verify", status: "completed", conclusion: status === "completed" ? "success" : null },
      { name: "deploy", status, conclusion },
    ],
  };
}

describe("deployStatusFromRun", () => {
  it("treats a missing run as still deploying", () => {
    expect(deployStatusFromRun(null)).toBe("deploying");
  });
  it("treats queued / in_progress as deploying", () => {
    expect(deployStatusFromRun(run("queued", null))).toBe("deploying");
    expect(deployStatusFromRun(run("in_progress", null))).toBe("deploying");
  });
  it("maps completed+success to deployed", () => {
    expect(deployStatusFromRun(run("completed", "success"))).toBe("deployed");
  });
  it("maps completed failure / cancelled / timed_out to failed", () => {
    expect(deployStatusFromRun(run("completed", "failure"))).toBe("failed");
    expect(deployStatusFromRun(run("completed", "cancelled"))).toBe("failed");
    expect(deployStatusFromRun(run("completed", "timed_out"))).toBe("failed");
  });
  it("picks the matching job conclusion", () => {
    const r = run("completed", "success");
    expect(jobConclusion(r, /verify|ci|test/i)).toBe("success");
    expect(jobConclusion(r, /deploy|cd/i)).toBe("success");
    expect(jobConclusion(null, /deploy/i)).toBeNull();
  });
});

describe("DeployMonitor", () => {
  it("finalizes deploy:deployed on a successful run and records CI/CD + run URL", async () => {
    const engStore = new EngStore(":memory:");
    const id = seedDeploying(engStore, "mergesha");
    await new DeployMonitor(engStore, new FakeGithub(run("completed", "success")), () => NOW, 60_000).run();
    const t = engStore.get(id)!;
    expect(t).toMatchObject({ stage: "deploy", status: "deployed" });
    expect(t.artifacts.deploy).toMatchObject({ status: "deployed", ci: "success", cd: "success", runUrl: "https://github.com/karna/loopkeeper/actions/runs/42" });
  });

  it("finalizes deploy:failed on a failed run", async () => {
    const engStore = new EngStore(":memory:");
    const id = seedDeploying(engStore, "mergesha");
    await new DeployMonitor(engStore, new FakeGithub(run("completed", "failure")), () => NOW, 60_000).run();
    expect(engStore.get(id)).toMatchObject({ stage: "deploy", status: "failed" });
    expect(engStore.get(id)!.artifacts.deploy?.cd).toBe("failure");
  });

  it("stays deploying while the run is in progress", async () => {
    const engStore = new EngStore(":memory:");
    const id = seedDeploying(engStore, "mergesha");
    await new DeployMonitor(engStore, new FakeGithub(run("in_progress", null)), () => NOW, 60_000).run();
    expect(engStore.get(id)).toMatchObject({ stage: "deploy", status: "deploying" });
  });

  it("fails when no run appears before the timeout", async () => {
    const engStore = new EngStore(":memory:");
    // started a day before NOW, tiny timeout → timed out; no run found.
    const id = seedDeploying(engStore, "mergesha", "2026-06-27T00:00:00Z");
    await new DeployMonitor(engStore, new FakeGithub(null), () => NOW, 1_000).run();
    const t = engStore.get(id)!;
    expect(t).toMatchObject({ stage: "deploy", status: "failed" });
    expect(t.artifacts.deploy?.logTail).toContain("timeout");
  });
});
