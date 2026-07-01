/** Prompt builders for the Claude Code stages. Kept pure + small so they're easy to tune/test. */
import type { EngTask, ReviewComment } from "../domain/eng-task.ts";
import type { DiffFile } from "./ports.ts";

function requirements(task: EngTask): string {
  const ac = task.acceptanceCriteria ? `\n\nAcceptance criteria:\n${task.acceptanceCriteria}` : "";
  const labels = task.labels.length ? `\nLabels: ${task.labels.join(", ")}` : "";
  return `Jira ${task.jiraKey}: ${task.title}\n\n${task.description}${ac}${labels}`;
}

export function renderPlanPrompt(task: EngTask): string {
  return [
    `You are planning the implementation of a software task in the repo ${task.repo}.`,
    `Do NOT modify any files — produce a clear, reviewable implementation plan only.`,
    ``,
    requirements(task),
    ``,
    `Write a step-by-step plan: which files to change, the approach, edge cases, and how to test it.`,
    ``,
    `After the prose, include EXACTLY ONE fenced JSON block (fence label must be \`\`\`json):`,
    "```json",
    `{`,
    `  "summary": "<one-sentence executive summary>",`,
    `  "steps": ["<step 1>", "<step 2>"],`,
    `  "changedFiles": ["path/to/file.ts"],`,
    `  "newTests": ["path/to/test.test.ts"],`,
    `  "riskFlags": ["<risk or concern>"]`,
    `}`,
    "```",
    `Omit a field (or use null) if not applicable. The JSON is machine-parsed — keep it valid.`,
  ].join("\n");
}

export function renderDevPrompt(task: EngTask): string {
  return [
    `Implement the approved plan for ${task.jiraKey} on branch ${task.branch ?? "(this branch)"}.`,
    `Make the code changes and keep the existing unit tests green; add tests for new behavior.`,
    `When done, summarize the changes you made.`,
    ``,
    requirements(task),
  ].join("\n");
}

export function renderFixPrompt(summary: string): string {
  return [
    `The verification checks (typecheck, lint, and unit tests) are failing. Fix the code so they all pass — do not delete or skip tests/checks to make them pass.`,
    ``,
    `Output:`,
    summary,
  ].join("\n");
}

/** Post-merge CI/build failure (fix-forward): the change merged but main is red. */
export function renderBuildFixPrompt(ciError: string): string {
  return [
    `The change was merged but CI on main FAILED. Fix the code so 'pnpm -r typecheck', 'pnpm -r lint', and 'pnpm -r test' all pass, then summarize the fix.`,
    `A common cause: a port/interface method was added without updating its test doubles/fakes, or a shared type changed. Check that any new interface members are implemented everywhere (including test fakes).`,
    ``,
    `CI error:`,
    ciError || "(no error captured — run the checks locally and fix whatever fails)",
  ].join("\n");
}

/** Cold-start (resume unavailable): re-inject the approved plan + work already on the branch. */
export function renderColdStartPrompt(task: EngTask, branchLog: string): string {
  const plan = task.artifacts.plan?.editedText ?? task.artifacts.plan?.text ?? "(no stored plan)";
  return [
    `Continue implementing ${task.jiraKey}. A previous session is unavailable, so here is the full context.`,
    `Do not redo or revert work already committed on this branch.`,
    ``,
    `Approved plan:`,
    plan,
    ``,
    `Work already on the branch:`,
    branchLog || "(no commits yet)",
    ``,
    requirements(task),
  ].join("\n");
}

function formatDiff(files: DiffFile[]): string {
  if (files.length === 0) return "(no diff available)";
  return files
    .map((f) => {
      const header = `--- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`;
      const hunks = f.hunks
        .map((h) => [h.header, ...h.lines.map((l) => `${l.type}${l.text}`)].join("\n"))
        .join("\n");
      return hunks ? `${header}\n${hunks}` : header;
    })
    .join("\n\n");
}

/** Fresh-session prompt for the AC verification run (LP-33). Agent must return ONLY a JSON array. */
export function renderAcCheckPrompt(task: EngTask, diff: DiffFile[]): string {
  const ac = task.acceptanceCriteria ?? "(no acceptance criteria recorded)";
  return [
    `You are verifying whether a code change satisfies acceptance criteria.`,
    `Read the diff and evaluate each criterion independently.`,
    `Output ONLY a JSON array — no prose, no markdown fences.`,
    `Each element: { "criterion": "<text>", "pass": true|false, "evidence": "<one sentence why>" }`,
    ``,
    `Task: ${task.jiraKey} — ${task.title}`,
    ``,
    `Acceptance criteria:`,
    ac,
    ``,
    `Code diff:`,
    formatDiff(diff),
  ].join("\n");
}

export function renderAddressCommentsPrompt(comments: readonly ReviewComment[]): string {
  const list = comments
    .filter((c) => !c.resolution)
    .map((c) => `- ${c.path ? `${c.path}: ` : ""}${c.body}`)
    .join("\n");
  return [
    `Address these PR review comments. Make the changes, keep tests green, and briefly note how you resolved each.`,
    ``,
    list || "(no unresolved comments)",
  ].join("\n");
}
