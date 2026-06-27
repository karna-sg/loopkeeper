import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Actor,
  AgentRun,
  AgentRunStatus,
  DeployArtifact,
  EngJob,
  EngTask,
  EngTaskInput,
  JobKind,
  JobState,
  Stage,
  StageEvent,
  StageStatus,
  Status,
  TaskArtifacts,
  TaskBudget,
} from "../domain/eng-task.ts";
import { DEFAULT_BUDGET, EMPTY_ARTIFACTS, taskId } from "../domain/eng-task.ts";
import { canTransition, needsHuman, transitionNeedsGate } from "../engineering/state-machine.ts";

/** Filters for {@link EngStore.list}. */
export interface EngTaskFilter {
  assignee?: string;
  stage?: Stage;
  /** Only tasks waiting on a human (computed in SQL is awkward; filtered in JS — small set). */
  needsHuman?: boolean;
}

export interface TransitionArgs {
  taskId: string;
  to: StageStatus;
  actor: Actor;
  actorDetail?: string;
  note?: string;
  gateApproved?: boolean;
  ts: string;
}

export interface TransitionOutcome {
  ok: boolean;
  /** True when the state actually changed (false for an idempotent no-op). */
  changed: boolean;
  reason?: string;
}

interface TaskRow {
  id: string;
  jira_key: string;
  jira_id: string;
  jira_url: string;
  title: string;
  description: string;
  acceptance_criteria: string | null;
  labels: string;
  components: string;
  assignee: string;
  jira_status: string;
  repo: string;
  default_branch: string;
  branch: string | null;
  worktree_path: string | null;
  claude_session_id: string | null;
  stage: string;
  status: string;
  artifacts: string;
  budget: string;
  last_notified_status: string | null;
  last_error: string | null;
  created_ts: string;
  updated_ts: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function parseStringArray(raw: string): string[] {
  const parsed = parseJson<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
}

function toTask(r: TaskRow): EngTask {
  return {
    id: r.id,
    jiraKey: r.jira_key,
    jiraId: r.jira_id,
    jiraUrl: r.jira_url,
    title: r.title,
    description: r.description,
    acceptanceCriteria: r.acceptance_criteria,
    labels: parseStringArray(r.labels),
    components: parseStringArray(r.components),
    assignee: r.assignee,
    jiraStatus: r.jira_status,
    repo: r.repo,
    defaultBranch: r.default_branch,
    branch: r.branch,
    worktreePath: r.worktree_path,
    claudeSessionId: r.claude_session_id,
    stage: r.stage as Stage,
    status: r.status as Status,
    artifacts: { ...EMPTY_ARTIFACTS, ...parseJson<Partial<TaskArtifacts>>(r.artifacts, {}) },
    budget: { ...DEFAULT_BUDGET, ...parseJson<Partial<TaskBudget>>(r.budget, {}) },
    lastNotifiedStatus: r.last_notified_status,
    lastError: r.last_error,
    createdTs: r.created_ts,
    updatedTs: r.updated_ts,
  };
}

interface JobRow {
  id: string;
  task_id: string;
  kind: string;
  payload: string | null;
  state: string;
  attempts: number;
  max_attempts: number;
  claimed_by: string | null;
  lease_until: string | null;
  available_at: string;
  dedupe_key: string | null;
  result: string | null;
  error: string | null;
  created_ts: string;
  updated_ts: string;
}

function toJob(r: JobRow): EngJob {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind as JobKind,
    payload: r.payload,
    state: r.state as JobState,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    claimedBy: r.claimed_by,
    leaseUntil: r.lease_until,
    availableAt: r.available_at,
    dedupeKey: r.dedupe_key,
    result: r.result,
    error: r.error,
    createdTs: r.created_ts,
    updatedTs: r.updated_ts,
  };
}

interface EventRow {
  seq: number;
  task_id: string;
  from_stage: string | null;
  from_status: string | null;
  to_stage: string;
  to_status: string;
  actor: string;
  actor_detail: string | null;
  note: string | null;
  gate_approved: number;
  ts: string;
}

function toEvent(r: EventRow): StageEvent {
  return {
    seq: r.seq,
    taskId: r.task_id,
    fromStage: r.from_stage as Stage | null,
    fromStatus: r.from_status as Status | null,
    toStage: r.to_stage as Stage,
    toStatus: r.to_status as Status,
    actor: r.actor as Actor,
    actorDetail: r.actor_detail,
    note: r.note,
    gateApproved: r.gate_approved === 1,
    ts: r.ts,
  };
}

interface RunRow {
  id: string;
  task_id: string;
  stage: string;
  session_id: string | null;
  status: string;
  started_ts: string;
  finished_ts: string | null;
  exit_code: number | null;
  iteration: number;
  usd_cents: number;
  num_turns: number | null;
  result_summary: string | null;
  error: string | null;
  log_path: string | null;
}

function toRun(r: RunRow): AgentRun {
  return {
    id: r.id,
    taskId: r.task_id,
    stage: r.stage as Stage,
    sessionId: r.session_id,
    status: r.status as AgentRunStatus,
    startedTs: r.started_ts,
    finishedTs: r.finished_ts,
    exitCode: r.exit_code,
    iteration: r.iteration,
    usdCents: r.usd_cents,
    numTurns: r.num_turns,
    resultSummary: r.result_summary,
    error: r.error,
    logPath: r.log_path,
  };
}

/**
 * SQLite-backed store for the engineering orchestration layer (single-user, separate `eng.db`).
 * WAL + `busy_timeout` so the api and the worker can both open it. The `eng_events` table is an
 * immutable audit log mirroring `loop_events`; `transition()` is the single chokepoint for state
 * changes and enforces the §8 gate invariant. `eng_jobs` is the worker's lease-based queue.
 */
export class EngStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("busy_timeout = 5000");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS eng_tasks (
        id TEXT PRIMARY KEY,
        jira_key TEXT NOT NULL UNIQUE,
        jira_id TEXT NOT NULL DEFAULT '',
        jira_url TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        components TEXT NOT NULL DEFAULT '[]',
        assignee TEXT NOT NULL DEFAULT '',
        jira_status TEXT NOT NULL DEFAULT '',
        repo TEXT NOT NULL DEFAULT '',
        default_branch TEXT NOT NULL DEFAULT 'main',
        branch TEXT,
        worktree_path TEXT,
        claude_session_id TEXT,
        stage TEXT NOT NULL DEFAULT 'plan',
        status TEXT NOT NULL DEFAULT 'not_started',
        artifacts TEXT NOT NULL DEFAULT '{}',
        budget TEXT NOT NULL DEFAULT '{}',
        last_notified_status TEXT,
        last_error TEXT,
        created_ts TEXT NOT NULL,
        updated_ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_eng_tasks_stage ON eng_tasks(stage, status);
      CREATE INDEX IF NOT EXISTS idx_eng_tasks_assignee ON eng_tasks(assignee);

      CREATE TABLE IF NOT EXISTS eng_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        from_stage TEXT,
        from_status TEXT,
        to_stage TEXT NOT NULL,
        to_status TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_detail TEXT,
        note TEXT,
        gate_approved INTEGER NOT NULL DEFAULT 0,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_eng_events_task ON eng_events(task_id, seq);

      CREATE TABLE IF NOT EXISTS eng_jobs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        claimed_by TEXT,
        lease_until TEXT,
        available_at TEXT NOT NULL,
        dedupe_key TEXT,
        result TEXT,
        error TEXT,
        created_ts TEXT NOT NULL,
        updated_ts TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_eng_jobs_dedupe
        ON eng_jobs(dedupe_key)
        WHERE dedupe_key IS NOT NULL AND state IN ('queued','claimed','running');
      CREATE INDEX IF NOT EXISTS idx_eng_jobs_claimable ON eng_jobs(state, available_at);

      CREATE TABLE IF NOT EXISTS eng_agent_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_ts TEXT NOT NULL,
        finished_ts TEXT,
        exit_code INTEGER,
        iteration INTEGER NOT NULL DEFAULT 0,
        usd_cents INTEGER NOT NULL DEFAULT 0,
        num_turns INTEGER,
        result_summary TEXT,
        error TEXT,
        log_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_eng_runs_task ON eng_agent_runs(task_id, started_ts);
    `);
    // Post-deploy column additions go here (try/catch ALTER), same no-migration convention as LoopsStore.
    for (const ddl of [] as string[]) {
      try {
        this.#db.exec(ddl);
      } catch {
        // column already present
      }
    }
  }

  // --- Tasks ---

  /**
   * Idempotent import (Jira → eng.db). New issues are inserted at `plan:not_started`. Existing rows
   * refresh only Jira-owned metadata; the LoopKeeper stage/status/artifacts/session/budget/branch
   * are NEVER touched (mirrors LoopsStore's "never resurrect a closed loop").
   */
  upsertFromJira(inputs: readonly EngTaskInput[], nowIso: string): { inserted: number; updated: number } {
    const insert = this.#db.prepare(`
      INSERT INTO eng_tasks
        (id, jira_key, jira_id, jira_url, title, description, acceptance_criteria, labels, components,
         assignee, jira_status, repo, default_branch, stage, status, artifacts, budget, created_ts, updated_ts)
      VALUES
        (@id, @jira_key, @jira_id, @jira_url, @title, @description, @acceptance_criteria, @labels, @components,
         @assignee, @jira_status, @repo, @default_branch, 'plan', 'not_started', '{}', @budget, @now, @now)
      ON CONFLICT(jira_key) DO UPDATE SET
        jira_id = excluded.jira_id,
        jira_url = excluded.jira_url,
        title = excluded.title,
        description = excluded.description,
        acceptance_criteria = excluded.acceptance_criteria,
        labels = excluded.labels,
        components = excluded.components,
        assignee = excluded.assignee,
        jira_status = excluded.jira_status,
        updated_ts = @now
    `);
    const budget = JSON.stringify(DEFAULT_BUDGET);
    const tx = this.#db.transaction((rows: readonly EngTaskInput[]) => {
      for (const t of rows) {
        insert.run({
          id: taskId(t.jiraKey),
          jira_key: t.jiraKey,
          jira_id: t.jiraId,
          jira_url: t.jiraUrl,
          title: t.title,
          description: t.description,
          acceptance_criteria: t.acceptanceCriteria,
          labels: JSON.stringify(t.labels),
          components: JSON.stringify(t.components),
          assignee: t.assignee,
          jira_status: t.jiraStatus,
          repo: t.repo,
          default_branch: t.defaultBranch,
          budget,
          now: nowIso,
        });
      }
    });
    const before = this.count();
    tx(inputs);
    const inserted = this.count() - before;
    return { inserted, updated: inputs.length - inserted };
  }

  get(id: string): EngTask | null {
    const row = this.#db.prepare("SELECT * FROM eng_tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  getByKey(jiraKey: string): EngTask | null {
    const row = this.#db.prepare("SELECT * FROM eng_tasks WHERE jira_key = ?").get(jiraKey) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  list(filter: EngTaskFilter = {}): EngTask[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.assignee) {
      where.push("assignee = @assignee");
      params.assignee = filter.assignee;
    }
    if (filter.stage) {
      where.push("stage = @stage");
      params.stage = filter.stage;
    }
    const sql = "SELECT * FROM eng_tasks" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY updated_ts DESC";
    let tasks = (this.#db.prepare(sql).all(params) as TaskRow[]).map(toTask);
    if (filter.needsHuman) {
      tasks = tasks.filter((t) => needsHuman({ stage: t.stage, status: t.status }));
    }
    return tasks;
  }

  count(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM eng_tasks").get() as { n: number }).n;
  }

  #currentStageStatus(id: string): StageStatus | null {
    const row = this.#db.prepare("SELECT stage, status FROM eng_tasks WHERE id = ?").get(id) as
      | { stage: string; status: string }
      | undefined;
    return row ? { stage: row.stage as Stage, status: row.status as Status } : null;
  }

  /**
   * The single chokepoint for state changes. Validates against the pure machine, enforces the §8
   * gate invariant (only `actor:"user"` + `gateApproved` may cross a gate), performs a guarded
   * compare-and-swap (so a lost race is detected), and appends an immutable `eng_events` row.
   * Idempotent: re-applying the current position is a successful no-op (no event).
   */
  transition(args: TransitionArgs): TransitionOutcome {
    const cur = this.#currentStageStatus(args.taskId);
    if (!cur) return { ok: false, changed: false, reason: "task not found" };
    if (cur.stage === args.to.stage && cur.status === args.to.status) return { ok: true, changed: false };

    const verdict = canTransition(cur, args.to, args.actor);
    if (!verdict.ok) return { ok: false, changed: false, reason: verdict.reason };
    if (transitionNeedsGate(cur, args.to) && args.gateApproved !== true) {
      return { ok: false, changed: false, reason: "gate requires an explicit user approval" };
    }

    const apply = this.#db.transaction(() => {
      const res = this.#db
        .prepare("UPDATE eng_tasks SET stage = ?, status = ?, updated_ts = ? WHERE id = ? AND stage = ? AND status = ?")
        .run(args.to.stage, args.to.status, args.ts, args.taskId, cur.stage, cur.status);
      if (res.changes !== 1) return false;
      this.#db
        .prepare(
          `INSERT INTO eng_events (task_id, from_stage, from_status, to_stage, to_status, actor, actor_detail, note, gate_approved, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.taskId,
          cur.stage,
          cur.status,
          args.to.stage,
          args.to.status,
          args.actor,
          args.actorDetail ?? null,
          args.note ?? null,
          transitionNeedsGate(cur, args.to) ? 1 : 0,
          args.ts,
        );
      // Clear a stale error once the task moves forward successfully (not when escalating).
      if (args.to.status !== "blocked" && args.to.status !== "failed" && args.to.status !== "cancelled") {
        this.#db.prepare("UPDATE eng_tasks SET last_error = NULL WHERE id = ?").run(args.taskId);
      }
      return true;
    });
    return apply() ? { ok: true, changed: true } : { ok: false, changed: false, reason: "concurrent update lost the race" };
  }

  /** Has this task ever crossed the merge gate via a recorded user approval? (deploy-retry guard) */
  hasGatedMerge(id: string): boolean {
    const row = this.#db
      .prepare("SELECT 1 FROM eng_events WHERE task_id = ? AND to_stage = 'merge' AND to_status = 'merging' AND gate_approved = 1 LIMIT 1")
      .get(id);
    return row !== undefined;
  }

  events(taskId: string): StageEvent[] {
    return (this.#db.prepare("SELECT * FROM eng_events WHERE task_id = ? ORDER BY seq ASC").all(taskId) as EventRow[]).map(toEvent);
  }

  // --- Mutable task fields the worker learns as it runs ---

  /** Merge-patch the artifacts JSON (other stages' artifacts are preserved). */
  setArtifact(id: string, patch: Partial<TaskArtifacts>, nowIso: string): boolean {
    const task = this.get(id);
    if (!task) return false;
    const next: TaskArtifacts = { ...task.artifacts, ...patch };
    return this.#db.prepare("UPDATE eng_tasks SET artifacts = ?, updated_ts = ? WHERE id = ?").run(JSON.stringify(next), nowIso, id).changes > 0;
  }

  setProgress(id: string, opts: { lastError?: string | null }, nowIso: string): boolean {
    if (opts.lastError === undefined) return false;
    return this.#db.prepare("UPDATE eng_tasks SET last_error = ?, updated_ts = ? WHERE id = ?").run(opts.lastError, nowIso, id).changes > 0;
  }

  setLastNotified(id: string, statusKeyValue: string): boolean {
    return this.#db.prepare("UPDATE eng_tasks SET last_notified_status = ? WHERE id = ?").run(statusKeyValue, id).changes > 0;
  }

  setBranchAndWorktree(id: string, branch: string, worktreePath: string, nowIso: string): boolean {
    return this.#db
      .prepare("UPDATE eng_tasks SET branch = ?, worktree_path = ?, updated_ts = ? WHERE id = ?")
      .run(branch, worktreePath, nowIso, id).changes > 0;
  }

  setClaudeSession(id: string, sessionId: string, nowIso: string): boolean {
    return this.#db.prepare("UPDATE eng_tasks SET claude_session_id = ?, updated_ts = ? WHERE id = ?").run(sessionId, nowIso, id).changes > 0;
  }

  setDeployArtifact(id: string, deploy: DeployArtifact, nowIso: string): boolean {
    return this.setArtifact(id, { deploy }, nowIso);
  }

  // --- Budget (atomic accounting + caps) ---

  /**
   * Record agent usage against the budget. Pre-increment iterations BEFORE a run (so a crash counts
   * the attempt rather than gifting a free retry); reconcile actual cost when the result arrives.
   */
  addBudgetUsage(id: string, delta: { usdCents?: number; iterations?: number; reviewRounds?: number }, nowIso: string): TaskBudget | null {
    const tx = this.#db.transaction(() => {
      const task = this.get(id);
      if (!task) return null;
      const b: TaskBudget = {
        ...task.budget,
        usdCentsUsed: task.budget.usdCentsUsed + (delta.usdCents ?? 0),
        iterationsUsed: task.budget.iterationsUsed + (delta.iterations ?? 0),
        reviewRoundsUsed: task.budget.reviewRoundsUsed + (delta.reviewRounds ?? 0),
      };
      this.#db.prepare("UPDATE eng_tasks SET budget = ?, updated_ts = ? WHERE id = ?").run(JSON.stringify(b), nowIso, id);
      return b;
    });
    return tx();
  }

  /** Raise a task's caps (user "retry with more budget"). Returns the new budget. */
  raiseBudget(id: string, caps: { maxIterations?: number; maxUsdCents?: number; maxReviewRounds?: number }, nowIso: string): TaskBudget | null {
    const tx = this.#db.transaction(() => {
      const task = this.get(id);
      if (!task) return null;
      const b: TaskBudget = {
        ...task.budget,
        maxIterations: caps.maxIterations ?? task.budget.maxIterations,
        maxUsdCents: caps.maxUsdCents ?? task.budget.maxUsdCents,
        maxReviewRounds: caps.maxReviewRounds ?? task.budget.maxReviewRounds,
      };
      this.#db.prepare("UPDATE eng_tasks SET budget = ?, updated_ts = ? WHERE id = ?").run(JSON.stringify(b), nowIso, id);
      return b;
    });
    return tx();
  }

  // --- Job queue ---

  /** Enqueue a job. Returns the id, or null if a live job with the same dedupe key already exists. */
  enqueue(
    job: { taskId: string; kind: JobKind; payload?: unknown; dedupeKey?: string; availableAt?: string; maxAttempts?: number },
    nowIso: string,
  ): string | null {
    const id = `job_${randomUUID()}`;
    try {
      this.#db
        .prepare(
          `INSERT INTO eng_jobs (id, task_id, kind, payload, state, attempts, max_attempts, available_at, dedupe_key, created_ts, updated_ts)
           VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          job.taskId,
          job.kind,
          job.payload === undefined ? null : JSON.stringify(job.payload),
          job.maxAttempts ?? 1,
          job.availableAt ?? nowIso,
          job.dedupeKey ?? null,
          nowIso,
          nowIso,
        );
      return id;
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) return null; // dedupe-blocked
      throw err;
    }
  }

  /** Atomically claim the oldest available queued job (lease-based; safe across processes). */
  claimNext(workerId: string, nowIso: string, leaseUntilIso: string): EngJob | null {
    const row = this.#db
      .prepare(
        `UPDATE eng_jobs
           SET state = 'claimed', claimed_by = ?, lease_until = ?, attempts = attempts + 1, updated_ts = ?
         WHERE id = (
           SELECT id FROM eng_jobs WHERE state = 'queued' AND available_at <= ? ORDER BY created_ts ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get(workerId, leaseUntilIso, nowIso, nowIso) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  markJobRunning(id: string, nowIso: string): boolean {
    return this.#db.prepare("UPDATE eng_jobs SET state = 'running', updated_ts = ? WHERE id = ? AND state = 'claimed'").run(nowIso, id).changes > 0;
  }

  completeJob(id: string, result: unknown, nowIso: string): boolean {
    return this.#db
      .prepare("UPDATE eng_jobs SET state = 'done', result = ?, lease_until = NULL, updated_ts = ? WHERE id = ?")
      .run(result === undefined ? null : JSON.stringify(result), nowIso, id).changes > 0;
  }

  /** Fail a job; if it has attempts left and a requeue time is given, return it to the queue with backoff. */
  failJob(id: string, error: string, nowIso: string, opts: { requeueAt?: string } = {}): boolean {
    const job = this.#db.prepare("SELECT attempts, max_attempts FROM eng_jobs WHERE id = ?").get(id) as
      | { attempts: number; max_attempts: number }
      | undefined;
    if (!job) return false;
    if (opts.requeueAt && job.attempts < job.max_attempts) {
      return this.#db
        .prepare("UPDATE eng_jobs SET state = 'queued', error = ?, available_at = ?, claimed_by = NULL, lease_until = NULL, updated_ts = ? WHERE id = ?")
        .run(error, opts.requeueAt, nowIso, id).changes > 0;
    }
    return this.#db
      .prepare("UPDATE eng_jobs SET state = 'failed', error = ?, lease_until = NULL, updated_ts = ? WHERE id = ?")
      .run(error, nowIso, id).changes > 0;
  }

  /** Crash recovery: claimed/running jobs whose lease expired go back to the queue (or fail if exhausted). */
  reapExpiredLeases(nowIso: string): number {
    const requeued = this.#db
      .prepare(
        `UPDATE eng_jobs SET state = 'queued', claimed_by = NULL, lease_until = NULL, updated_ts = ?
         WHERE state IN ('claimed','running') AND lease_until IS NOT NULL AND lease_until < ? AND attempts < max_attempts`,
      )
      .run(nowIso, nowIso).changes;
    const failed = this.#db
      .prepare(
        `UPDATE eng_jobs SET state = 'failed', error = 'lease expired (attempts exhausted)', lease_until = NULL, updated_ts = ?
         WHERE state IN ('claimed','running') AND lease_until IS NOT NULL AND lease_until < ? AND attempts >= max_attempts`,
      )
      .run(nowIso, nowIso).changes;
    return requeued + failed;
  }

  runningJobForTask(taskId: string): EngJob | null {
    const row = this.#db
      .prepare("SELECT * FROM eng_jobs WHERE task_id = ? AND state IN ('queued','claimed','running') ORDER BY created_ts ASC LIMIT 1")
      .get(taskId) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  cancelJobsForTask(taskId: string, nowIso: string, kinds?: readonly JobKind[]): number {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      return this.#db
        .prepare(`UPDATE eng_jobs SET state = 'cancelled', updated_ts = ? WHERE task_id = ? AND state IN ('queued','claimed','running') AND kind IN (${placeholders})`)
        .run(nowIso, taskId, ...kinds).changes;
    }
    return this.#db
      .prepare("UPDATE eng_jobs SET state = 'cancelled', updated_ts = ? WHERE task_id = ? AND state IN ('queued','claimed','running')")
      .run(nowIso, taskId).changes;
  }

  // --- Agent runs ---

  startAgentRun(run: { taskId: string; stage: Stage; sessionId: string | null; iteration: number; startedTs: string }): string {
    const id = `run_${randomUUID()}`;
    this.#db
      .prepare("INSERT INTO eng_agent_runs (id, task_id, stage, session_id, status, started_ts, iteration) VALUES (?, ?, ?, ?, 'running', ?, ?)")
      .run(id, run.taskId, run.stage, run.sessionId, run.startedTs, run.iteration);
    return id;
  }

  finishAgentRun(
    id: string,
    r: {
      status: AgentRunStatus;
      finishedTs: string;
      exitCode?: number | null;
      usdCents?: number;
      numTurns?: number | null;
      resultSummary?: string | null;
      error?: string | null;
      sessionId?: string | null;
      logPath?: string | null;
    },
  ): boolean {
    return this.#db
      .prepare(
        `UPDATE eng_agent_runs
           SET status = ?, finished_ts = ?, exit_code = ?, usd_cents = ?, num_turns = ?, result_summary = ?, error = ?,
               session_id = COALESCE(?, session_id), log_path = COALESCE(?, log_path)
         WHERE id = ?`,
      )
      .run(
        r.status,
        r.finishedTs,
        r.exitCode ?? null,
        r.usdCents ?? 0,
        r.numTurns ?? null,
        r.resultSummary ?? null,
        r.error ?? null,
        r.sessionId ?? null,
        r.logPath ?? null,
        id,
      ).changes > 0;
  }

  agentRuns(taskId: string): AgentRun[] {
    return (this.#db.prepare("SELECT * FROM eng_agent_runs WHERE task_id = ? ORDER BY started_ts ASC").all(taskId) as RunRow[]).map(toRun);
  }

  /** Startup reconcile: any `running` agent run left by a crash becomes `aborted`. */
  reconcileRunningAgentRuns(nowIso: string): number {
    return this.#db
      .prepare("UPDATE eng_agent_runs SET status = 'aborted', finished_ts = ?, error = 'reconciled after restart' WHERE status = 'running'")
      .run(nowIso).changes;
  }

  /** Test/dev wipe. */
  reset(): void {
    this.#db.exec("DELETE FROM eng_tasks; DELETE FROM eng_events; DELETE FROM eng_jobs; DELETE FROM eng_agent_runs;");
  }

  close(): void {
    this.#db.close();
  }
}
