import { fileURLToPath } from "node:url";
import { assertRunConfig, loadConfig } from "./config.js";
import { log } from "./logger.js";
import { writeOutput } from "./output.js";
import { runPipeline } from "./pipeline.js";
import { createInitialStatus } from "./status.js";

export async function runOnce(
  config,
  { pipeline = runPipeline, outputWriter = writeOutput, logger = log } = {}
) {
  const status = {
    ...createInitialStatus(),
    state: "running",
    stage: "reading_categories",
    startedAt: new Date().toISOString()
  };

  try {
    if (config.dataForSeoEnrichmentEnabled || config.cruxEnrichmentEnabled) {
      throw new Error(
        "Traffic enrichment is not supported by npm run run:once. " +
        "Set ENABLE_DATAFORSEO_ENRICHMENT=false and ENABLE_CRUX_ENRICHMENT=false, " +
        "then use the durable server workflow for enriched results."
      );
    }
    assertRunConfig(config);
    const result = await pipeline(config, status);
    await outputWriter(config.outputCsv, result.leads);
    status.state = "completed";
    status.stage = "completed";
    return status;
  } catch (error) {
    status.state = "failed";
    status.stage = "failed";
    status.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    status.completedAt = new Date().toISOString();
    logger("run_once_finished", status);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runOnce(loadConfig());
  } catch {
    process.exitCode = 1;
  }
}
