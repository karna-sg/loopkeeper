import type { EngTaskInput } from "../../domain/eng-task.ts";

/** The slice of a Jira Cloud REST v3 issue we consume (read-only). */
export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    /** ADF document object, a plain string (legacy), or null. */
    description?: unknown;
    status?: { name?: string } | null;
    labels?: string[];
    components?: Array<{ name?: string }>;
    assignee?: { accountId?: string; displayName?: string } | null;
  };
}

/** Flatten an Atlassian Document Format (ADF) node to plain text. Tolerant of strings/null. */
export function adfToText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (typeof node !== "object") return "";
  const o = node as Record<string, unknown>;
  // Text leaf.
  if (typeof o.text === "string") return o.text;
  const inner = adfToText(o.content);
  // Block-level nodes get a trailing newline so paragraphs/list items don't run together.
  const blockTypes = new Set(["paragraph", "heading", "listItem", "blockquote", "codeBlock", "rule"]);
  return typeof o.type === "string" && blockTypes.has(o.type) ? `${inner}\n` : inner;
}

/** Extract an "Acceptance Criteria" section from the description text, if present. */
export function extractAcceptanceCriteria(description: string): string | null {
  const match = description.match(/acceptance criteria\s*:?\s*\n?([\s\S]+?)(?:\n\s*\n[A-Z][^\n]{0,40}:|\n#{1,3}\s|$)/i);
  const body = match?.[1]?.trim();
  return body && body.length > 0 ? body : null;
}

/** Map a Jira issue → the input the orchestration store imports. Pure. */
export function mapJiraIssue(
  raw: JiraIssue,
  opts: { siteUrl: string; repo: string; defaultBranch: string },
): EngTaskInput {
  const description = adfToText(raw.fields.description).replace(/\n{3,}/g, "\n\n").trim();
  const components = (raw.fields.components ?? [])
    .map((c) => c.name)
    .filter((n): n is string => typeof n === "string");
  const labels = (raw.fields.labels ?? []).filter((l): l is string => typeof l === "string");
  return {
    jiraKey: raw.key,
    jiraId: raw.id,
    jiraUrl: `${opts.siteUrl.replace(/\/$/, "")}/browse/${raw.key}`,
    title: raw.fields.summary ?? raw.key,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    labels,
    components,
    assignee: raw.fields.assignee?.accountId ?? "",
    jiraStatus: raw.fields.status?.name ?? "",
    repo: opts.repo,
    defaultBranch: opts.defaultBranch,
  };
}
