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
  serializeCurrentShopTraffic,
  serializeLead,
  serializeEditableQueries,
  serializeQueryAudit,
  serializeRun,
  serializeTrafficOverview,
  runResultsAvailable
} from "./api-serializer.js";
import { normalizeShopTypes } from "./category-input.js";
import { assertRunConfig, loadConfig } from "./config.js";
import { log } from "./logger.js";
import { finalizeLeadScoresV3 } from "./lead-score-finalizer.js";
import { enrichTraffic } from "./enrichment/orchestrator.js";
import {
  discoverLeadForRunStore,
  discoverStoresFromQueryPlans,
  failedLeadForRunStore,
  materializeLeadFromProfile,
  planQueriesForReview,
  runDiscoveryFromQueryPlans,
  runPipeline,
  validateConfirmedQueries
} from "./pipeline.js";
import {
  createPrismaRunRepository,
  stableLeadId
} from "./prisma-run-repository.js";
import {
  validateEditableQueryList,
  validateResearchBackedQueryList,
  validateResearchBackedConfirmedQueryRows
} from "./query-review.js";
import { createKeywordResearchApi } from "./keyword-intelligence/api.js";
import { PrismaKeywordResearchRepository } from "./keyword-intelligence/repository.js";
import { keywordMessageSchema } from "./aws-pipeline/keyword-intelligence/contracts.js";
import { readJsonBody } from "./request-json.js";
import { createInitialStatus } from "./status.js";
import { parseAwsProviderConfig } from "./aws-pipeline/contracts/aws-provider-config.js";
import { PipelineInvariantError } from "./aws-pipeline/contracts/errors.js";
import { createPipelineRuntime } from "./aws-pipeline/runtime.js";
import { dispatchConfirmedQueries } from "./aws-pipeline/services/confirmed-query-dispatcher.js";
import {
  googleProbeAttemptArtifactSchema,
  googleProbeResultArtifactSchema,
  parseGoogleProbeResultArtifact
} from "./aws-pipeline/contracts/artifacts.js";
import { fingerprintJson } from "./aws-pipeline/core/canonical.js";
import {
  googleProbeAttemptArtifactKey,
  googleProbeResultArtifactKey
} from "./aws-pipeline/core/keys.js";
import { searchGooglePage } from "./search.js";

export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{16,80}$/u;
export const RUN_INTENT_ID_PATTERN = /^intent_[A-Za-z0-9_-]{32}$/u;
const KEYWORD_RESEARCH_ID_PATTERN = /^kr_[A-Za-z0-9_-]{24}$/u;
const RUN_LIST_PARAMETERS = new Set(["page", "pageSize"]);
const RESULT_PARAMETERS = new Set([
  "page",
  "pageSize",
  "status",
  "search",
  "sortBy",
  "sortDirection",
  "discoveryQuery"
]);
const TRAFFIC_OVERVIEW_PARAMETERS = new Set(["search", "discoveryQuery"]);
const MASTER_LEAD_PARAMETERS = new Set([
  "page", "pageSize", "search", "sortBy", "sortDirection", "archived", "discoveryQuery"
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

function queryReviewPolicy(run, config) {
  if (run.executionBackend !== "aws") return {
    maxQueries: config.maxQueries || 500,
    generatedQueryCount: config.generatedQueryCount ?? 10,
    awsProviderConfig: null
  };
  const awsProviderConfig = parseAwsProviderConfig(run.awsProviderConfig);
  return {
    maxQueries: awsProviderConfig.queryValidation.maxQueries,
    generatedQueryCount: awsProviderConfig.queryValidation.generatedQueryCount,
    awsProviderConfig
  };
}

function awsValidationConfig(snapshot) {
  return {
    ...snapshot.queryValidation,
    googleResultsPerQuery: snapshot.googleSearch.resultsPerQuery
  };
}

function awsProbeSearchPage({ runId, confirmedRevision, queriesConfirmedAt, snapshot, runtime }) {
  const providerConfigFingerprint = fingerprintJson(snapshot.googleSearch);
  const producedAt = queriesConfirmedAt.toISOString();
  const searchConfig = {
    googleApiKey: runtime.secrets.googleApiKey,
    googleSearchEngineId: runtime.secrets.googleSearchEngineId,
    googleResultsPerQuery: snapshot.googleSearch.resultsPerQuery,
    requestTimeoutMs: snapshot.googleSearch.requestTimeoutMs
  };
  const engineFingerprint = fingerprintJson({
    contractVersion: "google-search-engine-v1",
    searchEngineId: searchConfig.googleSearchEngineId
  });
  if (!searchConfig.googleApiKey || engineFingerprint !== snapshot.googleSearch.engineIdFingerprint) {
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  return async (query) => {
    const searchRequestFingerprint = fingerprintJson({
      contractVersion: "google-probe-request-v1", runId, generation: 1,
      confirmedRevision, queriesConfirmedAt: producedAt, query, providerConfigFingerprint
    });
    const expected = {
      contractVersion: "google-probe-result-v1", runId, stage: "query_validation", generation: 1,
      itemId: searchRequestFingerprint, inputFingerprint: searchRequestFingerprint, producedAt
    };
    const resultKey = googleProbeResultArtifactKey(runId, searchRequestFingerprint);
    const storedResult = await runtime.artifactStore.getOptionalValidated({
      key: resultKey, expected, schema: googleProbeResultArtifactSchema
    });
    const reconstruct = (raw) => {
      const parsed = parseGoogleProbeResultArtifact(raw);
      return {
        estimatedTotalResults: parsed.estimatedTotalResults,
        nextPageAvailable: parsed.nextPageAvailable,
        results: [
          ...parsed.results.map((item) => ({ ...item, query, rejectionReason: "" })),
          ...parsed.rejections.map((item) => ({ query, rank: item.rank, url: "", title: "", snippet: "",
            rejectionReason: item.reason }))
        ].sort((left, right) => left.rank - right.rank)
      };
    };
    if (storedResult.outcome === "found") return reconstruct(storedResult.value);

    const attemptKey = googleProbeAttemptArtifactKey(runId, searchRequestFingerprint);
    const attemptExpected = { ...expected, contractVersion: "google-probe-attempt-v1" };
    const marker = await runtime.artifactStore.getOptionalValidated({
      key: attemptKey, expected: attemptExpected, schema: googleProbeAttemptArtifactSchema
    });
    if (marker.outcome === "found") {
      throw new PipelineInvariantError("PIPELINE_PROVIDER_AMBIGUOUS");
    }
    const attempt = { contractVersion: "google-probe-attempt-v1", runId, generation: 1,
      searchRequestFingerprint, providerConfigFingerprint };
    await runtime.artifactStore.putImmutable({ key: attemptKey, ...attemptExpected,
      value: attempt, schema: googleProbeAttemptArtifactSchema });
    const page = await searchGooglePage(query, searchConfig, { retries: 0 });
    const normalized = {
      contractVersion: "google-probe-result-v1", runId, generation: 1,
      searchRequestFingerprint, providerConfigFingerprint,
      estimatedTotalResults: page.estimatedTotalResults,
      nextPageAvailable: Boolean(page.nextPageAvailable),
      results: page.results.filter((item) => !item.rejectionReason).map(({ rank, url, title, snippet }) =>
        ({ rank, url, title, snippet })),
      rejections: page.results.filter((item) => item.rejectionReason).map(({ rank, rejectionReason }) =>
        ({ rank, reason: rejectionReason }))
    };
    const parsed = parseGoogleProbeResultArtifact(normalized);
    await runtime.artifactStore.putImmutable({ key: resultKey, ...expected,
      value: parsed, schema: googleProbeResultArtifactSchema });
    return reconstruct(parsed);
  };
}
const DEFAULT_RECOVERY_INTERVAL_MS = 15_000;

function workerId() {
  return `worker_${randomBytes(18).toString("base64url")}`;
}

function currentDate(now) {
  return new Date(now());
}

export async function recoverInterruptedWork(
  repository,
  now = new Date(),
  logger = log
) {
  try {
    const recovered = await repository.recoverExpiredRuns(now);
    if (recovered.count) {
      logger("expired_runs_recovered", { count: recovered.count });
    }
  } catch {
    logger("run_recovery_failed", { code: "RUN_RECOVERY_FAILED" });
  }

  if (typeof repository.markStaleDataForSeoRequestsAmbiguous !== "function") {
    return;
  }

  try {
    const recovered = await repository.markStaleDataForSeoRequestsAmbiguous(now);
    if (recovered.count) {
      logger("stale_paid_requests_marked_ambiguous", { count: recovered.count });
    }
  } catch {
    logger("paid_request_recovery_failed", {
      code: "PAID_REQUEST_RECOVERY_FAILED"
    });
  }
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
    (name) => name !== "discoveryQuery" && searchParams.getAll(name).length > 1
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
  const discoveryQueries = [...new Set(searchParams.getAll("discoveryQuery"))];

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
  if (discoveryQueries.length > 100 || discoveryQueries.some((query) => !query || query.length > 500)) {
    invalid.push({ parameter: "discoveryQuery", issue: "invalid" });
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
    sortDirection,
    discoveryQueries
  };
}

export function parseTrafficOverviewFilters(searchParams) {
  const unknown = [...searchParams.keys()].filter(
    (name) => !TRAFFIC_OVERVIEW_PARAMETERS.has(name)
  );
  const duplicate = [...TRAFFIC_OVERVIEW_PARAMETERS].filter(
    (name) => name !== "discoveryQuery" && searchParams.getAll(name).length > 1
  );
  const rawSearch = searchParams.get("search");
  const search = rawSearch == null ? null : rawSearch.trim();
  const discoveryQueries = [...new Set(searchParams.getAll("discoveryQuery"))];
  const invalid = [];
  if (unknown.length) invalid.push({ parameters: unknown, issue: "unknown" });
  if (duplicate.length) invalid.push({ parameters: duplicate, issue: "duplicate" });
  if (search != null && search.length > 200) {
    invalid.push({ parameter: "search", issue: "too_long" });
  }
  if (discoveryQueries.length > 100 || discoveryQueries.some((query) => !query || query.length > 500)) {
    invalid.push({ parameter: "discoveryQuery", issue: "invalid" });
  }
  if (invalid.length) {
    throw new ApiError(
      400,
      "INVALID_QUERY_PARAMETERS",
      "One or more traffic overview query parameters are invalid.",
      invalid
    );
  }
  return { search: search || null, discoveryQueries };
}

export function parseMasterLeadFilters(searchParams) {
  const unknown = [...searchParams.keys()].filter((name) => !MASTER_LEAD_PARAMETERS.has(name));
  const duplicate = [...MASTER_LEAD_PARAMETERS].filter((name) => name !== "discoveryQuery" && searchParams.getAll(name).length > 1);
  const page = parsePositiveInteger(searchParams.get("page"), 1);
  const pageSize = parsePositiveInteger(searchParams.get("pageSize"), 50, { max: 200 });
  const rawSearch = searchParams.get("search");
  const search = rawSearch == null ? null : rawSearch.trim();
  const sortBy = searchParams.get("sortBy") || "lead_quality";
  const sortDirection = searchParams.get("sortDirection") || "desc";
  const archivedValue = searchParams.get("archived");
  const discoveryQueries = [...new Set(searchParams.getAll("discoveryQuery"))];
  const invalid = [];
  if (unknown.length) invalid.push({ parameters: unknown, issue: "unknown" });
  if (duplicate.length) invalid.push({ parameters: duplicate, issue: "duplicate" });
  if (page == null) invalid.push({ parameter: "page", issue: "invalid" });
  if (pageSize == null) invalid.push({ parameter: "pageSize", issue: "invalid" });
  if (search != null && search.length > 200) invalid.push({ parameter: "search", issue: "too_long" });
  if (!["lead_quality", "last_discovered", "first_discovered"].includes(sortBy)) invalid.push({ parameter: "sortBy", issue: "invalid" });
  if (!["asc", "desc"].includes(sortDirection)) invalid.push({ parameter: "sortDirection", issue: "invalid" });
  if (archivedValue != null && !["true", "false"].includes(archivedValue)) invalid.push({ parameter: "archived", issue: "invalid" });
  if (discoveryQueries.length > 100 || discoveryQueries.some((query) => !query || query.length > 500)) invalid.push({ parameter: "discoveryQuery", issue: "invalid" });
  if (invalid.length) throw new ApiError(400, "INVALID_QUERY_PARAMETERS", "One or more lead query parameters are invalid.", invalid);
  return { page, pageSize, search: search || null, sortBy, sortDirection, archived: archivedValue === "true", discoveryQueries };
}

function serializeMasterLead(item, cacheRows) {
  const profile = item.shop.leadProfile?.state === "completed"
    ? item.shop.leadProfile.profilePayload
    : null;
  const latest = item.shop.leads[0] || null;
  const historical = latest ? serializeLead(latest) : {};
  const traffic = serializeCurrentShopTraffic(cacheRows, item.shop);
  return {
    ...historical,
    id: item.id,
    store_name: profile?.storeName || null,
    email: profile?.email || null,
    email_source_url: profile?.emailSourceUrl || null,
    phone: profile?.phone || null,
    phone_source_url: profile?.phoneSourceUrl || null,
    contact_url: profile?.contactUrl || null,
    social_profiles: Array.isArray(profile?.socialProfiles) ? profile.socialProfiles : [],
    contactability_tier: profile?.contactabilityTier || null,
    contact_evidence: profile?.contactEvidence || null,
    identity_confidence: profile?.identityConfidence ?? item.shop.identityConfidence ?? null,
    identity_evidence: profile?.identityEvidence || item.shop.identityEvidence || null,
    myshopify_domain: item.shop.myshopifyDomain,
    resolved_domain: item.shop.resolvedDomain,
    canonical_url: item.shop.canonicalUrl,
    final_url: item.shop.canonicalUrl || (item.shop.resolvedDomain ? `https://${item.shop.resolvedDomain}/` : null),
    ...(traffic ? { traffic_enrichment: traffic } : {}),
    master: {
      shop_id: item.shopId,
      first_discovered_at: safeDate(item.firstDiscoveredAt),
      last_discovered_at: safeDate(item.lastDiscoveredAt),
      discovery_count: item.discoveryCount,
      lifecycle_status: item.lifecycleStatus,
      notes: item.notes,
      tags: item.tags,
      archived: item.archivedAt != null,
      profile_updated_at: item.shop.leadProfile?.updatedAt
        ? safeDate(item.shop.leadProfile.updatedAt)
        : null,
      runs: item.discoveries.map((discovery) => ({
        href: `/runs/${encodeURIComponent(discovery.runId)}`,
        discovered_at: safeDate(discovery.discoveredAt)
      })),
      discovery_queries: [...new Set(item.shop.leads.map((lead) =>
        lead.generatedQuery || lead.searchQuery).filter(Boolean))].sort()
    }
  };
}

const MASTER_TRAFFIC_KEYS = [
  "estimated_google_search_traffic", "organic_estimated_traffic", "organic_keyword_count",
  "paid_estimated_traffic", "paid_keyword_count", "featured_snippet_estimated_traffic",
  "featured_snippet_keyword_count", "local_pack_estimated_traffic", "local_pack_keyword_count"
];

function addMasterTraffic(target, source) {
  for (const key of MASTER_TRAFFIC_KEYS) target[key] = (target[key] || 0) + (source[key] || 0);
}

function aggregateMasterTraffic(items, search) {
  let worldwide;
  let leadsWithTraffic = 0;
  const markets = new Map();
  const groups = new Map();
  for (const item of items) {
    const traffic = item.traffic_enrichment?.dataforseo;
    const itemGroups = (item.master.discovery_queries.length
      ? item.master.discovery_queries
      : [null]).map((query) => {
        const key = query || "__unattributed__";
        const group = groups.get(key) || { query, shopsFound: 0, leadsWithTraffic: 0, markets: new Map() };
        group.shopsFound += 1;
        groups.set(key, group);
        return group;
      });
    if (!traffic?.worldwide && !traffic?.markets?.length) continue;
    leadsWithTraffic += 1;
    for (const group of itemGroups) group.leadsWithTraffic += 1;
    if (traffic.worldwide) {
      worldwide ||= {};
      addMasterTraffic(worldwide, traffic.worldwide);
      for (const group of itemGroups) {
        group.worldwide ||= {};
        addMasterTraffic(group.worldwide, traffic.worldwide);
      }
    }
    for (const market of traffic.markets || []) {
      const total = markets.get(market.country_code) || { country_code: market.country_code };
      addMasterTraffic(total, market);
      markets.set(market.country_code, total);
      for (const group of itemGroups) {
        const grouped = group.markets.get(market.country_code) || { country_code: market.country_code };
        addMasterTraffic(grouped, market);
        group.markets.set(market.country_code, grouped);
      }
    }
  }
  return {
    version: "traffic-overview-v1",
    runId: "master",
    scope: { search, matchedLeads: items.length, leadsWithTraffic },
    ...(worldwide ? { worldwide } : {}),
    markets: [...markets.values()],
    queries: [...groups.values()].map((group) => ({
      query: group.query,
      shopsFound: group.shopsFound,
      leadsWithTraffic: group.leadsWithTraffic,
      ...(group.worldwide ? { worldwide: group.worldwide } : {}),
      markets: [...group.markets.values()]
    }))
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

function requestedKeywordResearchId(pathname, suffix = "") {
  const expression = suffix
    ? new RegExp(`^/api/keyword-research/([^/]+)/${suffix}$`, "u")
    : /^\/api\/keyword-research\/([^/]+)$/u;
  const match = pathname.match(expression);
  if (!match) return null;
  let identifier;
  try {
    identifier = decodeURIComponent(match[1]);
  } catch {
    throw new ApiError(400, "KEYWORD_RESEARCH_INPUT_INVALID", "The keyword research ID is invalid.");
  }
  if (!KEYWORD_RESEARCH_ID_PATTERN.test(identifier)) {
    throw new ApiError(400, "KEYWORD_RESEARCH_INPUT_INVALID", "The keyword research ID is invalid.");
  }
  return identifier;
}

function keywordResearchBody(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {};
  const body = { ...payload };
  delete body.ownerId;
  delete body.researchId;
  return body;
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

async function processPersistedRunStores({
  config,
  identifier,
  lease,
  repository,
  status,
  now,
  leadDiscoveryPipeline,
  leadDependencyOverrides
}) {
  // A competing run may be inside bounded page/Browserless/AI timeouts. Keep
  // this run fenced and retry long enough to observe completion or reclaim an
  // expired owner lease without duplicating contact discovery.
  const maxWaitRounds = 1200;
  const outcomes = new Map();
  for (let round = 0; round <= maxWaitRounds; round += 1) {
    const rows = await repository.listRunStoresForProcessing(
      identifier,
      lease,
      500,
      currentDate(now)
    );
    const pendingRows = rows.filter(({ id }) => !outcomes.has(id));
    if (!pendingRows.length) return [...outcomes.values()];
    let progressed = false;
    let waiting = false;
    for (const row of pendingRows) {
      const claimedStore = await repository.claimRunStore(
        identifier,
        lease,
        row.id,
        currentDate(now)
      );
      if (!claimedStore.owned) continue;
      const runStore = claimedStore.runStore;
      let leadWorkOwned = false;
      try {
        let reusable = await repository.readReusableShopLeadProfile(
          identifier,
          lease,
          runStore.shopId,
          currentDate(now)
        );
        if (reusable) {
          const lead = materializeLeadFromProfile(
            runStore.candidatePayload,
            reusable.profilePayload
          );
          outcomes.set(runStore.id, {
            runStoreId: runStore.id,
            state: "completed",
            lead,
            profileReusable: true
          });
          progressed = true;
          status.storesProcessed += 1;
          if (lead.status === "qualified") status.storesQualified += 1;
          else status.storesRejected += 1;
          continue;
        }
        const work = await repository.claimShopWork(
          identifier,
          lease,
          runStore.shopId,
          "lead_discovery",
          "current",
          currentDate(now)
        );
        leadWorkOwned = work.networkAllowed;
        if (!work.networkAllowed) {
          if (["completed", "processing"].includes(work.outcome)) {
            reusable = await repository.readReusableShopLeadProfile(
              identifier,
              lease,
              runStore.shopId,
              currentDate(now)
            );
          }
          if (reusable) {
            const lead = materializeLeadFromProfile(
              runStore.candidatePayload,
              reusable.profilePayload
            );
            outcomes.set(runStore.id, {
              runStoreId: runStore.id,
              state: "completed",
              lead,
              profileReusable: true
            });
            progressed = true;
            status.storesProcessed += 1;
            if (lead.status === "qualified") status.storesQualified += 1;
            else status.storesRejected += 1;
          } else if (work.outcome === "processing") {
            waiting = true;
          } else {
            throw new Error("Reusable lead work completed without a valid profile");
          }
          continue;
        }
        const discovered = await leadDiscoveryPipeline(
          config,
          runStore,
          leadDependencyOverrides
        );
        try {
          await repository.saveDiscoveredShopLeadProfile(
            identifier,
            lease,
            runStore.id,
            discovered.profile,
            currentDate(now)
          );
        } catch {
          await repository.saveDiscoveredShopLeadProfile(
            identifier,
            lease,
            runStore.id,
            discovered.profile,
            currentDate(now)
          );
        }
        outcomes.set(runStore.id, {
          runStoreId: runStore.id,
          state: "completed",
          lead: discovered.lead,
          profileReusable: discovered.profile != null
        });
        progressed = true;
        status.storesProcessed += 1;
        if (discovered.lead.status === "qualified") status.storesQualified += 1;
        else status.storesRejected += 1;
      } catch (error) {
        const failed = failedLeadForRunStore(runStore.candidatePayload, error);
        if (leadWorkOwned) {
          try {
            await repository.failShopLeadDiscovery(
              identifier, lease, runStore.id, currentDate(now)
            );
          } catch {
            await repository.failShopLeadDiscovery(
              identifier, lease, runStore.id, currentDate(now)
            );
          }
        }
        outcomes.set(runStore.id, {
          runStoreId: runStore.id,
          state: "failed",
          lead: failed,
          profileReusable: false,
          diagnostic: {
            scope: "store",
            code: "lead_discovery_failed",
            result_url: runStore.candidatePayload.representative.resultUrl,
            details: {
              errorType: error instanceof Error ? error.name : "Error",
              shopId: runStore.shopId
            }
          }
        });
        progressed = true;
        status.storesProcessed += 1;
        status.storeProcessingFailures += 1;
        status.failures += 1;
      }
    }
    if (!waiting) continue;
    if (round === maxWaitRounds) {
      throw new Error("Concurrent shop lead discovery did not finish within the wait boundary");
    }
    if (!progressed) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return [...outcomes.values()];
}

export async function executeRun({
  config,
  identifier,
  categories,
  lease,
  pipeline,
  planningPipeline,
  queryValidationPipeline,
  researchQueryValidationPipeline,
  discoveryPipeline,
  storeDiscoveryPipeline,
  leadDiscoveryPipeline,
  leadDependencyOverrides,
  trafficOrchestrator,
  trafficDependencyOverrides,
  trafficSnapshot,
  queryPlanSource,
  keywordSelectionSnapshot,
  repository,
  logger,
  now,
  leaseDurationMs,
  heartbeatIntervalMs,
  setIntervalFn,
  clearIntervalFn,
  pipelineRuntimeFactory = createPipelineRuntime
}) {
  const baseStatus = {
    ...createInitialStatus(),
    ...(categories.progress && typeof categories.progress === "object"
      ? categories.progress
      : {}),
    state: "running",
    stage: categories.phase === "scraping"
      ? categories.stage || "validating_confirmed_queries"
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
  let baseResultsPersisted = false;

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
      if (planning.complete !== true) {
        if (typeof repository.saveQueryPlanningFailure !== "function") {
          throw new Error("Repository does not support query-planning failures");
        }
        await repository.saveQueryPlanningFailure(
          identifier,
          lease,
          planning,
          tracker.status,
          currentDate(now)
        );
        logger("query_plan_insufficient", {
          runId: identifier,
          shortfalls: planning.shortfalls
        });
        return;
      }
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
      if (categories.executionBackend === "aws") {
        const runtime = await pipelineRuntimeFactory({ baseConfig: config, prisma: repository.prisma, repository });
        const snapshot = parseAwsProviderConfig(categories.awsProviderConfig);
        const confirmedAt = new Date(categories.queriesConfirmedAt);
        let rows = await repository.loadConfirmedQueryPlans(identifier, lease, currentDate(now));
        if (!Array.isArray(rows) || Number.isNaN(confirmedAt.getTime())) {
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
        const validationConfig = awsValidationConfig(snapshot);
        let validation;
        if (queryPlanSource === "keyword_research") {
          validation = await researchQueryValidationPipeline(rows, categories.items, validationConfig, tracker.status, {
            now: confirmedAt,
            freshnessMs: validationConfig.queryProbeFreshnessMs,
            searchPage: awsProbeSearchPage({ runId: identifier,
              confirmedRevision: categories.confirmedQueryRevision,
              queriesConfirmedAt: confirmedAt, snapshot, runtime }),
            snapshot: keywordSelectionSnapshot
          });
        } else if (queryPlanSource === "legacy" || queryPlanSource == null) {
          validation = await queryValidationPipeline(validationConfig, tracker.status, {
            rows, categories: categories.items, now: confirmedAt,
            freshnessMs: validationConfig.queryProbeFreshnessMs,
            searchPage: awsProbeSearchPage({ runId: identifier,
              confirmedRevision: categories.confirmedQueryRevision,
              queriesConfirmedAt: confirmedAt, snapshot, runtime })
          });
        } else {
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
        await repository.saveQueryValidation(identifier, lease, validation.rows, currentDate(now));
        await tracker.flush();
        if (!validation.valid) {
          await heartbeat.stop();
          await repository.returnRunToQueryReview(identifier, lease, tracker.status, currentDate(now));
          logger("query_confirmation_rejected", { runId: identifier,
            invalidQueries: validation.rows.filter((row) => row.validationState === "invalid").length });
          return;
        }
        rows = await repository.loadConfirmedQueryPlans(identifier, lease, currentDate(now));
        if (!rows.every((row) => row.validationState === "valid" &&
          row.probeContractVersion === "google-probe-v2" && /^[a-f0-9]{64}$/u.test(row.probeFingerprint || "") &&
          Array.isArray(row.probeResults) && row.probedAt)) {
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
        await heartbeat.renew();
        await tracker.stop();
        await heartbeat.stop();
        await dispatchConfirmedQueries({ runId: identifier, lease, categories: categories.items,
          confirmedRevision: categories.confirmedQueryRevision,
          queriesConfirmedAt: new Date(categories.queriesConfirmedAt), awsProviderConfig: categories.awsProviderConfig,
          queries: rows, generation: categories.pipelineGeneration, status: tracker.status }, runtime);
        return;
      }
      const progressive = typeof repository.saveDiscoveredStores === "function" &&
        typeof repository.saveLeadBatch === "function";
      const resumedLeadStage = progressive && [
        "leads_persisted", "enriching_traffic"
      ].includes(categories.stage);
      const resumedStoreStage = progressive && [
        "stores_persisted", "discovering_leads"
      ].includes(categories.stage);
      if (resumedLeadStage) {
        baseResultsPersisted = true;
        result = {
          pipelineVersion: 2,
          scoringVersion: 2,
          leads: await repository.listPersistedQualifiedLeads(
            identifier,
            lease,
            currentDate(now)
          ),
          queryAudits: [],
          diagnostics: [],
          summary: categories.leadSummary || {
            total: 0, qualified: 0, rejected: 0, failed: 0
          }
        };
      } else {
        let validation = null;
        if (!resumedStoreStage) {
          const rows = await repository.loadConfirmedQueryPlans(
            identifier,
            lease,
            currentDate(now)
          );
          if (queryPlanSource === "keyword_research") {
            validation = await researchQueryValidationPipeline(rows, categories.items, config, tracker.status, {
              now: currentDate(now),
              snapshot: keywordSelectionSnapshot
            });
          } else if (queryPlanSource === "legacy" || queryPlanSource == null) {
            validation = await queryValidationPipeline(config, tracker.status, {
              rows,
              categories: categories.items,
              now: currentDate(now)
            });
          } else {
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          }
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
              invalidQueries: validation.rows.filter(
                (row) => row.validationState === "invalid"
              ).length
            });
            return;
          }
        }
        if (progressive) {
          if (!resumedStoreStage) {
            const discovery = await storeDiscoveryPipeline(config, tracker.status, {
              queryPlans: validation.queryPlans
            });
            tracker.status.stage = "stores_persisted";
            tracker.status.storesPersisted = discovery.stores.length;
            try {
              await repository.saveDiscoveredStores(
                identifier,
                lease,
                discovery.stores,
                discovery.diagnostics,
                tracker.status,
                currentDate(now)
              );
            } catch {
              await repository.saveDiscoveredStores(
                identifier,
                lease,
                discovery.stores,
                discovery.diagnostics,
                tracker.status,
                currentDate(now)
              );
            }
          }
          tracker.status.stage = "discovering_leads";
          await tracker.flush();
          const leadOutcomes = await processPersistedRunStores({
            config,
            identifier,
            lease,
            repository,
            status: tracker.status,
            now,
            leadDiscoveryPipeline,
            leadDependencyOverrides
          });
          let summary;
          try {
            summary = await repository.saveLeadBatch(
              identifier,
              lease,
              leadOutcomes,
              tracker.status,
              currentDate(now)
            );
          } catch {
            summary = await repository.saveLeadBatch(
              identifier,
              lease,
              leadOutcomes,
              tracker.status,
              currentDate(now)
            );
          }
          baseResultsPersisted = true;
          result = {
            pipelineVersion: 2,
            scoringVersion: 2,
            leads: await repository.listPersistedQualifiedLeads(
              identifier,
              lease,
              currentDate(now)
            ),
            queryAudits: [],
            diagnostics: [],
            summary
          };
        } else {
          result = await discoveryPipeline(config, tracker.status, {
            queryPlans: validation.queryPlans
          });
        }
      }
    } else {
      result = await pipeline(config, tracker.status, { categories: categories.items });
    }
    const trafficEnabled = trafficSnapshot?.dataForSeo?.enabled === true ||
      trafficSnapshot?.crux?.enabled === true;
    if (trafficEnabled) {
      tracker.status.stage = "enriching_traffic";
      await tracker.flush();
      if (leaseLoss) throw leaseLoss;
      await heartbeat.renew();
      if (leaseLoss) throw leaseLoss;
      const traffic = await trafficOrchestrator({
        runId: identifier,
        lease,
        runSnapshot: trafficSnapshot,
        runtimeConfig: config,
        leads: result.leads,
        repository,
        now: () => currentDate(now),
        assertLeaseActive: () => {
          if (leaseLoss) throw leaseLoss;
        },
        onBatchTelemetry: (fields) => logger("traffic_persistence_batch", {
          runId: identifier,
          ...fields
        }),
        ...(baseResultsPersisted && {
          onSourceComplete: async (sourceResult) => {
            const startedAt = performance.now();
            const published = await repository.saveTrafficSourceResults(
              identifier,
              lease,
              sourceResult,
              currentDate(now)
            );
            logger("traffic_persistence_batch", {
              runId: identifier,
              operation: "source_publication",
              source: sourceResult.sourceKey,
              rowCount: sourceResult.records.length,
              durationMs: Math.round((performance.now() - startedAt) * 10) / 10
            });
            return published;
          }
        }),
        dependencyOverrides: trafficDependencyOverrides
      });
      result = {
        ...result,
        trafficEnrichments: traffic.trafficEnrichments,
        trafficEnrichmentSummary: traffic.trafficEnrichmentSummary,
        diagnostics: [...result.diagnostics, ...traffic.diagnostics]
      };
      logger("traffic_enrichment_completed", {
        runId: identifier,
        summary: traffic.trafficEnrichmentSummary
      });
    }
    if (!baseResultsPersisted && trafficSnapshot?.dataForSeo?.enabled === true) {
      result = {
        ...result,
        leads: finalizeLeadScoresV3({
          leads: result.leads,
          trafficEnrichments: result.trafficEnrichments || [],
          cruxEnabled: trafficSnapshot?.crux?.enabled === true,
          leadIdFor: (lead, index) => stableLeadId(identifier, lead, index)
        }),
        pipelineVersion: 2,
        scoringVersion: 3
      };
    }
    if (baseResultsPersisted) {
      tracker.status.stage = "completed";
      tracker.status.outputRows = result.summary.total;
      await tracker.flush();
      if (leaseLoss) throw leaseLoss;
      await heartbeat.renew();
      if (leaseLoss) throw leaseLoss;
      await heartbeat.stop();
      await tracker.stop();
      await repository.completeTrafficEnrichment(
        identifier,
        lease,
        result.trafficEnrichmentSummary || null,
        [],
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
      return;
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
    if (baseResultsPersisted && typeof repository.completeTrafficEnrichment === "function") {
      await repository.completeTrafficEnrichment(
        identifier,
        lease,
        {
          version: "traffic-enrichment-summary-v1",
          state: "failed",
          safeErrorCode: "TRAFFIC_ENRICHMENT_FAILED"
        },
        [{
          scope: "run",
          code: "traffic_enrichment_failed",
          details: { errorType: error instanceof Error ? error.name : "Error" }
        }],
        tracker.status,
        currentDate(now)
      ).catch((persistenceError) => {
        logger("traffic_failure_persistence_failed", {
          runId: identifier,
          error: persistenceError
        });
      });
      logger("traffic_enrichment_failed", { runId: identifier, error });
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
    researchQueryValidationPipeline = validateResearchBackedConfirmedQueryRows,
    discoveryPipeline = runDiscoveryFromQueryPlans,
    storeDiscoveryPipeline = discoverStoresFromQueryPlans,
    leadDiscoveryPipeline = discoverLeadForRunStore,
    leadDependencyOverrides = {},
    trafficOrchestrator = enrichTraffic,
    trafficDependencyOverrides = {},
    repository = createPrismaRunRepository(),
    schedule = setImmediate,
    logger = log,
    now = () => Date.now(),
    leaseOwner = workerId(),
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    pipelineRuntimeFactory = createPipelineRuntime,
    keywordResearchApi
  } = {}
) {
  const acceptedRunTimes = [];
  const acceptedConfirmationTimes = [];
  let admissionTail = Promise.resolve();
  let drainScheduled = false;
  let draining = false;
  let drainRequested = false;

  const dispatchInitialize = async (message) => {
    const runtime = await pipelineRuntimeFactory({ baseConfig: config, prisma: repository.prisma, repository });
    const queueUrl = runtime.config?.awsPipelineKeywordResearchQueueUrl;
    let validUrl = typeof queueUrl === "string" && queueUrl.length > 0;
    if (validUrl) {
      try {
        validUrl = new URL(queueUrl).protocol === "https:";
      } catch {
        validUrl = false;
      }
    }
    if (!runtime.dispatcher || typeof runtime.dispatcher.sendOne !== "function" || !validUrl) {
      return { sentItemIds: [], failedItemIds: [] };
    }
    return runtime.dispatcher.sendOne(queueUrl, message, keywordMessageSchema);
  };

  const researchApi = keywordResearchApi ?? createKeywordResearchApi({
    keywordRepository: new PrismaKeywordResearchRepository(repository.prisma),
    runRepository: repository,
    now: () => currentDate(now),
    dispatchInitialize
  });

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
            categories: {
              items: categories,
              phase: run.run.phase || "scraping",
              stage: run.run.stage,
              leadSummary: run.run.leadSummary,
              progress: run.run.progress,
              executionBackend: run.run.executionBackend,
              pipelineGeneration: run.run.pipelineGeneration,
              confirmedQueryRevision: run.run.confirmedQueryRevision,
              queriesConfirmedAt: run.run.queriesConfirmedAt,
              awsProviderConfig: run.run.awsProviderConfig
            },
            lease: run.lease,
            pipeline,
            planningPipeline,
            queryValidationPipeline,
            researchQueryValidationPipeline,
            discoveryPipeline,
            storeDiscoveryPipeline,
            leadDiscoveryPipeline,
            leadDependencyOverrides,
            trafficOrchestrator,
            trafficDependencyOverrides,
            trafficSnapshot: run.run.trafficEnrichmentConfig,
            queryPlanSource: run.run.queryPlanSource,
            keywordSelectionSnapshot: run.run.keywordSelectionSnapshot,
            repository,
            logger,
            now,
            leaseDurationMs,
            heartbeatIntervalMs,
            setIntervalFn,
            clearIntervalFn,
            pipelineRuntimeFactory
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

    if (request.method === "POST" && requestUrl.pathname === "/api/keyword-research") {
      const ownerId = trustedUserId(request);
      const payload = await readJsonBody(request);
      const created = await researchApi.createResearch({
        ownerId,
        ...keywordResearchBody(payload)
      });
      return sendJson(response, 202, created);
    }

    const exportIdentifier = requestedKeywordResearchId(requestUrl.pathname, "export.csv");
    if (request.method === "GET" && exportIdentifier) {
      const ownerId = trustedUserId(request);
      const csv = await researchApi.exportCsv({
        ownerId,
        researchId: exportIdentifier,
        searchParams: requestUrl.searchParams
      });
      const filename = `keyword-research-${exportIdentifier}.csv`;
      response.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(csv)
      });
      return response.end(csv);
    }

    const selectionIdentifier = requestedKeywordResearchId(requestUrl.pathname, "selection");
    if (request.method === "PUT" && selectionIdentifier) {
      const ownerId = trustedUserId(request);
      const payload = await readJsonBody(request);
      const saved = await researchApi.saveSelection({
        ownerId,
        researchId: selectionIdentifier,
        ...keywordResearchBody(payload)
      });
      return sendJson(response, 200, saved);
    }

    const runsIdentifier = requestedKeywordResearchId(requestUrl.pathname, "runs");
    if (request.method === "POST" && runsIdentifier) {
      const ownerId = trustedUserId(request);
      const payload = await readJsonBody(request);
      const handoff = await researchApi.createRun({
        ownerId,
        researchId: runsIdentifier,
        ...keywordResearchBody(payload)
      });
      return sendJson(response, handoff.created ? 201 : 200, {
        run: handoff.run,
        statusUrl: handoff.statusUrl
      });
    }

    const researchIdentifier = requestedKeywordResearchId(requestUrl.pathname);
    if (request.method === "GET" && researchIdentifier) {
      const ownerId = trustedUserId(request);
      const view = await researchApi.getResearch({ ownerId, researchId: researchIdentifier });
      return sendJson(response, 200, view);
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
        const policy = queryReviewPolicy(run, config);
        let checked;
        if (run.queryPlanSource === "keyword_research") {
          checked = validateResearchBackedQueryList(payload.queries, run);
        } else if (run.queryPlanSource === "legacy" || run.queryPlanSource == null) {
          checked = validateEditableQueryList(payload.queries, categories, {
            maxQueries: policy.maxQueries,
            generatedQueryCount: policy.generatedQueryCount,
            categoryVocabularyByIndex
          });
        } else {
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
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
          const checkedEditable = (current.queries || []).map(({ id, categoryIndex, query }) => ({
            id,
            categoryIndex,
            query
          }));
          let checked;
          if (current.queryPlanSource === "keyword_research") {
            checked = validateResearchBackedQueryList(checkedEditable, current);
          } else if (current.queryPlanSource === "legacy" || current.queryPlanSource == null) {
            checked = validateEditableQueryList(
              checkedEditable,
              categories,
              {
                maxQueries: queryReviewPolicy(current, config).maxQueries,
                generatedQueryCount: queryReviewPolicy(current, config).generatedQueryCount,
                categoryVocabularyByIndex
              }
            );
          } else {
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          }
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
            currentDate(now),
            config.runExecutionBackend,
            queryReviewPolicy(current, config).awsProviderConfig
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
      if (requestUrl.pathname === "/api/leads/traffic-overview") {
        const ownerId = trustedUserId(request);
        const filters = parseTrafficOverviewFilters(requestUrl.searchParams);
        const page = await repository.getMasterLeadsPage(ownerId, {
          page: 1, pageSize: 10_000, ...filters, sortBy: "last_discovered",
          sortDirection: "desc", archived: false
        }, currentDate(now));
        const items = page.items.map((item) => serializeMasterLead(item, page.cacheRows));
        return sendJson(response, 200, aggregateMasterTraffic(items, filters.search));
      }
      if (requestUrl.pathname === "/api/leads") {
        const ownerId = trustedUserId(request);
        const filters = parseMasterLeadFilters(requestUrl.searchParams);
        const page = await repository.getMasterLeadsPage(ownerId, filters, currentDate(now));
        return sendJson(response, 200, {
          pagination: {
            page: filters.page,
            pageSize: filters.pageSize,
            totalItems: page.totalItems,
            totalPages: Math.ceil(page.totalItems / filters.pageSize)
          },
          items: page.items.map((item) => serializeMasterLead(item, page.cacheRows))
        });
      }
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
        if (!runResultsAvailable(run)) {
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

      const trafficOverviewIdentifier = requestedRunId(
        requestUrl.pathname,
        "traffic-overview"
      );
      if (trafficOverviewIdentifier) {
        const ownerId = trustedUserId(request);
        const filters = parseTrafficOverviewFilters(requestUrl.searchParams);
        const run = await repository.getRun(trafficOverviewIdentifier, ownerId);
        if (!run) {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        if (!runResultsAvailable(run) && [
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
        if (!runResultsAvailable(run)) {
          throw new ApiError(
            409,
            "RESULTS_UNAVAILABLE",
            "Results are unavailable for this run."
          );
        }
        const rows = await repository.getTrafficOverviewRows(
          trafficOverviewIdentifier,
          ownerId,
          filters
        );
        return sendJson(response, 200, serializeTrafficOverview(
          trafficOverviewIdentifier,
          rows,
          run.trafficEnrichmentConfig,
          filters.search
        ));
      }

      const resultsIdentifier = requestedRunId(requestUrl.pathname, "results");
      if (resultsIdentifier) {
        const ownerId = trustedUserId(request);
        const filters = parseResultFilters(requestUrl.searchParams);
        const run = await repository.getRun(resultsIdentifier, ownerId);
        if (!run) {
          throw new ApiError(404, "RUN_NOT_FOUND", "The requested run was not found.");
        }
        if (!runResultsAvailable(run) && [
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
        if (!runResultsAvailable(run)) {
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
        const trafficConfig = run.trafficEnrichmentConfig;
        const trafficEnabled = trafficConfig?.dataForSeo?.enabled === true ||
          trafficConfig?.crux?.enabled === true;
        const trafficRows = trafficEnabled && page.items.length
          ? await repository.getTrafficEnrichmentsForLeadIds(
              resultsIdentifier,
              ownerId,
              page.items.map(({ id }) => id)
            )
          : [];
        const trafficByLead = new Map();
        for (const row of trafficRows) {
          const rows = trafficByLead.get(row.leadId) || [];
          rows.push(row);
          trafficByLead.set(row.leadId, rows);
        }
        const summary = filters.search || filters.discoveryQueries.length
          ? await repository.getResultSummary(resultsIdentifier, ownerId, filters)
          : run.leadSummary || {
          total: 0,
          qualified: 0,
          rejected: 0,
          failed: 0
        };
        const items = page.items.map((lead) => serializeLead(lead, {
          trafficEnrichmentConfig: trafficConfig,
          trafficEnrichments: trafficByLead.get(lead.id) || []
        }));
        if (items.some((lead) =>
          lead.pipeline_version !== (run.pipelineVersion ?? null) ||
          lead.scoring_version !== (run.scoringVersion ?? null)
        )) {
          throw new Error("Published run and lead score versions do not agree");
        }
        return sendJson(response, 200, {
          runId: resultsIdentifier,
          summary,
          pagination: {
            page: filters.page,
            pageSize: filters.pageSize,
            totalItems: page.totalItems,
            totalPages: Math.ceil(page.totalItems / filters.pageSize)
          },
          items
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
    void recoverInterruptedWork(repository, currentDate(now), logger)
      .then(() => {
        queueDrain();
      })
      .catch(() => logger("recovery_cycle_failed", { code: "RECOVERY_CYCLE_FAILED" }));
  }, recoveryIntervalMs);
  recoveryTimer?.unref?.();
  server.on("close", () => clearIntervalFn(recoveryTimer));

  queueDrain();
  return server;
}

export async function startServer(
  config = loadConfig(),
  {
    repository = createPrismaRunRepository(),
    logger = log,
    serverFactory = createLeadServer,
    now = () => Date.now()
  } = {}
) {
  if (process.env.NODE_ENV === "production" && !config.backendApiToken) {
    throw new Error("BACKEND_API_TOKEN is required in production");
  }
  await recoverInterruptedWork(repository, currentDate(now), logger);
  const server = serverFactory(config, { repository, logger, now });
  server.listen(config.port, config.host, () => {
    logger("server_started", { host: config.host, port: config.port });
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
