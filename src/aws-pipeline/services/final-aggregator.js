import { randomUUID } from "node:crypto";
import { domainStageManifestSchema, leadResultArtifactSchema, parseCombinedTrafficCruxResult,
  parseDomainStageManifest, parseLeadResultArtifact, parseProviderSourceArtifact,
  providerSourceArtifactSchema, providerBatchArtifactSchema, parseProviderBatchArtifact,
  combinedTrafficCruxResultSchema } from "../contracts/artifacts.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { fingerprintJson } from "../core/canonical.js";
import { providerArtifactKey } from "../core/keys.js";
import { createPipelineLeaseMonitor } from "../core/lease-monitor.js";
import { mapWithConcurrency } from "../core/bounded-concurrency.js";
import { buildDataForSeoRequest, DATAFORSEO_COUNTRY_LOCATION_CODES,
  DATAFORSEO_TARGET_LIMIT } from "../../enrichment/dataforseo/request.js";

const S3_IO_CONCURRENCY = 8;

function dataForSeoScopeInput(scopeKey) {
  if (scopeKey === "worldwide") return "worldwide";
  const match = /^country:([A-Z]{2}):([1-9]\d*)$/u.exec(scopeKey);
  if (!match || DATAFORSEO_COUNTRY_LOCATION_CODES[match[1]] !== Number(match[2]))
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  return { countryIsoCode: match[1] };
}

function batches(values, limit) {
  const output = [];
  for (let index = 0; index < values.length; index += limit) output.push(values.slice(index, index + limit));
  return output;
}

function producedAt(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function expected(message, task, contractVersion) {
  return { contractVersion, runId: message.runId, stage: task.stage || "traffic_crux",
    generation: message.generation, itemId: task.itemKey, inputFingerprint: task.inputFingerprint,
    contentFingerprint: task.artifactFingerprint, producedAt: producedAt(task.createdAt) };
}

function aggregateSourceSummaries(values) {
  const output = {};
  const unique = [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
  for (const value of unique) for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item)) output[key] = (output[key] || 0) + item;
    else if (typeof item === "boolean") output[key] = Boolean(output[key]) || item;
    else if (item == null) continue;
    else if (!(key in output)) output[key] = item;
    else if (JSON.stringify(output[key]) !== JSON.stringify(item))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  return output;
}

export async function processFinalAggregation(message, runtime, {
  createLeaseMonitorFn = createPipelineLeaseMonitor
} = {}) {
  let phase = "claim";
  let reconciliationContext = null;
  let publicationStep = null;
  const token = randomUUID();
  const claim = await runtime.coordinator.claimAggregator({ runId: message.runId, stage: "traffic_crux",
    generation: message.generation, owner: `final-aggregation-${randomUUID()}`, token,
    leaseDurationMs: 120000 }, new Date());
  if (claim.outcome !== "owned") return { terminal: true, outcome: claim.outcome };
  const monitor = createLeaseMonitorFn({ intervalMs: 40000,
    renew: (now) => runtime.coordinator.renewAggregator({ stageId: claim.stage.id, token,
      leaseDurationMs: 120000 }, now) });
  try {
    phase = "load_complete_stage";
    const complete = await runtime.coordinator.getCompleteStage({ runId: message.runId,
      stage: "traffic_crux", generation: message.generation, token });
    if (complete.tasks.some(({ state }) => state !== "succeeded"))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    phase = "domain_manifest";
    const manifestTime = producedAt(complete.stage.manifestProducedAt);
    const storedManifest = await runtime.artifactStore.getValidated({ key: complete.stage.manifestS3Key,
      expected: { contractVersion: "domain-stage-manifest-v1", runId: message.runId, stage: "domain",
        generation: message.generation, itemId: "manifest", inputFingerprint: complete.stage.manifestFingerprint,
        contentFingerprint: complete.stage.manifestFingerprint, producedAt: manifestTime },
      schema: domainStageManifestSchema });
    const manifest = parseDomainStageManifest(storedManifest.value);
    const planByShop = new Map(manifest.workPlan.domains.map((entry) => [entry.shopId, entry]));
    const cacheRows = [];
    const leadTrafficRows = [];
    const workOutcomes = [];
    const diagnostics = [];
    const ledgerEvidenceByRequest = new Map();
    const ambiguousDataForSeoCandidates = [];
    const ambiguousCruxBigQueryCandidates = [];
    const summaries = { dataforseo: [], cruxRest: [], cruxBigQuery: [] };
    phase = "combined_artifacts";
    const combinedEntries = await mapWithConcurrency(complete.tasks, S3_IO_CONCURRENCY, async (task) => {
      const plan = planByShop.get(task.itemKey);
      if (!plan || !task.artifactS3Key || !task.artifactFingerprint)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const stored = await runtime.artifactStore.getValidated({ key: task.artifactS3Key,
        expected: expected(message, task, "combined-traffic-crux-result-v1"),
        schema: combinedTrafficCruxResultSchema });
      const combined = parseCombinedTrafficCruxResult(stored.value);
      if (combined.shopId !== task.itemKey) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      return { task, plan, combined };
    });
    phase = "source_artifacts";
    const sourcePlan = combinedEntries.flatMap(({ task, combined }) =>
      [["dataforseo", "dataforseo", "dataforseo"], ["cruxRest", "crux_rest", "crux-rest"],
        ["cruxBigQuery", "crux_bigquery", "crux-bigquery"]].flatMap(([component, source, keySource]) => {
        const part = combined.components[component];
        if (part.state === "skipped") return [];
        const key = providerArtifactKey(message.runId, task.itemKey, keySource);
        if (part.artifactKey !== key) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        return [{ task, component, source, key, part }];
      }));
    const sourceEntries = await mapWithConcurrency(sourcePlan, S3_IO_CONCURRENCY, async (entry) => {
      const stored = await runtime.artifactStore.getValidated({ key: entry.key,
        expected: { ...expected(message, entry.task, "provider-source-result-v1"), contentFingerprint: undefined },
        schema: providerSourceArtifactSchema });
      return { ...entry, artifact: parseProviderSourceArtifact(stored.value) };
    });
    const sourceByTaskComponent = new Map(sourceEntries.map((entry) =>
      [`${entry.task.itemKey}\0${entry.component}`, entry]));
    const batchReferences = new Map();
    for (const { task, source, artifact } of sourceEntries) if (source === "dataforseo") {
      for (const evidence of artifact.requestEvidence) if (evidence.disposition === "ledger" &&
          evidence.ledgerState === "succeeded") {
        const reference = { key: evidence.batchArtifactKey, batchId: evidence.batchId,
          scopeKey: evidence.scopeKey, requestFingerprint: evidence.requestFingerprint,
          targetCount: evidence.targetCount, artifactFingerprint: evidence.batchArtifactFingerprint,
          expected: { contractVersion: "provider-batch-result-v1", runId: message.runId,
            stage: "traffic_crux", generation: message.generation, itemId: evidence.batchId,
            inputFingerprint: evidence.batchId, contentFingerprint: evidence.batchArtifactFingerprint,
            producedAt: manifestTime } };
        const prior = batchReferences.get(reference.key);
        if (prior && fingerprintJson(prior) !== fingerprintJson(reference))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        batchReferences.set(reference.key, reference);
      }
    }
    phase = "batch_artifacts";
    const batchEntries = await mapWithConcurrency([...batchReferences.values()].sort((a, b) =>
      a.key.localeCompare(b.key)), S3_IO_CONCURRENCY, async (reference) => {
      const stored = await runtime.artifactStore.getValidated({ key: reference.key,
        expected: reference.expected, schema: providerBatchArtifactSchema });
      return [reference.key, { stored, batch: parseProviderBatchArtifact(stored.value) }];
    });
    phase = "source_reconciliation";
    const batchByKey = new Map(batchEntries);
    for (const { task, plan, combined } of combinedEntries) {
      for (const [component, source, keySource] of [["dataforseo", "dataforseo", "dataforseo"],
        ["cruxRest", "crux_rest", "crux-rest"], ["cruxBigQuery", "crux_bigquery", "crux-bigquery"]]) {
        reconciliationContext = { itemId: task.itemKey, source, check: "component" };
        const part = combined.components[component];
        if (part.state === "skipped") continue;
        const entry = sourceByTaskComponent.get(`${task.itemKey}\0${component}`);
        const artifact = entry?.artifact;
        if (!artifact) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        reconciliationContext.check = "source_identity";
        if (artifact.shopId !== task.itemKey || artifact.source !== source || artifact.state !== part.state)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        reconciliationContext.check = "scope_keys";
        const actualScopes = artifact.scopeStates.map(({ scopeKey }) => scopeKey);
        const plannedScopes = source === "dataforseo" ? plan.sourceKeys.dataForSeo.map(({ scopeKey }) => scopeKey).sort() :
          source === "crux_rest" ? [plan.sourceKeys.cruxRest.scopeKey] : [plan.sourceKeys.cruxBigQuery.scopeKey];
        if (source === "crux_bigquery" && plannedScopes[0] === "latest") {
          const preMonthTerminal = actualScopes[0] === "latest" &&
            ["ambiguous", "unavailable", "contract_mismatch"].includes(artifact.state);
          if (actualScopes.length !== 1 ||
              (!/^month:20\d{4}$/u.test(actualScopes[0]) && !preMonthTerminal))
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        } else if (actualScopes.length !== plannedScopes.length ||
            actualScopes.some((scope, index) => scope !== plannedScopes[index]))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        reconciliationContext.check = "lead_traffic_row";
        if (artifact.leadTrafficRows.length !== 1 || artifact.leadTrafficRows[0].source !== source)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        if (source === "dataforseo") for (const evidence of artifact.requestEvidence) {
          if (evidence.disposition !== "ledger") {
            if (evidence.disposition === "not_dispatched" && evidence.reason === "work_ambiguous") {
              const selection = plan.sourceKeys.dataForSeo.find(({ scopeKey }) => scopeKey === evidence.scopeKey);
              if (!selection || selection.reuse) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
              ambiguousDataForSeoCandidates.push({ shopId: task.itemKey, identity: selection.identity,
                scopeKey: evidence.scopeKey });
            }
            continue;
          }
          let ledgerEvidence;
          if (evidence.ledgerState === "succeeded") {
            reconciliationContext.check = "batch_presence";
            const memoized = batchByKey.get(evidence.batchArtifactKey);
            if (!memoized) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
            const { stored: batchStored, batch } = memoized;
            reconciliationContext.check = "batch_contract";
            if (batch.source !== "dataforseo" || batch.runId !== message.runId ||
                batch.generation !== message.generation || batch.scopeKey !== evidence.scopeKey ||
                batch.providerRequestFingerprint !== evidence.requestFingerprint ||
                batchStored.contentFingerprint !== evidence.batchArtifactFingerprint ||
                !batch.items.some(({ shopId }) => shopId === task.itemKey))
              throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
            ledgerEvidence = { requestFingerprint: evidence.requestFingerprint, scopeKey: evidence.scopeKey,
              targetCount: evidence.targetCount, state: "succeeded",
              resultFingerprint: evidence.batchArtifactFingerprint };
          } else ledgerEvidence = { requestFingerprint: evidence.requestFingerprint, scopeKey: evidence.scopeKey,
            targetCount: evidence.targetCount, state: evidence.ledgerState, resultFingerprint: null };
          const prior = ledgerEvidenceByRequest.get(evidence.requestFingerprint);
          reconciliationContext.check = "ledger_consistency";
          if (prior && fingerprintJson(prior) !== fingerprintJson(ledgerEvidence))
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          ledgerEvidenceByRequest.set(evidence.requestFingerprint, ledgerEvidence);
        }
        cacheRows.push(...artifact.cacheRows); leadTrafficRows.push(...artifact.leadTrafficRows);
        const workType = source === "dataforseo" ? "dataforseo" : source;
        const evidenceByScope = new Map(artifact.requestEvidence.map((item) => [item.scopeKey, item]));
        for (const scope of artifact.scopeStates) {
          if (source === "dataforseo" && evidenceByScope.get(scope.scopeKey)?.disposition === "not_dispatched")
            continue;
          if (source === "crux_bigquery" && scope.scopeKey === "latest" && scope.state === "ambiguous") {
            ambiguousCruxBigQueryCandidates.push({ shopId: task.itemKey, pipelineTaskId: task.id,
              state: scope.state });
            continue;
          }
          workOutcomes.push({ shopId: task.itemKey, workType,
            scopeKey: scope.scopeKey, state: scope.state, pipelineTaskId: task.id });
        }
        diagnostics.push(...artifact.diagnostics.map((value) => ({ source, shopId: task.itemKey, value })));
        summaries[component].push(artifact.summary);
      }
    }
    const ownedAmbiguousDataForSeo = ambiguousDataForSeoCandidates.length
      ? await runtime.repository.readAwsAmbiguousDataForSeoTargets({ runId: message.runId,
        generation: message.generation, aggregationToken: token,
        candidates: ambiguousDataForSeoCandidates }) : [];
    const ambiguousDataForSeoTargetsByScope = new Map();
    for (const candidate of ownedAmbiguousDataForSeo) {
      const targets = ambiguousDataForSeoTargetsByScope.get(candidate.scopeKey) || new Map();
      const priorShop = targets.get(candidate.identity);
      if (priorShop && priorShop !== candidate.shopId)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      targets.set(candidate.identity, candidate.shopId);
      ambiguousDataForSeoTargetsByScope.set(candidate.scopeKey, targets);
    }
    for (const [scopeKey, targetsByIdentity] of [...ambiguousDataForSeoTargetsByScope.entries()]
      .sort(([left], [right]) => left.localeCompare(right))) {
      const targets = [...targetsByIdentity.keys()].sort();
      for (const targetBatch of batches(targets, DATAFORSEO_TARGET_LIMIT)) {
        const descriptor = buildDataForSeoRequest({ targets: targetBatch,
          scope: dataForSeoScopeInput(scopeKey) });
        const ledgerEvidence = { requestFingerprint: descriptor.requestFingerprint, scopeKey,
          targetCount: descriptor.targets.length, state: "ambiguous", resultFingerprint: null };
        const prior = ledgerEvidenceByRequest.get(descriptor.requestFingerprint);
        if (prior && fingerprintJson(prior) !== fingerprintJson(ledgerEvidence))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        ledgerEvidenceByRequest.set(descriptor.requestFingerprint, ledgerEvidence);
      }
    }
    if (ambiguousCruxBigQueryCandidates.length) {
      const resolved = await runtime.repository.readAwsAmbiguousCruxBigQueryWork({ runId: message.runId,
        generation: message.generation, aggregationToken: token,
        candidates: ambiguousCruxBigQueryCandidates });
      workOutcomes.push(...resolved.map((item) => ({ ...item, workType: "crux_bigquery" })));
    }
    const reuseSelections = manifest.workPlan.domains.flatMap((plan) =>
      [...plan.sourceKeys.dataForSeo, plan.sourceKeys.cruxRest, plan.sourceKeys.cruxBigQuery]
        .filter(({ reuse }) => reuse).map((selection) => ({ ...selection, ...selection.reuse })));
    phase = "reuse_rows";
    const reused = await runtime.repository.readAwsFinalReuseRows({ runId: message.runId,
      generation: message.generation, stageId: complete.stage.id, aggregationToken: token,
      selections: reuseSelections, evaluatedAt: new Date(manifest.workPlan.evaluatedAt) });
    cacheRows.push(...reused.trafficRows);
    phase = "lead_artifacts";
    const leadProfileOutcomes = [];
    const leadTaskByShop = new Map(reused.leadTasks.map((task) => [task.itemKey, task]));
    const leadPlans = [...manifest.workPlan.domains].sort((a, b) => a.shopId.localeCompare(b.shopId))
      .filter((plan) => !plan.leadReuse).map((plan) => {
        const task = leadTaskByShop.get(plan.shopId);
        if (!task?.artifactS3Key || !task.artifactFingerprint)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        return { plan, task };
      });
    const leadEntries = await mapWithConcurrency(leadPlans, S3_IO_CONCURRENCY, async ({ plan, task }) => {
      const stored = await runtime.artifactStore.getValidated({ key: task.artifactS3Key,
        expected: { ...expected(message, { ...task, stage: "lead" }, "lead-result-v1"),
          contentFingerprint: task.artifactFingerprint }, schema: leadResultArtifactSchema });
      return [plan.shopId, parseLeadResultArtifact(stored.value).result];
    });
    const leadArtifactByShop = new Map(leadEntries);
    for (const plan of [...manifest.workPlan.domains].sort((a, b) => a.shopId.localeCompare(b.shopId))) {
      if (plan.leadReuse) { leadProfileOutcomes.push({ shopId: plan.shopId, state: "existing",
        profileFingerprint: plan.leadReuse.profileFingerprint }); continue; }
      const task = leadTaskByShop.get(plan.shopId);
      if (!task?.artifactS3Key || !task.artifactFingerprint) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const artifact = leadArtifactByShop.get(plan.shopId);
      leadProfileOutcomes.push(artifact.state === "completed" && artifact.profile
        ? { shopId: plan.shopId, sourceTaskId: task.id, state: "new",
          profileFingerprint: fingerprintJson(artifact.profile), profile: artifact.profile }
        : { shopId: plan.shopId, sourceTaskId: task.id, state: "failed" });
    }
    const trafficSummary = { version: "traffic-enrichment-summary-v1",
      ...(summaries.dataforseo.length && { dataforseo: aggregateSourceSummaries(summaries.dataforseo) }),
      ...(summaries.cruxRest.length && { cruxRest: aggregateSourceSummaries(summaries.cruxRest) }),
      ...(summaries.cruxBigQuery.length && { cruxBigQuery: aggregateSourceSummaries(summaries.cruxBigQuery) }) };
    phase = "publication";
    await monitor.renewNow(); await monitor.stop();
    await runtime.repository.publishAwsFinalResults({ runId: message.runId, generation: message.generation,
      stageId: complete.stage.id, aggregationToken: token, cacheRows, leadTrafficRows,
      leadProfileOutcomes, workOutcomes,
      dataForSeoLedgerEvidence: [...ledgerEvidenceByRequest.values()].sort((a, b) =>
        a.requestFingerprint < b.requestFingerprint ? -1 : a.requestFingerprint > b.requestFingerprint ? 1 : 0),
      diagnostics, trafficSummary, status: {} }, new Date(), {
      afterStep(step) { publicationStep = step; }
    });
    return { terminal: true, outcome: "completed" };
  } catch (error) {
    if (error?.code === "PIPELINE_NOT_READY") return { terminal: true, outcome: "not_ready" };
    if (error?.code === "PIPELINE_CANCELLED") return { terminal: true, outcome: "cancelled" };
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: "final_aggregation_failed",
      runId: message.runId, stage: "traffic_crux", generation: message.generation, phase,
      ...(phase === "source_reconciliation" && reconciliationContext ? reconciliationContext : {}),
      ...(phase === "publication" && publicationStep ? { publicationStep } : {}),
      safeCode: typeof error?.code === "string" ? error.code : "PIPELINE_UNEXPECTED" }));
    throw error;
  } finally { await monitor.stop().catch(() => {}); }
}
