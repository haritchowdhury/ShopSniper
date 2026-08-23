import { randomUUID } from "node:crypto";
import { normalizeWithAi } from "../../ai-normalizer.js";
import {
  discoverLeadForRunStoreWithFetcher,
  failedLeadForRunStore,
  materializeLeadFromProfile
} from "../../pipeline.js";
import { parseAwsProviderConfig } from "../contracts/aws-provider-config.js";
import {
  aiNormalizationAttemptArtifactSchema,
  browserlessAttemptArtifactSchema,
  domainCandidateArtifactSchema,
  domainStageManifestSchema,
  leadResultArtifactSchema,
  parseAiNormalizationAttemptArtifact,
  parseBrowserlessAttemptArtifact,
  parseDomainCandidateArtifact,
  parseDomainStageManifest,
  parseLeadResultArtifact
} from "../contracts/artifacts.js";
import { aggregationCheckMessageSchema } from "../contracts/messages.js";
import { PipelineInvariantError, safePipelineError } from "../contracts/errors.js";
import { fingerprintJson } from "../core/canonical.js";
import { aiNormalizationAttemptKey, browserlessAttemptArtifactKey, leadArtifactKey } from "../core/keys.js";
import {
  createPipelineLeaseMonitor,
  preparePipelineTerminalLease
} from "../core/lease-monitor.js";
import { executeBrowserlessDomainBatch } from "../lead/browserless-function-client.js";
import { fetchAwsDomainPages } from "../lead/domain-page-fetcher.js";

function leadInputFingerprint(message, selection) {
  return fingerprintJson({ contractVersion: "lead-domain-input-v1", runId: message.runId,
    generation: message.generation, manifestFingerprint: message.manifestFingerprint,
    shopId: selection.shopId, candidateFingerprint: selection.candidateFingerprint });
}

function artifactExpected({ message, task, inputFingerprint, contractVersion, itemId }) {
  return { contractVersion, runId: message.runId, stage: "lead",
    generation: message.generation, itemId, inputFingerprint,
    producedAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : new Date(task.createdAt).toISOString() };
}

export async function processLeadMessage(message, runtime) {
  const manifestStored = await runtime.artifactStore.getValidated({ key: message.manifestKey,
    expected: { contractVersion: "domain-stage-manifest-v1", runId: message.runId,
      stage: "domain", generation: message.generation, itemId: "manifest",
      inputFingerprint: message.manifestFingerprint, contentFingerprint: message.manifestFingerprint,
      producedAt: message.manifestProducedAt }, schema: domainStageManifestSchema });
  const manifest = parseDomainStageManifest(manifestStored.value);
  const providerConfig = parseAwsProviderConfig(manifest.workPlan.awsProviderConfig);
  const selection = manifest.workPlan.domains.find((entry) => entry.shopId === message.itemId);
  const domain = manifest.domainManifest.domains.find((entry) => entry.shopId === message.itemId);
  if (!selection?.needsLead || !domain || selection.candidateFingerprint !== fingerprintJson({
    contractVersion: "domain-candidate-v1", runId: message.runId, generation: message.generation,
    shopId: domain.shopId, runStoreId: domain.runStoreId, identity: domain.identity,
    candidatePayload: domain.candidatePayload })) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const candidateStored = await runtime.artifactStore.getValidated({ key: selection.candidateKey,
    expected: { contractVersion: "domain-candidate-v1", runId: message.runId, stage: "domain",
      generation: message.generation, itemId: selection.shopId,
      inputFingerprint: selection.candidateFingerprint, contentFingerprint: selection.candidateFingerprint,
      producedAt: manifest.workPlan.evaluatedAt }, schema: domainCandidateArtifactSchema });
  const candidate = parseDomainCandidateArtifact(candidateStored.value);
  const inputFingerprint = leadInputFingerprint(message, selection);
  const token = randomUUID();
  const claimed = await runtime.coordinator.claimTask({ runId: message.runId, stage: "lead",
    generation: message.generation, itemKey: message.itemId, inputFingerprint,
    owner: `lead-${randomUUID()}`, token, leaseDurationMs: 60000 }, new Date());
  if (claimed.outcome === "busy") return { terminal: false, outcome: "busy" };
  if (claimed.outcome === "cancelled") return { terminal: true, outcome: "cancelled" };
  if (claimed.outcome === "terminal") return { terminal: true, outcome: "replayed" };
  const monitor = createPipelineLeaseMonitor({ intervalMs: 20000,
    renew: (now) => runtime.coordinator.renewTask({ taskId: claimed.task.id, token,
      leaseDurationMs: 60000 }, now) });
  const expected = artifactExpected({ message, task: claimed.task, inputFingerprint,
    contractVersion: "lead-result-v1", itemId: message.itemId });
  const key = leadArtifactKey(message.runId, message.itemId);
  try {
    monitor.assertActive();
    let stored = await runtime.artifactStore.getOptionalValidated({ key, expected,
      schema: leadResultArtifactSchema });
    if (stored.outcome === "missing") {
      const work = await runtime.repository.claimAwsLeadWork({ runId: message.runId,
        generation: message.generation, taskId: claimed.task.id, taskToken: token,
        shopId: message.itemId }, new Date());
      if (work.outcome === "busy") { await monitor.stop(); return { terminal: false, outcome: "busy" }; }
      if (work.outcome === "cancelled") { await monitor.stop(); return { terminal: true, outcome: "cancelled" }; }
      let lead;
      let profile;
      let safeErrorCode;
      if (work.outcome === "completed") {
        profile = work.profile;
        lead = materializeLeadFromProfile(candidate.candidatePayload, profile);
      } else if (["failed", "ambiguous"].includes(work.outcome)) {
        safeErrorCode = work.safeErrorCode || "PIPELINE_PROVIDER_AMBIGUOUS";
        lead = failedLeadForRunStore(candidate.candidatePayload, { name: "Error" });
      } else {
        const taskContext = { runId: message.runId, generation: message.generation,
          shopId: message.itemId, taskId: claimed.task.id, taskToken: token,
          taskInputFingerprint: inputFingerprint, taskCreatedAt: expected.producedAt,
          assertActive: () => monitor.assertActive() };
        const browserlessConfig = { ...providerConfig.browserless,
          primaryToken: runtime.secrets?.browserlessToken || "",
          fallbackToken: runtime.secrets?.browserlessFallbackToken || "" };
        if (browserlessConfig.primaryConfigured !== Boolean(browserlessConfig.primaryToken) ||
            browserlessConfig.fallbackConfigured !== Boolean(browserlessConfig.fallbackToken))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        const executeBrowserless = async (browserlessInput) => {
          const pagePlanFingerprint = fingerprintJson({ contractVersion: "browserless-page-plan-v1",
            pages: browserlessInput.pages, allowedHostnames: browserlessInput.allowedHostnames });
          const markerKey = browserlessAttemptArtifactKey(message.runId, message.itemId);
          const markerExpected = artifactExpected({ message, task: claimed.task, inputFingerprint,
            contractVersion: "browserless-attempt-v1", itemId: message.itemId });
          const prior = await runtime.artifactStore.getOptionalValidated({ key: markerKey,
            expected: markerExpected, schema: browserlessAttemptArtifactSchema });
          if (prior.outcome === "found") throw new PipelineInvariantError("PIPELINE_PROVIDER_AMBIGUOUS");
          const marker = parseBrowserlessAttemptArtifact({ contractVersion: "browserless-attempt-v1",
            runId: message.runId, generation: message.generation, shopId: message.itemId,
            taskInputFingerprint: inputFingerprint, pagePlanFingerprint });
          await runtime.artifactStore.putImmutable({ key: markerKey, ...markerExpected,
            value: marker, schema: browserlessAttemptArtifactSchema });
          return executeBrowserlessDomainBatch({ ...browserlessInput, config: browserlessConfig });
        };
        const aiConfig = { enableAiNormalization: providerConfig.aiNormalization.enabled,
          openaiModel: providerConfig.aiNormalization.model,
          requestTimeoutMs: providerConfig.aiNormalization.requestTimeoutMs,
          openaiApiKey: runtime.secrets?.openaiApiKey || "" };
        if (providerConfig.aiNormalization.enabled && !aiConfig.openaiApiKey)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        const normalizeAi = (leadCandidate, evidence) => normalizeWithAi(leadCandidate, evidence, aiConfig, {
          beforeDispatch: async ({ inputFingerprint: normalizationInputFingerprint, clientRequestId }) => {
            monitor.assertActive();
            const markerKey = aiNormalizationAttemptKey(message.runId, message.itemId);
            const markerExpected = artifactExpected({ message, task: claimed.task, inputFingerprint,
              contractVersion: "ai-normalization-attempt-v1", itemId: message.itemId });
            const prior = await runtime.artifactStore.getOptionalValidated({ key: markerKey,
              expected: markerExpected, schema: aiNormalizationAttemptArtifactSchema });
            if (prior.outcome === "found") return "skip";
            const marker = parseAiNormalizationAttemptArtifact({ contractVersion: "ai-normalization-attempt-v1",
              runId: message.runId, generation: message.generation, shopId: message.itemId,
              taskInputFingerprint: inputFingerprint, normalizationInputFingerprint, clientRequestId });
            await runtime.artifactStore.putImmutable({ key: markerKey, ...markerExpected,
              value: marker, schema: aiNormalizationAttemptArtifactSchema });
            return "dispatch";
          }
        });
        try {
          ({ lead, profile } = await discoverLeadForRunStoreWithFetcher({ ...providerConfig.leadFetch,
            ...aiConfig }, { candidatePayload: candidate.candidatePayload },
            ({ candidate: value }) => fetchAwsDomainPages({ candidate: value, taskContext,
              config: { leadFetch: providerConfig.leadFetch, browserless: browserlessConfig } },
              { executeBrowserless }), { normalizeAi }));
        } catch (error) {
          const safe = safePipelineError(error, "PIPELINE_PROVIDER_UNAVAILABLE");
          safeErrorCode = safe.code;
          lead = failedLeadForRunStore(candidate.candidatePayload, error);
        }
      }
      const state = lead.status === "failed" ? "failed" : lead.status === "rejected" ? "rejected" : "completed";
      const artifact = parseLeadResultArtifact({ contractVersion: "lead-result-v1", result: {
        runId: message.runId, generation: message.generation, shopId: message.itemId,
        runStoreId: selection.runStoreId, state, profileReusable: work.outcome === "completed",
        ...(profile ? { profile } : {}), lead,
        ...(safeErrorCode ? { diagnostic: { scope: "store", code: safeErrorCode,
          shop_type: lead.shop_type || "", business_qualifier: lead.business_qualifier || "unspecified",
          details: {} } } : {}) } });
      await runtime.artifactStore.putImmutable({ key, ...expected, value: artifact,
        schema: leadResultArtifactSchema });
      stored = { outcome: "found", value: artifact, contentFingerprint: fingerprintJson(artifact) };
    }
    const artifact = parseLeadResultArtifact(stored.value);
    const artifactFingerprint = stored.contentFingerprint || fingerprintJson(artifact);
    await preparePipelineTerminalLease(monitor);
    const terminalState = artifact.result.state === "failed" ? "failed" : "succeeded";
    const safe = artifact.result.diagnostic?.code;
    const terminal = await runtime.coordinator.recordTerminal({ taskId: claimed.task.id, token,
      inputFingerprint, state: terminalState, artifactS3Key: key, artifactFingerprint,
      ...(safe ? { safeErrorCode: safe, safeErrorMessage: safe } : {}) }, new Date());
    await runtime.dispatcher.sendOne(runtime.config.awsPipelineLeadAggregationQueueUrl, {
      version: 1, type: "aggregation.check", runId: message.runId, stage: "lead",
      generation: message.generation, reason: "terminal_task_recorded", attempt: 1
    }, aggregationCheckMessageSchema);
    return { terminal: true, outcome: terminal.outcome === "replayed" ? "replayed" :
      terminalState === "failed" ? "failed" : "recorded" };
  } catch (error) { await monitor.stop().catch(() => {}); throw error; }
}
