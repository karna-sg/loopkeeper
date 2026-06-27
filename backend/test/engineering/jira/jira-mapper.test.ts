import { describe, expect, it } from "vitest";
import { adfToText, extractAcceptanceCriteria, mapJiraIssue } from "../../../src/engineering/jira/jira-mapper.ts";
import type { JiraIssue } from "../../../src/engineering/jira/jira-mapper.ts";

const OPTS = { siteUrl: "https://acme.atlassian.net", repo: "karna/loopkeeper", defaultBranch: "main" };

const issue: JiraIssue = {
  id: "10001",
  key: "LK-1",
  fields: {
    summary: "Add Jira OAuth connector",
    description: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Wire Atlassian 3LO." }] },
        { type: "heading", content: [{ type: "text", text: "Acceptance Criteria" }] },
        { type: "paragraph", content: [{ type: "text", text: "Tokens stored in the vault." }] },
      ],
    },
    status: { name: "To Do" },
    labels: ["backend"],
    components: [{ name: "api" }, { name: "oauth" }],
    assignee: { accountId: "acct-9", displayName: "Karna" },
  },
};

describe("jira-mapper", () => {
  it("flattens ADF to text with block breaks", () => {
    expect(adfToText(issue.fields.description)).toContain("Wire Atlassian 3LO.");
    expect(adfToText({ type: "text", text: "hi" })).toBe("hi");
    expect(adfToText(null)).toBe("");
  });

  it("extracts an acceptance-criteria section", () => {
    expect(extractAcceptanceCriteria("Do X.\nAcceptance Criteria\nTokens stored.")).toBe("Tokens stored.");
    expect(extractAcceptanceCriteria("No criteria here.")).toBeNull();
  });

  it("maps a Jira issue to an EngTaskInput", () => {
    const t = mapJiraIssue(issue, OPTS);
    expect(t).toMatchObject({
      jiraKey: "LK-1",
      jiraId: "10001",
      jiraUrl: "https://acme.atlassian.net/browse/LK-1",
      title: "Add Jira OAuth connector",
      labels: ["backend"],
      components: ["api", "oauth"],
      assignee: "acct-9",
      jiraStatus: "To Do",
      repo: "karna/loopkeeper",
      defaultBranch: "main",
    });
    expect(t.description).toContain("Wire Atlassian 3LO.");
    expect(t.acceptanceCriteria).toBe("Tokens stored in the vault.");
  });

  it("tolerates missing/empty fields", () => {
    const t = mapJiraIssue({ id: "2", key: "LK-2", fields: {} }, OPTS);
    expect(t.title).toBe("LK-2");
    expect(t.assignee).toBe("");
    expect(t.labels).toEqual([]);
    expect(t.components).toEqual([]);
    expect(t.acceptanceCriteria).toBeNull();
  });
});
