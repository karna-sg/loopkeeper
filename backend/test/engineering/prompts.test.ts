import { describe, expect, it } from "vitest";
import { renderAcCheckPrompt, renderPreReviewPrompt, renderRebuttalPrompt } from "../../src/engineering/prompts.ts";
import type { DiffFile } from "../../src/engineering/ports.ts";
import type { EngTask, PreReviewFinding } from "../../src/domain/eng-task.ts";

const baseTask = {
  id: "task-1",
  jiraKey: "LK-1",
  jiraId: "10001",
  jiraUrl: "https://x.atlassian.net/browse/LK-1",
  title: "Add a thing",
  description: "Do the thing.",
  acceptanceCriteria: "It works.\nIt is fast.",
  labels: [],
  components: [],
  assignee: "acct-1",
  jiraStatus: "In Progress",
  repo: "karna/loopkeeper",
  defaultBranch: "main",
  branch: "feat/lk-1-add-a-thing",
  worktreePath: null,
  claudeSessionId: null,
  claudeModel: null,
  stage: "pr" as const,
  status: "proposed" as const,
  artifacts: { plan: null, dev: null, test: null, pr: null, review: null, merge: null, deploy: null, verify: null, rollback: null, acCheck: null, preReview: null },
  budget: { maxIterations: 6, iterationsUsed: 0, maxUsdCents: 500, usdCentsUsed: 0, maxReviewRounds: 3, reviewRoundsUsed: 0 },
  lastNotifiedStatus: null,
  lastError: null,
  createdTs: "2026-06-27T00:00:00Z",
  updatedTs: "2026-06-27T00:00:00Z",
} satisfies EngTask;

const sampleDiff: DiffFile[] = [
  {
    path: "src/foo.ts",
    status: "modified",
    additions: 5,
    deletions: 1,
    hunks: [
      {
        header: "@@ -1,1 +1,5 @@",
        lines: [
          { type: "-", text: "export const foo = 0;" },
          { type: "+", text: "export const foo = 42;" },
        ],
      },
    ],
  },
];

describe("renderAcCheckPrompt", () => {
  it("includes acceptance criteria text in the prompt", () => {
    const prompt = renderAcCheckPrompt(baseTask, sampleDiff);
    expect(prompt).toContain("It works.");
    expect(prompt).toContain("It is fast.");
  });

  it("includes the diff file path and hunk content", () => {
    const prompt = renderAcCheckPrompt(baseTask, sampleDiff);
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("@@ -1,1 +1,5 @@");
    expect(prompt).toContain("+export const foo = 42;");
  });

  it("instructs the agent to return a JSON array", () => {
    const prompt = renderAcCheckPrompt(baseTask, sampleDiff);
    expect(prompt).toContain("JSON array");
    expect(prompt).toContain('"criterion"');
    expect(prompt).toContain('"pass"');
    expect(prompt).toContain('"evidence"');
  });

  it("falls back gracefully when acceptanceCriteria is null", () => {
    const task = { ...baseTask, acceptanceCriteria: null };
    const prompt = renderAcCheckPrompt(task, []);
    expect(prompt).toContain("no acceptance criteria recorded");
  });

  it("falls back gracefully when diff is empty", () => {
    const prompt = renderAcCheckPrompt(baseTask, []);
    expect(prompt).toContain("no diff available");
  });

  it("includes the Jira key and title for context", () => {
    const prompt = renderAcCheckPrompt(baseTask, sampleDiff);
    expect(prompt).toContain("LK-1");
    expect(prompt).toContain("Add a thing");
  });
});

describe("renderPreReviewPrompt", () => {
  it("includes the Jira key and diff content", () => {
    const prompt = renderPreReviewPrompt(baseTask, sampleDiff);
    expect(prompt).toContain("LK-1");
    expect(prompt).toContain("src/foo.ts");
  });

  it("instructs the agent to return a JSON object with findings array", () => {
    const prompt = renderPreReviewPrompt(baseTask, sampleDiff);
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"area"');
    expect(prompt).toContain('"note"');
  });

  it("identifies the reviewer as independent (not the author)", () => {
    const prompt = renderPreReviewPrompt(baseTask, sampleDiff);
    expect(prompt).toContain("independent");
  });

  it("falls back gracefully when diff is empty", () => {
    const prompt = renderPreReviewPrompt(baseTask, []);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("no diff available");
  });
});

describe("renderRebuttalPrompt", () => {
  const findings: PreReviewFinding[] = [
    { severity: "high", area: "security", note: "No input validation on user data.", response: "" },
    { severity: "medium", area: "tests", note: "Edge case for empty array not tested.", response: "" },
  ];

  it("includes each finding area and note", () => {
    const prompt = renderRebuttalPrompt(baseTask, findings);
    expect(prompt).toContain("security");
    expect(prompt).toContain("No input validation on user data.");
    expect(prompt).toContain("tests");
    expect(prompt).toContain("Edge case for empty array not tested.");
  });

  it("names the Jira key so the author knows what they're responding to", () => {
    const prompt = renderRebuttalPrompt(baseTask, findings);
    expect(prompt).toContain("LK-1");
  });

  it("instructs the agent to return a JSON array with a response field", () => {
    const prompt = renderRebuttalPrompt(baseTask, findings);
    expect(prompt).toContain('"response"');
    expect(prompt).toContain("JSON array");
  });

  it("handles empty findings list", () => {
    const prompt = renderRebuttalPrompt(baseTask, []);
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("[]");
  });
});
