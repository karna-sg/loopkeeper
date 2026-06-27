import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.ts";
import { extractionStatus } from "../../llm/factory.ts";

export function registerHealth(app: FastifyInstance, deps: AppDeps): void {
  app.get("/healthz", async () => ({
    ok: true,
    loops: deps.store.count(),
    connected: deps.vault.list(),
    extraction: extractionStatus(deps.config),
  }));
}
