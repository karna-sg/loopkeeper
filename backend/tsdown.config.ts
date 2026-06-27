import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/phase0.ts", "src/server/server.ts", "src/worker/worker.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  clean: true,
});
