import { describe, expect, it } from "vitest";
import * as http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server/app.ts";
import type { AppDeps } from "../../src/server/deps.ts";
import { loadConfig } from "../../src/server/config.ts";
import type { ServerConfig } from "../../src/server/config.ts";
import { LoopsStore } from "../../src/store/loops-store.ts";
import { EngStore } from "../../src/store/eng-store.ts";
import { InMemoryVault } from "../../src/vault/token-vault.ts";
import { FakeSource } from "../../src/sources/fake-source.ts";
import { StubExtractionClient } from "../../src/stub-extraction-client.ts";
import { ScanService } from "../../src/scan/scan-service.ts";
import { NudgeService } from "../../src/nudge/nudge-service.ts";
import { FakePushSender } from "../../src/push/push-sender.ts";
import { FakeDraftClient } from "../../src/draft/draft-composer.ts";
import type { HttpClient } from "../../src/oauth/http.ts";
import type { NormalizedMessage, UserIdentity } from "../../src/domain/message.ts";
import type { EngTaskInput } from "../../src/domain/eng-task.ts";
import { taskId } from "../../src/domain/eng-task.ts";
import type { GithubPort } from "../../src/engineering/ports.ts";
import { JiraSyncService } from "../../src/engineering/jira/jira-sync.ts";
import type { JiraClient } from "../../src/engineering/jira/jira-client.ts";
import type { JiraIssue } from "../../src/engineering/jira/jira-mapper.ts";

const IDENTITY: UserIdentity = { displayName: "Karna", aliases: [], timezone: "Asia/Kolkata" };
const NOW = "2026-06-25T04:00:00Z";
const noopHttp: HttpClient = { post: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }), getJson: async () => ({}) };

function makeApp(
  configOverrides: Partial<ServerConfig> = {},
  githubOverride?: GithubPort | null,
  jiraSyncOverride?: JiraSyncService | null,
): { app: ReturnType<typeof buildApp>; store: LoopsStore; engStore: EngStore; push: FakePushSender } {
  const store = new LoopsStore(":memory:");
  const engStore = new EngStore(":memory:");
  const messages: NormalizedMessage[] = [
    { channel: "slack", tenant: "T", sourceRef: "C1:1", permalink: "https://x/1", author: "Karna", fromMe: true, timestamp: "2026-06-24T10:00:00+05:30", sourceTimezone: "Asia/Kolkata", text: "I'll send the deck by EOD tomorrow" },
  ];
  const stub = new StubExtractionClient({
    "C1:1": [
      { direction: "owe", kind: "commitment", summary: "Send the deck", counterpart: "Anil", commitmentSpan: "I'll send the deck by EOD tomorrow", duePhrase: "by EOD tomorrow", firmness: "firm" },
    ],
  });
  const scan = new ScanService([new FakeSource("slack", messages)], stub, store, IDENTITY);
  const push = new FakePushSender();
  const deps: AppDeps = {
    config: { ...loadConfig({} as NodeJS.ProcessEnv), ...configOverrides },
    store,
    engStore,
    vault: new InMemoryVault(),
    http: noopHttp,
    identity: IDENTITY,
    buildScanService: () => scan,
    buildNudgeService: () => new NudgeService(store, push),
    buildDraftClient: () => new FakeDraftClient(),
    listSlackChannels: async () => [{ id: "C1", name: "general", kind: "channel" as const, isMember: true }],
    jiraSync: jiraSyncOverride ?? null,
    buildJiraSync: () => {
      throw new Error("Jira not connected");
    },
    buildGithub: () => githubOverride ?? null,
    now: () => NOW,
  };
  return { app: buildApp(deps), store, engStore, push };
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

/** POST /scan now runs in the background; trigger it and poll status until it's done. */
async function runScan(app: ReturnType<typeof buildApp>): Promise<{ gated?: number; inserted?: number; extracted?: number } | null> {
  await app.inject({ method: "POST", url: "/scan" });
  for (let i = 0; i < 200; i += 1) {
    const s = (await app.inject({ method: "GET", url: "/scan/status" })).json() as { running: boolean; last: { gated?: number; inserted?: number } | null };
    if (!s.running) return s.last;
    await new Promise((r) => setTimeout(r, 2));
  }
  return null;
}

describe("REST app", () => {
  it("GET /healthz", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, loops: 0 });
  });

  it("full flow: scan -> list -> brief -> done", async () => {
    const { app } = makeApp();
    const result = await runScan(app);
    expect(result).toMatchObject({ gated: 1, inserted: 1 });

    const list = await app.inject({ method: "GET", url: "/loops" });
    const loops = list.json() as Array<{ id: string; dueDate: string }>;
    expect(loops).toHaveLength(1);
    // "EOD tomorrow" is anchored to the MESSAGE date (2026-06-24), so it resolves to 2026-06-25,
    // not tomorrow-from-the-scan (2026-06-26). This is the message-date-relative due fix.
    expect(loops[0]?.dueDate).toBe("2026-06-25");
    const id = loops[0]!.id;

    const brief = await app.inject({ method: "GET", url: "/brief" });
    // Due 2026-06-25 == scan day → it lands in "today" (message-date-anchored "EOD tomorrow").
    expect((brief.json() as { today: unknown[] }).today).toHaveLength(1);

    const done = await app.inject({ method: "POST", url: `/loops/${id}/done` });
    expect(done.json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/loops" })).json()).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/loops?status=closed" })).json()).toHaveLength(1);
  });

  it("validation: snooze needs until, unknown id is 404, label is constrained", async () => {
    const { app, store } = makeApp();
    store.upsertMany([
      {
        id: "loop_test1",
        direction: "owe",
        kind: "commitment",
        summary: "X",
        counterpart: "Y",
        channel: "slack",
        sourceRef: "C9:9",
        permalink: "p",
        commitmentHash: "h",
        dueDate: null,
        dueConfidence: "none",
        firmness: "firm",
        status: "open",
        tenant: "T",
        createdTs: NOW,
      },
    ]);
    expect((await app.inject({ method: "POST", url: "/loops/loop_test1/snooze", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/loops/nope/done" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/loops/loop_test1/label", payload: { label: "maybe" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/loops/loop_test1/label", payload: { label: "true" } })).statusCode).toBe(200);
  });

  it("push flow: register device -> scan -> nudge (once)", async () => {
    const { app, push } = makeApp();
    expect((await app.inject({ method: "POST", url: "/devices", payload: { token: "devtok" } })).statusCode).toBe(200);
    await runScan(app);
    const res = await app.inject({ method: "POST", url: "/nudge" });
    expect(res.json()).toMatchObject({ candidates: 1, devices: 1, sent: 1, nudged: 1 });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload.body).toBe("Send the deck");
    // Already nudged -> not selected again.
    expect((await app.inject({ method: "POST", url: "/nudge" })).json()).toMatchObject({ candidates: 0, sent: 0 });
  });

  it("composes a draft chaser for a loop", async () => {
    const { app } = makeApp();
    await runScan(app);
    const id = ((await app.inject({ method: "GET", url: "/loops" })).json() as Array<{ id: string }>)[0]!.id;
    const res = await app.inject({ method: "GET", url: `/loops/${id}/draft` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { draft: string }).draft).toContain("following up");
  });

  it("confirm-close moves a candidate to closed", async () => {
    const { app, store } = makeApp();
    await runScan(app);
    const id = ((await app.inject({ method: "GET", url: "/loops" })).json() as Array<{ id: string }>)[0]!.id;
    store.setStatus(id, "closed_candidate");
    expect((await app.inject({ method: "POST", url: `/loops/${id}/confirm-close` })).json()).toEqual({ ok: true });
    expect(store.get(id)?.status).toBe("closed");
  });

  it("lists channels + saves config via /channels and /config", async () => {
    const { app, store } = makeApp();
    const channels = (await app.inject({ method: "GET", url: "/channels" })).json() as { slack: Array<{ id: string; enabled: boolean }>; gmailQuery: string };
    expect(channels.slack).toEqual([{ id: "C1", name: "general", kind: "channel", enabled: false }]);
    expect(channels.gmailQuery).toContain("category:primary");

    const saved = await app.inject({ method: "PUT", url: "/config", payload: { slackChannelIds: ["C1"], gmailQuery: "in:inbox is:important newer_than:7d" } });
    expect(saved.statusCode).toBe(200);
    expect(store.getSourceConfig()).toMatchObject({ slackChannelIds: ["C1"], gmailQuery: "in:inbox is:important newer_than:7d" });

    // now C1 shows enabled
    const after = (await app.inject({ method: "GET", url: "/channels" })).json() as { slack: Array<{ id: string; enabled: boolean }> };
    expect(after.slack[0]?.enabled).toBe(true);
  });

  it("searches loops by ?q= over summary/counterpart", async () => {
    const { app } = makeApp();
    await runScan(app);
    const hit = (await app.inject({ method: "GET", url: "/loops?q=deck" })).json() as unknown[];
    expect(hit).toHaveLength(1);
    const byPerson = (await app.inject({ method: "GET", url: "/loops?q=anil" })).json() as unknown[];
    expect(byPerson).toHaveLength(1);
    const miss = (await app.inject({ method: "GET", url: "/loops?q=zzzznope" })).json() as unknown[];
    expect(miss).toHaveLength(0);
  });

  it("not-a-loop dismisses the loop and suppresses its commitment hash", async () => {
    const { app, store } = makeApp();
    await runScan(app);
    const id = ((await app.inject({ method: "GET", url: "/loops" })).json() as Array<{ id: string }>)[0]!.id;

    expect((await app.inject({ method: "POST", url: `/loops/${id}/not-a-loop` })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/loops" })).json()).toHaveLength(0); // dismissed
    expect(store.suppressedHashes().size).toBe(1);
    expect(store.get(id)?.userLabel).toBe("false");
    expect((await app.inject({ method: "POST", url: "/loops/nope/not-a-loop" })).statusCode).toBe(404);
  });

  it("GET /stats reports metrics over all loops", async () => {
    const { app } = makeApp();
    await runScan(app);
    const stats = (await app.inject({ method: "GET", url: "/stats" })).json() as { open: { owe: number; total: number }; closed: { total: number } };
    expect(stats.open.owe).toBeGreaterThanOrEqual(1);
    expect(stats.closed.total).toBe(0);
  });

  it("delegate flips an owe loop to owed (waiting on someone else)", async () => {
    const { app, store } = makeApp();
    await runScan(app);
    const id = ((await app.inject({ method: "GET", url: "/loops" })).json() as Array<{ id: string }>)[0]!.id;

    expect((await app.inject({ method: "POST", url: `/loops/${id}/delegate`, payload: { to: "Bob" } })).json()).toEqual({ ok: true });
    const loop = store.get(id);
    expect(loop?.direction).toBe("owed");
    expect(loop?.counterpart).toBe("Bob");

    expect((await app.inject({ method: "POST", url: `/loops/${id}/delegate`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/loops/nope/delegate", payload: { to: "X" } })).statusCode).toBe(404);
  });

  it("undo reverts the most recent lifecycle change", async () => {
    const { app, store } = makeApp();
    await runScan(app);
    const id = ((await app.inject({ method: "GET", url: "/loops" })).json() as Array<{ id: string }>)[0]!.id;

    await app.inject({ method: "POST", url: `/loops/${id}/done` });
    expect(store.get(id)?.status).toBe("closed");
    expect((await app.inject({ method: "POST", url: "/undo" })).json()).toEqual({ ok: true, loopId: id });
    expect(store.get(id)?.status).toBe("open");
    expect(store.get(id)?.resolvedTs).toBeUndefined();
  });

  it("recurring loop spawns the next occurrence on done", async () => {
    const { app, store } = makeApp();
    await runScan(app);
    const id = ((await app.inject({ method: "GET", url: "/loops" })).json() as Array<{ id: string }>)[0]!.id;

    expect((await app.inject({ method: "POST", url: `/loops/${id}/recur`, payload: { rule: "weekly" } })).json()).toEqual({ ok: true });
    await app.inject({ method: "POST", url: `/loops/${id}/done` });

    expect(store.count()).toBe(2); // original closed + next occurrence
    const active = store.list({ status: ["open"] });
    expect(active).toHaveLength(1);
    expect(active[0]?.recurrence).toBe("weekly");
    expect(active[0]?.dueDate).toBe("2026-07-02"); // base 2026-06-25 (message-date anchored) + 1 week
  });

  it("double /done can't duplicate a recurring loop; undo reopens it and removes the spawn", async () => {
    const { app, store } = makeApp();
    await runScan(app);
    const id = ((await app.inject({ method: "GET", url: "/loops" })).json() as Array<{ id: string }>)[0]!.id;
    await app.inject({ method: "POST", url: `/loops/${id}/recur`, payload: { rule: "weekly" } });

    await app.inject({ method: "POST", url: `/loops/${id}/done` });
    await app.inject({ method: "POST", url: `/loops/${id}/done` }); // retry — must not spawn again
    expect(store.count()).toBe(2); // original + one spawned occurrence (not 3)

    expect((await app.inject({ method: "POST", url: "/undo" })).json()).toMatchObject({ ok: true, loopId: id });
    expect(store.get(id)?.status).toBe("open");
    expect(store.count()).toBe(1); // pristine spawn removed by the undo
  });

  it("undo ignores automated nudge transitions", async () => {
    const { app, store } = makeApp();
    await app.inject({ method: "POST", url: "/devices", payload: { token: "devtok" } });
    await runScan(app);
    const id = ((await app.inject({ method: "GET", url: "/loops" })).json() as Array<{ id: string }>)[0]!.id;
    await app.inject({ method: "POST", url: "/nudge" });
    expect(store.get(id)?.status).toBe("nudged");
    expect((await app.inject({ method: "POST", url: "/undo" })).json()).toEqual({ ok: false }); // nudge isn't undoable
    expect(store.get(id)?.status).toBe("nudged");
  });

  it("organize sets project/tags and they're searchable", async () => {
    const { app, store } = makeApp();
    await runScan(app);
    const id = ((await app.inject({ method: "GET", url: "/loops" })).json() as Array<{ id: string }>)[0]!.id;

    await app.inject({ method: "POST", url: `/loops/${id}/organize`, payload: { project: "Acme", tags: ["urgent", "q3"] } });
    expect(store.get(id)?.project).toBe("Acme");
    expect(store.get(id)?.tags).toContain("urgent");
    expect((await app.inject({ method: "GET", url: "/loops?q=Acme" })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/loops?q=q3" })).json()).toHaveLength(1);
  });

  it("GET /export returns all loops", async () => {
    const { app } = makeApp();
    await runScan(app);
    const out = (await app.inject({ method: "GET", url: "/export" })).json() as { exportedAt: string; loops: unknown[] };
    expect(out.loops.length).toBeGreaterThanOrEqual(1);
    expect(typeof out.exportedAt).toBe("string");
  });

  it("enforces the bearer token when configured (health + auth exempt)", async () => {
    const { app } = makeApp({ apiToken: "s3cret" });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200); // exempt
    expect((await app.inject({ method: "GET", url: "/loops" })).statusCode).toBe(401); // no token
    expect((await app.inject({ method: "GET", url: "/loops", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/loops", headers: { authorization: "Bearer s3cret" } })).statusCode).toBe(200);
  });
});

describe("engineering routes", () => {
  it("GET /tasks returns imported tasks (empty before any import)", async () => {
    const { app, engStore } = makeApp();
    expect(((await app.inject({ method: "GET", url: "/tasks" })).json() as { tasks: unknown[] }).tasks).toEqual([]);
    engStore.upsertFromJira([engInput()], NOW);
    const tasks = ((await app.inject({ method: "GET", url: "/tasks" })).json() as { tasks: Array<{ jiraKey: string; stage: string; status: string }> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ jiraKey: "LK-1", stage: "plan", status: "not_started" });
  });

  it("filters /tasks to the assignee when a self identity is configured", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ jiraKey: "LK-1", jiraId: "10001", assignee: "acct-1" }), engInput({ jiraKey: "LK-2", jiraId: "10002", assignee: "someone-else" })], NOW);
    const tasks = ((await app.inject({ method: "GET", url: "/tasks" })).json() as { tasks: Array<{ jiraKey: string }> }).tasks;
    expect(tasks.map((t) => t.jiraKey)).toEqual(["LK-1"]);
  });

  it("GET /tasks/:id returns task + events; 404 for unknown", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    const body = (await app.inject({ method: "GET", url: `/tasks/${id}` })).json() as { task: { id: string }; events: unknown[] };
    expect(body.task.id).toBe(id);
    expect(body.events).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/tasks/nope" })).statusCode).toBe(404);
  });

  it("GET /tasks/:id overlays LIVE Jira metadata when Jira is connected (fresh-on-open)", async () => {
    // getTask only uses its client + opts (db row is passed in), so a throwaway store is fine here.
    const liveIssue: JiraIssue = { id: "10001", key: "LP-1", fields: { summary: "LIVE title", status: { name: "In Review" }, assignee: { accountId: "acct-1" } } };
    const fakeClient: JiraClient = {
      searchAssigned: async () => [],
      getIssue: async (idOrKey) => (idOrKey === "10001" ? liveIssue : null),
      currentUserAccountId: async () => "acct-1",
      addComment: async () => {},
    };
    const jira = new JiraSyncService(fakeClient, new EngStore(":memory:"), { siteUrl: "https://x.atlassian.net", repo: "r/r", defaultBranch: "main" });
    const { app, engStore } = makeApp({}, undefined, jira);
    engStore.upsertFromJira([engInput({ title: "Stale cached title", jiraKey: "LK-1" })], NOW);

    const body = (await app.inject({ method: "GET", url: `/tasks/${taskId("10001")}` })).json() as { task: { title: string; jiraKey: string; jiraStatus: string } };
    expect(body.task.title).toBe("LIVE title"); // live overlay, not the cached "Stale cached title"
    expect(body.task.jiraKey).toBe("LP-1"); // live key too
    expect(body.task.jiraStatus).toBe("In Review");
  });

  it("GET /tasks/:id/status reports idle for a fresh task", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const status = (await app.inject({ method: "GET", url: `/tasks/${taskId("10001")}/status` })).json() as { runState: string; stage: string };
    expect(status).toMatchObject({ stage: "plan", runState: "idle" });
  });

  it("POST /tasks/sync is 503 until Jira is connected", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "POST", url: "/tasks/sync" })).statusCode).toBe(503);
  });

  it("gates fail closed without a self identity (403)", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    expect((await app.inject({ method: "POST", url: `/tasks/${taskId("10001")}/prepare-plan` })).statusCode).toBe(403);
  });

  it("prepare-plan transitions to in_progress and enqueues a plan job", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/prepare-plan` });
    expect(res.json()).toEqual({ started: true });
    expect(engStore.get(id)).toMatchObject({ stage: "plan", status: "in_progress" });
    expect(engStore.runningJobForTask(id)?.kind).toBe("plan");
  });

  it("plan/approve enforces the gate and enqueues dev_test", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    // Not yet planned → 409.
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/plan/approve` })).statusCode).toBe(409);
    engStore.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    engStore.transition({ taskId: id, to: { stage: "plan", status: "completed_unapproved" }, actor: "agent", ts: NOW });
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/plan/approve`, payload: {} })).json()).toEqual({ ok: true });
    expect(engStore.get(id)).toMatchObject({ stage: "plan", status: "approved" });
    expect(engStore.runningJobForTask(id)?.kind).toBe("dev_test");
    // The gate crossing is recorded with gate_approved + user.
    expect(engStore.events(id).find((e) => e.toStatus === "approved")).toMatchObject({ gateApproved: true, actor: "user" });
  });

  it("review/approve lets the solo operator approve the PR and advances to merge:ready", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    // Wrong stage → 409.
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/review/approve` })).statusCode).toBe(409);
    const path: Array<[string, string, "user" | "agent" | "system", boolean]> = [
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
    ];
    for (const [stage, status, actor, gate] of path) {
      engStore.transition({ taskId: id, to: { stage: stage as never, status: status as never }, actor, gateApproved: gate, ts: NOW });
    }
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/review/approve` })).json()).toEqual({ ok: true });
    expect(engStore.get(id)).toMatchObject({ stage: "merge", status: "ready" });
    // The review approval is recorded as a user action in the audit log.
    expect(engStore.events(id).find((e) => e.toStage === "review" && e.toStatus === "approved")).toMatchObject({ actor: "user" });
  });

  it("merge/approve crosses Gate 3 and enqueues a merge job with the method", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1", github: { repo: "karna/loopkeeper", baseBranch: "main" } });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    const path: Array<[string, string, "user" | "agent" | "system", boolean]> = [
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
    ];
    for (const [stage, status, actor, gate] of path) {
      engStore.transition({ taskId: id, to: { stage: stage as never, status: status as never }, actor, gateApproved: gate, ts: NOW });
    }
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/merge/approve`, payload: { method: "squash" } });
    expect(res.json()).toEqual({ started: true });
    expect(engStore.get(id)).toMatchObject({ stage: "merge", status: "merging" });
    const job = engStore.runningJobForTask(id);
    expect(job?.kind).toBe("merge");
    expect(JSON.parse(job?.payload ?? "{}")).toEqual({ method: "squash" });
  });

  it("POST /tasks/:id/cancel 403s without self identity", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/cancel` })).statusCode).toBe(403);
  });

  it("POST /tasks/:id/cancel 404s for unknown task", async () => {
    const { app } = makeApp({ selfAccountId: "acct-1" });
    expect((await app.inject({ method: "POST", url: "/tasks/nope/cancel" })).statusCode).toBe(404);
  });

  it("POST /tasks/:id/cancel moves an active task to blocked and cancels jobs", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    // Advance to a running state and enqueue a job.
    engStore.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    engStore.enqueue({ taskId: id, kind: "plan", dedupeKey: `${id}:plan` }, NOW);

    const res = await app.inject({ method: "POST", url: `/tasks/${id}/cancel` });
    expect(res.json()).toEqual({ ok: true });
    const task = engStore.get(id)!;
    expect(task).toMatchObject({ stage: "plan", status: "blocked" });
    expect(task.lastError).toBe("Cancelled by user.");
    // Queued jobs are cancelled.
    expect(engStore.runningJobForTask(id)).toBeNull();
    // cancel_pending flag is set for the worker-watcher.
    expect(engStore.isTaskCancelPending(id)).toBe(true);
  });

  it("POST /tasks/:id/cancel 409s for a terminal task", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    // Drive to cancelled (terminal).
    engStore.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    engStore.transition({ taskId: id, to: { stage: "plan", status: "cancelled" }, actor: "user", ts: NOW });
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/cancel` })).statusCode).toBe(409);
  });

  it("retry after cancel resets cancel_pending and resumes from blocked", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    // Put into blocked via cancel.
    engStore.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    await app.inject({ method: "POST", url: `/tasks/${id}/cancel` });
    expect(engStore.isTaskCancelPending(id)).toBe(true);
    // Retry → raises budget, clears cancel_pending, transitions back.
    const retry = await app.inject({ method: "POST", url: `/tasks/${id}/retry` });
    expect(retry.json()).toEqual({ started: true });
    expect(engStore.isTaskCancelPending(id)).toBe(false);
    expect(engStore.get(id)).toMatchObject({ stage: "plan", status: "in_progress" });
  });

  // Drive a task to a given (stage,status) for the post-deploy route tests.
  const FULL_PATH: Array<[string, string, "user" | "agent" | "system", boolean]> = [
    ["plan", "in_progress", "user", false], ["plan", "completed_unapproved", "agent", false], ["plan", "approved", "user", true],
    ["dev", "in_progress", "system", false], ["dev", "done", "agent", false],
    ["test", "in_progress", "system", false], ["test", "passed", "system", false],
    ["pr", "proposed", "system", false], ["pr", "creating", "user", true], ["pr", "created", "system", false],
    ["review", "awaiting_review", "system", false], ["review", "approved", "system", false],
    ["merge", "ready", "system", false], ["merge", "merging", "user", true], ["merge", "merged", "system", false],
    ["deploy", "deploying", "system", false], ["deploy", "deployed", "system", false], ["verify", "in_progress", "system", false],
    ["verify", "awaiting_review", "system", false],
  ];
  function driveTo(engStore: EngStore, id: string, until: [string, string]): void {
    engStore.setArtifact(id, { merge: { commitSha: "mergesha", mergedTs: NOW, mergedBy: null, method: "squash" } }, NOW);
    for (const [stage, status, actor, gate] of FULL_PATH) {
      engStore.transition({ taskId: id, to: { stage: stage as never, status: status as never }, actor, gateApproved: gate, ts: NOW });
      if (stage === until[0] && status === until[1]) return;
    }
  }

  it("verify/confirm crosses Gate 4 to verify:verified", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/verify/confirm` })).statusCode).toBe(409);
    driveTo(engStore, id, ["verify", "awaiting_review"]);
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/verify/confirm` })).json()).toEqual({ ok: true });
    expect(engStore.get(id)).toMatchObject({ stage: "verify", status: "verified" });
    expect(engStore.events(id).find((e) => e.toStage === "verify" && e.toStatus === "verified")).toMatchObject({ gateApproved: true, actor: "user" });
  });

  it("rollback arms + executes (Gate 5) and enqueues a rollback job", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1", github: { repo: "karna/loopkeeper", baseBranch: "main" } });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    driveTo(engStore, id, ["verify", "awaiting_review"]);
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/rollback` });
    expect(res.json()).toEqual({ started: true });
    expect(engStore.get(id)).toMatchObject({ stage: "rollback", status: "in_progress" });
    expect(engStore.runningJobForTask(id)?.kind).toBe("rollback");
    expect(engStore.events(id).find((e) => e.toStage === "rollback" && e.toStatus === "in_progress")).toMatchObject({ gateApproved: true, actor: "user" });
  });

  /** Drive a task to deploy:failed with a given failureKind for the build-failure recovery tests. */
  function driveToDeployFailed(engStore: EngStore, id: string, failureKind: "ci_build" | "cd_infra"): void {
    driveTo(engStore, id, ["merge", "merged"]);
    engStore.transition({ taskId: id, to: { stage: "deploy", status: "deploying" }, actor: "system", ts: NOW });
    engStore.transition({ taskId: id, to: { stage: "deploy", status: "failed" }, actor: "system", ts: NOW });
    engStore.setDeployArtifact(id, { env: "prod", status: "failed", startedTs: NOW, finishedTs: NOW, commitSha: "mergesha", runUrl: "https://github.com/karna/loopkeeper/actions/runs/9", ci: failureKind === "ci_build" ? "failure" : "success", cd: failureKind === "cd_infra" ? "failure" : null, failureKind, ciError: failureKind === "ci_build" ? "error TS2420" : null, logTail: null }, NOW);
  }

  it("fix-build sends a ci_build deploy failure back to dev (seedFix job)", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1", github: { repo: "karna/loopkeeper", baseBranch: "main" } });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    driveToDeployFailed(engStore, id, "ci_build");
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/fix-build` });
    expect(res.json()).toEqual({ started: true });
    expect(engStore.get(id)).toMatchObject({ stage: "dev", status: "in_progress" });
    const job = engStore.runningJobForTask(id);
    expect(job?.kind).toBe("dev_test");
    expect((JSON.parse(job?.payload ?? "{}") as { seedFix?: boolean }).seedFix).toBe(true);
  });

  it("retry on a ci_build deploy failure is rejected with a fix-build hint", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1", github: { repo: "karna/loopkeeper", baseBranch: "main" } });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    driveToDeployFailed(engStore, id, "ci_build");
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/retry` });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain("fix-build");
  });

  it("fix-build is 409 on a cd_infra failure (only ci_build is fixable)", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1", github: { repo: "karna/loopkeeper", baseBranch: "main" } });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    driveToDeployFailed(engStore, id, "cd_infra");
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/fix-build` })).statusCode).toBe(409);
  });

  it("GET /tasks/:id/diff returns 503 when GitHub is not configured", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    const res = await app.inject({ method: "GET", url: `/tasks/${id}/diff` });
    expect(res.statusCode).toBe(503);
  });

  it("GET /tasks/:id/diff returns 404 for unknown task", async () => {
    const fakeGithub: GithubPort = {
      findOpenPr: async () => null,
      createPr: async () => ({ number: 1, url: "https://github.com/x/y/pull/1" }),
      getPr: async () => ({ number: 1, url: "", reviewDecision: null, merged: false, comments: [] }),
      merge: async () => ({ sha: "abc", merged: true }),
      getDeployRun: async () => null,
      getRunLog: async () => null,
      rerunDeploy: async () => {},
      getDiff: async () => [],
    };
    const { app } = makeApp({ github: { repo: "karna/loopkeeper", baseBranch: "main" } }, fakeGithub);
    expect((await app.inject({ method: "GET", url: "/tasks/nope/diff" })).statusCode).toBe(404);
  });

  it("GET /tasks/:id/diff returns empty files when task has no branch or PR", async () => {
    const fakeGithub: GithubPort = {
      findOpenPr: async () => null,
      createPr: async () => ({ number: 1, url: "https://github.com/x/y/pull/1" }),
      getPr: async () => ({ number: 1, url: "", reviewDecision: null, merged: false, comments: [] }),
      merge: async () => ({ sha: "abc", merged: true }),
      getDeployRun: async () => null,
      getRunLog: async () => null,
      rerunDeploy: async () => {},
      getDiff: async () => [],
    };
    const { app, engStore } = makeApp({ github: { repo: "karna/loopkeeper", baseBranch: "main" } }, fakeGithub);
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    const res = (await app.inject({ method: "GET", url: `/tasks/${id}/diff` })).json() as { files: unknown[]; truncated: boolean };
    expect(res.files).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it("GET /tasks/:id/diff returns parsed diff files from GitHub", async () => {
    const fakeDiff = [
      {
        path: "src/foo.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        hunks: [{ header: "@@ -1,3 +1,4 @@", lines: [{ type: " " as const, text: "context" }, { type: "-" as const, text: "old line" }, { type: "+" as const, text: "new line" }] }],
      },
    ];
    const fakeGithub: GithubPort = {
      findOpenPr: async () => null,
      createPr: async () => ({ number: 1, url: "https://github.com/x/y/pull/1" }),
      getPr: async () => ({ number: 1, url: "", reviewDecision: null, merged: false, comments: [] }),
      merge: async () => ({ sha: "abc", merged: true }),
      getDeployRun: async () => null,
      getRunLog: async () => null,
      rerunDeploy: async () => {},
      getDiff: async (_repo, args) => {
        // compare path: when branch is set but no prNumber
        if (!args.prNumber) return fakeDiff;
        return [];
      },
    };
    const { app, engStore } = makeApp({ github: { repo: "karna/loopkeeper", baseBranch: "main" } }, fakeGithub);
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    // Drive to dev:done so the task has a branch set.
    engStore.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    engStore.transition({ taskId: id, to: { stage: "plan", status: "completed_unapproved" }, actor: "agent", ts: NOW });
    engStore.transition({ taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ts: NOW });
    engStore.setArtifact(id, { dev: { summary: "did work", branch: "LK-1-add-thing", branchURL: null, filesChanged: 1, iterations: 1, lastIterationTs: NOW } }, NOW);
    const res = (await app.inject({ method: "GET", url: `/tasks/${id}/diff` })).json() as { files: typeof fakeDiff; truncated: boolean };
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({ path: "src/foo.ts", additions: 2, deletions: 1 });
    expect(res.files[0]?.hunks[0]?.lines).toHaveLength(3);
    expect(res.truncated).toBe(false);
  });

  // --- Activity feed (LP-11) ---

  it("GET /tasks/:id/activity returns 404 for unknown task", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "GET", url: "/tasks/nope/activity" })).statusCode).toBe(404);
  });

  it("GET /tasks/:id/activity returns done:true and empty lines when no agent runs exist", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    const body = (await app.inject({ method: "GET", url: `/tasks/${id}/activity` })).json() as { lines: string[]; nextOffset: number; done: boolean };
    expect(body).toEqual({ lines: [], nextOffset: 0, done: true });
  });

  it("GET /tasks/:id/activity returns done:true when run has no logPath", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    // Insert a running run with no logPath (simulates a run that never opened a log file).
    engStore.startAgentRun({ taskId: id, stage: "plan", sessionId: "sess-1", iteration: 1, startedTs: NOW });
    const body = (await app.inject({ method: "GET", url: `/tasks/${id}/activity` })).json() as { lines: string[]; nextOffset: number; done: boolean };
    expect(body).toEqual({ lines: [], nextOffset: 0, done: true });
  });

  it("GET /tasks/:id/activity reads and formats JSONL from log file", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");

    const logDir = mkdtempSync(join(tmpdir(), "lk-test-"));
    const taskLogDir = join(logDir, id);
    mkdirSync(taskLogDir, { recursive: true });
    const logPath = join(taskLogDir, "plan-sess-1.jsonl");

    const content = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Planning the feature." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/src/app.ts" } }] } }),
      JSON.stringify({ type: "result", is_error: false, result: "", num_turns: 5, total_cost_usd: 0.03 }),
    ].join("\n") + "\n";
    writeFileSync(logPath, content);

    const runId = engStore.startAgentRun({ taskId: id, stage: "plan", sessionId: "sess-1", iteration: 1, startedTs: NOW });
    engStore.finishAgentRun(runId, { status: "succeeded", finishedTs: NOW, exitCode: 0, usdCents: 3, numTurns: 5, resultSummary: "done", logPath });

    const body = (await app.inject({ method: "GET", url: `/tasks/${id}/activity?offset=0` })).json() as { lines: string[]; nextOffset: number; done: boolean };
    expect(body.lines).toEqual([
      "text: Planning the feature.",
      "tool: Read /src/app.ts",
      "result: ok 5 turns $0.03",
    ]);
    expect(body.nextOffset).toBeGreaterThan(0);
    expect(body.done).toBe(true);
  });

  it("GET /tasks/:id/activity respects the offset cursor (returns only new lines)", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");

    const logDir = mkdtempSync(join(tmpdir(), "lk-test-"));
    const taskLogDir = join(logDir, id);
    mkdirSync(taskLogDir, { recursive: true });
    const logPath = join(taskLogDir, "plan-sess-2.jsonl");

    const firstLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "First." }] } }) + "\n";
    const secondLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Second." }] } }) + "\n";
    writeFileSync(logPath, firstLine + secondLine);

    const runId = engStore.startAgentRun({ taskId: id, stage: "plan", sessionId: "sess-2", iteration: 1, startedTs: NOW });
    engStore.finishAgentRun(runId, { status: "succeeded", finishedTs: NOW, exitCode: 0, usdCents: 1, numTurns: 2, resultSummary: "done", logPath });

    const firstByteLen = Buffer.byteLength(firstLine, "utf8");

    // Read only the second line by providing the byte offset of the first line.
    const body = (await app.inject({ method: "GET", url: `/tasks/${id}/activity?offset=${firstByteLen}` })).json() as { lines: string[] };
    expect(body.lines).toEqual(["text: Second."]);
  });

  it("GET /tasks/:id/activity: offset at EOF returns empty lines, done:true for terminal run", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");

    const logDir = mkdtempSync(join(tmpdir(), "lk-test-"));
    const taskLogDir = join(logDir, id);
    mkdirSync(taskLogDir, { recursive: true });
    const logPath = join(taskLogDir, "plan-sess-3.jsonl");
    const content = JSON.stringify({ type: "result", is_error: false, result: "" }) + "\n";
    writeFileSync(logPath, content);

    const runId = engStore.startAgentRun({ taskId: id, stage: "plan", sessionId: "sess-3", iteration: 1, startedTs: NOW });
    engStore.finishAgentRun(runId, { status: "succeeded", finishedTs: NOW, exitCode: 0, usdCents: 0, numTurns: 1, resultSummary: "done", logPath });

    const offset = Buffer.byteLength(content, "utf8");
    const body = (await app.inject({ method: "GET", url: `/tasks/${id}/activity?offset=${offset}` })).json() as { lines: string[]; nextOffset: number; done: boolean };
    expect(body.lines).toEqual([]);
    expect(body.nextOffset).toBe(offset);
    expect(body.done).toBe(true);
  });
});

describe("PATCH /tasks/:id — per-task model override (LP-27)", () => {
  it("sets claudeModel and reflects it in GET /tasks/:id", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");

    const res = await app.inject({ method: "PATCH", url: `/tasks/${id}`, payload: { claudeModel: "claude-opus-4-8" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(engStore.get(id)?.claudeModel).toBe("claude-opus-4-8");
  });

  it("resets claudeModel to null (global default)", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    engStore.setModel(id, "claude-opus-4-8", NOW);

    const res = await app.inject({ method: "PATCH", url: `/tasks/${id}`, payload: { claudeModel: null } });
    expect(res.statusCode).toBe(200);
    expect(engStore.get(id)?.claudeModel).toBeNull();
  });

  it("rejects unknown model strings with 400", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");

    const res = await app.inject({ method: "PATCH", url: `/tasks/${id}`, payload: { claudeModel: "gpt-4o" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("unknown model");
  });

  it("returns 403 without a self identity", async () => {
    const { app, engStore } = makeApp(); // no selfAccountId
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("10001");
    expect((await app.inject({ method: "PATCH", url: `/tasks/${id}`, payload: { claudeModel: "claude-opus-4-8" } })).statusCode).toBe(403);
  });

  it("returns 404 for unknown task", async () => {
    const { app } = makeApp({ selfAccountId: "acct-1" });
    expect((await app.inject({ method: "PATCH", url: "/tasks/task_nonexistent", payload: { claudeModel: "claude-sonnet-4-6" } })).statusCode).toBe(404);
  });
});

// --- SSE stream (LP-71) ---
// Streaming tests require a real listening server (inject doesn't support hijacked SSE connections).

describe("GET /tasks/:id/stream — SSE (LP-71)", () => {
  it("returns 404 for unknown task (pre-hijack path)", async () => {
    const { app } = makeApp();
    // The 404 branch returns before reply.hijack(), so app.inject() works here.
    const res = await app.inject({ method: "GET", url: "/tasks/task_nope/stream" });
    expect(res.statusCode).toBe(404);
  });

  it("replays current log tail on connect and sets text/event-stream header", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");

    const logDir = mkdtempSync(join(tmpdir(), "lk-sse-"));
    const logPath = join(logDir, "plan-sse.jsonl");
    const logContent =
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Planning." }] } }) + "\n";
    writeFileSync(logPath, logContent);
    const runId = engStore.startAgentRun({ taskId: id, stage: "plan", sessionId: "sse-1", iteration: 1, startedTs: NOW });
    engStore.finishAgentRun(runId, {
      status: "succeeded", finishedTs: NOW, exitCode: 0, usdCents: 1, numTurns: 1, resultSummary: "done", logPath,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    try {
      const { contentType, body } = await new Promise<{ contentType: string; body: string }>((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: `/tasks/${id}/stream` }, (res) => {
          const ct = res.headers["content-type"] ?? "";
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            data += chunk;
            if (data.includes("data: text: Planning.")) {
              resolve({ contentType: ct, body: data });
              req.destroy(); // disconnect after we have what we need
            }
          });
          res.on("end", () => resolve({ contentType: ct, body: data }));
          res.on("error", (err) => reject(err));
        });
        req.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
        });
        req.end();
      });
      expect(contentType).toContain("text/event-stream");
      expect(body).toContain("data: text: Planning.");
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });

  it("emits a status SSE event when a transition fires, then closes the stream on terminal status", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    // Advance to a stage that can be transitioned
    engStore.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    try {
      // Use http.request (not fetch) so we get direct socket control and reliable close detection.
      const collected = await new Promise<string>((resolve, reject) => {
        let data = "";
        const req = http.request({ hostname: "127.0.0.1", port, path: `/tasks/${id}/stream` }, (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            data += chunk;
            if (data.includes('"status":"cancelled"')) {
              resolve(data);
              req.destroy(); // client disconnect after collecting the event
            }
          });
          res.on("end", () => resolve(data)); // server closed cleanly
          res.on("error", (err) => reject(err));
        });
        // ECONNRESET is expected when cleanup() destroys the socket after sending the event.
        req.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code === "ECONNRESET") resolve(data);
          else reject(err);
        });
        // Fire a terminal transition 20ms after the connection is established.
        setTimeout(() => {
          engStore.transition({ taskId: id, to: { stage: "plan", status: "cancelled" }, actor: "user", ts: NOW });
        }, 20);
        req.end();
      });

      expect(collected).toContain("event: status");
      expect(collected).toContain('"status":"cancelled"');
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });

  it("tears down the emitter listener and watcher when the stream ends", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("10001");
    // Pre-advance so the task is cancellable from in_progress.
    engStore.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });

    expect(engStore.transitionEmitter.listenerCount("transition")).toBe(0);

    // Use inject rather than a real server to avoid app.close() hanging on the keep-alive socket
    // that remains after res.end() in cleanup(). The inject Promise stays pending until cleanup()
    // calls res.end(), which happens when we fire a terminal transition below.
    const injectPromise = app.inject({ method: "GET", url: `/tasks/${id}/stream` });

    // Poll until the async route handler has completed its setup and registered the listener.
    const deadline = Date.now() + 1000;
    while (engStore.transitionEmitter.listenerCount("transition") === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(engStore.transitionEmitter.listenerCount("transition")).toBe(1);

    // Terminal transition → onTransition() → cleanup() → res.end() → inject resolves.
    engStore.transition({ taskId: id, to: { stage: "plan", status: "cancelled" }, actor: "user", ts: NOW });

    await injectPromise; // completes because cleanup() called res.end()

    expect(engStore.transitionEmitter.listenerCount("transition")).toBe(0);
  });
});
