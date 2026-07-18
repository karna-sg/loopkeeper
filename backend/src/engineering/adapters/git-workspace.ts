import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { branchNameFor } from "../../domain/eng-task.ts";
import type { DiffGuardFlag, EngTask } from "../../domain/eng-task.ts";
import type { CommitResult, Workspace, WorktreeInfo } from "../ports.ts";
import { DiffGuardError, depFlagFromReport, inspectDiff, stagedFilesFromDiff } from "../diff-guard.ts";
import { runProcess } from "./spawn.ts";

export interface GitWorkspaceConfig {
  repoUrl: string;
  /** The single mirror/primary clone all worktrees branch from. */
  mirrorDir: string;
  worktreeRoot: string;
  defaultBranch: string;
  /** Repo-scoped token; injected per-command via http.extraheader, never written to .git/config. */
  token: string | null;
  /** Committer identity, injected per-commit via `-c user.*` (the worker container has none). */
  authorName: string;
  authorEmail: string;
}

/**
 * Per-task git worktree lifecycle: one mirror clone + `git worktree add` per task branch. All
 * primary-clone operations (clone/fetch/worktree) are serialized behind a mutex so they stay safe
 * if concurrency is ever raised. Auth is injected via a one-shot `-c http.extraheader` so the token
 * never lands in on-disk config (P3-2).
 */
export class GitWorkspace implements Workspace {
  readonly #cfg: GitWorkspaceConfig;
  #lock: Promise<void> = Promise.resolve();

  constructor(cfg: GitWorkspaceConfig) {
    this.#cfg = cfg;
  }

  #authArgs(): string[] {
    if (!this.#cfg.token) return [];
    const basic = Buffer.from(`x-access-token:${this.#cfg.token}`).toString("base64");
    return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  async #git(cwd: string | null, args: readonly string[], withAuth = false): Promise<{ ok: boolean; out: string }> {
    const full = [...(withAuth ? this.#authArgs() : []), ...args];
    const res = await runProcess("git", full, { ...(cwd ? { cwd } : {}), timeoutMs: 120_000 });
    return { ok: res.code === 0, out: `${res.stdout}\n${res.stderr}`.trim() };
  }

  /** Serialize primary-clone mutations. */
  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #ensureMirror(): Promise<void> {
    if (existsSync(join(this.#cfg.mirrorDir, ".git")) || existsSync(join(this.#cfg.mirrorDir, "HEAD"))) {
      await this.#git(this.#cfg.mirrorDir, ["fetch", "origin", this.#cfg.defaultBranch], true);
      return;
    }
    mkdirSync(this.#cfg.worktreeRoot, { recursive: true });
    const r = await this.#git(null, ["clone", this.#cfg.repoUrl, this.#cfg.mirrorDir], true);
    if (!r.ok) throw new Error(`git clone failed: ${r.out.slice(-300)}`);
  }

  async ensure(task: EngTask): Promise<WorktreeInfo> {
    const branch = task.branch ?? branchNameFor(task.jiraKey, task.title);
    const path = task.worktreePath ?? join(this.#cfg.worktreeRoot, branch);
    return this.#withLock(async () => {
      await this.#ensureMirror();
      if (!existsSync(path)) {
        const base = `origin/${this.#cfg.defaultBranch}`;
        const created = await this.#git(this.#cfg.mirrorDir, ["worktree", "add", "-b", branch, path, base]);
        if (!created.ok) {
          // Branch may already exist — attach a worktree to it.
          const attached = await this.#git(this.#cfg.mirrorDir, ["worktree", "add", path, branch]);
          if (!attached.ok) throw new Error(`git worktree add failed: ${created.out.slice(-300)}`);
        }
      }
      return { path, branch };
    });
  }

  async commitAndPush(task: EngTask, message: string): Promise<CommitResult> {
    const branch = task.branch ?? branchNameFor(task.jiraKey, task.title);
    const path = task.worktreePath ?? join(this.#cfg.worktreeRoot, branch);
    await this.#git(path, ["add", "-A"]);
    const status = await this.#git(path, ["status", "--porcelain"]);
    const files = status.out ? status.out.split("\n").filter(Boolean).map((l) => l.slice(3).trim()) : [];
    const filesChanged = files.length;
    let diffGuard: DiffGuardFlag | undefined;
    if (filesChanged > 0) {
      // DiffGuard (LP-53): inspect the STAGED content BEFORE committing. A hard secret/forbidden-path
      // hit throws (→ the worker escalates to `blocked`, commit skipped); a dependency change is a soft
      // flag returned to the orchestrator. Scans only added (`+`) lines, so it never re-flags untouched
      // code or reacts to deletions.
      const report = inspectDiff(stagedFilesFromDiff((await this.#git(path, ["diff", "--cached"])).out));
      if (report.blocked) throw new DiffGuardError(report.secretHits);
      diffGuard = depFlagFromReport(report) ?? undefined;
      // Inject identity per-commit (the container has no global git identity); never persisted to config.
      const ident = ["-c", `user.name=${this.#cfg.authorName}`, "-c", `user.email=${this.#cfg.authorEmail}`];
      const commit = await this.#git(path, [...ident, "commit", "-m", message]);
      if (!commit.ok) throw new Error(`git commit failed: ${commit.out.slice(-300)}`);
    }
    const push = await this.#git(path, ["push", "-u", "origin", branch], true);
    if (!push.ok) throw new Error(`git push failed: ${push.out.slice(-300)}`);
    const sha = (await this.#git(path, ["rev-parse", "HEAD"])).out.trim() || null;
    return { sha, pushed: true, filesChanged, files, ...(diffGuard ? { diffGuard } : {}) };
  }

  async branchLog(task: EngTask): Promise<string> {
    const branch = task.branch ?? branchNameFor(task.jiraKey, task.title);
    const path = task.worktreePath ?? join(this.#cfg.worktreeRoot, branch);
    const r = await this.#git(path, ["log", "--oneline", `origin/${this.#cfg.defaultBranch}..HEAD`]);
    return r.ok ? r.out.slice(0, 2000) : "";
  }

  async revert(task: EngTask, sha: string): Promise<{ revertSha: string; branch: string }> {
    const branch = `rollback/${task.jiraKey.toLowerCase()}-${sha.slice(0, 7)}`;
    const path = join(this.#cfg.worktreeRoot, branch);
    return this.#withLock(async () => {
      await this.#ensureMirror();
      if (!existsSync(path)) {
        const base = `origin/${this.#cfg.defaultBranch}`;
        const created = await this.#git(this.#cfg.mirrorDir, ["worktree", "add", "-b", branch, path, base]);
        if (!created.ok) {
          const attached = await this.#git(this.#cfg.mirrorDir, ["worktree", "add", path, branch]);
          if (!attached.ok) throw new Error(`git worktree add (revert) failed: ${created.out.slice(-300)}`);
        }
      }
      const ident = ["-c", `user.name=${this.#cfg.authorName}`, "-c", `user.email=${this.#cfg.authorEmail}`];
      const rev = await this.#git(path, [...ident, "revert", "--no-edit", sha]);
      if (!rev.ok) throw new Error(`git revert failed: ${rev.out.slice(-300)}`);
      const push = await this.#git(path, ["push", "-u", "origin", branch], true);
      if (!push.ok) throw new Error(`git push (revert) failed: ${push.out.slice(-300)}`);
      const revertSha = (await this.#git(path, ["rev-parse", "HEAD"])).out.trim();
      return { revertSha, branch };
    });
  }

  async remove(task: EngTask): Promise<void> {
    const branch = task.branch ?? branchNameFor(task.jiraKey, task.title);
    const path = task.worktreePath ?? join(this.#cfg.worktreeRoot, branch);
    await this.#withLock(async () => {
      await this.#git(this.#cfg.mirrorDir, ["worktree", "remove", "--force", path]);
      await this.#git(this.#cfg.mirrorDir, ["worktree", "prune"]);
    });
  }
}
