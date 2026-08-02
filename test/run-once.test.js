import assert from "node:assert/strict";
import test from "node:test";
import { runOnce } from "../src/run-once.js";

function runConfig(overrides = {}) {
  return {
    googleApiKey: "test",
    googleSearchEngineId: "test",
    openaiApiKey: "test",
    outputCsv: "/tmp/legacy-leads.csv",
    dataForSeoEnrichmentEnabled: false,
    cruxEnrichmentEnabled: false,
    ...overrides
  };
}

test("run:once remains the explicit legacy CSV output sink", async () => {
  const config = runConfig();
  const leads = [{ shop_type: "eyewear", status: "qualified" }];
  let written;
  const logged = [];
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
    logger: (event, fields) => logged.push({ event, fields })
  });

  assert.deepEqual(written, {
    path: "/tmp/legacy-leads.csv",
    rows: leads
  });
  assert.equal(status.state, "completed");
  assert.equal(status.stage, "completed");
  assert(status.completedAt);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, "run_once_finished");
  assert.equal(logged[0].fields.state, "completed");
});

for (const flags of [
  { dataForSeoEnrichmentEnabled: true, cruxEnrichmentEnabled: false },
  { dataForSeoEnrichmentEnabled: false, cruxEnrichmentEnabled: true },
  { dataForSeoEnrichmentEnabled: true, cruxEnrichmentEnabled: true }
]) {
  const label = [
    flags.dataForSeoEnrichmentEnabled ? "DataForSEO" : null,
    flags.cruxEnrichmentEnabled ? "CrUX" : null
  ].filter(Boolean).join(" and ");

  test(`run:once rejects ${label} before pipeline, output, or provider interaction`, async () => {
    const calls = {
      pipeline: 0,
      outputWriter: 0,
      credentialProvider: 0,
      cache: 0,
      paidLedger: 0,
      network: 0
    };
    const logged = [];

    await assert.rejects(runOnce(runConfig(flags), {
      pipeline: async () => {
        calls.pipeline += 1;
        calls.credentialProvider += 1;
        calls.cache += 1;
        calls.paidLedger += 1;
        calls.network += 1;
        return { leads: [] };
      },
      outputWriter: async () => {
        calls.outputWriter += 1;
      },
      logger: (event, fields) => logged.push({ event, fields })
    }), (error) => {
      assert.match(error.message, /Traffic enrichment is not supported by npm run run:once/u);
      assert.match(error.message, /ENABLE_DATAFORSEO_ENRICHMENT=false/u);
      assert.match(error.message, /ENABLE_CRUX_ENRICHMENT=false/u);
      assert.match(error.message, /durable server workflow/u);
      return true;
    });

    assert.deepEqual(calls, {
      pipeline: 0,
      outputWriter: 0,
      credentialProvider: 0,
      cache: 0,
      paidLedger: 0,
      network: 0
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].event, "run_once_finished");
    assert.equal(logged[0].fields.state, "failed");
    assert.equal(logged[0].fields.stage, "failed");
    assert.match(logged[0].fields.error, /durable server workflow/u);
  });
}
