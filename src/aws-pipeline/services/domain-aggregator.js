import { randomUUID } from "node:crypto";
import { trafficCacheRecordToUpsert } from "../../api-serializer.js";
import { mergeRunStoreCandidatePayloads } from "../../discovery-aggregation.js";
import {
  parseRunStoreCandidate, parseShopLeadProfile, runStoreId, shopIdForStableKey,
  stableShopIdentity
} from "../../shop-persistence-contract.js";
import {
  confirmedQueryManifestSchema, domainCandidateArtifactSchema, domainStageManifestSchema,
  parseConfirmedQueryManifest, parseDomainCandidateArtifact, parseDomainStageManifest,
  parseQueryDiscoveryArtifact, queryDiscoveryArtifactSchema
} from "../contracts/artifacts.js";
import { aggregationCheckMessageSchema, workMessageSchema } from "../contracts/messages.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { canonicalJson, fingerprintJson } from "../core/canonical.js";
import { candidateArtifactKey, domainManifestKey } from "../core/keys.js";
import { createPipelineLeaseMonitor } from "../core/lease-monitor.js";

function serializeCache(row) {
  return { source: row.source, identity: row.identity, scopeKey: row.scopeKey,
    metricSetKey: row.metricSetKey, contractVersion: row.contractVersion,
    state: row.state, normalizedPayload: row.normalizedPayload,
    fetchedAt: row.fetchedAt instanceof Date ? row.fetchedAt.toISOString() : row.fetchedAt,
    coverageStartedAt: row.coverageStartedAt instanceof Date ? row.coverageStartedAt.toISOString() : row.coverageStartedAt,
    coverageEndedAt: row.coverageEndedAt instanceof Date ? row.coverageEndedAt.toISOString() : row.coverageEndedAt,
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt };
}

function exactKey(key) {
  return [key.source, key.identity, key.scopeKey, key.metricSetKey, key.contractVersion].join("\0");
}

export async function processDomainAggregation(message, runtime, {
  mergeCandidatesFn = mergeRunStoreCandidatePayloads,
  createLeaseMonitorFn = createPipelineLeaseMonitor
} = {}) {
  if (typeof mergeCandidatesFn !== "function" || typeof createLeaseMonitorFn !== "function") {
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  const token = randomUUID();
  const claim = await runtime.coordinator.claimAggregator({ runId: message.runId, stage: "discovery",
    generation: message.generation, owner: `domain-${randomUUID()}`, token,
    leaseDurationMs: 120000 }, new Date());
  if (claim.outcome !== "owned") return { terminal: true, outcome: claim.outcome };
  const monitor = createLeaseMonitorFn({ intervalMs: 40000,
    renew: (now) => runtime.coordinator.renewAggregator({ stageId: claim.stage.id, token,
      leaseDurationMs: 120000 }, now) });
  try {
    const complete = await runtime.coordinator.getCompleteStage({ runId: message.runId,
      stage: "discovery", generation: message.generation, token });
    if (complete.tasks.some((task) => task.state !== "succeeded")) {
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    }
    const producedAt = complete.stage.manifestProducedAt.toISOString();
    const manifestStored = await runtime.artifactStore.getValidated({ key: complete.stage.manifestS3Key,
      expected: { contractVersion: "confirmed-query-manifest-v1", runId: message.runId,
        stage: "discovery", generation: message.generation, itemId: "manifest",
        inputFingerprint: complete.stage.manifestFingerprint,
        contentFingerprint: complete.stage.manifestFingerprint, producedAt },
      schema: confirmedQueryManifestSchema });
    const confirmed = parseConfirmedQueryManifest(manifestStored.value);
    const taskByItem = new Map(complete.tasks.map((task) => [task.itemKey, task]));
    const artifacts = [];
    for (const query of [...confirmed.queries].sort((a, b) => a.sequence - b.sequence)) {
      const task = taskByItem.get(query.id);
      if (!task?.artifactS3Key || !task.artifactFingerprint) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const stored = await runtime.artifactStore.getValidated({ key: task.artifactS3Key,
        expected: { contractVersion: "query-discovery-artifact-v1", runId: message.runId,
          stage: "discovery", generation: message.generation, itemId: query.id,
          inputFingerprint: task.inputFingerprint, contentFingerprint: task.artifactFingerprint,
          producedAt: task.createdAt }, schema: queryDiscoveryArtifactSchema });
      const artifact = parseQueryDiscoveryArtifact(stored.value);
      if (artifact.queryAudits.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      artifacts.push({ artifact, fingerprint: stored.contentFingerprint });
    }
    const merged = mergeCandidatesFn(artifacts.flatMap(({ artifact }) =>
      artifact.stores.map((store) => store.candidatePayload)));
    const domains = merged.map((candidatePayload) => {
      const identity = stableShopIdentity(candidatePayload);
      const shopId = shopIdForStableKey(identity.stableKey);
      return { shopId, runStoreId: runStoreId(message.runId, shopId), identity, candidatePayload };
    }).sort((a, b) => a.shopId.localeCompare(b.shopId));
    const evaluatedAt = complete.stage.createdAt;
    const reuse = await runtime.repository.readAwsReuseInputs({ runId: message.runId,
      generation: message.generation, stageId: complete.stage.id, aggregationToken: token,
      domains, evaluatedAt });
    if (canonicalJson(reuse.awsProviderConfig) !== canonicalJson(confirmed.awsProviderConfig)) {
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    }
    const domainByShopId = new Map(domains.map((domain) => [domain.shopId, domain]));
    const profiles = new Map();
    for (const row of reuse.profiles) {
      const profile = parseShopLeadProfile(row.profilePayload);
      if (profile.stableIdentity !== domainByShopId.get(row.shopId)?.identity.stableKey) continue;
      profiles.set(row.shopId, { profileShopId: row.shopId, profileFingerprint: fingerprintJson(profile) });
    }
    const cache = new Map();
    for (const row of [...reuse.trafficRows, ...reuse.latestCruxMonth]) {
      const key = exactKey(row);
      if (cache.has(key)) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      cache.set(key, { cacheId: row.id,
        cacheFingerprint: fingerprintJson(trafficCacheRecordToUpsert(row.id, serializeCache(row))) });
    }
    const traffic = reuse.trafficSnapshot;
    const bigRows = reuse.latestCruxMonth;
    const origins = domains.map((domain) => new URL(domain.identity.canonicalUrl).origin);
    const monthCounts = new Map();
    for (const row of bigRows) {
      if (!origins.includes(row.identity)) continue;
      if (!monthCounts.has(row.scopeKey)) monthCounts.set(row.scopeKey, new Set());
      monthCounts.get(row.scopeKey).add(row.identity);
    }
    const latestMonth = [...monthCounts].filter(([, found]) => found.size === new Set(origins).size)
      .map(([month]) => month).sort().at(-1) || null;
    const planned = domains.map((domain) => {
      const origin = new URL(domain.identity.canonicalUrl).origin;
      const dataForSeo = traffic.dataForSeo.scopes.map((scope) => {
        const scopeKey = typeof scope === "string" ? scope : `country:${scope.countryIsoCode}:${scope.locationCode}`;
        const key = { source: "dataforseo", identity: domain.identity.resolvedDomain, scopeKey,
          metricSetKey: traffic.dataForSeo.metricSetKey, contractVersion: traffic.dataForSeo.contractVersion };
        return { ...key, reuse: cache.get(exactKey(key)) || null };
      });
      const restKey = { source: "crux_rest", identity: origin, scopeKey: "current",
        metricSetKey: traffic.crux.rest.metricSetKey, contractVersion: traffic.crux.rest.contractVersion };
      const bigKey = { source: "crux_bigquery", identity: origin, scopeKey: latestMonth || "latest",
        metricSetKey: traffic.crux.bigQuery.metricSetKey, contractVersion: traffic.crux.bigQuery.contractVersion };
      const cruxRest = { ...restKey, reuse: cache.get(exactKey(restKey)) || null };
      const cruxBigQuery = { ...bigKey, reuse: latestMonth ? (cache.get(exactKey(bigKey)) || null) : null };
      const candidateArtifact = parseDomainCandidateArtifact({ contractVersion: "domain-candidate-v1",
        runId: message.runId, generation: message.generation, ...domain });
      const candidateFingerprint = fingerprintJson(candidateArtifact);
      const leadReuse = profiles.get(domain.shopId) || null;
      const needsTraffic = traffic.dataForSeo.enabled && dataForSeo.some((item) => !item.reuse);
      const needsCruxRest = traffic.crux.enabled && !cruxRest.reuse;
      const needsCruxBigQuery = traffic.crux.enabled && !cruxBigQuery.reuse;
      return { ...domain, candidateArtifact, candidateFingerprint,
        plan: { shopId: domain.shopId, runStoreId: domain.runStoreId,
          candidateKey: candidateArtifactKey(message.runId, domain.shopId), candidateFingerprint,
          leadReuse, needsLead: !leadReuse, needsTraffic, needsCruxRest, needsCruxBigQuery,
          needsCrux: needsCruxRest || needsCruxBigQuery,
          sourceKeys: { dataForSeo, cruxRest, cruxBigQuery } } };
    });
    for (const domain of planned) await runtime.artifactStore.putImmutable({
      key: domain.plan.candidateKey, contractVersion: "domain-candidate-v1", runId: message.runId,
      stage: "domain", generation: message.generation, itemId: domain.shopId,
      inputFingerprint: domain.candidateFingerprint, producedAt: evaluatedAt,
      value: domain.candidateArtifact, schema: domainCandidateArtifactSchema });
    const domainManifest = { contractVersion: "domain-manifest-v1", runId: message.runId,
      generation: message.generation, confirmedRevision: confirmed.confirmedRevision,
      inputQueryArtifactFingerprints: artifacts.map(({ fingerprint }) => fingerprint),
      probeEvidence: { queryOrderIndependent: true,
        mergedOccurrenceCount: domains.reduce((sum, domain) => sum + domain.candidatePayload.occurrences.length, 0),
        duplicateCount: domains.reduce((sum, domain) => sum + domain.candidatePayload.duplicateCount, 0) },
      domains };
    const combined = parseDomainStageManifest({ contractVersion: "domain-stage-manifest-v1", domainManifest,
      workPlan: { contractVersion: "domain-work-plan-v1", runId: message.runId,
        generation: message.generation, evaluatedAt: evaluatedAt.toISOString(),
        domainManifestKey: domainManifestKey(message.runId), awsProviderConfig: reuse.awsProviderConfig,
        domains: planned.map(({ plan }) => plan) } });
    const combinedFingerprint = fingerprintJson(combined);
    const key = domainManifestKey(message.runId);
    await runtime.artifactStore.putImmutable({ key, contractVersion: "domain-stage-manifest-v1",
      runId: message.runId, stage: "domain", generation: message.generation, itemId: "manifest",
      inputFingerprint: combinedFingerprint, producedAt: evaluatedAt, value: combined,
      schema: domainStageManifestSchema });
    const leadTasks = planned.filter(({ plan }) => plan.needsLead).map(({ plan }) => ({
      itemKey: plan.shopId, inputFingerprint: fingerprintJson({ contractVersion: "lead-domain-input-v1",
        runId: message.runId, generation: message.generation, manifestFingerprint: combinedFingerprint,
        shopId: plan.shopId, candidateFingerprint: plan.candidateFingerprint }) }));
    await monitor.renewNow();
    await monitor.stop();
    const published = await runtime.repository.publishAwsDomainCheckpoint({ runId: message.runId,
      generation: message.generation, stageId: complete.stage.id, aggregationToken: token,
      domainStageManifestKey: key, domainStageManifestFingerprint: combinedFingerprint,
      manifestProducedAt: evaluatedAt, domains, diagnostics: artifacts.flatMap(({ artifact }) => artifact.diagnostics),
      leadTasks, status: { stage: "aws_lead", storesPersisted: domains.length } }, new Date());
    const messages = [...published.dispatchItems].sort((a, b) => a.itemKey.localeCompare(b.itemKey)).map((task) => ({
      version: 1, type: "lead.domain", runId: message.runId, stage: "lead", generation: message.generation,
      itemId: task.itemKey, manifestKey: key, manifestFingerprint: combinedFingerprint,
      manifestProducedAt: evaluatedAt.toISOString(), attempt: 1 }));
    const sent = await runtime.dispatcher.sendMany(runtime.config.awsPipelineLeadQueueUrl, messages, workMessageSchema);
    if (sent.sentItemIds.length) await runtime.coordinator.recordDispatch({ stageId: published.leadStage.id,
      itemKeys: sent.sentItemIds }, new Date());
    if (!leadTasks.length) await runtime.dispatcher.sendOne(runtime.config.awsPipelineLeadAggregationQueueUrl,
      { version: 1, type: "aggregation.check", runId: message.runId, stage: "lead",
        generation: message.generation, reason: "zero_expected", attempt: 1 }, aggregationCheckMessageSchema);
    return { terminal: true, outcome: "completed" };
  } catch (error) {
    await monitor.stop().catch(() => {});
    throw error;
  }
}
