import { randomUUID } from "node:crypto";
import { fingerprintJson } from "../../src/aws-pipeline/core/canonical.js";
import { cancelAwsRunGeneration } from "../../src/aws-pipeline/services/recovery.js";
import { dispatchConfirmedQueries } from "../../src/aws-pipeline/services/confirmed-query-dispatcher.js";
import { processDiscoveryMessage } from "../../src/aws-pipeline/services/discovery-worker.js";
import { processDomainAggregation } from "../../src/aws-pipeline/services/domain-aggregator.js";
import { processLeadAggregation } from "../../src/aws-pipeline/services/lead-aggregator.js";
import { processTrafficBatch } from "../../src/aws-pipeline/services/traffic-worker.js";
import { processFinalAggregation } from "../../src/aws-pipeline/services/final-aggregator.js";
import { PipelineCoordinatorRepository } from "../../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository, trafficEnrichmentConfigSnapshot } from "../../src/prisma-run-repository.js";

const queues = { discovery: "q-discovery", domain: "q-domain", lead: "q-lead",
  leadCheck: "q-lead-check", traffic: "q-traffic", final: "q-final" };
const stoppedMonitor = () => ({ assertActive() {}, async renewNow() {}, async stop() {} });

export async function createAwsPipelineE2eHarness({ prisma, scenario, now }) {
  const runId = `run_e2e_${fingerprintJson({ boundary: scenario.boundary }).slice(0, 24)}`;
  const artifacts = scenario.artifacts || new Map();
  const dispatches = scenario.dispatches || [];
  const pending = scenario.pending || [];
  const providerCalls = scenario.providerCalls || { google: 0, browserless: 0, ai: 0, dataforseo: 0,
    rest: 0, bigQueryTable: 0, bigQueryDry: 0, bigQueryLive: 0 };
  const coordinator = new PipelineCoordinatorRepository(prisma);
  const repository = new PrismaRunRepository(prisma);
  const artifactStore = {
    async putImmutable(input) {
      const contentFingerprint = fingerprintJson(input.value);
      const prior = artifacts.get(input.key);
      if (prior && prior.contentFingerprint !== contentFingerprint) {
        const error = new Error("PIPELINE_ARTIFACT_CONFLICT"); error.code = "PIPELINE_ARTIFACT_CONFLICT"; throw error;
      }
      artifacts.set(input.key, { value: structuredClone(input.value), contentFingerprint,
        metadata: { contractVersion: input.contractVersion, runId: input.runId, stage: input.stage,
          generation: input.generation, itemId: input.itemId, inputFingerprint: input.inputFingerprint,
          producedAt: input.producedAt } });
      return { contentFingerprint };
    },
    async getValidated({ key, expected, schema }) {
      const stored = artifacts.get(key); if (!stored) throw new Error("missing artifact");
      for (const [name, value] of Object.entries(expected || {})) {
        const actual = name === "contentFingerprint" ? stored.contentFingerprint : stored.metadata[name];
        const normalizedActual = actual instanceof Date ? actual.toISOString() : actual;
        const normalizedValue = value instanceof Date ? value.toISOString() : value;
        if (String(normalizedActual) !== String(normalizedValue)) {
          const error = new Error(`PIPELINE_ARTIFACT_CONFLICT:${name}`);
          error.code = "PIPELINE_ARTIFACT_CONFLICT"; throw error;
        }
      }
      return { value: schema.parse(stored.value), contentFingerprint: stored.contentFingerprint };
    },
    async getOptionalValidated(input) {
      if (!artifacts.has(input.key)) return { outcome: "missing" };
      return { outcome: "found", ...await this.getValidated(input) };
    }
  };
  const dispatcher = {
    async sendMany(queue, messages) {
      const results = messages.map(({ itemId }, index) => ({ index, itemId, outcome: "sent" }));
      for (const message of messages) { pending.push({ queue, message }); dispatches.push({ queue, message }); }
      return { sentItemIds: messages.map(({ itemId }) => itemId), failedItemIds: [], results };
    },
    async sendOne(queue, message) {
      pending.push({ queue, message }); dispatches.push({ queue, message });
      return { sentItemIds: [message.itemId || message.stage], failedItemIds: [],
        results: [{ index: 0, itemId: message.itemId || message.stage, outcome: "sent" }] };
    }
  };
  const runtime = { coordinator, repository, artifactStore, dispatcher, config: {
    awsPipelineRecoveryAgeMs: 1, awsPipelineDiscoveryQueueUrl: queues.discovery,
    awsPipelineLeadQueueUrl: queues.lead, awsPipelineTrafficQueueUrl: queues.traffic,
    awsPipelineDomainAggregationQueueUrl: queues.domain,
    awsPipelineLeadAggregationQueueUrl: queues.leadCheck,
    awsPipelineFinalAggregationQueueUrl: queues.final } };

  if (!await prisma.run.findUnique({ where: { id: runId } })) {
    await prisma.run.create({ data: { id: runId, ownerId: `owner_${runId}`, state: "running", phase: "scraping",
      stage: "queued_query_validation", normalizedShopTypes: [], progress: {}, executionBackend: "aws",
      pipelineGeneration: 1, trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({}),
      awsProviderConfig: scenario.providerConfig, leaseOwner: "e2e", leaseToken: "e2e-token",
      leaseAcquiredAt: now, leaseExpiresAt: new Date(now.getTime() + 86400000), resultsAvailable: false } });
    const query = { id: "query_e2e_001", categoryIndex: 0, sequence: 0,
      query: "site:myshopify.com/products deterministic e2e", source: "generated",
      validationState: "valid", queryScore: 90, generationReason: "e2e", sourceUrls: [],
      categoryVocabulary: ["deterministic"], probeContractVersion: "google-probe-v2",
      probeFingerprint: "a".repeat(64), probeResults: [{ query: "site:myshopify.com/products deterministic e2e",
        rank: 1, url: "", title: "", snippet: "", rejectionReason: "invalid_url" }] };
    await dispatchConfirmedQueries({ runId, lease: { owner: "e2e", token: "e2e-token" }, generation: 1,
      confirmedRevision: 1, queriesConfirmedAt: now, awsProviderConfig: scenario.providerConfig,
      categories: [{ originalShopType: "Deterministic", shopType: "deterministic",
        businessQualifier: "brand" }], queries: [query], status: {} }, runtime);
  }

  async function drainOne(entry) {
    if (entry.queue === queues.discovery) return processDiscoveryMessage(entry.message, runtime);
    if (entry.queue === queues.domain) return processDomainAggregation(entry.message, runtime,
      { createLeaseMonitorFn: stoppedMonitor });
    if (entry.queue === queues.lead) throw new Error("zero-domain fixture unexpectedly created lead work");
    if (entry.queue === queues.leadCheck) return processLeadAggregation(entry.message, runtime,
      { createLeaseMonitorFn: stoppedMonitor });
    if (entry.queue === queues.traffic) return processTrafficBatch([{ recordId: randomUUID(), message: entry.message }], runtime);
    if (entry.queue === queues.final) return processFinalAggregation(entry.message, runtime,
      { createLeaseMonitorFn: stoppedMonitor });
    throw new Error("unknown queue");
  }

  return {
    async runUntilSettled() {
      let steps = 0;
      while (steps < 100) {
        const run = await prisma.run.findUnique({ where: { id: runId } });
        if (["completed", "cancelled", "failed"].includes(run.state)) {
          return { run, providerCalls, artifacts, dispatches };
        }
        const next = pending.shift(); if (!next) throw new Error("pipeline stalled before durable terminal state");
        await drainOne(next); steps += 1;
      }
      throw new Error("pipeline exceeded 100 durable actions");
    },
    async restart() { return createAwsPipelineE2eHarness({ prisma, scenario: { ...scenario,
      artifacts, dispatches, pending, providerCalls, providerConfig: scenario.providerConfig }, now }); },
    async cancel() { return cancelAwsRunGeneration({ runId, generation: 1,
      now: new Date(now.getTime() + 1) }, runtime); }
  };
}
