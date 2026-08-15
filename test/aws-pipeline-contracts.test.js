import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { awsDataForSeoRequestFingerprint, canonicalJson,
  fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import * as keys from "../src/aws-pipeline/core/keys.js";
import { safePipelineError } from "../src/aws-pipeline/contracts/errors.js";
import { parseAggregationCheckMessage, parseWorkMessage } from "../src/aws-pipeline/contracts/messages.js";
import {
  parseAiNormalizationAttemptArtifact, parseBrowserlessAttemptArtifact,
  parseCombinedTrafficCruxResult, parseConfirmedQueryManifest, parseDomainCandidateArtifact, parseDomainManifest,
  parseDomainStageManifest, parseDomainWorkPlan, parseGoogleProbeAttemptArtifact, parseGoogleProbeResultArtifact,
  parseLeadResultArtifact, parseProviderBatchArtifact, parseProviderBatchAttempt,
  parseProviderSourceArtifact, parseProviderSourceAttemptArtifact, parseQueryDiscoveryArtifact
} from "../src/aws-pipeline/contracts/artifacts.js";
import { parseAwsProviderConfig } from "../src/aws-pipeline/contracts/aws-provider-config.js";
import { parseTrafficRunConfig } from "../src/aws-pipeline/contracts/traffic-config.js";
import { createPipelineLeaseMonitor } from "../src/aws-pipeline/core/lease-monitor.js";
import { trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import {
  BROWSERLESS_FUNCTION_CONTRACT, buildBrowserlessFunctionRequest,
  parseBrowserlessFunctionEnvelope
} from "../src/aws-pipeline/contracts/browserless-function.js";

const root = new URL("./fixtures/aws-pipeline/v1/", import.meta.url);
const fixture = async (name) => JSON.parse(await fs.readFile(new URL(name, root), "utf8"));
const clone = (value) => structuredClone(value);
const rejects = (fn, code) => assert.throws(fn, (error) => error?.code === code && error.message === code);

test("canonical JSON is deterministic and rejects unsafe JavaScript values", () => {
  assert.equal(canonicalJson({ z: 1, a: [new Date("2026-08-11T00:00:00Z"), { b: 2, a: 1 }] }),
    '{"a":["2026-08-11T00:00:00.000Z",{"a":1,"b":2}],"z":1}');
  assert.equal(fingerprintJson({ b: 2, a: 1 }), fingerprintJson({ a: 1, b: 2 }));
  for (const value of [{ a: undefined }, { a: NaN }, { a: Infinity }, new Map()])
    rejects(() => canonicalJson(value), "PIPELINE_ARTIFACT_INVALID");
  const cycle = {}; cycle.self = cycle;
  rejects(() => canonicalJson(cycle), "PIPELINE_ARTIFACT_INVALID");
});

test("AWS DataForSEO paid identities are stable within a run and isolated across runs", () => {
  const providerRequestFingerprint = "a".repeat(64);
  const first = awsDataForSeoRequestFingerprint({ runId: "run_paid_owner_one", generation: 1,
    providerRequestFingerprint });
  assert.equal(first, awsDataForSeoRequestFingerprint({ runId: "run_paid_owner_one", generation: 1,
    providerRequestFingerprint }));
  assert.notEqual(first, awsDataForSeoRequestFingerprint({ runId: "run_paid_owner_two", generation: 1,
    providerRequestFingerprint }));
  assert.notEqual(first, awsDataForSeoRequestFingerprint({ runId: "run_paid_owner_one", generation: 2,
    providerRequestFingerprint }));
});

test("keys and deterministic IDs implement the locked grammar", () => {
  const runId = "run_fixture_payload_discovery_0001";
  assert.equal(keys.queryManifestKey(runId), `runs/${runId}/queries/manifest.json`);
  assert.equal(keys.queryArtifactKey(runId, "query_1"), `runs/${runId}/queries/query_1/domains.json`);
  assert.equal(keys.domainManifestKey(runId), `runs/${runId}/domains-manifest.json`);
  assert.equal(keys.candidateArtifactKey(runId, "shop_1"), `runs/${runId}/domains/shop_1/candidate.json`);
  assert.equal(keys.leadArtifactKey(runId, "shop_1"), `runs/${runId}/domains/shop_1/lead.json`);
  assert.equal(keys.googleProbeAttemptArtifactKey(runId, "a".repeat(64)), `runs/${runId}/query-probes/${"a".repeat(64)}.attempt.json`);
  assert.equal(keys.googleProbeResultArtifactKey(runId, "a".repeat(64)), `runs/${runId}/query-probes/${"a".repeat(64)}.result.json`);
  assert.equal(keys.providerSourceAttemptArtifactKey(runId, "shop_1", "crux-rest"), `runs/${runId}/domains/shop_1/traffic/crux-rest.attempt.json`);
  assert.equal(keys.providerBatchArtifactKey(runId, "dataforseo", "a".repeat(64)), `runs/${runId}/traffic-batches/dataforseo/${"a".repeat(64)}.json`);
  assert.equal(keys.providerBatchAttemptKey(runId, "crux-bigquery", "a".repeat(64)), `runs/${runId}/traffic-batches/crux-bigquery/${"a".repeat(64)}.attempt.json`);
  assert.equal(keys.browserlessAttemptArtifactKey(runId, "shop_1"), `runs/${runId}/domains/shop_1/browserless-attempt.json`);
  assert.equal(keys.aiNormalizationAttemptKey(runId, "shop_1"), `runs/${runId}/domains/shop_1/ai-normalization-attempt.json`);
  assert.match(keys.pipelineStageId(runId, "lead", 1), /^pipeline_stage_[A-Za-z0-9_-]{24}$/u);
  assert.match(keys.pipelineTaskId(keys.pipelineStageId(runId, "lead", 1), "shop_1"), /^pipeline_task_[A-Za-z0-9_-]{24}$/u);
  for (const invalid of ["../secret", "a/b", "a?token=x", "authorization_token"])
    rejects(() => keys.leadArtifactKey(runId, invalid), "PIPELINE_MESSAGE_INVALID");
  rejects(() => keys.providerBatchArtifactKey(runId, "crux-rest", "a".repeat(64)), "PIPELINE_MESSAGE_INVALID");
  rejects(() => keys.providerBatchAttemptKey(runId, "dataforseo", "a".repeat(64)), "PIPELINE_MESSAGE_INVALID");
});

test("all retained positive pipeline fixtures parse through production schemas", async () => {
  parseConfirmedQueryManifest(await fixture("confirmed-query-manifest.valid.json"));
  parseQueryDiscoveryArtifact(await fixture("per-query-discovery.valid.json"));
  const manifest = parseDomainManifest(await fixture("domain-manifest.valid.json"));
  const workPlan = parseDomainWorkPlan(await fixture("domain-work-plan.valid.json"));
  const lead = await fixture("lead-results.valid.json");
  parseLeadResultArtifact({ contractVersion: "lead-result-v1", result: lead.success });
  parseLeadResultArtifact({ contractVersion: "lead-result-v1", result: lead.failure });
  parseCombinedTrafficCruxResult(await fixture("combined-traffic-crux-result.valid.json"));
  parseDomainStageManifest({ contractVersion: "domain-stage-manifest-v1", domainManifest: manifest, workPlan });
  for (const [name, parse] of [
    ["domain-candidate.valid.json", parseDomainCandidateArtifact],
    ["google-probe-attempt.valid.json", parseGoogleProbeAttemptArtifact],
    ["google-probe-result.valid.json", parseGoogleProbeResultArtifact],
    ["provider-source-attempt.valid.json", parseProviderSourceAttemptArtifact],
    ["provider-batch-attempt.valid.json", parseProviderBatchAttempt],
    ["browserless-attempt.valid.json", parseBrowserlessAttemptArtifact],
    ["ai-normalization-attempt.valid.json", parseAiNormalizationAttemptArtifact],
    ["provider-batch-result.valid.json", parseProviderBatchArtifact]
  ]) assert.equal(canonicalJson(parse(await fixture(name))), canonicalJson(await fixture(name)));
  parseAwsProviderConfig(await fixture("aws-provider-config.valid.json"));
});

test("durable provider configuration contracts reject drift instead of defaulting", async () => {
  const provider = await fixture("aws-provider-config.valid.json");
  assert.deepEqual(parseAwsProviderConfig(provider), provider);
  for (const mutate of [
    (value) => { value.unknown = true; },
    (value) => { value.browserless.origin = "https://user:pass@example.test"; },
    (value) => { value.browserless.navigationTimeoutMs = 9000; },
    (value) => { value.queryValidation.generatedQueryCount = 101; },
    (value) => { value.googleSearch.engineIdFingerprint = "x"; },
    (value) => { value.aiNormalization.model = ""; }
  ]) {
    const changed = clone(provider); mutate(changed);
    rejects(() => parseAwsProviderConfig(changed), "PIPELINE_INPUT_CONFLICT");
  }
  const traffic = trafficEnrichmentConfigSnapshot({ dataForSeoEnrichmentEnabled: true, cruxEnrichmentEnabled: true });
  assert.deepEqual(parseTrafficRunConfig(traffic), traffic);
  for (const mutate of [
    (value) => { value.dataForSeo.scopes.reverse(); },
    (value) => { value.dataForSeo.estimatedCostPerTaskUsd = 0.025; },
    (value) => { value.crux.rest.concurrency = 11; },
    (value) => { value.crux.bigQuery.metricSet.reverse(); },
    (value) => { value.crux.bigQuery.maxBytesBilled = 0; }
  ]) {
    const changed = clone(traffic); mutate(changed);
    rejects(() => parseTrafficRunConfig(changed), "PIPELINE_INPUT_CONFLICT");
  }
});

test("attempt and batch contracts reject cross-field drift, ordering, duplicates and private fields", async () => {
  const ai = await fixture("ai-normalization-attempt.valid.json");
  rejects(() => parseAiNormalizationAttemptArtifact({ ...ai, clientRequestId: `openai-${"c".repeat(32)}` }), "PIPELINE_ARTIFACT_INVALID");
  const attempt = await fixture("provider-batch-attempt.valid.json");
  rejects(() => parseProviderBatchAttempt({ ...attempt, datasetMonth: "202606" }), "PIPELINE_ARTIFACT_INVALID");
  rejects(() => parseProviderBatchAttempt({ ...attempt, dryRunBytesProcessed: -1 }), "PIPELINE_ARTIFACT_INVALID");
  const probe = await fixture("google-probe-result.valid.json");
  const duplicate = clone(probe); duplicate.rejections[0].rank = 1;
  rejects(() => parseGoogleProbeResultArtifact(duplicate), "PIPELINE_ARTIFACT_INVALID");
  rejects(() => parseGoogleProbeResultArtifact({ ...probe, rawBody: "forbidden" }), "PIPELINE_ARTIFACT_INVALID");
  const manifest = await fixture("confirmed-query-manifest.valid.json");
  const unsorted = clone(manifest); unsorted.queries[0].probeResults.push({ ...unsorted.queries[0].probeResults[0], rank: 1 });
  rejects(() => parseConfirmedQueryManifest(unsorted), "PIPELINE_ARTIFACT_INVALID");
  const wrongQuery = clone(manifest); wrongQuery.queries[0].probeResults[0].query = "different";
  rejects(() => parseConfirmedQueryManifest(wrongQuery), "PIPELINE_ARTIFACT_INVALID");
  const source = { contractVersion: "provider-source-result-v1", runId: manifest.runId, generation: 1,
    shopId: "shop_13iOzZDK7joaSKKTmscbk00V", source: "dataforseo", state: "partial",
    scopeStates: [{ scopeKey: "a", state: "available" }, { scopeKey: "b", state: "unavailable" }],
    requestEvidence: ["a", "b"].map((scopeKey, index) => { const batchId = `${index + 1}`.repeat(64);
      return { scopeKey, disposition: "ledger", requestFingerprint: `${index + 3}`.repeat(64), targetCount: 1,
        ledgerState: "succeeded", batchId, batchArtifactKey: keys.providerBatchArtifactKey(manifest.runId,
          "dataforseo", batchId), batchArtifactFingerprint: `${index + 5}`.repeat(64) }; }),
    cacheRows: [], leadTrafficRows: [], summary: {}, diagnostics: [] };
  parseProviderSourceArtifact(source);
  rejects(() => parseProviderSourceArtifact({ ...source, source: "crux_rest" }), "PIPELINE_ARTIFACT_INVALID");
  const missingEvidence = clone(source); delete missingEvidence.requestEvidence;
  rejects(() => parseProviderSourceArtifact(missingEvidence), "PIPELINE_ARTIFACT_INVALID");
  const duplicateEvidence = clone(source); duplicateEvidence.requestEvidence[1].scopeKey = "a";
  rejects(() => parseProviderSourceArtifact(duplicateEvidence), "PIPELINE_ARTIFACT_INVALID");
  const wrongBatchKey = clone(source); wrongBatchKey.requestEvidence[0].batchArtifactKey = "runs/wrong.json";
  rejects(() => parseProviderSourceArtifact(wrongBatchKey), "PIPELINE_ARTIFACT_INVALID");
  const privateEvidence = clone(source); privateEvidence.requestEvidence[0].targets = ["private.example"];
  rejects(() => parseProviderSourceArtifact(privateEvidence), "PIPELINE_ARTIFACT_INVALID");
  const paidContractMismatch = clone(source);
  paidContractMismatch.state = "contract_mismatch";
  paidContractMismatch.scopeStates = paidContractMismatch.scopeStates
    .map(({ scopeKey }) => ({ scopeKey, state: "contract_mismatch" }));
  paidContractMismatch.requestEvidence = paidContractMismatch.requestEvidence
    .map(({ scopeKey, requestFingerprint, targetCount }) => ({ scopeKey, disposition: "ledger",
      requestFingerprint, targetCount, ledgerState: "ambiguous" }));
  parseProviderSourceArtifact(paidContractMismatch);
  const cruxEvidence = clone(source); cruxEvidence.source = "crux_rest"; cruxEvidence.state = "available";
  cruxEvidence.scopeStates = [{ scopeKey: "current", state: "available" }];
  cruxEvidence.requestEvidence = [source.requestEvidence[0]];
  rejects(() => parseProviderSourceArtifact(cruxEvidence), "PIPELINE_ARTIFACT_INVALID");
  const duplicateScope = clone(source); duplicateScope.scopeStates[1].scopeKey = "a";
  rejects(() => parseProviderSourceArtifact(duplicateScope), "PIPELINE_ARTIFACT_INVALID");
  const traffic = await fixture("combined-traffic-crux-result.valid.json");
  const invalidPartial = clone(traffic); invalidPartial.components.cruxRest.state = "partial";
  rejects(() => parseCombinedTrafficCruxResult(invalidPartial), "PIPELINE_ARTIFACT_INVALID");
});

test("lease monitor serializes renewals, captures loss synchronously and cleans timers", async () => {
  let callback;
  let cleared = 0;
  let active = 0;
  let maxActive = 0;
  let release;
  const renewal = new Promise((resolve) => { release = resolve; });
  const monitor = createPipelineLeaseMonitor({ intervalMs: 20000, now: () => new Date("2026-08-11T00:00:00Z"),
    setIntervalFn(fn, ms) { assert.equal(ms, 20000); callback = fn; return 7; },
    clearIntervalFn(idValue) { assert.equal(idValue, 7); cleared += 1; },
    async renew() { active += 1; maxActive = Math.max(maxActive, active); await renewal; active -= 1; }
  });
  callback(); callback(); callback();
  await Promise.resolve();
  assert.equal(maxActive, 1);
  release();
  await monitor.stop();
  assert.equal(cleared, 1);

  let lossCallback;
  const loss = Object.assign(new Error("PIPELINE_LEASE_LOST"), { code: "PIPELINE_LEASE_LOST" });
  const lost = createPipelineLeaseMonitor({ intervalMs: 40000, renew: async () => { throw loss; },
    setIntervalFn(fn) { lossCallback = fn; return 8; }, clearIntervalFn() {} });
  lossCallback();
  await assert.rejects(lost.stop(), (error) => error === loss);
  assert.throws(() => lost.assertActive(), (error) => error === loss);
  rejects(() => createPipelineLeaseMonitor({ renew() {}, intervalMs: 30000 }), "PIPELINE_INPUT_CONFLICT");
});

test("messages are strict single-item reference envelopes", async () => {
  const { messages, encodedBytes } = await fixture("sqs-envelopes.valid.json");
  for (const name of ["discovery", "lead", "traffic"]) {
    const parsed = parseWorkMessage(messages[name]);
    assert.equal(parsed.manifestProducedAt, "2026-08-11T00:00:00.000Z");
    assert.equal(Buffer.byteLength(canonicalJson(parsed)), encodedBytes[name]);
  }
  parseAggregationCheckMessage(messages.aggregateCheck);
  assert.equal(Buffer.byteLength(canonicalJson(messages.aggregateCheck)), encodedBytes.aggregateCheck);
  for (const mutation of [{ itemIds: ["x"] }, { providerBody: {} }, { html: "<html>" }, { credential: "x" }])
    rejects(() => parseWorkMessage({ ...messages.lead, ...mutation }), "PIPELINE_MESSAGE_INVALID");
  rejects(() => parseWorkMessage({ ...messages.lead, manifestFingerprint: "0".repeat(63) }), "PIPELINE_MESSAGE_INVALID");
  for (const invalid of [undefined, "not-a-timestamp", 1723334400000, "2026-08-11T05:30:00+05:30"])
    rejects(() => parseWorkMessage({ ...messages.lead, manifestProducedAt: invalid }), "PIPELINE_MESSAGE_INVALID");
  rejects(() => parseWorkMessage({ ...messages.lead, producedAt: messages.lead.manifestProducedAt }), "PIPELINE_MESSAGE_INVALID");
});

test("artifact bounds, strictness, identities and combined manifest reconcile", async () => {
  const query = await fixture("per-query-discovery.valid.json");
  rejects(() => parseQueryDiscoveryArtifact({ ...query, unknown: true }), "PIPELINE_ARTIFACT_INVALID");
  const missing = clone(query); delete missing.runId;
  rejects(() => parseQueryDiscoveryArtifact(missing), "PIPELINE_ARTIFACT_INVALID");
  const over = clone(query); over.stores = Array(1001).fill(query.stores[0]);
  rejects(() => parseQueryDiscoveryArtifact(over), "PIPELINE_ARTIFACT_INVALID");
  const identity = clone(query); identity.stores[0].identity.stableKey = "other.example";
  rejects(() => parseQueryDiscoveryArtifact(identity), "PIPELINE_ARTIFACT_INVALID");
  const manifest = await fixture("domain-manifest.valid.json");
  const plan = await fixture("domain-work-plan.valid.json");
  for (const mutate of [
    (value) => { value.workPlan.generation = 2; },
    (value) => { value.workPlan.domains[0].runStoreId = "other"; },
    (value) => { value.workPlan.domains[0].candidateKey = value.workPlan.domains[0].candidateKey.replace("candidate", "other"); },
    (value) => { value.workPlan.domains[0].candidateFingerprint = "f".repeat(64); },
    (value) => { value.workPlan.domains[0].needsCrux = false; }
  ]) {
    const combined = { contractVersion: "domain-stage-manifest-v1", domainManifest: clone(manifest), workPlan: clone(plan) };
    mutate(combined);
    rejects(() => parseDomainStageManifest(combined), "PIPELINE_INPUT_CONFLICT");
  }
});

test("provider bodies, credential URLs and persisted Browserless HTML are rejected safely", async () => {
  const traffic = await fixture("combined-traffic-crux-result.valid.json");
  rejects(() => parseCombinedTrafficCruxResult({ ...traffic, providerBody: { raw: true } }), "PIPELINE_ARTIFACT_INVALID");
  const credential = clone(traffic); credential.components.dataforseo.artifactKey = "https://user:pass@example.test/raw";
  rejects(() => parseCombinedTrafficCruxResult(credential), "PIPELINE_ARTIFACT_INVALID");
  const leadFixture = await fixture("lead-results.valid.json");
  const lead = clone(leadFixture.success); lead.pageDiagnostics.html = "<html>forbidden</html>";
  rejects(() => parseLeadResultArtifact({ contractVersion: "lead-result-v1", result: lead }), "PIPELINE_ARTIFACT_INVALID");
  assert.deepEqual(safePipelineError(new Error("https://user:pass@example.test?<html>")),
    { code: "PIPELINE_ARTIFACT_INVALID", message: "PIPELINE_ARTIFACT_INVALID" });
});

test("Browserless request and transient response enforce sequential session limits", () => {
  const request = buildBrowserlessFunctionRequest({ pages: [{ url: "https://fixture.example/contact", purpose: "contact" }],
    allowedHostnames: ["fixture.example"], stopOnSufficientEvidence: true });
  assert.equal(request.context.navigationTimeoutMs, 8000);
  const envelope = { type: "application/json", data: { contractVersion: BROWSERLESS_FUNCTION_CONTRACT,
    activeSessionCount: 1, pageLimit: 1, successes: 1, earlyStopReason: "sufficient_evidence", durationMs: 50,
    cleanup: "automatic_function_api", results: [{ inputIndex: 0, disposition: "rendered", status: 200,
      finalPath: "/contact", durationMs: 50, html: "<main>transient</main>" }] } };
  parseBrowserlessFunctionEnvelope(envelope);
  rejects(() => parseBrowserlessFunctionEnvelope({ ...envelope, data: { ...envelope.data, durationMs: 45001 } }),
    "PIPELINE_CONTRACT_DRIFT");
  rejects(() => buildBrowserlessFunctionRequest({ pages: [{ url: "https://user:pass@fixture.example/", purpose: "x" }],
    allowedHostnames: ["fixture.example"] }), "PIPELINE_MESSAGE_INVALID");
});
