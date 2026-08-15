import { randomUUID } from "node:crypto";
import { leadRecordToCreate, serializeLead, trafficCacheRecordToUpsert } from "../../api-serializer.js";
import { stableLeadId } from "../../prisma-run-repository.js";
import { enrichTraffic } from "../../enrichment/orchestrator.js";
import { buildDataForSeoRequest } from "../../enrichment/dataforseo/request.js";
import { fetchDataForSeoTraffic } from "../../enrichment/dataforseo/adapter.js";
import { dryRunCruxPopularity, fetchCruxLatestDatasetMonth, fetchCruxOriginMetrics,
  fetchCruxPopularityForMonth } from "../../enrichment/crux/adapter.js";
import { EnrichmentError, ENRICHMENT_ERROR_CODES } from "../../enrichment/errors.js";
import { parseDomainStageManifest, domainStageManifestSchema,
  parseProviderSourceArtifact, providerSourceArtifactSchema,
  parseCombinedTrafficCruxResult, combinedTrafficCruxResultSchema,
  providerSourceAttemptArtifactSchema, parseProviderBatchArtifact,
  providerBatchArtifactSchema, providerBatchAttemptSchema } from "../contracts/artifacts.js";
import { parseWorkMessage, aggregationCheckMessageSchema } from "../contracts/messages.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { awsDataForSeoRequestFingerprint, fingerprintJson } from "../core/canonical.js";
import { providerArtifactKey, providerBatchArtifactKey, providerBatchAttemptKey,
  providerSourceAttemptArtifactKey, trafficArtifactKey } from "../core/keys.js";
import { createPipelineLeaseMonitor } from "../core/lease-monitor.js";
import { mapWithConcurrency } from "../core/bounded-concurrency.js";
import { bigQueryAttemptBody, mapProviderError, providerBatchIdentity, reconcileBigQueryAttempt,
  sourceAttemptBody } from "../traffic/durable-protocol.js";

const S3_IO_CONCURRENCY = 8;
const TASK_SETTLEMENT_CONCURRENCY = 4;

export function trafficInputFingerprint(runId, generation, manifestFingerprint, plan, lead) {
  return fingerprintJson({ contractVersion: "traffic-domain-input-v1", runId, generation,
    manifestFingerprint, shopId: plan.shopId,
    leadFingerprint: fingerprintJson(leadRecordToCreate(runId, lead.id, serializeLead(lead))),
    needsTraffic: plan.needsTraffic, needsCruxRest: plan.needsCruxRest,
    needsCruxBigQuery: plan.needsCruxBigQuery, sourceKeys: plan.sourceKeys });
}

function providerRuntimeConfig(traffic, provider, secrets = {}) {
  const cruxProject = secrets.cruxBigQueryProjectId || "";
  if (traffic.crux.enabled) {
    if (!cruxProject || fingerprintJson({ contractVersion: "crux-bigquery-project-v1",
      projectId: cruxProject }) !== provider.trafficHttp.cruxBigQueryProjectIdFingerprint)
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  } else if (provider.trafficHttp.cruxBigQueryProjectIdFingerprint !== null) {
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  return Object.freeze({ dataForSeoEnrichmentEnabled: traffic.dataForSeo.enabled,
    cruxEnrichmentEnabled: traffic.crux.enabled,
    dataForSeoLogin: secrets.dataForSeoLogin || "", dataForSeoPassword: secrets.dataForSeoPassword || "",
    cruxApiKey: secrets.cruxApiKey || "", cruxBigQueryProjectId: cruxProject,
    googleApplicationCredentials: secrets.googleApplicationCredentials || "",
    cruxBigQueryLocation: traffic.crux.bigQuery.location,
    cruxBigQueryMaxBytesBilled: traffic.crux.bigQuery.maxBytesBilled,
    requestTimeoutMs: provider.trafficHttp.requestTimeoutMs });
}

function persistedLead(row) {
  return { ...serializeLead(row), id: row.id, shop_id: row.shopId,
    resolved_domain: row.resolvedDomain, final_url: row.finalUrl, status: row.status,
    identity_evidence: row.identityEvidence };
}

export function bindTrafficProviderIdentities(runId, lead, plan) {
  const dataForSeoIdentities = new Set(plan?.sourceKeys?.dataForSeo?.map(({ identity }) => identity) || []);
  const cruxIdentities = new Set([plan?.sourceKeys?.cruxRest?.identity,
    plan?.sourceKeys?.cruxBigQuery?.identity].filter(Boolean));
  if (dataForSeoIdentities.size > 1 || cruxIdentities.size > 1)
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const bound = { ...lead,
    ...(dataForSeoIdentities.size && { resolved_domain: [...dataForSeoIdentities][0] }),
    ...(cruxIdentities.size && { final_url: [...cruxIdentities][0] }) };
  if (stableLeadId(runId, bound) !== stableLeadId(runId, lead))
    throw new PipelineInvariantError("PIPELINE_IDENTITY_MISMATCH");
  return bound;
}

function sourceSelection(plan, workType, scopeKey) {
  if (workType === "dataforseo") return plan.sourceKeys.dataForSeo.find((entry) => entry.scopeKey === scopeKey);
  if (workType === "crux_rest") return plan.sourceKeys.cruxRest;
  if (workType === "crux_bigquery") return { ...plan.sourceKeys.cruxBigQuery, scopeKey };
  return null;
}

function normalizedDataForSeoScopeKey(scope) {
  return scope === "worldwide" ? "worldwide" : scope && typeof scope === "object"
    ? `country:${scope.countryIsoCode}:${scope.locationCode}` : null;
}

function artifactExpected(message, task, contractVersion) {
  return { contractVersion, runId: message.runId, stage: "traffic_crux",
    generation: message.generation, itemId: task.itemKey, inputFingerprint: task.inputFingerprint,
    producedAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : new Date(task.createdAt).toISOString() };
}

function assertDependencies(value) {
  const allowed = new Set(["createLeaseMonitorFn", "buildDataForSeoRequestFn", "fetchDataForSeoTrafficFn",
    "fetchCruxOriginMetricsFn", "fetchCruxLatestDatasetMonthFn", "dryRunCruxPopularityFn",
    "fetchCruxPopularityForMonthFn"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) ||
      Object.values(value).some((entry) => typeof entry !== "function"))
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
}

export async function processTrafficBatch(records, runtime, dependencies = {}) {
  assertDependencies(dependencies);
  dependencies = { createLeaseMonitorFn: createPipelineLeaseMonitor, buildDataForSeoRequestFn: buildDataForSeoRequest,
    fetchDataForSeoTrafficFn: fetchDataForSeoTraffic, fetchCruxOriginMetricsFn: fetchCruxOriginMetrics,
    fetchCruxLatestDatasetMonthFn: fetchCruxLatestDatasetMonth, dryRunCruxPopularityFn: dryRunCruxPopularity,
    fetchCruxPopularityForMonthFn: fetchCruxPopularityForMonth, ...dependencies };
  const createLeaseMonitorFn = dependencies.createLeaseMonitorFn ?? createPipelineLeaseMonitor;
  const parsed = records.map((entry) => ({ recordId: entry.recordId, message: parseWorkMessage(entry.message) }));
  const groups = new Map();
  for (const entry of parsed) {
    const message = entry.message;
    if (message.type !== "traffic.domain") throw new PipelineInvariantError("PIPELINE_MESSAGE_INVALID");
    const key = [message.runId, message.generation, message.manifestKey,
      message.manifestFingerprint, message.manifestProducedAt].join("\0");
    const group = groups.get(key) || [];
    group.push(entry); groups.set(key, group);
  }
  const results = [];
  for (const group of groups.values()) {
    const message = group[0].message;
    const token = randomUUID();
    let claim;
    try { claim = await runtime.repository.claimAwsRunLease({ runId: message.runId,
      generation: message.generation, owner: `traffic-${randomUUID()}`, token,
      leaseDurationMs: 60000 }, new Date()); }
    catch { results.push(...group.map(({ recordId }) =>
      ({ recordId, terminal: false, outcome: "retryable" }))); continue; }
    if (claim.outcome === "busy") { results.push(...group.map(({ recordId }) =>
      ({ recordId, terminal: false, outcome: "busy" }))); continue; }
    if (claim.outcome === "cancelled") { results.push(...group.map(({ recordId }) =>
      ({ recordId, terminal: true, outcome: "cancelled" }))); continue; }
    const monitor = createLeaseMonitorFn({ intervalMs: 20000,
      renew: (now) => runtime.repository.renewAwsRunLease({ runId: message.runId,
        generation: message.generation, token, leaseDurationMs: 60000 }, now) });
    let released = false;
    let executionPhase = "load_stage";
    try {
      const loaded = await runtime.repository.loadAwsTrafficStage({ runId: message.runId,
        generation: message.generation, runLease: claim.lease }, new Date());
      if (["ready", "aggregating"].includes(loaded.stage.state)) {
        await monitor.stop();
        await runtime.repository.releaseAwsRunLease({ runId: message.runId,
          generation: message.generation, token }, new Date());
        released = true;
        await runtime.dispatcher.sendOne(runtime.config.awsPipelineFinalAggregationQueueUrl,
          { version: 1, type: "aggregation.check", runId: message.runId, stage: "traffic_crux",
            generation: message.generation, reason: "terminal_task_recorded", attempt: 1 },
          aggregationCheckMessageSchema);
        results.push(...group.map(({ recordId }) =>
          ({ recordId, terminal: true, outcome: "replayed" })));
        continue;
      }
      executionPhase = "load_manifest";
      const stored = await runtime.artifactStore.getValidated({ key: message.manifestKey,
        expected: { contractVersion: "domain-stage-manifest-v1", runId: message.runId,
          stage: "domain", generation: message.generation, itemId: "manifest",
          inputFingerprint: message.manifestFingerprint, contentFingerprint: message.manifestFingerprint,
          producedAt: message.manifestProducedAt }, schema: domainStageManifestSchema });
      const manifest = parseDomainStageManifest(stored.value);
      if (fingerprintJson(manifest.workPlan.awsProviderConfig) !== fingerprintJson(loaded.run.awsProviderConfig))
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const planByShop = new Map(manifest.workPlan.domains.map((entry) => [entry.shopId, entry]));
      const taskByShop = new Map(loaded.tasks.map((entry) => [entry.itemKey, entry]));
      const leads = loaded.leads.map(persistedLead);
      const providerLeads = leads.map((lead) => bindTrafficProviderIdentities(
        message.runId, lead, planByShop.get(lead.shop_id)));
      const leadByShop = new Map(loaded.leads.map((entry) => [entry.shopId, entry]));
      if (loaded.tasks.some((task) => !planByShop.has(task.itemKey) || !leadByShop.has(task.itemKey)))
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      for (const task of loaded.tasks) {
        const expected = trafficInputFingerprint(message.runId, message.generation,
          message.manifestFingerprint, planByShop.get(task.itemKey), leadByShop.get(task.itemKey));
        if (expected !== task.inputFingerprint) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const durableSources = new Map();
      const durableCombined = new Map();
      const readPlan = [];
      for (const task of loaded.tasks) {
        for (const [source, keySource, enabled] of [["dataforseo", "dataforseo", planByShop.get(task.itemKey).needsTraffic],
          ["crux_rest", "crux-rest", planByShop.get(task.itemKey).needsCruxRest],
          ["crux_bigquery", "crux-bigquery", planByShop.get(task.itemKey).needsCruxBigQuery]]) {
          if (!enabled) continue;
          readPlan.push({ mapKey: `${task.itemKey}:${source}`, combined: false, request: {
            key: providerArtifactKey(message.runId, task.itemKey, keySource),
            expected: artifactExpected(message, task, "provider-source-result-v1"),
            schema: providerSourceArtifactSchema } });
        }
        readPlan.push({ mapKey: task.itemKey, combined: true, request: {
          key: trafficArtifactKey(message.runId, task.itemKey), expected: artifactExpected(message, task,
            "combined-traffic-crux-result-v1"), schema: combinedTrafficCruxResultSchema } });
      }
      const readResults = await mapWithConcurrency(readPlan, S3_IO_CONCURRENCY, async (entry) => {
        monitor.assertActive();
        return { entry, found: await runtime.artifactStore.getOptionalValidated(entry.request) };
      });
      executionPhase = "provider_enrichment";
      for (const { entry, found } of readResults) if (found.outcome === "found")
        (entry.combined ? durableCombined : durableSources).set(entry.mapKey, found.value);
      const runtimeConfig = providerRuntimeConfig(loaded.run.trafficEnrichmentConfig,
        loaded.run.awsProviderConfig, runtime.secrets);
      const evaluatedAt = new Date(manifest.workPlan.evaluatedAt);
      const capturedRows = [...durableSources.values()].flatMap(({ cacheRows }) => cacheRows);
      const sourceOutputs = new Map();
      const ledgerMetadata = new Map();
      const requestDescriptors = new Map();
      const bigQueryState = { datasetMonth: null, batch: null, existing: null };
      const transientSources = new Set();
      const dataForSeoEvidence = new Map();
      const setDataForSeoEvidence = (descriptor, evidence) => {
        for (const plan of manifest.workPlan.domains) {
          const selection = plan.sourceKeys.dataForSeo.find(({ scopeKey, identity }) =>
            scopeKey === descriptor.scopeKey && descriptor.targets.includes(identity));
          if (selection) dataForSeoEvidence.set(`${descriptor.scopeKey}\0${plan.shopId}`,
            { scopeKey: descriptor.scopeKey, ...evidence });
        }
      };
      for (const plan of manifest.workPlan.domains) {
        for (const selection of plan.sourceKeys.dataForSeo) {
          if (selection.reuse) dataForSeoEvidence.set(`${selection.scopeKey}\0${plan.shopId}`,
            { scopeKey: selection.scopeKey, disposition: "reused",
              cacheFingerprint: selection.reuse.cacheFingerprint });
        }
      }
      const dataForSeoBatch = (descriptor) => {
        const items = manifest.workPlan.domains.flatMap((plan) => {
          const selection = plan.sourceKeys.dataForSeo.find(({ scopeKey }) => scopeKey === descriptor.scopeKey);
          return selection && descriptor.targets.includes(selection.identity)
            ? [{ shopId: plan.shopId, sourceKey: selection }] : [];
        });
        const identity = providerBatchIdentity({ runId: message.runId, generation: message.generation,
          source: "dataforseo", scopeKey: descriptor.scopeKey,
          manifestFingerprint: message.manifestFingerprint,
          runSnapshot: loaded.run.trafficEnrichmentConfig,
          providerRequestFingerprint: descriptor.requestFingerprint, items });
        return { ...identity, key: providerBatchArtifactKey(message.runId, "dataforseo", identity.batchId),
          expected: { contractVersion: "provider-batch-result-v1", runId: message.runId,
            stage: "traffic_crux", generation: message.generation, itemId: identity.batchId,
            inputFingerprint: identity.batchInputFingerprint, producedAt: message.manifestProducedAt } };
      };
      const adapterRepository = {
        getDataForSeoRunCostUsd: (...args) => { executionPhase = "dataforseo_cost";
          return runtime.repository.getDataForSeoRunCostUsd(...args); },
        planDataForSeoRequest: async (...args) => {
          executionPhase = "dataforseo_plan";
          const ledger = args[2];
          const descriptor = requestDescriptors.get(ledger.requestFingerprint);
          if (!descriptor) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          const metadata = { ...descriptor, ...ledger };
          ledgerMetadata.set(metadata.requestFingerprint, metadata);
          const batch = dataForSeoBatch(metadata);
          monitor.assertActive();
          const existing = await runtime.artifactStore.getOptionalValidated({ key: batch.key,
            expected: batch.expected, schema: providerBatchArtifactSchema });
          if (existing.outcome === "found") {
            const artifact = parseProviderBatchArtifact(existing.value);
            capturedRows.push(...artifact.items.flatMap(({ cacheRows }) => cacheRows));
            const providerCostUsd = artifact.items[0]?.summary?.providerCostUsd;
            if (!Number.isFinite(providerCostUsd) || providerCostUsd < 0)
              throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
            await runtime.repository.recordAwsDataForSeoOutcome(message.runId, claim.lease,
              { requestFingerprint: metadata.requestFingerprint, targetCount: metadata.targetCount,
                scopeKey: metadata.scopeKey, outcome: "succeeded", providerCostUsd,
                resultFingerprint: existing.contentFingerprint }, new Date());
            setDataForSeoEvidence(metadata, { disposition: "ledger",
              requestFingerprint: metadata.requestFingerprint, targetCount: metadata.targetCount,
              ledgerState: "succeeded", batchId: batch.batchId, batchArtifactKey: batch.key,
              batchArtifactFingerprint: existing.contentFingerprint });
            return { outcome: "succeeded" };
          }
          const planned = await runtime.repository.planDataForSeoRequest(...args);
          if (planned.outcome !== "planned") setDataForSeoEvidence(metadata,
            planned.outcome === "ambiguous" || planned.outcome === "in_flight"
              ? { disposition: "ledger", requestFingerprint: metadata.requestFingerprint,
                targetCount: metadata.targetCount, ledgerState: "ambiguous" }
              : { disposition: "not_dispatched", reason: "budget_exhausted" });
          return planned;
        },
        claimDataForSeoRequest: async (...args) => {
          executionPhase = "dataforseo_ledger_claim";
          const claimed = await runtime.repository.claimDataForSeoRequest(...args);
          const metadata = ledgerMetadata.get(args[2]);
          if (metadata && !claimed.networkAllowed) setDataForSeoEvidence(metadata,
            claimed.outcome === "ambiguous" || claimed.outcome === "in_flight"
              ? { disposition: "ledger", requestFingerprint: metadata.requestFingerprint,
                targetCount: metadata.targetCount, ledgerState: "ambiguous" }
              : { disposition: "not_dispatched", reason: "budget_exhausted" });
          return claimed;
        },
        readReusableTrafficCache: async (_runId, _lease, keys) => {
          executionPhase = "reusable_traffic_cache";
          const materialized = keys.flatMap((key) => capturedRows.filter((row) =>
            row.source === key.source && row.identity === key.identity && row.scopeKey === key.scopeKey &&
            row.metricSetKey === key.metricSetKey && row.contractVersion === key.contractVersion));
          const selected = keys.filter((key) => manifest.workPlan.domains.some((plan) =>
            [...plan.sourceKeys.dataForSeo, plan.sourceKeys.cruxRest, plan.sourceKeys.cruxBigQuery]
              .some((selection) => selection.reuse && selection.source === key.source &&
                selection.identity === key.identity && selection.scopeKey === key.scopeKey &&
                selection.metricSetKey === key.metricSetKey && selection.contractVersion === key.contractVersion)));
          const storedRows = selected.length ? await runtime.repository.readReusableTrafficCache(
            message.runId, claim.lease, selected, evaluatedAt) : [];
          return [...new Map([...materialized, ...storedRows].map((row) =>
            [`${row.source}:${row.identity}:${row.scopeKey}:${row.metricSetKey}:${row.contractVersion}`, row])).values()];
        },
        readReusableLatestCruxBigQueryCache: (_runId, _lease, identities) => {
          executionPhase = "crux_bigquery_latest_cache";
          return runtime.repository.readReusableLatestCruxBigQueryCache(
            message.runId, claim.lease, identities, evaluatedAt);
        },
        claimShopWorkBatch: async (_runId, _lease, claims) => {
          executionPhase = `claim_${claims[0]?.workType || "traffic"}`;
          const groupShopsByClaim = new Map();
          const groupedClaims = new Map();
          for (const item of claims) {
            const plan = planByShop.get(item.shopId);
            const task = taskByShop.get(item.shopId);
            const selection = plan && sourceSelection(plan, item.workType, item.scopeKey);
            if (!plan || !task || !selection || selection.scopeKey !== item.scopeKey)
              throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
            const groupKey = [item.workType, selection.identity, selection.scopeKey,
              selection.metricSetKey, selection.contractVersion].join("\0");
            const entries = groupedClaims.get(groupKey) || [];
            entries.push(item);
            groupedClaims.set(groupKey, entries);
            groupShopsByClaim.set(`${item.shopId}:${item.workType}:${item.scopeKey}`, groupKey);
          }
          for (const entries of groupedClaims.values()) entries.sort((left, right) =>
            left.shopId.localeCompare(right.shopId));
          const alreadyTerminal = new Map(claims.map((item) => {
            const plan = planByShop.get(item.shopId);
            const source = item.workType === "dataforseo" ? "dataforseo" : item.workType;
            return [item, durableSources.get(`${item.shopId}:${source}`)];
          }));
          const unresolved = claims.filter((item) => !alreadyTerminal.get(item));
          const resolved = new Map();
          if (unresolved.length) {
          const awsClaims = unresolved.map((item) => { const plan = planByShop.get(item.shopId);
            const selection = sourceSelection(plan, item.workType, item.scopeKey);
            return { shopId: item.shopId, pipelineTaskId: taskByShop.get(item.shopId).id, selection }; });
          const outcomes = await runtime.repository.claimAwsTrafficWorkBatch({ runId: message.runId,
            generation: message.generation, runLease: claim.lease, claims: awsClaims }, new Date());
          outcomes.forEach((item) => { if (item.outcome === "completed") capturedRows.push(...(item.cacheRows || []));
            if (item.workType === "dataforseo") {
              if (item.outcome === "completed") {
                const row = (item.cacheRows || []).find((entry) => entry.scopeKey === item.scopeKey);
                if (row?.id) dataForSeoEvidence.set(`${item.scopeKey}\0${item.shopId}`,
                  { scopeKey: item.scopeKey, disposition: "reused",
                    cacheFingerprint: fingerprintJson(trafficCacheRecordToUpsert(row.id, row)) });
              } else if (["failed", "ambiguous"].includes(item.outcome)) {
                dataForSeoEvidence.set(`${item.scopeKey}\0${item.shopId}`, { scopeKey: item.scopeKey,
                  disposition: "not_dispatched", reason: item.outcome === "ambiguous"
                    ? "work_ambiguous" : "work_failed" });
              }
            }
            resolved.set(`${item.shopId}:${item.workType}:${item.scopeKey}`, item); });
          }
          return claims.map((claimItem) => { const durable = alreadyTerminal.get(claimItem);
            if (durable) return { outcome: durable.state === "ambiguous" ? "ambiguous" : "completed",
              networkAllowed: false, work: claimItem };
            const item = resolved.get(`${claimItem.shopId}:${claimItem.workType}:${claimItem.scopeKey}`);
            if (item.outcome === "busy") {
              const groupKey = groupShopsByClaim.get(
                `${claimItem.shopId}:${claimItem.workType}:${claimItem.scopeKey}`
              );
              for (const sibling of groupedClaims.get(groupKey) || [])
                transientSources.add(`${sibling.shopId}:${sibling.workType}`);
            }
            return ({ outcome: item.outcome === "owned" ? "won" :
            item.outcome === "busy" ? "processing" : item.outcome, networkAllowed: item.outcome === "owned",
            work: { shopId: item.shopId, workType: item.workType, scopeKey: item.scopeKey } }); });
        },
        markDataForSeoRequestSucceeded: async (_runId, _lease, requestFingerprint,
          { providerCostUsd, cacheRows }, now) => { capturedRows.push(...cacheRows);
          const metadata = ledgerMetadata.get(requestFingerprint);
          if (!metadata) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          const batch = dataForSeoBatch(metadata);
          const batchCandidate = { contractVersion: "provider-batch-result-v1",
            runId: message.runId, generation: message.generation, source: "dataforseo",
            scopeKey: metadata.scopeKey, batchId: batch.batchId,
            providerRequestFingerprint: requestFingerprint, items: batch.items.map(({ shopId, sourceKey }, index) => {
              const rows = cacheRows.filter((row) => row.identity === sourceKey.identity &&
                row.scopeKey === metadata.scopeKey);
              return { shopId, state: rows.length ? "available" : "unavailable",
                cacheRows: rows, leadTrafficRows: [], summary: index === 0 ? { providerCostUsd } : {}, diagnostics: [] };
            }) };
          const value = parseProviderBatchArtifact(batchCandidate);
          monitor.assertActive();
          const written = await runtime.artifactStore.putImmutable({ key: batch.key, ...batch.expected,
            value, schema: providerBatchArtifactSchema });
          await runtime.repository.recordAwsDataForSeoOutcome(message.runId, claim.lease,
            { requestFingerprint, targetCount: metadata.targetCount, scopeKey: metadata.scopeKey,
              outcome: "succeeded", providerCostUsd, resultFingerprint: written.contentFingerprint }, now);
          setDataForSeoEvidence(metadata, { disposition: "ledger", requestFingerprint,
            targetCount: metadata.targetCount, ledgerState: "succeeded", batchId: batch.batchId,
            batchArtifactKey: batch.key, batchArtifactFingerprint: written.contentFingerprint }); },
        markDataForSeoRequestFailed: async (_runId, _lease, requestFingerprint, error, now) => {
          const metadata = ledgerMetadata.get(requestFingerprint);
          if (!metadata) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          const result = await runtime.repository.recordAwsDataForSeoOutcome(message.runId, claim.lease,
            { requestFingerprint, targetCount: metadata.targetCount, scopeKey: metadata.scopeKey,
              outcome: "failed", safeErrorCode: error.code }, now);
          setDataForSeoEvidence(metadata, { disposition: "ledger", requestFingerprint,
            targetCount: metadata.targetCount, ledgerState: "failed" });
          return result;
        },
        markDataForSeoRequestAmbiguous: async (_runId, _lease, requestFingerprint, now) => {
          const metadata = ledgerMetadata.get(requestFingerprint);
          if (!metadata) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          const result = await runtime.repository.recordAwsDataForSeoOutcome(message.runId, claim.lease,
            { requestFingerprint, targetCount: metadata.targetCount, scopeKey: metadata.scopeKey,
              outcome: "ambiguous" }, now);
          setDataForSeoEvidence(metadata, { disposition: "ledger", requestFingerprint,
            targetCount: metadata.targetCount, ledgerState: "ambiguous" });
          return result;
        },
        saveCruxTrafficCache: async (_runId, _lease, rows) => { capturedRows.push(...rows); },
        finishShopWorkClaims: async () => ({ count: 0 })
      };
      const output = await enrichTraffic({ runId: message.runId, lease: claim.lease,
        runSnapshot: loaded.run.trafficEnrichmentConfig, runtimeConfig, leads: providerLeads,
        repository: adapterRepository, assertLeaseActive: () => monitor.assertActive(),
        dependencyOverrides: { buildDataForSeoRequest: (input) => {
          const providerDescriptor = dependencies.buildDataForSeoRequestFn(input);
          const descriptor = { ...providerDescriptor, requestFingerprint: awsDataForSeoRequestFingerprint({
            runId: message.runId, generation: message.generation,
            providerRequestFingerprint: providerDescriptor.requestFingerprint
          }) };
          requestDescriptors.set(descriptor.requestFingerprint, descriptor);
          return descriptor;
        },
          fetchDataForSeoTraffic: (input) => dependencies.fetchDataForSeoTrafficFn(input),
          fetchCruxOriginMetrics: async (input) => {
            executionPhase = "crux_rest_live";
            const plans = manifest.workPlan.domains.filter((entry) =>
              entry.sourceKeys.cruxRest?.identity === input.origin).sort((left, right) =>
              left.shopId.localeCompare(right.shopId));
            if (!plans.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
            const plan = plans[0];
            const task = taskByShop.get(plan.shopId);
            const key = providerSourceAttemptArtifactKey(message.runId, plan.shopId, "crux-rest");
            const expected = artifactExpected(message, task, "provider-source-attempt-v1");
            monitor.assertActive();
            const prior = await runtime.artifactStore.getOptionalValidated({ key, expected,
              schema: providerSourceAttemptArtifactSchema });
            if (prior.outcome === "found") throw new EnrichmentError("PIPELINE_PROVIDER_AMBIGUOUS", {
              code: ENRICHMENT_ERROR_CODES.ambiguousRequest, provider: "crux",
              contractVersion: loaded.run.trafficEnrichmentConfig.crux.rest.contractVersion });
            const marker = sourceAttemptBody({ runId: message.runId, generation: message.generation,
              shopId: plan.shopId, taskInputFingerprint: task.inputFingerprint,
              selection: plan.sourceKeys.cruxRest });
            monitor.assertActive();
            await runtime.artifactStore.putImmutable({ key, ...expected, value: marker,
              schema: providerSourceAttemptArtifactSchema });
            monitor.assertActive();
            try { return await dependencies.fetchCruxOriginMetricsFn(input); }
            catch (error) {
              const mapped = mapProviderError("crux_rest", "live", error);
              if (mapped.outcome === "ambiguous") throw new EnrichmentError("PIPELINE_PROVIDER_AMBIGUOUS", {
                code: ENRICHMENT_ERROR_CODES.ambiguousRequest, provider: "crux",
                contractVersion: loaded.run.trafficEnrichmentConfig.crux.rest.contractVersion });
              if (mapped.outcome === "throw") throw error;
              throw new EnrichmentError("PIPELINE_PROVIDER_UNAVAILABLE", {
                code: ENRICHMENT_ERROR_CODES.providerRejected, provider: "crux",
                contractVersion: loaded.run.trafficEnrichmentConfig.crux.rest.contractVersion });
            }
          },
          fetchCruxLatestDatasetMonth: async (input) => {
            executionPhase = "crux_bigquery_latest_month";
            if ((claim.lease.leaseAttempt ?? loaded.run.leaseAttempt ?? 1) > 3)
              throw new EnrichmentError("PIPELINE_PROVIDER_AMBIGUOUS", { code: ENRICHMENT_ERROR_CODES.ambiguousRequest,
                provider: "crux", contractVersion: loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion });
            monitor.assertActive();
            let month;
            try { month = await dependencies.fetchCruxLatestDatasetMonthFn(input); }
            catch (error) {
              const mapped = mapProviderError("crux_bigquery", "table", error,
                claim.lease.leaseAttempt ?? loaded.run.leaseAttempt ?? 1);
              if (mapped.outcome === "retry")
                manifest.workPlan.domains.filter(({ needsCruxBigQuery }) => needsCruxBigQuery)
                  .forEach(({ shopId }) => transientSources.add(`${shopId}:crux_bigquery`));
              if (mapped.outcome === "ambiguous") throw new EnrichmentError("PIPELINE_PROVIDER_AMBIGUOUS", {
                code: ENRICHMENT_ERROR_CODES.ambiguousRequest, provider: "crux",
                contractVersion: loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion });
              throw error;
            }
            bigQueryState.datasetMonth = month;
            return month;
          },
          dryRunCruxPopularity: async (input) => {
            executionPhase = "crux_bigquery_dry_run";
            const scopeKey = `month:${input.datasetMonth}`;
            const items = manifest.workPlan.domains.flatMap((plan) =>
              input.origins.includes(plan.sourceKeys.cruxBigQuery.identity)
                ? [{ shopId: plan.shopId, sourceKey: { ...plan.sourceKeys.cruxBigQuery, scopeKey } }] : []);
            const identity = providerBatchIdentity({ runId: message.runId, generation: message.generation,
              source: "crux_bigquery", scopeKey, manifestFingerprint: message.manifestFingerprint,
              runSnapshot: loaded.run.trafficEnrichmentConfig,
              providerRequestFingerprint: "bigquery-request-id-v1", items });
            bigQueryState.batch = { ...identity, scopeKey,
              key: providerBatchArtifactKey(message.runId, "crux-bigquery", identity.batchId),
              attemptKey: providerBatchAttemptKey(message.runId, "crux-bigquery", identity.batchId),
              expected: { contractVersion: "provider-batch-result-v1", runId: message.runId,
                stage: "traffic_crux", generation: message.generation, itemId: identity.batchId,
                inputFingerprint: identity.batchInputFingerprint, producedAt: message.manifestProducedAt } };
            monitor.assertActive();
            bigQueryState.existing = await runtime.artifactStore.getOptionalValidated({
              key: bigQueryState.batch.key, expected: bigQueryState.batch.expected, schema: providerBatchArtifactSchema });
            if (bigQueryState.existing.outcome === "found") {
              const summary = bigQueryState.existing.value.items[0]?.summary || {};
              return { datasetMonth: input.datasetMonth, bytesProcessed: summary.dryRunBytesProcessed ?? 0 };
            }
            if ((claim.lease.leaseAttempt ?? loaded.run.leaseAttempt ?? 1) > 3)
              throw new EnrichmentError("PIPELINE_PROVIDER_AMBIGUOUS", { code: ENRICHMENT_ERROR_CODES.ambiguousRequest,
                provider: "crux", contractVersion: loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion });
            monitor.assertActive();
            try { return await dependencies.dryRunCruxPopularityFn(input); }
            catch (error) {
              const mapped = mapProviderError("crux_bigquery", "dry", error,
                claim.lease.leaseAttempt ?? loaded.run.leaseAttempt ?? 1);
              if (mapped.outcome === "retry")
                if (!bigQueryState.batch || bigQueryState.batch.scopeKey !== `month:${input.datasetMonth}`)
                  throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
                bigQueryState.batch.items.forEach(({ shopId }) => transientSources.add(`${shopId}:crux_bigquery`));
              if (mapped.outcome === "ambiguous") throw new EnrichmentError("PIPELINE_PROVIDER_AMBIGUOUS", {
                code: ENRICHMENT_ERROR_CODES.ambiguousRequest, provider: "crux",
                contractVersion: loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion });
              throw error;
            }
          },
          fetchCruxPopularityForMonth: async (input) => {
            executionPhase = "crux_bigquery_live";
            const batch = bigQueryState.batch;
            if (!batch || batch.scopeKey !== `month:${input.datasetMonth}`)
              throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
            const responseFromArtifact = (artifact) => {
              const summary = artifact.items[0]?.summary || {};
              return { datasetMonth: input.datasetMonth,
                records: artifact.items.map((item) => item.cacheRows[0]?.normalizedPayload || {
                  contractVersion: loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion,
                  origin: batch.items.find(({ shopId }) => shopId === item.shopId).sourceKey.identity,
                  coverage: "unavailable", reason: item.state === "contract_mismatch" ? "contract_mismatch" : "no_coverage",
                  datasetMonth: input.datasetMonth, fetchedAt: message.manifestProducedAt }),
                dryRunBytesProcessed: summary.dryRunBytesProcessed ?? input.dryRun.bytesProcessed,
                bytesProcessed: summary.bytesProcessed ?? 0, bytesBilled: summary.bytesBilled ?? 0,
                cacheHit: summary.cacheHit ?? false };
            };
            if (bigQueryState.existing?.outcome === "found")
              return responseFromArtifact(parseProviderBatchArtifact(bigQueryState.existing.value));
            const attemptExpected = { contractVersion: "provider-batch-attempt-v1", runId: message.runId,
              stage: "traffic_crux", generation: message.generation, itemId: batch.batchId,
              inputFingerprint: batch.batchInputFingerprint, producedAt: message.manifestProducedAt };
            monitor.assertActive();
            const prior = await runtime.artifactStore.getOptionalValidated({ key: batch.attemptKey,
              expected: attemptExpected, schema: providerBatchAttemptSchema });
            let requestId = batch.requestId;
            let dryRun = input.dryRun;
            if (prior.outcome === "found") {
              const recovery = reconcileBigQueryAttempt(prior.value, { now: new Date(), scopeKey: batch.scopeKey,
                maximumBytesBilled: loaded.run.trafficEnrichmentConfig.crux.bigQuery.maxBytesBilled });
              if (recovery.outcome === "ambiguous") throw new EnrichmentError("PIPELINE_PROVIDER_AMBIGUOUS", {
                code: ENRICHMENT_ERROR_CODES.ambiguousRequest, provider: "crux",
                contractVersion: loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion });
              requestId = recovery.requestId; dryRun = recovery.dryRun;
            } else {
              const marker = bigQueryAttemptBody({ runId: message.runId, generation: message.generation,
                scopeKey: batch.scopeKey, batchInputFingerprint: batch.batchInputFingerprint,
                datasetMonth: input.datasetMonth, dryRunBytesProcessed: input.dryRun.bytesProcessed,
                dispatchedAt: new Date() });
              monitor.assertActive();
              await runtime.artifactStore.putImmutable({ key: batch.attemptKey, ...attemptExpected,
                value: marker, schema: providerBatchAttemptSchema });
            }
            monitor.assertActive();
            const response = await dependencies.fetchCruxPopularityForMonthFn({ ...input, dryRun, requestId });
            const value = parseProviderBatchArtifact({ contractVersion: "provider-batch-result-v1",
              runId: message.runId, generation: message.generation, source: "crux_bigquery",
              scopeKey: batch.scopeKey, batchId: batch.batchId, providerRequestFingerprint: requestId,
              items: batch.items.map(({ shopId, sourceKey }, index) => { const record = response.records.find(({ origin }) =>
                origin === sourceKey.identity); const state = record?.coverage === "available" ? "available" :
                  record?.reason === "contract_mismatch" ? "contract_mismatch" : "no_coverage";
                const cacheRows = state === "contract_mismatch" || !record ? [] : [{ source: "crux_bigquery",
                  identity: sourceKey.identity, scopeKey: batch.scopeKey,
                  metricSetKey: loaded.run.trafficEnrichmentConfig.crux.bigQuery.metricSetKey,
                  contractVersion: loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion,
                  state, ...(state === "available" && { normalizedPayload: record }), fetchedAt: record.fetchedAt,
                  expiresAt: new Date(new Date(record.fetchedAt).getTime() + 86400000).toISOString() }];
                return { shopId, state, cacheRows, leadTrafficRows: [],
                  summary: index === 0 ? { dryRunBytesProcessed: response.dryRunBytesProcessed,
                    bytesProcessed: response.bytesProcessed, bytesBilled: response.bytesBilled,
                    cacheHit: response.cacheHit } : {}, diagnostics: [] }; }) });
            monitor.assertActive();
            await runtime.artifactStore.putImmutable({ key: batch.key, ...batch.expected,
              value, schema: providerBatchArtifactSchema });
            return response;
          } },
        onBatchTelemetry: ({ source, operation }) => {
          executionPhase = `after_${source}_${operation}`;
        },
        onSourceComplete: async (source) => {
          sourceOutputs.set(source.sourceKey, source);
          executionPhase = `after_${source.sourceKey}`;
        } });
      executionPhase = "source_artifacts";
      const recordByLead = new Map(output.trafficEnrichments.map((entry) => [`${entry.leadId}:${entry.source}`, entry]));
      let terminalCount = 0;
      let recordedCount = 0;
      const sourceWrites = [];
      const taskPlans = [];
      for (const task of loaded.tasks) {
        const plan = planByShop.get(task.itemKey); const lead = leadByShop.get(task.itemKey);
        if ((plan.needsTraffic && transientSources.has(`${task.itemKey}:dataforseo`)) ||
            (plan.needsCruxRest && transientSources.has(`${task.itemKey}:crux_rest`)) ||
            (plan.needsCruxBigQuery && transientSources.has(`${task.itemKey}:crux_bigquery`))) continue;
        const sourceDefs = [["dataforseo", "dataforseo", plan.needsTraffic],
          ["cruxRest", "crux-rest", plan.needsCruxRest], ["cruxBigQuery", "crux-bigquery", plan.needsCruxBigQuery]];
        const components = {};
        for (const [component, keySource, enabled] of sourceDefs) {
          if (!enabled) { components[component] = { state: "skipped",
            contractVersion: component === "dataforseo" ? loaded.run.trafficEnrichmentConfig.dataForSeo.contractVersion :
              component === "cruxRest" ? loaded.run.trafficEnrichmentConfig.crux.rest.contractVersion :
                loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion }; continue; }
          const existingArtifact = durableSources.get(`${task.itemKey}:${keySource.replaceAll("-", "_")}`);
          if (existingArtifact) {
            components[component] = { state: existingArtifact.state,
              contractVersion: component === "dataforseo" ? loaded.run.trafficEnrichmentConfig.dataForSeo.contractVersion :
                component === "cruxRest" ? loaded.run.trafficEnrichmentConfig.crux.rest.contractVersion :
                  loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion,
              artifactKey: providerArtifactKey(message.runId, task.itemKey, keySource) };
            continue;
          }
          const record = recordByLead.get(`${stableLeadId(message.runId, persistedLead(lead))}:${keySource.replaceAll("-", "_")}`);
          const state = record?.state || "unavailable";
          const sourceName = keySource.replaceAll("-", "_");
          const resolvedBigQueryScope = capturedRows.find((row) => row.source === "crux_bigquery" &&
            row.identity === plan.sourceKeys.cruxBigQuery.identity)?.scopeKey;
          const bigQueryScope = plan.sourceKeys.cruxBigQuery.scopeKey === "latest"
            ? resolvedBigQueryScope || (bigQueryState.datasetMonth
              ? `month:${bigQueryState.datasetMonth}`
              : (["ambiguous", "unavailable", "contract_mismatch"].includes(state) ? "latest" : null))
            : plan.sourceKeys.cruxBigQuery.scopeKey;
          if (component === "cruxBigQuery" && (!bigQueryScope ||
              !/^(?:latest|month:20\d{4})$/u.test(bigQueryScope)))
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          const scopeKeys = component === "dataforseo"
            ? plan.sourceKeys.dataForSeo.map(({ scopeKey }) => scopeKey).sort()
            : [component === "cruxRest" ? "current" : bigQueryScope];
          const materialScopes = new Set([...(record?.normalizedPayload?.records?.map((item) =>
            item.scopeKey || normalizedDataForSeoScopeKey(item.scope))
            .filter(Boolean) || []), ...capturedRows.filter((row) => sourceName === "dataforseo" &&
              plan.sourceKeys.dataForSeo.some(({ identity }) => identity === row.identity)).map(({ scopeKey }) => scopeKey)]);
          const scopeStates = scopeKeys.map((scopeKey) => ({ scopeKey,
            state: component === "dataforseo" &&
              dataForSeoEvidence.get(`${scopeKey}\0${task.itemKey}`)?.disposition === "reused"
              ? "reused"
              : state === "partial" ? (materialScopes.has(scopeKey) ? "available" : "unavailable") : state }));
          if (state === "partial" && !scopeStates.some(({ state: value }) => value === "available"))
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          const sourceCandidate = { contractVersion: "provider-source-result-v1",
            runId: message.runId, generation: message.generation, shopId: task.itemKey, source: sourceName,
            state, scopeStates, requestEvidence: component === "dataforseo"
              ? scopeKeys.map((scopeKey, index) => dataForSeoEvidence.get(`${scopeKey}\0${task.itemKey}`) ||
                { scopeKey, disposition: "not_dispatched", reason:
                  scopeStates[index].state === "ambiguous" ? "work_ambiguous" : "budget_exhausted" }) : [],
            cacheRows: capturedRows.filter((row) => row.source === sourceName &&
              (row.identity === plan.sourceKeys.cruxRest.identity || row.identity === plan.sourceKeys.cruxBigQuery.identity ||
                plan.sourceKeys.dataForSeo.some((item) => item.identity === row.identity)) &&
              !(sourceName === "dataforseo" && plan.sourceKeys.dataForSeo.some((item) => item.reuse &&
                item.identity === row.identity && item.scopeKey === row.scopeKey))),
            leadTrafficRows: record ? [record] : [], summary: sourceOutputs.get(component)?.summary || {}, diagnostics: [] };
          const artifact = parseProviderSourceArtifact(sourceCandidate);
          const sourceKey = providerArtifactKey(message.runId, task.itemKey, keySource);
          const sourceExpected = artifactExpected(message, task, "provider-source-result-v1");
          sourceWrites.push({ key: sourceKey, ...sourceExpected,
            value: artifact, schema: providerSourceArtifactSchema });
          components[component] = { state, contractVersion: record?.contractVersion ||
            (component === "dataforseo" ? loaded.run.trafficEnrichmentConfig.dataForSeo.contractVersion :
              component === "cruxRest" ? loaded.run.trafficEnrichmentConfig.crux.rest.contractVersion :
                loaded.run.trafficEnrichmentConfig.crux.bigQuery.contractVersion), artifactKey: sourceKey };
        }
        taskPlans.push({ task, components });
      }
      await mapWithConcurrency(sourceWrites, S3_IO_CONCURRENCY, (write) => {
        monitor.assertActive();
        return runtime.artifactStore.putImmutable(write);
      });
      executionPhase = "combined_artifacts";
      const combinedWrites = taskPlans.map(({ task, components }) => {
        const value = durableCombined.get(task.itemKey) || parseCombinedTrafficCruxResult({
          contractVersion: "combined-traffic-crux-result-v1", runId: message.runId,
          generation: message.generation, shopId: task.itemKey, components });
        return { task, request: { key: trafficArtifactKey(message.runId, task.itemKey),
          ...artifactExpected(message, task, "combined-traffic-crux-result-v1"), value,
          schema: combinedTrafficCruxResultSchema } };
      });
      const writtenCombined = await mapWithConcurrency(combinedWrites, S3_IO_CONCURRENCY, async (entry) => {
        monitor.assertActive();
        return { ...entry, written: await runtime.artifactStore.putImmutable(entry.request) };
      });
      executionPhase = "task_settlement";
      const settlements = await mapWithConcurrency(writtenCombined, TASK_SETTLEMENT_CONCURRENCY,
        async ({ task, request, written }) => {
        monitor.assertActive();
        const taskToken = randomUUID();
        const taskClaim = await runtime.coordinator.claimTask({ runId: message.runId, stage: "traffic_crux",
          generation: message.generation, itemKey: task.itemKey, inputFingerprint: task.inputFingerprint,
          owner: `traffic-terminal-${randomUUID()}`, token: taskToken, leaseDurationMs: 60000 }, new Date());
        if (taskClaim.outcome === "owned") { monitor.assertActive();
          await runtime.coordinator.recordTerminal({ taskId: taskClaim.task.id,
          token: taskToken, inputFingerprint: task.inputFingerprint, state: "succeeded",
          artifactS3Key: request.key, artifactFingerprint: written.contentFingerprint }, new Date());
          return "recorded"; }
        return taskClaim.outcome === "terminal" ? "replayed" : "busy";
      });
      terminalCount = settlements.filter((outcome) => outcome !== "busy").length;
      recordedCount = settlements.filter((outcome) => outcome === "recorded").length;
      await monitor.renewNow(); await monitor.stop();
      await runtime.repository.releaseAwsRunLease({ runId: message.runId,
        generation: message.generation, token }, new Date()); released = true;
      if (terminalCount) await runtime.dispatcher.sendOne(runtime.config.awsPipelineFinalAggregationQueueUrl,
        { version: 1, type: "aggregation.check", runId: message.runId, stage: "traffic_crux",
          generation: message.generation, reason: "terminal_task_recorded", attempt: 1 }, aggregationCheckMessageSchema);
      results.push(...group.map(({ recordId }) => ({ recordId, terminal: terminalCount > 0,
        outcome: terminalCount === 0 ? "busy" : recordedCount > 0 ? "recorded" : "replayed" })));
    } catch (error) {
      runtime.log?.("traffic_group_retryable", { runId: message.runId, stage: "traffic_crux",
        generation: message.generation, itemId: executionPhase, outcome: "retryable",
        safeCode: typeof error?.code === "string" ? error.code : "TRAFFIC_WORKER_UNEXPECTED" });
      results.push(...group.map(({ recordId }) => ({ recordId, terminal: false, outcome: "retryable" })));
    }
    finally { await monitor.stop().catch(() => {}); if (!released) { /* expiry owns recovery */ } }
  }
  return { results: results.sort((left, right) => left.recordId.localeCompare(right.recordId)) };
}
