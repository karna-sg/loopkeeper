import type { LoopsStore } from "../store/loops-store.ts";
import type { NudgePayload, PushSender } from "../push/push-sender.ts";
import type { OpenLoop } from "../domain/open-loop.ts";
import { todayInTz } from "../clock.ts";

export interface NudgeResult {
  candidates: number;
  devices: number;
  sent: number;
  nudged: number;
}

export interface NudgeOptions {
  nowIso: string;
  timezone: string;
  /** Nudge loops due within this many days (and anything overdue). Default 1. */
  windowDays?: number;
}

function addDaysToDate(dateStr: string, days: number): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Selects owe-loops at risk (overdue or due within the window), pushes one self-addressed
 * notification per device, and marks each loop `nudged` so it isn't nudged again. Skips loops
 * that are owed-to-you, snoozed, dateless, already nudged, or beyond the window.
 */
export class NudgeService {
  readonly #store: LoopsStore;
  readonly #push: PushSender;

  constructor(store: LoopsStore, push: PushSender) {
    this.#store = store;
    this.#push = push;
  }

  selectCandidates(nowIso: string, timezone: string, windowDays: number): OpenLoop[] {
    const today = todayInTz(nowIso, timezone);
    const horizon = addDaysToDate(today, windowDays);
    // status: ["open"] excludes already-nudged loops, so we never double-nudge.
    return this.#store
      .list({ status: ["open"], notSnoozedAfter: nowIso })
      .filter((l) => l.direction === "owe" && l.dueDate !== null && l.dueDate <= horizon);
  }

  #payload(loop: OpenLoop, today: string): NudgePayload {
    const when = loop.dueDate !== null && loop.dueDate < today ? "Overdue" : loop.dueDate === today ? "Due today" : "Due soon";
    const payload: NudgePayload = {
      title: `${when} · ${loop.counterpart}`,
      body: loop.summary, // our restatement — never a counterpart quote
      loopId: loop.id,
      threadRef: loop.sourceRef,
    };
    return payload;
  }

  async run(opts: NudgeOptions): Promise<NudgeResult> {
    const today = todayInTz(opts.nowIso, opts.timezone);
    const candidates = this.selectCandidates(opts.nowIso, opts.timezone, opts.windowDays ?? 1);
    const tokens = this.#store.listDeviceTokens();
    let sent = 0;
    let nudged = 0;
    for (const loop of candidates) {
      const payload = this.#payload(loop, today);
      for (const token of tokens) {
        await this.#push.send(token, payload);
        sent += 1;
      }
      this.#store.setStatus(loop.id, "nudged", { audit: false });
      nudged += 1;
    }
    return { candidates: candidates.length, devices: tokens.length, sent, nudged };
  }
}
