import { describe, expect, it } from "vitest";
import { buildPlanComment } from "../../../src/engineering/writeback.ts";
import { buildApp } from "../../../src/server/app.ts";
import type { AppDeps } from "../../../src/server/deps.ts";
import { loadConfig } from "../../../src/server/config.ts";
import type { ServerConfig } from "../../../src/server/config.ts";
import { LoopsStore } from "../../../src/store/loops-store.ts";
import { EngStore } from "../../../src/store/eng-store.ts";
import { InMemoryVault } from "../../../src/vault/token-vault.ts";
import { FakeDraftClient } from "../../../src/draft/draft-composer.ts";
import { FakePushSender } from "../../../src/push/push-sender.ts";
import { StubExtractionClient } from "../../../src/stub-extraction-client.ts";
import { FakeSource } from "../../../src/sources/fake-source.ts";
import { ScanService } from "../../../src/scan/scan-service.ts";
import { NudgeService } from "../../../src/nudge/nudge-service.ts";
import type { HttpClient } from "../../../src/oauth/http.ts";
import type { UserIdentity } from "../../../src/domain/message.ts";
import type { EngTaskInput } from "../../../src/domain/eng-task.ts";
import { taskId, EMPTY_ARTIFACTS } from "../../../src/domain/eng-task.ts";
import type { EngTask } from "../../../src/domain/eng-task.ts";
import type { JiraClient } from "../../../src/engineering/jira/jira-client.ts";
import type { JiraIssue } from "../../../src/engineering/jira/jira-mapper.ts";
import { JiraSyncService } from "../../../src/engineering/jira/jira-sync.ts";

const IDENTITY: UserIdentity = { displayName: "Karna", aliases: [], timezone: "Asia/Kolkata" };
const NOW = "2026-06-29T00:00:00Z";
const noopHttp: HttpClient = { post: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }), getJson: async () => ({}) };

class SpyJiraClient implements JiraClient {
  comments: Array<{ issueIdOrKey: string; body: string }> = [];
  async searchAssigned(): Promise<JiraIssue[]> { return []; }
  async getIssue(): Promise<JiraIssue | null> { return null; }
  async currentUserAccountId(): Promise<string> { return "acct-1"; }
  async addComment(issueIdOrKey: string, body: string): Promise<void> {
    this.comments.push({ issueIdOrKey, body });
  }
}

function makeApp(
  configOverrides: Partial<ServerConfig> = {},
  jiraClient?: JiraClient,
): { app: ReturnType<typeof buildApp>; engStore: EngStore; spy: SpyJiraClient } {
  const store = new LoopsStore(":memory:");
  const engStore = new EngStore(":memory:");
  const scan = new ScanService([new FakeSource("slack", [])], new StubExtractionClient({}), store, IDENTITY);
  const spy = (jiraClient as SpyJiraClient | undefined) ?? new SpyJiraClient();
  const jiraSync = new JiraSyncService(spy, engStore, { siteUrl: "https://x.atlassian.net", repo: "karna/loopkeeper", defaultBranch: "main" });
  const deps: AppDeps = {
    config: { ...loadConfig({} as NodeJS.ProcessEnv), ...configOverrides },
    store,
    engStore,
    vault: new InMemoryVault(),
    http: noopHttp,
    identity: IDENTITY,
    buildScanService: () => scan,
    buildNudgeService: () => new NudgeService(store, new FakePushSender()),
    buildDraftClient: () => new FakeDraftClient(),
    listSlackChannels: async () => [],
    jiraSync,
    buildJiraSync: () => { throw new Error("Jira not connected"); },
    buildGithub: () => null,
    now: () => NOW,
  };
  return { app: buildApp(deps), engStore, spy };
}

function engInput(over: Partial<EngTaskInput> = {}): EngTaskInput {
  return {
    jiraKey: "LK-1",
    jiraId: "10001",
    jiraUrl: "https://x.atlassian.net/browse/LK-1",
    title: "Add Jira OAuth connector",
    description: "Wire 3LO.",
    acceptanceCriteria: null,
    labels: [],
    components: [],
    assignee: "acct-1",
    jiraStatus: "To Do",
    repo: "karna/loopkeeper",
    defaultBranch: "main",
    ...over,
  };
}

// ---- Unit tests for buildPlanComment ----

describe("buildPlanComment", () => {
  function baseTask(over: Partial<EngTask> = {}): EngTask {
    return {
      id: taskId("10001"),
      jiraKey: "LK-1",
      jiraId: "10001",
      jiraUrl: "https://x.atlassian.net/browse/LK-1",
      title: "Add Jira OAuth connector",
      description: "Wire 3LO.",
      acceptanceCriteria: null,
      labels: [],
      components: [],
      labelIds: [],
      assignee: "acct-1",
      jiraStatus: "To Do",
      repo: "karna/loopkeeper",
      defaultBranch: "main",
      branch: null,
      worktreePath: null,
      claudeSessionId: null,
      claudeModel: null,
      stage: "plan",
      status: "not_started",
      artifacts: { ...EMPTY_ARTIFACTS },
      budget: { maxIterations: 6, iterationsUsed: 0, maxUsdCents: 500, usdCentsUsed: 0, maxReviewRounds: 5, reviewRoundsUsed: 0 },
      lastNotifiedStatus: null,
      lastError: null,
      createdTs: NOW,
      updatedTs: NOW,
      ...over,
    };
  }

  it("includes the jiraKey and title", () => {
    const body = buildPlanComment(baseTask());
    expect(body).toContain("LK-1");
    expect(body).toContain("Add Jira OAuth connector");
  });

  it("includes the plan text when present (prefers editedText)", () => {
    const task = baseTask({
      artifacts: { ...EMPTY_ARTIFACTS, plan: { text: "raw plan", editedText: "annotated plan", sessionId: null, revision: 0, generatedTs: NOW, approvedTs: null, approvedBy: null, qualityScore: null } },
    });
    const body = buildPlanComment(task);
    expect(body).toContain("annotated plan");
    expect(body).not.toContain("raw plan");
  });

  it("falls back to plan.text when editedText is null", () => {
    const task = baseTask({
      artifacts: { ...EMPTY_ARTIFACTS, plan: { text: "raw plan", editedText: null, sessionId: null, revision: 0, generatedTs: NOW, approvedTs: null, approvedBy: null, qualityScore: null } },
    });
    expect(buildPlanComment(task)).toContain("raw plan");
  });

  it("includes branch and PR URL when present", () => {
    const task = baseTask({
      artifacts: {
        ...EMPTY_ARTIFACTS,
        dev: { summary: "done", branch: "LK-1-add-oauth", branchURL: "https://github.com/karna/loopkeeper/tree/LK-1-add-oauth", filesChanged: 3, iterations: 2, lastIterationTs: NOW },
        pr: { title: "Add OAuth", body: "Adds 3LO.", diffSummary: "", url: "https://github.com/karna/loopkeeper/pull/42", number: 42, proposedTs: NOW, createdTs: NOW, approvedBy: null, selfReview: null },
      },
    });
    const body = buildPlanComment(task);
    expect(body).toContain("LK-1-add-oauth");
    expect(body).toContain("https://github.com/karna/loopkeeper/pull/42");
  });

  it("omits branch/PR sections when artifacts are null", () => {
    const body = buildPlanComment(baseTask());
    expect(body).not.toContain("Branch:");
    expect(body).not.toContain("PR:");
  });

  it("always ends with the human-approved footer", () => {
    expect(buildPlanComment(baseTask())).toContain("human-approved");
  });
});

// ---- Route tests ----

describe("POST /tasks/:id/jira/writeback/draft", () => {
  it("returns 403 when ENG_JIRA_WRITEBACK is not enabled (default off)", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/draft` });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain("ENG_JIRA_WRITEBACK");
  });

  it("returns 404 for an unknown task", async () => {
    const { app } = makeApp({ eng: { ...loadConfig({} as NodeJS.ProcessEnv).eng, jiraWriteback: true } });
    const res = await app.inject({ method: "POST", url: `/tasks/${taskId("99999")}/jira/writeback/draft` });
    expect(res.statusCode).toBe(404);
  });

  it("composes and stores a draft without calling Jira", async () => {
    const { app, engStore, spy } = makeApp({ eng: { ...loadConfig({} as NodeJS.ProcessEnv).eng, jiraWriteback: true } });
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/draft` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { draftBody: string };
    expect(body.draftBody).toContain("LK-1");
    // Draft is stored in the artifact.
    const task = engStore.get(id);
    expect(task?.artifacts.jiraWriteback?.draftBody).toBe(body.draftBody);
    expect(task?.artifacts.jiraWriteback?.postedTs).toBeNull();
    // Jira was NOT called.
    expect(spy.comments).toHaveLength(0);
  });

  it("allows re-drafting and overwrites the previous draft body (postedTs preserved if already posted)", async () => {
    const { app, engStore } = makeApp({ eng: { ...loadConfig({} as NodeJS.ProcessEnv).eng, jiraWriteback: true } });
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/draft` });
    const secondRes = await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/draft` });
    expect(secondRes.statusCode).toBe(200);
    // Still has a draft, not posted.
    expect(engStore.get(id)?.artifacts.jiraWriteback?.postedTs).toBeNull();
  });
});

describe("POST /tasks/:id/jira/writeback/confirm", () => {
  it("returns 403 when ENG_JIRA_WRITEBACK is not enabled", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/confirm` });
    expect(res.statusCode).toBe(403);
  });

  it("fails closed when selfAccountId is not set", async () => {
    const config = { eng: { ...loadConfig({} as NodeJS.ProcessEnv).eng, jiraWriteback: true } };
    const { app, engStore } = makeApp(config);
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    // Create a draft first.
    await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/draft` });
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/confirm` });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain("LOOPKEEPER_JIRA_ACCOUNT_ID");
  });

  it("returns 409 when no draft exists", async () => {
    const config = { selfAccountId: "acct-1", eng: { ...loadConfig({} as NodeJS.ProcessEnv).eng, jiraWriteback: true } };
    const { app, engStore } = makeApp(config);
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/confirm` });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain("no draft");
  });

  it("posts the comment and sets postedTs; Jira addComment is called exactly once", async () => {
    const spy = new SpyJiraClient();
    const config = { selfAccountId: "acct-1", eng: { ...loadConfig({} as NodeJS.ProcessEnv).eng, jiraWriteback: true } };
    const { app, engStore } = makeApp(config, spy);
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    // Draft first.
    const draftRes = await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/draft` });
    const { draftBody } = draftRes.json() as { draftBody: string };
    // Confirm.
    const confirmRes = await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/confirm` });
    expect(confirmRes.statusCode).toBe(200);
    expect((confirmRes.json() as { postedTs: string }).postedTs).toBe(NOW);
    // Artifact updated.
    const task = engStore.get(id);
    expect(task?.artifacts.jiraWriteback?.postedTs).toBe(NOW);
    expect(task?.artifacts.jiraWriteback?.postedBy).toBe("acct-1");
    // Jira was called once with the right args.
    expect(spy.comments).toHaveLength(1);
    expect(spy.comments[0]?.issueIdOrKey).toBe("LK-1");
    expect(spy.comments[0]?.body).toBe(draftBody);
  });

  it("returns 409 if already posted (idempotent guard)", async () => {
    const spy = new SpyJiraClient();
    const config = { selfAccountId: "acct-1", eng: { ...loadConfig({} as NodeJS.ProcessEnv).eng, jiraWriteback: true } };
    const { app, engStore } = makeApp(config, spy);
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/draft` });
    await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/confirm` });
    // Second confirm should be rejected.
    const second = await app.inject({ method: "POST", url: `/tasks/${id}/jira/writeback/confirm` });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toContain("already posted");
    // Jira still only called once.
    expect(spy.comments).toHaveLength(1);
  });
});
