import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { processLeadAggregation } from "../src/aws-pipeline/services/lead-aggregator.js";

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/aws-pipeline/v1/${name}`, import.meta.url)));

test("G10 zero/all-reused lead checkpoint registers no traffic work and sends the final zero check", async () => {
  const manifest = await load("domain-manifest.valid.json");
  const plan = await load("domain-work-plan.valid.json");
  manifest.domains = [];
  plan.domains = [];
  plan.evaluatedAt = "2026-08-11T09:30:00.000Z";
  const combined = { contractVersion: "domain-stage-manifest-v1", domainManifest: manifest, workPlan: plan };
  const manifestFingerprint = fingerprintJson(combined);
  let checkpoint;
  let zeroChecks = 0;
  const runtime = {
    config: { awsPipelineTrafficQueueUrl: "traffic", awsPipelineFinalAggregationQueueUrl: "final" },
    coordinator: {
      async claimAggregator() { return { outcome: "owned", stage: { id: "lead_stage" } }; },
      async renewAggregator() { return { expiresAt: new Date(Date.now() + 240000) }; },
      async getCompleteStage() { return { stage: { id: "lead_stage", manifestS3Key: plan.domainManifestKey,
        manifestFingerprint, manifestProducedAt: new Date(plan.evaluatedAt) }, tasks: [] }; },
      async recordDispatch() { throw new Error("no traffic dispatch expected"); }
    },
    artifactStore: { async getValidated() { return { value: combined, contentFingerprint: manifestFingerprint }; } },
    repository: {
      async readAwsReusableProfiles(input) { assert.deepEqual(input.selections, []); return { profiles: [] }; },
      async publishAwsLeadCheckpoint(input) { checkpoint = input; return { stage: {}, trafficStage: { id: "traffic_stage" },
        dispatchItems: [], summary: { total: 0, qualified: 0, rejected: 0, failed: 0 } }; }
    },
    dispatcher: {
      async sendMany(_queue, messages) { assert.deepEqual(messages, []); return { sentItemIds: [], failedItemIds: [] }; },
      async sendOne() { zeroChecks += 1; return { sentItemIds: ["zero"], failedItemIds: [] }; }
    }
  };
  const result = await processLeadAggregation({ version: 1, type: "aggregation.check",
    runId: manifest.runId, stage: "lead", generation: manifest.generation,
    reason: "zero_expected", attempt: 1 }, runtime);
  assert.equal(result.outcome, "completed");
  assert.deepEqual(checkpoint.outcomes, []);
  assert.deepEqual(checkpoint.trafficDomains, []);
  assert.equal(zeroChecks, 1);
});

test("G10 returns early when another aggregator owns the lead stage", async () => {
  const runtime = { coordinator: { async claimAggregator() { return { outcome: "busy" }; } } };
  assert.deepEqual(await processLeadAggregation({ runId: "run_abcdefghijklmnop", generation: 1 }, runtime),
    { terminal: true, outcome: "busy" });
});

test("G10 materializes one new terminal artifact, registers traffic, and preserves partial dispatch", async () => {
  const manifest = await load("domain-manifest.valid.json");
  const plan = await load("domain-work-plan.valid.json");
  const fixture = await load("lead-results.valid.json");
  const combined = { contractVersion: "domain-stage-manifest-v1", domainManifest: manifest, workPlan: plan };
  const manifestFingerprint = fingerprintJson(combined);
  const resultArtifact = { contractVersion: "lead-result-v1", result: fixture.success };
  const artifactFingerprint = fingerprintJson(resultArtifact);
  const task = { id: "task_g10", itemKey: plan.domains[0].shopId, state: "succeeded",
    inputFingerprint: "b".repeat(64), artifactS3Key: "lead-result", artifactFingerprint,
    createdAt: new Date(plan.evaluatedAt) };
  let checkpoint;
  let recorded = false;
  const runtime = {
    config: { awsPipelineTrafficQueueUrl: "traffic", awsPipelineFinalAggregationQueueUrl: "final" },
    coordinator: {
      async claimAggregator() { return { outcome: "owned", stage: { id: "lead_stage" } }; },
      async renewAggregator() { return { expiresAt: new Date(Date.now() + 120000) }; },
      async getCompleteStage() { return { stage: { id: "lead_stage", manifestS3Key: plan.domainManifestKey,
        manifestFingerprint, manifestProducedAt: new Date(plan.evaluatedAt) }, tasks: [task] }; },
      async recordDispatch() { recorded = true; }
    },
    artifactStore: { async getValidated({ key }) { return key === "lead-result"
      ? { value: resultArtifact, contentFingerprint: artifactFingerprint }
      : { value: combined, contentFingerprint: manifestFingerprint }; } },
    repository: {
      async readAwsReusableProfiles(input) { assert.deepEqual(input.selections, []); return { profiles: [] }; },
      async publishAwsLeadCheckpoint(input) { checkpoint = input; return { stage: {}, trafficStage: { id: "traffic_stage" },
        dispatchItems: [{ itemKey: task.itemKey, inputFingerprint: "c".repeat(64) }],
        summary: { total: 1, qualified: 1, rejected: 0, failed: 0 } }; }
    },
    dispatcher: {
      async sendMany(_queue, messages) { assert.equal(messages[0].type, "traffic.domain");
        return { sentItemIds: [], failedItemIds: [task.itemKey] }; },
      async sendOne() { throw new Error("nonzero traffic work cannot send zero check"); }
    }
  };
  const result = await processLeadAggregation({ version: 1, type: "aggregation.check", runId: manifest.runId,
    stage: "lead", generation: 1, reason: "terminal_task_recorded", attempt: 1 }, runtime);
  assert.equal(checkpoint.outcomes[0].profileReusable, false);
  assert.equal(checkpoint.outcomes[0].sourceTaskId, task.id);
  assert.equal(checkpoint.trafficDomains.length, 1);
  assert.deepEqual(result.failedItemIds, [task.itemKey]);
  assert.equal(recorded, false);
});
