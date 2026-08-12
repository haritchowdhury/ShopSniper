import { confirmedQueryManifestSchema, parseConfirmedQueryManifest } from "../contracts/artifacts.js";
import { aggregationCheckMessageSchema, workMessageSchema } from "../contracts/messages.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { fingerprintJson } from "../core/canonical.js";
import { queryManifestKey } from "../core/keys.js";
import { parseAwsProviderConfig } from "../contracts/aws-provider-config.js";

export async function dispatchConfirmedQueries(input, runtime) {
  if (input.generation !== 1 || !(input.queriesConfirmedAt instanceof Date) ||
      Number.isNaN(input.queriesConfirmedAt.getTime())) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const awsProviderConfig = parseAwsProviderConfig(input.awsProviderConfig);
  const categories = input.categories.map((category, categoryIndex) => ({
    categoryIndex, originalShopType: category.originalShopType, shopType: category.shopType,
    businessQualifier: category.businessQualifier,
    categoryVocabulary: [...new Set(input.queries.filter((query) => query.categoryIndex === categoryIndex)
      .flatMap((query) => query.categoryVocabulary || []))].sort()
  }));
  const queries = [...input.queries].sort((left, right) => left.sequence - right.sequence).map((query) => ({
    id: query.id, categoryIndex: query.categoryIndex, sequence: query.sequence, query: query.query,
    source: query.source, validationState: query.validationState, queryScore: query.queryScore,
    generationReason: query.generationReason || "", sourceUrls: query.sourceUrls || [],
    categoryVocabulary: query.categoryVocabulary || [], probeContractVersion: query.probeContractVersion,
    probeFingerprint: query.probeFingerprint, probeResults: query.probeResults
  }));
  const manifest = parseConfirmedQueryManifest({ contractVersion: "confirmed-query-manifest-v1", runId: input.runId,
    generation: 1, confirmedRevision: input.confirmedRevision, awsProviderConfig, categories, queries });
  const manifestFingerprint = fingerprintJson(manifest);
  const producedAt = input.queriesConfirmedAt.toISOString();
  const key = queryManifestKey(input.runId);
  await runtime.artifactStore.putImmutable({ contractVersion: manifest.contractVersion, runId: input.runId,
    stage: "discovery", generation: 1, itemId: "manifest", inputFingerprint: manifestFingerprint,
    producedAt, key, value: manifest, schema: confirmedQueryManifestSchema });
  const tasks = queries.map((query) => ({ itemKey: query.id, inputFingerprint: fingerprintJson({
    contractVersion: "discovery-query-input-v1", runId: manifest.runId, generation: manifest.generation,
    confirmedRevision: manifest.confirmedRevision, manifestFingerprint, query
  }) }));
  const published = await runtime.repository.publishAwsDiscoveryStage({ ...input, manifestS3Key: key,
    manifestFingerprint, manifestProducedAt: input.queriesConfirmedAt, awsProviderConfig, tasks }, new Date());
  const messages = published.dispatchItems.map((task) => ({ version: 1, type: "discovery.query", runId: input.runId,
    stage: "discovery", generation: 1, itemId: task.itemKey, manifestKey: key, manifestFingerprint,
    manifestProducedAt: producedAt, attempt: 1 }));
  const sent = await runtime.dispatcher.sendMany(runtime.config.awsPipelineDiscoveryQueueUrl, messages, workMessageSchema);
  if (sent.sentItemIds.length) await runtime.coordinator.recordDispatch({ stageId: published.stage.id, itemKeys: sent.sentItemIds }, new Date());
  if (!tasks.length) await runtime.dispatcher.sendOne(runtime.config.awsPipelineDomainAggregationQueueUrl,
    { version: 1, type: "aggregation.check", runId: input.runId, stage: "discovery", generation: 1,
      reason: "zero_expected", attempt: 1 }, aggregationCheckMessageSchema);
  return { manifest, stage: published.stage, sent };
}
