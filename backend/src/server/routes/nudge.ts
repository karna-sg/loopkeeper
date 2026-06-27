import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.ts";

export function registerNudge(app: FastifyInstance, deps: AppDeps): void {
  // Run the nudge sweep: push self-reminders for at-risk owe-loops, mark them nudged.
  app.post("/nudge", async (req, reply) => {
    const q = req.query as { days?: string };
    const windowDays = Number(q.days ?? "1");
    let nudge;
    try {
      nudge = deps.buildNudgeService();
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : "nudge unavailable" });
    }
    return nudge.run({
      nowIso: deps.now(),
      timezone: deps.identity.timezone,
      windowDays: Number.isFinite(windowDays) ? windowDays : 1,
    });
  });
}
