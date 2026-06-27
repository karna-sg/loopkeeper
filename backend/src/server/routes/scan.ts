import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.ts";
import type { ScanResult } from "../../scan/scan-service.ts";
import { daysBefore } from "../../clock.ts";

/**
 * A scan can take a while (many Slack channels + per-message LLM calls), so `POST /scan` starts
 * it in the BACKGROUND and returns immediately — otherwise the iOS client times out (~60s) while
 * curl, with no timeout, succeeds. The app polls `GET /scan/status` until it finishes.
 */
export function registerScan(app: FastifyInstance, deps: AppDeps): void {
  let running = false;
  let last: ScanResult | null = null;
  let lastError: string | null = null;
  let lastFinishedAt: string | null = null;

  app.post("/scan", async (req, reply) => {
    if (running) return { started: false, running: true };
    const q = req.query as { days?: string };
    const days = Number(q.days ?? "1");
    let scan;
    try {
      scan = deps.buildScanService();
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : "scan unavailable" });
    }
    const now = deps.now();
    running = true;
    lastError = null;
    // Fire-and-forget: the request returns now; the scan continues on the event loop.
    void scan
      .run({
        sinceIso: daysBefore(now, Number.isFinite(days) ? days : 1),
        nowIso: now,
        limitPerSource: 1000,
        includeQuoteExcerpt: deps.config.includeQuoteExcerpt,
      })
      .then((r) => {
        last = r;
      })
      .catch((err: unknown) => {
        lastError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        running = false;
        lastFinishedAt = deps.now();
      });
    return { started: true, running: true, days };
  });

  app.get("/scan/status", async () => ({ running, last, lastError, lastFinishedAt }));
}
