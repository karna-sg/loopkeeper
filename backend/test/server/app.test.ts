import { describe, expect, it } from "vitest";
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

const IDENTITY: UserIdentity = { displayName: "Karna", aliases: [], timezone: "Asia/Kolkata" };
const NOW = "2026-06-25T04:00:00Z";
const noopHttp: HttpClient = { post: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }), getJson: async () => ({}) };

function makeApp(configOverrides: Partial<ServerConfig> = {}): { app: ReturnType<typeof buildApp>; store: LoopsStore; engStore: EngStore; push: FakePushSender } {
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
    buildJiraSync: () => {
      throw new Error("Jira not connected");
    },
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
    expect(loops[0]?.dueDate).toBe("2026-06-26");
    const id = loops[0]!.id;

    const brief = await app.inject({ method: "GET", url: "/brief" });
    expect((brief.json() as { upcoming: unknown[] }).upcoming).toHaveLength(1);

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
    expect(active[0]?.dueDate).toBe("2026-07-03"); // 2026-06-26 + 1 week
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
    expect((await app.inject({ method: "GET", url: "/tasks" })).json()).toEqual({ tasks: [] });
    engStore.upsertFromJira([engInput()], NOW);
    const tasks = ((await app.inject({ method: "GET", url: "/tasks" })).json() as { tasks: Array<{ jiraKey: string; stage: string; status: string }> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ jiraKey: "LK-1", stage: "plan", status: "not_started" });
  });

  it("filters /tasks to the assignee when a self identity is configured", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ jiraKey: "LK-1", assignee: "acct-1" }), engInput({ jiraKey: "LK-2", assignee: "someone-else" })], NOW);
    const tasks = ((await app.inject({ method: "GET", url: "/tasks" })).json() as { tasks: Array<{ jiraKey: string }> }).tasks;
    expect(tasks.map((t) => t.jiraKey)).toEqual(["LK-1"]);
  });

  it("GET /tasks/:id returns task + events; 404 for unknown", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const id = taskId("LK-1");
    const body = (await app.inject({ method: "GET", url: `/tasks/${id}` })).json() as { task: { id: string }; events: unknown[] };
    expect(body.task.id).toBe(id);
    expect(body.events).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/tasks/nope" })).statusCode).toBe(404);
  });

  it("GET /tasks/:id/status reports idle for a fresh task", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput()], NOW);
    const status = (await app.inject({ method: "GET", url: `/tasks/${taskId("LK-1")}/status` })).json() as { runState: string; stage: string };
    expect(status).toMatchObject({ stage: "plan", runState: "idle" });
  });

  it("POST /tasks/sync is 503 until Jira is connected", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "POST", url: "/tasks/sync" })).statusCode).toBe(503);
  });

  it("gates fail closed without a self identity (403)", async () => {
    const { app, engStore } = makeApp();
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    expect((await app.inject({ method: "POST", url: `/tasks/${taskId("LK-1")}/prepare-plan` })).statusCode).toBe(403);
  });

  it("prepare-plan transitions to in_progress and enqueues a plan job", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("LK-1");
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/prepare-plan` });
    expect(res.json()).toEqual({ started: true });
    expect(engStore.get(id)).toMatchObject({ stage: "plan", status: "in_progress" });
    expect(engStore.runningJobForTask(id)?.kind).toBe("plan");
  });

  it("plan/approve enforces the gate and enqueues dev_test", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1" });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("LK-1");
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

  it("merge/approve crosses Gate 3 and enqueues a merge job with the method", async () => {
    const { app, engStore } = makeApp({ selfAccountId: "acct-1", github: { repo: "karna/loopkeeper", baseBranch: "main" } });
    engStore.upsertFromJira([engInput({ assignee: "acct-1" })], NOW);
    const id = taskId("LK-1");
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
});
