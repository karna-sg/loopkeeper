import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.ts";
import type { LoopStatus, UserLabel } from "../../domain/open-loop.ts";
import { LOOP_STATUSES, RECURRENCES, USER_LABELS } from "../../domain/open-loop.ts";
import { buildBrief } from "../../brief.ts";
import { buildStats } from "../../stats.ts";
import { todayInTz } from "../../clock.ts";

const ACTIVE: readonly LoopStatus[] = ["open", "nudged", "closed_candidate"];

function parseStatuses(raw: unknown): LoopStatus[] {
  if (typeof raw !== "string") return [...ACTIVE];
  const parts = raw.split(",").map((s) => s.trim());
  const valid = parts.filter((p): p is LoopStatus => (LOOP_STATUSES as readonly string[]).includes(p));
  return valid.length ? valid : [...ACTIVE];
}

export function registerLoops(app: FastifyInstance, deps: AppDeps): void {
  // List loops (default: active, not snoozed). Optional ?q= substring search; ?status=closed for history.
  app.get("/loops", async (req) => {
    const query = req.query as { status?: string; q?: string };
    const statuses = parseStatuses(query.status);
    const terminalOnly = statuses.every((s) => s === "closed" || s === "dismissed");
    return deps.store.list({
      status: statuses,
      ...(terminalOnly ? {} : { notSnoozedAfter: deps.now() }), // archive view isn't snooze-filtered
      ...(query.q ? { q: query.q } : {}),
    });
  });

  // The daily brief — owe loops bucketed by urgency + what you're awaiting.
  app.get("/brief", async () => {
    const loops = deps.store.list({ status: [...ACTIVE], notSnoozedAfter: deps.now() });
    return buildBrief(loops, todayInTz(deps.now(), deps.identity.timezone));
  });

  // Reliability / throughput / ROI metrics over every loop (including closed/dismissed).
  app.get("/stats", async () => buildStats(deps.store.list({ status: [...LOOP_STATUSES] }), deps.now()));

  // Mark done (the precision signal + closure). A recurring loop spawns its next occurrence — but
  // only on a real active→closed transition, so a retried/double /done can't duplicate it.
  app.post("/loops/:id/done", async (req, reply) => {
    const { id } = req.params as { id: string };
    const loop = deps.store.get(id);
    if (!loop) return reply.code(404).send({ error: "not found" });
    const wasActive = loop.status !== "closed" && loop.status !== "dismissed";
    const child = wasActive && loop.recurrence ? deps.store.spawnNext(loop, deps.now()) : null;
    deps.store.setStatus(id, "closed", { resolution: "manual", resolvedTs: deps.now(), ...(child ? { spawnedLoopId: child.id } : {}) });
    return { ok: true };
  });

  app.post("/loops/:id/dismiss", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = deps.store.setStatus(id, "dismissed", { resolution: "manual", resolvedTs: deps.now() });
    return ok ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  app.post("/loops/:id/snooze", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { until?: string; condition?: string };
    // Condition-based snooze (e.g. "reply"): hidden until the scanner sees the condition met.
    if (body.condition === "reply") {
      const ok = deps.store.snooze(id, "9999-12-31T00:00:00.000Z", "reply");
      return ok ? { ok: true } : reply.code(404).send({ error: "not found" });
    }
    if (!body.until) return reply.code(400).send({ error: "until (ISO) or condition required" });
    const ok = deps.store.snooze(id, body.until);
    return ok ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  // Set or clear a recurrence rule (daily/weekly/monthly; anything else clears it).
  app.post("/loops/:id/recur", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { rule?: string };
    const rule = body.rule && (RECURRENCES as readonly string[]).includes(body.rule) ? (body.rule as (typeof RECURRENCES)[number]) : null;
    const ok = deps.store.setRecurrence(id, rule);
    return ok ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  // Organize: set the loop's project and/or tags.
  app.post("/loops/:id/organize", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.store.get(id)) return reply.code(404).send({ error: "not found" });
    const body = (req.body ?? {}) as { project?: string | null; tags?: string[] };
    const opts: { project?: string | null; tags?: string[] } = {};
    if (body.project !== undefined) opts.project = body.project;
    if (Array.isArray(body.tags)) opts.tags = body.tags.filter((t): t is string => typeof t === "string");
    deps.store.organize(id, opts);
    return { ok: true };
  });

  // Phase-0/precision labelling.
  app.post("/loops/:id/label", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { label?: string };
    if (!body.label || !(USER_LABELS as readonly string[]).includes(body.label)) {
      return reply.code(400).send({ error: "label must be 'true' or 'false'" });
    }
    const ok = deps.store.label(id, body.label as UserLabel);
    return ok ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  // Compose a suggested follow-up (chaser) for review — NEVER sent by the backend.
  app.get("/loops/:id/draft", async (req, reply) => {
    const { id } = req.params as { id: string };
    const loop = deps.store.get(id);
    if (!loop) return reply.code(404).send({ error: "not found" });
    let client;
    try {
      client = deps.buildDraftClient();
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : "draft unavailable" });
    }
    return { id, draft: await client.draftChaser(loop) };
  });

  // "Not a loop" — a false positive. Records the precision signal (userLabel=false), dismisses it,
  // and suppresses its commitment hash so future scans never re-create it (survives a reset).
  app.post("/loops/:id/not-a-loop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const loop = deps.store.get(id);
    if (!loop) return reply.code(404).send({ error: "not found" });
    deps.store.label(id, "false");
    deps.store.setStatus(id, "dismissed", { resolution: "manual", resolvedTs: deps.now() });
    deps.store.suppressHash(loop.commitmentHash, deps.now());
    return { ok: true };
  });

  // Delegation: hand a loop off to someone else — flips owe -> owed (now waiting on them).
  app.post("/loops/:id/delegate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { to?: string };
    if (!body.to || !body.to.trim()) return reply.code(400).send({ error: "to (counterpart) required" });
    const ok = deps.store.delegate(id, body.to.trim());
    return ok ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  // Confirm a closure candidate (human-in-the-loop): closed_candidate -> closed.
  app.post("/loops/:id/confirm-close", async (req, reply) => {
    const { id } = req.params as { id: string };
    const loop = deps.store.get(id);
    if (!loop) return reply.code(404).send({ error: "not found" });
    deps.store.setStatus(id, "closed", { resolution: "replied", resolvedTs: deps.now() });
    return { ok: true };
  });

  // Undo the most recent lifecycle change (done / dismiss / not-a-loop / confirm-close).
  app.post("/undo", async () => {
    const loopId = deps.store.undoLastStatusChange();
    return loopId ? { ok: true, loopId } : { ok: false };
  });

  // Full data export (all loops, every status) for backup / portability.
  app.get("/export", async () => ({ exportedAt: deps.now(), loops: deps.store.list({ status: [...LOOP_STATUSES] }) }));

  // Wipe all loops + seen-message tracking (then a fresh scan rebuilds cleanly).
  app.post("/reset", async () => ({ ok: true, cleared: deps.store.reset() }));

  // Data-subject erasure: purge everything about a counterpart.
  app.delete("/loops", async (req) => {
    const q = req.query as { counterpart?: string };
    if (q.counterpart) return { purged: deps.store.purgeByCounterpart(q.counterpart) };
    return { purged: 0, hint: "pass ?counterpart=<name> to erase" };
  });
}
