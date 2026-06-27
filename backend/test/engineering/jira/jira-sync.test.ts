import { beforeEach, describe, expect, it } from "vitest";
import { JiraSyncService } from "../../../src/engineering/jira/jira-sync.ts";
import type { JiraClient } from "../../../src/engineering/jira/jira-client.ts";
import type { JiraIssue } from "../../../src/engineering/jira/jira-mapper.ts";
import { EngStore } from "../../../src/store/eng-store.ts";

const NOW = "2026-06-27T00:00:00Z";

class FakeJiraClient implements JiraClient {
  constructor(private issues: JiraIssue[]) {}
  async searchAssigned(): Promise<JiraIssue[]> {
    return this.issues;
  }
  async currentUserAccountId(): Promise<string> {
    return "acct-1";
  }
}

function issue(key: string, summary: string, status = "To Do"): JiraIssue {
  return { id: key.replace("LK-", "100"), key, fields: { summary, status: { name: status }, assignee: { accountId: "acct-1" } } };
}

describe("JiraSyncService", () => {
  let store: EngStore;
  beforeEach(() => {
    store = new EngStore(":memory:");
  });

  it("imports assigned issues, then refreshes metadata idempotently", async () => {
    const client = new FakeJiraClient([issue("LK-1", "Add OAuth"), issue("LK-2", "Add worker")]);
    const sync = new JiraSyncService(client, store, { siteUrl: "https://acme.atlassian.net", repo: "karna/loopkeeper", defaultBranch: "main" });

    const first = await sync.run({ nowIso: NOW });
    expect(first).toEqual({ imported: 2, updated: 0, fetched: 2 });
    expect(store.list()).toHaveLength(2);
    expect(store.getByKey("LK-1")?.repo).toBe("karna/loopkeeper");

    // Advance a task's LK stage, then re-sync with a changed Jira status.
    const id = store.getByKey("LK-1")!.id;
    store.transition({ taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ts: NOW });
    const client2 = new FakeJiraClient([issue("LK-1", "Add OAuth", "In Progress"), issue("LK-2", "Add worker")]);
    const second = await new JiraSyncService(client2, store, { siteUrl: "https://acme.atlassian.net", repo: "karna/loopkeeper", defaultBranch: "main" }).run({ nowIso: NOW });
    expect(second).toEqual({ imported: 0, updated: 2, fetched: 2 });
    const t = store.getByKey("LK-1")!;
    expect(t.jiraStatus).toBe("In Progress"); // metadata refreshed
    expect(t.status).toBe("in_progress"); // LK stage preserved
  });
});
