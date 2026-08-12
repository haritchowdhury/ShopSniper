import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { processDomainAggregation } from "../src/aws-pipeline/services/domain-aggregator.js";
import { mergeRunStoreCandidatePayloads } from "../src/discovery-aggregation.js";
import { trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/aws-pipeline/v1/${name}`, import.meta.url)));

test("persisted candidate merge is reverse-order byte identical and removes exact duplicate evidence", async () => {
  const artifact = await load("per-query-discovery.valid.json");
  const candidate = artifact.stores[0].candidatePayload;
  const forward = mergeRunStoreCandidatePayloads([candidate, structuredClone(candidate)]);
  const reverse = mergeRunStoreCandidatePayloads([structuredClone(candidate), candidate]);
  assert.equal(canonicalJson(forward), canonicalJson(reverse));
  assert.equal(forward.length, 1);
  assert.equal(forward[0].occurrences.length, 1);
  assert.equal(forward[0].duplicateCount, 0);
});

test("persisted candidate merge joins custom and MyShopify aliases deterministically", async () => {
  const artifact = await load("per-query-discovery.valid.json");
  const first = structuredClone(artifact.stores[0].candidatePayload);
  const second = structuredClone(first);
  second.stableIdentity = first.resolvedDomain;
  second.myshopifyDomain = "";
  second.allowedHostnames = [first.resolvedDomain, first.myshopifyDomain];
  second.occurrences[0].query = "second deterministic occurrence";
  const merged = mergeRunStoreCandidatePayloads([second, first]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].stableIdentity, first.myshopifyDomain);
  assert.equal(merged[0].occurrences.length, 2);
  assert.equal(merged[0].duplicateCount, 1);
  assert.equal(merged[0].identityEvidence.mergedOccurrenceCount, 2);
});

test("persisted candidate merge rejects contradictory MyShopify identities", async () => {
  const artifact = await load("per-query-discovery.valid.json");
  const first = structuredClone(artifact.stores[0].candidatePayload);
  const second = structuredClone(first);
  second.myshopifyDomain = "other-fixture.myshopify.com";
  second.stableIdentity = second.myshopifyDomain;
  second.allowedHostnames = [first.resolvedDomain, second.myshopifyDomain];
  second.identityEvidence.stableHostname = second.myshopifyDomain;
  second.identityEvidence.observedHostnames = second.allowedHostnames;
  assert.throws(() => mergeRunStoreCandidatePayloads([first, second]),
    (error) => error.code === "PIPELINE_IDENTITY_MISMATCH");
});

test("domain aggregation rejects invalid locked test seams before ownership", async () => {
  await assert.rejects(
    processDomainAggregation({}, {}, { mergeCandidatesFn: null }),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT"
  );
  await assert.rejects(
    processDomainAggregation({}, {}, { createLeaseMonitorFn: "invalid" }),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT"
  );
});

test("zero-domain aggregation writes the deterministic manifest and advances an empty lead stage", async () => {
  const confirmed = await load("confirmed-query-manifest.valid.json");
  confirmed.queries = [];
  const validTraffic = trafficEnrichmentConfigSnapshot({});
  const manifestFingerprint = fingerprintJson(confirmed);
  const createdAt = new Date("2026-08-11T09:30:00.000Z");
  let domainArtifact;
  let zeroChecks = 0;
  const runtime = {
    config: { awsPipelineLeadQueueUrl: "lead", awsPipelineLeadAggregationQueueUrl: "lead-check" },
    coordinator: {
      async claimAggregator() { return { outcome: "owned", stage: { id: "stage_discovery" } }; },
      async renewAggregator() { return { expiresAt: new Date(Date.now() + 120000) }; },
      async getCompleteStage() { return { stage: { id: "stage_discovery", manifestS3Key: "manifest",
        manifestFingerprint, manifestProducedAt: createdAt, createdAt }, tasks: [] }; },
      async recordDispatch() { throw new Error("no lead dispatch expected"); }
    },
    artifactStore: {
      async getValidated() { return { value: confirmed, contentFingerprint: manifestFingerprint }; },
      async putImmutable(input) { domainArtifact = input.value; return { contentFingerprint: fingerprintJson(input.value) }; }
    },
    repository: {
      async readAwsReuseInputs() { return { profiles: [], trafficRows: [], latestCruxMonth: [],
        trafficSnapshot: validTraffic, awsProviderConfig: confirmed.awsProviderConfig }; },
      async publishAwsDomainCheckpoint(input) { assert.deepEqual(input.leadTasks, []);
        return { stage: {}, leadStage: { id: "lead_stage" }, dispatchItems: [] }; }
    },
    dispatcher: {
      async sendMany(_queue, messages) { assert.deepEqual(messages, []); return { sentItemIds: [], failedItemIds: [] }; },
      async sendOne() { zeroChecks += 1; return { sentItemIds: ["check"], failedItemIds: [] }; }
    }
  };
  assert.deepEqual(await processDomainAggregation({ version: 1, type: "aggregation.check",
    runId: confirmed.runId, stage: "discovery", generation: 1, reason: "zero_expected", attempt: 1 }, runtime),
  { terminal: true, outcome: "completed" });
  assert.deepEqual(domainArtifact.domainManifest.domains, []);
  assert.deepEqual(domainArtifact.workPlan.domains, []);
  assert.equal(zeroChecks, 1);
});

test("one-domain aggregation writes strict candidate and work-plan artifacts before checkpoint dispatch", async () => {
  const confirmed = await load("confirmed-query-manifest.valid.json");
  const discovery = await load("per-query-discovery.valid.json");
  confirmed.queries = [confirmed.queries.find((query) => query.id === discovery.queryId) || confirmed.queries[0]];
  confirmed.queries[0].id = discovery.queryId;
  confirmed.queries[0].sequence = 0;
  const manifestFingerprint = fingerprintJson(confirmed);
  const artifactFingerprint = fingerprintJson(discovery);
  const createdAt = new Date("2026-08-11T09:30:00.000Z");
  const task = { itemKey: discovery.queryId, state: "succeeded", inputFingerprint: "1".repeat(64),
    artifactS3Key: `query/${discovery.queryId}`, artifactFingerprint, createdAt };
  const writes = [];
  let checkpoint;
  const runtime = {
    config: { awsPipelineLeadQueueUrl: "lead", awsPipelineLeadAggregationQueueUrl: "lead-check" },
    coordinator: {
      async claimAggregator() { return { outcome: "owned", stage: { id: "stage_discovery" } }; },
      async renewAggregator() { return { expiresAt: new Date(Date.now() + 120000) }; },
      async getCompleteStage() { return { stage: { id: "stage_discovery", manifestS3Key: "manifest",
        manifestFingerprint, manifestProducedAt: createdAt, createdAt }, tasks: [task] }; },
      async recordDispatch({ itemKeys }) { assert.equal(itemKeys.length, 1); return { count: 1 }; }
    },
    artifactStore: {
      async getValidated({ key }) { return key === "manifest"
        ? { value: confirmed, contentFingerprint: manifestFingerprint }
        : { value: discovery, contentFingerprint: artifactFingerprint }; },
      async putImmutable(input) { writes.push(input); return { contentFingerprint: fingerprintJson(input.value) }; }
    },
    repository: {
      async readAwsReuseInputs() { return { profiles: [], trafficRows: [], latestCruxMonth: [],
        trafficSnapshot: trafficEnrichmentConfigSnapshot({}), awsProviderConfig: confirmed.awsProviderConfig }; },
      async publishAwsDomainCheckpoint(input) { checkpoint = input; return { stage: {},
        leadStage: { id: "lead_stage" }, dispatchItems: input.leadTasks }; }
    },
    dispatcher: {
      async sendMany(_queue, messages) { assert.equal(messages.length, 1);
        return { sentItemIds: [messages[0].itemId], failedItemIds: [] }; },
      async sendOne() { throw new Error("nonzero lead stage must not send zero check"); }
    }
  };
  assert.deepEqual(await processDomainAggregation({ version: 1, type: "aggregation.check",
    runId: confirmed.runId, stage: "discovery", generation: 1,
    reason: "terminal_task_recorded", attempt: 1 }, runtime), { terminal: true, outcome: "completed" });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].contractVersion, "domain-candidate-v1");
  assert.equal(writes[1].contractVersion, "domain-stage-manifest-v1");
  assert.equal(writes[1].value.workPlan.domains.length, 1);
  assert.equal(writes[1].value.workPlan.domains[0].needsLead, true);
  assert.equal(checkpoint.domains.length, 1);
  assert.equal(checkpoint.leadTasks.length, 1);
});
