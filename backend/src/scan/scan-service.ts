import type { NormalizedMessage, UserIdentity } from "../domain/message.ts";
import { messageSeenKey } from "../domain/message.ts";
import type { MessageSource } from "../sources/source.ts";
import type { ExtractionClient } from "../extractor.ts";
import { extractLoops } from "../extractor.ts";
import { DEFAULT_MAX_CANDIDATES, gate } from "../gate.ts";
import type { LoopsStore } from "../store/loops-store.ts";
import { detectClosures } from "../nudge/closure.ts";
import { daysBefore } from "../clock.ts";

/** True when `message` is a reply from the loop's counterpart in the same thread / DM / email thread. */
function counterpartReplied(
  message: NormalizedMessage,
  loop: { channel: string; sourceRef: string; threadTs?: string; sourceLabel?: string; counterpart: string },
): boolean {
  if (message.fromMe) return false;
  const counterpart = loop.counterpart.trim().toLowerCase();
  const author = message.author.trim().toLowerCase();
  // Require a resolved, matching identity — never match on the "unknown" fallback.
  if (!counterpart || counterpart === "unknown" || !author || author === "unknown" || author !== counterpart) return false;
  const loopChannel = loop.sourceRef.split(":")[0];
  const msgChannel = message.sourceRef.split(":")[0];
  // Gmail sourceRef is `threadId:messageId` — same thread = same prefix.
  if (loop.channel === "gmail") return loopChannel === msgChannel;
  const inThread = loop.threadTs !== undefined && message.threadTs === loop.threadTs;
  const inDm = (loop.sourceLabel === "DM" || loop.sourceLabel === "Group DM") && loopChannel === msgChannel;
  return inThread || inDm;
}

/** Key for the single global "catch up since here" watermark (channel-agnostic). */
const LAST_SCAN_START = "last_scan_start";
/** Free-plan Slack history is limited to ~90 days; never ask for older. */
const MAX_LOOKBACK_DAYS = 90;

export interface ScanResult {
  fetched: number;
  gated: number;
  /** New (not-yet-processed) candidates sent to the model this run. */
  fresh: number;
  /** Already-processed candidates skipped (no re-extraction → no duplicates). */
  skipped: number;
  extracted: number;
  inserted: number;
  updated: number;
  closedCandidates: number;
  /** Coverage warnings surfaced from sources (e.g. Slack search unavailable, channel truncation). */
  warnings: string[];
}

export interface ScanOptions {
  sinceIso: string;
  nowIso: string;
  /** Per-source ingestion ceiling (runaway guard). NOT the LLM candidate cap — see maxCandidates. */
  limitPerSource?: number;
  /** Max scored channel candidates sent to the model (DMs + mentions/broadcasts bypass this). */
  maxCandidates?: number;
  includeQuoteExcerpt?: boolean;
  /** Per-source tenant allowlist. When set, only messages from these tenants are scanned. */
  allowedTenants?: ReadonlySet<string>;
}

/**
 * The end-to-end scan: pull recent messages from every source, drop anything off the tenant
 * allowlist, run the deterministic gate, extract loops with the LLM client, and upsert into
 * the store. Read-only and side-effect-free except for the store write — never sends anything.
 */
export class ScanService {
  readonly #sources: readonly MessageSource[];
  readonly #client: ExtractionClient;
  readonly #store: LoopsStore;
  readonly #identity: UserIdentity;

  constructor(sources: readonly MessageSource[], client: ExtractionClient, store: LoopsStore, identity: UserIdentity) {
    this.#sources = sources;
    this.#client = client;
    this.#store = store;
    this.#identity = identity;
  }

  /**
   * The window start to actually fetch from: the requested `sinceIso`, extended further back to
   * the last successful scan if we fell behind (downtime), and clamped to the free-plan 90-day
   * history limit. ISO instants compare chronologically as strings (all UTC `…Z`).
   */
  #effectiveSince(sinceIso: string, nowIso: string): string {
    const floor = daysBefore(nowIso, MAX_LOOKBACK_DAYS);
    const lastStart = this.#store.getMeta(LAST_SCAN_START);
    let since = sinceIso;
    if (lastStart && lastStart < since) since = lastStart;
    if (since < floor) since = floor;
    return since;
  }

  async run(opts: ScanOptions): Promise<ScanResult> {
    const limit = opts.limitPerSource ?? 500;
    const since = this.#effectiveSince(opts.sinceIso, opts.nowIso);
    const messages: NormalizedMessage[] = [];
    const warnings: string[] = [];
    for (const source of this.#sources) {
      const batch = await source.fetchRecent({ sinceIso: since, limit });
      for (const m of batch) {
        if (!opts.allowedTenants || opts.allowedTenants.has(m.tenant)) messages.push(m);
      }
      if (source.drainWarnings) warnings.push(...source.drainWarnings());
    }

    // Resolve "snooze until they reply": a new message from the counterpart in the loop's thread
    // (or its DM) clears the snooze, resurfacing the loop.
    for (const loop of this.#store.snoozedUntilReply()) {
      if (messages.some((m) => counterpartReplied(m, loop))) this.#store.clearSnooze(loop.id);
    }
    const candidates = gate(messages, { maxCandidates: opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES });

    // Only extract messages we haven't processed before — re-syncs add nothing for unchanged
    // data (no duplicates), and the LLM is never called twice on the same message. The seen key
    // folds in a message's edit version, so an edit (e.g. adding a deadline) re-extracts.
    const keyOf = (c: { message: NormalizedMessage }): string => messageSeenKey(c.message);
    const freshKeys = new Set(this.#store.filterUnseen(candidates.map(keyOf)));
    const fresh = candidates.filter((c) => freshKeys.has(keyOf(c)));

    const extractedLoops = await extractLoops(fresh, this.#client, {
      nowIso: opts.nowIso,
      identity: this.#identity,
      ...(opts.includeQuoteExcerpt === undefined ? {} : { includeQuoteExcerpt: opts.includeQuoteExcerpt }),
    });
    // Never re-create a loop the user marked "not a loop".
    const suppressed = this.#store.suppressedHashes();
    const loops = suppressed.size === 0 ? extractedLoops : extractedLoops.filter((l) => !suppressed.has(l.commitmentHash));
    const { inserted, updated } = this.#store.upsertMany(loops);
    // Mark every fresh candidate processed (even those that yielded no loop) so it isn't re-tried.
    this.#store.markSeen([...freshKeys], opts.nowIso);
    // Advance the catch-up watermark ONLY after a successful run, so the next scan re-covers any
    // window we skipped during downtime and no message can age out unscanned.
    this.#store.setMeta(LAST_SCAN_START, opts.nowIso);

    // Conservative same-channel closure: a later "done/sent" from the user in the same thread
    // flags the loop as a candidate (never auto-closed).
    const openOwe = this.#store.list({ status: ["open"] });
    const closeIds = detectClosures(messages, openOwe);
    for (const id of closeIds) this.#store.setStatus(id, "closed_candidate", { audit: false });

    return {
      fetched: messages.length,
      gated: candidates.length,
      fresh: fresh.length,
      skipped: candidates.length - fresh.length,
      extracted: loops.length,
      inserted,
      updated,
      closedCandidates: closeIds.length,
      warnings,
    };
  }
}
