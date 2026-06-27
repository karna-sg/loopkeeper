#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import { buildAppFromConfig } from "./app.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, scheduler } = buildAppFromConfig(config);
  await app.listen({ port: config.port, host: config.host });
  console.log(`Loopkeeper backend on http://${config.host}:${config.port}`);
  console.log(`  connect:  GET /auth/slack   GET /auth/google`);
  console.log(`  scan:     POST /scan        brief: GET /brief        nudge: POST /nudge`);
  console.log(`  data dir: ${config.dataDir}`);

  const running = scheduler.start();
  console.log(
    running
      ? `  scheduler: on — scan every ${config.scanEveryMin}m, nudge every ${config.nudgeEveryMin}m, purge daily`
      : `  scheduler: off (set LOOPKEEPER_SCAN_EVERY_MIN / LOOPKEEPER_NUDGE_EVERY_MIN > 0)`,
  );

  const shutdown = (): void => {
    scheduler.stop();
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
