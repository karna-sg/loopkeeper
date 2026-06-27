import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.ts";
import type { EngTask, Status } from "../../domain/eng-task.ts";
import { applyTransition } from "../../engineering/orchestrator.ts";
import { isTerminal } from "../../engineering/state-machine.ts";

/** Live = a stage is executing; the status endpoint reports running vs stalled vs idle. */
const ACTIVE_STATUSES: ReadonlySet<Status> = new Set<Status>(["in_progress", "creating", "merging", "deploying"]);

function runStateFor(task: EngTask, hasLiveJob: boolean): "running" | "stalled" | "idle" {
  if (!ACTIVE_STATUSES.has(task.status)) return "idle";
  return hasLiveJob ? "running" : "stalled";
}

/**
 * The engineering surface: My Jira Tasks + the 7-stage lifecycle. Read endpoints + the three human
 * gates (plan, PR creation, merge) + Prepare-Plan / address-comments / retry. Mirrors the existing
 * route conventions; gated actions are assignee-only (fails closed when no self identity is set).
 * Every gate crossing goes through `applyTransition` (CAS in the store + effect enqueue).
 */
export function registerEngineering(app: FastifyInstance, deps: AppDeps): void {
  const { engStore, config } = deps;

  /** Assignee-only gate auth that fails CLOSED when no self identity is configured. */
  function assigneeError(task: EngTask): string | null {
    if (!config.selfAccountId) return "engineering gates require LOOPKEEPER_JIRA_ACCOUNT_ID to be configured";
    if (task.assignee && task.assignee !== config.selfAccountId) return "only the assignee can act on this task";
    return null;
  }

  function detail(): { actorDetail?: string } {
    return config.selfAccountId ? { actorDetail: config.selfAccountId } : {};
  }

  // --- Reads ---

  app.get("/tasks", async () => {
    const filter = config.selfAccountId ? { assignee: config.selfAccountId } : {};
    return { tasks: engStore.list(filter) };
  });

  app.get("/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    return { task, events: engStore.events(id) };
  });

  app.get("/tasks/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const hasLiveJob = engStore.runningJobForTask(id) !== null;
    return {
      id: task.id,
      stage: task.stage,
      status: task.status,
      runState: runStateFor(task, hasLiveJob),
      iteration: task.budget.iterationsUsed,
      usdCents: task.budget.usdCentsUsed,
      lastError: task.lastError,
    };
  });

  // --- Jira sync (FR-2) ---

  app.post("/tasks/sync", async (_req, reply) => {
    let sync;
    try {
      sync = deps.buildJiraSync();
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : "Jira sync unavailable" });
    }
    try {
      const result = await sync.run({ nowIso: deps.now() });
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Jira sync failed" });
    }
  });

  // --- Prepare Plan (FR-9/10) ---

  app.post("/tasks/:id/prepare-plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "plan" && task.status === "not_started")) {
      return reply.code(409).send({ error: "task is not awaiting a plan" });
    }
    const now = deps.now();
    const r = applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ...detail(), ts: now }, now);
    if (!r.ok) return reply.code(409).send({ error: r.reason ?? "cannot start planning" });
    return { started: true };
  });

  // --- Gate 1: plan approval / revision (FR-13/15) ---

  app.post("/tasks/:id/plan/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "plan" && task.status === "completed_unapproved")) {
      return reply.code(409).send({ error: "task is not awaiting plan approval" });
    }
    const now = deps.now();
    const body = (req.body ?? {}) as { editedText?: string };
    if (task.artifacts.plan) {
      engStore.setArtifact(
        id,
        { plan: { ...task.artifacts.plan, editedText: body.editedText ?? task.artifacts.plan.editedText, approvedTs: now, approvedBy: config.selfAccountId } },
        now,
      );
    }
    const r = applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "approved" }, actor: "user", gateApproved: true, ...detail(), ts: now }, now);
    if (!r.ok) return reply.code(409).send({ error: r.reason ?? "cannot approve plan" });
    return { ok: true };
  });

  app.post("/tasks/:id/plan/revise", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "plan" && task.status === "completed_unapproved")) {
      return reply.code(409).send({ error: "task has no plan to revise" });
    }
    const now = deps.now();
    const body = (req.body ?? {}) as { note?: string };
    if (task.artifacts.plan) {
      engStore.setArtifact(id, { plan: { ...task.artifacts.plan, editedText: body.note ?? null, revision: task.artifacts.plan.revision + 1 } }, now);
    }
    // Back to in_progress → re-enqueues the plan job (effect of plan:in_progress).
    const r = applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", note: "revise", ...detail(), ts: now }, now);
    if (!r.ok) return reply.code(409).send({ error: r.reason ?? "cannot revise plan" });
    return { started: true };
  });

  // --- Gate 2: PR creation (FR-18/19) ---

  app.post("/tasks/:id/pr/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "pr" && task.status === "proposed")) {
      return reply.code(409).send({ error: "task has no proposed PR to open" });
    }
    if (!config.github) return reply.code(503).send({ error: "GitHub not configured" });
    const now = deps.now();
    if (task.artifacts.pr) engStore.setArtifact(id, { pr: { ...task.artifacts.pr, approvedBy: config.selfAccountId } }, now);
    const r = applyTransition(engStore, { taskId: id, to: { stage: "pr", status: "creating" }, actor: "user", gateApproved: true, ...detail(), ts: now }, now);
    if (!r.ok) return reply.code(409).send({ error: r.reason ?? "cannot open PR" });
    return { started: true };
  });

  // --- Review loop: address comments (FR-21) ---

  app.post("/tasks/:id/review/address-comments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "review" && task.status === "comments_received")) {
      return reply.code(409).send({ error: "no review comments to address" });
    }
    const now = deps.now();
    const enqueued = engStore.enqueue({ taskId: id, kind: "address_comments", dedupeKey: `${id}:address_comments` }, now);
    if (!enqueued) return reply.code(409).send({ error: "already addressing comments" });
    return { started: true };
  });

  // --- Review: solo self-approve (a single-account operator can't approve their own GitHub PR;
  //     the human review here IS the user reviewing the PR in the app). Advances to merge:ready. ---
  app.post("/tasks/:id/review/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "review" && (task.status === "awaiting_review" || task.status === "comments_addressed"))) {
      return reply.code(409).send({ error: "task is not awaiting review" });
    }
    const now = deps.now();
    const approved = applyTransition(engStore, { taskId: id, to: { stage: "review", status: "approved" }, actor: "user", ...detail(), ts: now }, now);
    if (!approved.ok) return reply.code(409).send({ error: approved.reason ?? "cannot approve review" });
    applyTransition(engStore, { taskId: id, to: { stage: "merge", status: "ready" }, actor: "user", ...detail(), ts: now }, now);
    return { ok: true };
  });

  // --- Gate 3: merge (FR-23) ---

  app.post("/tasks/:id/merge/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "merge" && task.status === "ready")) {
      return reply.code(409).send({ error: "task is not ready to merge" });
    }
    if (!config.github) return reply.code(503).send({ error: "GitHub not configured" });
    const now = deps.now();
    const body = (req.body ?? {}) as { method?: "merge" | "squash" | "rebase" };
    const method = body.method ?? "squash";
    if (task.artifacts.pr) engStore.setArtifact(id, { merge: { commitSha: null, mergedTs: null, mergedBy: config.selfAccountId, method } }, now);
    // CAS the gate (store enforces user + gateApproved), THEN enqueue the merge job with the method.
    const r = engStore.transition({ taskId: id, to: { stage: "merge", status: "merging" }, actor: "user", gateApproved: true, ...detail(), ts: now });
    if (!r.ok) return reply.code(409).send({ error: r.reason ?? "cannot merge" });
    engStore.enqueue({ taskId: id, kind: "merge", payload: { method }, dedupeKey: `${id}:merge` }, now);
    return { started: true };
  });

  // --- Retry: raise budget + resume, or re-run a failed deploy (decision #6) ---

  app.post("/tasks/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    const now = deps.now();
    const body = (req.body ?? {}) as { maxIterations?: number; maxUsdCents?: number; maxReviewRounds?: number };

    if (task.status === "blocked") {
      engStore.raiseBudget(id, body, now);
      if (task.stage === "plan") {
        const r = applyTransition(engStore, { taskId: id, to: { stage: "plan", status: "in_progress" }, actor: "user", ...detail(), ts: now }, now);
        if (!r.ok) return reply.code(409).send({ error: r.reason ?? "cannot retry" });
      } else {
        const r = engStore.transition({ taskId: id, to: { stage: "dev", status: "in_progress" }, actor: "user", ...detail(), ts: now });
        if (!r.ok) return reply.code(409).send({ error: r.reason ?? "cannot retry" });
        engStore.enqueue({ taskId: id, kind: "dev_test", dedupeKey: `${id}:dev_test` }, now);
      }
      return { started: true };
    }

    if (task.stage === "deploy" && task.status === "failed") {
      // Prod-mutating: only allowed if this task actually crossed the merge gate (audit invariant).
      if (!engStore.hasGatedMerge(id)) return reply.code(403).send({ error: "deploy retry requires a recorded merge approval" });
      const enqueued = engStore.enqueue({ taskId: id, kind: "deploy", dedupeKey: `${id}:deploy` }, now);
      if (!enqueued) return reply.code(409).send({ error: "deploy already in progress" });
      return { started: true };
    }

    return reply.code(409).send({ error: "task is not in a retryable state" });
  });

  // --- Cancel: stop a running task, move it to blocked (recoverable via retry) ---

  app.post("/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (isTerminal({ stage: task.stage, status: task.status })) {
      return reply.code(409).send({ error: "task is already terminal" });
    }
    const now = deps.now();
    // Signal the worker cancel-watcher to kill the live process group.
    engStore.setCancelPending(id, now);
    // Drain the job queue so nothing new starts while the signal propagates.
    engStore.cancelJobsForTask(id, now);
    // Move to blocked (same stage) so the retry UI can recover it.
    // Actor is "system" because the state machine reserves "blocked" for non-user actors.
    const r = engStore.transition({
      taskId: id,
      to: { stage: task.stage, status: "blocked" },
      actor: "system",
      note: "user cancel",
      actorDetail: config.selfAccountId ?? undefined,
      ts: now,
    });
    if (!r.ok && r.reason !== "concurrent update lost the race") {
      return reply.code(409).send({ error: r.reason ?? "cannot cancel" });
    }
    engStore.setProgress(id, { lastError: "Cancelled by user." }, now);
    return { ok: true };
  });
}
