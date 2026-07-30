import { assertRunConfig, loadConfig } from "./config.js";
import { log } from "./logger.js";
import { runPipeline } from "./pipeline.js";
import { createInitialStatus } from "./status.js";

const config = loadConfig();
assertRunConfig(config);

const status = {
  ...createInitialStatus(),
  state: "running",
  stage: "reading_categories",
  startedAt: new Date().toISOString(),
};

try {
  await runPipeline(config, status);
  status.state = "completed";
  status.stage = "completed";
} catch (error) {
  status.state = "failed";
  status.stage = "failed";
  status.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  status.completedAt = new Date().toISOString();
  log("run_once_finished", status);
}
