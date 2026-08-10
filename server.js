import { loadConfig } from "./lib/config.js";
import { createServer } from "./lib/server.js";

const config = loadConfig(process.env);
const server = createServer(config);

// PORT is assigned by the Toolforge build service; hardcoding it makes the
// healthcheck fail.
server.listen(config.port, () => {
  console.log(`llm-router listening on port ${config.port}`);
  console.log(`  /liftwing -> ${config.liftwing.base}`);
  console.log(`  /hf       -> ${config.hf.base}`);
  if (!config.liftwing.token) {
    console.warn("  LIFTWING_TOKEN not set — Lift Wing calls use the anonymous rate-limit tier");
  }
  if (!config.hf.token) {
    console.warn("  HF_TOKEN not set — /hf will fail upstream auth");
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
