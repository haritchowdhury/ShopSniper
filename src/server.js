import http from "node:http";
import { fileURLToPath } from "node:url";
import { ActiveRunError, ApiError, errorPayload } from "./api-errors.js";
import { serializeLead, serializeRun } from "./api-serializer.js";
import { normalizeShopTypes } from "./category-input.js";
import { assertRunConfig, loadConfig } from "./config.js";
import { log } from "./logger.js";
import { runPipeline } from "./pipeline.js";
import { createPrismaRunRepository } from "./prisma-run-repository.js";
import { readJsonBody } from "./request-json.js";
import { createInitialStatus } from "./status.js";

export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{16,80}$/u;
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
  const expression = suffix === "results"
    ? /^\/api\/runs\/([^/]+)\/results$/u
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

function hasAccess(request, token) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function createProgressTracker(repository, identifier, status) {
  let timer = null;
  let pending = Promise.resolve();

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = pending
      .catch(() => {})
      .then(() => repository.updateProgress(identifier, status));
    return pending;
  };

  const tracked = new Proxy(status, {
    set(target, property, value) {
      target[property] = value;
      if (timer == null) {
        timer = setTimeout(() => {
          timer = null;
          void flush().catch(() => {});
        }, 250);
      }
      return true;
    }
  });

  return { status: tracked, flush };
}

async function executeRun({
  config,
  identifier,
  categories,
  pipeline,
  repository,
  logger
}) {
  const baseStatus = {
    ...createInitialStatus(),
    state: "running",
    stage: "reading_categories",
    runId: identifier,
    shopTypesTotal: categories.length,
    startedAt: new Date().toISOString()
  };
  const tracker = createProgressTracker(repository, identifier, baseStatus);

  try {
    await repository.markRunning(identifier);
    const result = await pipeline(config, tracker.status, { categories });
    tracker.status.stage = "writing_results";
    tracker.status.outputRows = result.leads.length;
    await tracker.flush();
    await repository.saveCompletedResults(identifier, result, tracker.status);
    logger("run_completed", {
      runId: identifier,
      outputRows: result.summary.total,
      qualified: result.summary.qualified,
      rejected: result.summary.rejected,
      failures: result.summary.failed
    });
  } catch (error) {
    await tracker.flush().catch(() => {});
    await repository
      .markFailed(
        identifier,
        {
          code: "RUN_FAILED",
          message: "The run could not be completed. Please try again."
        },
        tracker.status
      )
      .catch((persistenceError) => {
        logger("run_failure_persistence_failed", {
          runId: identifier,
          error: persistenceError
        });
      });
    logger("run_failed", { runId: identifier, error });
  }
}

export function createLeadServer(
  config,
  {
    pipeline = runPipeline,
    repository = createPrismaRunRepository(),
    schedule = setImmediate,
    logger = log,
    now = () => Date.now()
  } = {}
) {
  const acceptedRunTimes = [];

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

    if (request.method === "POST" && requestUrl.pathname === "/api/runs") {
      const payload = await readJsonBody(request);
      const categories = validateRunRequest(payload, config.maxShopTypes || 100);
      try {
        assertRunConfig(config);
      } catch {
        throw new ApiError(
          503,
          "BACKEND_CONFIGURATION_UNAVAILABLE",
          "The backend is not configured to start runs."
        );
      }

      const cutoff = now() - (config.runRateLimitWindowMs || 60000);
      while (acceptedRunTimes.length && acceptedRunTimes[0] <= cutoff) {
        acceptedRunTimes.shift();
      }
      if (acceptedRunTimes.length >= (config.runRateLimitMax || 5)) {
        throw new ApiError(
          429,
          "RUN_RATE_LIMITED",
          "Too many runs were started recently. Please try again later."
        );
      }

      let run;
      try {
        run = await repository.createRun(categories);
      } catch (error) {
        if (error instanceof ActiveRunError) {
          throw new ApiError(
            409,
            "RUN_ALREADY_ACTIVE",
            "A lead-generation run is already active.",
            error.runId ? { runId: error.runId } : undefined
          );
        }
        throw error;
      }
      acceptedRunTimes.push(now());

      const statusUrl = `/api/runs/${encodeURIComponent(run.id)}`;
      sendJson(
        response,
        202,
        {
          runId: run.id,
          state: "queued",
          statusUrl,
          resultsUrl: `${statusUrl}/results`,
          createdAt: safeDate(run.createdAt)
        },
        { location: statusUrl }
      );
      schedule(() => {
        void executeRun({
          config,
          identifier: run.id,
          categories,
          pipeline,
          repository,
          logger
        });
      });
      return;
    }

    if (request.method === "GET") {
      const resultsIdentifier = requestedRunId(requestUrl.pathname, "results");
      if (resultsIdentifier) {
        const filters = parseResultFilters(requestUrl.searchParams);
        const run = await repository.getRun(resultsIdentifier);
        if (!run) {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        if (!run.resultsAvailable && ["queued", "running"].includes(run.state)) {
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
        const page = await repository.getResultsPage(resultsIdentifier, filters);
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
        const run = await repository.getRun(statusIdentifier);
        if (!run) {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        return sendJson(response, 200, serializeRun(run));
      }
    }

    throw new ApiError(404, "NOT_FOUND", "The requested endpoint was not found.");
  }

  return http.createServer((request, response) => {
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
}

export async function startServer(config = loadConfig()) {
  const repository = createPrismaRunRepository();
  try {
    const recovered = await repository.recoverInterruptedRuns();
    if (recovered.count) log("interrupted_runs_recovered", { count: recovered.count });
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
