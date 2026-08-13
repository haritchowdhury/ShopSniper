import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { processFinalAggregation } from "../src/aws-pipeline/services/final-aggregator.js";

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/aws-pipeline/v1/${name}`, import.meta.url)));
const message = { version: 1, type: "aggregation.check", runId: "run_fixture_payload_discovery_0001",
  stage: "traffic_crux", generation: 1, reason: "zero_expected", attempt: 1 };

test("final aggregator busy/cancelled ownership returns without artifact or publication work", async () => {
  for (const outcome of ["busy", "cancelled", "terminal"]) {
    let extra = false;
    const result = await processFinalAggregation(message, { coordinator: {
      async claimAggregator() { return { outcome }; } }, artifactStore: { getValidated() { extra = true; } } });
    assert.deepEqual(result, { terminal: true, outcome });
    assert.equal(extra, false);
  }
});

test("zero-task final aggregation validates the shared manifest and publishes atomically", async () => {
  const domainManifest = await load("domain-manifest.valid.json");
  const workPlan = await load("domain-work-plan.valid.json");
  domainManifest.domains = []; workPlan.domains = [];
  workPlan.awsProviderConfig.trafficHttp.cruxBigQueryProjectIdFingerprint = null;
  const manifest = { contractVersion: "domain-stage-manifest-v1", domainManifest, workPlan };
  const fingerprint = fingerprintJson(manifest);
  const events = []; let published;
  const runtime = {
    coordinator: {
      async claimAggregator() { events.push("claim"); return { outcome: "owned", stage: { id: "traffic_stage" } }; },
      async getCompleteStage() { events.push("complete"); return { stage: { id: "traffic_stage",
        manifestS3Key: workPlan.domainManifestKey, manifestFingerprint: fingerprint,
        manifestProducedAt: new Date(workPlan.evaluatedAt) }, tasks: [] }; }
    },
    artifactStore: { async getValidated() { events.push("manifest"); return { value: manifest,
      contentFingerprint: fingerprint }; } },
    repository: {
      async readAwsFinalReuseRows(input) { events.push("reuse"); assert.deepEqual(input.selections, []);
        return { trafficRows: [], leadStage: { id: "lead_stage" }, leadTasks: [] }; },
      async publishAwsFinalResults(input) { events.push("publish"); published = input; return { resultFingerprint: "a".repeat(64) }; }
    }
  };
  const result = await processFinalAggregation(message, runtime, { createLeaseMonitorFn: () => ({
    assertActive() {}, async renewNow() { events.push("renew"); }, async stop() { events.push("stop"); } }) });
  assert.deepEqual(result, { terminal: true, outcome: "completed" });
  assert.deepEqual(published.cacheRows, []); assert.deepEqual(published.leadTrafficRows, []);
  assert.deepEqual(published.leadProfileOutcomes, []);
  assert.ok(events.indexOf("renew") < events.indexOf("publish"));
});

test("publication not-ready and cancellation outcomes remain terminal and privacy-safe", async () => {
  for (const [code, outcome] of [["PIPELINE_NOT_READY", "not_ready"], ["PIPELINE_CANCELLED", "cancelled"]]) {
    const domainManifest = await load("domain-manifest.valid.json"); const workPlan = await load("domain-work-plan.valid.json");
    domainManifest.domains = []; workPlan.domains = []; workPlan.awsProviderConfig.trafficHttp.cruxBigQueryProjectIdFingerprint = null;
    const manifest = { contractVersion: "domain-stage-manifest-v1", domainManifest, workPlan };
    const fingerprint = fingerprintJson(manifest);
    const error = Object.assign(new Error(code), { code });
    const runtime = { coordinator: { async claimAggregator() { return { outcome: "owned", stage: { id: "s" } }; },
      async getCompleteStage() { return { stage: { id: "s", manifestS3Key: workPlan.domainManifestKey,
        manifestFingerprint: fingerprint, manifestProducedAt: new Date(workPlan.evaluatedAt) }, tasks: [] }; } },
    artifactStore: { async getValidated() { return { value: manifest }; } }, repository: {
      async readAwsFinalReuseRows() { return { trafficRows: [], leadTasks: [] }; },
      async publishAwsFinalResults() { throw error; } } };
    assert.deepEqual(await processFinalAggregation(message, runtime, { createLeaseMonitorFn: () => ({
      async renewNow() {}, async stop() {} }) }), { terminal: true, outcome });
  }
});

async function oneDomainFinalHarness(mutator = () => {}) {
  const domainManifest = await load("domain-manifest.valid.json"); const workPlan = await load("domain-work-plan.valid.json");
  const manifest = { contractVersion: "domain-stage-manifest-v1", domainManifest, workPlan };
  const manifestFingerprint = fingerprintJson(manifest); const plan = workPlan.domains[0];
  const combined = await load("combined-traffic-crux-result.valid.json");
  combined.components.dataforseo.state = "unavailable";
  combined.components.cruxRest.state = "unavailable";
  const leadId = "lead_fixture_final_0001";
  const sourceArtifacts = {
    dataforseo: { contractVersion: "provider-source-result-v1", runId: message.runId, generation: 1,
      shopId: plan.shopId, source: "dataforseo", state: "unavailable",
      scopeStates: plan.sourceKeys.dataForSeo.map(({ scopeKey }) => ({ scopeKey, state: "unavailable" })),
      requestEvidence: plan.sourceKeys.dataForSeo.map(({ scopeKey }) =>
        ({ scopeKey, disposition: "not_dispatched", reason: "budget_exhausted" })),
      cacheRows: [], leadTrafficRows: [{ leadId, source: "dataforseo", state: "unavailable",
        contractVersion: "dataforseo-traffic-v1" }], summary: {}, diagnostics: [] },
    "crux-rest": { contractVersion: "provider-source-result-v1", runId: message.runId, generation: 1,
      shopId: plan.shopId, source: "crux_rest", state: "unavailable",
      scopeStates: [{ scopeKey: "current", state: "unavailable" }], cacheRows: [],
      requestEvidence: [],
      leadTrafficRows: [{ leadId, source: "crux_rest", state: "unavailable",
        contractVersion: "crux-origin-metrics-v1" }], summary: {}, diagnostics: [] },
    "crux-bigquery": { contractVersion: "provider-source-result-v1", runId: message.runId, generation: 1,
      shopId: plan.shopId, source: "crux_bigquery", state: "contract_mismatch",
      scopeStates: [{ scopeKey: "month:202607", state: "contract_mismatch" }], cacheRows: [],
      requestEvidence: [],
      leadTrafficRows: [{ leadId, source: "crux_bigquery", state: "contract_mismatch",
        contractVersion: "crux-popularity-v1" }], summary: {}, diagnostics: [] }
  };
  const leadResult = { contractVersion: "lead-result-v1", result: (await load("lead-results.valid.json")).success };
  const trafficTask = { id: "traffic_task", itemKey: plan.shopId, state: "succeeded",
    inputFingerprint: "b".repeat(64), artifactS3Key: `runs/${message.runId}/domains/${plan.shopId}/traffic-crux.json`,
    artifactFingerprint: fingerprintJson(combined), createdAt: new Date(workPlan.evaluatedAt) };
  const leadTask = { id: "lead_task", itemKey: plan.shopId, state: "succeeded", inputFingerprint: "c".repeat(64),
    artifactS3Key: `runs/${message.runId}/domains/${plan.shopId}/lead.json`,
    artifactFingerprint: fingerprintJson(leadResult), createdAt: new Date(workPlan.evaluatedAt) };
  const batchArtifacts = {};
  const state = { manifest, combined, sourceArtifacts, batchArtifacts, leadResult, trafficTask, leadTask };
  mutator(state);
  let published;
  const runtime = { coordinator: {
    async claimAggregator() { return { outcome: "owned", stage: { id: "traffic_stage" } }; },
    async getCompleteStage() { return { stage: { id: "traffic_stage", manifestS3Key: workPlan.domainManifestKey,
      manifestFingerprint, manifestProducedAt: new Date(workPlan.evaluatedAt) }, tasks: [trafficTask] }; } },
  artifactStore: { async getValidated({ key }) {
    if (key === workPlan.domainManifestKey) return { value: manifest, contentFingerprint: manifestFingerprint };
    if (key === trafficTask.artifactS3Key) return { value: combined, contentFingerprint: fingerprintJson(combined) };
    if (key === leadTask.artifactS3Key) return { value: leadResult, contentFingerprint: fingerprintJson(leadResult) };
    if (batchArtifacts[key]) return { value: batchArtifacts[key], contentFingerprint: fingerprintJson(batchArtifacts[key]) };
    const source = key.split("/").at(-1).replace(".json", "");
    if (!sourceArtifacts[source]) throw Object.assign(new Error("missing"), { code: "PIPELINE_ARTIFACT_INVALID" });
    return { value: sourceArtifacts[source], contentFingerprint: fingerprintJson(sourceArtifacts[source]) };
  } }, repository: {
    async readAwsFinalReuseRows() { return { trafficRows: [], leadStage: {}, leadTasks: [leadTask] }; },
    async publishAwsFinalResults(input) { published = input; return { resultFingerprint: "d".repeat(64) }; }
  } };
  const result = await processFinalAggregation(message, runtime, { createLeaseMonitorFn: () => ({
    async renewNow() {}, async stop() {} }) });
  return { result, published };
}

test("final aggregator reconstructs all independent source and lead artifacts", async () => {
  const { result, published } = await oneDomainFinalHarness();
  assert.deepEqual(result, { terminal: true, outcome: "completed" });
  assert.equal(published.leadTrafficRows.length, 3);
  assert.deepEqual(published.workOutcomes.map(({ workType }) => workType).sort(),
    ["crux_bigquery", "crux_rest"]);
  assert.deepEqual(published.leadProfileOutcomes.map(({ state }) => state), ["new"]);
});

test("final aggregator validates a succeeded paid batch reference and emits unique ledger evidence", async () => {
  const { published } = await oneDomainFinalHarness(({ sourceArtifacts, batchArtifacts }) => {
    const scopeKey = sourceArtifacts.dataforseo.scopeStates[0].scopeKey;
    const requestFingerprint = "1".repeat(64); const batchId = "2".repeat(64);
    const key = `runs/${message.runId}/traffic-batches/dataforseo/${batchId}.json`;
    const batch = { contractVersion: "provider-batch-result-v1", runId: message.runId, generation: 1,
      source: "dataforseo", scopeKey, batchId, providerRequestFingerprint: requestFingerprint,
      items: [{ shopId: sourceArtifacts.dataforseo.shopId, state: "unavailable", cacheRows: [],
        leadTrafficRows: [], summary: { providerCostUsd: 0.01 }, diagnostics: [] }] };
    batchArtifacts[key] = batch;
    sourceArtifacts.dataforseo.requestEvidence[0] = { scopeKey, disposition: "ledger", requestFingerprint,
      targetCount: 1, ledgerState: "succeeded", batchId, batchArtifactKey: key,
      batchArtifactFingerprint: fingerprintJson(batch) };
  });
  assert.deepEqual(published.dataForSeoLedgerEvidence, [{ requestFingerprint: "1".repeat(64),
    scopeKey: "worldwide", targetCount: 1, state: "succeeded", resultFingerprint:
    published.dataForSeoLedgerEvidence[0].resultFingerprint }]);
  assert.match(published.dataForSeoLedgerEvidence[0].resultFingerprint, /^[a-f0-9]{64}$/u);
});

for (const [name, mutate] of [
  ["missing source material", ({ sourceArtifacts }) => { sourceArtifacts["crux-rest"].leadTrafficRows = []; }],
  ["wrong source scope", ({ sourceArtifacts }) => { sourceArtifacts.dataforseo.scopeStates[0].scopeKey = "wrong"; }],
  ["wrong combined state", ({ combined }) => { combined.components.cruxRest.state = "no_coverage"; }]
]) test(`final aggregator fails closed on ${name}`, async () => {
  await assert.rejects(oneDomainFinalHarness(mutate), (error) =>
    ["PIPELINE_INPUT_CONFLICT", "PIPELINE_ARTIFACT_INVALID"].includes(error.code));
});
