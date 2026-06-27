import type { EngStore } from "../store/eng-store.ts";
import type { Orchestrator } from "./orchestrator.ts";

/**
 * The worker's main loop: claim a queued job, run it via the orchestrator, escalate on failure.
 * `tick()` is deterministic (claims + runs at most one job) so it's unit-testable; `start()` wraps
 * it in a poller. Crash recovery: `recover()` requeues leased jobs and aborts orphaned agent runs.
 * Designed to run in a SEPARATE worker process/container (single writer to eng.db at concurrency 1).
 */
export interface WorkerDeps {
  engStore: EngStore;
  orchestrator: Orchestrator;
  workerId: string;
  now: () => string;
  /** How long a claim lease lasts before the reaper requeues it. */
  leaseMs: number;
  /**
   * Shared map populated by the orchestrator when an agent process starts. The cancel-watcher
   * polls `isTaskCancelPending` and calls the registered kill fn to stop the process group.
   */
  cancelRegistry?: Map<string, () => void>;
}

export class WorkerRunner {
  readonly #d: WorkerDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  constructor(deps: WorkerDeps) {
    this.#d = deps;
  }

  /** Startup reconcile after a crash/restart: requeue expired leases + abort orphaned runs. */
  recover(): void {
    const now = this.#d.now();
    this.#d.engStore.reapExpiredLeases(now);
    this.#d.engStore.reconcileRunningAgentRuns(now);
  }

  /** Claim and run at most one job. Returns true if a job ran (success or escalation). */
  async tick(): Promise<boolean> {
    const { engStore, orchestrator, workerId, now, leaseMs, cancelRegistry } = this.#d;
    engStore.reapExpiredLeases(now());
    const leaseUntil = new Date(Date.parse(now()) + leaseMs).toISOString();
    const job = engStore.claimNext(workerId, now(), leaseUntil);
    if (!job) return false;
    engStore.markJobRunning(job.id, now());

    // Poll the cancel_pending flag every 1.5 s while the job runs; kill the process group when set.
    // Only needed when a cancelRegistry is wired — without one there are no kill callbacks to invoke.
    let cancelWatcher: ReturnType<typeof setInterval> | null = null;
    if (cancelRegistry) {
      cancelWatcher = setInterval(() => {
        if (engStore.isTaskCancelPending(job.taskId)) {
          cancelRegistry.get(job.taskId)?.();
          if (cancelWatcher) { clearInterval(cancelWatcher); cancelWatcher = null; }
        }
      }, 1_500);
    }

    try {
      await orchestrator.runJob(job);
      engStore.completeJob(job.id, null, now());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      engStore.failJob(job.id, msg, now());
      // Skip escalation if the task was already moved to blocked by the cancel route.
      if (!engStore.isTaskCancelPending(job.taskId)) {
        orchestrator.escalate(job.taskId, msg);
      }
    } finally {
      if (cancelWatcher) { clearInterval(cancelWatcher); cancelWatcher = null; }
    }
    return true;
  }

  /** Poll the queue, draining all ready jobs each interval. No-op if already started. */
  start(pollMs: number, opts: { keepAlive?: boolean } = {}): boolean {
    if (this.#timer) return false;
    this.recover();
    this.#timer = setInterval(() => {
      if (this.#busy) return;
      this.#busy = true;
      void this.#drain().finally(() => {
        this.#busy = false;
      });
    }, pollMs);
    // In a standalone worker process we WANT the interval to keep the process alive; embedded/test
    // callers unref so they don't hang.
    if (!opts.keepAlive && typeof this.#timer === "object" && "unref" in this.#timer) this.#timer.unref();
    return true;
  }

  async #drain(): Promise<void> {
    // Run jobs until the queue is momentarily empty (concurrency 1: sequential).
    for (let guard = 0; guard < 100; guard += 1) {
      if (!(await this.tick())) break;
    }
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
