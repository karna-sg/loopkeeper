#!/usr/bin/env node
/**
 * The engineering worker process (runs in its own container — has git/gh/claude + the build
 * toolchain). It owns running Claude Code, pushing branches, merging, and the SSH redeploy. It
 * shares `eng.db` with the api (single writer at concurrency 1) and drains the job queue.
 */
import { loadConfig } from "../server/config.ts";
import { EngStore } from "../store/eng-store.ts";
import { buildWorker } from "../engineering/factory.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.eng.enabled) {
    console.error("[worker] ENG_ENABLED=0 — exiting");
    return;
  }
  const engStore = new EngStore(config.eng.dbPath);
  const worker = buildWorker(config, engStore);
  worker.recover();
  worker.start(config.workerPollEverySec * 1000, { keepAlive: true });
  console.log(`[worker] started — polling eng.db every ${config.workerPollEverySec}s (concurrency ${config.eng.maxConcurrent})`);

  const shutdown = (): void => {
    worker.stop();
    engStore.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
