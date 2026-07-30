import { assertRunConfig, loadConfig } from "./config.js";
import { log } from "./logger.js";
import { runPipeline } from "./pipeline.js";

const config = loadConfig();
assertRunConfig(config);

const status = {
  state: "running",
  startedAt: new Date().toISOString(),
  completedAt: "",
  queriesTotal: 0,
  queriesProcessed: 0,
  blankQueriesSkipped: 0,
  storesDiscovered: 0,
  storesQualified: 0,
  storesRejected: 0,
  failures: 0,
  outputRows: 0,
  error: ""
};

try {
  await runPipeline(config, status);
  status.state = "completed";
} catch (error) {
  status.state = "failed";
  status.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  status.completedAt = new Date().toISOString();
  log("run_once_finished", status);
}
