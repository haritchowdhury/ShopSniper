import { randomUUID } from "node:crypto";
import { domainStageManifestSchema, leadResultArtifactSchema, parseCombinedTrafficCruxResult,
  parseDomainStageManifest, parseLeadResultArtifact, parseProviderSourceArtifact,
  providerSourceArtifactSchema, combinedTrafficCruxResultSchema } from "../contracts/artifacts.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { fingerprintJson } from "../core/canonical.js";
import { providerArtifactKey } from "../core/keys.js";
import { createPipelineLeaseMonitor } from "../core/lease-monitor.js";

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
  const token = randomUUID();
  const claim = await runtime.coordinator.claimAggregator({ runId: message.runId, stage: "traffic_crux",
    generation: message.generation, owner: `final-aggregation-${randomUUID()}`, token,
    leaseDurationMs: 120000 }, new Date());
  if (claim.outcome !== "owned") return { terminal: true, outcome: claim.outcome };
  const monitor = createLeaseMonitorFn({ intervalMs: 40000,
    renew: (now) => runtime.coordinator.renewAggregator({ stageId: claim.stage.id, token,
      leaseDurationMs: 120000 }, now) });
  try {
    const complete = await runtime.coordinator.getCompleteStage({ runId: message.runId,
      stage: "traffic_crux", generation: message.generation, token });
    if (complete.tasks.some(({ state }) => state !== "succeeded"))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
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
    const summaries = { dataforseo: [], cruxRest: [], cruxBigQuery: [] };
    for (const task of complete.tasks) {
      const plan = planByShop.get(task.itemKey);
      if (!plan || !task.artifactS3Key || !task.artifactFingerprint)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const stored = await runtime.artifactStore.getValidated({ key: task.artifactS3Key,
        expected: expected(message, task, "combined-traffic-crux-result-v1"),
        schema: combinedTrafficCruxResultSchema });
      const combined = parseCombinedTrafficCruxResult(stored.value);
      if (combined.shopId !== task.itemKey) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      for (const [component, source, keySource] of [["dataforseo", "dataforseo", "dataforseo"],
        ["cruxRest", "crux_rest", "crux-rest"], ["cruxBigQuery", "crux_bigquery", "crux-bigquery"]]) {
        const part = combined.components[component];
        if (part.state === "skipped") continue;
        const key = providerArtifactKey(message.runId, task.itemKey, keySource);
        if (part.artifactKey !== key) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        const sourceStored = await runtime.artifactStore.getValidated({ key,
          expected: { ...expected(message, task, "provider-source-result-v1"), contentFingerprint: undefined },
          schema: providerSourceArtifactSchema });
        const artifact = parseProviderSourceArtifact(sourceStored.value);
        if (artifact.shopId !== task.itemKey || artifact.source !== source || artifact.state !== part.state)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        const actualScopes = artifact.scopeStates.map(({ scopeKey }) => scopeKey);
        const plannedScopes = source === "dataforseo" ? plan.sourceKeys.dataForSeo.map(({ scopeKey }) => scopeKey).sort() :
          source === "crux_rest" ? [plan.sourceKeys.cruxRest.scopeKey] : [plan.sourceKeys.cruxBigQuery.scopeKey];
        if (source === "crux_bigquery" && plannedScopes[0] === "latest") {
          if (actualScopes.length !== 1 || !/^month:20\d{4}$/u.test(actualScopes[0]))
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        } else if (actualScopes.length !== plannedScopes.length ||
            actualScopes.some((scope, index) => scope !== plannedScopes[index]))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        if (artifact.leadTrafficRows.length !== 1 || artifact.leadTrafficRows[0].source !== source)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        cacheRows.push(...artifact.cacheRows); leadTrafficRows.push(...artifact.leadTrafficRows);
        const workType = source === "dataforseo" ? "dataforseo" : source;
        for (const scope of artifact.scopeStates) workOutcomes.push({ shopId: task.itemKey, workType,
          scopeKey: scope.scopeKey, state: scope.state, pipelineTaskId: task.id });
        diagnostics.push(...artifact.diagnostics.map((value) => ({ source, shopId: task.itemKey, value })));
        summaries[component].push(artifact.summary);
      }
    }
    const reuseSelections = manifest.workPlan.domains.flatMap((plan) =>
      [...plan.sourceKeys.dataForSeo, plan.sourceKeys.cruxRest, plan.sourceKeys.cruxBigQuery]
        .filter(({ reuse }) => reuse).map((selection) => ({ ...selection, ...selection.reuse })));
    const reused = await runtime.repository.readAwsFinalReuseRows({ runId: message.runId,
      generation: message.generation, stageId: complete.stage.id, aggregationToken: token,
      selections: reuseSelections, evaluatedAt: new Date(manifest.workPlan.evaluatedAt) });
    cacheRows.push(...reused.trafficRows);
    const leadProfileOutcomes = [];
    const leadTaskByShop = new Map(reused.leadTasks.map((task) => [task.itemKey, task]));
    for (const plan of [...manifest.workPlan.domains].sort((a, b) => a.shopId.localeCompare(b.shopId))) {
      if (plan.leadReuse) { leadProfileOutcomes.push({ shopId: plan.shopId, state: "existing",
        profileFingerprint: plan.leadReuse.profileFingerprint }); continue; }
      const task = leadTaskByShop.get(plan.shopId);
      if (!task?.artifactS3Key || !task.artifactFingerprint) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const stored = await runtime.artifactStore.getValidated({ key: task.artifactS3Key,
        expected: { ...expected(message, { ...task, stage: "lead" }, "lead-result-v1"),
          contentFingerprint: task.artifactFingerprint }, schema: leadResultArtifactSchema });
      const artifact = parseLeadResultArtifact(stored.value).result;
      leadProfileOutcomes.push(artifact.state === "completed" && artifact.profile
        ? { shopId: plan.shopId, sourceTaskId: task.id, state: "new",
          profileFingerprint: fingerprintJson(artifact.profile), profile: artifact.profile }
        : { shopId: plan.shopId, sourceTaskId: task.id, state: "failed" });
    }
    const trafficSummary = { version: "traffic-enrichment-summary-v1",
      ...(summaries.dataforseo.length && { dataforseo: aggregateSourceSummaries(summaries.dataforseo) }),
      ...(summaries.cruxRest.length && { cruxRest: aggregateSourceSummaries(summaries.cruxRest) }),
      ...(summaries.cruxBigQuery.length && { cruxBigQuery: aggregateSourceSummaries(summaries.cruxBigQuery) }) };
    await monitor.renewNow(); await monitor.stop();
    await runtime.repository.publishAwsFinalResults({ runId: message.runId, generation: message.generation,
      stageId: complete.stage.id, aggregationToken: token, cacheRows, leadTrafficRows,
      leadProfileOutcomes, workOutcomes, diagnostics, trafficSummary, status: {} }, new Date());
    return { terminal: true, outcome: "completed" };
  } catch (error) {
    if (error?.code === "PIPELINE_NOT_READY") return { terminal: true, outcome: "not_ready" };
    if (error?.code === "PIPELINE_CANCELLED") return { terminal: true, outcome: "cancelled" };
    throw error;
  } finally { await monitor.stop().catch(() => {}); }
}
