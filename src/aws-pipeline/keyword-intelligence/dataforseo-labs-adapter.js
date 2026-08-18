import { PipelineInvariantError } from "../contracts/errors.js";
import {
  KEYWORD_ENDPOINT_SUGGESTIONS,
  KEYWORD_ENDPOINT_RELATED,
  KEYWORD_ENDPOINT_OVERVIEW,
  KEYWORD_PROVIDER_REQUEST_INVALID,
  KEYWORD_PROVIDER_AUTH_FAILED,
  KEYWORD_PROVIDER_RETRY_EXHAUSTED,
  KEYWORD_PROVIDER_TASK_FAILED,
  KEYWORD_PROVIDER_CONTRACT_MISMATCH,
  KEYWORD_PROVIDER_AMBIGUOUS,
  KEYWORD_PROVIDER_BUDGET_EXHAUSTED,
  KEYWORD_PROVIDER_RETRY_NOT_SCHEDULED,
  KEYWORD_PROVIDER_THROTTLED,
  KEYWORD_PROVIDER_RETRYABLE,
  keywordMarketMetricSchema,
  keywordListResultSchema,
  keywordMetricsResultSchema,
  overviewRequestSchema,
  relatedRequestSchema,
  suggestionRequestSchema,
  rootEnvelopeSchema,
  taskEnvelopeSchema,
  endpointTaskSchema
} from "./contracts.js";
import { keywordCacheKey, keywordRequestFingerprint } from "./keys.js";
import { fingerprintJson } from "../core/canonical.js";

const ENDPOINT_PATHS = Object.freeze({
  [KEYWORD_ENDPOINT_SUGGESTIONS]: "/dataforseo_labs/google/keyword_suggestions/live",
  [KEYWORD_ENDPOINT_RELATED]: "/dataforseo_labs/google/related_keywords/live",
  [KEYWORD_ENDPOINT_OVERVIEW]: "/dataforseo_labs/google/keyword_overview/live"
});

const RESERVATION_SUGGESTIONS = "0.01560000";
const RESERVATION_RELATED = "0.01560000";
const OVERVIEW_FIXED_USD = 0.012;
const OVERVIEW_PER_KEYWORD_USD = 0.00012;
const CACHE_TTL_SECONDS = 604800;
const THROTTLE_MIN_GAP_MS = 2000;

function invariant(code = "PIPELINE_INPUT_CONFLICT") {
  throw new PipelineInvariantError(code);
}

function settlementFence(settled, { attempt, providerCostUsd }) {
  const kind = settled?.outcome;
  if ((kind === "terminal" || kind === "found") && settled?.fenceActive === true) {
    return { outcome: "active", attempt, providerCostUsd };
  }
  if (kind === "lost" || kind === "not_found" ||
      (kind === "found" && settled?.fenceActive === false)) {
    return { outcome: "lost", attempt, providerCostUsd };
  }
  invariant();
}

async function markAmbiguousOnce(repository, { taskId, attemptNumber, requestFingerprint }, now) {
  const marked = await repository.markAttemptAmbiguous({
    taskId, attemptNumber, requestFingerprint, safeErrorCode: KEYWORD_PROVIDER_AMBIGUOUS
  }, now);
  if (marked.outcome !== "terminal" && marked.outcome !== "found") invariant();
}

function moneyString(value) {
  return Number(value).toFixed(8);
}

function requestSchemaFor(endpointKey) {
  if (endpointKey === KEYWORD_ENDPOINT_SUGGESTIONS) return suggestionRequestSchema;
  if (endpointKey === KEYWORD_ENDPOINT_RELATED) return relatedRequestSchema;
  if (endpointKey === KEYWORD_ENDPOINT_OVERVIEW) return overviewRequestSchema;
  return null;
}

function reservationFor(endpointKey, request) {
  if (endpointKey === KEYWORD_ENDPOINT_OVERVIEW) {
    const count = request.keywords.length;
    return moneyString(OVERVIEW_FIXED_USD + OVERVIEW_PER_KEYWORD_USD * count);
  }
  return endpointKey === KEYWORD_ENDPOINT_RELATED ? RESERVATION_RELATED : RESERVATION_SUGGESTIONS;
}

function normalizeKeywordList(items) {
  const out = [];
  const seen = new Set();
  for (const keyword of items) {
    const trimmed = keyword.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeOverviewMetrics(items) {
  const metrics = [];
  for (const item of items) {
    if (!item.keyword || !item.keyword.trim()) continue;
    const volume = item.keyword_info.search_volume;
    if (volume === null || volume === undefined || !Number.isFinite(volume) || volume <= 0) continue;
    const metric = {
      keyword: item.keyword,
      keyword_info: { ...item.keyword_info, monthly_searches: item.monthly_searches },
      keyword_properties: item.keyword_properties,
      search_intent_info: item.search_intent_info
    };
    keywordMarketMetricSchema.parse(metric);
    metrics.push(metric);
  }
  return metrics;
}

function normalizeSuccess(endpointKey, task) {
  if (endpointKey === KEYWORD_ENDPOINT_OVERVIEW) {
    const blocks = task.result ?? [];
    const items = [];
    for (const block of blocks) items.push(...(block.items ?? []));
    return keywordMetricsResultSchema.parse({ metrics: normalizeOverviewMetrics(items) });
  }
  const blocks = task.result ?? [];
  const items = [];
  for (const block of blocks) items.push(...(block.items ?? []));
  if (endpointKey === KEYWORD_ENDPOINT_SUGGESTIONS) {
    return keywordListResultSchema.parse({ keywords: normalizeKeywordList(items.map((item) => item.keyword)) });
  }
  return keywordListResultSchema.parse({
    keywords: normalizeKeywordList(items.map((item) => item.keyword_data.keyword))
  });
}

function bodyCost(body, fallback = 0) {
  if (!body || typeof body !== "object" || typeof body.cost !== "number" || !Number.isFinite(body.cost)) {
    return moneyString(fallback);
  }
  return moneyString(body.cost);
}

function taskCost(task, fallback = 0) {
  if (!task || typeof task.cost !== "number" || !Number.isFinite(task.cost)) return moneyString(fallback);
  return moneyString(task.cost);
}

function parseRoot(body) {
  const result = rootEnvelopeSchema.safeParse(body);
  if (!result.success) return null;
  return result.data;
}

function parseTaskEnvelope(body) {
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  if (tasks.length !== 1) return null;
  const result = taskEnvelopeSchema.safeParse(tasks[0]);
  if (!result.success) return null;
  return result.data;
}

function parseEndpointTask(endpointKey, body) {
  const schema = endpointTaskSchema[endpointKey];
  if (!schema) return null;
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  if (tasks.length !== 1) return null;
  const result = schema.safeParse(tasks[0]);
  if (!result.success) return null;
  return result.data;
}

export async function executeProviderAttempt({ task, config, clock, http, repository }) {
  if (!task || !config || typeof clock !== "function" || typeof http !== "function" || !repository) invariant();
  const endpointKey = task.endpointKey;
  const request = task.request;
  if (!ENDPOINT_PATHS[endpointKey] || request === undefined) {
    return { outcome: "failed", code: KEYWORD_PROVIDER_REQUEST_INVALID, attempt: null, providerCostUsd: null };
  }
  const requestSchema = requestSchemaFor(endpointKey);
  const parsedRequest = requestSchema.safeParse(request);
  if (!parsedRequest.success) {
    return { outcome: "failed", code: KEYWORD_PROVIDER_REQUEST_INVALID, attempt: null, providerCostUsd: null };
  }
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invariant();
  if (task.requestFingerprint !== keywordRequestFingerprint(endpointKey, parsedRequest.data)) invariant();

  const taskId = task.id;
  const token = task.leaseToken;
  const cacheHit = await repository.cacheRead({ requestFingerprint: task.requestFingerprint }, now);
  if (cacheHit.outcome === "found") {
    return { outcome: "cacheHit", normalized: cacheHit.cache.normalizedResponse };
  }

  const throttle = await repository.claimThrottle({ provider: "dataforseo_labs_keyword", minGapMs: THROTTLE_MIN_GAP_MS });
  if (throttle.outcome === "delayed") {
    const nextAttemptAt = new Date(Math.max(
      Math.ceil(throttle.retryAt.getTime() / 1000) * 1000,
      Math.floor(now.getTime() / 1000) * 1000 + 1000
    ));
    const deferred = await repository.deferTask({
      taskId, token, nextAttemptAt, safeErrorCode: KEYWORD_PROVIDER_THROTTLED
    }, now);
    if (deferred.outcome === "delayed") {
      return { outcome: "retryAt", retryAt: deferred.retryAt, reason: "throttled", attempt: null, providerCostUsd: null };
    }
    return { outcome: "lost", attempt: null, providerCostUsd: null };
  }

  const reservationCostUsd = reservationFor(endpointKey, parsedRequest.data);
  const recorded = await repository.recordAttempt({
    taskId,
    token,
    requestFingerprint: task.requestFingerprint,
    reservationCostUsd,
    maxCostPerResearchUsd: config.maxCostPerResearchUsd
  }, now);

  if (recorded.outcome === "not_found" || recorded.outcome === "lost") {
    return { outcome: "lost", attempt: null, providerCostUsd: null };
  }
  if (recorded.outcome === "conflict") {
    const code = recorded.code;
    if (code === KEYWORD_PROVIDER_BUDGET_EXHAUSTED || code === KEYWORD_PROVIDER_RETRY_EXHAUSTED ||
        code === KEYWORD_PROVIDER_RETRY_NOT_SCHEDULED) {
      return { outcome: "failed", code, attempt: null, providerCostUsd: null };
    }
    invariant();
  }
  if (recorded.outcome === "found") {
    await markAmbiguousOnce(repository, { taskId, attemptNumber: recorded.attempt.attemptNumber,
      requestFingerprint: task.requestFingerprint }, now);
    return { outcome: "ambiguous", code: KEYWORD_PROVIDER_AMBIGUOUS };
  }
  if (recorded.outcome !== "created" || recorded.mayCall !== true) invariant();

  const attemptNumber = recorded.attempt.attemptNumber;
  const credentials = config.api?.credentials;
  const login = credentials?.login ?? "";
  const password = credentials?.password ?? "";
  const authorization = `Basic ${Buffer.from(`${login}:${password}`, "utf8").toString("base64")}`;
  const url = `${config.api.baseUrl}${ENDPOINT_PATHS[endpointKey]}`;
  const timeoutSeconds = Number.isInteger(config.api.timeoutSeconds) ? config.api.timeoutSeconds : 120;

  let response;
  try {
    response = await http(url, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify([parsedRequest.data]),
      signal: AbortSignal.timeout(timeoutSeconds * 1000)
    });
  } catch {
    await markAmbiguousOnce(repository, { taskId, attemptNumber, requestFingerprint: task.requestFingerprint }, now);
    return { outcome: "ambiguous", code: KEYWORD_PROVIDER_AMBIGUOUS };
  }

  const status = response?.status;
  let body;
  let decoded = true;
  try {
    body = await response.json();
  } catch {
    body = null;
    decoded = false;
  }

  if (status === 401) {
    const settled = await repository.settleAttempt({
      taskId, token, attemptNumber, state: "failed", providerCostUsd: bodyCost(body),
      safeErrorCode: KEYWORD_PROVIDER_AUTH_FAILED, resultFingerprint: null, cacheEntry: null
    }, now);
    const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: bodyCost(body) });
    if (fence.outcome === "lost") return fence;
    return { outcome: "failed", code: KEYWORD_PROVIDER_AUTH_FAILED, attempt: fence.attempt,
      providerCostUsd: fence.providerCostUsd };
  }

  if (!decoded) {
    await markAmbiguousOnce(repository, { taskId, attemptNumber, requestFingerprint: task.requestFingerprint }, now);
    return { outcome: "ambiguous", code: KEYWORD_PROVIDER_AMBIGUOUS };
  }

  const root = parseRoot(body);
  if (!root) {
    const settled = await repository.settleAttempt({
      taskId, token, attemptNumber, state: "failed", providerCostUsd: bodyCost(body),
      safeErrorCode: KEYWORD_PROVIDER_CONTRACT_MISMATCH, resultFingerprint: null, cacheEntry: null
    }, now);
    const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: bodyCost(body) });
    if (fence.outcome === "lost") return fence;
    return { outcome: "failed", code: KEYWORD_PROVIDER_CONTRACT_MISMATCH, attempt: fence.attempt,
      providerCostUsd: fence.providerCostUsd };
  }

  if (root.status_code === 40100) {
    const settled = await repository.settleAttempt({
      taskId, token, attemptNumber, state: "failed", providerCostUsd: bodyCost(body),
      safeErrorCode: KEYWORD_PROVIDER_AUTH_FAILED, resultFingerprint: null, cacheEntry: null
    }, now);
    const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: bodyCost(body) });
    if (fence.outcome === "lost") return fence;
    return { outcome: "failed", code: KEYWORD_PROVIDER_AUTH_FAILED, attempt: fence.attempt,
      providerCostUsd: fence.providerCostUsd };
  }

  const retryableStatus = config.api.retry?.retryableStatus ?? [];
  const retryableApiCodes = config.api.retry?.retryableApiCodes ?? [];
  if (retryableStatus.includes(status) || retryableApiCodes.includes(root.status_code)) {
    const settled = await repository.settleAttempt({
      taskId, token, attemptNumber, state: "failed", providerCostUsd: bodyCost(body),
      safeErrorCode: KEYWORD_PROVIDER_RETRYABLE, resultFingerprint: null, cacheEntry: null
    }, now);
    const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: bodyCost(body) });
    if (fence.outcome === "lost") return fence;
    return scheduleKnownRetry({ taskId, token, attemptNumber, config, clock, repository, recorded,
      attempt: fence.attempt, providerCostUsd: fence.providerCostUsd });
  }

  if (status !== 200 || root.status_code !== 20000) {
    const settled = await repository.settleAttempt({
      taskId, token, attemptNumber, state: "failed", providerCostUsd: bodyCost(body),
      safeErrorCode: KEYWORD_PROVIDER_TASK_FAILED, resultFingerprint: null, cacheEntry: null
    }, now);
    const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: bodyCost(body) });
    if (fence.outcome === "lost") return fence;
    return { outcome: "failed", code: KEYWORD_PROVIDER_TASK_FAILED, attempt: fence.attempt,
      providerCostUsd: fence.providerCostUsd };
  }

  const taskEnvelope = parseTaskEnvelope(body);
  if (!taskEnvelope) {
    const settled = await repository.settleAttempt({
      taskId, token, attemptNumber, state: "failed", providerCostUsd: bodyCost(body),
      safeErrorCode: KEYWORD_PROVIDER_CONTRACT_MISMATCH, resultFingerprint: null, cacheEntry: null
    }, now);
    const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: bodyCost(body) });
    if (fence.outcome === "lost") return fence;
    return { outcome: "failed", code: KEYWORD_PROVIDER_CONTRACT_MISMATCH, attempt: fence.attempt,
      providerCostUsd: fence.providerCostUsd };
  }

  if (taskEnvelope.status_code !== 20000) {
    const settled = await repository.settleAttempt({
      taskId, token, attemptNumber, state: "failed", providerCostUsd: taskCost(taskEnvelope, 0),
      safeErrorCode: KEYWORD_PROVIDER_TASK_FAILED, resultFingerprint: null, cacheEntry: null
    }, now);
    const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: taskCost(taskEnvelope, 0) });
    if (fence.outcome === "lost") return fence;
    return { outcome: "failed", code: KEYWORD_PROVIDER_TASK_FAILED, attempt: fence.attempt,
      providerCostUsd: fence.providerCostUsd };
  }

  const taskBody = parseEndpointTask(endpointKey, body);
  if (!taskBody) {
    const settled = await repository.settleAttempt({
      taskId, token, attemptNumber, state: "failed", providerCostUsd: taskCost(taskEnvelope, 0),
      safeErrorCode: KEYWORD_PROVIDER_CONTRACT_MISMATCH, resultFingerprint: null, cacheEntry: null
    }, now);
    const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: taskCost(taskEnvelope, 0) });
    if (fence.outcome === "lost") return fence;
    return { outcome: "failed", code: KEYWORD_PROVIDER_CONTRACT_MISMATCH, attempt: fence.attempt,
      providerCostUsd: fence.providerCostUsd };
  }

  let normalized;
  try {
    normalized = normalizeSuccess(endpointKey, taskBody);
  } catch {
    const settled = await repository.settleAttempt({
      taskId, token, attemptNumber, state: "failed", providerCostUsd: taskCost(taskEnvelope, 0),
      safeErrorCode: KEYWORD_PROVIDER_CONTRACT_MISMATCH, resultFingerprint: null, cacheEntry: null
    }, now);
    const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: taskCost(taskEnvelope, 0) });
    if (fence.outcome === "lost") return fence;
    return { outcome: "failed", code: KEYWORD_PROVIDER_CONTRACT_MISMATCH, attempt: fence.attempt,
      providerCostUsd: fence.providerCostUsd };
  }

  const costUsd = taskCost(taskEnvelope, 0);
  const resultFingerprint = fingerprintJson(normalized);
  const settled = await repository.settleAttempt({
    taskId, token, attemptNumber, state: "succeeded", providerCostUsd: costUsd,
    safeErrorCode: null, resultFingerprint,
    cacheEntry: {
      cacheKey: keywordCacheKey(endpointKey, parsedRequest.data),
      endpointKey,
      contractVersion: 1,
      normalizedResponse: normalized,
      resultFingerprint,
      ttlSeconds: CACHE_TTL_SECONDS
    }
  }, now);
  const fence = settlementFence(settled, { attempt: recorded.attempt, providerCostUsd: costUsd });
  if (fence.outcome === "lost") return fence;
  return {
    outcome: "succeeded",
    normalized,
    attempt: fence.attempt,
    providerCostUsd: costUsd
  };
}

async function scheduleKnownRetry({ taskId, token, attemptNumber, config, clock, repository, recorded, attempt, providerCostUsd }) {
  const now = clock();
  const scheduled = await repository.scheduleRetry({ taskId, token, attemptNumber }, now);
  if (scheduled.outcome === "delayed") {
    return { outcome: "retryAt", retryAt: scheduled.retryAt, reason: "retry", attempt: attempt ?? recorded.attempt,
      providerCostUsd: providerCostUsd ?? null };
  }
  if (scheduled.outcome === "conflict" && scheduled.code === KEYWORD_PROVIDER_RETRY_EXHAUSTED) {
    return { outcome: "failed", code: KEYWORD_PROVIDER_RETRY_EXHAUSTED, attempt: attempt ?? recorded.attempt,
      providerCostUsd: providerCostUsd ?? null };
  }
  if (scheduled.outcome === "not_found" || scheduled.outcome === "lost") {
    return { outcome: "lost", attempt: attempt ?? recorded.attempt, providerCostUsd: providerCostUsd ?? null };
  }
  invariant();
}