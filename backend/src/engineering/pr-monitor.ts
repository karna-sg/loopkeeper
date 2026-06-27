import type { EngStore } from "../store/eng-store.ts";
import type { GithubPort } from "./ports.ts";
import type { ReviewComment } from "../domain/eng-task.ts";
import { applyTransition } from "./orchestrator.ts";

/** Union review comments by external id, preserving any resolution already recorded locally. */
function mergeComments(existing: readonly ReviewComment[], incoming: readonly ReviewComment[]): ReviewComment[] {
  const byId = new Map<string, ReviewComment>();
  for (const c of existing) byId.set(c.externalId, c);
  for (const c of incoming) {
    const prev = byId.get(c.externalId);
    byId.set(c.externalId, prev ? { ...c, resolution: prev.resolution, resolvedTs: prev.resolvedTs, resolvedCommitSha: prev.resolvedCommitSha } : c);
  }
  return [...byId.values()];
}

/**
 * Polls open PRs for tasks awaiting review (FR-20). On a review approval → review:approved → merge:ready.
 * On new unresolved comments → review:comments_received. Idempotent (comment external ids dedupe;
 * transitions are no-ops when already there). Runs as an api-side scheduler job.
 */
export class PrMonitor {
  readonly #engStore: EngStore;
  readonly #github: GithubPort;
  readonly #now: () => string;

  constructor(engStore: EngStore, github: GithubPort, now: () => string) {
    this.#engStore = engStore;
    this.#github = github;
    this.#now = now;
  }

  async run(): Promise<{ checked: number }> {
    const tasks = this.#engStore.list().filter((t) => t.stage === "review" && (t.status === "awaiting_review" || t.status === "comments_addressed"));
    for (const task of tasks) {
      const num = task.artifacts.pr?.number;
      if (!num) continue;
      const state = await this.#github.getPr(task.repo, num);
      const now = this.#now();
      const existing = task.artifacts.review?.comments ?? [];
      const merged = mergeComments(existing, state.comments);
      const knownIds = new Set(existing.map((c) => c.externalId));
      const hasNewUnresolved = merged.some((c) => !c.resolution && !knownIds.has(c.externalId));

      this.#engStore.setArtifact(
        task.id,
        { review: { comments: merged, approved: state.reviewDecision === "APPROVED", rounds: task.artifacts.review?.rounds ?? 0 } },
        now,
      );

      if (state.reviewDecision === "APPROVED") {
        applyTransition(this.#engStore, { taskId: task.id, to: { stage: "review", status: "approved" }, actor: "system", ts: now }, now);
        applyTransition(this.#engStore, { taskId: task.id, to: { stage: "merge", status: "ready" }, actor: "system", ts: now }, now);
      } else if (hasNewUnresolved && task.status === "awaiting_review") {
        applyTransition(this.#engStore, { taskId: task.id, to: { stage: "review", status: "comments_received" }, actor: "system", ts: now }, now);
      }
    }
    return { checked: tasks.length };
  }
}
