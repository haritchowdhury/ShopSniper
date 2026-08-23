import { randomUUID } from "node:crypto";
import { resolveStoreIdentity } from "../../domain-resolver.js";
import { discoverStoresFromQueryPlans } from "../../pipeline.js";
import {
  confirmedQueryManifestSchema,
  parseConfirmedQueryManifest,
  parseQueryDiscoveryArtifact,
  queryDiscoveryArtifactSchema
} from "../contracts/artifacts.js";
import { aggregationCheckMessageSchema } from "../contracts/messages.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { fingerprintJson } from "../core/canonical.js";
import { queryArtifactKey } from "../core/keys.js";
import {
  createPipelineLeaseMonitor,
  preparePipelineTerminalLease
} from "../core/lease-monitor.js";

function queryInputFingerprint(manifest, manifestFingerprint, query) {
  return fingerprintJson({
    contractVersion: "discovery-query-input-v1", runId: manifest.runId,
    generation: manifest.generation, confirmedRevision: manifest.confirmedRevision,
    manifestFingerprint, query
  });
}

function queryPlan(query, category, acceptedResults) {
  return {
    ...category,
    categoryIntent: category,
    categoryVocabulary: query.categoryVocabulary,
    query: query.query,
    queryScore: query.queryScore,
    queryGenerationReason: query.generationReason,
    querySourceUrls: query.sourceUrls,
    results: acceptedResults
  };
}

export async function processDiscoveryMessage(message, runtime, dependencies = {}) {
  if (dependencies === null || typeof dependencies !== "object" ||
      Object.getPrototypeOf(dependencies) !== Object.prototype ||
      Object.keys(dependencies).some((key) => key !== "resolveStoreIdentityFn") ||
      (dependencies.resolveStoreIdentityFn !== undefined &&
       typeof dependencies.resolveStoreIdentityFn !== "function")) {
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  const resolveStoreIdentityFn = dependencies.resolveStoreIdentityFn ?? resolveStoreIdentity;
  const manifestStored = await runtime.artifactStore.getValidated({
    key: message.manifestKey,
    expected: {
      contractVersion: "confirmed-query-manifest-v1", runId: message.runId,
      stage: "discovery", generation: message.generation, itemId: "manifest",
      inputFingerprint: message.manifestFingerprint,
      contentFingerprint: message.manifestFingerprint, producedAt: message.manifestProducedAt
    },
    schema: confirmedQueryManifestSchema
  });
  const manifest = parseConfirmedQueryManifest(manifestStored.value);
  if (manifestStored.contentFingerprint !== message.manifestFingerprint ||
      manifest.runId !== message.runId || manifest.generation !== message.generation) {
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  const query = manifest.queries.find((item) => item.id === message.itemId);
  if (!query) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const inputFingerprint = queryInputFingerprint(manifest, message.manifestFingerprint, query);
  const owner = `discovery-${randomUUID()}`;
  const token = randomUUID();
  const claimed = await runtime.coordinator.claimTask({
    runId: message.runId, stage: "discovery", generation: message.generation,
    itemKey: message.itemId, inputFingerprint, owner, token, leaseDurationMs: 60000
  }, new Date());
  if (claimed.outcome === "busy") return { terminal: false, outcome: "busy" };
  if (claimed.outcome === "cancelled") return { terminal: true, outcome: "cancelled" };
  if (claimed.outcome === "terminal") return { terminal: true, outcome: "replayed" };

  const monitor = createPipelineLeaseMonitor({ intervalMs: 20000,
    renew: (now) => runtime.coordinator.renewTask({ taskId: claimed.task.id, token,
      leaseDurationMs: 60000 }, now) });
  const key = queryArtifactKey(message.runId, message.itemId);
  const producedAt = claimed.task.createdAt instanceof Date
    ? claimed.task.createdAt.toISOString() : new Date(claimed.task.createdAt).toISOString();
  const expected = { contractVersion: "query-discovery-artifact-v1", runId: message.runId,
    stage: "discovery", generation: message.generation, itemId: message.itemId,
    inputFingerprint, producedAt };
  try {
    monitor.assertActive();
    let stored = await runtime.artifactStore.getOptionalValidated({ key, expected,
      schema: queryDiscoveryArtifactSchema });
    if (stored.outcome === "missing") {
      const category = manifest.categories[query.categoryIndex];
      if (!category) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const accepted = [];
      const rejected = [];
      for (const result of query.probeResults) {
        if (result.query !== query.query) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        if (result.rejectionReason) rejected.push(result);
        else accepted.push(result);
      }
      const identityConfig = {
        ...runtime.config,
        requestTimeoutMs: manifest.awsProviderConfig.discoveryIdentity.requestTimeoutMs,
        browserlessEnabled: false, browserlessUrl: "", browserlessToken: "",
        browserlessFallbackToken: ""
      };
      const status = { queriesTotal: 0, queriesProcessed: 0, storesDiscovered: 0,
        failures: 0, occurrenceFailures: 0 };
      const discovery = await discoverStoresFromQueryPlans(identityConfig, status, {
        queryPlans: [queryPlan(query, category, accepted)],
        resolve: (result) => resolveStoreIdentityFn(result, identityConfig)
      });
      const rejectionDiagnostics = rejected.sort((left, right) => left.rank - right.rank).map((item) => ({
        scope: "occurrence", code: item.rejectionReason, shop_type: category.shopType,
        business_qualifier: category.businessQualifier, query: query.query,
        details: { rank: item.rank }
      }));
      const artifact = parseQueryDiscoveryArtifact({
        contractVersion: "query-discovery-artifact-v1", runId: message.runId,
        generation: message.generation, queryId: query.id,
        confirmedRevision: manifest.confirmedRevision,
        pipelineVersion: discovery.pipelineVersion, scoringVersion: discovery.scoringVersion,
        stores: discovery.stores, queryAudits: [],
        diagnostics: [...discovery.diagnostics, ...rejectionDiagnostics]
      });
      await runtime.artifactStore.putImmutable({ key, ...expected, value: artifact,
        schema: queryDiscoveryArtifactSchema });
      stored = { outcome: "found", value: artifact, contentFingerprint: fingerprintJson(artifact) };
    }
    monitor.assertActive();
    const artifact = parseQueryDiscoveryArtifact(stored.value);
    const artifactFingerprint = stored.contentFingerprint || fingerprintJson(artifact);
    await preparePipelineTerminalLease(monitor);
    const terminal = await runtime.coordinator.recordTerminal({ taskId: claimed.task.id, token, inputFingerprint,
      state: "succeeded", artifactS3Key: key, artifactFingerprint }, new Date());
    await runtime.dispatcher.sendOne(runtime.config.awsPipelineDomainAggregationQueueUrl, {
      version: 1, type: "aggregation.check", runId: message.runId, stage: "discovery",
      generation: message.generation, reason: "terminal_task_recorded", attempt: 1
    }, aggregationCheckMessageSchema);
    return { terminal: true, outcome: terminal.outcome === "replayed" ? "replayed" : "recorded" };
  } catch (error) {
    await monitor.stop().catch(() => {});
    throw error;
  }
}
