import { randomUUID } from "node:crypto";
import { PipelineInvariantError } from "../contracts/errors.js";
import { createPipelineLeaseMonitor } from "../core/lease-monitor.js";
import { isLeadFindingConfig, parseKeywordResearchConfig } from "../../keyword-intelligence/config.js";
import { isInformational } from "../../keyword-intelligence/intent.js";
import { computeResearchResult, resultFingerprint } from "../../keyword-intelligence/pipeline.js";
import { compareLeadFindingShortlist } from "../../keyword-intelligence/score.js";
import { createDefaultSelection } from "../../keyword-intelligence/selection.js";
import { executeProviderAttempt } from "./dataforseo-labs-adapter.js";
import {
  KEYWORD_MESSAGE_INITIALIZE,
  KEYWORD_MESSAGE_EXPANSION_TASK,
  KEYWORD_MESSAGE_OVERVIEW_TASK,
  KEYWORD_MESSAGE_AGGREGATE_CHECK,
  KEYWORD_ENDPOINT_SUGGESTIONS,
  KEYWORD_ENDPOINT_RELATED,
  KEYWORD_ENDPOINT_OVERVIEW,
  KEYWORD_REMAINING_MARKET_CODES,
  KEYWORD_PROVIDER_AMBIGUOUS,
  KEYWORD_PROVIDER_BUDGET_EXHAUSTED,
  KEYWORD_PROVIDER_RETRY_EXHAUSTED,
  KEYWORD_PROVIDER_RETRYABLE,
  KEYWORD_PROVIDER_AUTH_FAILED,
  KEYWORD_PROVIDER_CONTRACT_MISMATCH,
  KEYWORD_PROVIDER_TASK_FAILED,
  KEYWORD_RUNTIME_CONFIG_INVALID,
  KEYWORD_RESEARCH_STAGE_FAILED,
  KEYWORD_ARTIFACT_EXPANSION_RESULT,
  KEYWORD_ARTIFACT_EXPANSION_MANIFEST,
  KEYWORD_ARTIFACT_ANCHOR_RESULT,
  KEYWORD_ARTIFACT_SHORTLIST_MANIFEST,
  KEYWORD_ARTIFACT_MARKET_RESULT,
  KEYWORD_ARTIFACT_MARKET_MANIFEST,
  KEYWORD_ARTIFACT_RESEARCH_RESULT,
  KeywordContractError,
  keywordExpansionResultSchema,
  keywordExpansionManifestSchema,
  keywordAnchorScreenResultSchema,
  keywordShortlistManifestSchema,
  keywordMarketOverviewResultSchema,
  keywordMarketOverviewManifestSchema,
  keywordResearchResultArtifactSchema,
  keywordMessageSchema,
  suggestionRequestSchema,
  relatedRequestSchema,
  overviewRequestSchema
} from "./contracts.js";
import {
  keywordTaskArtifactKey,
  keywordManifestKey,
  keywordResultKey,
  keywordRequestFingerprint,
  keywordTaskInputFingerprint,
  keywordStageInputFingerprint
} from "./keys.js";
import { fingerprintJson } from "../core/canonical.js";

function invariant(code = "PIPELINE_INPUT_CONFLICT") {
  throw new PipelineInvariantError(code);
}

function nowOf(runtime) {
  const value = typeof runtime.clock === "function" ? runtime.clock() : new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invariant();
  return value;
}

const LEASE_LOST_CODE = "PIPELINE_LEASE_LOST";

function leaseLostError() {
  const error = new Error(LEASE_LOST_CODE);
  error.code = LEASE_LOST_CODE;
  return error;
}

function createKeywordLeaseMonitor({ kind, runtime, createLeaseMonitor, taskId, token, researchId, stage, generation }) {
  const factory = createLeaseMonitor ?? createPipelineLeaseMonitor;
  if (kind === "task") {
    return factory({
      intervalMs: 20000,
      now: () => nowOf(runtime),
      renew: async (now) => {
        const renewed = await runtime.repository.heartbeat({ taskId, token }, now);
        if (renewed.outcome !== "claimed") throw leaseLostError();
        return renewed;
      }
    });
  }
  if (kind === "aggregation") {
    return factory({
      intervalMs: 40000,
      now: () => nowOf(runtime),
      renew: async (now) => {
        const renewed = await runtime.repository.heartbeatAggregator({ researchId, stage, generation, token }, now);
        if (renewed.outcome !== "claimed") throw leaseLostError();
        return renewed;
      }
    });
  }
  invariant();
}

async function withLeaseBoundary(monitor, operation) {
  monitor.assertActive();
  const result = await operation();
  monitor.assertActive();
  return result;
}

async function prepareTerminalLease(monitor) {
  await monitor.renewNow();
  await monitor.stop();
  monitor.assertActive();
}

async function stopReleasedLease(monitor) {
  try {
    await monitor.stop();
  } catch (error) {
    if (error?.code !== LEASE_LOST_CODE) throw error;
  }
}

function httpOf(runtime) {
  return typeof runtime.http === "function" ? runtime.http : globalThis.fetch;
}

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

function configOf(research) {
  const result = parseKeywordResearchConfig(research.configSnapshot);
  if (!result.ok) invariant();
  return result.data;
}

function parseRequest(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) invariant();
  return result.data;
}

function ownerOf(kind) {
  return `${kind}-${randomUUID()}`;
}

function newToken() {
  return randomUUID().replaceAll("-", "");
}

function requestSchemaFor(endpointKey) {
  if (endpointKey === KEYWORD_ENDPOINT_SUGGESTIONS) return suggestionRequestSchema;
  if (endpointKey === KEYWORD_ENDPOINT_RELATED) return relatedRequestSchema;
  if (endpointKey === KEYWORD_ENDPOINT_OVERVIEW) return overviewRequestSchema;
  return null;
}

function expansionRequestForTask(task, research, config) {
  const match = /^(\d+):(suggestions|related)$/u.exec(task.itemKey);
  if (!match) invariant();
  const index = Number(match[1]);
  const endpoint = match[2];
  if (!Number.isInteger(index) || index < 0 || index >= research.seeds.length) invariant();
  const endpointKey = endpoint === "suggestions" ? KEYWORD_ENDPOINT_SUGGESTIONS : KEYWORD_ENDPOINT_RELATED;
  if (endpointKey !== task.endpointKey) invariant();
  const schema = requestSchemaFor(endpointKey);
  if (!schema) invariant();
  const extra = endpointKey === KEYWORD_ENDPOINT_RELATED ? { depth: config.expansion.relatedDepth } : {};
  const request = parseRequest(schema, {
    keyword: research.seeds[index],
    location_code: config.expansionAnchor.locationCode,
    language_code: config.expansionAnchor.languageCode,
    limit: endpointKey === KEYWORD_ENDPOINT_SUGGESTIONS
      ? config.expansion.suggestionsLimit : config.expansion.relatedLimit,
    ...extra
  });
  return {
    request,
    inputFingerprint: keywordTaskInputFingerprint({
      contractVersion: "keyword-expansion-input-v1", researchId: research.id,
      generation: research.generation, payload: { seed: research.seeds[index], endpointKey }
    })
  };
}

async function overviewRequestForTask(task, message, context, runtime, config) {
  const marketCode = task.itemKey.split(":")[0];
  if (message.stage !== context.stage.stage) invariant();
  let inputKeywords;
  let manifestStage;
  let contractVersion;
  if (message.stage === "anchor_screen") {
    if (marketCode !== "US") invariant();
    manifestStage = "expansion";
    contractVersion = KEYWORD_ARTIFACT_EXPANSION_MANIFEST;
    const manifest = await readManifest(runtime, context.research, context.stage, manifestStage, contractVersion,
      keywordExpansionManifestSchema);
    inputKeywords = manifest.candidates.map((entry) => entry.keyword);
  } else if (message.stage === "market_overview") {
    if (!KEYWORD_REMAINING_MARKET_CODES.includes(marketCode)) invariant();
    manifestStage = "anchor_screen";
    contractVersion = KEYWORD_ARTIFACT_SHORTLIST_MANIFEST;
    const manifest = await readManifest(runtime, context.research, context.stage, manifestStage, contractVersion,
      keywordShortlistManifestSchema);
    inputKeywords = manifest.keywords;
  } else {
    invariant();
  }
  const market = config.markets.find((entry) => entry.code === marketCode);
  if (!market) invariant();
  const request = parseRequest(overviewRequestSchema, {
    keywords: inputKeywords,
    location_code: market.locationCode,
    language_code: market.languageCode
  });
  const inputFingerprint = keywordTaskInputFingerprint({
    contractVersion: message.stage === "anchor_screen" ? "keyword-anchor-input-v1" : "keyword-market-input-v1",
    researchId: context.research.id,
    generation: context.research.generation,
    payload: message.stage === "anchor_screen" ? { candidates: inputKeywords } : { code: marketCode, keywords: inputKeywords }
  });
  return { request, inputFingerprint, marketCode };
}

async function sendKeywordMessage(runtime, message, schema, options) {
  const sent = await runtime.dispatcher.sendOne(queueUrlOf(runtime), message, schema, options);
  if (sent.sentItemIds.length !== 1) return false;
  return true;
}

async function sendCheck(runtime, { researchId, generation, stage, tasks }) {
  const stageInputFingerprint = keywordStageInputFingerprint({ researchId, generation, stage, tasks });
  return sendKeywordMessage(runtime, {
    contractVersion: 1, type: KEYWORD_MESSAGE_AGGREGATE_CHECK,
    researchId, generation, stage, stageInputFingerprint
  }, keywordMessageSchema);
}

export async function processKeywordMessage(message, runtime, dependencies = {}) {
  if (message.type === KEYWORD_MESSAGE_INITIALIZE) return processInitialize(message, runtime, dependencies);
  if (message.type === KEYWORD_MESSAGE_EXPANSION_TASK) return processTask(message, runtime, "expansion", dependencies);
  if (message.type === KEYWORD_MESSAGE_OVERVIEW_TASK) return processTask(message, runtime, "overview", dependencies);
  if (message.type === KEYWORD_MESSAGE_AGGREGATE_CHECK) return processAggregateCheck(message, runtime, dependencies);
  invariant();
}

export async function processInitialize(message, runtime) {
  const loaded = await runtime.repository.getWorkerResearch({
    researchId: message.researchId, generation: message.generation
  });
  if (loaded.outcome !== "found") return { terminal: true, outcome: loaded.outcome };
  const research = loaded.research;
  const config = configOf(research);
  const tasks = [];
  for (let index = 0; index < research.seeds.length; index += 1) {
    const seed = research.seeds[index];
    for (const [endpointKey, suffix] of [
      [KEYWORD_ENDPOINT_SUGGESTIONS, "suggestions"],
      [KEYWORD_ENDPOINT_RELATED, "related"]
    ]) {
      const schema = requestSchemaFor(endpointKey);
      const extra = endpointKey === KEYWORD_ENDPOINT_RELATED ? { depth: config.expansion.relatedDepth } : {};
      const request = parseRequest(schema, {
        keyword: seed,
        location_code: config.expansionAnchor.locationCode,
        language_code: config.expansionAnchor.languageCode,
        limit: endpointKey === KEYWORD_ENDPOINT_SUGGESTIONS
          ? config.expansion.suggestionsLimit : config.expansion.relatedLimit,
        ...extra
      });
      tasks.push({
        itemKey: `${index}:${suffix}`,
        inputFingerprint: keywordTaskInputFingerprint({
          contractVersion: "keyword-expansion-input-v1", researchId: research.id,
          generation: research.generation, payload: { seed, endpointKey }
        }),
        endpointKey,
        requestFingerprint: keywordRequestFingerprint(endpointKey, request)
      });
    }
  }
  const initialized = await runtime.repository.initialize({
    researchId: message.researchId, generation: message.generation, stage: "expansion", tasks
  }, nowOf(runtime));
  if (initialized.outcome !== "created" && initialized.outcome !== "found") {
    return { terminal: true, outcome: initialized.outcome };
  }
  for (const task of initialized.tasks) {
    await sendKeywordMessage(runtime, {
      contractVersion: 1, type: KEYWORD_MESSAGE_EXPANSION_TASK,
      researchId: message.researchId, generation: message.generation,
      stage: "expansion", taskNaturalId: task.id, inputFingerprint: task.inputFingerprint
    }, keywordMessageSchema);
  }
  await sendCheck(runtime, {
    researchId: message.researchId, generation: message.generation,
    stage: "expansion", tasks: initialized.tasks
  });
  return { terminal: true, outcome: "initialized" };
}

async function processTask(message, runtime, kind, dependencies) {
  const taskId = message.taskNaturalId;
  const initial = await runtime.repository.getTaskContext({ taskId });
  if (initial.outcome !== "found") return { terminal: true, outcome: initial.outcome };
  if (message.inputFingerprint !== initial.task.inputFingerprint) invariant();

  const claimed = await runtime.repository.claim({
    taskId, owner: ownerOf("keyword-worker"), token: newToken()
  }, nowOf(runtime));
  if (claimed.outcome !== "claimed") return { terminal: true, outcome: claimed.outcome };

  const token = claimed.task.leaseToken;
  const current = await runtime.repository.getTaskContext({ taskId });
  if (current.outcome !== "found") return { terminal: true, outcome: "lost" };
  const task = current.task;
  const research = current.research;
  const stage = current.stage;
  const config = configOf(research);

  const monitor = createKeywordLeaseMonitor({
    kind: "task", runtime, createLeaseMonitor: dependencies?.createLeaseMonitor, taskId, token
  });

  try {
    let recovered;
    let reconstructed;
    await withLeaseBoundary(monitor, async () => {
      recovered = await recoverClaimedTask({
        taskId, token, current, message, kind, runtime, research, stage, config, monitor
      });
      if (recovered.outcome === "proceed") {
        reconstructed = kind === "expansion"
          ? expansionRequestForTask(task, research, config)
          : await overviewRequestForTask(task, message, current, runtime, config);
      }
    });
    if (recovered.outcome === "recovered") {
      return { terminal: true, outcome: "recovered" };
    }
    if (reconstructed.inputFingerprint !== task.inputFingerprint) invariant();
    if (keywordRequestFingerprint(task.endpointKey, reconstructed.request) !== task.requestFingerprint) invariant();

    let attempt;
    await withLeaseBoundary(monitor, async () => {
      attempt = await runProviderAttempt({
        task, research, config, runtime, request: reconstructed.request, monitor
      });
    });

    if (attempt.outcome === "retryAt") {
      const delaySeconds = Math.max(0, Math.ceil((attempt.retryAt.getTime() - nowOf(runtime).getTime()) / 1000));
      if (delaySeconds > 900) invariant();
      await stopReleasedLease(monitor);
      await sendSameTaskMessage(runtime, message, { delaySeconds });
      return { terminal: true, outcome: "retryAt" };
    }
    if (attempt.outcome === "ambiguous" || attempt.outcome === "lost") {
      await stopReleasedLease(monitor);
      return { terminal: true, outcome: attempt.outcome };
    }
    if (attempt.outcome === "failed") {
      const state = stage.stage === "expansion" && attempt.code !== KEYWORD_PROVIDER_BUDGET_EXHAUSTED
        ? "skipped" : "failed";
      await prepareTerminalLease(monitor);
      const terminalized = await runtime.repository.terminalize({
        taskId, token, state, safeErrorCode: attempt.code
      }, nowOf(runtime));
      if (terminalized.outcome === "terminal" || terminalized.outcome === "found") {
        await sendCheckForStage(runtime, current);
      } else if (terminalized.outcome !== "lost" && terminalized.outcome !== "conflict" &&
          terminalized.outcome !== "not_found") {
        invariant();
      }
      await stopReleasedLease(monitor);
      return { terminal: true, outcome: terminalized.outcome === "terminal" ? "terminal" : terminalized.outcome };
    }
    if (attempt.outcome !== "succeeded" && attempt.outcome !== "cacheHit") invariant();

    const { schema, value: artifact } = buildTaskArtifact(research, task, stage, attempt);
    const key = keywordTaskArtifactKey(research.id, research.generation, stage.stage, task.itemKey);
    let stored;
    await withLeaseBoundary(monitor, async () => {
      stored = await runtime.artifactStore.putImmutable({
        key,
        contractVersion: artifact.contractVersion,
        runId: research.id,
        stage: stage.stage,
        generation: research.generation,
        itemId: task.itemKey,
        inputFingerprint: task.inputFingerprint,
        producedAt: task.createdAt,
        value: artifact,
        schema
      });
    });
    await prepareTerminalLease(monitor);
    const terminalized = await runtime.repository.terminalize({
      taskId, token, state: "succeeded",
      artifactS3Key: stored.key, artifactFingerprint: stored.contentFingerprint
    }, nowOf(runtime));
    if (terminalized.outcome === "terminal" || terminalized.outcome === "found") {
      await sendCheckForStage(runtime, current);
    } else if (terminalized.outcome !== "lost" && terminalized.outcome !== "conflict" &&
        terminalized.outcome !== "not_found") {
      invariant();
    }
    await stopReleasedLease(monitor);
    return { terminal: true, outcome: terminalized.outcome === "terminal" ? "succeeded" : terminalized.outcome };
  } catch (error) {
    await stopReleasedLease(monitor);
    throw error;
  }
}

async function recoverClaimedTask({ taskId, token, current, message, kind, runtime, research, stage, config, monitor }) {
  const latestAttempt = current.latestAttempt;
  if (!latestAttempt) return { outcome: "proceed" };
  if (latestAttempt.requestFingerprint !== current.task.requestFingerprint) invariant();
  const now = () => nowOf(runtime);

  if (latestAttempt.state === "planned" || latestAttempt.state === "in_flight") {
    const marked = await runtime.repository.markAttemptAmbiguous({
      taskId, attemptNumber: latestAttempt.attemptNumber,
      requestFingerprint: latestAttempt.requestFingerprint, safeErrorCode: KEYWORD_PROVIDER_AMBIGUOUS
    }, now());
    await stopReleasedLease(monitor);
    if (marked.outcome === "terminal" || marked.outcome === "found") {
      await sendCheckForStage(runtime, current);
      return { outcome: "recovered", result: "ambiguous" };
    }
    if (marked.outcome === "lost" || marked.outcome === "conflict" || marked.outcome === "not_found") {
      return { outcome: "recovered", result: marked.outcome };
    }
    invariant();
  }

  if (latestAttempt.state === "succeeded") {
    if (current.task.requestFingerprint !== latestAttempt.requestFingerprint) invariant();
    const cached = await runtime.repository.cacheRead({
      requestFingerprint: current.task.requestFingerprint
    }, now());
    const cacheOk = cached.outcome === "found" &&
      cached.cache.resultFingerprint === latestAttempt.resultFingerprint &&
      fingerprintJson(cached.cache.normalizedResponse) === latestAttempt.resultFingerprint;
    if (!cacheOk) {
      await prepareTerminalLease(monitor);
      const terminalized = await runtime.repository.terminalize({
        taskId, token, state: "failed", safeErrorCode: KEYWORD_PROVIDER_AMBIGUOUS
      }, now());
      if (terminalized.outcome === "terminal" || terminalized.outcome === "found") {
        await sendCheckForStage(runtime, current);
        return { outcome: "recovered", result: terminalized.outcome === "terminal" ? "terminal" : "found" };
      }
      if (terminalized.outcome === "lost" || terminalized.outcome === "conflict" || terminalized.outcome === "not_found") {
        return { outcome: "recovered", result: terminalized.outcome };
      }
      invariant();
    }
    const reconstructed = kind === "expansion"
      ? expansionRequestForTask(current.task, research, config)
      : await overviewRequestForTask(current.task, message, current, runtime, config);
    if (reconstructed.inputFingerprint !== current.task.inputFingerprint) invariant();
    if (keywordRequestFingerprint(current.task.endpointKey, reconstructed.request) !== current.task.requestFingerprint) invariant();
    const { schema, value: artifact } = buildTaskArtifact(research, current.task, stage,
      { outcome: "succeeded", normalized: cached.cache.normalizedResponse,
        providerCostUsd: latestAttempt.providerCostUsd });
    const key = keywordTaskArtifactKey(research.id, research.generation, stage.stage, current.task.itemKey);
    let stored;
    await withLeaseBoundary(monitor, async () => {
      stored = await runtime.artifactStore.putImmutable({
        key, contractVersion: artifact.contractVersion, runId: research.id,
        stage: stage.stage, generation: research.generation, itemId: current.task.itemKey,
        inputFingerprint: current.task.inputFingerprint, producedAt: current.task.createdAt,
        value: artifact, schema
      });
    });
    await prepareTerminalLease(monitor);
    const terminalized = await runtime.repository.terminalize({
      taskId, token, state: "succeeded",
      artifactS3Key: stored.key, artifactFingerprint: stored.contentFingerprint
    }, now());
    if (terminalized.outcome === "terminal" || terminalized.outcome === "found") {
      await sendCheckForStage(runtime, current);
      return { outcome: "recovered", result: terminalized.outcome === "terminal" ? "terminal" : "found" };
    }
    if (terminalized.outcome === "lost" || terminalized.outcome === "conflict" || terminalized.outcome === "not_found") {
      return { outcome: "recovered", result: terminalized.outcome };
    }
    invariant();
  }

  if (latestAttempt.state === "failed") {
    const code = latestAttempt.safeErrorCode;
    if (code === KEYWORD_PROVIDER_RETRYABLE && current.task.nextAttemptAt !== null) {
      return { outcome: "proceed" };
    }
    if (code === KEYWORD_PROVIDER_RETRYABLE && latestAttempt.attemptNumber < 5) {
      const scheduled = await runtime.repository.scheduleRetry({
        taskId, token, attemptNumber: latestAttempt.attemptNumber
      }, now());
      if (scheduled.outcome === "delayed") {
        await stopReleasedLease(monitor);
        const delaySeconds = Math.max(0, Math.ceil((scheduled.retryAt.getTime() - now().getTime()) / 1000));
        if (delaySeconds > 900) invariant();
        await sendSameTaskMessage(runtime, message, { delaySeconds });
        return { outcome: "recovered", result: "delayed" };
      }
      await stopReleasedLease(monitor);
      if (scheduled.outcome === "conflict" && scheduled.code === KEYWORD_PROVIDER_RETRY_EXHAUSTED) {
        await prepareTerminalLease(monitor);
        const terminalized = await runtime.repository.terminalize({
          taskId, token, state: "failed", safeErrorCode: KEYWORD_PROVIDER_RETRY_EXHAUSTED
        }, now());
        if (terminalized.outcome === "terminal" || terminalized.outcome === "found") {
          await sendCheckForStage(runtime, current);
          return { outcome: "recovered", result: terminalized.outcome === "terminal" ? "terminal" : "found" };
        }
        if (terminalized.outcome === "lost" || terminalized.outcome === "conflict" || terminalized.outcome === "not_found") {
          return { outcome: "recovered", result: terminalized.outcome };
        }
        invariant();
      }
      if (scheduled.outcome === "lost" || scheduled.outcome === "conflict" || scheduled.outcome === "not_found") {
        return { outcome: "recovered", result: scheduled.outcome };
      }
      invariant();
    }
    if (code === KEYWORD_PROVIDER_RETRYABLE) {
      await prepareTerminalLease(monitor);
      const terminalized = await runtime.repository.terminalize({
        taskId, token, state: "failed", safeErrorCode: KEYWORD_PROVIDER_RETRY_EXHAUSTED
      }, now());
      if (terminalized.outcome === "terminal" || terminalized.outcome === "found") {
        await sendCheckForStage(runtime, current);
        return { outcome: "recovered", result: terminalized.outcome === "terminal" ? "terminal" : "found" };
      }
      if (terminalized.outcome === "lost" || terminalized.outcome === "conflict" || terminalized.outcome === "not_found") {
        return { outcome: "recovered", result: terminalized.outcome };
      }
      invariant();
    }
    if (code === KEYWORD_PROVIDER_AUTH_FAILED || code === KEYWORD_PROVIDER_CONTRACT_MISMATCH ||
        code === KEYWORD_PROVIDER_TASK_FAILED) {
      const state = stage.stage === "expansion" ? "skipped" : "failed";
      await prepareTerminalLease(monitor);
      const terminalized = await runtime.repository.terminalize({
        taskId, token, state, safeErrorCode: code
      }, now());
      if (terminalized.outcome === "terminal" || terminalized.outcome === "found") {
        await sendCheckForStage(runtime, current);
        return { outcome: "recovered", result: terminalized.outcome === "terminal" ? "terminal" : "found" };
      }
      if (terminalized.outcome === "lost" || terminalized.outcome === "conflict" || terminalized.outcome === "not_found") {
        return { outcome: "recovered", result: terminalized.outcome };
      }
      invariant();
    }
    invariant();
  }

  invariant();
}

async function runProviderAttempt({ task, research, config, runtime, request, monitor }) {
  const secrets = runtime.secrets ?? {};
  const adapterConfig = {
    ...config,
    api: {
      ...config.api,
      credentials: {
        login: secrets.dataForSeoLogin ?? "",
        password: secrets.dataForSeoPassword ?? ""
      }
    }
  };
  const monitoredHttp = async (url, init) => {
    monitor.assertActive();
    let response;
    try {
      response = await httpOf(runtime)(url, init);
    } finally {
      monitor.assertActive();
    }
    const json = async () => {
      monitor.assertActive();
      try {
        return await response.json();
      } finally {
        monitor.assertActive();
      }
    };
    return { status: response.status, json };
  };
  return executeProviderAttempt({
    task: { ...task, request },
    config: adapterConfig,
    clock: () => nowOf(runtime),
    http: monitoredHttp,
    repository: runtime.repository
  });
}

function buildTaskArtifact(research, task, stage, attempt) {
  const producedAt = task.createdAt instanceof Date
    ? task.createdAt.toISOString() : new Date(task.createdAt).toISOString();
  const header = {
    researchId: research.id,
    generation: stage.generation,
    itemId: task.itemKey,
    inputFingerprint: task.inputFingerprint,
    producedAt
  };
  if (stage.stage === "expansion") {
    return {
      schema: keywordExpansionResultSchema,
      value: {
        contractVersion: KEYWORD_ARTIFACT_EXPANSION_RESULT,
        stage: "expansion",
        status: "succeeded",
        costUsd: attempt.outcome === "cacheHit" ? null : attempt.providerCostUsd,
        normalized: attempt.normalized,
        ...header
      }
    };
  }
  if (stage.stage === "anchor_screen") {
    return {
      schema: keywordAnchorScreenResultSchema,
      value: {
        contractVersion: KEYWORD_ARTIFACT_ANCHOR_RESULT,
        stage: "anchor_screen",
        status: "succeeded",
        costUsd: attempt.outcome === "cacheHit" ? null : attempt.providerCostUsd,
        normalized: attempt.normalized,
        ...header
      }
    };
  }
  if (stage.stage === "market_overview") {
    return {
      schema: keywordMarketOverviewResultSchema,
      value: {
        contractVersion: KEYWORD_ARTIFACT_MARKET_RESULT,
        stage: "market_overview",
        status: "succeeded",
        costUsd: attempt.outcome === "cacheHit" ? null : attempt.providerCostUsd,
        normalized: attempt.normalized,
        ...header
      }
    };
  }
  invariant();
}

async function sendSameTaskMessage(runtime, message, options) {
  return sendKeywordMessage(runtime, {
    contractVersion: 1, type: message.type, researchId: message.researchId,
    generation: message.generation, stage: message.stage,
    taskNaturalId: message.taskNaturalId, inputFingerprint: message.inputFingerprint
  }, keywordMessageSchema, options);
}

async function sendCheckForStage(runtime, context) {
  const tasks = await stageTasks(runtime, context.research.id, context.stage.stage, context.stage.generation);
  return sendCheck(runtime, {
    researchId: context.research.id, generation: context.stage.generation,
    stage: context.stage.stage, tasks
  });
}

async function stageTasks(runtime, researchId, stageName, generation) {
  const loaded = await runtime.repository.getStageContext({ researchId, stage: stageName, generation });
  if (loaded.outcome !== "found") return [];
  return loaded.tasks;
}

export async function processAggregateCheck(message, runtime, dependencies = {}) {
  const token = newToken();
  const claimed = await runtime.repository.claimAggregator({
    researchId: message.researchId, stage: message.stage, generation: message.generation,
    owner: ownerOf("keyword-aggregator"), token
  }, nowOf(runtime));
  if (claimed.outcome !== "claimed") return { terminal: true, outcome: claimed.outcome };

  const monitor = createKeywordLeaseMonitor({
    kind: "aggregation", runtime, createLeaseMonitor: dependencies.createLeaseMonitor,
    researchId: message.researchId, stage: message.stage, generation: message.generation, token
  });

  try {
    let context;
    await withLeaseBoundary(monitor, async () => {
      context = await runtime.repository.getStageContext({
        researchId: message.researchId, stage: message.stage, generation: message.generation
      });
    });
    if (context.outcome !== "found") return { terminal: true, outcome: "lost" };
    const stage = context.stage;
    const research = context.research;
    const config = configOf(research);
    const tasks = context.tasks;

    if (message.stageInputFingerprint !== undefined &&
        keywordStageInputFingerprint({
          researchId: research.id, generation: message.generation, stage: message.stage, tasks
        }) !== message.stageInputFingerprint) {
      invariant();
    }

    const failedTask = tasks.find((entry) => entry.state === "failed");
    if (failedTask) {
      await prepareTerminalLease(monitor);
      const failedOutcome = await failStage(runtime, research, stage, token,
        failedTask.safeErrorCode ?? KEYWORD_RESEARCH_STAGE_FAILED);
      if (failedOutcome !== "terminal" && failedOutcome !== "found") {
        return { terminal: true, outcome: failedOutcome };
      }
      return { terminal: true, outcome: "stage_failed" };
    }

    if (message.stage === "expansion") {
      return { terminal: true, outcome: await aggregateExpansion({ research, stage, config, tasks, token, runtime, monitor }) };
    }
    if (message.stage === "anchor_screen") {
      return { terminal: true, outcome: await aggregateAnchor({ research, stage, config, tasks, token, runtime, monitor }) };
    }
    if (message.stage === "market_overview") {
      return { terminal: true, outcome: await aggregateMarket({ research, stage, config, tasks, token, runtime, monitor }) };
    }
    invariant();
  } finally {
    await stopReleasedLease(monitor);
  }
}

async function readArtifact(runtime, research, stage, task, schema, contractVersion, monitor) {
  const read = async () => {
    const stored = await runtime.artifactStore.getValidated({
      key: task.artifactS3Key,
      expected: {
        contractVersion, runId: research.id, stage: stage.stage, generation: stage.generation,
        itemId: task.itemKey, inputFingerprint: task.inputFingerprint,
        contentFingerprint: task.artifactFingerprint, producedAt: task.createdAt
      },
      schema
    });
    return stored.value;
  };
  return monitor ? withLeaseBoundary(monitor, read) : read();
}

async function readManifest(runtime, research, stage, manifestStage, contractVersion, schema, monitor) {
  const manifestContext = await runtime.repository.getStageContext({
    researchId: research.id, stage: manifestStage, generation: stage.generation
  });
  if (manifestContext.outcome !== "found") invariant();
  const source = manifestContext.stage;
  if (!source.manifestS3Key) invariant();
  const stageInputFingerprint = keywordStageInputFingerprint({
    researchId: research.id, generation: stage.generation, stage: manifestStage, tasks: manifestContext.tasks
  });
  const read = async () => {
    const stored = await runtime.artifactStore.getValidated({
      key: source.manifestS3Key,
      expected: {
        contractVersion, runId: research.id, stage: manifestStage, generation: stage.generation,
        itemId: "manifest", inputFingerprint: stageInputFingerprint,
        contentFingerprint: source.manifestFingerprint, producedAt: source.manifestProducedAt
      },
      schema
    });
    return stored.value;
  };
  return monitor ? withLeaseBoundary(monitor, read) : read();
}

async function aggregateExpansion({ research, stage, config, tasks, token, runtime, monitor }) {
  const bySeed = [];
  const globalList = [];
  const seen = new Set();
  for (let index = 0; index < research.seeds.length; index += 1) {
    const seed = research.seeds[index];
    const list = [seed];
    for (const endpoint of ["suggestions", "related"]) {
      const task = tasks.find((entry) => entry.itemKey === `${index}:${endpoint}`);
      if (task && task.state === "succeeded") {
        const artifact = await readArtifact(runtime, research, stage, task,
          keywordExpansionResultSchema, KEYWORD_ARTIFACT_EXPANSION_RESULT, monitor);
        list.push(...artifact.normalized.keywords);
      }
    }
    const merged = [];
    const mergedSeen = new Set();
    for (const keyword of list) {
      const key = keyword.toLocaleLowerCase("en-US");
      if (mergedSeen.has(key)) continue;
      mergedSeen.add(key);
      merged.push(keyword);
      if (merged.length >= config.expansionPerSeedLimit) break;
    }
    bySeed.push({ seed, keywords: merged });
    for (const keyword of merged) {
      const key = keyword.toLocaleLowerCase("en-US");
      if (seen.has(key)) continue;
      seen.add(key);
      globalList.push({ keyword, seeds: [seed] });
    }
  }
  if (globalList.length === 0 || globalList.length > config.screenCandidateLimit) invariant();

  const manifest = {
    contractVersion: KEYWORD_ARTIFACT_EXPANSION_MANIFEST,
    researchId: research.id,
    generation: stage.generation,
    stage: "expansion",
    itemId: "manifest",
    inputFingerprint: keywordStageInputFingerprint({
      researchId: research.id, generation: stage.generation, stage: "expansion", tasks
    }),
    producedAt: new Date(stage.createdAt).toISOString(),
    seeds: research.seeds,
    bySeed,
    candidates: globalList
  };
  keywordExpansionManifestSchema.parse(manifest);
  let stored;
  await withLeaseBoundary(monitor, async () => {
    stored = await runtime.artifactStore.putImmutable({
      key: keywordManifestKey(research.id, stage.generation, "expansion"),
      contractVersion: KEYWORD_ARTIFACT_EXPANSION_MANIFEST,
      runId: research.id, stage: "expansion", generation: stage.generation, itemId: "manifest",
      inputFingerprint: manifest.inputFingerprint, producedAt: manifest.producedAt,
      value: manifest, schema: keywordExpansionManifestSchema
    });
  });

  const anchorKeywords = globalList.map((entry) => entry.keyword);
  const request = parseRequest(overviewRequestSchema, {
    keywords: anchorKeywords,
    location_code: config.expansionAnchor.locationCode,
    language_code: config.expansionAnchor.languageCode
  });
  const inputFingerprint = keywordTaskInputFingerprint({
    contractVersion: "keyword-anchor-input-v1", researchId: research.id,
    generation: stage.generation, payload: { candidates: anchorKeywords }
  });
  const nextStageTasks = [{
    itemKey: "US:0",
    inputFingerprint,
    endpointKey: KEYWORD_ENDPOINT_OVERVIEW,
    requestFingerprint: keywordRequestFingerprint(KEYWORD_ENDPOINT_OVERVIEW, request)
  }];
  await prepareTerminalLease(monitor);
  const published = await runtime.repository.publishCandidateManifest({
    researchId: research.id, generation: stage.generation, token,
    manifestS3Key: stored.key, manifestFingerprint: stored.contentFingerprint, nextStageTasks
  }, nowOf(runtime));
  if (published.outcome !== "terminal" && published.outcome !== "found") {
    return published.outcome;
  }
  const anchorTask = published.tasks[0];
  await sendKeywordMessage(runtime, {
    contractVersion: 1, type: KEYWORD_MESSAGE_OVERVIEW_TASK,
    researchId: research.id, generation: stage.generation, stage: "anchor_screen",
    taskNaturalId: anchorTask.id, inputFingerprint: anchorTask.inputFingerprint
  }, keywordMessageSchema);
  await sendCheck(runtime, {
    researchId: research.id, generation: stage.generation, stage: "anchor_screen", tasks: published.tasks
  });
  return "published";
}

async function aggregateAnchor({ research, stage, config, tasks, token, runtime, monitor }) {
  const anchorTask = tasks[0];
  const artifact = await readArtifact(runtime, research, stage, anchorTask,
    keywordAnchorScreenResultSchema, KEYWORD_ARTIFACT_ANCHOR_RESULT, monitor);
  const metrics = artifact.normalized.metrics;
  if (!metrics.length) {
    await prepareTerminalLease(monitor);
    const failedOutcome = await failStage(runtime, research, stage, token);
    if (failedOutcome !== "terminal" && failedOutcome !== "found") return failedOutcome;
    return "stage_failed";
  }

  const expansionManifest = await readManifest(runtime, research, stage, "expansion",
    KEYWORD_ARTIFACT_EXPANSION_MANIFEST, keywordExpansionManifestSchema, monitor);
  const expansion = Object.fromEntries(expansionManifest.bySeed.map((entry) => [entry.seed, entry.keywords]));
  const usMarket = config.markets.find((entry) => entry.code === "US");
  if (!usMarket) invariant();
  const usResult = computeResearchResult({
    config, seeds: research.seeds, markets: [usMarket], expansion,
    overview: { US: metrics }, anchorMarket: "US",
    researchId: research.id, generation: stage.generation, configFingerprint: research.configFingerprint
  });
  const active = usResult.keywords.filter((entry) => entry.mergedInto === null);
  const leadFinding = isLeadFindingConfig(config);
  const usable = leadFinding
    ? active
    : active.filter((entry) => !isInformational(entry.keyword, entry.mainIntent, config));
  const sorted = [...usable].sort((left, right) => (
    leadFinding
      ? compareLeadFindingShortlist(left, right, shortlistComparator)
      : shortlistComparator(left, right)
  ));
  const shortlist = sorted.slice(0, config.shortlistLimit).map((entry) => entry.keyword);
  if (!shortlist.length) {
    await prepareTerminalLease(monitor);
    const failedOutcome = await failStage(runtime, research, stage, token);
    if (failedOutcome !== "terminal" && failedOutcome !== "found") return failedOutcome;
    return "stage_failed";
  }

  const manifest = {
    contractVersion: KEYWORD_ARTIFACT_SHORTLIST_MANIFEST,
    researchId: research.id,
    generation: stage.generation,
    stage: "anchor_screen",
    itemId: "manifest",
    inputFingerprint: keywordStageInputFingerprint({
      researchId: research.id, generation: stage.generation, stage: "anchor_screen", tasks
    }),
    producedAt: new Date(stage.createdAt).toISOString(),
    keywords: shortlist
  };
  keywordShortlistManifestSchema.parse(manifest);
  let stored;
  await withLeaseBoundary(monitor, async () => {
    stored = await runtime.artifactStore.putImmutable({
      key: keywordManifestKey(research.id, stage.generation, "anchor_screen"),
      contractVersion: KEYWORD_ARTIFACT_SHORTLIST_MANIFEST,
      runId: research.id, stage: "anchor_screen", generation: stage.generation, itemId: "manifest",
      inputFingerprint: manifest.inputFingerprint, producedAt: manifest.producedAt,
      value: manifest, schema: keywordShortlistManifestSchema
    });
  });

  const marketTasks = [];
  for (const code of KEYWORD_REMAINING_MARKET_CODES) {
    const market = config.markets.find((entry) => entry.code === code);
    if (!market) invariant();
    const request = parseRequest(overviewRequestSchema, {
      keywords: shortlist,
      location_code: market.locationCode,
      language_code: market.languageCode
    });
    marketTasks.push({
      itemKey: `${code}:0`,
      inputFingerprint: keywordTaskInputFingerprint({
        contractVersion: "keyword-market-input-v1", researchId: research.id,
        generation: stage.generation, payload: { code, keywords: shortlist }
      }),
      endpointKey: KEYWORD_ENDPOINT_OVERVIEW,
      requestFingerprint: keywordRequestFingerprint(KEYWORD_ENDPOINT_OVERVIEW, request)
    });
  }
  await prepareTerminalLease(monitor);
  const published = await runtime.repository.publishShortlist({
    researchId: research.id, generation: stage.generation, token,
    manifestS3Key: stored.key, manifestFingerprint: stored.contentFingerprint, marketTasks
  }, nowOf(runtime));
  if (published.outcome !== "terminal" && published.outcome !== "found") {
    return published.outcome;
  }
  for (const task of published.tasks) {
    await sendKeywordMessage(runtime, {
      contractVersion: 1, type: KEYWORD_MESSAGE_OVERVIEW_TASK,
      researchId: research.id, generation: stage.generation, stage: "market_overview",
      taskNaturalId: task.id, inputFingerprint: task.inputFingerprint
    }, keywordMessageSchema);
  }
  await sendCheck(runtime, {
    researchId: research.id, generation: stage.generation, stage: "market_overview", tasks: published.tasks
  });
  return "published";
}

async function aggregateMarket({ research, stage, config, tasks, token, runtime, monitor }) {
  const anchorContext = await runtime.repository.getStageContext({
    researchId: research.id, stage: "anchor_screen", generation: stage.generation
  });
  if (anchorContext.outcome !== "found") invariant();
  const anchorTask = anchorContext.tasks[0];
  const anchorArtifact = await readArtifact(runtime, research, anchorContext.stage, anchorTask,
    keywordAnchorScreenResultSchema, KEYWORD_ARTIFACT_ANCHOR_RESULT, monitor);

  const overview = { US: anchorArtifact.normalized.metrics };
  for (const task of tasks) {
    const code = task.itemKey.split(":")[0];
    const artifact = await readArtifact(runtime, research, stage, task,
      keywordMarketOverviewResultSchema, KEYWORD_ARTIFACT_MARKET_RESULT, monitor);
    overview[code] = artifact.normalized.metrics;
  }

  const expansionManifest = await readManifest(runtime, research, stage, "expansion",
    KEYWORD_ARTIFACT_EXPANSION_MANIFEST, keywordExpansionManifestSchema, monitor);
  const shortlistManifest = await readManifest(runtime, research, stage, "anchor_screen",
    KEYWORD_ARTIFACT_SHORTLIST_MANIFEST, keywordShortlistManifestSchema, monitor);
  const keywordKey = (keyword) => keyword.trim().toLowerCase();
  const shortlist = shortlistManifest.keywords;
  const shortlistKeys = new Set(shortlist.map(keywordKey));
  const projectedExpansion = Object.fromEntries(expansionManifest.bySeed.map((entry) => [
    entry.seed,
    entry.keywords.filter((keyword) => shortlistKeys.has(keywordKey(keyword)))
  ]));
  const projectedExpansionKeys = new Set(Object.values(projectedExpansion).flat().map(keywordKey));
  if (projectedExpansionKeys.size !== shortlistKeys.size ||
      [...projectedExpansionKeys].some((key) => !shortlistKeys.has(key))) {
    invariant();
  }
  const projectedUsMetrics = anchorArtifact.normalized.metrics.filter((item) =>
    shortlistKeys.has(keywordKey(item.keyword))
  );
  const projectedUsMetricKeys = new Set(projectedUsMetrics.map((item) => keywordKey(item.keyword)));
  if (projectedUsMetrics.length === 0 || projectedUsMetricKeys.size !== shortlistKeys.size ||
      [...projectedUsMetricKeys].some((key) => !shortlistKeys.has(key))) {
    invariant();
  }
  const projectedOverview = { ...overview, US: projectedUsMetrics };

  let result;
  try {
    result = computeResearchResult({
      config, seeds: research.seeds, markets: config.markets, expansion: projectedExpansion,
      overview: projectedOverview, anchorMarket: "US",
      researchId: research.id, generation: stage.generation, configFingerprint: research.configFingerprint
    });
  } catch {
    await prepareTerminalLease(monitor);
    const failedOutcome = await failStage(runtime, research, stage, token);
    if (failedOutcome !== "terminal" && failedOutcome !== "found") return failedOutcome;
    return "stage_failed";
  }

  const stageInputFingerprint = keywordStageInputFingerprint({
    researchId: research.id, generation: stage.generation, stage: "market_overview", tasks
  });
  const producedAt = new Date(stage.createdAt).toISOString();
  const marketManifest = {
    contractVersion: KEYWORD_ARTIFACT_MARKET_MANIFEST,
    researchId: research.id,
    generation: stage.generation,
    stage: "market_overview",
    itemId: "manifest",
    inputFingerprint: stageInputFingerprint,
    producedAt,
    overview
  };
  keywordMarketOverviewManifestSchema.parse(marketManifest);
  let manifestStored;
  await withLeaseBoundary(monitor, async () => {
    manifestStored = await runtime.artifactStore.putImmutable({
      key: keywordManifestKey(research.id, stage.generation, "market_overview"),
      contractVersion: KEYWORD_ARTIFACT_MARKET_MANIFEST,
      runId: research.id, stage: "market_overview", generation: stage.generation, itemId: "manifest",
      inputFingerprint: stageInputFingerprint, producedAt,
      value: marketManifest, schema: keywordMarketOverviewManifestSchema
    });
  });

  const resultArtifact = { ...result, contractVersion: KEYWORD_ARTIFACT_RESEARCH_RESULT };
  keywordResearchResultArtifactSchema.parse(resultArtifact);
  await withLeaseBoundary(monitor, async () => {
    await runtime.artifactStore.putImmutable({
      key: keywordResultKey(research.id, stage.generation),
      contractVersion: KEYWORD_ARTIFACT_RESEARCH_RESULT,
      runId: research.id, stage: "market_overview", generation: stage.generation, itemId: "result",
      inputFingerprint: stageInputFingerprint, producedAt,
      value: resultArtifact, schema: keywordResearchResultArtifactSchema
    });
  });

  const selection = createDefaultSelection(result.keywords);
  if (!selection.ok) invariant();
  await prepareTerminalLease(monitor);
  const published = await runtime.repository.publishResearchResult({
    researchId: research.id, generation: stage.generation, token,
    manifestS3Key: manifestStored.key, manifestFingerprint: manifestStored.contentFingerprint,
    result, resultFingerprint: resultFingerprint(result), selectionItems: selection.items
  }, nowOf(runtime));
  return published.outcome === "terminal" || published.outcome === "found"
    ? "published" : published.outcome;
}

async function failStage(runtime, research, stage, token, safeErrorCode = KEYWORD_RESEARCH_STAGE_FAILED) {
  const outcome = await runtime.repository.failStage({
    researchId: research.id, stage: stage.stage, generation: stage.generation,
    token, safeErrorCode
  }, nowOf(runtime));
  return outcome.outcome;
}

function shortlistComparator(left, right) {
  const lr = left.recommended === true ? 1 : 0;
  const rr = right.recommended === true ? 1 : 0;
  if (lr !== rr) return rr - lr;
  const lo = left.opportunityScore === null || left.opportunityScore === undefined ? -1 : left.opportunityScore;
  const ro = right.opportunityScore === null || right.opportunityScore === undefined ? -1 : right.opportunityScore;
  if (lo !== ro) return ro - lo;
  const lv = left.searchVolume === null || left.searchVolume === undefined ? -1 : left.searchVolume;
  const rv = right.searchVolume === null || right.searchVolume === undefined ? -1 : right.searchVolume;
  if (lv !== rv) return rv - lv;
  const lk = String(left.keyword).toLocaleLowerCase("en-US");
  const rk = String(right.keyword).toLocaleLowerCase("en-US");
  if (lk !== rk) return lk < rk ? -1 : 1;
  const li = String(left.itemId).toLocaleLowerCase("en-US");
  const ri = String(right.itemId).toLocaleLowerCase("en-US");
  if (li !== ri) return li < ri ? -1 : 1;
  return 0;
}
