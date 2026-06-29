import { beforeEach, describe, expect, it } from "vitest";
import { JiraSyncService } from "../../../src/engineering/jira/jira-sync.ts";
import type { JiraClient } from "../../../src/engineering/jira/jira-client.ts";
import type { JiraIssue } from "../../../src/engineering/jira/jira-mapper.ts";
import { EngStore } from "../../../src/store/eng-store.ts";

const NOW = "2026-06-27T00:00:00Z";
const OPTS = { siteUrl: "https://acme.atlassian.net", repo: "karna/loopkeeper", defaultBranch: "main" };

class FakeJiraClient implements JiraClient {
  callCount = 0;
  getCount = 0;
  throwOnGet = false;
  comments: Array<{ issueIdOrKey: string; body: string }> = [];
  constructor(private issues: JiraIssue[]) {}
  async searchAssigned(): Promise<JiraIssue[]> {
    this.callCount++;
    return this.issues;
  }
  async getIssue(idOrKey: string): Promise<JiraIssue | null> {
    this.getCount++;
    if (this.throwOnGet) throw new Error("jira unavailable");
    return this.issues.find((i) => i.id === idOrKey || i.key === idOrKey) ?? null;
  }
  async currentUserAccountId(): Promise<string> {
    return "acct-1";
  }
  async addComment(issueIdOrKey: string, body: string): Promise<void> {
    this.comments.push({ issueIdOrKey, body });
  }
}

/** Build a minimal JiraIssue. jiraId defaults to "1000{N}" where N is the numeric part of key. */
function issue(key: string, summary: string, status = "To Do", jiraId?: string): JiraIssue {
  const id = jiraId ?? `1000${key.split("-")[1] ?? "0"}`;
  return { id, key, fields: { summary, status: { name: status }, assignee: { accountId: "acct-1" } } };
}

describe("JiraSyncService", () => {
  let store: EngStore;
  beforeEach(() => {
    store = new EngStore(":memory:");
  });

  it("imports assigned issues, then refreshes metadata idempotently", async () => {
    const client = new FakeJiraClient([issue("LK-1", "Add OAuth"), issue("LK-2", "Add worker")]);
    const sync = new JiraSyncService(client, store, OPTS);

    const first = await sync.run({ nowIso: NOW });
    expect(first).toEqual({ imported: 2, updated: 0, fetched: 2, pruned: 0, flagged: 0 });
    expect(store.list()).toHaveLength(2);
    expect(store.getByKey("LK-1")?.repo).toBe("karna/loopkeeper");

    // Advance a task's LK stage, then re-sync with a changed Jira status.
    const id = store.getByKey("LK-1")!.id;
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    const client2 = new FakeJiraClient([issue("LK-1", "Add OAuth", "In Progress"), issue("LK-2", "Add worker")]);
    const second = await new JiraSyncService(client2, store, OPTS).run({ nowIso: NOW });
    expect(second).toEqual({ imported: 0, updated: 2, fetched: 2, pruned: 0, flagged: 0 });
    const t = store.getByKey("LK-1")!;
    expect(t.jiraStatus).toBe("In Progress"); // metadata refreshed
    expect(t.status).toBe("in_progress"); // LK stage preserved
  });

  it("key rename: sync with new jira_key for same jira_id preserves row and state", async () => {
    // Initial sync: LK-1 maps to jira_id "10001"
    const client1 = new FakeJiraClient([issue("LK-1", "Add OAuth", "To Do", "10001")]);
    await new JiraSyncService(client1, store, OPTS).run({ nowIso: NOW });
    const id = store.getByKey("LK-1")!.id;
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });

    // After rename: same jira_id, key is now LP-1
    const client2 = new FakeJiraClient([issue("LP-1", "Add OAuth", "In Progress", "10001")]);
    const result = await new JiraSyncService(client2, store, OPTS).run({ nowIso: NOW });
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(1);
    expect(store.count()).toBe(1); // no duplicate
    const after = store.get(id)!;
    expect(after.jiraKey).toBe("LP-1"); // key updated
    expect(after.status).toBe("in_progress"); // pipeline state preserved
  });

  it("prunes not_started stale tasks on sync", async () => {
    await new JiraSyncService(new FakeJiraClient([issue("LK-1", "OAuth"), issue("LK-2", "Worker")]), store, OPTS).run({ nowIso: NOW });
    expect(store.list()).toHaveLength(2);

    // Next sync: LK-2 dropped from Jira
    const result = await new JiraSyncService(new FakeJiraClient([issue("LK-1", "OAuth")]), store, OPTS).run({ nowIso: NOW });
    expect(result.pruned).toBe(1);
    expect(result.flagged).toBe(0);
    expect(store.list()).toHaveLength(1);
    expect(store.getByKey("LK-2")).toBeNull();
  });

  it("flags in-flight tasks dropped from Jira rather than deleting them", async () => {
    await new JiraSyncService(new FakeJiraClient([issue("LK-1", "OAuth"), issue("LK-2", "Keep")]), store, OPTS).run({ nowIso: NOW });
    const id = store.getByKey("LK-1")!.id;
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });

    // LK-1 unassigned in Jira, but the result is non-empty (LK-2 still assigned) so reconcile runs.
    const result = await new JiraSyncService(new FakeJiraClient([issue("LK-2", "Keep")]), store, OPTS).run({ nowIso: NOW });
    expect(result.pruned).toBe(0);
    expect(result.flagged).toBe(1);
    expect(store.get(id)?.lastError).toContain("no longer assigned");
  });

  it("empty assignee fetch is non-destructive: keeps not_started and in-flight tasks (no prune/flag)", async () => {
    await new JiraSyncService(new FakeJiraClient([issue("LK-1", "OAuth"), issue("LK-2", "Worker")]), store, OPTS).run({ nowIso: NOW });
    const id1 = store.getByKey("LK-1")!.id;
    store.transition({ taskId: id1, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });

    // Jira returns [] (transient/auth blip) — must NOT wipe the backlog (the prime symptom guard).
    const result = await new JiraSyncService(new FakeJiraClient([]), store, OPTS).run({ nowIso: NOW });
    expect(result).toEqual({ imported: 0, updated: 0, fetched: 0, pruned: 0, flagged: 0 });
    expect(store.count()).toBe(2); // both survive
    expect(store.get(id1)?.lastError ?? null).toBeNull(); // in-flight not flagged
    expect(store.getByKey("LK-2")).not.toBeNull(); // not_started not pruned
  });

  it("listTasks: live Jira result left-joined with DB pipeline state", async () => {
    // Sync to populate DB
    await new JiraSyncService(new FakeJiraClient([issue("LK-1", "OAuth"), issue("LK-2", "Worker")]), store, OPTS).run({ nowIso: NOW });
    const id1 = store.getByKey("LK-1")!.id;
    store.transition({ taskId: id1, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });

    const client = new FakeJiraClient([issue("LK-1", "OAuth"), issue("LK-2", "Worker")]);
    const sync = new JiraSyncService(client, store, OPTS);
    const tasks = await sync.listTasks();

    expect(tasks).toHaveLength(2);
    const lk1 = tasks.find((t) => t.jiraKey === "LK-1")!;
    expect(lk1.status).toBe("in_progress"); // DB pipeline state merged in
    const lk2 = tasks.find((t) => t.jiraKey === "LK-2")!;
    expect(lk2.status).toBe("not_started");
  });

  it("listTasks: returns synthetic stub for Jira issue not yet in DB", async () => {
    const client = new FakeJiraClient([issue("LK-99", "Brand new", "To Do", "19999")]);
    const sync = new JiraSyncService(client, store, OPTS);
    const tasks = await sync.listTasks();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.jiraKey).toBe("LK-99");
    expect(tasks[0]?.stage).toBe("plan");
    expect(tasks[0]?.status).toBe("not_started");
    expect(store.list()).toHaveLength(0); // not written to DB until an explicit sync
  });

  it("getTask: overlays live Jira metadata onto the DB pipeline row (fresh, by jira_id)", async () => {
    await new JiraSyncService(new FakeJiraClient([issue("LK-1", "Old title", "To Do", "10001")]), store, OPTS).run({ nowIso: NOW });
    const id = store.getByKey("LK-1")!.id;
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    const db = store.get(id)!;

    const client = new FakeJiraClient([issue("LK-1", "New title", "In Progress", "10001")]);
    const merged = await new JiraSyncService(client, store, OPTS).getTask(db);
    expect(client.getCount).toBe(1); // fetched THIS issue live, no cache
    expect(merged.title).toBe("New title"); // live metadata overlaid
    expect(merged.jiraStatus).toBe("In Progress");
    expect(merged.status).toBe("in_progress"); // pipeline state preserved from DB
    expect(merged.id).toBe(db.id);
  });

  it("getTask: falls back to the DB row when Jira is unavailable (never throws)", async () => {
    await new JiraSyncService(new FakeJiraClient([issue("LK-1", "Title", "To Do", "10001")]), store, OPTS).run({ nowIso: NOW });
    const db = store.getByKey("LK-1")!;
    const client = new FakeJiraClient([issue("LK-1", "Changed", "In Progress", "10001")]);
    client.throwOnGet = true;
    const result = await new JiraSyncService(client, store, OPTS).getTask(db);
    expect(result).toEqual(db); // unchanged fallback
  });

  it("getTask: returns the DB row when the issue is gone (null)", async () => {
    await new JiraSyncService(new FakeJiraClient([issue("LK-1", "Title", "To Do", "10001")]), store, OPTS).run({ nowIso: NOW });
    const db = store.getByKey("LK-1")!;
    const result = await new JiraSyncService(new FakeJiraClient([]), store, OPTS).getTask(db);
    expect(result.title).toBe(db.title); // DB row, unchanged
  });

  it("getTask + listTasks produce an identical metadata overlay (no drift)", async () => {
    await new JiraSyncService(new FakeJiraClient([issue("LK-1", "Old", "To Do", "10001")]), store, OPTS).run({ nowIso: NOW });
    const id = store.getByKey("LK-1")!.id;
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    const db = store.get(id)!;

    const sync = new JiraSyncService(new FakeJiraClient([issue("LK-1", "Fresh", "In Progress", "10001")]), store, OPTS);
    const fromList = (await sync.listTasks()).find((t) => t.jiraKey === "LK-1")!;
    const fromGet = await sync.getTask(db);
    for (const k of ["jiraKey", "jiraUrl", "title", "description", "acceptanceCriteria", "labels", "components", "assignee", "jiraStatus"] as const) {
      expect(fromGet[k]).toEqual(fromList[k]);
    }
  });

  it("listTasks: serves cache within TTL, bypasses cache for run()", async () => {
    const client = new FakeJiraClient([issue("LK-1", "OAuth")]);
    const sync = new JiraSyncService(client, store, { ...OPTS, cacheTtlMs: 60_000 });

    await sync.listTasks();
    await sync.listTasks(); // second call within TTL
    expect(client.callCount).toBe(1); // cache hit

    await sync.run({ nowIso: NOW }); // run() always fetches fresh
    expect(client.callCount).toBe(2);

    await sync.listTasks(); // cache was warmed by run()
    expect(client.callCount).toBe(2); // still cached
  });
});
