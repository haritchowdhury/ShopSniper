import http from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ApiError,
  QueryRevisionConflictError,
  RunAdmissionRejectedError,
  RunIntentNotFoundError,
  RunLeaseLostError,
  RunNotAwaitingQueryConfirmationError,
  errorPayload
} from "./api-errors.js";
import {
  serializeDiagnostic,
  serializeLead,
  serializeEditableQueries,
  serializeQueryAudit,
  serializeRun
} from "./api-serializer.js";
import { normalizeShopTypes } from "./category-input.js";
import { assertRunConfig, loadConfig } from "./config.js";
import { log } from "./logger.js";
import {
  planQueriesForReview,
  runDiscoveryFromQueryPlans,
  runPipeline,
  validateConfirmedQueries
} from "./pipeline.js";
import { createPrismaRunRepository } from "./prisma-run-repository.js";
import { validateEditableQueryList } from "./query-review.js";
import { readJsonBody } from "./request-json.js";
import { createInitialStatus } from "./status.js";

export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{16,80}$/u;
export const RUN_INTENT_ID_PATTERN = /^intent_[A-Za-z0-9_-]{32}$/u;
const RUN_LIST_PARAMETERS = new Set(["page", "pageSize"]);
const RESULT_PARAMETERS = new Set([
  "page",
  "pageSize",
  "status",
  "search",
  "sortBy",
  "sortDirection"
]);
const RESULT_STATUSES = new Set(["qualified", "rejected", "failed"]);
const SORT_FIELDS = new Set([
  "lead_score",
  "store_name",
  "shop_type",
  "google_rank"
]);
const DEFAULT_LEASE_DURATION_MS = 90_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 15_000;

function workerId() {
  return `worker_${randomBytes(18).toString("base64url")}`;
}

function currentDate(now) {
  return new Date(now());
}

function sendJson(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers
  });
  response.end(body);
}

function safeDate(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parsePositiveInteger(value, fallback, { max } = {}) {
  if (value == null) return fallback;
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (max != null && parsed > max)) return null;
  return parsed;
}

export function parseResultFilters(searchParams) {
  const unknown = [...searchParams.keys()].filter(
    (name) => !RESULT_PARAMETERS.has(name)
  );
  const duplicate = [...RESULT_PARAMETERS].filter(
    (name) => searchParams.getAll(name).length > 1
  );
  const page = parsePositiveInteger(searchParams.get("page"), 1);
  const pageSize = parsePositiveInteger(searchParams.get("pageSize"), 100, {
    max: 200
  });
  const status = searchParams.get("status") || null;
  const rawSearch = searchParams.get("search");
  const search = rawSearch == null ? null : rawSearch.trim();
  const sortBy = searchParams.get("sortBy") || null;
  const sortDirection = searchParams.get("sortDirection") || "desc";

  const invalid = [];
  if (unknown.length) invalid.push({ parameters: unknown, issue: "unknown" });
  if (duplicate.length) invalid.push({ parameters: duplicate, issue: "duplicate" });
  if (page == null) invalid.push({ parameter: "page", issue: "invalid" });
  if (pageSize == null) invalid.push({ parameter: "pageSize", issue: "invalid" });
  if (status && !RESULT_STATUSES.has(status)) {
    invalid.push({ parameter: "status", issue: "invalid" });
  }
  if (search != null && search.length > 200) {
    invalid.push({ parameter: "search", issue: "too_long" });
  }
  if (sortBy && !SORT_FIELDS.has(sortBy)) {
    invalid.push({ parameter: "sortBy", issue: "invalid" });
  }
  if (!["asc", "desc"].includes(sortDirection)) {
    invalid.push({ parameter: "sortDirection", issue: "invalid" });
  }
  if (invalid.length) {
    throw new ApiError(
      400,
      "INVALID_QUERY_PARAMETERS",
      "One or more result query parameters are invalid.",
      invalid
    );
  }

  return {
    page,
    pageSize,
    status,
    search: search || null,
    sortBy,
    sortDirection
  };
}

function requestedRunId(pathname, suffix = "") {
  const expression = suffix
    ? new RegExp(`^/api/runs/([^/]+)/${suffix}$`, "u")
    : /^\/api\/runs\/([^/]+)$/u;
  const match = pathname.match(expression);
  if (!match) return null;
  let identifier;
  try {
    identifier = decodeURIComponent(match[1]);
  } catch {
    throw new ApiError(400, "INVALID_RUN_ID", "The run ID is invalid.");
  }
  if (!RUN_ID_PATTERN.test(identifier)) {
    throw new ApiError(400, "INVALID_RUN_ID", "The run ID is invalid.");
  }
  return identifier;
}

function requestedRunCollection(pathname, collection) {
  const match = pathname.match(new RegExp(`^/api/runs/([^/]+)/${collection}$`, "u"));
  if (!match) return null;
  let identifier;
  try {
    identifier = decodeURIComponent(match[1]);
  } catch {
    throw new ApiError(400, "INVALID_RUN_ID", "The run ID is invalid.");
  }
  if (!RUN_ID_PATTERN.test(identifier)) {
    throw new ApiError(400, "INVALID_RUN_ID", "The run ID is invalid.");
  }
  return identifier;
}

function requestedIntentId(pathname) {
  const match = pathname.match(/^\/api\/run-intents\/([^/]+)\/claim$/u);
  if (!match) return null;
  let identifier;
  try {
    identifier = decodeURIComponent(match[1]);
  } catch {
    throw new ApiError(400, "INVALID_RUN_INTENT_ID", "The run intent ID is invalid.");
  }
  if (!RUN_INTENT_ID_PATTERN.test(identifier)) {
    throw new ApiError(400, "INVALID_RUN_INTENT_ID", "The run intent ID is invalid.");
  }
  return identifier;
}

function parseRunListPagination(searchParams) {
  const unknown = [...searchParams.keys()].filter(
    (name) => !RUN_LIST_PARAMETERS.has(name)
  );
  const duplicate = [...RUN_LIST_PARAMETERS].filter(
    (name) => searchParams.getAll(name).length > 1
  );
  const page = parsePositiveInteger(searchParams.get("page"), 1);
  const pageSize = parsePositiveInteger(searchParams.get("pageSize"), 20, {
    max: 100
  });
  if (unknown.length || duplicate.length || page == null || pageSize == null) {
    throw new ApiError(
      400,
      "INVALID_QUERY_PARAMETERS",
      "One or more run-list query parameters are invalid."
    );
  }
  return { page, pageSize };
}

function validateRunRequest(payload, maxShopTypes) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(
      400,
      "INVALID_REQUEST_BODY",
      "Request body must be a JSON object."
    );
  }
  const unknown = Object.keys(payload).filter((key) => key !== "shopTypes");
  if (unknown.length) {
    throw new ApiError(
      400,
      "INVALID_REQUEST_BODY",
      "Request body contains unsupported fields.",
      { fields: unknown }
    );
  }
  try {
    return normalizeShopTypes(payload.shopTypes, maxShopTypes);
  } catch (error) {
    throw new ApiError(
      400,
      "INVALID_SHOP_TYPES",
      "One or more shop types are invalid.",
      error.validationDetails || { issue: error.message }
    );
  }
}

function validateRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function validateQueryListRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(400, "INVALID_REQUEST_BODY", "Request body must be a JSON object.");
  }
  const unknown = Object.keys(payload).filter((key) => !["revision", "queries"].includes(key));
  if (unknown.length || validateRevision(payload.revision) == null || !Array.isArray(payload.queries)) {
    throw new ApiError(
      400,
      "INVALID_REQUEST_BODY",
      "The request must contain only a non-negative revision and a queries array.",
      unknown.length ? { fields: unknown } : undefined
    );
  }
  return payload;
}

function validateStartRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(400, "INVALID_REQUEST_BODY", "Request body must be a JSON object.");
  }
  if (Object.keys(payload).some((key) => key !== "revision") || validateRevision(payload.revision) == null) {
    throw new ApiError(
      400,
      "INVALID_REQUEST_BODY",
      "The request must contain only a non-negative revision."
    );
  }
  return payload.revision;
}

function throwQueryLifecycleApiError(error) {
  if (error instanceof QueryRevisionConflictError) {
    throw new ApiError(
      409,
      "QUERY_REVISION_CONFLICT",
      "The query list changed. Reload it before continuing.",
      { currentRevision: error.currentRevision }
    );
  }
  if (error instanceof RunNotAwaitingQueryConfirmationError) {
    throw new ApiError(
      409,
      "RUN_NOT_AWAITING_QUERY_CONFIRMATION",
      "This run is not currently editable."
    );
  }
  throw error;
}

function hasAccess(request, token) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function trustedUserId(request) {
  const distinct = request.headersDistinct?.["x-user-id"];
  const values = Array.isArray(distinct)
    ? distinct
    : request.headers["x-user-id"] == null
      ? []
      : Array.isArray(request.headers["x-user-id"])
        ? request.headers["x-user-id"]
        : [request.headers["x-user-id"]];
  if (values.length !== 1) {
    throw new ApiError(
      401,
      "USER_CONTEXT_REQUIRED",
      "Authenticated user context is required."
    );
  }
  const value = values[0].trim();
  if (!value || value.length > 255 || /[,\r\n\0]/u.test(value)) {
    throw new ApiError(
      401,
      "USER_CONTEXT_REQUIRED",
      "Authenticated user context is required."
    );
  }
  return value;
}

function startRunPayload(run) {
  const statusUrl = `/api/runs/${encodeURIComponent(run.id)}`;
  return {
    runId: run.id,
    state: run.state,
    phase: run.phase || "query_planning",
    stage: run.stage || "queued_query_planning",
    statusUrl,
    queriesUrl: `${statusUrl}/queries`,
    resultsUrl: `${statusUrl}/results`,
    createdAt: safeDate(run.createdAt)
  };
}

function createProgressTracker(
  repository,
  identifier,
  lease,
  status,
  { now, onLeaseLost }
) {
  let timer = null;
  let pending = Promise.resolve();

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = pending.then(() =>
      repository.updateProgress(identifier, lease, status, currentDate(now))
    );
    return pending;
  };

  const tracked = new Proxy(status, {
    set(target, property, value) {
      target[property] = value;
      if (timer == null) {
        timer = setTimeout(() => {
          timer = null;
          void flush().catch(onLeaseLost);
        }, 250);
      }
      return true;
    }
  });

  const stop = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    await pending;
  };

  return { status: tracked, flush, stop };
}

function createHeartbeatMonitor({
  repository,
  identifier,
  lease,
  now,
  leaseDurationMs,
  heartbeatIntervalMs,
  setIntervalFn,
  clearIntervalFn,
  onLeaseLost
}) {
  let stopped = false;
  let pending = Promise.resolve();

  const renew = () => {
    if (stopped) return pending;
    pending = pending.then(async () => {
      if (stopped) return;
      await repository.heartbeatRun(
        identifier,
        lease,
        currentDate(now),
        leaseDurationMs
      );
    });
    pending.catch(onLeaseLost);
    return pending;
  };

  const timer = setIntervalFn(() => { void renew(); }, heartbeatIntervalMs);
  timer?.unref?.();

  return {
    renew,
    async stop() {
      stopped = true;
      clearIntervalFn(timer);
      await pending;
    }
  };
}

async function executeRun({
  config,
  identifier,
  categories,
  lease,
  pipeline,
  planningPipeline,
  queryValidationPipeline,
  discoveryPipeline,
  repository,
  logger,
  now,
  leaseDurationMs,
  heartbeatIntervalMs,
  setIntervalFn,
  clearIntervalFn
}) {
  const baseStatus = {
    ...createInitialStatus(),
    state: "running",
    stage: categories.phase === "scraping"
      ? "validating_confirmed_queries"
      : "reading_categories",
    runId: identifier,
    shopTypesTotal: categories.items.length,
    startedAt: new Date().toISOString()
  };
  let leaseLoss = null;
  const onLeaseLost = (error) => {
    if (!leaseLoss) leaseLoss = error;
  };
  const tracker = createProgressTracker(repository, identifier, lease, baseStatus, {
    now,
    onLeaseLost
  });
  const heartbeat = createHeartbeatMonitor({
    repository,
    identifier,
    lease,
    now,
    leaseDurationMs,
    heartbeatIntervalMs,
    setIntervalFn,
    clearIntervalFn,
    onLeaseLost
  });

  try {
    const supportsReview = typeof repository.saveGeneratedQueryPlan === "function";
    let result;
    if (supportsReview && categories.phase === "query_planning") {
      const planning = await planningPipeline(config, tracker.status, {
        categories: categories.items
      });
      await tracker.flush();
      if (leaseLoss) throw leaseLoss;
      await heartbeat.renew();
      await heartbeat.stop();
      await repository.saveGeneratedQueryPlan(
        identifier,
        lease,
        {
          ...planning,
          categories: categories.items,
          config
        },
        tracker.status,
        currentDate(now)
      );
      logger("query_plan_ready", {
        runId: identifier,
        revision: 1,
        queries: planning.selected.length
      });
      return;
    }
    if (supportsReview && categories.phase === "scraping") {
      const rows = await repository.loadConfirmedQueryPlans(
        identifier,
        lease,
        currentDate(now)
      );
      const validation = await queryValidationPipeline(config, tracker.status, {
        rows,
        categories: categories.items,
        now: currentDate(now)
      });
      await repository.saveQueryValidation(
        identifier,
        lease,
        validation.rows,
        currentDate(now)
      );
      await tracker.flush();
      if (!validation.valid) {
        await heartbeat.stop();
        await repository.returnRunToQueryReview(
          identifier,
          lease,
          tracker.status,
          currentDate(now)
        );
        logger("query_confirmation_rejected", {
          runId: identifier,
          invalidQueries: validation.rows.filter((row) => row.validationState === "invalid").length
        });
        return;
      }
      result = await discoveryPipeline(config, tracker.status, {
        queryPlans: validation.queryPlans
      });
    } else {
      result = await pipeline(config, tracker.status, { categories: categories.items });
    }
    tracker.status.stage = "writing_results";
    tracker.status.outputRows = result.leads.length;
    await tracker.flush();
    if (leaseLoss) throw leaseLoss;
    await heartbeat.renew();
    if (leaseLoss) throw leaseLoss;
    await heartbeat.stop();
    await repository.saveCompletedResults(
      identifier,
      lease,
      result,
      tracker.status,
      currentDate(now)
    );
    logger("run_completed", {
      runId: identifier,
      outputRows: result.summary.total,
      qualified: result.summary.qualified,
      rejected: result.summary.rejected,
      failures: result.summary.failed
    });
  } catch (error) {
    await heartbeat.stop().catch(onLeaseLost);
    await tracker.stop().catch(onLeaseLost);
    if (leaseLoss || error instanceof RunLeaseLostError) {
      logger("run_lease_lost", { runId: identifier, code: "RUN_LEASE_LOST" });
      return;
    }
    await tracker.flush().catch(onLeaseLost);
    if (leaseLoss) {
      logger("run_lease_lost", { runId: identifier, code: "RUN_LEASE_LOST" });
      return;
    }
    await repository
      .markFailed(
        identifier,
        lease,
        {
          code: "RUN_FAILED",
          message: "The run could not be completed. Please try again."
        },
        tracker.status,
        currentDate(now)
      )
      .catch((persistenceError) => {
        logger("run_failure_persistence_failed", {
          runId: identifier,
          error: persistenceError
        });
      });
    logger("run_failed", { runId: identifier, error });
  } finally {
    await heartbeat.stop().catch(() => {});
    await tracker.stop().catch(() => {});
  }
}

export function createLeadServer(
  config,
  {
    pipeline = runPipeline,
    planningPipeline = planQueriesForReview,
    queryValidationPipeline = validateConfirmedQueries,
    discoveryPipeline = runDiscoveryFromQueryPlans,
    repository = createPrismaRunRepository(),
    schedule = setImmediate,
    logger = log,
    now = () => Date.now(),
    leaseOwner = workerId(),
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = {}
) {
  const acceptedRunTimes = [];
  const acceptedConfirmationTimes = [];
  let admissionTail = Promise.resolve();
  let drainScheduled = false;
  let draining = false;
  let drainRequested = false;

  function checkRunConfiguration() {
    try {
      assertRunConfig(config);
    } catch {
      throw new ApiError(
        503,
        "BACKEND_CONFIGURATION_UNAVAILABLE",
        "The backend is not configured to start runs."
      );
    }
  }

  function expireAdmissions(timestamp) {
    const cutoff = timestamp - (config.runRateLimitWindowMs || 60000);
    while (acceptedRunTimes.length && acceptedRunTimes[0].at <= cutoff) {
      acceptedRunTimes.shift();
    }
  }

  function rateLimitError() {
    return new ApiError(
      429,
      "RUN_RATE_LIMITED",
      "Too many runs were started recently. Please try again later."
    );
  }

  function enforceConfirmationRateLimit() {
    const timestamp = now();
    const cutoff = timestamp - (config.queryConfirmRateLimitWindowMs || 60000);
    while (acceptedConfirmationTimes.length && acceptedConfirmationTimes[0] <= cutoff) {
      acceptedConfirmationTimes.shift();
    }
    if (acceptedConfirmationTimes.length >= (config.queryConfirmRateLimitMax || 10)) {
      throw new ApiError(
        429,
        "QUERY_CONFIRMATION_RATE_LIMITED",
        "Too many query confirmations were attempted recently. Please try again later."
      );
    }
    acceptedConfirmationTimes.push(timestamp);
  }

  async function admitRun(operation) {
    const previous = admissionTail;
    let releaseLock;
    admissionTail = new Promise((resolve) => { releaseLock = resolve; });
    await previous;

    const timestamp = now();
    expireAdmissions(timestamp);
    const hasCapacity = acceptedRunTimes.length < (config.runRateLimitMax || 5);
    const reservation = hasCapacity ? { at: timestamp } : null;
    if (reservation) acceptedRunTimes.push(reservation);
    try {
      const result = await operation({ allowCreate: hasCapacity });
      if (result.created && !reservation) throw rateLimitError();
      if (!result.created && reservation) {
        acceptedRunTimes.splice(acceptedRunTimes.indexOf(reservation), 1);
      }
      return result;
    } catch (error) {
      if (reservation) {
        const index = acceptedRunTimes.indexOf(reservation);
        if (index >= 0) acceptedRunTimes.splice(index, 1);
      }
      if (error instanceof RunAdmissionRejectedError) throw rateLimitError();
      throw error;
    } finally {
      releaseLock();
    }
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;
    try {
      do {
        drainRequested = false;
        let run;
        while ((run = await repository.claimNextQueuedRun(
          leaseOwner,
          currentDate(now),
          leaseDurationMs
        ))) {
          const categories = Array.isArray(run.run.normalizedShopTypes)
            ? run.run.normalizedShopTypes
            : [];
          await executeRun({
            config,
            identifier: run.run.id,
            categories: { items: categories, phase: run.run.phase || "scraping" },
            lease: run.lease,
            pipeline,
            planningPipeline,
            queryValidationPipeline,
            discoveryPipeline,
            repository,
            logger,
            now,
            leaseDurationMs,
            heartbeatIntervalMs,
            setIntervalFn,
            clearIntervalFn
          });
        }
      } while (drainRequested);
    } catch (error) {
      logger("queue_drain_failed", { error });
    } finally {
      draining = false;
    }
  }

  function queueDrain() {
    drainRequested = true;
    if (draining || drainScheduled) return;
    drainScheduled = true;
    schedule(() => {
      drainScheduled = false;
      void drainQueue();
    });
  }

  async function handle(request, response) {
    const requestUrl = new URL(request.url || "/", "http://localhost");

    if (!hasAccess(request, config.backendApiToken)) {
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "Valid backend authorization is required."
      );
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      try {
        await repository.health();
        return sendJson(response, 200, { status: "ok" });
      } catch (error) {
        logger("database_health_failed", { error });
        throw new ApiError(
          503,
          "DATABASE_UNAVAILABLE",
          "The database is currently unavailable."
        );
      }
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/run-intents") {
      const payload = await readJsonBody(request);
      const categories = validateRunRequest(payload, config.maxShopTypes || 100);
      const expiresAt = new Date(now() + 60 * 60 * 1000);
      const intent = await repository.createRunIntent(categories, expiresAt);
      void repository.deleteExpiredRunIntents?.(new Date(now())).catch(() => {});
      return sendJson(response, 201, {
        intentId: intent.id,
        expiresAt: safeDate(intent.expiresAt)
      });
    }

    if (request.method === "POST") {
      const intentIdentifier = requestedIntentId(requestUrl.pathname);
      if (intentIdentifier) {
        const ownerId = trustedUserId(request);
        checkRunConfiguration();
        let claimed;
        try {
          claimed = await admitRun(({ allowCreate }) =>
            repository.claimRunIntent(
              intentIdentifier,
              ownerId,
              new Date(now()),
              { allowCreate }
            )
          );
        } catch (error) {
          if (error instanceof RunIntentNotFoundError) {
            throw new ApiError(
              404,
              "RUN_INTENT_NOT_FOUND",
              "The pending search was not found or has expired."
            );
          }
          throw error;
        }
        queueDrain();
        const payload = startRunPayload(claimed.run);
        return sendJson(response, claimed.created ? 201 : 200, payload, {
          location: payload.statusUrl
        });
      }
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/runs") {
      const ownerId = trustedUserId(request);
      const payload = await readJsonBody(request);
      const categories = validateRunRequest(payload, config.maxShopTypes || 100);
      checkRunConfiguration();
      const { run } = await admitRun(async ({ allowCreate }) => {
        if (!allowCreate) throw rateLimitError();
        return {
          run: await repository.createRun(ownerId, categories),
          created: true
        };
      });

      const startPayload = startRunPayload(run);
      sendJson(
        response,
        202,
        startPayload,
        { location: startPayload.statusUrl }
      );
      queueDrain();
      return;
    }

    if (request.method === "PUT") {
      const identifier = requestedRunId(requestUrl.pathname, "queries");
      if (identifier) {
        const ownerId = trustedUserId(request);
        if (typeof repository.getEditableQueries !== "function") {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        const payload = validateQueryListRequest(await readJsonBody(request, 128 * 1024));
        const run = await repository.getEditableQueries(identifier, ownerId);
        if (!run) {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        if (run.state !== "awaiting_query_confirmation" || run.phase !== "query_review") {
          throw new ApiError(
            409,
            "RUN_NOT_AWAITING_QUERY_CONFIRMATION",
            "This run is not currently editable."
          );
        }
        const categories = Array.isArray(run.normalizedShopTypes)
          ? run.normalizedShopTypes
          : [];
        const categoryVocabularyByIndex = categories.map((_, categoryIndex) => [
          ...new Set((run.queries || [])
            .filter((row) => row.categoryIndex === categoryIndex)
            .flatMap((row) => Array.isArray(row.categoryVocabulary) ? row.categoryVocabulary : []))
        ]);
        const checked = validateEditableQueryList(payload.queries, categories, {
          maxQueries: config.maxQueries || 500,
          categoryVocabularyByIndex
        });
        if (!checked.valid) {
          throw new ApiError(
            422,
            "QUERY_LIST_INVALID",
            "One or more queries are invalid.",
            { errors: checked.errors }
          );
        }
        try {
          const updated = await repository.replaceEditableQueries(
            identifier,
            ownerId,
            payload.revision,
            checked.queries,
            currentDate(now)
          );
          if (!updated) {
            throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
          }
          return sendJson(response, 200, serializeEditableQueries(updated));
        } catch (error) {
          throwQueryLifecycleApiError(error);
        }
      }
    }

    if (request.method === "POST") {
      const identifier = requestedRunId(requestUrl.pathname, "start");
      if (identifier) {
        const ownerId = trustedUserId(request);
        enforceConfirmationRateLimit();
        const revision = validateStartRequest(await readJsonBody(request));
        if (typeof repository.confirmQueryRevision !== "function") {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        try {
          const current = await repository.getEditableQueries(identifier, ownerId);
          if (!current) {
            throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
          }
          const categories = Array.isArray(current.normalizedShopTypes)
            ? current.normalizedShopTypes
            : [];
          const categoryVocabularyByIndex = categories.map((_, categoryIndex) => [
            ...new Set((current.queries || [])
              .filter((row) => row.categoryIndex === categoryIndex)
              .flatMap((row) => Array.isArray(row.categoryVocabulary) ? row.categoryVocabulary : []))
          ]);
          const checked = validateEditableQueryList(
            (current.queries || []).map(({ id, categoryIndex, query }) => ({
              id,
              categoryIndex,
              query
            })),
            categories,
            { maxQueries: config.maxQueries || 500, categoryVocabularyByIndex }
          );
          if (!checked.valid) {
            throw new ApiError(
              422,
              "QUERY_LIST_INVALID",
              "One or more queries are invalid.",
              { errors: checked.errors }
            );
          }
          const run = await repository.confirmQueryRevision(
            identifier,
            ownerId,
            revision,
            currentDate(now)
          );
          if (!run) {
            throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
          }
          queueDrain();
          return sendJson(response, 202, {
            runId: run.id,
            state: run.state,
            phase: run.phase,
            stage: run.stage,
            revision: run.confirmedQueryRevision
          });
        } catch (error) {
          throwQueryLifecycleApiError(error);
        }
      }
    }

    if (request.method === "GET") {
      if (requestUrl.pathname === "/api/runs") {
        const ownerId = trustedUserId(request);
        const pagination = parseRunListPagination(requestUrl.searchParams);
        const page = await repository.listRuns(ownerId, pagination);
        return sendJson(response, 200, {
          pagination: {
            ...pagination,
            totalItems: page.totalItems,
            totalPages: Math.ceil(page.totalItems / pagination.pageSize)
          },
          items: page.items.map(serializeRun)
        });
      }

      const queriesIdentifier = requestedRunId(requestUrl.pathname, "queries");
      if (queriesIdentifier) {
        const ownerId = trustedUserId(request);
        if (typeof repository.getEditableQueries !== "function") {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        const run = await repository.getEditableQueries(queriesIdentifier, ownerId);
        if (!run) {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        if (run.queryRevision < 1) {
          throw new ApiError(
            409,
            "QUERY_CONFIRMATION_IN_PROGRESS",
            "The query plan is not ready yet."
          );
        }
        return sendJson(response, 200, serializeEditableQueries(run));
      }

      for (const collection of ["query-audits", "diagnostics"]) {
        const identifier = requestedRunCollection(requestUrl.pathname, collection);
        if (!identifier) continue;
        const ownerId = trustedUserId(request);
        const pagination = parseRunListPagination(requestUrl.searchParams);
        const run = await repository.getRun(identifier, ownerId);
        if (!run) {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        if (!run.resultsAvailable) {
          throw new ApiError(409, "RESULTS_UNAVAILABLE", "Results are unavailable for this run.");
        }
        const page = collection === "query-audits"
          ? await repository.getQueryAuditsPage(identifier, ownerId, pagination)
          : await repository.getDiagnosticsPage(identifier, ownerId, pagination);
        return sendJson(response, 200, {
          runId: identifier,
          pagination: {
            ...pagination,
            totalItems: page.totalItems,
            totalPages: Math.ceil(page.totalItems / pagination.pageSize)
          },
          items: page.items.map(collection === "query-audits" ? serializeQueryAudit : serializeDiagnostic)
        });
      }

      const resultsIdentifier = requestedRunId(requestUrl.pathname, "results");
      if (resultsIdentifier) {
        const ownerId = trustedUserId(request);
        const filters = parseResultFilters(requestUrl.searchParams);
        const run = await repository.getRun(resultsIdentifier, ownerId);
        if (!run) {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        if (!run.resultsAvailable && [
          "queued",
          "running",
          "awaiting_query_confirmation"
        ].includes(run.state)) {
          throw new ApiError(
            409,
            "RESULTS_NOT_READY",
            "Results are not ready for this run."
          );
        }
        if (!run.resultsAvailable) {
          throw new ApiError(
            409,
            "RESULTS_UNAVAILABLE",
            "Results are unavailable for this run."
          );
        }
        const page = await repository.getResultsPage(
          resultsIdentifier,
          ownerId,
          filters
        );
        const summary = run.leadSummary || {
          total: 0,
          qualified: 0,
          rejected: 0,
          failed: 0
        };
        return sendJson(response, 200, {
          runId: resultsIdentifier,
          summary,
          pagination: {
            page: filters.page,
            pageSize: filters.pageSize,
            totalItems: page.totalItems,
            totalPages: Math.ceil(page.totalItems / filters.pageSize)
          },
          items: page.items.map(serializeLead)
        });
      }

      const statusIdentifier = requestedRunId(requestUrl.pathname);
      if (statusIdentifier) {
        const ownerId = trustedUserId(request);
        const run = await repository.getRun(statusIdentifier, ownerId);
        if (!run) {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        return sendJson(response, 200, serializeRun(run));
      }
    }

    throw new ApiError(404, "NOT_FOUND", "The requested endpoint was not found.");
  }

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!(error instanceof ApiError)) {
        logger("api_request_failed", {
          method: request.method,
          path: request.url,
          error
        });
      }
      if (!response.headersSent) {
        const status = error instanceof ApiError ? error.status : 500;
        sendJson(response, status, errorPayload(error));
      } else {
        response.destroy();
      }
    });
  });

  const recoveryTimer = setIntervalFn(() => {
    void repository.recoverExpiredRuns(currentDate(now))
      .then((recovered) => {
        if (recovered.count) {
          logger("expired_runs_recovered", { count: recovered.count });
        }
        queueDrain();
      })
      .catch((error) => logger("run_recovery_failed", { error }));
  }, recoveryIntervalMs);
  recoveryTimer?.unref?.();
  server.on("close", () => clearIntervalFn(recoveryTimer));

  queueDrain();
  return server;
}

export async function startServer(config = loadConfig()) {
  if (process.env.NODE_ENV === "production" && !config.backendApiToken) {
    throw new Error("BACKEND_API_TOKEN is required in production");
  }
  const repository = createPrismaRunRepository();
  try {
    const recovered = await repository.recoverExpiredRuns();
    if (recovered.count) log("expired_runs_recovered", { count: recovered.count });
  } catch (error) {
    log("run_recovery_failed", { error });
  }
  const server = createLeadServer(config, { repository });
  server.listen(config.port, config.host, () => {
    log("server_started", { host: config.host, port: config.port });
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await startServer();
  } catch (error) {
    log("startup_failed", { error });
    process.exitCode = 1;
  }
}
