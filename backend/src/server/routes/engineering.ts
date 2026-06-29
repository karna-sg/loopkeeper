import { watch } from "node:fs";
import { open } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.ts";
import type { EngTask, Status } from "../../domain/eng-task.ts";
import { applyTransition } from "../../engineering/orchestrator.ts";
import { isTerminal, shouldRetryAfterBuildFailure } from "../../engineering/state-machine.ts";
import { RestGithubClient } from "../../engineering/adapters/rest-github.ts";
import { buildEngStats } from "../../eng-stats.ts";
import { buildPlanComment } from "../../engineering/writeback.ts";

/** Live = a stage is executing; the status endpoint reports running vs stalled vs idle. */
const ACTIVE_STATUSES: ReadonlySet<Status> = new Set<Status>(["in_progress", "creating", "merging", "deploying"]);

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "aborted", "budget_exceeded"]);

/**
 * Parse one redacted JSONL line from an agent log into a human-readable activity string.
 * Returns null for lines that should be skipped (system, user, malformed JSON, empty).
 * Exported for unit testing.
 */
export function formatActivityLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (evt.type === "assistant") {
    const msg = evt.message as { content?: unknown } | undefined;
    if (!msg || !Array.isArray(msg.content)) return null;
    const parts: string[] = [];
    for (const c of msg.content as Array<Record<string, unknown>>) {
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
        parts.push(`text: ${c.text.trim().replace(/\s+/g, " ").slice(0, 200)}`);
      } else if (c.type === "tool_use" && typeof c.name === "string") {
        const input = (c.input ?? {}) as Record<string, unknown>;
        const firstKey = Object.keys(input)[0];
        const detail = firstKey !== undefined ? ` ${String(input[firstKey]).slice(0, 80)}` : "";
        parts.push(`tool: ${c.name}${detail}`);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }

  if (evt.type === "result") {
    if (evt.is_error === true) {
      const msg = typeof evt.result === "string" ? evt.result.slice(0, 120) : "error";
      return `result: error ${msg}`;
    }
    const turns = typeof evt.num_turns === "number" ? ` ${evt.num_turns} turns` : "";
    const cost = typeof evt.total_cost_usd === "number" ? ` $${evt.total_cost_usd.toFixed(2)}` : "";
    return `result: ok${turns}${cost}`;
  }

  return null;
}

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

  // --- Stats ---

  app.get("/eng/stats", async () => buildEngStats(engStore.list(), deps.now()));

  // --- Reads ---

  app.get("/tasks", async () => {
    const jiraSync = deps.jiraSync;
    if (jiraSync) {
      try {
        const tasks = await jiraSync.listTasks();
        return { tasks, live: true };
      } catch {
        // Jira temporarily unavailable — fall back to the last-synced DB snapshot.
      }
    }
    const filter = config.selfAccountId ? { assignee: config.selfAccountId } : {};
    return { tasks: engStore.list(filter), live: false };
  });

  app.get("/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dbRow = engStore.get(id);
    if (!dbRow) return reply.code(404).send({ error: "not found" });
    // Always reflect current Jira: re-fetch THIS issue live and overlay its metadata onto the pipeline row.
    // getTask falls back to the DB row if Jira is unavailable, so the detail view never 5xx's on a Jira blip.
    const jiraSync = deps.jiraSync;
    const task = jiraSync ? await jiraSync.getTask(dbRow) : dbRow;
    return { task, events: engStore.events(id) };
  });

  app.get("/tasks/:id/diff", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const github = deps.buildGithub();
    if (!config.github || !github) return reply.code(503).send({ error: "GitHub not configured" });
    const pr = task.artifacts.pr;
    const branch = task.branch ?? task.artifacts.dev?.branch ?? null;
    if (!pr?.number && !branch) return { files: [], truncated: false };
    try {
      const args = pr?.number ? { prNumber: pr.number } : { base: config.github.baseBranch, head: branch! };
      const files = await github.getDiff(task.repo, args);
      const truncated = files.length > 50;
      return { files: files.slice(0, 50), truncated };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "GitHub diff unavailable" });
    }
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

  // --- Live activity feed (LP-11) ---

  app.get("/tasks/:id/activity", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });

    const runs = engStore.agentRuns(id);
    const run = runs.at(-1) ?? null;
    if (!run || !run.logPath) return { lines: [], nextOffset: 0, done: true };

    const { offset: rawOffset } = req.query as { offset?: string };
    const startOffset = Math.max(0, parseInt(rawOffset ?? "0", 10) || 0);
    const runDone = TERMINAL_RUN_STATUSES.has(run.status);

    const BUF_SIZE = 65536;
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(run.logPath, "r");
      const { size: fileSize } = await fh.stat();
      const offset = Math.min(startOffset, fileSize);

      if (offset >= fileSize) return { lines: [], nextOffset: fileSize, done: runDone };

      const bytesToRead = Math.min(BUF_SIZE, fileSize - offset);
      const buf = Buffer.alloc(bytesToRead);
      const { bytesRead } = await fh.read(buf, 0, bytesToRead, offset);
      const chunk = buf.subarray(0, bytesRead).toString("utf8");

      // Only emit complete lines to avoid a mid-write partial at the tail.
      const lastNewline = chunk.lastIndexOf("\n");
      if (lastNewline === -1) return { lines: [], nextOffset: offset, done: false };

      const complete = chunk.slice(0, lastNewline);
      // Use byte length (not char length) for the cursor so multibyte chars don't desync.
      const nextOffset = offset + Buffer.byteLength(complete, "utf8") + 1; // +1 for the \n

      const lines: string[] = [];
      for (const raw of complete.split("\n")) {
        const formatted = formatActivityLine(raw);
        if (formatted !== null) lines.push(...formatted.split("\n")); // multi-block assistant
      }

      return { lines, nextOffset, done: runDone && nextOffset >= fileSize };
    } catch (err) {
      // Log file not yet created (runner hasn't started writing) — normal race at run start.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], nextOffset: 0, done: runDone };
      throw err;
    } finally {
      await fh?.close();
    }
  });

  // --- Live SSE stream (LP-71) ---

  app.get("/tasks/:id/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!engStore.get(id)) return reply.code(404).send({ error: "not found" });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const runs = engStore.agentRuns(id);
    const run = runs.at(-1) ?? null;
    let offset = 0;
    let flushing = false;
    let pending = false;

    const sendData = (line: string): void => { res.write(`data: ${line}\n\n`); };
    const sendEvent = (type: string, data: string): void => { res.write(`event: ${type}\ndata: ${data}\n\n`); };

    const flushNewLines = async (): Promise<void> => {
      if (res.writableEnded || flushing) { if (!res.writableEnded) pending = true; return; }
      flushing = true;
      try {
        if (!run?.logPath) return;
        const fh = await open(run.logPath, "r");
        try {
          const { size } = await fh.stat();
          if (offset >= size) return;
          const bytesToRead = Math.min(65536, size - offset);
          const buf = Buffer.alloc(bytesToRead);
          const { bytesRead } = await fh.read(buf, 0, bytesToRead, offset);
          const chunk = buf.subarray(0, bytesRead).toString("utf8");
          const lastNl = chunk.lastIndexOf("\n");
          if (lastNl === -1) return;
          const complete = chunk.slice(0, lastNl);
          offset += Buffer.byteLength(complete, "utf8") + 1;
          for (const raw of complete.split("\n")) {
            const formatted = formatActivityLine(raw);
            if (formatted !== null) {
              for (const line of formatted.split("\n")) sendData(line);
            }
          }
        } finally {
          await fh.close();
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      } finally {
        flushing = false;
        if (pending) { pending = false; void flushNewLines(); }
      }
    };

    // Replay the current tail on connect.
    await flushNewLines();

    // Watch the log file for appended lines.
    let watcher: ReturnType<typeof watch> | null = null;
    if (run?.logPath) {
      watcher = watch(run.logPath, { persistent: false }, () => { void flushNewLines(); });
    }

    // Declare cleanup first (with no-op default) so onTransition can safely reference it.
    let cleaned = false;
    let cleanup: () => void = () => {};

    // Heartbeat comment every 15s to keep proxies from closing the connection.
    const heartbeat = setInterval(() => { res.write(": heartbeat\n\n"); }, 15_000);

    // Forward transition events as SSE "status" events; close stream when terminal.
    const onTransition = (evt: { taskId: string; stage: string; status: string }): void => {
      if (evt.taskId !== id) return;
      sendEvent("status", JSON.stringify({ stage: evt.stage, status: evt.status }));
      const terminal =
        evt.status === "cancelled" ||
        (evt.stage === "verify" && evt.status === "verified") ||
        (evt.stage === "rollback" && evt.status === "rolled_back");
      if (terminal) cleanup();
    };
    engStore.transitionEmitter.on("transition", onTransition);

    cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      watcher?.close();
      engStore.transitionEmitter.off("transition", onTransition);
      if (!res.writableEnded) res.end();
      // Destroy the socket so the TCP connection closes fully and app.close() doesn't wait on
      // a keep-alive socket that would otherwise linger after the HTTP response is done.
      res.socket?.destroy();
    };
    // req.raw fires 'close' on client disconnect; res fires it when the response stream is done.
    req.raw.on("close", cleanup);
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

  // --- Per-task model override (LP-27) ---

  const ALLOWED_MODELS = new Set(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);

  app.patch("/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    const body = (req.body ?? {}) as { claudeModel?: string | null };
    if ("claudeModel" in body) {
      const m = body.claudeModel;
      if (m !== null && m !== undefined && !ALLOWED_MODELS.has(m)) {
        return reply.code(400).send({ error: `unknown model; allowed: ${[...ALLOWED_MODELS].join(", ")}` });
      }
      engStore.setModel(id, m ?? null, deps.now());
    }
    return { ok: true };
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

  // --- Gate 4: post-deploy verify sign-off ---

  app.post("/tasks/:id/verify/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "verify" && task.status === "awaiting_review")) {
      return reply.code(409).send({ error: "task is not awaiting verification" });
    }
    const now = deps.now();
    if (task.artifacts.verify) engStore.setArtifact(id, { verify: { ...task.artifacts.verify, verifiedBy: config.selfAccountId, verifiedTs: now } }, now);
    const r = applyTransition(engStore, { taskId: id, to: { stage: "verify", status: "verified" }, actor: "user", gateApproved: true, ...detail(), ts: now }, now);
    if (!r.ok) return reply.code(409).send({ error: r.reason ?? "cannot confirm verification" });
    return { ok: true };
  });

  // Re-run the post-deploy smoke after a verify failure (the verify job advances failed → in_progress).
  app.post("/tasks/:id/verify/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "verify" && task.status === "failed")) {
      return reply.code(409).send({ error: "no failed verification to retry" });
    }
    const now = deps.now();
    const enqueued = engStore.enqueue({ taskId: id, kind: "verify", dedupeKey: `${id}:verify` }, now);
    if (!enqueued) return reply.code(409).send({ error: "verification already running" });
    return { started: true };
  });

  // --- Gate 5: rollback (revert the merge + redeploy the previous good state) ---

  app.post("/tasks/:id/rollback", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    const canRollback = (task.stage === "verify" && (task.status === "awaiting_review" || task.status === "failed")) || (task.stage === "deploy" && task.status === "failed");
    if (!canRollback) return reply.code(409).send({ error: "task is not in a rollback-able state" });
    if (!task.artifacts.merge?.commitSha) return reply.code(409).send({ error: "no merge commit to roll back" });
    if (!config.github) return reply.code(503).send({ error: "GitHub not configured" });
    const now = deps.now();
    engStore.setArtifact(
      id,
      { rollback: { targetSha: task.artifacts.merge.commitSha, revertSha: null, prUrl: null, status: "ready", startedTs: now, finishedTs: null, triggeredBy: config.selfAccountId, logTail: null } },
      now,
    );
    // Arm → execute (the store enforces user + gateApproved on the execution gate), then enqueue.
    const armed = engStore.transition({ taskId: id, to: { stage: "rollback", status: "ready" }, actor: "user", ...detail(), ts: now });
    if (!armed.ok) return reply.code(409).send({ error: armed.reason ?? "cannot start rollback" });
    const exec = engStore.transition({ taskId: id, to: { stage: "rollback", status: "in_progress" }, actor: "user", gateApproved: true, ...detail(), ts: now });
    if (!exec.ok) return reply.code(409).send({ error: exec.reason ?? "cannot roll back" });
    engStore.enqueue({ taskId: id, kind: "rollback", dedupeKey: `${id}:rollback` }, now);
    return { started: true };
  });

  // --- Fix-forward: a post-deploy CI/build failure is a CODE problem — send it back to the agent
  //     (re-enters the dev→test→pr→merge→deploy loop seeded with the CI error), not a blind CI re-run. ---

  app.post("/tasks/:id/fix-build", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const err = assigneeError(task);
    if (err) return reply.code(403).send({ error: err });
    if (!(task.stage === "deploy" && task.status === "failed" && task.artifacts.deploy?.failureKind === "ci_build")) {
      return reply.code(409).send({ error: "no CI/build failure to fix" });
    }
    const now = deps.now();
    const body = (req.body ?? {}) as { maxIterations?: number; maxUsdCents?: number };
    engStore.raiseBudget(id, body, now); // let the user top up before re-entering the agent loop
    const fresh = engStore.get(id);
    if (fresh && !shouldRetryAfterBuildFailure(fresh.budget)) {
      return reply.code(409).send({ error: "budget exhausted — raise maxIterations/maxUsdCents to fix the build" });
    }
    // Back to dev (ungated); the PR + merge gates are re-crossed on the way out (human-in-the-loop kept).
    const r = applyTransition(engStore, { taskId: id, to: { stage: "dev", status: "in_progress" }, actor: "user", ...detail(), ts: now }, now);
    if (!r.ok) return reply.code(409).send({ error: r.reason ?? "cannot start build fix" });
    engStore.enqueue({ taskId: id, kind: "dev_test", payload: { seedFix: true }, dedupeKey: `${id}:dev_test` }, now);
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
      // A build failure can't be fixed by re-running CI — point the user at fix-forward.
      if (task.artifacts.deploy?.failureKind === "ci_build") {
        return reply.code(409).send({ error: "this is a build failure — use POST /tasks/:id/fix-build (a CI re-run won't fix it)" });
      }
      // Transient CD/infra failure: actually RE-RUN the workflow's failed jobs (re-observing the same
      // run alone would just see the old failure), then re-observe.
      const runUrl = task.artifacts.deploy?.runUrl ?? "";
      const runIdMatch = runUrl.match(/\/runs\/(\d+)/);
      if (task.artifacts.deploy?.failureKind === "cd_infra" && config.github && config.githubToken && runIdMatch) {
        try {
          await new RestGithubClient(config.githubToken).rerunDeploy(config.github.repo, Number(runIdMatch[1]));
        } catch {
          // best-effort: re-observe anyway
        }
      }
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

  // --- Labels CRUD ---

  app.get("/labels", async () => {
    return { labels: engStore.listLabels() };
  });

  app.post("/labels", async (req, reply) => {
    const { name, color } = (req.body ?? {}) as { name?: string; color?: string };
    if (!name || !color) return reply.code(400).send({ error: "name and color required" });
    try {
      const label = engStore.createLabel(name, color);
      return { label };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return reply.code(409).send({ error: "a label with that name already exists" });
      }
      throw err;
    }
  });

  app.patch("/labels/:labelId", async (req, reply) => {
    const { labelId } = req.params as { labelId: string };
    const patch = (req.body ?? {}) as { name?: string; color?: string };
    try {
      const label = engStore.updateLabel(labelId, patch);
      if (!label) return reply.code(404).send({ error: "label not found" });
      return { label };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return reply.code(409).send({ error: "a label with that name already exists" });
      }
      throw err;
    }
  });

  app.delete("/labels/:labelId", async (req) => {
    const { labelId } = req.params as { labelId: string };
    engStore.deleteLabel(labelId);
    return { ok: true };
  });

  // --- Label attach / detach on tasks ---

  app.post("/tasks/:id/labels", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const { labelId } = (req.body ?? {}) as { labelId?: string };
    if (!labelId) return reply.code(400).send({ error: "labelId required" });
    const labels = engStore.listLabels();
    if (!labels.find((l) => l.id === labelId)) return reply.code(404).send({ error: "label not found" });
    engStore.attachLabel(labelId, task.jiraId);
    return { ok: true };
  });

  app.delete("/tasks/:id/labels/:labelId", async (req, reply) => {
    const { id, labelId } = req.params as { id: string; labelId: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    engStore.detachLabel(labelId, task.jiraId);
    return { ok: true };
  });

  // --- Label queue order ---

  app.get("/labels/:labelId/order", async (req) => {
    const { labelId } = req.params as { labelId: string };
    const jiraIds = engStore.labelTaskOrder(labelId);
    return { jiraIds };
  });

  app.put("/labels/:labelId/order", async (req, reply) => {
    const { labelId } = req.params as { labelId: string };
    const { jiraIds } = (req.body ?? {}) as { jiraIds?: string[] };
    if (!Array.isArray(jiraIds)) return reply.code(400).send({ error: "jiraIds array required" });
    engStore.reorderLabel(labelId, jiraIds);
    return { ok: true };
  });

  // --- Jira write-back (LP-66): opt-in, DRAFT-first advisory comment ---

  app.post("/tasks/:id/jira/writeback/draft", async (req, reply) => {
    if (!config.eng.jiraWriteback) return reply.code(403).send({ error: "ENG_JIRA_WRITEBACK is not enabled" });
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const now = deps.now();
    const draftBody = buildPlanComment(task);
    const existing = task.artifacts.jiraWriteback;
    engStore.setArtifact(
      id,
      { jiraWriteback: { draftBody, draftTs: now, postedTs: existing?.postedTs ?? null, postedBy: existing?.postedBy ?? null } },
      now,
    );
    return { draftBody };
  });

  app.post("/tasks/:id/jira/writeback/confirm", async (req, reply) => {
    if (!config.eng.jiraWriteback) return reply.code(403).send({ error: "ENG_JIRA_WRITEBACK is not enabled" });
    const { id } = req.params as { id: string };
    const task = engStore.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const authErr = assigneeError(task);
    if (authErr) return reply.code(403).send({ error: authErr });
    const wb = task.artifacts.jiraWriteback;
    if (!wb?.draftBody) return reply.code(409).send({ error: "no draft exists — call /jira/writeback/draft first" });
    if (wb.postedTs !== null) return reply.code(409).send({ error: "already posted to Jira" });
    const jiraSync = deps.jiraSync;
    if (!jiraSync) return reply.code(503).send({ error: "Jira not connected" });
    const now = deps.now();
    try {
      await jiraSync.addComment(task.jiraKey, wb.draftBody);
    } catch (postErr) {
      return reply.code(502).send({ error: postErr instanceof Error ? postErr.message : "Jira comment failed" });
    }
    engStore.setArtifact(id, { jiraWriteback: { ...wb, postedTs: now, postedBy: config.selfAccountId } }, now);
    return { postedTs: now };
  });
}
