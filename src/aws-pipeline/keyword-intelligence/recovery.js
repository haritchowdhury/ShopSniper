import { PipelineInvariantError } from "../contracts/errors.js";
import {
  KEYWORD_MESSAGE_INITIALIZE,
  KEYWORD_MESSAGE_EXPANSION_TASK,
  KEYWORD_MESSAGE_OVERVIEW_TASK,
  KEYWORD_MESSAGE_AGGREGATE_CHECK,
  KEYWORD_ENDPOINT_OVERVIEW,
  KEYWORD_RUNTIME_CONFIG_INVALID,
  KeywordContractError,
  keywordMessageSchema
} from "./contracts.js";

function queueUrlOf(runtime) {
  const url = runtime.config?.awsPipelineKeywordResearchQueueUrl;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new KeywordContractError(KEYWORD_RUNTIME_CONFIG_INVALID);
  }
  if (parsed.protocol !== "https:") throw new KeywordContractError(KEYWORD_RUNTIME_CONFIG_INVALID);
  return url;
}

export async function recoverKeywordWork({ now, limit = 100 }, runtime) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  const queueUrl = queueUrlOf(runtime);
  const recovered = await runtime.repository.recover(now);
  if (recovered.outcome !== "found") throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");

  let sent = 0;
  for (const initialization of recovered.initializations) {
    const message = {
      contractVersion: 1, type: KEYWORD_MESSAGE_INITIALIZE,
      researchId: initialization.researchId, generation: initialization.generation
    };
    const result = await runtime.dispatcher.sendOne(queueUrl, message, keywordMessageSchema);
    sent += result.sentItemIds.length;
  }
  for (const task of recovered.taskDispatches) {
    const isOverview = task.endpointKey === KEYWORD_ENDPOINT_OVERVIEW;
    const message = {
      contractVersion: 1,
      type: isOverview ? KEYWORD_MESSAGE_OVERVIEW_TASK : KEYWORD_MESSAGE_EXPANSION_TASK,
      researchId: task.researchId,
      generation: task.generation,
      stage: isOverview ? task.stage : "expansion",
      taskNaturalId: task.taskId,
      inputFingerprint: task.inputFingerprint
    };
    const result = await runtime.dispatcher.sendOne(queueUrl, message, keywordMessageSchema);
    sent += result.sentItemIds.length;
  }
  for (const check of recovered.aggregateChecks) {
    const message = {
      contractVersion: 1, type: KEYWORD_MESSAGE_AGGREGATE_CHECK,
      researchId: check.researchId,
      generation: check.generation,
      stage: check.stage,
      stageInputFingerprint: check.stageInputFingerprint
    };
    const result = await runtime.dispatcher.sendOne(queueUrl, message, keywordMessageSchema);
    sent += result.sentItemIds.length;
  }
  return {
    initializations: recovered.initializations.length,
    taskDispatches: recovered.taskDispatches.length,
    aggregateChecks: recovered.aggregateChecks.length,
    sent
  };
}