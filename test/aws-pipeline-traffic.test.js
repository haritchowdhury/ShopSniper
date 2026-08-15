import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { leadRecordToCreate } from "../src/api-serializer.js";
import { runStoreId, shopIdForStableKey } from "../src/shop-persistence-contract.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { buildCruxBigQueryLiveRequest } from "../src/enrichment/crux/bigquery-request.js";
import { bindTrafficProviderIdentities, processTrafficBatch,
  trafficInputFingerprint } from "../src/aws-pipeline/services/traffic-worker.js";
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
  artifactSeed, sharedState, domainCount = 1, fullScopes = true, adapterOverrides = {},
  leaseAttempt = 1, secretOverrides = {}, stageState = "collecting" } = {}) {
  const domainManifest = await load("domain-manifest.valid.json");
  const workPlan = await load("domain-work-plan.valid.json");
  const leadFixture = (await load("lead-results.valid.json")).success.lead;
  const trafficSnapshot = trafficEnrichmentConfigSnapshot({ dataForSeoEnrichmentEnabled: true,
    cruxEnrichmentEnabled: true });
  const traffic = fullScopes ? trafficSnapshot : { ...trafficSnapshot,
    dataForSeo: { ...trafficSnapshot.dataForSeo, scopes: ["worldwide"] } };
  if (domainCount > 1) {
    const baseDomain = domainManifest.domains[0]; const basePlan = workPlan.domains[0];
    domainManifest.domains = Array.from({ length: domainCount }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      const domain = JSON.parse(JSON.stringify(baseDomain).replaceAll("fixture.example", `fixture-${suffix}.example`)
        .replaceAll("fixture.myshopify.com", `fixture-${suffix}.myshopify.com`));
      domain.shopId = shopIdForStableKey(domain.identity.stableKey);
      domain.runStoreId = runStoreId(domainManifest.runId, domain.shopId); return domain;
    });
    workPlan.domains = domainManifest.domains.map((domain, index) => {
      const suffix = String(index).padStart(3, "0");
      const plan = JSON.parse(JSON.stringify(basePlan).replaceAll("fixture.example", `fixture-${suffix}.example`)
        .replaceAll("fixture.myshopify.com", `fixture-${suffix}.myshopify.com`));
      plan.shopId = domain.shopId; plan.runStoreId = domain.runStoreId;
      plan.candidateKey = `runs/${domainManifest.runId}/domains/${domain.shopId}/candidate.json`;
      plan.candidateFingerprint = fingerprintJson({ contractVersion: "domain-candidate-v1",
        runId: domainManifest.runId, generation: 1, shopId: domain.shopId, runStoreId: domain.runStoreId,
        identity: domain.identity, candidatePayload: domain.candidatePayload });
      if (fullScopes) { const base = plan.sourceKeys.dataForSeo[0];
        plan.sourceKeys.dataForSeo = traffic.dataForSeo.scopes.map((scope) => ({ ...base,
          scopeKey: scope === "worldwide" ? scope : `country:${scope.countryIsoCode}:${scope.locationCode}` })); }
      return plan;
    });
  }
  if (domainCount === 1 && fullScopes) {
    const base = workPlan.domains[0].sourceKeys.dataForSeo[0];
    workPlan.domains[0].sourceKeys.dataForSeo = traffic.dataForSeo.scopes.map((scope) => ({ ...base,
      scopeKey: scope === "worldwide" ? scope : `country:${scope.countryIsoCode}:${scope.locationCode}` }));
  }
  workPlan.awsProviderConfig.trafficHttp.cruxBigQueryProjectIdFingerprint = fingerprintJson({
    contractVersion: "crux-bigquery-project-v1", projectId: "fixture-project" });
  const manifest = { contractVersion: "domain-stage-manifest-v1", domainManifest, workPlan };
  const manifestFingerprint = fingerprintJson(manifest);
  const plans = workPlan.domains; const leads = plans.map((plan, index) => {
    const suffix = String(index).padStart(3, "0");
    const fixture = domainCount === 1 ? leadFixture : JSON.parse(JSON.stringify(leadFixture)
      .replaceAll("fixture.example", `fixture-${suffix}.example`)
      .replaceAll("fixture.myshopify.com", `fixture-${suffix}.myshopify.com`));
    const id = `lead_fixture_service_${suffix}`;
    return { ...leadRecordToCreate(domainManifest.runId, id, fixture), id, runId: domainManifest.runId,
      shopId: plan.shopId, status: "qualified", identityEvidence: fixture.identity_evidence };
  });
  const tasks = plans.map((plan, index) => { const task = { id: `pipeline_task_fixture_${index}`,
    itemKey: plan.shopId, createdAt: new Date(workPlan.evaluatedAt) };
    task.inputFingerprint = trafficInputFingerprint(domainManifest.runId, 1, manifestFingerprint, plan, leads[index]);
    return task; });
  const plan = plans[0];
  const artifacts = artifactSeed || new Map();
  const state = sharedState || { terminal: terminalReplay };
  const events = []; const calls = { dataforseo: 0, rest: 0, table: 0, dry: 0, live: 0 };
  const maybeFail = (name) => { events.push(name); if (failAt === name) throw new Error(`injected:${name}`); };
  const runtime = {
    config: { awsPipelineFinalAggregationQueueUrl: "final" }, secrets: {
      dataForSeoLogin: "fixture", dataForSeoPassword: "fixture", cruxApiKey: "fixture",
      cruxBigQueryProjectId: "fixture-project", googleApplicationCredentials: "fixture", ...secretOverrides },
    repository: {
      async claimAwsRunLease() { maybeFail("claim-run"); return cancelled ? { outcome: "cancelled" } :
        { outcome: "owned", lease: { token: "run-token", attempt: leaseAttempt, leaseAttempt,
          expiresAt: new Date(Date.now() + 60000) } }; },
      async loadAwsTrafficStage() { maybeFail("load-stage"); return { run: { trafficEnrichmentConfig: traffic,
        awsProviderConfig: workPlan.awsProviderConfig }, stage: { expectedCount: tasks.length,
          state: stageState }, tasks, leads }; },
      async releaseAwsRunLease() { maybeFail("release-run"); return { run: {} }; },
      async renewAwsRunLease() { return { expiresAt: new Date(Date.now() + 60000) }; },
      async getDataForSeoRunCostUsd() { return 0; },
      async planDataForSeoRequest() { return { outcome: "planned" }; },
      async claimDataForSeoRequest() { return { outcome: "in_flight", networkAllowed: true }; },
      async recordAwsDataForSeoOutcome() { return { ledger: {} }; },
      async readReusableTrafficCache() { return []; },
      async readReusableLatestCruxBigQueryCache() { return []; },
      async claimAwsTrafficWorkBatch({ claims }) { return claims.map(({ shopId, selection }) => ({
        shopId, workType: selection.source, scopeKey: selection.scopeKey, outcome: "owned" })); }
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
      async claimTask({ itemKey }) { maybeFail("claim-task"); const task = tasks.find((entry) => entry.itemKey === itemKey);
        return state.terminal ? { outcome: "terminal", task } : { outcome: "owned", task }; },
      async recordTerminal() { maybeFail("record-terminal"); state.terminal = true; }
    },
    dispatcher: { async sendOne() { maybeFail("send-check"); return { sentItemIds: ["check"], failedItemIds: [] }; } }
  };
  const records = triggers.map((recordId) => ({ recordId, message: { ...message,
    runId: domainManifest.runId, itemId: plan.shopId, manifestKey: workPlan.domainManifestKey,
    manifestFingerprint, manifestProducedAt: workPlan.evaluatedAt } }));
  const defaultAdapters = { createLeaseMonitorFn: () => ({
    assertActive() {}, async renewNow() { events.push("renew-now"); }, async stop() { events.push("stop-monitor"); } }),
    fetchDataForSeoTrafficFn: async ({ targets, scope }) => { calls.dataforseo += 1; return {
      records: targets.map((target) => ({ state: "available", value: { contractVersion: "dataforseo-traffic-v1",
        target, scope: scope === "worldwide" ? scope : { countryIsoCode: scope.countryIsoCode,
          locationCode: traffic.dataForSeo.scopes.find((entry) => entry.countryIsoCode === scope.countryIsoCode).locationCode },
        languageScope: "all_available", metrics: { organic: { etv: 10, count: 1 }, paid: { etv: 0, count: 0 },
          featuredSnippet: { etv: 0, count: 0 }, localPack: { etv: 0, count: 0 } },
        fetchedAt: workPlan.evaluatedAt } })), cost: { providerReported: 0.01 } }; },
    fetchCruxOriginMetricsFn: async ({ origin }) => { calls.rest += 1; return { contractVersion: "crux-origin-metrics-v1",
      origin, coverage: "available", metrics: { largestContentfulPaintP75Ms: 1000 },
      collectionPeriod: { firstDate: "2026-07-01", lastDate: "2026-07-28" }, fetchedAt: workPlan.evaluatedAt }; },
    fetchCruxLatestDatasetMonthFn: async () => { calls.table += 1; return "202607"; },
    dryRunCruxPopularityFn: async () => { calls.dry += 1; return { datasetMonth: "202607", bytesProcessed: 100 }; },
    fetchCruxPopularityForMonthFn: async ({ origins, datasetMonth, dryRun }) => { calls.live += 1; return {
      datasetMonth, records: origins.map((origin) => ({ contractVersion: "crux-popularity-v1", origin,
        coverage: "available", datasetMonth, popularityRank: 1000,
        deviceFractions: { phone: 0.7, desktop: 0.29, tablet: 0.01 }, fetchedAt: workPlan.evaluatedAt })),
      dryRunBytesProcessed: dryRun.bytesProcessed, bytesProcessed: 100, bytesBilled: 100, cacheHit: false }; } };
  const result = await processTrafficBatch(records, runtime, { ...defaultAdapters, ...adapterOverrides });
  return { result, events, artifacts, state, calls };
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

test("provider execution stays bound to frozen source identities after a lead URL refinement", async () => {
  const plan = (await load("domain-work-plan.valid.json")).domains[0];
  const lead = (await load("lead-results.valid.json")).success.lead;
  const refined = { ...lead, final_url: "https://refined.example/products/item" };
  const bound = bindTrafficProviderIdentities("run_traffic_fixture_0001", refined, plan);
  assert.equal(bound.final_url, plan.sourceKeys.cruxRest.identity);
  assert.equal(bound.resolved_domain, plan.sourceKeys.dataForSeo[0].identity);
  assert.deepEqual(bound.identity_evidence, refined.identity_evidence);
  const conflicting = structuredClone(plan);
  conflicting.sourceKeys.cruxBigQuery.identity = "https://different.example";
  assert.throws(() => bindTrafficProviderIdentities("run_traffic_fixture_0001", refined, conflicting),
    /PIPELINE_INPUT_CONFLICT/u);
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
  assert.deepEqual(result.results.map(({ outcome }) => outcome), ["cancelled", "retryable", "cancelled"]);
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
  const { result, events, artifacts, calls, state } = await serviceHarness({ triggers: ["m3", "m1", "m2", "m1"] });
  assert.deepEqual(result.results.map(({ recordId, outcome }) => [recordId, outcome]),
    [["m1", "recorded"], ["m1", "recorded"], ["m2", "recorded"], ["m3", "recorded"]]);
  assert.equal([...artifacts.keys()].filter((key) => key.endsWith("traffic-crux.json")).length, 1);
  assert.deepEqual(calls, { dataforseo: 10, rest: 1, table: 1, dry: 1, live: 1 });
  assert.ok(events.indexOf("record-terminal") < events.indexOf("release-run"));
  assert.ok(events.indexOf("release-run") < events.indexOf("send-check"));
  assert.equal(events.filter((event) => event === "send-check").length, 1);
});

test("52-domain stage preserves run-wide provider cardinality through the real service", async () => {
  const { result, calls, artifacts } = await serviceHarness({ domainCount: 52, fullScopes: true,
    triggers: ["split-b", "split-a"] });
  assert.ok(result.results.every(({ outcome }) => outcome === "recorded"));
  assert.deepEqual(calls, { dataforseo: 10, rest: 52, table: 1, dry: 1, live: 1 });
  assert.equal([...artifacts.values()].filter(({ contractVersion }) =>
    contractVersion === "combined-traffic-crux-result-v1").length, 52);
});

test("REST marker makes a lost response terminally ambiguous without a second adapter call", async () => {
  let calls = 0;
  const failure = new EnrichmentError("lost", { code: ENRICHMENT_ERROR_CODES.providerHttp,
    provider: "crux", contractVersion: "crux-origin-metrics-v1", httpStatus: 0 });
  const first = await serviceHarness({ adapterOverrides: { fetchCruxOriginMetricsFn: async () => {
    calls += 1; throw failure; } } });
  assert.equal(calls, 1);
  const second = await serviceHarness({ artifactSeed: first.artifacts, sharedState: first.state,
    adapterOverrides: { fetchCruxOriginMetricsFn: async () => { calls += 1; throw failure; } } });
  assert.equal(calls, 1);
  const rest = [...second.artifacts.values()].find((value) => value.contractVersion === "provider-source-result-v1" &&
    value.source === "crux_rest");
  assert.equal(rest.state, "ambiguous");
});

test("BigQuery transient dry-run leaves the task nonterminal and retries on a later lease", async () => {
  const transient = new EnrichmentError("transient", { code: ENRICHMENT_ERROR_CODES.providerHttp,
    provider: "crux", contractVersion: "crux-popularity-v1", httpStatus: 503 });
  const first = await serviceHarness({ leaseAttempt: 1,
    adapterOverrides: { dryRunCruxPopularityFn: async () => { throw transient; } } });
  assert.equal(first.result.results[0].outcome, "busy");
  assert.equal([...first.artifacts.values()].some((value) => value.contractVersion ===
    "combined-traffic-crux-result-v1"), false);
  const second = await serviceHarness({ leaseAttempt: 2, artifactSeed: first.artifacts, sharedState: first.state });
  assert.equal(second.result.results[0].outcome, "recorded");
  assert.equal(second.calls.dry, 1);
});

test("BigQuery pre-month ambiguity on lease attempt four produces terminal latest-scope evidence", async () => {
  const output = await serviceHarness({ leaseAttempt: 4 });
  assert.equal(output.result.results[0].outcome, "recorded");
  assert.equal(output.calls.table, 0);
  assert.equal(output.calls.dry, 0);
  assert.equal(output.calls.live, 0);
  const source = [...output.artifacts.values()].find((value) =>
    value.contractVersion === "provider-source-result-v1" && value.source === "crux_bigquery");
  assert.equal(source.state, "ambiguous");
  assert.deepEqual(source.scopeStates, [{ scopeKey: "latest", state: "ambiguous" }]);
});

test("BigQuery post-month contract mismatch retains the resolved month scope", async () => {
  const output = await serviceHarness({ adapterOverrides: {
    fetchCruxPopularityForMonthFn: async ({ origins, datasetMonth, dryRun }) => ({
      datasetMonth,
      records: origins.map((origin) => ({ contractVersion: "crux-popularity-v1", origin,
        coverage: "unavailable", reason: "contract_mismatch", datasetMonth,
        fetchedAt: message.manifestProducedAt })),
      dryRunBytesProcessed: dryRun.bytesProcessed, bytesProcessed: 100,
      bytesBilled: 100, cacheHit: false
    })
  } });
  const source = [...output.artifacts.values()].find((value) =>
    value.contractVersion === "provider-source-result-v1" && value.source === "crux_bigquery");
  assert.equal(source.state, "contract_mismatch");
  assert.deepEqual(source.scopeStates, [{ scopeKey: "month:202607", state: "contract_mismatch" }]);
});

test("BigQuery attempt marker retries live only before the strict fifteen-minute boundary", () => {
  const marker = bigQueryAttemptBody({ runId: message.runId, generation: 1, scopeKey: "month:202607",
    batchInputFingerprint: "c".repeat(64), datasetMonth: "202607", dryRunBytesProcessed: 100,
    dispatchedAt: "2026-08-12T00:00:00.000Z" });
  assert.equal(reconcileBigQueryAttempt(marker, { now: "2026-08-12T00:14:59.999Z",
    scopeKey: "month:202607", maximumBytesBilled: 100 }).outcome, "retry");
  assert.equal(reconcileBigQueryAttempt(marker, { now: "2026-08-12T00:15:00.000Z",
    scopeKey: "month:202607", maximumBytesBilled: 100 }).outcome, "ambiguous");
  assert.throws(() => reconcileBigQueryAttempt(marker, { now: "2026-08-12T00:01:00.000Z",
    scopeKey: "month:202606", maximumBytesBilled: 100 }), (error) => error.code === "PIPELINE_INPUT_CONFLICT");
});

test("provider configuration mismatch remains retryable and calls no adapter", async () => {
  const result = await serviceHarness({ secretOverrides: { cruxBigQueryProjectId: "wrong-project" } });
  assert.equal(result.result.results[0].outcome, "retryable");
  assert.deepEqual(result.calls, { dataforseo: 0, rest: 0, table: 0, dry: 0, live: 0 });
});

test("terminal replay still releases the Run lease before exactly one recovery check", async () => {
  const { result, events } = await serviceHarness({ terminalReplay: true, triggers: ["m2", "m1"] });
  assert.deepEqual(result.results.map(({ outcome }) => outcome), ["replayed", "replayed"]);
  assert.ok(events.indexOf("release-run") < events.indexOf("send-check"));
  assert.equal(events.filter((event) => event === "send-check").length, 1);
});

test("terminal-stage duplicate releases the Run lease and checks final aggregation without providers", async () => {
  for (const stageState of ["ready", "aggregating"]) {
    const { result, events, calls } = await serviceHarness({ stageState, triggers: ["m2", "m1"] });
    assert.deepEqual(result.results.map(({ outcome }) => outcome), ["replayed", "replayed"]);
    assert.deepEqual(calls, { dataforseo: 0, rest: 0, table: 0, dry: 0, live: 0 });
    assert.ok(events.indexOf("release-run") < events.indexOf("send-check"));
    assert.equal(events.filter((event) => event === "send-check").length, 1);
  }
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
    assert.deepEqual(result.results, [{ recordId: "m1", terminal: false, outcome: "retryable" }]);
    if (events.includes("release-run")) assert.ok(events.indexOf("record-terminal") < events.indexOf("release-run"));
    if (events.includes("send-check")) assert.ok(events.indexOf("release-run") < events.indexOf("send-check"));
  });
}
