import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.ts";

const { version } = JSON.parse(
  readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "../../../package.json"),
    "utf8",
  ),
) as { version: string };

export function registerVersion(app: FastifyInstance, _deps: AppDeps): void {
  app.get("/version", async () => ({
    version,
    commit: process.env.GIT_COMMIT ?? "dev",
  }));
}
