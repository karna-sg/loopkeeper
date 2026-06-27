import type { EngStore } from "../../store/eng-store.ts";
import type { JiraClient } from "./jira-client.ts";
import { mapJiraIssue } from "./jira-mapper.ts";

export interface JiraSyncResult {
  imported: number;
  updated: number;
  fetched: number;
}

/**
 * Imports the user's assigned Jira issues into the orchestration store (FR-2). One-way: Jira owns
 * task metadata; `upsertFromJira` refreshes it but never regresses the LoopKeeper stage. Mirrors the
 * `ScanService` shape (a `run()` that returns counts).
 */
export class JiraSyncService {
  readonly #client: JiraClient;
  readonly #store: EngStore;
  readonly #opts: { siteUrl: string; repo: string; defaultBranch: string };

  constructor(client: JiraClient, store: EngStore, opts: { siteUrl: string; repo: string; defaultBranch: string }) {
    this.#client = client;
    this.#store = store;
    this.#opts = opts;
  }

  async run(args: { nowIso: string }): Promise<JiraSyncResult> {
    const issues = await this.#client.searchAssigned();
    const inputs = issues.map((i) => mapJiraIssue(i, this.#opts));
    const { inserted, updated } = this.#store.upsertFromJira(inputs, args.nowIso);
    return { imported: inserted, updated, fetched: issues.length };
  }
}
