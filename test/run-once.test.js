import assert from "node:assert/strict";
import test from "node:test";
import { runOnce } from "../src/run-once.js";

test("run:once remains the explicit legacy CSV output sink", async () => {
  const config = {
    googleApiKey: "test",
    googleSearchEngineId: "test",
    openaiApiKey: "test",
    outputCsv: "/tmp/legacy-leads.csv"
  };
  const leads = [{ shop_type: "eyewear", status: "qualified" }];
  let written;
  const status = await runOnce(config, {
    pipeline: async (_config, pipelineStatus) => {
      pipelineStatus.stage = "writing_results";
      pipelineStatus.outputRows = 1;
      return {
        leads,
        summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
      };
    },
    outputWriter: async (path, rows) => {
      written = { path, rows };
    },
    logger: () => {}
  });

  assert.deepEqual(written, {
    path: "/tmp/legacy-leads.csv",
    rows: leads
  });
  assert.equal(status.state, "completed");
  assert.equal(status.stage, "completed");
  assert(status.completedAt);
});
