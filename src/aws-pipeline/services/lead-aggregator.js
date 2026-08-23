import { randomUUID } from "node:crypto";
import { materializeLeadFromProfile } from "../../pipeline.js";
import { parseShopLeadProfile } from "../../shop-persistence-contract.js";
import {
  domainStageManifestSchema, leadResultArtifactSchema,
  parseDomainStageManifest, parseLeadResultArtifact
} from "../contracts/artifacts.js";
import { aggregationCheckMessageSchema, workMessageSchema } from "../contracts/messages.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { fingerprintJson } from "../core/canonical.js";
import { createPipelineLeaseMonitor } from "../core/lease-monitor.js";
import { mapWithConcurrency } from "../core/bounded-concurrency.js";

const S3_IO_CONCURRENCY = 8;

function expectedLeadArtifact(message, task) {
  return { contractVersion: "lead-result-v1", runId: message.runId, stage: "lead",
    generation: message.generation, itemId: task.itemKey, inputFingerprint: task.inputFingerprint,
    contentFingerprint: task.artifactFingerprint,
    producedAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : new Date(task.createdAt).toISOString() };
}

export async function processLeadAggregation(message, runtime, {
  createLeaseMonitorFn = createPipelineLeaseMonitor
} = {}) {
  const token = randomUUID();
  const claim = await runtime.coordinator.claimAggregator({ runId: message.runId, stage: "lead",
    generation: message.generation, owner: `lead-aggregation-${randomUUID()}`, token,
    leaseDurationMs: 120000 }, new Date());
  if (claim.outcome !== "owned") return { terminal: true, outcome: claim.outcome };
  const monitor = createLeaseMonitorFn({ intervalMs: 40000,
    renew: (now) => runtime.coordinator.renewAggregator({ stageId: claim.stage.id, token,
      leaseDurationMs: 120000 }, now) });
  try {
    const complete = await runtime.coordinator.getCompleteStage({ runId: message.runId, stage: "lead",
      generation: message.generation, token }, new Date());
    const producedAt = complete.stage.manifestProducedAt instanceof Date
      ? complete.stage.manifestProducedAt.toISOString() : new Date(complete.stage.manifestProducedAt).toISOString();
    const storedManifest = await runtime.artifactStore.getValidated({ key: complete.stage.manifestS3Key,
      expected: { contractVersion: "domain-stage-manifest-v1", runId: message.runId, stage: "domain",
        generation: message.generation, itemId: "manifest", inputFingerprint: complete.stage.manifestFingerprint,
        contentFingerprint: complete.stage.manifestFingerprint, producedAt }, schema: domainStageManifestSchema });
    const manifest = parseDomainStageManifest(storedManifest.value);
    if (manifest.workPlan.evaluatedAt !== producedAt) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    const domainByShop = new Map(manifest.domainManifest.domains.map((entry) => [entry.shopId, entry]));
    const planByShop = new Map(manifest.workPlan.domains.map((entry) => [entry.shopId, entry]));
    const taskByShop = new Map(complete.tasks.map((task) => [task.itemKey, task]));
    const orderedTasks = [...complete.tasks].sort((a, b) => a.itemKey.localeCompare(b.itemKey));
    const artifactEntries = await mapWithConcurrency(orderedTasks, S3_IO_CONCURRENCY, async (task) => {
      if (!task.artifactS3Key || !task.artifactFingerprint) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const stored = await runtime.artifactStore.getValidated({ key: task.artifactS3Key,
        expected: expectedLeadArtifact(message, task), schema: leadResultArtifactSchema });
      const artifact = parseLeadResultArtifact(stored.value);
      if (fingerprintJson(artifact) !== task.artifactFingerprint || artifact.result.shopId !== task.itemKey ||
          artifact.result.runId !== message.runId || artifact.result.generation !== message.generation) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      return [task.itemKey, artifact.result];
    });
    const artifacts = new Map(artifactEntries);
    const reusableSelections = [];
    for (const plan of manifest.workPlan.domains) {
      const result = artifacts.get(plan.shopId);
      if (plan.leadReuse) reusableSelections.push({ shopId: plan.shopId,
        profileShopId: plan.leadReuse.profileShopId, profileFingerprint: plan.leadReuse.profileFingerprint,
        stableIdentity: domainByShop.get(plan.shopId)?.identity.stableKey });
      else if (result?.profileReusable && result.profile) reusableSelections.push({ shopId: plan.shopId,
        profileShopId: plan.shopId, profileFingerprint: fingerprintJson(parseShopLeadProfile(result.profile)),
        stableIdentity: domainByShop.get(plan.shopId)?.identity.stableKey });
    }
    const reusable = await runtime.repository.readAwsReusableProfiles({ runId: message.runId,
      generation: message.generation, stageId: complete.stage.id, aggregationToken: token,
      selections: reusableSelections, evaluatedAt: new Date(manifest.workPlan.evaluatedAt) });
    const profileByShop = new Map(reusable.profiles.map((row) => [row.shopId, parseShopLeadProfile(row.profilePayload)]));
    const outcomes = [];
    for (const plan of [...manifest.workPlan.domains].sort((a, b) => a.shopId.localeCompare(b.shopId))) {
      const domain = domainByShop.get(plan.shopId);
      const task = taskByShop.get(plan.shopId);
      const artifact = artifacts.get(plan.shopId);
      if (!domain || plan.runStoreId !== domain.runStoreId || plan.needsLead !== Boolean(task) ||
          plan.needsLead !== Boolean(artifact)) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      if (artifact && (artifact.runStoreId !== plan.runStoreId || artifact.shopId !== plan.shopId))
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const profileReusable = plan.leadReuse != null || artifact?.profileReusable === true;
      const profile = profileReusable ? profileByShop.get(plan.shopId) : artifact?.profile;
      const lead = plan.leadReuse
        ? materializeLeadFromProfile(domain.candidatePayload, profile)
        : artifact.lead;
      outcomes.push({ shopId: plan.shopId, runStoreId: plan.runStoreId,
        state: artifact?.state === "failed" ? "failed" : "completed", lead, profileReusable,
        ...(profile ? { profile } : {}), ...(artifact?.diagnostic ? { diagnostic: artifact.diagnostic } : {}),
        ...(task ? { sourceTaskId: task.id } : {}) });
    }
    const outcomeByShop = new Map(outcomes.map((entry) => [entry.shopId, entry]));
    const trafficDomains = manifest.workPlan.domains.filter((plan) => {
      const outcome = outcomeByShop.get(plan.shopId);
      return outcome?.lead?.status === "qualified" &&
        [plan.needsTraffic, plan.needsCruxRest, plan.needsCruxBigQuery].some(Boolean);
    }).sort((a, b) => a.shopId.localeCompare(b.shopId));
    await monitor.renewNow();
    await monitor.stop();
    const published = await runtime.repository.publishAwsLeadCheckpoint({ runId: message.runId,
      generation: message.generation, stageId: complete.stage.id, aggregationToken: token,
      outcomes, trafficDomains, domainStageManifestKey: complete.stage.manifestS3Key,
      domainStageManifestFingerprint: complete.stage.manifestFingerprint,
      manifestProducedAt: new Date(producedAt), status: { stage: "aws_traffic_crux",
        storesProcessed: outcomes.length, outputRows: outcomes.length } }, new Date());
    const messages = published.dispatchItems.map((task) => ({ version: 1, type: "traffic.domain",
      runId: message.runId, stage: "traffic_crux", generation: message.generation,
      itemId: task.itemKey, manifestKey: complete.stage.manifestS3Key,
      manifestFingerprint: complete.stage.manifestFingerprint, manifestProducedAt: producedAt, attempt: 1 }));
    const sent = await runtime.dispatcher.sendMany(runtime.config.awsPipelineTrafficQueueUrl, messages, workMessageSchema);
    if (sent.sentItemIds.length) await runtime.coordinator.recordDispatch({ stageId: published.trafficStage.id,
      itemKeys: sent.sentItemIds }, new Date());
    if (!published.dispatchItems.length) await runtime.dispatcher.sendOne(
      runtime.config.awsPipelineFinalAggregationQueueUrl, { version: 1, type: "aggregation.check",
        runId: message.runId, stage: "traffic_crux", generation: message.generation,
        reason: "zero_expected", attempt: 1 }, aggregationCheckMessageSchema);
    return { terminal: true, outcome: "completed", summary: published.summary,
      failedItemIds: sent.failedItemIds };
  } catch (error) { await monitor.stop().catch(() => {}); throw error; }
}
