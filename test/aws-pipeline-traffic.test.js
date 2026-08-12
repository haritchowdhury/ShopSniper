import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { leadRecordToCreate } from "../src/api-serializer.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { buildCruxBigQueryLiveRequest } from "../src/enrichment/crux/bigquery-request.js";
import { processTrafficBatch, trafficInputFingerprint } from "../src/aws-pipeline/services/traffic-worker.js";
import { EnrichmentError, ENRICHMENT_ERROR_CODES } from "../src/enrichment/errors.js";
import { assertTrafficCallCeilings, bigQueryAttemptBody, mapProviderError,
  providerBatchIdentity, reconcileBigQueryAttempt, sourceAttemptBody,
  trafficProviderConfigFingerprint } from "../src/aws-pipeline/traffic/durable-protocol.js";

const message = Object.freeze({ version: 1, type: "traffic.domain",
  runId: "run_traffic_fixture_0001", stage: "traffic_crux", generation: 1,
  itemId: "shop_13iOzZDK7joaSKKTmscbk00V",
  manifestKey: "runs/run_traffic_fixture_0001/domains-manifest.json",
  manifestFingerprint: "a".repeat(64), manifestProducedAt: "2026-08-12T00:00:00.000Z", attempt: 1 });
const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/aws-pipeline/v1/${name}`, import.meta.url)));

async function serviceHarness({ failAt, terminalReplay = false, triggers = ["m1"], cancelled = false,
  artifactSeed, sharedState } = {}) {
  const domainManifest = await load("domain-manifest.valid.json");
  const workPlan = await load("domain-work-plan.valid.json");
  const leadFixture = (await load("lead-results.valid.json")).success.lead;
  const traffic = trafficEnrichmentConfigSnapshot({});
  workPlan.domains[0] = { ...workPlan.domains[0], needsTraffic: false,
    needsCruxRest: false, needsCruxBigQuery: false, needsCrux: false };
  workPlan.awsProviderConfig.trafficHttp.cruxBigQueryProjectIdFingerprint = null;
  const manifest = { contractVersion: "domain-stage-manifest-v1", domainManifest, workPlan };
  const manifestFingerprint = fingerprintJson(manifest);
  const plan = workPlan.domains[0];
  const lead = { ...leadRecordToCreate(domainManifest.runId, "lead_fixture_service_0001", leadFixture),
    id: "lead_fixture_service_0001", runId: domainManifest.runId, shopId: plan.shopId,
    status: "qualified", identityEvidence: leadFixture.identity_evidence };
  const task = { id: "pipeline_task_fixture_service", itemKey: plan.shopId,
    createdAt: new Date(workPlan.evaluatedAt) };
  task.inputFingerprint = trafficInputFingerprint(domainManifest.runId, 1, manifestFingerprint, plan, lead);
  const artifacts = artifactSeed || new Map();
  const state = sharedState || { terminal: terminalReplay };
  const events = [];
  const maybeFail = (name) => { events.push(name); if (failAt === name) throw new Error(`injected:${name}`); };
  const runtime = {
    config: { awsPipelineFinalAggregationQueueUrl: "final" }, secrets: {},
    repository: {
      async claimAwsRunLease() { maybeFail("claim-run"); return cancelled ? { outcome: "cancelled" } :
        { outcome: "owned", lease: { token: "run-token", attempt: 1, expiresAt: new Date(Date.now() + 60000) } }; },
      async loadAwsTrafficStage() { maybeFail("load-stage"); return { run: { trafficEnrichmentConfig: traffic,
        awsProviderConfig: workPlan.awsProviderConfig }, stage: { expectedCount: 1 }, tasks: [task], leads: [lead] }; },
      async releaseAwsRunLease() { maybeFail("release-run"); return { run: {} }; },
      async renewAwsRunLease() { return { expiresAt: new Date(Date.now() + 60000) }; }
    },
    artifactStore: {
      async getValidated() { maybeFail("read-manifest"); return { value: manifest, contentFingerprint: manifestFingerprint }; },
      async getOptionalValidated({ key }) { maybeFail(`optional:${key.split("/").at(-1)}`);
        return artifacts.has(key) ? { outcome: "found", value: artifacts.get(key),
          contentFingerprint: fingerprintJson(artifacts.get(key)) } : { outcome: "missing" }; },
      async putImmutable({ key, value }) { maybeFail(`put:${key.split("/").at(-1)}`);
        if (artifacts.has(key)) assert.deepEqual(artifacts.get(key), value); else artifacts.set(key, value);
        return { contentFingerprint: fingerprintJson(value) }; }
    },
    coordinator: {
      async claimTask() { maybeFail("claim-task"); return state.terminal ? { outcome: "terminal", task } :
        { outcome: "owned", task }; },
      async recordTerminal() { maybeFail("record-terminal"); state.terminal = true; }
    },
    dispatcher: { async sendOne() { maybeFail("send-check"); return { sentItemIds: ["check"], failedItemIds: [] }; } }
  };
  const records = triggers.map((recordId) => ({ recordId, message: { ...message,
    runId: domainManifest.runId, itemId: plan.shopId, manifestKey: workPlan.domainManifestKey,
    manifestFingerprint, manifestProducedAt: workPlan.evaluatedAt } }));
  const result = await processTrafficBatch(records, runtime, { createLeaseMonitorFn: () => ({
    assertActive() {}, async renewNow() { events.push("renew-now"); }, async stop() { events.push("stop-monitor"); } }) });
  return { result, events, artifacts, state };
}

test("BigQuery live request pins a strict request ID only in the request body", () => {
  const requestId = `crux-${"b".repeat(31)}`;
  const descriptor = buildCruxBigQueryLiveRequest({ origins: ["https://fixture.example"],
    month: "202607", projectId: "fixture-project", location: "US",
    maximumBytesBilled: 10000000000, requestId });
  assert.equal(descriptor.body.requestId, requestId);
  assert.equal(descriptor.requestId, undefined);
  assert.equal(descriptor.endpoint.includes(requestId), false);
  assert.throws(() => buildCruxBigQueryLiveRequest({ origins: ["https://fixture.example"],
    month: "202607", projectId: "fixture-project", location: "US",
    maximumBytesBilled: 10000000000, requestId: "invalid" }));
});

test("busy stage-wide owner makes every trigger in the group retryable without I/O", async () => {
  let calls = 0;
  const runtime = { repository: { async claimAwsRunLease() { calls += 1; return { outcome: "busy" }; } } };
  const result = await processTrafficBatch([{ recordId: "m2", message },
    { recordId: "m1", message: { ...message, itemId: "shop_13iOzZDK7joaSKKTmscbk01V" } }], runtime);
  assert.equal(calls, 1);
  assert.deepEqual(result.results, [{ recordId: "m1", terminal: false, outcome: "busy" },
    { recordId: "m2", terminal: false, outcome: "busy" }]);
});

test("mixed groups are processed sequentially and one ownership failure does not suppress later groups", async () => {
  const calls = [];
  const runtime = { repository: { async claimAwsRunLease({ runId }) { calls.push(runId);
    if (runId.endsWith("0002")) throw new Error("fixture"); return { outcome: "cancelled" }; } } };
  const records = ["0002", "0001", "0003"].map((suffix) => ({ recordId: `m${suffix}`,
    message: { ...message, runId: `run_traffic_fixture_${suffix}`,
      manifestKey: `runs/run_traffic_fixture_${suffix}/domains-manifest.json` } }));
  const result = await processTrafficBatch(records, runtime);
  assert.deepEqual(calls, ["run_traffic_fixture_0002", "run_traffic_fixture_0001", "run_traffic_fixture_0003"]);
  assert.deepEqual(result.results.map(({ outcome }) => outcome), ["cancelled", "failed", "cancelled"]);
});

test("traffic service rejects unknown dependency injection before ownership", async () => {
  let claimed = false;
  await assert.rejects(processTrafficBatch([{ recordId: "m1", message }],
    { repository: { claimAwsRunLease() { claimed = true; } } }, { alternateClient: () => {} }),
  (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  assert.equal(claimed, false);
});

test("provider batch identity is order-independent, snapshot-bound, and pins the BigQuery request ID", () => {
  const base = { runId: message.runId, generation: 1, source: "crux_bigquery",
    scopeKey: "month:202607", manifestFingerprint: "a".repeat(64),
    runSnapshot: { enabled: true }, providerRequestFingerprint: "bigquery-request-id-v1" };
  const items = [{ shopId: "shop_b", sourceKey: { identity: "https://b.example" } },
    { shopId: "shop_a", sourceKey: { identity: "https://a.example" } }];
  const left = providerBatchIdentity({ ...base, items });
  const right = providerBatchIdentity({ ...base, items: [...items].reverse() });
  assert.deepEqual(left, right);
  assert.equal(left.batchId, left.batchInputFingerprint);
  assert.equal(left.requestId, `crux-${left.batchId.slice(0, 31)}`);
  assert.notEqual(trafficProviderConfigFingerprint(base.runSnapshot),
    trafficProviderConfigFingerprint({ enabled: false }));
});

test("REST marker binds the exact task and source selection", () => {
  const body = sourceAttemptBody({ runId: message.runId, generation: 1, shopId: message.itemId,
    taskInputFingerprint: "b".repeat(64), selection: { source: "crux_rest", identity: "https://a.example" } });
  assert.equal(body.source, "crux_rest");
  assert.match(body.sourceKeyFingerprint, /^[a-f0-9]{64}$/u);
});

test("BigQuery marker permits only same-ID live retry strictly before 15 minutes", () => {
  const attempt = bigQueryAttemptBody({ runId: message.runId, generation: 1,
    scopeKey: "month:202607", batchInputFingerprint: "b".repeat(64), datasetMonth: "202607",
    dryRunBytesProcessed: 80, dispatchedAt: "2026-08-12T00:00:00.000Z" });
  assert.deepEqual(reconcileBigQueryAttempt(attempt, { now: "2026-08-12T00:14:59.999Z",
    scopeKey: "month:202607", maximumBytesBilled: 100 }), { outcome: "retry",
    requestId: `crux-${"b".repeat(31)}`, dryRun: { datasetMonth: "202607", bytesProcessed: 80 } });
  assert.deepEqual(reconcileBigQueryAttempt(attempt, { now: "2026-08-12T00:15:00.000Z",
    scopeKey: "month:202607", maximumBytesBilled: 100 }), { outcome: "ambiguous" });
  assert.throws(() => reconcileBigQueryAttempt(attempt, { now: "2026-08-12T00:01:00.000Z",
    scopeKey: "month:202606", maximumBytesBilled: 100 }), (error) => error.code === "PIPELINE_INPUT_CONFLICT");
});

test("fixed provider error matrix distinguishes paid ambiguity, REST status, and BQ preflight attempts", () => {
  const error = (code, httpStatus = 0, paidOutcome = "possibly_charged") => new EnrichmentError("safe", {
    code, provider: "fixture", contractVersion: "fixture-v1", httpStatus, paidOutcome });
  assert.deepEqual(mapProviderError("dataforseo", "live",
    error(ENRICHMENT_ERROR_CODES.providerHttp, 0, "not_dispatched")),
  { outcome: "unavailable", ledger: "failed" });
  assert.deepEqual(mapProviderError("dataforseo", "live",
    error(ENRICHMENT_ERROR_CODES.providerHttp)), { outcome: "ambiguous", ledger: "ambiguous" });
  assert.deepEqual(mapProviderError("crux_rest", "live",
    error(ENRICHMENT_ERROR_CODES.providerHttp, 0)), { outcome: "ambiguous" });
  assert.deepEqual(mapProviderError("crux_rest", "live",
    error(ENRICHMENT_ERROR_CODES.providerHttp, 503)), { outcome: "unavailable" });
  assert.deepEqual(mapProviderError("crux_bigquery", "table",
    error(ENRICHMENT_ERROR_CODES.providerHttp, 503), 1), { outcome: "retry" });
  assert.deepEqual(mapProviderError("crux_bigquery", "dry",
    error(ENRICHMENT_ERROR_CODES.providerHttp, 0), 3), { outcome: "ambiguous" });
  assert.deepEqual(mapProviderError("crux_bigquery", "live",
    error(ENRICHMENT_ERROR_CODES.contractMismatch)), { outcome: "contract_mismatch" });
  assert.deepEqual(mapProviderError("crux_rest", "live", new Error("program")), { outcome: "throw" });
});

test("52-domain amplification ceilings are exact and fail closed", () => {
  const exact = { dataForSeoAdapter: 10, cruxRestAdapter: 52, cruxRestHttp: 156,
    bigQueryTableAdapter: 3, bigQueryTableHttp: 6, bigQueryDryAdapter: 3,
    bigQueryDryHttp: 6, bigQueryLiveAdapter: 1, bigQueryLiveHttp: 2 };
  assert.deepEqual(assertTrafficCallCeilings(exact, 52), exact);
  assert.throws(() => assertTrafficCallCeilings({ ...exact, cruxRestHttp: 157 }, 52),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
});

test("service processes duplicate and reverse triggers from one complete stage-wide set", async () => {
  const { result, events, artifacts } = await serviceHarness({ triggers: ["m3", "m1", "m2", "m1"] });
  assert.deepEqual(result.results.map(({ recordId, outcome }) => [recordId, outcome]),
    [["m1", "recorded"], ["m1", "recorded"], ["m2", "recorded"], ["m3", "recorded"]]);
  assert.equal([...artifacts.keys()].filter((key) => key.endsWith("traffic-crux.json")).length, 1);
  assert.ok(events.indexOf("record-terminal") < events.indexOf("release-run"));
  assert.ok(events.indexOf("release-run") < events.indexOf("send-check"));
  assert.equal(events.filter((event) => event === "send-check").length, 1);
});

test("terminal replay still releases the Run lease before exactly one recovery check", async () => {
  const { result, events } = await serviceHarness({ terminalReplay: true, triggers: ["m2", "m1"] });
  assert.deepEqual(result.results.map(({ outcome }) => outcome), ["replayed", "replayed"]);
  assert.ok(events.indexOf("release-run") < events.indexOf("send-check"));
  assert.equal(events.filter((event) => event === "send-check").length, 1);
});

test("crash after immutable combined artifact recovers without changing bytes", async () => {
  const first = await serviceHarness({ failAt: "claim-task" });
  const before = [...first.artifacts.entries()];
  const second = await serviceHarness({ artifactSeed: first.artifacts, sharedState: first.state });
  assert.deepEqual([...second.artifacts.entries()], before);
  assert.deepEqual(second.result.results, [{ recordId: "m1", terminal: true, outcome: "recorded" }]);
  assert.equal(second.events.filter((event) => event === "send-check").length, 1);
});

test("split invocations converge through terminal replay and each sends at most one check", async () => {
  const artifacts = new Map(); const state = { terminal: false };
  const first = await serviceHarness({ triggers: ["late"], artifactSeed: artifacts, sharedState: state });
  const second = await serviceHarness({ triggers: ["early"], artifactSeed: artifacts, sharedState: state });
  assert.equal(first.result.results[0].outcome, "recorded");
  assert.equal(second.result.results[0].outcome, "replayed");
  assert.equal(first.events.filter((event) => event === "send-check").length, 1);
  assert.equal(second.events.filter((event) => event === "send-check").length, 1);
});

test("cancelled stage-wide claim acknowledges all records without artifact or queue I/O", async () => {
  const { result, events, artifacts } = await serviceHarness({ cancelled: true, triggers: ["m2", "m1"] });
  assert.deepEqual(result.results, [{ recordId: "m1", terminal: true, outcome: "cancelled" },
    { recordId: "m2", terminal: true, outcome: "cancelled" }]);
  assert.deepEqual(events, ["claim-run"]);
  assert.equal(artifacts.size, 0);
});

for (const crash of ["load-stage", "read-manifest", "optional:traffic-crux.json",
  "put:traffic-crux.json", "claim-task", "record-terminal", "release-run", "send-check"]) {
  test(`service crash boundary ${crash} is privacy-safe and never fabricates success`, async () => {
    const { result, events } = await serviceHarness({ failAt: crash });
    assert.deepEqual(result.results, [{ recordId: "m1", terminal: true, outcome: "failed" }]);
    if (events.includes("release-run")) assert.ok(events.indexOf("record-terminal") < events.indexOf("release-run"));
    if (events.includes("send-check")) assert.ok(events.indexOf("release-run") < events.indexOf("send-check"));
  });
}
