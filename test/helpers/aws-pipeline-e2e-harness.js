import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fingerprintJson } from "../../src/aws-pipeline/core/canonical.js";
import { cancelAwsRunGeneration, recoverPipelineWork } from "../../src/aws-pipeline/services/recovery.js";
import { dispatchConfirmedQueries } from "../../src/aws-pipeline/services/confirmed-query-dispatcher.js";
import { processDiscoveryMessage } from "../../src/aws-pipeline/services/discovery-worker.js";
import { processDomainAggregation } from "../../src/aws-pipeline/services/domain-aggregator.js";
import { processLeadAggregation } from "../../src/aws-pipeline/services/lead-aggregator.js";
import { processLeadMessage } from "../../src/aws-pipeline/services/lead-worker.js";
import { processTrafficBatch } from "../../src/aws-pipeline/services/traffic-worker.js";
import { processFinalAggregation } from "../../src/aws-pipeline/services/final-aggregator.js";
import { buildDataForSeoRequest } from "../../src/enrichment/dataforseo/request.js";
import { PipelineCoordinatorRepository } from "../../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository, trafficEnrichmentConfigSnapshot } from "../../src/prisma-run-repository.js";
import { shopWorkId } from "../../src/shop-persistence-contract.js";

const queues = { discovery: "q-discovery", domain: "q-domain", lead: "q-lead",
  leadCheck: "q-lead-check", traffic: "q-traffic", final: "q-final" };
const stoppedMonitor = () => ({ assertActive() {}, async renewNow() {}, async stop() {} });
const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/aws-pipeline/v1/${name}`,
  import.meta.url), "utf8"));

export async function createAwsPipelineE2eHarness({ prisma, scenario, now }) {
  const runId = `run_e2e_${fingerprintJson({ boundary: scenario.boundary,
    variant: scenario.variant || "default" }).slice(0, 24)}`;
  const artifacts = scenario.artifacts || new Map();
  const dispatches = scenario.dispatches || [];
  const pending = scenario.pending || [];
  const providerCalls = scenario.providerCalls || { google: 0, browserless: 0, ai: 0, dataforseo: 0,
    rest: 0, bigQueryTable: 0, bigQueryDry: 0, bigQueryLive: 0 };
  const clock = scenario.clock || { value: new Date(now) };
  const fault = scenario.fault || { injected: false, restarts: 0, boundary: scenario.boundary };
  const inject = (boundary) => {
    if (fault.boundary !== boundary || fault.injected) return false;
    fault.injected = true; return true;
  };
  const withClock = (args) => args.map((value, index) =>
    index === args.length - 1 && value instanceof Date ? clock.value : value);
  const pipelineTime = scenario.pipelineTime || { value: now.toISOString() };
  const coordinatorBase = new PipelineCoordinatorRepository(prisma);
  const coordinator = new Proxy(coordinatorBase, { get(target, name) {
    if (name !== "recordTerminal") { const value = target[name]; return typeof value === "function"
      ? (...args) => value.apply(target, withClock(args)) : value; }
    return async (input, valueNow) => {
      const trafficTerminal = input.artifactS3Key?.endsWith("/traffic-crux.json");
      if (trafficTerminal && inject("after_s3_before_first_neon_terminal"))
        throw new Error("injected:after_s3_before_first_neon_terminal");
      const result = await target.recordTerminal(input, clock.value);
      if (trafficTerminal && inject("after_first_neon_terminal_before_aggregation_check_send"))
        throw new Error("injected:after_first_neon_terminal_before_aggregation_check_send");
      return result;
    };
  } });
  const repositoryBase = new PrismaRunRepository(prisma);
  const repository = new Proxy(repositoryBase, { get(target, name) {
    if (name === "publishAwsFinalResults") return async (input, valueNow) => {
      const result = await target.publishAwsFinalResults(input, clock.value, { afterStep(step) {
        if (step === "before_run_visibility" && inject("final_publication_before_results_available"))
          throw new Error("injected:final_publication_before_results_available");
      } });
      if (inject("final_publication_after_results_available"))
        throw new Error("injected:final_publication_after_results_available");
      return result;
    };
    const value = target[name]; return typeof value === "function"
      ? (...args) => value.apply(target, withClock(args)) : value;
  } });
  const artifactStore = {
    async putImmutable(input) {
      const value = input.schema.parse(input.value);
      const contentFingerprint = fingerprintJson(value);
      const durableWriteBoundary = input.contractVersion === "domain-stage-manifest-v1";
      if (durableWriteBoundary && inject("before_s3_write")) throw new Error("injected:before_s3_write");
      if (fault.boundary === "conditional_s3_conflict" && !fault.injected &&
          input.contractVersion === "provider-source-result-v1") {
        fault.injected = true;
        artifacts.set(input.key, { value: { conflicting: true }, contentFingerprint: "f".repeat(64),
          metadata: { contractVersion: input.contractVersion, runId: input.runId, stage: input.stage,
            generation: input.generation, itemId: input.itemId, inputFingerprint: input.inputFingerprint,
            producedAt: input.producedAt } });
      }
      const prior = artifacts.get(input.key);
      if (prior && prior.contentFingerprint !== contentFingerprint) {
        const error = new Error("PIPELINE_ARTIFACT_CONFLICT"); error.code = "PIPELINE_ARTIFACT_CONFLICT"; throw error;
      }
      artifacts.set(input.key, { value: structuredClone(value), contentFingerprint,
        metadata: { contractVersion: input.contractVersion, runId: input.runId, stage: input.stage,
          generation: input.generation, itemId: input.itemId, inputFingerprint: input.inputFingerprint,
          producedAt: input.producedAt } });
      if (durableWriteBoundary && inject("during_s3_write_or_lost_write_response"))
        throw new Error("injected:during_s3_write_or_lost_write_response");
      return { contentFingerprint };
    },
    async getValidated({ key, expected, schema }) {
      const stored = artifacts.get(key); if (!stored) throw new Error("missing artifact");
      if (stored.value?.contractVersion === "domain-stage-manifest-v1")
        pipelineTime.value = stored.value.workPlan.evaluatedAt;
      for (const [name, value] of Object.entries(expected || {})) {
        if (value === undefined) continue;
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
      if (queue !== queues.discovery && inject("partial_sqs_batch_failure")) {
        if (messages.length < 2) throw new Error("partial batch scenario requires two task messages");
        pending.push({ queue, message: messages[0] }); dispatches.push({ queue, message: messages[0] });
        return { sentItemIds: [messages[0].itemId], failedItemIds: messages.slice(1).map(({ itemId }) => itemId),
          results: messages.map(({ itemId }, index) => ({ index, itemId, outcome: index ? "failed" : "sent" })) };
      }
      const results = messages.map(({ itemId }, index) => ({ index, itemId, outcome: "sent" }));
      for (const message of messages) { pending.push({ queue, message }); dispatches.push({ queue, message }); }
      if (queue === queues.traffic && inject("duplicate_delayed_or_reversed_delivery")) {
        for (const message of [...messages].reverse()) pending.unshift({ queue, message: structuredClone(message) });
      }
      return { sentItemIds: messages.map(({ itemId }) => itemId), failedItemIds: [], results };
    },
    async sendOne(queue, message) {
      pending.push({ queue, message }); dispatches.push({ queue, message });
      if (inject("after_aggregation_check_send_before_sqs_ack"))
        pending.push({ queue, message: structuredClone(message) });
      return { sentItemIds: [message.itemId || message.stage], failedItemIds: [],
        results: [{ index: 0, itemId: message.itemId || message.stage, outcome: "sent" }] };
    }
  };
  const runtime = { coordinator, repository, artifactStore, dispatcher, config: {
    awsPipelineRecoveryAgeMs: 1, awsPipelineDiscoveryQueueUrl: queues.discovery,
    awsPipelineLeadQueueUrl: queues.lead, awsPipelineTrafficQueueUrl: queues.traffic,
    awsPipelineDomainAggregationQueueUrl: queues.domain,
    awsPipelineLeadAggregationQueueUrl: queues.leadCheck,
    awsPipelineFinalAggregationQueueUrl: queues.final }, secrets: {
    dataForSeoLogin: "fixture", dataForSeoPassword: "fixture", cruxApiKey: "fixture",
    cruxBigQueryProjectId: "fixture-project", googleApplicationCredentials: "fixture",
    browserlessToken: "", browserlessFallbackToken: "", openaiApiKey: "" } };

  if (!await prisma.run.findUnique({ where: { id: runId } })) {
    await prisma.run.create({ data: { id: runId, ownerId: `owner_${runId}`, state: "running", phase: "scraping",
      stage: "queued_query_validation", normalizedShopTypes: [], progress: {}, executionBackend: "aws",
      pipelineGeneration: 1, trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({
        dataForSeoEnrichmentEnabled: scenario.variant !== "all_reused",
        cruxEnrichmentEnabled: scenario.variant !== "all_reused",
        dataForSeoMaxCostPerRunUsd: 0.024 }),
      awsProviderConfig: scenario.providerConfig, leaseOwner: "e2e", leaseToken: `lease_${runId}`,
      leaseAcquiredAt: now, leaseExpiresAt: new Date(now.getTime() + 86400000), resultsAvailable: false } });
    const query = { id: "query_e2e_001", categoryIndex: 0, sequence: 0,
      query: "site:myshopify.com/products deterministic e2e", source: "generated",
      validationState: "valid", queryScore: 90, generationReason: "e2e", sourceUrls: [],
      categoryVocabulary: ["deterministic"], probeContractVersion: "google-probe-v2",
      probeFingerprint: "a".repeat(64), probeResults: [{ query: "site:myshopify.com/products deterministic e2e",
        rank: 1, url: "", title: "", snippet: "", rejectionReason: "invalid_url" }] };
    const multipleTasks = ["duplicate_delayed_or_reversed_delivery", "partial_sqs_batch_failure"]
      .includes(scenario.boundary);
    const secondQueryText = "site:myshopify.com/products deterministic e2e second";
    const secondQuery = { ...query, id: "query_e2e_002", sequence: 1, query: secondQueryText,
      probeFingerprint: "b".repeat(64), probeResults: query.probeResults.map((probe) =>
        ({ ...probe, query: secondQueryText })) };
    const queries = scenario.variant === "zero_query" ? [] : multipleTasks ? [query, secondQuery] : [query];
    await dispatchConfirmedQueries({ runId, lease: { owner: "e2e", token: `lease_${runId}` }, generation: 1,
      confirmedRevision: 1, queriesConfirmedAt: now, awsProviderConfig: scenario.providerConfig,
      categories: [{ originalShopType: "Deterministic", shopType: "deterministic",
        businessQualifier: "brand" }], queries, status: {} }, runtime);
    if (["zero_query", "all_reused"].includes(scenario.variant)) {
      fault.injected = true;
    }
    if (scenario.variant === "zero_query") {
      await prisma.run.update({ where: { id: runId }, data: { leaseOwner: null, leaseToken: null,
        leaseAcquiredAt: null, leaseExpiresAt: null } });
    } else {
    const discoveryStage = await prisma.pipelineStage.findFirst({ where: { runId, stage: "discovery" } });
    for (const [index, confirmedQuery] of queries.entries()) {
      const discoveryTask = await prisma.pipelineTask.findFirst({ where: {
        stageId: discoveryStage.id, itemKey: confirmedQuery.id } });
      let discovery = await fixture("per-query-discovery.valid.json");
      if (index) discovery = JSON.parse(JSON.stringify(discovery).replaceAll("fixture", "secondfixture"));
      discovery.runId = runId; discovery.generation = 1; discovery.queryId = confirmedQuery.id;
      const discoveryKey = `runs/${runId}/queries/${confirmedQuery.id}/domains.json`;
      artifacts.set(discoveryKey, { value: discovery, contentFingerprint: fingerprintJson(discovery), metadata: {
        contractVersion: "query-discovery-artifact-v1", runId, stage: "discovery", generation: 1,
        itemId: confirmedQuery.id, inputFingerprint: discoveryTask.inputFingerprint,
        producedAt: discoveryTask.createdAt.toISOString() } });
    }
    await prisma.run.update({ where: { id: runId }, data: { leaseOwner: null, leaseToken: null,
      leaseAcquiredAt: null, leaseExpiresAt: null } });
    }
  }

  async function preloadLead(message) {
    const stage = await prisma.pipelineStage.findFirst({ where: { runId, stage: "lead" } });
    const task = await prisma.pipelineTask.findFirst({ where: { stageId: stage.id, itemKey: message.itemId } });
    const runStore = await prisma.runStore.findFirst({ where: { runId, shopId: message.itemId } });
    await prisma.shopWork.upsert({ where: { shopId_workType_scopeKey: { shopId: message.itemId,
      workType: "lead_discovery", scopeKey: "current" } }, create: {
      id: shopWorkId(message.itemId, "lead_discovery", "current"), shopId: message.itemId,
      workType: "lead_discovery", scopeKey: "current", state: "processing", processingRunId: runId,
      processingPipelineTaskId: task.id, startedAt: clock.value }, update: {} });
    let source = (await fixture("lead-results.valid.json")).success;
    if (runStore.candidatePayload?.stableIdentity === "secondfixture.myshopify.com")
      source = JSON.parse(JSON.stringify(source).replaceAll("fixture", "secondfixture"));
    const value = { contractVersion: "lead-result-v1", result: { ...source, runId, generation: 1,
      shopId: message.itemId, runStoreId: runStore.id } };
    const key = `runs/${runId}/domains/${message.itemId}/lead.json`;
    artifacts.set(key, { value, contentFingerprint: fingerprintJson(value), metadata: {
      contractVersion: "lead-result-v1", runId, stage: "lead", generation: 1,
      itemId: message.itemId, inputFingerprint: task.inputFingerprint,
      producedAt: task.createdAt.toISOString() } });
  }

  const trafficDependencies = {
    createLeaseMonitorFn: stoppedMonitor,
    buildDataForSeoRequestFn: (input) => buildDataForSeoRequest(input),
    fetchDataForSeoTrafficFn: async ({ targets, scope }) => { providerCalls.dataforseo += 1;
      if (inject("external_success_response_lost")) throw new Error("injected:external_success_response_lost");
      return {
      records: targets.map((target) => ({ state: "available", value: {
        contractVersion: "dataforseo-traffic-v1", target,
        scope, languageScope: "all_available",
        metrics: { organic: { etv: 10, count: 1 }, paid: { etv: 0, count: 0 },
          featuredSnippet: { etv: 0, count: 0 }, localPack: { etv: 0, count: 0 } },
        fetchedAt: pipelineTime.value } })), cost: { providerReported: 0.01 } }; },
    fetchCruxOriginMetricsFn: async ({ origin }) => { providerCalls.rest += 1; return {
      contractVersion: "crux-origin-metrics-v1", origin, coverage: "available",
      metrics: { largestContentfulPaintP75Ms: 1000 },
      collectionPeriod: { firstDate: "2026-07-01", lastDate: "2026-07-28" }, fetchedAt: pipelineTime.value }; },
    fetchCruxLatestDatasetMonthFn: async () => { providerCalls.bigQueryTable += 1; return "202607"; },
    dryRunCruxPopularityFn: async () => { providerCalls.bigQueryDry += 1;
      return { datasetMonth: "202607", bytesProcessed: 100 }; },
    fetchCruxPopularityForMonthFn: async ({ origins, datasetMonth, dryRun }) => {
      providerCalls.bigQueryLive += 1; return { datasetMonth,
        records: origins.map((origin) => ({ contractVersion: "crux-popularity-v1", origin,
          coverage: "available", datasetMonth, popularityRank: 1000,
          deviceFractions: { phone: 0.7, desktop: 0.29, tablet: 0.01 }, fetchedAt: pipelineTime.value })),
        dryRunBytesProcessed: dryRun.bytesProcessed, bytesProcessed: 100, bytesBilled: 100, cacheHit: false }; }
  };

  async function drainOne(entry) {
    if (entry.queue === queues.discovery) return processDiscoveryMessage(entry.message, runtime);
    if (entry.queue === queues.domain) return processDomainAggregation(entry.message, runtime,
      { createLeaseMonitorFn: stoppedMonitor });
    if (entry.queue === queues.lead) { await preloadLead(entry.message); return processLeadMessage(entry.message, runtime); }
    if (entry.queue === queues.leadCheck) return processLeadAggregation(entry.message, runtime,
      { createLeaseMonitorFn: stoppedMonitor });
    if (entry.queue === queues.traffic) {
      if (inject("dlq_arrival")) { fault.dlq = { queue: entry.queue, message: entry.message }; return; }
      if (inject("before_external_work") || inject("lambda_timeout_or_process_death"))
        throw new Error(`injected:${fault.boundary}`);
      const result = await processTrafficBatch([{ recordId: randomUUID(), message: entry.message }],
        runtime, trafficDependencies);
      if (["after_s3_before_first_neon_terminal",
        "after_first_neon_terminal_before_aggregation_check_send"].includes(fault.boundary) &&
        fault.injected && result.results.some(({ terminal }) => !terminal)) fault.pauseRequested = true;
      return result;
    }
    if (entry.queue === queues.final) return processFinalAggregation(entry.message, runtime,
      { createLeaseMonitorFn: stoppedMonitor });
    throw new Error("unknown queue");
  }

  return {
    async runUntilSettled() {
      let steps = 0;
      while (steps < 100) {
        const run = await prisma.run.findUnique({ where: { id: runId } });
        if (fault.boundary === "conditional_s3_conflict" && fault.injected)
          return { run, providerCalls, artifacts, dispatches };
        if (fault.boundary === "external_success_response_lost" && fault.injected &&
            await prisma.dataForSeoRequestLedger.count({ where: { runId, state: "ambiguous" } }))
          return { run, providerCalls, artifacts, dispatches };
        if (fault.boundary === "dlq_arrival" && fault.dlq)
          return { run, providerCalls, artifacts, dispatches };
        if (fault.boundary === "partial_sqs_batch_failure" && fault.injected) {
          const trafficStage = await prisma.pipelineStage.findFirst({ where: { runId, stage: "traffic_crux" } });
          if (trafficStage && trafficStage.expectedCount === 2 && trafficStage.terminalCount === 2)
            return { run, providerCalls, artifacts, dispatches };
        }
        if (["completed", "cancelled", "failed"].includes(run.state)) {
          return { run, providerCalls, artifacts, dispatches };
        }
        const next = pending.shift();
        if (next) {
          try { await drainOne(next); }
          catch (error) {
            if (!fault.injected || fault.boundary === "conditional_s3_conflict" ||
                !String(error?.message).startsWith("injected:")) throw error;
            fault.pauseRequested = true;
          }
          if (fault.pauseRequested && !["external_success_response_lost", "dlq_arrival"]
            .includes(fault.boundary)) {
            fault.pauseRequested = false; fault.restarts += 1;
            return { run: await prisma.run.findUnique({ where: { id: runId } }),
              providerCalls, artifacts, dispatches };
          }
        }
        else {
          clock.value = new Date(Math.max(clock.value.getTime(), Date.now()) + 120000 + 1);
          const recovered = await recoverPipelineWork({ now: clock.value, limit: 100 }, runtime);
          if (recovered.tasksSent === 0 && recovered.checksSent === 0 && recovered.paidMarkedAmbiguous === 0)
            throw new Error("pipeline stalled without recoverable durable work");
        }
        steps += 1;
      }
      const [stages, tasks, ledgers] = await Promise.all([
        prisma.pipelineStage.findMany({ where: { runId }, select: { stage: true, state: true,
          expectedCount: true, terminalCount: true, aggregationAttempt: true } }),
        prisma.pipelineTask.findMany({ where: { stage: { runId } }, select: { itemKey: true, state: true,
          dispatchCount: true, attemptCount: true } }),
        prisma.dataForSeoRequestLedger.findMany({ where: { runId }, select: { scopeKey: true, state: true } })
      ]);
      throw new Error(`pipeline exceeded diagnostic durable actions: ${JSON.stringify({
        pending: pending.map(({ queue }) => queue), providerCalls, stages, tasks, ledgers })}`);
    },
    async restart() { return createAwsPipelineE2eHarness({ prisma, scenario: { ...scenario,
      artifacts, dispatches, pending, providerCalls, clock, fault,
      providerConfig: scenario.providerConfig }, now }); },
    async cancel() { return cancelAwsRunGeneration({ runId, generation: 1,
      now: new Date(now.getTime() + 1) }, runtime); }
  };
}
