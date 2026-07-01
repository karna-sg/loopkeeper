import { describe, expect, it } from "vitest";
import { buildEngStats } from "../src/eng-stats.ts";
import type { EngTask } from "../src/domain/eng-task.ts";
import { EMPTY_ARTIFACTS, DEFAULT_BUDGET } from "../src/domain/eng-task.ts";

const NOW = "2026-06-25T00:00:00.000Z";

function task(o: Partial<EngTask> & Pick<EngTask, "id" | "stage" | "status">): EngTask {
  return {
    jiraKey: o.id,
    jiraId: o.id,
    jiraUrl: `https://jira/${o.id}`,
    title: o.id,
    description: "",
    acceptanceCriteria: null,
    labels: [],
    components: [],
    assignee: "me",
    jiraStatus: "In Progress",
    repo: "owner/repo",
    defaultBranch: "main",
    branch: null,
    worktreePath: null,
    claudeSessionId: null,
    artifacts: EMPTY_ARTIFACTS,
    budget: { ...DEFAULT_BUDGET },
    lastNotifiedStatus: null,
    lastError: null,
    createdTs: NOW,
    updatedTs: NOW,
    cancelPending: false,
    ...o,
  } as EngTask;
}

function withMerge(t: EngTask, mergedTs: string, usdCentsUsed = 0): EngTask {
  return {
    ...t,
    artifacts: {
      ...t.artifacts,
      merge: { commitSha: "abc", mergedTs, mergedBy: "user", method: "squash" },
    },
    budget: { ...t.budget, usdCentsUsed },
  };
}

function withPr(t: EngTask, createdTs: string): EngTask {
  return {
    ...t,
    artifacts: {
      ...t.artifacts,
      pr: { title: "PR", body: "", diffSummary: "", url: "https://github.com/pr/1", number: 1, proposedTs: createdTs, createdTs, approvedBy: null, selfReview: null },
    },
  };
}

function withReview(t: EngTask, rounds: number): EngTask {
  return {
    ...t,
    artifacts: {
      ...t.artifacts,
      review: { comments: [], approved: true, rounds },
    },
  };
}

describe("buildEngStats — empty", () => {
  const s = buildEngStats([], NOW);

  it("returns zeros for counts", () => {
    expect(s.shipped.total).toBe(0);
    expect(s.shipped.last7).toBe(0);
    expect(s.shipped.last30).toBe(0);
    expect(s.inFlight.total).toBe(0);
    expect(s.spend.last7UsdCents).toBe(0);
    expect(s.spend.last30UsdCents).toBe(0);
    expect(s.spend.totalIterations).toBe(0);
  });

  it("returns null medians", () => {
    expect(s.medianTimeToPrHours).toBeNull();
    expect(s.medianTimeToMergeHours).toBeNull();
    expect(s.medianReviewRounds).toBeNull();
  });

  it("returns empty byWeek", () => {
    expect(s.byWeek).toHaveLength(0);
  });
});

describe("buildEngStats — shipped vs in-flight", () => {
  // shipped 10 days ago
  const t1 = withMerge(task({ id: "A", stage: "merge", status: "merged", createdTs: "2026-06-10T00:00:00.000Z" }), "2026-06-15T00:00:00.000Z", 100);
  // shipped 3 days ago
  const t2 = withMerge(task({ id: "B", stage: "merge", status: "merged", createdTs: "2026-06-20T00:00:00.000Z" }), "2026-06-22T00:00:00.000Z", 200);
  // in-flight
  const t3 = task({ id: "C", stage: "dev", status: "in_progress" });
  // cancelled — not in-flight
  const t4 = task({ id: "D", stage: "plan", status: "cancelled" });

  const s = buildEngStats([t1, t2, t3, t4], NOW);

  it("counts shipped correctly", () => {
    expect(s.shipped.total).toBe(2);
    expect(s.shipped.last7).toBe(1); // only t2 (3d ago)
    expect(s.shipped.last30).toBe(2);
  });

  it("counts inFlight (excludes cancelled)", () => {
    expect(s.inFlight.total).toBe(1); // t3 only
  });
});

describe("buildEngStats — medians", () => {
  // Task A: created Jun 10, PR Jun 12 (48h), merged Jun 14 (96h), 2 review rounds
  const tA = withMerge(
    withReview(
      withPr(task({ id: "A", stage: "merge", status: "merged", createdTs: "2026-06-10T00:00:00.000Z" }), "2026-06-12T00:00:00.000Z"),
      2,
    ),
    "2026-06-14T00:00:00.000Z",
  );
  // Task B: created Jun 15, PR Jun 18 (72h), merged Jun 20 (120h), 0 review rounds
  const tB = withMerge(
    withReview(
      withPr(task({ id: "B", stage: "merge", status: "merged", createdTs: "2026-06-15T00:00:00.000Z" }), "2026-06-18T00:00:00.000Z"),
      0,
    ),
    "2026-06-20T00:00:00.000Z",
  );

  const s = buildEngStats([tA, tB], NOW);

  it("computes median time to PR", () => {
    expect(s.medianTimeToPrHours).toBe(60); // median(48, 72)
  });

  it("computes median time to merge", () => {
    expect(s.medianTimeToMergeHours).toBe(108); // median(96, 120)
  });

  it("computes median review rounds", () => {
    expect(s.medianReviewRounds).toBe(1); // median(2, 0)
  });
});

describe("buildEngStats — spend", () => {
  // merged 3 days ago, spent 150 cents
  const tRecent = withMerge(task({ id: "R", stage: "merge", status: "merged" }), "2026-06-22T00:00:00.000Z", 150);
  // merged 20 days ago, spent 80 cents
  const tOld = withMerge(task({ id: "O", stage: "merge", status: "merged" }), "2026-06-05T00:00:00.000Z", 80);
  // in-flight, 50 cents used — not counted in spend windows
  const tActive = { ...task({ id: "I", stage: "dev", status: "in_progress" }), budget: { ...DEFAULT_BUDGET, usdCentsUsed: 50, iterationsUsed: 3 } };

  const s = buildEngStats([tRecent, tOld, tActive], NOW);

  it("spend windows attribute to merge date", () => {
    expect(s.spend.last7UsdCents).toBe(150);  // only tRecent
    expect(s.spend.last30UsdCents).toBe(230); // tRecent + tOld
  });

  it("totalIterations includes all non-cancelled tasks", () => {
    expect(s.spend.totalIterations).toBe(3); // only tActive has iterationsUsed=3
  });
});

describe("buildEngStats — subscription mode (all spend=0)", () => {
  const t1 = withMerge(task({ id: "A", stage: "merge", status: "merged" }), "2026-06-22T00:00:00.000Z", 0);
  const t2 = { ...task({ id: "B", stage: "dev", status: "in_progress" }), budget: { ...DEFAULT_BUDGET, iterationsUsed: 4 } };

  const s = buildEngStats([t1, t2], NOW);

  it("spend is zero when running on subscription", () => {
    expect(s.spend.last7UsdCents).toBe(0);
    expect(s.spend.last30UsdCents).toBe(0);
  });

  it("totalIterations is non-zero (subscription proxy)", () => {
    expect(s.spend.totalIterations).toBe(4);
  });
});

describe("buildEngStats — byWeek", () => {
  // Two tasks merged in the same week, one in a different week
  const tW1a = withMerge(task({ id: "A", stage: "merge", status: "merged" }), "2026-06-22T00:00:00.000Z", 100); // 2026-W26
  const tW1b = withMerge(task({ id: "B", stage: "merge", status: "merged" }), "2026-06-23T00:00:00.000Z", 50);  // 2026-W26
  const tW2  = withMerge(task({ id: "C", stage: "merge", status: "merged" }), "2026-06-15T00:00:00.000Z", 200); // 2026-W25

  const s = buildEngStats([tW1a, tW1b, tW2], NOW);

  it("groups shipped tasks by merge week, oldest first", () => {
    expect(s.byWeek).toHaveLength(2);
    expect(s.byWeek[0]!.week).toBe("2026-W25");
    expect(s.byWeek[0]!.shipped).toBe(1);
    expect(s.byWeek[0]!.spendUsdCents).toBe(200);
    expect(s.byWeek[1]!.week).toBe("2026-W26");
    expect(s.byWeek[1]!.shipped).toBe(2);
    expect(s.byWeek[1]!.spendUsdCents).toBe(150);
  });

  it("caps byWeek at 8 entries", () => {
    // 10 tasks, each in a different week spanning 10 weeks — only the last 8 should appear
    const tasks = Array.from({ length: 10 }, (_, i) => {
      const weekDate = new Date("2026-01-05T00:00:00.000Z"); // start from week 2
      weekDate.setUTCDate(weekDate.getUTCDate() + i * 7);
      return withMerge(task({ id: `T${i}`, stage: "merge", status: "merged" }), weekDate.toISOString());
    });
    const result = buildEngStats(tasks, NOW);
    expect(result.byWeek.length).toBeLessThanOrEqual(8);
  });
});
