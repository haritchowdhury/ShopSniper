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
