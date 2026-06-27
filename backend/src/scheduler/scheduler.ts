/**
 * A tiny interval scheduler. Jobs declare an interval; `tick(nowMs)` runs whichever are due
 * and is deterministic (no real timers) so it's unit-testable. `start()` wraps it in a
 * setInterval for production. A job that throws is isolated — it's logged and the others run.
 */
export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
}

interface JobState extends ScheduledJob {
  lastRunMs: number;
}

export class Scheduler {
  readonly #jobs: JobState[] = [];
  readonly #onError: (job: string, err: unknown) => void;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(onError: (job: string, err: unknown) => void = () => {}) {
    this.#onError = onError;
  }

  /** Register a job. intervalMs <= 0 disables it. */
  add(job: ScheduledJob): this {
    if (job.intervalMs > 0) this.#jobs.push({ ...job, lastRunMs: 0 });
    return this;
  }

  get jobNames(): string[] {
    return this.#jobs.map((j) => j.name);
  }

  /** Run every job whose interval has elapsed since its last run. Returns the names run. */
  async tick(nowMs: number): Promise<string[]> {
    const ran: string[] = [];
    for (const job of this.#jobs) {
      if (nowMs - job.lastRunMs < job.intervalMs) continue;
      job.lastRunMs = nowMs;
      ran.push(job.name);
      try {
        await job.run();
      } catch (err) {
        this.#onError(job.name, err);
      }
    }
    return ran;
  }

  /** Begin ticking every `tickMs`. No-op if there are no enabled jobs. */
  start(tickMs = 60_000): boolean {
    if (this.#jobs.length === 0 || this.#timer) return false;
    this.#timer = setInterval(() => {
      void this.tick(Date.now());
    }, tickMs);
    if (typeof this.#timer === "object" && "unref" in this.#timer) this.#timer.unref();
    return true;
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
