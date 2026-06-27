import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Channel,
  Direction,
  DueConfidence,
  Firmness,
  LoopKind,
  LoopStatus,
  OpenLoop,
  Recurrence,
  Resolution,
  SnoozeCondition,
  UserLabel,
} from "../domain/open-loop.ts";
import type { SourceConfig } from "../domain/source-config.ts";
import { DEFAULT_SOURCE_CONFIG } from "../domain/source-config.ts";
import { loopId } from "../dedupe.ts";

/** Advance a YYYY-MM-DD date by one recurrence interval (UTC). Monthly clamps to the last valid
 *  day so e.g. Jan 31 → Feb 28, not a month-skipping rollover. */
function advanceDate(base: string, rule: Recurrence): string {
  const d = new Date(`${base}T00:00:00Z`);
  if (rule === "daily") {
    d.setUTCDate(d.getUTCDate() + 1);
  } else if (rule === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
  } else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, daysInMonth));
  }
  return d.toISOString().slice(0, 10);
}

/** Filters for {@link LoopsStore.list}. */
export interface LoopFilter {
  status?: readonly LoopStatus[];
  tenant?: string;
  channel?: Channel;
  /** Exclude loops snoozed past this instant (ISO). */
  notSnoozedAfter?: string;
  /** Case-insensitive substring match over summary / counterpart / source label. */
  q?: string;
}

interface Row {
  id: string;
  direction: string;
  kind: string;
  summary: string;
  counterpart: string;
  channel: string;
  source_ref: string;
  permalink: string;
  source_label: string | null;
  thread_ts: string | null;
  commitment_hash: string;
  quote_excerpt: string | null;
  due_date: string | null;
  due_confidence: string;
  firmness: string;
  status: string;
  snoozed_until: string | null;
  tenant: string;
  created_ts: string;
  resolved_ts: string | null;
  resolution: string | null;
  user_label: string | null;
  recurrence: string | null;
  snooze_condition: string | null;
  project: string | null;
  tags: string | null;
}

function toLoop(r: Row): OpenLoop {
  const loop: OpenLoop = {
    id: r.id,
    direction: r.direction as Direction,
    kind: r.kind as LoopKind,
    summary: r.summary,
    counterpart: r.counterpart,
    channel: r.channel as Channel,
    sourceRef: r.source_ref,
    permalink: r.permalink,
    commitmentHash: r.commitment_hash,
    ...(r.source_label !== null ? { sourceLabel: r.source_label } : {}),
    ...(r.thread_ts !== null ? { threadTs: r.thread_ts } : {}),
    dueDate: r.due_date,
    dueConfidence: r.due_confidence as DueConfidence,
    firmness: r.firmness as Firmness,
    status: r.status as LoopStatus,
    tenant: r.tenant,
    createdTs: r.created_ts,
  };
  if (r.quote_excerpt !== null) loop.quoteExcerpt = r.quote_excerpt;
  if (r.snoozed_until !== null) loop.snoozedUntil = r.snoozed_until;
  if (r.resolved_ts !== null) loop.resolvedTs = r.resolved_ts;
  if (r.resolution !== null) loop.resolution = r.resolution as Resolution;
  if (r.user_label !== null) loop.userLabel = r.user_label as UserLabel;
  if (r.recurrence !== null) loop.recurrence = r.recurrence as Recurrence;
  if (r.snooze_condition !== null) loop.snoozeCondition = r.snooze_condition as SnoozeCondition;
  if (r.project !== null) loop.project = r.project;
  if (r.tags !== null) {
    try {
      const parsed = JSON.parse(r.tags) as unknown;
      if (Array.isArray(parsed)) loop.tags = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      // ignore malformed tag json
    }
  }
  return loop;
}

/**
 * SQLite-backed store for open loops (single-user). WAL mode; dedupe enforced by a UNIQUE
 * constraint on (channel, source_ref, direction, commitment_hash). A re-scan upserts the
 * mutable fields but never resurrects a closed/dismissed loop's status.
 */
export class LoopsStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma("journal_mode = WAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS open_loops (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        counterpart TEXT NOT NULL,
        channel TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        permalink TEXT NOT NULL,
        commitment_hash TEXT NOT NULL,
        source_label TEXT,
        thread_ts TEXT,
        quote_excerpt TEXT,
        due_date TEXT,
        due_confidence TEXT NOT NULL,
        firmness TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        snoozed_until TEXT,
        tenant TEXT NOT NULL,
        created_ts TEXT NOT NULL,
        resolved_ts TEXT,
        resolution TEXT,
        user_label TEXT,
        recurrence TEXT,
        snooze_condition TEXT,
        project TEXT,
        tags TEXT,
        UNIQUE(channel, source_ref, direction, commitment_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_loops_status ON open_loops(status);
      CREATE INDEX IF NOT EXISTS idx_loops_due ON open_loops(due_date);
      CREATE INDEX IF NOT EXISTS idx_loops_tenant ON open_loops(tenant);
      CREATE TABLE IF NOT EXISTS devices (
        token TEXT PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'ios',
        created_ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen_messages (
        source_ref TEXT PRIMARY KEY,
        seen_ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS suppressed_hashes (
        commitment_hash TEXT PRIMARY KEY,
        ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loop_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        loop_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        ts TEXT NOT NULL,
        spawned_loop_id TEXT
      );
    `);
    // Add columns introduced after the first deploy (safe no-op if they already exist).
    for (const ddl of [
      "ALTER TABLE open_loops ADD COLUMN source_label TEXT",
      "ALTER TABLE open_loops ADD COLUMN thread_ts TEXT",
      "ALTER TABLE open_loops ADD COLUMN recurrence TEXT",
      "ALTER TABLE open_loops ADD COLUMN snooze_condition TEXT",
      "ALTER TABLE open_loops ADD COLUMN project TEXT",
      "ALTER TABLE open_loops ADD COLUMN tags TEXT",
      "ALTER TABLE loop_events ADD COLUMN spawned_loop_id TEXT",
    ]) {
      try {
        this.#db.exec(ddl);
      } catch {
        // column already present
      }
    }
  }

  // --- Generic key/value metadata (scan watermark, etc.) on the app_config table ---

  getMeta(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.#db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
  }

  // --- Processed-message tracking: each source message is extracted at most once, ever,
  //     so re-syncs never re-extract (no duplicates) and cost stays bounded. ---

  /** Of the given source refs, return those NOT yet processed. */
  filterUnseen(refs: readonly string[]): string[] {
    if (refs.length === 0) return [];
    const placeholders = refs.map(() => "?").join(",");
    const seen = new Set(
      (this.#db.prepare(`SELECT source_ref FROM seen_messages WHERE source_ref IN (${placeholders})`).all(...refs) as Array<{ source_ref: string }>).map(
        (r) => r.source_ref,
      ),
    );
    return refs.filter((r) => !seen.has(r));
  }

  // --- False-positive suppression: a commitment hash the user marked "not a loop" is never
  //     re-created by future scans (survives reset, so the rebuild stays clean). ---

  suppressHash(commitmentHash: string, ts: string): void {
    this.#db
      .prepare("INSERT INTO suppressed_hashes (commitment_hash, ts) VALUES (?, ?) ON CONFLICT(commitment_hash) DO NOTHING")
      .run(commitmentHash, ts);
  }

  suppressedHashes(): Set<string> {
    return new Set(
      (this.#db.prepare("SELECT commitment_hash FROM suppressed_hashes").all() as Array<{ commitment_hash: string }>).map((r) => r.commitment_hash),
    );
  }

  markSeen(refs: readonly string[], ts: string): void {
    const insert = this.#db.prepare("INSERT INTO seen_messages (source_ref, seen_ts) VALUES (?, ?) ON CONFLICT(source_ref) DO NOTHING");
    const tx = this.#db.transaction((rows: readonly string[]) => {
      for (const r of rows) insert.run(r, ts);
    });
    tx(refs);
  }

  // --- Ingestion config (which Slack channels / Gmail query to scan) ---

  getSourceConfig(): SourceConfig {
    const row = this.#db.prepare("SELECT value FROM app_config WHERE key = 'source_config'").get() as
      | { value: string }
      | undefined;
    if (!row) return { ...DEFAULT_SOURCE_CONFIG };
    try {
      const parsed = JSON.parse(row.value) as Partial<SourceConfig>;
      return {
        slackScope: parsed.slackScope === "selected" || parsed.slackScope === "all_member" ? parsed.slackScope : DEFAULT_SOURCE_CONFIG.slackScope,
        slackChannelIds: Array.isArray(parsed.slackChannelIds) ? parsed.slackChannelIds : DEFAULT_SOURCE_CONFIG.slackChannelIds,
        gmailQuery: typeof parsed.gmailQuery === "string" && parsed.gmailQuery ? parsed.gmailQuery : DEFAULT_SOURCE_CONFIG.gmailQuery,
      };
    } catch {
      return { ...DEFAULT_SOURCE_CONFIG };
    }
  }

  setSourceConfig(partial: Partial<SourceConfig>): SourceConfig {
    const next: SourceConfig = { ...this.getSourceConfig(), ...partial };
    this.#db
      .prepare("INSERT INTO app_config (key, value) VALUES ('source_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  // --- APNs device registry (single user, possibly multiple devices) ---

  registerDevice(token: string, createdTs: string, platform = "ios"): void {
    this.#db
      .prepare("INSERT INTO devices (token, platform, created_ts) VALUES (?, ?, ?) ON CONFLICT(token) DO NOTHING")
      .run(token, platform, createdTs);
  }

  listDeviceTokens(): string[] {
    return (this.#db.prepare("SELECT token FROM devices").all() as Array<{ token: string }>).map((r) => r.token);
  }

  removeDevice(token: string): boolean {
    return this.#db.prepare("DELETE FROM devices WHERE token = ?").run(token).changes > 0;
  }

  /** Idempotent insert. On conflict, refresh mutable fields but preserve lifecycle state. */
  upsertMany(loops: readonly OpenLoop[]): { inserted: number; updated: number } {
    const insert = this.#db.prepare(`
      INSERT INTO open_loops
        (id, direction, kind, summary, counterpart, channel, source_ref, permalink, source_label, thread_ts,
         commitment_hash, quote_excerpt, due_date, due_confidence, firmness, status,
         snoozed_until, tenant, created_ts, resolved_ts, resolution, user_label,
         recurrence, snooze_condition, project, tags)
      VALUES
        (@id, @direction, @kind, @summary, @counterpart, @channel, @source_ref, @permalink, @source_label, @thread_ts,
         @commitment_hash, @quote_excerpt, @due_date, @due_confidence, @firmness, @status,
         @snoozed_until, @tenant, @created_ts, @resolved_ts, @resolution, @user_label,
         @recurrence, @snooze_condition, @project, @tags)
      ON CONFLICT(channel, source_ref, direction, commitment_hash) DO UPDATE SET
        summary = excluded.summary,
        permalink = excluded.permalink,
        source_label = excluded.source_label,
        thread_ts = excluded.thread_ts,
        due_date = excluded.due_date,
        due_confidence = excluded.due_confidence,
        firmness = excluded.firmness
    `);
    const tx = this.#db.transaction((rows: readonly OpenLoop[]) => {
      for (const l of rows) {
        insert.run({
          id: l.id,
          direction: l.direction,
          kind: l.kind,
          summary: l.summary,
          counterpart: l.counterpart,
          channel: l.channel,
          source_ref: l.sourceRef,
          permalink: l.permalink,
          source_label: l.sourceLabel ?? null,
          thread_ts: l.threadTs ?? null,
          commitment_hash: l.commitmentHash,
          quote_excerpt: l.quoteExcerpt ?? null,
          due_date: l.dueDate,
          due_confidence: l.dueConfidence,
          firmness: l.firmness,
          status: l.status,
          snoozed_until: l.snoozedUntil ?? null,
          tenant: l.tenant,
          created_ts: l.createdTs,
          resolved_ts: l.resolvedTs ?? null,
          resolution: l.resolution ?? null,
          user_label: l.userLabel ?? null,
          recurrence: l.recurrence ?? null,
          snooze_condition: l.snoozeCondition ?? null,
          project: l.project ?? null,
          tags: l.tags && l.tags.length > 0 ? JSON.stringify(l.tags) : null,
        });
      }
    });
    const before = this.count();
    tx(loops);
    const inserted = this.count() - before;
    return { inserted, updated: loops.length - inserted };
  }

  get(id: string): OpenLoop | null {
    const row = this.#db.prepare("SELECT * FROM open_loops WHERE id = ?").get(id) as Row | undefined;
    return row ? toLoop(row) : null;
  }

  list(filter: LoopFilter = {}): OpenLoop[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.status && filter.status.length > 0) {
      where.push(`status IN (${filter.status.map((_, i) => `@s${i}`).join(", ")})`);
      filter.status.forEach((s, i) => (params[`s${i}`] = s));
    }
    if (filter.tenant) {
      where.push("tenant = @tenant");
      params.tenant = filter.tenant;
    }
    if (filter.channel) {
      where.push("channel = @channel");
      params.channel = filter.channel;
    }
    if (filter.notSnoozedAfter) {
      where.push("(snoozed_until IS NULL OR snoozed_until <= @snz)");
      params.snz = filter.notSnoozedAfter;
    }
    if (filter.q && filter.q.trim()) {
      where.push("(summary LIKE @q OR counterpart LIKE @q OR source_label LIKE @q OR project LIKE @q OR tags LIKE @q)");
      params.q = `%${filter.q.trim()}%`;
    }
    const sql =
      "SELECT * FROM open_loops" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY (due_date IS NULL), due_date ASC, created_ts ASC";
    return (this.#db.prepare(sql).all(params) as Row[]).map(toLoop);
  }

  /**
   * Transition a loop's lifecycle. Idempotent: re-applying the same status is a no-op (no event,
   * no side effects). `audit` (default true) controls whether the change is recorded for undo —
   * automated transitions (nudge/closure) pass `audit:false` so they never sit on the undo stack.
   */
  setStatus(id: string, status: LoopStatus, opts: { resolution?: Resolution; resolvedTs?: string; audit?: boolean; spawnedLoopId?: string } = {}): boolean {
    const prior = (this.#db.prepare("SELECT status FROM open_loops WHERE id = ?").get(id) as { status: string } | undefined)?.status ?? null;
    if (prior === null) return false; // loop doesn't exist
    if (prior === status) return true; // already there — no event, no side effects
    this.#db
      .prepare("UPDATE open_loops SET status = @status, resolution = @resolution, resolved_ts = @resolved_ts WHERE id = @id")
      .run({ id, status, resolution: opts.resolution ?? null, resolved_ts: opts.resolvedTs ?? null });
    if (opts.audit !== false) {
      this.#db
        .prepare("INSERT INTO loop_events (loop_id, from_status, to_status, ts, spawned_loop_id) VALUES (?, ?, ?, ?, ?)")
        .run(id, prior, status, opts.resolvedTs ?? "", opts.spawnedLoopId ?? null);
    }
    return true;
  }

  /** Revert the most recent user status change; also removes a freshly-spawned recurrence if pristine. */
  undoLastStatusChange(): string | null {
    const ev = this.#db.prepare("SELECT seq, loop_id, from_status, spawned_loop_id FROM loop_events ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; loop_id: string; from_status: string | null; spawned_loop_id: string | null }
      | undefined;
    if (!ev || ev.from_status === null) return null;
    const reactivating = ev.from_status === "open" || ev.from_status === "nudged" || ev.from_status === "closed_candidate";
    this.#db
      .prepare("UPDATE open_loops SET status = ?, resolution = CASE WHEN ? THEN NULL ELSE resolution END, resolved_ts = CASE WHEN ? THEN NULL ELSE resolved_ts END WHERE id = ?")
      .run(ev.from_status, reactivating ? 1 : 0, reactivating ? 1 : 0, ev.loop_id);
    // Undo of a recurring "done" should also remove the occurrence it spawned, if untouched.
    if (ev.spawned_loop_id) {
      const child = this.get(ev.spawned_loop_id);
      const childEvents = (this.#db.prepare("SELECT COUNT(*) AS n FROM loop_events WHERE loop_id = ? AND seq <> ?").get(ev.spawned_loop_id, ev.seq) as { n: number }).n;
      if (child && child.status === "open" && childEvents === 0) {
        this.#db.prepare("DELETE FROM open_loops WHERE id = ?").run(ev.spawned_loop_id);
      }
    }
    this.#db.prepare("DELETE FROM loop_events WHERE seq = ?").run(ev.seq);
    return ev.loop_id;
  }

  /** Hide a loop from briefs until `untilIso`; optionally until a condition (e.g. a reply) is met. */
  snooze(id: string, untilIso: string, condition: SnoozeCondition | null = null): boolean {
    return this.#db.prepare("UPDATE open_loops SET snoozed_until = ?, snooze_condition = ? WHERE id = ?").run(untilIso, condition, id).changes > 0;
  }

  /** Loops currently snoozed until a reply arrives (the scanner clears these when one does). */
  snoozedUntilReply(): OpenLoop[] {
    return (this.#db.prepare("SELECT * FROM open_loops WHERE snooze_condition = 'reply'").all() as Row[]).map(toLoop);
  }

  clearSnooze(id: string): boolean {
    return this.#db.prepare("UPDATE open_loops SET snoozed_until = NULL, snooze_condition = NULL WHERE id = ?").run(id).changes > 0;
  }

  /** Set or clear a loop's recurrence rule. */
  setRecurrence(id: string, rule: Recurrence | null): boolean {
    return this.#db.prepare("UPDATE open_loops SET recurrence = ? WHERE id = ?").run(rule, id).changes > 0;
  }

  /** Set a loop's project and/or tags (only the provided fields change). */
  organize(id: string, opts: { project?: string | null; tags?: readonly string[] | null }): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (opts.project !== undefined) {
      sets.push("project = @project");
      params.project = opts.project && opts.project.trim() ? opts.project.trim() : null;
    }
    if (opts.tags !== undefined) {
      sets.push("tags = @tags");
      params.tags = opts.tags && opts.tags.length > 0 ? JSON.stringify(opts.tags) : null;
    }
    if (sets.length === 0) return false;
    return this.#db.prepare(`UPDATE open_loops SET ${sets.join(", ")} WHERE id = @id`).run(params).changes > 0;
  }

  /** When a recurring loop closes, create its next occurrence (a fresh open loop with the next due date). */
  spawnNext(loop: OpenLoop, nowIso: string): OpenLoop | null {
    if (!loop.recurrence) return null;
    const today = nowIso.slice(0, 10);
    const base = loop.dueDate && loop.dueDate > today ? loop.dueDate : today;
    const next = advanceDate(base, loop.recurrence);
    const sourceRef = `${loop.sourceRef}@${next}`;
    const clone: OpenLoop = {
      ...loop,
      id: loopId({ channel: loop.channel, sourceRef, direction: loop.direction, commitmentHash: loop.commitmentHash }),
      sourceRef,
      dueDate: next,
      dueConfidence: "explicit",
      status: "open",
      createdTs: nowIso,
    };
    delete clone.resolvedTs;
    delete clone.resolution;
    delete clone.snoozedUntil;
    delete clone.snoozeCondition;
    delete clone.userLabel;
    this.upsertMany([clone]);
    return clone;
  }

  /** Hand a loop off: flip an owe-loop to owed (now waiting on `to`) and reopen it. */
  delegate(id: string, to: string): boolean {
    return (
      this.#db
        .prepare("UPDATE open_loops SET direction = 'owed', counterpart = ?, status = 'open', snoozed_until = NULL, resolved_ts = NULL, resolution = NULL WHERE id = ?")
        .run(to, id).changes > 0
    );
  }

  label(id: string, label: UserLabel): boolean {
    return this.#db.prepare("UPDATE open_loops SET user_label = ? WHERE id = ?").run(label, id).changes > 0;
  }

  /** Purge closed/dismissed loops resolved before the cutoff (retention TTL). */
  purgeClosedOlderThan(cutoffIso: string): number {
    return this.#db
      .prepare("DELETE FROM open_loops WHERE status IN ('closed', 'dismissed') AND (resolved_ts IS NULL OR resolved_ts < ?)")
      .run(cutoffIso).changes;
  }

  /** Per-counterpart deletion (data-subject erasure path). */
  purgeByCounterpart(counterpart: string): number {
    return this.#db.prepare("DELETE FROM open_loops WHERE counterpart = ?").run(counterpart).changes;
  }

  count(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM open_loops").get() as { n: number }).n;
  }

  /** Wipe all loops + processed-message tracking + scan watermark, so the next scan rebuilds from scratch. */
  reset(): number {
    const n = this.count();
    this.#db.exec("DELETE FROM open_loops; DELETE FROM seen_messages; DELETE FROM loop_events; DELETE FROM app_config WHERE key = 'last_scan_start';");
    return n;
  }

  close(): void {
    this.#db.close();
  }
}
