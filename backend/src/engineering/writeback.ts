/**
 * Compose the advisory Jira comment body for a task (LP-66). Pure function — no I/O.
 * ADF wrapping and HTTP posting live in jira-client.ts; this only produces the human-readable text.
 */
import type { EngTask } from "../domain/eng-task.ts";

export function buildPlanComment(task: EngTask): string {
  const lines: string[] = [];
  lines.push(`LoopKeeper update for ${task.jiraKey}: ${task.title}`);
  lines.push("");

  if (task.artifacts.plan) {
    const planText = task.artifacts.plan.editedText ?? task.artifacts.plan.text;
    if (planText) {
      lines.push("Plan summary:");
      // Trim very long plans so the Jira comment stays readable.
      lines.push(planText.length > 2000 ? `${planText.slice(0, 2000)}\n[… truncated]` : planText);
      lines.push("");
    }
  }

  if (task.artifacts.dev?.branch) {
    const { branch, branchURL } = task.artifacts.dev;
    lines.push(`Branch: ${branchURL ? `${branch} ( ${branchURL} )` : branch}`);
  }

  if (task.artifacts.pr?.url) {
    lines.push(`PR: ${task.artifacts.pr.url}`);
  }

  lines.push("");
  lines.push("_Posted by LoopKeeper (human-approved)_");

  return lines.join("\n");
}
