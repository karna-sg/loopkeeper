import type { EngStore } from "../../store/eng-store.ts";
import type { JiraClient } from "./jira-client.ts";
import type { JiraIssue } from "./jira-mapper.ts";
import { mapJiraIssue } from "./jira-mapper.ts";
import type { EngTask } from "../../domain/eng-task.ts";
import { taskId, DEFAULT_BUDGET, EMPTY_ARTIFACTS } from "../../domain/eng-task.ts";

export interface JiraSyncResult {
  imported: number;
  updated: number;
  fetched: number;
  /** plan:not_started rows removed because jira_id is no longer in the assignee set. */
  pruned: number;
  /** In-flight rows that are no longer assigned — flagged via lastError, not deleted. */
  flagged: number;
}

/**
 * Imports the user's assigned Jira issues into the orchestration store (FR-2). Jira is the live
 * source of truth: upsertFromJira refreshes metadata keyed on the immutable jira_id, and
 * reconcile prunes rows that have fallen off the assignee list.
 *
 * GET /tasks is served by listTasks(), which hits Jira live (with a 30s TTL cache) and left-joins
 * the result with eng.db pipeline state — so the visible list always reflects current assignments.
 */
export class JiraSyncService {
  readonly #client: JiraClient;
  readonly #store: EngStore;
  readonly #opts: { siteUrl: string; repo: string; defaultBranch: string };
  readonly #cacheTtlMs: number;
  #cache: { issues: JiraIssue[]; expiresAt: number } | null = null;

  constructor(
    client: JiraClient,
    store: EngStore,
    opts: { siteUrl: string; repo: string; defaultBranch: string; cacheTtlMs?: number },
  ) {
    this.#client = client;
    this.#store = store;
    this.#opts = opts;
    this.#cacheTtlMs = opts.cacheTtlMs ?? 30_000;
  }

  /** Fetch assigned issues, using a short TTL cache to avoid hammering Jira on every GET /tasks. */
  async #fetchCached(): Promise<JiraIssue[]> {
    const now = Date.now();
    if (this.#cache && this.#cache.expiresAt > now) return this.#cache.issues;
    const issues = await this.#client.searchAssigned();
    this.#cache = { issues, expiresAt: now + this.#cacheTtlMs };
    return issues;
  }

  /**
   * Live task list for GET /tasks: Jira assignee query left-joined with eng.db pipeline state.
   * Issues not in eng.db are returned as synthetic plan:not_started stubs (not written to DB here).
   */
  async listTasks(): Promise<EngTask[]> {
    const issues = await this.#fetchCached();
    const byJiraId = new Map(this.#store.list().map((t) => [t.jiraId, t]));
    return issues.map((issue) => {
      const mapped = mapJiraIssue(issue, this.#opts);
      const db = byJiraId.get(issue.id);
      if (!db) {
        // Issue not yet in DB: return a live-metadata stub with default pipeline state.
        return {
          id: taskId(issue.id),
          jiraKey: mapped.jiraKey,
          jiraId: mapped.jiraId,
          jiraUrl: mapped.jiraUrl,
          title: mapped.title,
          description: mapped.description,
          acceptanceCriteria: mapped.acceptanceCriteria,
          labels: mapped.labels,
          components: mapped.components,
          assignee: mapped.assignee,
          jiraStatus: mapped.jiraStatus,
          repo: mapped.repo,
          defaultBranch: mapped.defaultBranch,
          branch: null,
          worktreePath: null,
          claudeSessionId: null,
          claudeModel: null,
          stage: "plan" as const,
          status: "not_started" as const,
          artifacts: { ...EMPTY_ARTIFACTS },
          budget: { ...DEFAULT_BUDGET },
          lastNotifiedStatus: null,
          lastError: null,
          createdTs: "",
          updatedTs: "",
        };
      }
      // Merge live Jira metadata onto the DB row so the caller sees current key/title/status.
      return {
        ...db,
        jiraKey: mapped.jiraKey,
        jiraUrl: mapped.jiraUrl,
        title: mapped.title,
        description: mapped.description,
        acceptanceCriteria: mapped.acceptanceCriteria,
        labels: mapped.labels,
        components: mapped.components,
        assignee: mapped.assignee,
        jiraStatus: mapped.jiraStatus,
      };
    });
  }

  async run(args: { nowIso: string }): Promise<JiraSyncResult> {
    // Always fetch fresh for an explicit sync; warm the cache so subsequent listTasks() is fast.
    const issues = await this.#client.searchAssigned();
    this.#cache = { issues, expiresAt: Date.now() + this.#cacheTtlMs };

    const inputs = issues.map((i) => mapJiraIssue(i, this.#opts));
    const { inserted, updated } = this.#store.upsertFromJira(inputs, args.nowIso);

    const liveJiraIds = new Set(issues.map((i) => i.id));
    const { pruned, flagged } = this.#store.reconcile(liveJiraIds, args.nowIso);

    return { imported: inserted, updated, fetched: issues.length, pruned, flagged };
  }
}
