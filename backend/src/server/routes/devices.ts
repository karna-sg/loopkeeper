import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.ts";

export function registerDevices(app: FastifyInstance, deps: AppDeps): void {
  // Register an APNs device token (from the iOS app after permission grant).
  app.post("/devices", async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; platform?: string };
    if (!body.token) return reply.code(400).send({ error: "token required" });
    deps.store.registerDevice(body.token, deps.now(), body.platform ?? "ios");
    return { ok: true, devices: deps.store.listDeviceTokens().length };
  });

  app.delete("/devices/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    return deps.store.removeDevice(token) ? { ok: true } : reply.code(404).send({ error: "not found" });
  });
}
