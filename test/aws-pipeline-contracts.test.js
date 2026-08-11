import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { canonicalJson, fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import * as keys from "../src/aws-pipeline/core/keys.js";
import { safePipelineError } from "../src/aws-pipeline/contracts/errors.js";
import { parseAggregationCheckMessage, parseWorkMessage } from "../src/aws-pipeline/contracts/messages.js";
import {
  parseCombinedTrafficCruxResult, parseConfirmedQueryManifest, parseDomainManifest,
  parseDomainStageManifest, parseDomainWorkPlan, parseLeadResultArtifact,
  parseQueryDiscoveryArtifact
} from "../src/aws-pipeline/contracts/artifacts.js";
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

test("keys and deterministic IDs implement the locked grammar", () => {
  const runId = "run_fixture_payload_discovery_0001";
  assert.equal(keys.queryManifestKey(runId), `runs/${runId}/queries/manifest.json`);
  assert.equal(keys.queryArtifactKey(runId, "query_1"), `runs/${runId}/queries/query_1/domains.json`);
  assert.equal(keys.domainManifestKey(runId), `runs/${runId}/domains-manifest.json`);
  assert.equal(keys.candidateArtifactKey(runId, "shop_1"), `runs/${runId}/domains/shop_1/candidate.json`);
  assert.equal(keys.leadArtifactKey(runId, "shop_1"), `runs/${runId}/domains/shop_1/lead.json`);
  assert.match(keys.pipelineStageId(runId, "lead", 1), /^pipeline_stage_[A-Za-z0-9_-]{24}$/u);
  assert.match(keys.pipelineTaskId(keys.pipelineStageId(runId, "lead", 1), "shop_1"), /^pipeline_task_[A-Za-z0-9_-]{24}$/u);
  for (const invalid of ["../secret", "a/b", "a?token=x", "authorization_token"])
    rejects(() => keys.leadArtifactKey(runId, invalid), "PIPELINE_MESSAGE_INVALID");
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
});

test("messages are strict single-item reference envelopes", async () => {
  const { messages } = await fixture("sqs-envelopes.valid.json");
  parseWorkMessage(messages.discovery); parseWorkMessage(messages.lead); parseWorkMessage(messages.traffic);
  parseAggregationCheckMessage(messages.aggregateCheck);
  for (const mutation of [{ itemIds: ["x"] }, { providerBody: {} }, { html: "<html>" }, { credential: "x" }])
    rejects(() => parseWorkMessage({ ...messages.lead, ...mutation }), "PIPELINE_MESSAGE_INVALID");
  rejects(() => parseWorkMessage({ ...messages.lead, manifestFingerprint: "0".repeat(63) }), "PIPELINE_MESSAGE_INVALID");
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
