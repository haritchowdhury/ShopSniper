import { createHash, randomBytes } from "node:crypto";
import {
  RunAdmissionRejectedError,
  RunIntentNotFoundError,
  RunLeaseLostError,
  RunTerminalConflictError,
  QueryRevisionConflictError,
  RunNotAwaitingQueryConfirmationError
} from "./api-errors.js";
import {
  diagnosticRecordToCreate,
  leadTrafficEnrichmentRecordToCreate,
  leadRecordToCreate,
  queryAuditRecordToCreate,
  serializeLead,
  trafficCacheRecordToUpsert
} from "./api-serializer.js";
import { loadConfig } from "./config.js";
import { finalizeLeadScoresV3 } from "./lead-score-finalizer.js";
import {
  DATAFORSEO_COUNTRY_LOCATION_CODES,
  DATAFORSEO_ITEM_TYPES,
  DATAFORSEO_RESPONSE_CONTRACT_VERSION,
  DATAFORSEO_TARGET_LIMIT,
  DATAFORSEO_TRAFFIC_CONTRACT_VERSION
} from "./enrichment/dataforseo/request.js";
import {
  CRUX_API_RESPONSE_CONTRACT_VERSION,
  CRUX_METRICS,
  CRUX_ORIGIN_METRICS_CONTRACT_VERSION
} from "./enrichment/crux/api-request.js";
import {
  CRUX_BIGQUERY_ORIGIN_LIMIT,
  CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION,
  CRUX_POPULARITY_CONTRACT_VERSION
} from "./enrichment/crux/bigquery-request.js";
import { getPrismaClient, prismaSchemaForClient } from "./prisma-client.js";
import { createInitialProgress, progressFromStatus } from "./status.js";
import { fingerprintJson } from "./aws-pipeline/core/canonical.js";
import { parseAwsProviderConfig } from "./aws-pipeline/contracts/aws-provider-config.js";
import { parseTrafficRunConfig } from "./aws-pipeline/contracts/traffic-config.js";
import { PipelineInvariantError } from "./aws-pipeline/contracts/errors.js";
import {
  assertCompleteAggregatorInTransaction,
  completeAggregatorInTransaction,
  registerStageInTransaction
} from "./aws-pipeline/repositories/pipeline-coordinator-repository.js";
import {
  GOOGLE_PROBE_CONTRACT_VERSION,
  normalizeProbeResults,
  queryProbeFingerprint
} from "./query-review.js";
import {
  assertLeadMatchesShop,
  assertProfileMatchesShop,
  assertRunStoreIdentityPair,
  parseRunStoreCandidate,
  parseShopLeadProfile,
  parseStableShopIdentity,
  runStoreId,
  shopIdForStableKey,
  shopWorkId,
  trafficProviderIdentities
} from "./shop-persistence-contract.js";

const ACTIVE_STATES = ["queued", "running"];
const BULK_CHECKPOINT_LIMIT = 500;

function runId() {
  return `run_${randomBytes(18).toString("base64url")}`;
}

function runIntentId() {
  return `intent_${randomBytes(24).toString("base64url")}`;
}

function leaseToken() {
  return `lease_${randomBytes(24).toString("base64url")}`;
}

function queryId() {
  return `query_${randomBytes(18).toString("base64url")}`;
}

function jsonValue(value) {
  return value == null ? undefined : value;
}

function activeLeaseWhere(runIdentifier, lease, now) {
  return {
    id: runIdentifier,
    state: "running",
    leaseOwner: lease.owner,
    leaseToken: lease.token,
    leaseExpiresAt: { gt: now }
  };
}

function requireLeaseMutation(result) {
  if (result.count !== 1) throw new RunLeaseLostError();
  return result;
}

function childId(prefix, runIdentifier, identity) {
  const opaque = createHash("sha256")
    .update(`${runIdentifier}:${identity}`)
    .digest("base64url")
    .slice(0, 24);
  return `${prefix}_${opaque}`;
}

async function grantRunShopsToOwner(transaction, runIdentifier, leadRows, now) {
  const rows = [...new Map(leadRows.filter(({ shopId }) => shopId)
    .map((row) => [row.shopId, { shopId: row.shopId, leadId: row.id }])).values()];
  if (!rows.length || typeof transaction.$queryRaw !== "function") return;
  await transaction.$queryRaw`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS value("shopId" text, "leadId" text)
    ), owned AS (
      SELECT r."ownerId" AS "userId", r."createdAt" AS "discoveredAt",
        input."shopId", input."leadId"
      FROM input JOIN "Run" r ON r."id" = ${runIdentifier}
      WHERE r."ownerId" IS NOT NULL
    ), granted AS (
      INSERT INTO "UserShop" (
        "id", "userId", "shopId", "firstDiscoveredAt", "lastDiscoveredAt",
        "firstDiscoveredRunId", "lastDiscoveredRunId", "discoveryCount", "updatedAt"
      )
      SELECT 'user_shop_' || MD5("userId" || ':' || "shopId"), "userId", "shopId",
        "discoveredAt", "discoveredAt", ${runIdentifier}, ${runIdentifier}, 0, ${now}
      FROM owned
      ON CONFLICT ("userId", "shopId") DO UPDATE SET "updatedAt" = "UserShop"."updatedAt"
      RETURNING "id", "userId", "shopId"
    ), inserted AS (
      INSERT INTO "UserShopDiscovery" (
        "id", "userShopId", "runId", "leadId", "discoveredAt"
      )
      SELECT 'user_shop_discovery_' || MD5(granted."id" || ':' || ${runIdentifier}),
        granted."id", ${runIdentifier}, owned."leadId", owned."discoveredAt"
      FROM granted JOIN owned USING ("userId", "shopId")
      ON CONFLICT ("userShopId", "runId") DO NOTHING
      RETURNING "userShopId"
    )
    UPDATE "UserShop" us SET
      "firstDiscoveredAt" = stats."firstAt",
      "lastDiscoveredAt" = stats."lastAt",
      "firstDiscoveredRunId" = stats."firstRun",
      "lastDiscoveredRunId" = stats."lastRun",
      "discoveryCount" = stats."runCount",
      "updatedAt" = ${now}
    FROM (
      SELECT d."userShopId", MIN(d."discoveredAt") "firstAt",
        MAX(d."discoveredAt") "lastAt",
        (ARRAY_AGG(d."runId" ORDER BY d."discoveredAt", d."runId"))[1] "firstRun",
        (ARRAY_AGG(d."runId" ORDER BY d."discoveredAt" DESC, d."runId" DESC))[1] "lastRun",
        COUNT(*)::integer "runCount"
      FROM "UserShopDiscovery" d
      WHERE d."userShopId" IN (SELECT "id" FROM granted)
      GROUP BY d."userShopId"
    ) stats
    WHERE us."id" = stats."userShopId"
    RETURNING us."id"
  `;
}

export function stableLeadId(runIdentifier, record, index) {
  const identity = record.identity_evidence?.stableHostname || record.resolved_domain;
  if (!identity && !Number.isInteger(index)) {
    throw new Error("A stable lead identity or deterministic index is required");
  }
  return childId("lead", runIdentifier, identity || index);
}

function isUniqueConstraint(error) {
  return error?.code === "P2002" || error?.cause?.code === "23505" ||
    error?.meta?.code === "23505";
}

const SHOP_WORK_TYPES = new Set([
  "lead_discovery", "dataforseo", "crux_rest", "crux_bigquery"
]);

function requireShopWorkKey(workType, scopeKey) {
  if (!SHOP_WORK_TYPES.has(workType)) throw new Error("Shop work type is invalid");
  if (typeof scopeKey !== "string" || !scopeKey || scopeKey.length > 128) {
    throw new Error("Shop work scope is invalid");
  }
  const valid = workType === "lead_discovery"
    ? scopeKey === "current"
    : workType === "dataforseo"
      ? /^(?:worldwide|country:[A-Z]{2}:[1-9]\d*)$/u.test(scopeKey)
      : workType === "crux_rest"
        ? scopeKey === "current"
        : /^month:20\d{2}(?:0[1-9]|1[0-2])$/u.test(scopeKey);
  if (!valid) throw new Error("Shop work scope is invalid for its type");
  return { workType, scopeKey };
}

function canonicalJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireBoundedBatch(name, rows, limit = BULK_CHECKPOINT_LIMIT) {
  if (!Array.isArray(rows)) throw new Error(`${name} are required`);
  if (rows.length > limit) throw new Error(`${name} exceed the ${limit}-row limit`);
  return rows;
}

function requireUniqueBatchKeys(name, rows, keyFor) {
  const keys = new Set(rows.map(keyFor));
  if (keys.size !== rows.length) throw new Error(`${name} contain duplicates`);
  return rows;
}

async function bulkUpsertShops(transaction, rows, now) {
  if (!rows.length) return [];
  return transaction.$queryRaw`
    INSERT INTO "Shop" (
      "id", "stableKey", "myshopifyDomain", "resolvedDomain", "canonicalUrl",
      "identityConfidence", "identityEvidence", "createdAt", "updatedAt"
    )
    SELECT
      input."id", input."stableKey", input."myshopifyDomain",
      input."resolvedDomain", input."canonicalUrl", input."identityConfidence",
      input."identityEvidence", ${now}, ${now}
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input(
      "id" text,
      "stableKey" text,
      "myshopifyDomain" text,
      "resolvedDomain" text,
      "canonicalUrl" text,
      "identityConfidence" integer,
      "identityEvidence" jsonb
    )
    ON CONFLICT ("stableKey") DO UPDATE SET
      "myshopifyDomain" = COALESCE("Shop"."myshopifyDomain", EXCLUDED."myshopifyDomain"),
      "resolvedDomain" = CASE
        WHEN EXCLUDED."identityConfidence" > COALESCE("Shop"."identityConfidence", -1)
          THEN COALESCE(EXCLUDED."resolvedDomain", "Shop"."resolvedDomain")
        ELSE COALESCE("Shop"."resolvedDomain", EXCLUDED."resolvedDomain")
      END,
      "canonicalUrl" = CASE
        WHEN EXCLUDED."identityConfidence" > COALESCE("Shop"."identityConfidence", -1)
          THEN COALESCE(EXCLUDED."canonicalUrl", "Shop"."canonicalUrl")
        ELSE COALESCE("Shop"."canonicalUrl", EXCLUDED."canonicalUrl")
      END,
      "identityConfidence" = CASE
        WHEN EXCLUDED."identityConfidence" > COALESCE("Shop"."identityConfidence", -1)
          THEN EXCLUDED."identityConfidence"
        ELSE COALESCE("Shop"."identityConfidence", EXCLUDED."identityConfidence")
      END,
      "identityEvidence" = CASE
        WHEN EXCLUDED."identityConfidence" > COALESCE("Shop"."identityConfidence", -1)
          OR "Shop"."identityEvidence" IS NULL
          THEN EXCLUDED."identityEvidence"
        ELSE "Shop"."identityEvidence"
      END,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "Shop"."myshopifyDomain" IS NULL
      OR EXCLUDED."myshopifyDomain" IS NULL
      OR "Shop"."myshopifyDomain" = EXCLUDED."myshopifyDomain"
    RETURNING *
  `;
}

async function selectBulkSchema(transaction, schema) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error("Database schema is invalid for bulk persistence");
  }
  await transaction.$queryRaw`SELECT set_config('search_path', ${schema}, true)`;
}

async function bulkUpsertDiagnostics(transaction, rows) {
  if (!rows.length) return [];
  return transaction.$queryRaw`
    INSERT INTO "RunDiagnostic" (
      "id", "runId", "sequence", "scope", "code", "shopType",
      "businessQualifier", "query", "resultUrl", "details"
    )
    SELECT
      input."id", input."runId", input."sequence", input."scope", input."code",
      input."shopType", input."businessQualifier", input."query", input."resultUrl",
      input."details"
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input(
      "id" text,
      "runId" text,
      "sequence" integer,
      "scope" text,
      "code" text,
      "shopType" text,
      "businessQualifier" text,
      "query" text,
      "resultUrl" text,
      "details" jsonb
    )
    ON CONFLICT ("runId", "sequence") DO UPDATE SET
      "id" = EXCLUDED."id",
      "scope" = EXCLUDED."scope",
      "code" = EXCLUDED."code",
      "shopType" = EXCLUDED."shopType",
      "businessQualifier" = EXCLUDED."businessQualifier",
      "query" = EXCLUDED."query",
      "resultUrl" = EXCLUDED."resultUrl",
      "details" = EXCLUDED."details"
    RETURNING "id"
  `;
}

function shopWorkBatchKey({ shopId, workType, scopeKey }) {
  return `${shopId}\u0000${workType}\u0000${scopeKey}`;
}

async function bulkClaimShopWorkRows(
  transaction,
  rows,
  runIdentifier,
  lease,
  now
) {
  if (!rows.length) return [];
  return transaction.$queryRaw`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS value(
        "id" text,
        "shopId" text,
        "workType" text,
        "scopeKey" text,
        "expectedState" text,
        "expectedRunId" text,
        "expectedLeaseToken" text,
        "expectedPipelineTaskId" text
      )
    )
    UPDATE "ShopWork" AS work SET
      "state" = 'processing'::"ShopWorkState",
      "processingRunId" = ${runIdentifier},
      "processingLeaseToken" = ${lease.token},
      "processingPipelineTaskId" = NULL,
      "safeErrorCode" = NULL,
      "safeErrorMessage" = NULL,
      "startedAt" = ${now},
      "completedAt" = NULL,
      "updatedAt" = ${now}
    FROM input
    WHERE work."id" = input."id"
      AND work."shopId" = input."shopId"
      AND work."workType" = input."workType"::"ShopWorkType"
      AND work."scopeKey" = input."scopeKey"
      AND work."state" = input."expectedState"::"ShopWorkState"
      AND work."processingRunId" IS NOT DISTINCT FROM input."expectedRunId"
      AND work."processingLeaseToken" IS NOT DISTINCT FROM input."expectedLeaseToken"
      AND work."processingPipelineTaskId" IS NOT DISTINCT FROM input."expectedPipelineTaskId"
      AND NOT (
        work."workType" = 'dataforseo'::"ShopWorkType"
        AND EXISTS (
          SELECT 1
          FROM "DataForSeoRequestLedger" AS ledger
          WHERE ledger."runId" = work."processingRunId"
            AND ledger."scopeKey" = work."scopeKey"
            AND ledger."state" IN (
              'in_flight'::"DataForSeoRequestState",
              'ambiguous'::"DataForSeoRequestState"
            )
        )
      )
    RETURNING work."id", work."shopId", work."workType", work."scopeKey"
  `;
}

async function bulkFinishOwnedShopWork(
  transaction,
  rows,
  runIdentifier,
  lease,
  state,
  now
) {
  if (!rows.length) return [];
  const safeErrorCode = state === "completed"
    ? null
    : state === "ambiguous"
      ? "WORK_OUTCOME_AMBIGUOUS"
      : "WORK_FAILED";
  const safeErrorMessage = state === "completed"
    ? null
    : state === "ambiguous"
      ? "The provider work outcome could not be confirmed safely."
      : "The provider work failed safely.";
  return transaction.$queryRaw`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS value(
        "shopId" text,
        "workType" text,
        "scopeKey" text
      )
    )
    UPDATE "ShopWork" AS work SET
      "state" = ${state}::"ShopWorkState",
      "completedAt" = ${now},
      "safeErrorCode" = ${safeErrorCode},
      "safeErrorMessage" = ${safeErrorMessage},
      "updatedAt" = ${now}
    FROM input
    WHERE work."shopId" = input."shopId"
      AND work."workType" = input."workType"::"ShopWorkType"
      AND work."scopeKey" = input."scopeKey"
      AND work."state" = 'processing'::"ShopWorkState"
      AND work."processingRunId" = ${runIdentifier}
      AND work."processingLeaseToken" = ${lease.token}
    RETURNING work."id", work."shopId", work."workType", work."scopeKey"
  `;
}

async function markPaidWorkForAmbiguousLedgers(transaction, now) {
  return transaction.$executeRaw`
    UPDATE "ShopWork" AS work SET
      "state" = 'ambiguous'::"ShopWorkState",
      "safeErrorCode" = 'WORK_OUTCOME_AMBIGUOUS',
      "safeErrorMessage" = 'The provider work outcome could not be confirmed safely.',
      "completedAt" = ${now},
      "updatedAt" = ${now}
    FROM "DataForSeoRequestLedger" AS ledger
    WHERE work."workType" = 'dataforseo'::"ShopWorkType"
      AND work."state" = 'processing'::"ShopWorkState"
      AND work."processingRunId" = ledger."runId"
      AND work."scopeKey" = ledger."scopeKey"
      AND ledger."state" = 'ambiguous'::"DataForSeoRequestState"
  `;
}

async function bulkUpsertTrafficCache(transaction, rows, now) {
  if (!rows.length) return [];
  return transaction.$queryRaw`
    INSERT INTO "TrafficEnrichmentCache" (
      "id", "source", "identity", "scopeKey", "metricSetKey",
      "contractVersion", "state", "normalizedPayload", "fetchedAt",
      "coverageStartedAt", "coverageEndedAt", "expiresAt", "createdAt", "updatedAt"
    )
    SELECT
      input."id", input."source"::"TrafficEnrichmentSource", input."identity",
      input."scopeKey", input."metricSetKey", input."contractVersion",
      input."state"::"TrafficEnrichmentCacheState", input."normalizedPayload",
      input."fetchedAt", input."coverageStartedAt", input."coverageEndedAt",
      input."expiresAt", ${now}, ${now}
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input(
      "id" text,
      "source" text,
      "identity" text,
      "scopeKey" text,
      "metricSetKey" text,
      "contractVersion" text,
      "state" text,
      "normalizedPayload" jsonb,
      "fetchedAt" timestamp,
      "coverageStartedAt" timestamp,
      "coverageEndedAt" timestamp,
      "expiresAt" timestamp
    )
    ON CONFLICT ("source", "identity", "scopeKey", "metricSetKey", "contractVersion")
    DO UPDATE SET
      "state" = EXCLUDED."state",
      "normalizedPayload" = EXCLUDED."normalizedPayload",
      "fetchedAt" = EXCLUDED."fetchedAt",
      "coverageStartedAt" = EXCLUDED."coverageStartedAt",
      "coverageEndedAt" = EXCLUDED."coverageEndedAt",
      "expiresAt" = EXCLUDED."expiresAt",
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "source", "identity", "scopeKey", "metricSetKey", "contractVersion"
  `;
}

async function bulkUpsertLeadTraffic(transaction, rows) {
  if (!rows.length) return [];
  return transaction.$queryRaw`
    INSERT INTO "LeadTrafficEnrichment" (
      "id", "runId", "leadId", "source", "state", "contractVersion",
      "normalizedPayload", "fetchedAt", "coverageStartedAt", "coverageEndedAt"
    )
    SELECT
      input."id", input."runId", input."leadId",
      input."source"::"TrafficEnrichmentSource",
      input."state"::"LeadTrafficEnrichmentState", input."contractVersion",
      input."normalizedPayload", input."fetchedAt", input."coverageStartedAt",
      input."coverageEndedAt"
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input(
      "id" text,
      "runId" text,
      "leadId" text,
      "source" text,
      "state" text,
      "contractVersion" text,
      "normalizedPayload" jsonb,
      "fetchedAt" timestamp,
      "coverageStartedAt" timestamp,
      "coverageEndedAt" timestamp
    )
    ON CONFLICT ("leadId", "source") DO UPDATE SET
      "state" = EXCLUDED."state",
      "contractVersion" = EXCLUDED."contractVersion",
      "normalizedPayload" = EXCLUDED."normalizedPayload",
      "fetchedAt" = EXCLUDED."fetchedAt",
      "coverageStartedAt" = EXCLUDED."coverageStartedAt",
      "coverageEndedAt" = EXCLUDED."coverageEndedAt"
    RETURNING "leadId", "source"
  `;
}

function metricSetKey(values) {
  return [...values].sort().join(",");
}

function dataForSeoScopes() {
  return [
    "worldwide",
    ...Object.entries(DATAFORSEO_COUNTRY_LOCATION_CODES).map(
      ([countryIsoCode, locationCode]) => ({ countryIsoCode, locationCode })
    )
  ];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

export function trafficEnrichmentConfigSnapshot(config = {}) {
  const noCoverageFreshnessMs = config.trafficNoCoverageCacheFreshnessMs ?? 86400000;
  return deepFreeze({
    version: "traffic-enrichment-run-v1",
    dataForSeo: Object.freeze({
      enabled: config.dataForSeoEnrichmentEnabled === true,
      scopes: Object.freeze(dataForSeoScopes()),
      contractVersion: DATAFORSEO_TRAFFIC_CONTRACT_VERSION,
      responseContractVersion: DATAFORSEO_RESPONSE_CONTRACT_VERSION,
      metricSet: Object.freeze([...DATAFORSEO_ITEM_TYPES]),
      metricSetKey: metricSetKey(DATAFORSEO_ITEM_TYPES),
      targetLimit: DATAFORSEO_TARGET_LIMIT,
      cacheFreshnessMs: config.dataForSeoCacheFreshnessMs ?? 2592000000,
      noCoverageFreshnessMs,
      maxCostPerRunUsd: config.dataForSeoMaxCostPerRunUsd ?? 2,
      estimatedCostPerTaskUsd: 0.024,
      paidRequestStaleMs: config.trafficPaidRequestStaleMs ?? 900000
    }),
    crux: Object.freeze({
      enabled: config.cruxEnrichmentEnabled === true,
      rest: Object.freeze({
        contractVersion: CRUX_ORIGIN_METRICS_CONTRACT_VERSION,
        responseContractVersion: CRUX_API_RESPONSE_CONTRACT_VERSION,
        metricSet: Object.freeze([...CRUX_METRICS]),
        metricSetKey: metricSetKey(CRUX_METRICS),
        concurrency: config.cruxRestConcurrency ?? 2,
        cacheFreshnessMs: config.cruxRestCacheFreshnessMs ?? 86400000,
        noCoverageFreshnessMs
      }),
      bigQuery: Object.freeze({
        contractVersion: CRUX_POPULARITY_CONTRACT_VERSION,
        responseContractVersion: CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION,
        metricSet: Object.freeze([
          "popularity_rank", "phone_density", "desktop_density", "tablet_density"
        ]),
        metricSetKey: metricSetKey([
          "popularity_rank", "phone_density", "desktop_density", "tablet_density"
        ]),
        originLimit: CRUX_BIGQUERY_ORIGIN_LIMIT,
        location: config.cruxBigQueryLocation || "US",
        maxBytesBilled: config.cruxBigQueryMaxBytesBilled ?? 10000000000
      })
    })
  });
}

export function awsProviderConfigSnapshot(config = {}) {
  try {
    const browserlessUrl = new URL(config.browserlessUrl);
    if (browserlessUrl.protocol !== "https:" || browserlessUrl.username || browserlessUrl.password ||
        browserlessUrl.search || browserlessUrl.hash || !config.googleSearchEngineId ||
        (config.cruxEnrichmentEnabled === true && !config.cruxBigQueryProjectId) ||
        config.maxPagesPerStore !== 5 || config.pageFetchConcurrency !== 2 ||
        (config.browserlessEnabled === true && !config.browserlessToken) ||
        (config.enableAiNormalization === true && (!config.openaiApiKey || !config.openaiModel))) {
      throw new Error("invalid AWS provider configuration");
    }
    return deepFreeze(parseAwsProviderConfig({
      version: "aws-provider-config-v1",
      googleSearch: {
        contractVersion: "google-custom-search-v1",
        engineIdFingerprint: fingerprintJson({ contractVersion: "google-search-engine-v1", searchEngineId: config.googleSearchEngineId }),
        resultsPerQuery: config.googleResultsPerQuery,
        requestTimeoutMs: config.requestTimeoutMs
      },
      queryValidation: {
        probeContractVersion: "google-probe-v2", maxQueries: config.maxQueries,
        generatedQueryCount: config.generatedQueryCount, queryProbeFreshnessMs: config.queryProbeFreshnessMs,
        queryProbeConcurrency: config.queryProbeConcurrency, minQueryResults: config.minQueryResults,
        minQueryUniqueHosts: config.minQueryUniqueHosts, minQueryRelevantResults: config.minQueryRelevantResults,
        minQueryRelevanceRatio: config.minQueryRelevanceRatio, minQueryBaseScore: config.minQueryBaseScore
      },
      discoveryIdentity: { requestTimeoutMs: config.requestTimeoutMs, browserlessEnabled: false },
      leadFetch: { requestTimeoutMs: config.requestTimeoutMs, maxPagesPerStore: 5, pageFetchConcurrency: 2 },
      browserless: {
        enabled: config.browserlessEnabled === true, origin: browserlessUrl.origin,
        contractVersion: "browserless-domain-render-documents-v1",
        primaryConfigured: Boolean(config.browserlessToken), fallbackConfigured: Boolean(config.browserlessFallbackToken),
        navigationTimeoutMs: 8000, requestTimeoutMs: 45000, clientAbortMs: 48000
      },
      aiNormalization: {
        enabled: config.enableAiNormalization === true,
        contractVersion: "openai-chat-completions-shopify-lead-v1", model: config.openaiModel || "",
        requestTimeoutMs: config.requestTimeoutMs
      },
      trafficHttp: {
        requestTimeoutMs: config.requestTimeoutMs,
        cruxBigQueryProjectIdFingerprint: config.cruxEnrichmentEnabled === true
          ? fingerprintJson({ contractVersion: "crux-bigquery-project-v1", projectId: config.cruxBigQueryProjectId })
          : null
      }
    }));
  } catch {
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
}

const SAFE_LEDGER_FAILURES = Object.freeze({
  DATAFORSEO_NOT_DISPATCHED: "The request failed before provider dispatch.",
  DATAFORSEO_ZERO_COST_REJECTION: "The provider rejected the request with proven zero cost."
});

function safeLedgerError(code) {
  const message = SAFE_LEDGER_FAILURES[code];
  if (!message) throw new Error("A recognized safe ledger error code is required");
  return { code, message };
}

function requirePaidDescriptor(descriptor) {
  if (!descriptor || !/^[a-f0-9]{64}$/u.test(descriptor.requestFingerprint || "")) {
    throw new Error("DataForSEO request fingerprint is invalid");
  }
  if (!Number.isInteger(descriptor.targetCount) || descriptor.targetCount < 1 ||
      descriptor.targetCount > DATAFORSEO_TARGET_LIMIT) {
    throw new Error("DataForSEO target count is invalid");
  }
  if (typeof descriptor.scopeKey !== "string" || !descriptor.scopeKey || descriptor.scopeKey.length > 128) {
    throw new Error("DataForSEO scope key is invalid");
  }
  if (!/^(?:worldwide|country:[A-Z]{2}:[1-9]\d*)$/u.test(descriptor.scopeKey)) {
    throw new Error("DataForSEO scope key is invalid");
  }
  if (descriptor.refreshSucceededAfterMs != null &&
      (!Number.isSafeInteger(descriptor.refreshSucceededAfterMs) ||
       descriptor.refreshSucceededAfterMs < 1)) {
    throw new Error("DataForSEO refresh freshness is invalid");
  }
  return descriptor;
}

function requirePaidPolicy(snapshot) {
  const policy = snapshot?.dataForSeo;
  if (!policy || !Number.isFinite(policy.maxCostPerRunUsd) || policy.maxCostPerRunUsd <= 0 ||
      !Number.isFinite(policy.estimatedCostPerTaskUsd) || policy.estimatedCostPerTaskUsd <= 0 ||
      !Number.isSafeInteger(policy.paidRequestStaleMs) || policy.paidRequestStaleMs < 1) {
    throw new Error("The immutable DataForSEO paid policy is invalid");
  }
  return policy;
}

function paidExposure(rows, policy) {
  return rows.reduce((total, row) => {
    if (row.state === "succeeded") {
      const cost = Number(row.providerCostUsd);
      return total + (Number.isFinite(cost) && cost >= 0 ? cost : policy.maxCostPerRunUsd);
    }
    const reservation = Number(row.reservationCostUsd);
    return total + (Number.isFinite(reservation) && reservation > 0
      ? reservation
      : policy.estimatedCostPerTaskUsd);
  }, 0);
}

function cacheId(record) {
  return childId("traffic_cache", record.source, canonicalJson({
    identity: record.identity,
    scopeKey: record.scopeKey,
    metricSetKey: record.metricSetKey,
    contractVersion: record.contractVersion
  }));
}

function resultFingerprint(payload) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function dataForSeoScoringEnabled(run) {
  return run?.trafficEnrichmentConfig?.dataForSeo?.enabled === true;
}

export async function finalizePersistedLeadScoresV3(transaction, runIdentifier, run, { captureLeads } = {}) {
  if (!dataForSeoScoringEnabled(run)) return 2;
  const [storedLeads, trafficEnrichments] = await Promise.all([
    transaction.lead.findMany({
      where: { runId: runIdentifier },
      orderBy: { id: "asc" }
    }),
    transaction.leadTrafficEnrichment.findMany({
      where: { runId: runIdentifier },
      orderBy: [{ leadId: "asc" }, { source: "asc" }]
    })
  ]);
  const publicLeads = storedLeads.map((lead) => serializeLead(lead));
  const finalLeads = finalizeLeadScoresV3({
    leads: publicLeads,
    trafficEnrichments,
    cruxEnabled: run.trafficEnrichmentConfig?.crux?.enabled === true
  });
  if (finalLeads.length !== storedLeads.length) {
    throw new Error("V3 score finalization did not reconcile every lead");
  }
  const updates = finalLeads.map((lead) => {
    const validated = leadRecordToCreate(runIdentifier, lead.id, lead);
    return { id: lead.id, pipelineVersion: validated.pipelineVersion,
      scoringVersion: validated.scoringVersion, leadScore: validated.leadScore,
      scoreBreakdown: validated.scoreBreakdown ?? null };
  });
  const updated = updates.length ? await transaction.$queryRaw`
    UPDATE "Lead" AS lead SET
      "pipelineVersion" = input."pipelineVersion",
      "scoringVersion" = input."scoringVersion",
      "leadScore" = input."leadScore",
      "scoreBreakdown" = input."scoreBreakdown"
    FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS input(
      "id" text,
      "pipelineVersion" integer,
      "scoringVersion" integer,
      "leadScore" integer,
      "scoreBreakdown" jsonb
    )
    WHERE lead."id" = input."id" AND lead."runId" = ${runIdentifier}
    RETURNING lead."id"
  ` : [];
  if (updated.length !== storedLeads.length ||
      new Set(updated.map(({ id }) => id)).size !== storedLeads.length) {
    throw new Error("V3 score finalization row count did not reconcile every lead");
  }
  if (Array.isArray(captureLeads)) {
    const updateById = new Map(updates.map((update) => [update.id, update]));
    captureLeads.push(...storedLeads.map((lead) => ({ ...lead, ...updateById.get(lead.id) })));
  }
  return 3;
}

function resultWhere(runIdentifier, ownerId, filters) {
  const where = { runId: runIdentifier, run: { ownerId } };
  if (filters.status) where.status = filters.status;
  if (filters.search) {
    where.OR = [
      "storeName",
      "resolvedDomain",
      "myshopifyDomain",
      "email",
      "shopType"
    ].map((field) => ({
      [field]: { contains: filters.search, mode: "insensitive" }
    }));
  }
  if (filters.discoveryQueries?.length) {
    const attributed = filters.discoveryQueries.filter((query) => query !== "__unattributed__");
    const includeUnattributed = filters.discoveryQueries.includes("__unattributed__");
    where.AND = [{ OR: [
      ...(attributed.length ? [{ generatedQuery: { in: attributed } }, { searchQuery: { in: attributed } }] : []),
      ...(includeUnattributed ? [{ AND: [{ generatedQuery: null }, { searchQuery: null }] }] : [])
    ] }];
  }
  return where;
}

const SORT_FIELDS = {
  lead_score: "leadScore",
  store_name: "storeName",
  shop_type: "shopType",
  google_rank: "googleRank"
};

function resultOrder(filters) {
  if (!filters.sortBy) {
    return [
      { leadScore: { sort: "desc", nulls: "last" } },
      { storeName: { sort: "asc", nulls: "last" } },
      { id: "asc" }
    ];
  }
  const field = SORT_FIELDS[filters.sortBy];
  return [
    { [field]: { sort: filters.sortDirection, nulls: "last" } },
    { id: "asc" }
  ];
}

export class PrismaRunRepository {
  constructor(prisma = getPrismaClient(), runtimeConfig = {}) {
    this.prisma = prisma;
    this.databaseSchema = prismaSchemaForClient(prisma);
    this.trafficEnrichmentConfig = trafficEnrichmentConfigSnapshot(runtimeConfig);
    this.awsProviderConfig = runtimeConfig.runExecutionBackend === "aws"
      ? awsProviderConfigSnapshot(runtimeConfig)
      : null;
  }

  async health() {
    await this.prisma.run.count();
  }

  runCreateData(ownerId, normalizedShopTypes, identifier = runId()) {
    return {
      id: identifier,
      ownerId,
      state: "queued",
      phase: "query_planning",
      stage: "queued_query_planning",
      normalizedShopTypes,
      progress: {
        ...createInitialProgress(),
        shopTypesTotal: normalizedShopTypes.length
      },
      pipelineVersion: 2,
      scoringVersion: 2,
      executionBackend: this.awsProviderConfig ? "aws" : "local",
      trafficEnrichmentConfig: this.trafficEnrichmentConfig,
      ...(this.awsProviderConfig ? { awsProviderConfig: this.awsProviderConfig } : {})
    };
  }

  async createRun(ownerId, normalizedShopTypes) {
    return this.prisma.run.create({
      data: this.runCreateData(ownerId, normalizedShopTypes)
    });
  }

  async createRunIntent(normalizedShopTypes, expiresAt) {
    return this.prisma.runIntent.create({
      data: {
        id: runIntentId(),
        normalizedShopTypes,
        expiresAt
      }
    });
  }

  async claimRunIntent(
    intentIdentifier,
    ownerId,
    now = new Date(),
    { allowCreate = true } = {}
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const intent = await transaction.runIntent.findUnique({
        where: { id: intentIdentifier }
      });
      if (!intent || intent.expiresAt <= now) {
        throw new RunIntentNotFoundError();
      }
      if (intent.claimedRunId) {
        if (intent.claimedByUserId !== ownerId) {
          throw new RunIntentNotFoundError();
        }
        const existingRun = await transaction.run.findFirst({
          where: { id: intent.claimedRunId, ownerId }
        });
        if (!existingRun) throw new RunIntentNotFoundError();
        return { run: existingRun, created: false };
      }
      if (!allowCreate) throw new RunAdmissionRejectedError();

      const identifier = runId();
      const claimed = await transaction.runIntent.updateMany({
        where: {
          id: intentIdentifier,
          claimedRunId: null,
          claimedByUserId: null,
          expiresAt: { gt: now }
        },
        data: {
          claimedByUserId: ownerId,
          claimedRunId: identifier
        }
      });
      if (claimed.count !== 1) {
        const concurrent = await transaction.runIntent.findUnique({
          where: { id: intentIdentifier }
        });
        if (
          concurrent?.claimedByUserId === ownerId &&
          concurrent.claimedRunId
        ) {
          const existingRun = await transaction.run.findFirst({
            where: { id: concurrent.claimedRunId, ownerId }
          });
          if (existingRun) return { run: existingRun, created: false };
        }
        throw new RunIntentNotFoundError();
      }

      const run = await transaction.run.create({
        data: this.runCreateData(
          ownerId,
          intent.normalizedShopTypes,
          identifier
        )
      });
      return { run, created: true };
    });
  }

  async claimNextQueuedRun(
    owner,
    now = new Date(),
    leaseDurationMs = 90_000
  ) {
    if (!owner) throw new Error("A worker lease owner is required");
    const token = leaseToken();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const next = await transaction.run.findFirst({
          where: { state: "queued" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }]
        });
        if (!next) return null;
        const claimed = await transaction.run.updateMany({
          where: { id: next.id, state: "queued" },
          data: {
            state: "running",
            stage: next.phase === "scraping" && [
              "stores_persisted",
              "discovering_leads",
              "leads_persisted",
              "enriching_traffic"
            ].includes(next.stage)
              ? next.stage
              : next.phase === "scraping"
                ? "validating_confirmed_queries"
                : "reading_categories",
            startedAt: next.startedAt || now,
            leaseOwner: owner,
            leaseToken: token,
            leaseAcquiredAt: now,
            leaseExpiresAt: expiresAt,
            lastHeartbeatAt: now,
            leaseAttempt: { increment: 1 },
            safeErrorCode: null,
            safeErrorMessage: null
          }
        });
        if (claimed.count !== 1) return null;
        const run = await transaction.run.findUnique({ where: { id: next.id } });
        return { run, lease: { owner, token, expiresAt } };
      });
    } catch (error) {
      if (isUniqueConstraint(error)) return null;
      throw error;
    }
  }

  async listRuns(ownerId, { page, pageSize }) {
    const where = { ownerId };
    const skip = (page - 1) * pageSize;
    const [totalItems, items] = await this.prisma.$transaction([
      this.prisma.run.count({ where }),
      this.prisma.run.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: pageSize
      })
    ]);
    return { totalItems, items };
  }

  async getRun(runIdentifier, ownerId) {
    return this.prisma.run.findFirst({
      where: { id: runIdentifier, ownerId },
      include: {
        queries: { select: { validationState: true } }
      }
    });
  }

  async getActiveRunForOwner(ownerId) {
    return this.prisma.run.findFirst({
      where: {
        ownerId,
        state: { in: [...ACTIVE_STATES, "awaiting_query_confirmation"] }
      },
      orderBy: { createdAt: "asc" }
    });
  }

  async saveGeneratedQueryPlan(
    runIdentifier,
    lease,
    { selected = [], audits = [], categories = [], config },
    status,
    now = new Date()
  ) {
    const requiredCount = config.generatedQueryCount ?? 10;
    const counts = new Array(categories.length).fill(0);
    for (const plan of selected) {
      const categoryIndex = categories.findIndex((category) =>
        category.shopType === plan.shopType &&
        category.businessQualifier === (plan.businessQualifier || "unspecified") &&
        category.originalShopType === (plan.originalShopType || "")
      );
      if (categoryIndex >= 0) counts[categoryIndex] += 1;
    }
    if (counts.some((count) => count !== requiredCount)) {
      throw new Error("Cannot publish an incomplete generated query plan");
    }
    const rows = selected.map((plan, sequence) => {
      const categoryIndex = categories.findIndex((category) =>
        category.shopType === plan.shopType &&
        category.businessQualifier === (plan.businessQualifier || "unspecified") &&
        category.originalShopType === (plan.originalShopType || "")
      );
      if (categoryIndex < 0) throw new Error("Generated query has no matching run category");
      const category = categories[categoryIndex];
      const fingerprint = queryProbeFingerprint(plan.query, category, config);
      return {
        id: queryId(),
        runId: runIdentifier,
        categoryIndex,
        sequence,
        query: plan.query,
        source: "generated",
        validationState: "valid",
        rejectionReason: null,
        queryScore: Number.isFinite(Number(plan.queryScore)) ? Number(plan.queryScore) : null,
        generationReason: plan.queryGenerationReason || null,
        sourceUrls: Array.isArray(plan.querySourceUrls) ? plan.querySourceUrls.slice(0, 8) : [],
        categoryVocabulary: plan.categoryVocabulary || [],
        probeSummary: {
          accepted: true,
          resultCount: Array.isArray(plan.results) ? plan.results.length : 0
        },
        probeResults: normalizeProbeResults(plan.results),
        probeContractVersion: GOOGLE_PROBE_CONTRACT_VERSION,
        probeFingerprint: fingerprint,
        probedAt: now
      };
    });
    const auditRows = audits.map((record, index) =>
      queryAuditRecordToCreate(
        runIdentifier,
        childId("audit", runIdentifier, index),
        index,
        record
      )
    );
    return this.prisma.$transaction(async (transaction) => {
      const transitioned = await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          state: "awaiting_query_confirmation",
          phase: "query_review",
          stage: "awaiting_query_confirmation",
          queryRevision: { increment: 1 },
          queryPlanReadyAt: now,
          progress: progressFromStatus(status),
          leaseOwner: null,
          leaseToken: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null
        }
      });
      requireLeaseMutation(transitioned);
      await transaction.runQuery.deleteMany({ where: { runId: runIdentifier } });
      await transaction.queryAudit.deleteMany({ where: { runId: runIdentifier } });
      if (rows.length) await transaction.runQuery.createMany({ data: rows });
      if (auditRows.length) await transaction.queryAudit.createMany({ data: auditRows });
      return transaction.run.findUnique({ where: { id: runIdentifier } });
    });
  }

  async saveQueryPlanningFailure(
    runIdentifier,
    lease,
    { audits = [], shortfalls = [] },
    status,
    now = new Date()
  ) {
    const auditRows = audits.map((record, index) =>
      queryAuditRecordToCreate(
        runIdentifier,
        childId("audit", runIdentifier, index),
        index,
        record
      )
    );
    const first = shortfalls[0] || {};
    const selected = Number.isInteger(first.selected) ? first.selected : 0;
    const target = Number.isInteger(first.target) ? first.target : 10;
    const category = first.shopType || "the category";
    const message = `${selected} of ${target} required queries passed for ${category}.`;

    return this.prisma.$transaction(async (transaction) => {
      const transitioned = await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          state: "failed",
          phase: "finished",
          stage: "failed",
          completedAt: now,
          resultsAvailable: false,
          safeErrorCode: "INSUFFICIENT_HIGH_QUALITY_QUERIES",
          safeErrorMessage: message,
          progress: progressFromStatus(status),
          leaseOwner: null,
          leaseToken: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null
        }
      });
      requireLeaseMutation(transitioned);
      await transaction.runQuery.deleteMany({ where: { runId: runIdentifier } });
      await transaction.queryAudit.deleteMany({ where: { runId: runIdentifier } });
      if (auditRows.length) await transaction.queryAudit.createMany({ data: auditRows });
      return transaction.run.findUnique({ where: { id: runIdentifier } });
    });
  }

  async getEditableQueries(runIdentifier, ownerId) {
    const run = await this.prisma.run.findFirst({
      where: { id: runIdentifier, ownerId },
      include: { queries: { orderBy: { sequence: "asc" } } }
    });
    return run;
  }

  async replaceEditableQueries(
    runIdentifier,
    ownerId,
    expectedRevision,
    queries,
    now = new Date()
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.run.findFirst({
        where: { id: runIdentifier, ownerId },
        include: { queries: true }
      });
      if (!run) return null;
      if (run.state !== "awaiting_query_confirmation" || run.phase !== "query_review") {
        throw new RunNotAwaitingQueryConfirmationError();
      }
      if (run.queryRevision !== expectedRevision) {
        throw new QueryRevisionConflictError(run.queryRevision);
      }
      const advanced = await transaction.run.updateMany({
        where: {
          id: runIdentifier,
          ownerId,
          state: "awaiting_query_confirmation",
          phase: "query_review",
          queryRevision: expectedRevision
        },
        data: { queryRevision: { increment: 1 } }
      });
      if (advanced.count !== 1) {
        const current = await transaction.run.findFirst({
          where: { id: runIdentifier, ownerId },
          select: { queryRevision: true }
        });
        throw new QueryRevisionConflictError(current?.queryRevision ?? expectedRevision);
      }
      const existingById = new Map(run.queries.map((row) => [row.id, row]));
      const rows = queries.map((item, sequence) => {
        const existing = item.id ? existingById.get(item.id) : null;
        const unchanged = existing &&
          existing.categoryIndex === item.categoryIndex &&
          existing.query === item.query;
        if (unchanged) return { ...existing, sequence, updatedAt: now };
        return {
          id: existing?.id || queryId(),
          runId: runIdentifier,
          categoryIndex: item.categoryIndex,
          sequence,
          query: item.query,
          source: existing ? "user_edited" : "user_added",
          validationState: "pending",
          rejectionReason: null,
          queryScore: existing?.queryScore ?? null,
          generationReason: existing?.generationReason ?? null,
          sourceUrls: existing?.sourceUrls || [],
          categoryVocabulary: jsonValue(existing?.categoryVocabulary) || [],
          probeSummary: undefined,
          probeResults: undefined,
          probeContractVersion: null,
          probeFingerprint: null,
          probedAt: null,
          createdAt: existing?.createdAt || now,
          updatedAt: now
        };
      });
      await transaction.runQuery.deleteMany({ where: { runId: runIdentifier } });
      if (rows.length) await transaction.runQuery.createMany({ data: rows });
      return transaction.run.findUnique({
        where: { id: runIdentifier },
        include: { queries: { orderBy: { sequence: "asc" } } }
      });
    });
  }

  async confirmQueryRevision(
    runIdentifier,
    ownerId,
    expectedRevision,
    now = new Date(),
    executionBackend = "local",
    awsProviderConfig = null
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.run.findFirst({
        where: { id: runIdentifier, ownerId }
      });
      if (!run) return null;
      let parsedAwsConfig = null;
      if (executionBackend === "aws") {
        parsedAwsConfig = parseAwsProviderConfig(awsProviderConfig);
        const persisted = parseAwsProviderConfig(run.awsProviderConfig);
        if (run.executionBackend !== "aws" || canonicalJson(parsedAwsConfig) !== canonicalJson(persisted)) {
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
      } else if (executionBackend !== "local" || awsProviderConfig !== null) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      if (
        run.phase === "scraping" &&
        run.confirmedQueryRevision === expectedRevision &&
        ["queued", "running"].includes(run.state) &&
        run.executionBackend === executionBackend
      ) return run;
      if (run.state !== "awaiting_query_confirmation" || run.phase !== "query_review") {
        throw new RunNotAwaitingQueryConfirmationError();
      }
      if (run.queryRevision !== expectedRevision) {
        throw new QueryRevisionConflictError(run.queryRevision);
      }
      const updated = await transaction.run.updateMany({
        where: {
          id: runIdentifier,
          ownerId,
          state: "awaiting_query_confirmation",
          phase: "query_review",
          queryRevision: expectedRevision,
          executionBackend
        },
        data: {
          state: "queued",
          phase: "scraping",
          stage: "queued_query_validation",
          confirmedQueryRevision: expectedRevision,
          queriesConfirmedAt: now,
          safeErrorCode: null,
          safeErrorMessage: null
        }
      });
      if (updated.count !== 1) throw new QueryRevisionConflictError(expectedRevision);
      return transaction.run.findUnique({ where: { id: runIdentifier } });
    });
  }

  async loadConfirmedQueryPlans(runIdentifier, lease, now = new Date()) {
    const run = await this.prisma.run.findFirst({
      where: activeLeaseWhere(runIdentifier, lease, now),
      include: { queries: { orderBy: { sequence: "asc" } } }
    });
    if (!run) throw new RunLeaseLostError();
    if (run.confirmedQueryRevision !== run.queryRevision) {
      throw new Error("Confirmed query revision no longer matches the editable revision");
    }
    return run.queries;
  }

  async publishAwsDiscoveryStage(input, now = new Date()) {
    const providerConfig = parseAwsProviderConfig(input.awsProviderConfig);
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const run = await transaction.run.findFirst({
        where: {
          ...activeLeaseWhere(input.runId, input.lease, now), executionBackend: "aws",
          pipelineGeneration: input.generation
        }
      });
      if (!run || canonicalJson(parseAwsProviderConfig(run.awsProviderConfig)) !== canonicalJson(providerConfig)) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const updated = await transaction.run.updateMany({
        where: { ...activeLeaseWhere(input.runId, input.lease, now), executionBackend: "aws",
          pipelineGeneration: input.generation },
        data: {
          state: "running", phase: "scraping", stage: "aws_discovery", resultsAvailable: false,
          progress: input.status, leaseOwner: null, leaseToken: null, leaseAcquiredAt: null,
          leaseExpiresAt: null, lastHeartbeatAt: null
        }
      });
      requireLeaseMutation(updated);
      const registered = await registerStageInTransaction(transaction, {
        runId: input.runId, stage: "discovery", generation: input.generation,
        manifestS3Key: input.manifestS3Key, manifestFingerprint: input.manifestFingerprint,
        manifestProducedAt: input.manifestProducedAt, tasks: input.tasks
      }, now);
      const finalRun = await transaction.run.findUnique({ where: { id: input.runId } });
      return { run: finalRun, stage: registered.stage,
        dispatchItems: registered.tasks.map((task) => ({ itemKey: task.itemKey, inputFingerprint: task.inputFingerprint })) };
    });
  }

  async readAwsReuseInputs(input) {
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const owned = await assertCompleteAggregatorInTransaction(transaction, {
        runId: input.runId, stage: "discovery", generation: input.generation,
        token: input.aggregationToken
      }, new Date());
      if (!(input.evaluatedAt instanceof Date) || input.evaluatedAt.getTime() !== owned.stage.createdAt.getTime()) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const trafficSnapshot = parseTrafficRunConfig(owned.run.trafficEnrichmentConfig);
      const awsProviderConfig = parseAwsProviderConfig(owned.run.awsProviderConfig);
      const shopIds = input.domains.map((domain) => domain.shopId);
      const exactKeys = input.domains.flatMap((domain) => {
        const providerIdentity = trafficProviderIdentities(domain.identity);
        return [
          ...trafficSnapshot.dataForSeo.scopes.map((scope) => ({ source: "dataforseo",
            identity: providerIdentity.hostname,
            scopeKey: typeof scope === "string" ? scope : `country:${scope.countryIsoCode}:${scope.locationCode}`,
            metricSetKey: trafficSnapshot.dataForSeo.metricSetKey,
            contractVersion: trafficSnapshot.dataForSeo.contractVersion })),
          { source: "crux_rest", identity: providerIdentity.origin, scopeKey: "current",
            metricSetKey: trafficSnapshot.crux.rest.metricSetKey,
            contractVersion: trafficSnapshot.crux.rest.contractVersion }
        ];
      });
      const bigQueryOrigins = input.domains.map((domain) =>
        trafficProviderIdentities(domain.identity).origin);
      const profiles = await transaction.shopLeadProfile.findMany({
        where: { shopId: { in: shopIds }, state: "completed", updatedAt: { lte: input.evaluatedAt } },
        orderBy: { shopId: "asc" }
      });
      const trafficRows = exactKeys.length ? await transaction.trafficEnrichmentCache.findMany({
        where: { fetchedAt: { lte: input.evaluatedAt }, expiresAt: { gt: input.evaluatedAt },
          OR: exactKeys.map(({ source, identity, scopeKey, metricSetKey, contractVersion }) =>
            ({ source, identity, scopeKey, metricSetKey, contractVersion })) },
        orderBy: { id: "asc" }
      }) : [];
      const latestCruxMonth = bigQueryOrigins.length ? await transaction.trafficEnrichmentCache.findMany({
        where: { source: "crux_bigquery", identity: { in: [...new Set(bigQueryOrigins)] },
          scopeKey: { startsWith: "month:" }, fetchedAt: { lte: input.evaluatedAt },
          expiresAt: { gt: input.evaluatedAt }, metricSetKey: trafficSnapshot.crux.bigQuery.metricSetKey,
          contractVersion: trafficSnapshot.crux.bigQuery.contractVersion },
        orderBy: [{ scopeKey: "desc" }, { identity: "asc" }]
      }) : [];
      return { profiles, trafficRows, latestCruxMonth, trafficSnapshot, awsProviderConfig,
        stage: owned.stage, tasks: owned.tasks };
    });
  }

  async readAwsReusableProfiles(input) {
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      await assertCompleteAggregatorInTransaction(transaction, {
        runId: input.runId, stage: "lead", generation: input.generation,
        token: input.aggregationToken
      }, new Date());
      if (!(input.evaluatedAt instanceof Date) || !Array.isArray(input.selections)) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const selections = [...input.selections].sort((left, right) => left.shopId.localeCompare(right.shopId));
      requireUniqueBatchKeys("Reusable lead selections", selections, ({ shopId }) => shopId);
      if (selections.some((selection) => selection.profileShopId !== selection.shopId ||
          typeof selection.profileFingerprint !== "string")) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const profiles = selections.length ? await transaction.shopLeadProfile.findMany({
        where: { shopId: { in: selections.map(({ profileShopId }) => profileShopId) },
          state: "completed", updatedAt: { lte: input.evaluatedAt } },
        orderBy: { shopId: "asc" }
      }) : [];
      if (profiles.length !== selections.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const selectionByShop = new Map(selections.map((selection) => [selection.shopId, selection]));
      for (const row of profiles) {
        const selection = selectionByShop.get(row.shopId);
        const profile = parseShopLeadProfile(row.profilePayload);
        if (!selection || fingerprintJson(profile) !== selection.profileFingerprint) {
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
        assertProfileMatchesShop(profile, selection.stableIdentity);
      }
      return { profiles };
    });
  }

  async publishAwsDomainCheckpoint(input, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const owned = await assertCompleteAggregatorInTransaction(transaction, {
        runId: input.runId, stage: "discovery", generation: input.generation,
        token: input.aggregationToken
      }, now);
      const shopRows = input.domains.map(({ identity, shopId }) => ({ id: shopId, ...identity }));
      const shops = await bulkUpsertShops(transaction, shopRows, now);
      if (shops.length !== shopRows.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const runStores = input.domains.map(({ runStoreId: id, shopId, candidatePayload }) => ({
        id, runId: input.runId, shopId, state: "processing", candidatePayload
      }));
      const existing = runStores.length ? await transaction.runStore.findMany({
        where: { id: { in: runStores.map((row) => row.id) } }
      }) : [];
      const expected = new Map(runStores.map((row) => [row.id, row]));
      if (existing.some((row) => canonicalJson(row.candidatePayload) !== canonicalJson(expected.get(row.id)?.candidatePayload))) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      if (runStores.length) await transaction.runStore.createMany({ data: runStores, skipDuplicates: true });
      const diagnostics = input.diagnostics.map((record, index) => diagnosticRecordToCreate(
        input.runId, childId("diag", input.runId, `aws-discovery:${100000 + index}`), 100000 + index, record
      ));
      const existingDiagnostics = diagnostics.length ? await transaction.runDiagnostic.findMany({
        where: { runId: input.runId, sequence: { in: diagnostics.map((row) => row.sequence) } }
      }) : [];
      const expectedDiagnostics = new Map(diagnostics.map((row) => [row.sequence, row]));
      if (existingDiagnostics.some((row) => canonicalJson({
        id: row.id, runId: row.runId, sequence: row.sequence, scope: row.scope, code: row.code,
        shopType: row.shopType, businessQualifier: row.businessQualifier, query: row.query,
        resultUrl: row.resultUrl, details: row.details
      }) !== canonicalJson(expectedDiagnostics.get(row.sequence)))) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const written = await bulkUpsertDiagnostics(transaction, diagnostics);
      if (written.length !== diagnostics.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const lead = await registerStageInTransaction(transaction, {
        runId: input.runId, stage: "lead", generation: input.generation,
        manifestS3Key: input.domainStageManifestKey,
        manifestFingerprint: input.domainStageManifestFingerprint,
        manifestProducedAt: input.manifestProducedAt, tasks: input.leadTasks
      }, now);
      const updated = await transaction.run.updateMany({ where: { id: input.runId, executionBackend: "aws",
        pipelineGeneration: input.generation, state: "running" }, data: { stage: "aws_lead",
        progress: input.status, resultsAvailable: false } });
      requireLeaseMutation(updated);
      const completed = await completeAggregatorInTransaction(transaction, {
        stageId: input.stageId, token: input.aggregationToken, state: "completed"
      }, now);
      return { stage: completed.stage, leadStage: lead.stage,
        dispatchItems: lead.tasks.map((task) => ({ itemKey: task.itemKey, inputFingerprint: task.inputFingerprint })) };
    });
  }

  async publishAwsLeadCheckpoint(input, now = new Date()) {
    const normalized = requireBoundedBatch("AWS lead outcomes", input.outcomes, 1000)
      .map((outcome) => {
        if (!outcome || typeof outcome.shopId !== "string" || typeof outcome.runStoreId !== "string" ||
            !["completed", "failed"].includes(outcome.state) || typeof outcome.profileReusable !== "boolean") {
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
        if (outcome.state === "failed" && outcome.profileReusable) {
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
        const profile = outcome.profile == null ? null : parseShopLeadProfile(outcome.profile);
        const leadRow = { ...leadRecordToCreate(input.runId,
          stableLeadId(input.runId, outcome.lead, 0), outcome.lead), shopId: outcome.shopId,
          shopLeadProfileId: outcome.profileReusable ? outcome.shopId : null };
        const diagnostic = outcome.diagnostic == null ? null : diagnosticRecordToCreate(input.runId,
          childId("diag", input.runId, `lead:${outcome.runStoreId}`), 0, outcome.diagnostic);
        return { ...outcome, profile, leadRow, diagnostic };
      }).sort((left, right) => left.shopId.localeCompare(right.shopId));
    requireUniqueBatchKeys("AWS lead outcomes", normalized, ({ shopId }) => shopId);
    requireUniqueBatchKeys("AWS lead run stores", normalized, ({ runStoreId }) => runStoreId);
    const trafficDomains = requireBoundedBatch("AWS traffic domains", input.trafficDomains, 1000)
      .slice().sort((left, right) => left.shopId.localeCompare(right.shopId));
    requireUniqueBatchKeys("AWS traffic domains", trafficDomains, ({ shopId }) => shopId);
    const progress = input.status ? progressFromStatus(input.status) : null;

    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const owned = await assertCompleteAggregatorInTransaction(transaction, {
        runId: input.runId, stage: "lead", generation: input.generation,
        token: input.aggregationToken
      }, now);
      const taskByShop = new Map(owned.tasks.map((task) => [task.itemKey, task]));
      if (normalized.some((outcome) => outcome.sourceTaskId == null
        ? taskByShop.has(outcome.shopId)
        : taskByShop.get(outcome.shopId)?.id !== outcome.sourceTaskId)) {
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const runStores = normalized.length ? await transaction.runStore.findMany({
        where: { runId: input.runId, id: { in: normalized.map(({ runStoreId }) => runStoreId) } },
        include: { shop: true }, orderBy: { shopId: "asc" }
      }) : [];
      if (runStores.length !== normalized.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const runStoreById = new Map(runStores.map((row) => [row.id, row]));
      for (const outcome of normalized) {
        const store = runStoreById.get(outcome.runStoreId);
        if (!store || store.shopId !== outcome.shopId || !["processing", outcome.state].includes(store.state))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        assertLeadMatchesShop(outcome.lead, store.shop.stableKey);
        if (outcome.profile) assertProfileMatchesShop(outcome.profile, store.shop.stableKey);
      }
      const reusable = normalized.filter(({ profileReusable }) => profileReusable);
      const profiles = reusable.length ? await transaction.shopLeadProfile.findMany({
        where: { shopId: { in: reusable.map(({ shopId }) => shopId) }, state: "completed" },
        orderBy: { shopId: "asc" }
      }) : [];
      if (profiles.length !== reusable.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const outcomeByShop = new Map(normalized.map((outcome) => [outcome.shopId, outcome]));
      for (const profileRow of profiles) {
        const profile = parseShopLeadProfile(profileRow.profilePayload);
        const expected = outcomeByShop.get(profileRow.shopId);
        assertProfileMatchesShop(profile, runStoreById.get(expected.runStoreId).shop.stableKey);
        if (expected.profile && fingerprintJson(profile) !== fingerprintJson(expected.profile))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const existing = normalized.length ? await transaction.lead.findMany({
        where: { runId: input.runId, shopId: { in: normalized.map(({ shopId }) => shopId) } }
      }) : [];
      const expectedByShop = new Map(normalized.map((outcome) => [outcome.shopId, outcome.leadRow]));
      for (const row of existing) for (const [key, value] of Object.entries(expectedByShop.get(row.shopId))) {
        if (value !== undefined && canonicalJson(row[key]) !== canonicalJson(value))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const existingShops = new Set(existing.map(({ shopId }) => shopId));
      const missing = normalized.filter(({ shopId }) => !existingShops.has(shopId)).map(({ leadRow }) => leadRow);
      if (missing.length) await transaction.lead.createMany({ data: missing });
      for (const state of ["completed", "failed"]) {
        const ids = normalized.filter((outcome) => outcome.state === state &&
          runStoreById.get(outcome.runStoreId).state === "processing").map(({ runStoreId }) => runStoreId);
        if (ids.length) {
          const result = await transaction.runStore.updateMany({ where: { runId: input.runId,
            id: { in: ids }, state: "processing" }, data: state === "completed"
            ? { state, safeErrorCode: null, safeErrorMessage: null }
            : { state, safeErrorCode: "LEAD_DISCOVERY_FAILED",
              safeErrorMessage: "Lead discovery failed safely for this store." } });
          if (result.count !== ids.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
      }
      const diagnostics = normalized.filter(({ diagnostic }) => diagnostic).map(({ diagnostic }, index) => ({
        ...diagnostic, sequence: 1_000_000 + index
      }));
      if ((await bulkUpsertDiagnostics(transaction, diagnostics)).length !== diagnostics.length)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const durableLeads = await transaction.lead.findMany({ where: { runId: input.runId }, orderBy: { shopId: "asc" } });
      if (durableLeads.length !== normalized.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const summary = durableLeads.reduce((counts, row) => { counts.total += 1; counts[row.status] += 1; return counts; },
        { total: 0, qualified: 0, rejected: 0, failed: 0 });
      const trafficByShop = new Map(trafficDomains.map((entry) => [entry.shopId, entry]));
      const trafficTasks = durableLeads.filter((lead) => trafficByShop.has(lead.shopId)).map((lead) => {
        const selection = trafficByShop.get(lead.shopId);
        if (lead.status !== "qualified" || selection.runStoreId !== runStoreById.get(
          outcomeByShop.get(lead.shopId).runStoreId).id ||
          ![selection.needsTraffic, selection.needsCruxRest, selection.needsCruxBigQuery].some(Boolean))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        const leadFingerprint = fingerprintJson(leadRecordToCreate(input.runId, lead.id, serializeLead(lead)));
        return { itemKey: lead.shopId, inputFingerprint: fingerprintJson({
          contractVersion: "traffic-domain-input-v1", runId: input.runId, generation: input.generation,
          manifestFingerprint: input.domainStageManifestFingerprint, shopId: lead.shopId, leadFingerprint,
          needsTraffic: selection.needsTraffic, needsCruxRest: selection.needsCruxRest,
          needsCruxBigQuery: selection.needsCruxBigQuery, sourceKeys: selection.sourceKeys
        }) };
      });
      if (trafficTasks.length !== trafficDomains.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const traffic = await registerStageInTransaction(transaction, { runId: input.runId,
        stage: "traffic_crux", generation: input.generation,
        manifestS3Key: input.domainStageManifestKey,
        manifestFingerprint: input.domainStageManifestFingerprint,
        manifestProducedAt: input.manifestProducedAt, tasks: trafficTasks }, now);
      const updated = await transaction.run.updateMany({ where: { id: input.runId, executionBackend: "aws",
        pipelineGeneration: input.generation, state: "running" }, data: { stage: "aws_traffic_crux",
        leadSummary: summary, pipelineVersion: 2, scoringVersion: 2, resultsAvailable: false,
        ...(progress ? { progress: { ...progress, outputRows: summary.total, storesProcessed: summary.total } } : {}) } });
      requireLeaseMutation(updated);
      const completed = await completeAggregatorInTransaction(transaction, { stageId: input.stageId,
        token: input.aggregationToken, state: "completed" }, now);
      return { stage: completed.stage, trafficStage: traffic.stage, summary,
        dispatchItems: traffic.tasks.map((task) => ({ itemKey: task.itemKey, inputFingerprint: task.inputFingerprint })) };
    });
  }

  async saveQueryValidation(runIdentifier, lease, rows, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      const fenced = await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { stage: "validating_confirmed_queries" }
      });
      requireLeaseMutation(fenced);
      for (const row of rows) {
        await transaction.runQuery.updateMany({
          where: { id: row.id, runId: runIdentifier },
          data: {
            query: row.query,
            validationState: row.validationState,
            rejectionReason: row.rejectionReason || null,
            probeSummary: jsonValue(row.probeSummary),
            probeResults: jsonValue(row.probeResults),
            probeContractVersion: row.probeContractVersion || null,
            probeFingerprint: row.probeFingerprint || null,
            probedAt: row.probedAt || null
          }
        });
      }
    });
  }

  async returnRunToQueryReview(
    runIdentifier,
    lease,
    status,
    now = new Date()
  ) {
    const result = await this.prisma.run.updateMany({
      where: activeLeaseWhere(runIdentifier, lease, now),
      data: {
        state: "awaiting_query_confirmation",
        phase: "query_review",
        stage: "awaiting_query_confirmation",
        confirmedQueryRevision: null,
        queriesConfirmedAt: null,
        progress: progressFromStatus(status),
        leaseOwner: null,
        leaseToken: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null
      }
    });
    return requireLeaseMutation(result);
  }

  async deleteExpiredRunIntents(now = new Date()) {
    return this.prisma.runIntent.deleteMany({
      where: {
        expiresAt: { lte: now },
        claimedRunId: null
      }
    });
  }

  async updateProgress(runIdentifier, lease, status, now = new Date()) {
    const result = await this.prisma.run.updateMany({
      where: activeLeaseWhere(runIdentifier, lease, now),
      data: {
        stage: status.stage || "running",
        progress: progressFromStatus(status)
      }
    });
    return requireLeaseMutation(result);
  }

  async heartbeatRun(
    runIdentifier,
    lease,
    now = new Date(),
    leaseDurationMs = 90_000
  ) {
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    const result = await this.prisma.run.updateMany({
      where: activeLeaseWhere(runIdentifier, lease, now),
      data: { lastHeartbeatAt: now, leaseExpiresAt: expiresAt }
    });
    requireLeaseMutation(result);
    return { ...lease, expiresAt };
  }

  async upsertVerifiedShop(
    runIdentifier,
    lease,
    identity,
    now = new Date(),
    retryAfterConflict = true
  ) {
    const input = parseStableShopIdentity(identity);
    const identifier = shopIdForStableKey(input.stableKey);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        requireLeaseMutation(await transaction.run.updateMany({
          where: activeLeaseWhere(runIdentifier, lease, now),
          data: { lastHeartbeatAt: now }
        }));
        const existing = await transaction.shop.findUnique({
          where: { stableKey: input.stableKey }
        });
        if (existing?.myshopifyDomain && input.myshopifyDomain &&
            existing.myshopifyDomain !== input.myshopifyDomain) {
          throw new Error("Conflicting verified MyShopify identities cannot be merged");
        }
        if (!existing) {
          return transaction.shop.create({
            data: { id: identifier, ...input }
          });
        }
        const stronger = Number(input.identityConfidence) >
          Number(existing.identityConfidence ?? -1);
        return transaction.shop.update({
          where: { id: existing.id },
          data: {
            myshopifyDomain: existing.myshopifyDomain || input.myshopifyDomain,
            resolvedDomain: stronger
              ? input.resolvedDomain || existing.resolvedDomain
              : existing.resolvedDomain || input.resolvedDomain,
            canonicalUrl: stronger
              ? input.canonicalUrl || existing.canonicalUrl
              : existing.canonicalUrl || input.canonicalUrl,
            identityConfidence: stronger
              ? input.identityConfidence
              : existing.identityConfidence ?? input.identityConfidence,
            identityEvidence: stronger || existing.identityEvidence == null
              ? input.identityEvidence
              : existing.identityEvidence
          }
        });
      });
    } catch (error) {
      if (retryAfterConflict && isUniqueConstraint(error)) {
        return this.upsertVerifiedShop(runIdentifier, lease, input, now, false);
      }
      throw error;
    }
  }

  async saveDiscoveredStores(
    runIdentifier,
    lease,
    stores,
    diagnostics = [],
    status = null,
    now = new Date(),
    retryAfterConflict = true
  ) {
    const normalized = requireBoundedBatch("Discovered stores", stores).map(
      ({ identity, candidatePayload }) => assertRunStoreIdentityPair(identity, candidatePayload)
    );
    requireUniqueBatchKeys(
      "Discovered stores",
      normalized,
      ({ identity }) => identity.stableKey
    );
    const diagnosticRows = requireBoundedBatch("Store diagnostics", diagnostics).map((record, index) =>
      diagnosticRecordToCreate(
        runIdentifier,
        childId("diag", runIdentifier, `stores:${index}`),
        index,
        record
      )
    );
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await selectBulkSchema(transaction, this.databaseSchema);
        requireLeaseMutation(await transaction.run.updateMany({
          where: activeLeaseWhere(runIdentifier, lease, now),
          data: {
            stage: "stores_persisted",
            ...(status ? { progress: {
              ...progressFromStatus(status),
              storesPersisted: normalized.length
            } } : {}),
            lastHeartbeatAt: now
          }
        }));
        const stableKeys = normalized.map(({ identity }) => identity.stableKey);
        const existingShops = normalized.length
          ? await transaction.shop.findMany({ where: { stableKey: { in: stableKeys } } })
          : [];
        const existingShopByKey = new Map(existingShops.map((shop) => [shop.stableKey, shop]));
        for (const { identity } of normalized) {
          const existing = existingShopByKey.get(identity.stableKey);
          if (existing?.myshopifyDomain && identity.myshopifyDomain &&
              existing.myshopifyDomain !== identity.myshopifyDomain) {
            throw new Error("Conflicting verified MyShopify identities cannot be merged");
          }
        }
        const shopInputs = normalized.map(({ identity }) => ({
          id: shopIdForStableKey(identity.stableKey),
          ...identity
        }));
        const shops = await bulkUpsertShops(transaction, shopInputs, now);
        if (shops.length !== normalized.length) {
          throw new Error("Conflicting verified MyShopify identities cannot be merged");
        }
        const shopByKey = new Map(shops.map((shop) => [shop.stableKey, shop]));
        const runStoreInputs = normalized.map(({ identity, candidatePayload }) => {
          const shop = shopByKey.get(identity.stableKey);
          if (!shop) throw new Error("Bulk shop checkpoint did not return every stable identity");
          return {
            id: runStoreId(runIdentifier, shop.id),
            runId: runIdentifier,
            shopId: shop.id,
            state: "discovered",
            candidatePayload
          };
        });
        const shopIds = runStoreInputs.map(({ shopId }) => shopId);
        const existingRunStores = normalized.length
          ? await transaction.runStore.findMany({
              where: { runId: runIdentifier, shopId: { in: shopIds } }
            })
          : [];
        const expectedByShopId = new Map(
          runStoreInputs.map((row) => [row.shopId, row.candidatePayload])
        );
        for (const existing of existingRunStores) {
          if (canonicalJson(existing.candidatePayload) !==
              canonicalJson(expectedByShopId.get(existing.shopId))) {
            throw new Error("Conflicting run-store replay cannot overwrite durable provenance");
          }
        }
        if (runStoreInputs.length) {
          await transaction.runStore.createMany({
            data: runStoreInputs,
            skipDuplicates: true
          });
        }
        const durableRunStores = runStoreInputs.length
          ? await transaction.runStore.findMany({
              where: { runId: runIdentifier, shopId: { in: shopIds } }
            })
          : [];
        if (durableRunStores.length !== runStoreInputs.length) {
          throw new Error("Bulk run-store checkpoint did not persist every store");
        }
        for (const durable of durableRunStores) {
          if (canonicalJson(durable.candidatePayload) !==
              canonicalJson(expectedByShopId.get(durable.shopId))) {
            throw new Error("Conflicting run-store replay cannot overwrite durable provenance");
          }
        }
        const writtenDiagnostics = await bulkUpsertDiagnostics(transaction, diagnosticRows);
        if (writtenDiagnostics.length !== diagnosticRows.length) {
          throw new Error("Bulk store diagnostics were not reconciled");
        }
        return durableRunStores
          .map((runStore) => ({
            ...runStore,
            shop: shops.find(({ id }) => id === runStore.shopId)
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
      });
    } catch (error) {
      if (retryAfterConflict && isUniqueConstraint(error)) {
        return this.saveDiscoveredStores(
          runIdentifier, lease, normalized, diagnostics, status, now, false
        );
      }
      throw error;
    }
  }

  async listRunStoresForProcessing(runIdentifier, lease, limit = 100, now = new Date()) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Run-store processing limit is invalid");
    }
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const rows = await transaction.runStore.findMany({
        where: { runId: runIdentifier, state: { in: ["discovered", "processing"] } },
        include: { shop: true },
        orderBy: { id: "asc" },
        take: limit
      });
      return rows.map((row) => ({
        ...row,
        candidatePayload: parseRunStoreCandidate(row.candidatePayload)
      }));
    });
  }

  async claimRunStore(runIdentifier, lease, runStoreIdentifier, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const claimed = await transaction.runStore.updateMany({
        where: {
          id: runStoreIdentifier,
          runId: runIdentifier,
          state: { in: ["discovered", "processing"] }
        },
        data: { state: "processing", safeErrorCode: null, safeErrorMessage: null }
      });
      const row = await transaction.runStore.findFirst({
        where: { id: runStoreIdentifier, runId: runIdentifier },
        include: { shop: true }
      });
      if (!row) throw new Error("Run store does not exist for this run");
      return {
        outcome: claimed.count === 1 ? "won" : row.state,
        owned: claimed.count === 1,
        runStore: {
          ...row,
          candidatePayload: parseRunStoreCandidate(row.candidatePayload)
        }
      };
    });
  }

  async claimAwsLeadWork(
    { runId: runIdentifier, generation, taskId, taskToken, shopId },
    now = new Date()
  ) {
    if (typeof shopId !== "string" || !/^shop_[A-Za-z0-9_-]{16,80}$/u.test(shopId))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const task = await transaction.pipelineTask.findUnique({ where: { id: taskId },
        include: { stage: { include: { run: true } } } });
      if (!task || task.leaseToken !== taskToken || task.itemKey !== shopId ||
          task.state !== "processing" || task.stage.stage !== "lead" ||
          task.stage.runId !== runIdentifier || task.stage.generation !== generation)
        throw new PipelineInvariantError("PIPELINE_LEASE_LOST");
      if (task.stage.run.state !== "running")
        return { outcome: task.stage.run.state === "cancelled" ? "cancelled" : "busy" };
      const key = { shopId_workType_scopeKey: { shopId, workType: "lead_discovery", scopeKey: "current" } };
      let work = await transaction.shopWork.findUnique({ where: key });
      if (!work) {
        work = await transaction.shopWork.create({ data: { id: shopWorkId(shopId, "lead_discovery", "current"),
          shopId, workType: "lead_discovery", scopeKey: "current", state: "processing",
          processingRunId: runIdentifier, processingLeaseToken: null,
          processingPipelineTaskId: taskId, startedAt: now } });
        return { outcome: "owned" };
      }
      if (work.state === "completed") {
        const profile = await transaction.shopLeadProfile.findUnique({ where: { shopId } });
        if (!profile || profile.state !== "completed" || profile.profilePayload == null) {
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        }
        const parsed = parseShopLeadProfile(profile.profilePayload);
        const shop = await transaction.shop.findUnique({ where: { id: shopId }, select: { stableKey: true } });
        if (!shop) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        assertProfileMatchesShop(parsed, shop.stableKey);
        return { outcome: "completed", profile: parsed };
      }
      if (work.state === "ambiguous") return { outcome: "ambiguous", safeErrorCode: work.safeErrorCode };
      if (work.state === "failed" && work.processingRunId === runIdentifier)
        return { outcome: "failed", safeErrorCode: work.safeErrorCode };
      if (work.state === "processing" && work.processingPipelineTaskId === taskId)
        return { outcome: "owned" };
      let active = false;
      if (work.state === "processing" && work.processingPipelineTaskId) {
        const ownerTask = await transaction.pipelineTask.findUnique({ where: { id: work.processingPipelineTaskId },
          include: { stage: { include: { run: { select: { state: true } } } } } });
        active = ownerTask?.stage?.run?.state === "running" && ownerTask.state !== "cancelled";
      } else if (work.state === "processing" && work.processingRunId) {
        const owner = await transaction.run.findUnique({ where: { id: work.processingRunId },
          select: { state: true, leaseToken: true, leaseExpiresAt: true } });
        active = owner?.state === "running" && owner.leaseToken === work.processingLeaseToken &&
          owner.leaseExpiresAt instanceof Date && owner.leaseExpiresAt > now;
      }
      if (active) return { outcome: "busy" };
      const replaced = await transaction.shopWork.updateMany({ where: { id: work.id,
        state: work.state, processingRunId: work.processingRunId,
        processingLeaseToken: work.processingLeaseToken,
        processingPipelineTaskId: work.processingPipelineTaskId }, data: { state: "processing",
        processingRunId: runIdentifier, processingLeaseToken: null,
        processingPipelineTaskId: taskId, safeErrorCode: null, safeErrorMessage: null,
        startedAt: now, completedAt: null } });
      return { outcome: replaced.count === 1 ? "owned" : "busy" };
    });
  }

  async claimAwsRunLease(
    { runId: runIdentifier, generation, owner, token, leaseDurationMs },
    now = new Date()
  ) {
    if (!Number.isInteger(generation) || generation < 1 ||
        typeof owner !== "string" || !owner || typeof token !== "string" || !token ||
        leaseDurationMs !== 60000) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const run = await transaction.run.findUnique({ where: { id: runIdentifier } });
      if (!run || run.executionBackend !== "aws" || run.pipelineGeneration !== generation)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      if (run.state !== "running") return { outcome: "cancelled" };
      if (run.leaseToken === token && run.leaseExpiresAt instanceof Date && run.leaseExpiresAt > now)
        return { outcome: "owned", lease: { owner: run.leaseOwner, token, attempt: run.leaseAttempt,
          expiresAt: run.leaseExpiresAt } };
      if (run.leaseToken && run.leaseExpiresAt instanceof Date && run.leaseExpiresAt > now)
        return { outcome: "busy" };
      const expiresAt = new Date(now.getTime() + leaseDurationMs);
      const claimed = await transaction.run.updateMany({ where: { id: runIdentifier,
        state: "running", pipelineGeneration: generation, leaseToken: run.leaseToken,
        leaseExpiresAt: run.leaseExpiresAt }, data: { leaseOwner: owner, leaseToken: token,
        leaseAcquiredAt: now, leaseExpiresAt: expiresAt, lastHeartbeatAt: now,
        leaseAttempt: { increment: 1 } } });
      if (claimed.count !== 1) return { outcome: "busy" };
      const durable = await transaction.run.findUnique({ where: { id: runIdentifier } });
      return { outcome: "owned", lease: { owner, token, attempt: durable.leaseAttempt, expiresAt } };
    });
  }

  async renewAwsRunLease(
    { runId: runIdentifier, generation, token, leaseDurationMs }, now = new Date()
  ) {
    if (leaseDurationMs !== 60000) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    const updated = await this.prisma.run.updateMany({ where: { id: runIdentifier,
      executionBackend: "aws", pipelineGeneration: generation, state: "running", leaseToken: token,
      leaseExpiresAt: { gt: now } }, data: { leaseExpiresAt: expiresAt, lastHeartbeatAt: now } });
    if (updated.count !== 1) throw new PipelineInvariantError("PIPELINE_LEASE_LOST");
    return { expiresAt };
  }

  async releaseAwsRunLease({ runId: runIdentifier, generation, token }, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const updated = await transaction.run.updateMany({ where: { id: runIdentifier,
        executionBackend: "aws", pipelineGeneration: generation, state: "running", leaseToken: token },
      data: { leaseOwner: null, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null,
        lastHeartbeatAt: now } });
      if (updated.count !== 1) throw new PipelineInvariantError("PIPELINE_LEASE_LOST");
      return { run: await transaction.run.findUnique({ where: { id: runIdentifier } }) };
    });
  }

  async loadAwsTrafficStage({ runId: runIdentifier, generation, runLease }, now = new Date()) {
    const loaded = await this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const run = await transaction.run.findUnique({ where: { id: runIdentifier } });
      if (!run || run.executionBackend !== "aws" || run.pipelineGeneration !== generation ||
          run.state !== "running" || run.leaseToken !== runLease?.token ||
          !(run.leaseExpiresAt instanceof Date) || run.leaseExpiresAt <= now)
        throw new PipelineInvariantError("PIPELINE_LEASE_LOST");
      const stage = await transaction.pipelineStage.findUnique({ where: {
        runId_stage_generation: { runId: runIdentifier, stage: "traffic_crux", generation } } });
      if (!stage || !["collecting", "ready", "aggregating"].includes(stage.state))
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const tasks = await transaction.pipelineTask.findMany({ where: { stageId: stage.id }, orderBy: { itemKey: "asc" } });
      if (tasks.length !== stage.expectedCount) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const leads = await transaction.lead.findMany({ where: { runId: runIdentifier, status: "qualified" },
        orderBy: [{ shopId: "asc" }, { id: "asc" }] });
      return { run, stage, tasks, leads };
    });
    return { ...loaded, run: { ...loaded.run,
      trafficEnrichmentConfig: parseTrafficRunConfig(loaded.run.trafficEnrichmentConfig),
      awsProviderConfig: parseAwsProviderConfig(loaded.run.awsProviderConfig) } };
  }

  async claimAwsTrafficWorkBatch(
    { runId: runIdentifier, generation, runLease, claims }, now = new Date()
  ) {
    const normalized = requireBoundedBatch("AWS traffic work claims", claims, DATAFORSEO_TARGET_LIMIT)
      .map((claim) => {
        const selection = claim?.selection;
        const source = selection?.source;
        const workType = source === "dataforseo" ? "dataforseo" :
          source === "crux_rest" ? "crux_rest" : source === "crux_bigquery" ? "crux_bigquery" : null;
        if (!workType || selection.reuse != null || typeof claim?.shopId !== "string" ||
            typeof claim?.pipelineTaskId !== "string" || typeof selection.identity !== "string" ||
            typeof selection.scopeKey !== "string" || typeof selection.metricSetKey !== "string" ||
            typeof selection.contractVersion !== "string")
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        return { ...claim, workType, scopeKey: selection.scopeKey,
          id: shopWorkId(claim.shopId, workType, selection.scopeKey) };
      });
    requireUniqueBatchKeys("AWS traffic work claims", normalized, (value) => value.id);
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const run = await transaction.run.findUnique({ where: { id: runIdentifier } });
      if (!run || run.executionBackend !== "aws" || run.pipelineGeneration !== generation ||
          run.state !== "running" || run.leaseToken !== runLease?.token ||
          !(run.leaseExpiresAt instanceof Date) || run.leaseExpiresAt <= now)
        throw new PipelineInvariantError("PIPELINE_LEASE_LOST");
      const stage = await transaction.pipelineStage.findUnique({ where: {
        runId_stage_generation: { runId: runIdentifier, stage: "traffic_crux", generation } } });
      if (!stage) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const taskIds = normalized.map(({ pipelineTaskId }) => pipelineTaskId);
      const tasks = await transaction.pipelineTask.findMany({ where: { id: { in: taskIds }, stageId: stage.id } });
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      if (tasks.length !== normalized.length || normalized.some((claim) =>
        taskById.get(claim.pipelineTaskId)?.itemKey !== claim.shopId))
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      await transaction.shopWork.createMany({ data: normalized.map((claim) => ({ id: claim.id,
        shopId: claim.shopId, workType: claim.workType, scopeKey: claim.scopeKey, state: "pending" })),
      skipDuplicates: true });
      const rows = normalized.length ? await transaction.$queryRaw`
        WITH input AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(normalized.map((claim, ordinal) =>
            ({ id: claim.id, ordinal })))}::jsonb) AS value("id" text, "ordinal" integer)
        )
        SELECT work.*, input."ordinal"
        FROM input JOIN "ShopWork" work ON work."id" = input."id"
        ORDER BY input."ordinal" ASC
        FOR UPDATE OF work
      ` : [];
      if (rows.length !== normalized.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (byId.size !== normalized.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const completedClaims = normalized.filter(({ id }) => byId.get(id)?.state === "completed");
      const cacheSelections = [...new Map(completedClaims.map(({ selection }) =>
        [[selection.source, selection.identity, selection.scopeKey, selection.metricSetKey,
          selection.contractVersion].join("\0"), selection])).values()];
      const cacheRows = cacheSelections.length ? await transaction.trafficEnrichmentCache.findMany({
        where: { OR: cacheSelections.map((selection) => ({ source: selection.source,
          identity: selection.identity, scopeKey: selection.scopeKey,
          metricSetKey: selection.metricSetKey, contractVersion: selection.contractVersion })) }
      }) : [];
      const cacheByKey = new Map();
      for (const row of cacheRows) {
        const key = [row.source, row.identity, row.scopeKey, row.metricSetKey,
          row.contractVersion].join("\0");
        const values = cacheByKey.get(key) || [];
        values.push(row);
        cacheByKey.set(key, values);
      }
      const taskOwnerIds = [...new Set(rows.filter((row) => row.processingPipelineTaskId)
        .map((row) => row.processingPipelineTaskId))];
      const taskOwners = taskOwnerIds.length ? await transaction.pipelineTask.findMany({
        where: { id: { in: taskOwnerIds } }, include: { stage: { include: { run: { select: { state: true } } } } }
      }) : [];
      const taskOwnerById = new Map(taskOwners.map((owner) => [owner.id, owner]));
      const legacyRunIds = [...new Set(rows.filter((row) => !row.processingPipelineTaskId && row.processingRunId)
        .map((row) => row.processingRunId))];
      const legacyRuns = legacyRunIds.length ? await transaction.run.findMany({
        where: { id: { in: legacyRunIds } }
      }) : [];
      const legacyRunById = new Map(legacyRuns.map((owner) => [owner.id, owner]));
      const output = [];
      const reclaimable = [];
      for (const claim of normalized) {
        const work = byId.get(claim.id);
        if (!work) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        if (work.state === "completed") {
          const key = claim.selection;
          const matching = cacheByKey.get([key.source, key.identity, key.scopeKey,
            key.metricSetKey, key.contractVersion].join("\0")) || [];
          if (matching.length > 1) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          if (matching.length === 1) {
            const row = matching[0];
            if (!(row.fetchedAt instanceof Date) || row.fetchedAt > now ||
                !(row.expiresAt instanceof Date)) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
            if (row.expiresAt > now) { output.push({ shopId: claim.shopId, workType: claim.workType,
              scopeKey: claim.scopeKey, pipelineTaskId: claim.pipelineTaskId, outcome: "completed",
              cacheRows: [row] }); continue; }
          }
        }
        if (work.state === "ambiguous") { output.push({ shopId: claim.shopId, workType: claim.workType,
          scopeKey: claim.scopeKey, pipelineTaskId: claim.pipelineTaskId, outcome: "ambiguous" }); continue; }
        if (work.state === "processing" && work.processingPipelineTaskId === claim.pipelineTaskId) {
          output.push({ shopId: claim.shopId, workType: claim.workType, scopeKey: claim.scopeKey,
            pipelineTaskId: claim.pipelineTaskId, outcome: "owned" }); continue;
        }
        let active = false;
        if (work.state === "processing" && work.processingPipelineTaskId) {
          const ownerTask = taskOwnerById.get(work.processingPipelineTaskId);
          active = ownerTask?.stage?.run?.state === "running" && ownerTask.state !== "cancelled";
        } else if (work.state === "processing" && work.processingRunId) {
          const owner = legacyRunById.get(work.processingRunId);
          active = owner?.state === "running" && owner.leaseToken === work.processingLeaseToken &&
            owner.leaseExpiresAt instanceof Date && owner.leaseExpiresAt > now;
        }
        if (active) { output.push({ shopId: claim.shopId, workType: claim.workType, scopeKey: claim.scopeKey,
          pipelineTaskId: claim.pipelineTaskId, outcome: "busy" }); continue; }
        reclaimable.push({ id: work.id, state: work.state, processingRunId: work.processingRunId,
          processingLeaseToken: work.processingLeaseToken,
          processingPipelineTaskId: work.processingPipelineTaskId, pipelineTaskId: claim.pipelineTaskId });
        output.push({ shopId: claim.shopId, workType: claim.workType, scopeKey: claim.scopeKey,
          pipelineTaskId: claim.pipelineTaskId, outcome: "pending_cas", workId: work.id });
      }
      const wonRows = reclaimable.length ? await transaction.$queryRaw`
        WITH input AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(reclaimable)}::jsonb) AS value(
            "id" text, "state" text, "processingRunId" text, "processingLeaseToken" text,
            "processingPipelineTaskId" text, "pipelineTaskId" text
          )
        )
        UPDATE "ShopWork" AS work SET
          "state" = 'processing'::"ShopWorkState", "processingRunId" = ${runIdentifier},
          "processingLeaseToken" = NULL, "processingPipelineTaskId" = input."pipelineTaskId",
          "safeErrorCode" = NULL, "safeErrorMessage" = NULL, "startedAt" = ${now},
          "completedAt" = NULL, "updatedAt" = ${now}
        FROM input
        WHERE work."id" = input."id" AND work."state" = input."state"::"ShopWorkState"
          AND work."processingRunId" IS NOT DISTINCT FROM input."processingRunId"
          AND work."processingLeaseToken" IS NOT DISTINCT FROM input."processingLeaseToken"
          AND work."processingPipelineTaskId" IS NOT DISTINCT FROM input."processingPipelineTaskId"
        RETURNING work."id"
      ` : [];
      const wonIds = new Set(wonRows.map(({ id }) => id));
      if (wonIds.size !== wonRows.length || wonRows.some(({ id }) => !reclaimable.some((row) => row.id === id)))
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      return output.map(({ workId, ...item }) => item.outcome === "pending_cas"
        ? { ...item, outcome: wonIds.has(workId) ? "owned" : "busy" }
        : item);
    });
  }

  async recordAwsDataForSeoOutcome(runIdentifier, runLease, outcome, now = new Date()) {
    if (!outcome || !["succeeded", "failed", "ambiguous"].includes(outcome.outcome))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({ where: activeLeaseWhere(
        runIdentifier, runLease, now), data: { lastHeartbeatAt: now } }));
      const ledger = await transaction.dataForSeoRequestLedger.findUnique({ where: {
        requestFingerprint: outcome.requestFingerprint } });
      if (!ledger || ledger.runId !== runIdentifier || ledger.targetCount !== outcome.targetCount ||
          ledger.scopeKey !== outcome.scopeKey) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      if (ledger.state === outcome.outcome) {
        if (outcome.outcome === "succeeded" && (ledger.resultFingerprint !== outcome.resultFingerprint ||
            Number(ledger.providerCostUsd) !== outcome.providerCostUsd))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        return { ledger };
      }
      if (ledger.state !== "in_flight") throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      if (outcome.outcome === "succeeded" && (!/^[a-f0-9]{64}$/u.test(outcome.resultFingerprint) ||
          !Number.isFinite(outcome.providerCostUsd) || outcome.providerCostUsd < 0))
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      if (outcome.outcome === "failed" && !["DATAFORSEO_NOT_DISPATCHED", "DATAFORSEO_ZERO_COST_REJECTION"]
        .includes(outcome.safeErrorCode)) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const updated = await transaction.dataForSeoRequestLedger.update({ where: {
        requestFingerprint: outcome.requestFingerprint }, data: { state: outcome.outcome,
        providerCostUsd: outcome.outcome === "succeeded" ? outcome.providerCostUsd : null,
        resultFingerprint: outcome.outcome === "succeeded" ? outcome.resultFingerprint : null,
        safeErrorCode: outcome.safeErrorCode ?? null, reservationCostUsd: null,
        ambiguousAfter: null, completedAt: now } });
      return { ledger: updated };
    });
  }

  async readAwsFinalReuseRows(input) {
    if (!(input.evaluatedAt instanceof Date) || !Array.isArray(input.selections))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      await assertCompleteAggregatorInTransaction(transaction, { runId: input.runId,
        stage: "traffic_crux", generation: input.generation, token: input.aggregationToken }, new Date());
      const selections = [...input.selections].sort((a, b) => a.cacheId.localeCompare(b.cacheId));
      requireUniqueBatchKeys("AWS final reuse selections", selections, ({ cacheId }) => cacheId);
      const trafficRows = selections.length ? await transaction.trafficEnrichmentCache.findMany({
        where: { id: { in: selections.map(({ cacheId }) => cacheId) } }, orderBy: { id: "asc" } }) : [];
      if (trafficRows.length !== selections.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const byId = new Map(selections.map((selection) => [selection.cacheId, selection]));
      for (const row of trafficRows) {
        const selection = byId.get(row.id);
        const parsed = trafficCacheRecordToUpsert(row.id, row);
        if (!selection || row.source !== selection.source || row.identity !== selection.identity ||
            row.scopeKey !== selection.scopeKey || row.metricSetKey !== selection.metricSetKey ||
            row.contractVersion !== selection.contractVersion || row.fetchedAt > input.evaluatedAt ||
            row.expiresAt <= input.evaluatedAt || fingerprintJson(parsed) !== selection.cacheFingerprint)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const leadStage = await transaction.pipelineStage.findUnique({ where: { runId_stage_generation: {
        runId: input.runId, stage: "lead", generation: input.generation } } });
      if (!leadStage || leadStage.state !== "completed") throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const leadTasks = await transaction.pipelineTask.findMany({ where: { stageId: leadStage.id },
        orderBy: [{ itemKey: "asc" }, { id: "asc" }] });
      if (leadTasks.length !== leadStage.expectedCount || leadTasks.some(({ state }) =>
        !["succeeded", "failed", "skipped"].includes(state))) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      return { trafficRows, leadStage, leadTasks };
    });
  }

  async readAwsAmbiguousDataForSeoTargets(input) {
    if (!Array.isArray(input?.candidates)) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    const candidates = input.candidates.map((candidate, ordinal) => ({ ...candidate, ordinal }));
    requireUniqueBatchKeys("AWS ambiguous DataForSEO candidates", candidates,
      ({ shopId, scopeKey }) => `${shopId}\0${scopeKey}`);
    if (candidates.some(({ shopId, identity, scopeKey }) => typeof shopId !== "string" || !shopId ||
        typeof identity !== "string" || !identity || typeof scopeKey !== "string" || !scopeKey))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const owned = await assertCompleteAggregatorInTransaction(transaction, { runId: input.runId,
        stage: "traffic_crux", generation: input.generation, token: input.aggregationToken }, new Date());
      const taskByShop = new Map(owned.tasks.map((task) => [task.itemKey, task]));
      const rows = candidates.length ? await transaction.$queryRaw`
        WITH input AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb) AS value(
            "shopId" text, "identity" text, "scopeKey" text, "ordinal" integer
          )
        )
        SELECT input."shopId", input."identity", input."scopeKey", input."ordinal",
          work."processingRunId", work."processingPipelineTaskId"
        FROM input JOIN "ShopWork" work
          ON work."shopId" = input."shopId"
          AND work."workType" = 'dataforseo'::"ShopWorkType"
          AND work."scopeKey" = input."scopeKey"
        WHERE work."state" = 'ambiguous'::"ShopWorkState"
        ORDER BY input."ordinal" ASC
      ` : [];
      const selected = [];
      for (const row of rows) {
        if (row.processingRunId !== input.runId) continue;
        const task = taskByShop.get(row.shopId);
        if (!task || row.processingPipelineTaskId !== task.id)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        selected.push({ shopId: row.shopId, identity: row.identity, scopeKey: row.scopeKey });
      }
      return selected;
    });
  }

  async readAwsAmbiguousCruxBigQueryWork(input) {
    if (!Array.isArray(input?.candidates)) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    const candidates = input.candidates.map((candidate, ordinal) => ({ ...candidate, ordinal }));
    requireUniqueBatchKeys("AWS ambiguous CrUX BigQuery candidates", candidates, ({ shopId }) => shopId);
    if (candidates.some(({ shopId, pipelineTaskId, state }) => typeof shopId !== "string" || !shopId ||
        typeof pipelineTaskId !== "string" || !pipelineTaskId || state !== "ambiguous"))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const owned = await assertCompleteAggregatorInTransaction(transaction, { runId: input.runId,
        stage: "traffic_crux", generation: input.generation, token: input.aggregationToken }, new Date());
      const taskByShop = new Map(owned.tasks.map((task) => [task.itemKey, task]));
      for (const candidate of candidates) if (taskByShop.get(candidate.shopId)?.id !== candidate.pipelineTaskId)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const rows = candidates.length ? await transaction.$queryRaw`
        WITH input AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb) AS value(
            "shopId" text, "pipelineTaskId" text, "state" text, "ordinal" integer
          )
        )
        SELECT input."shopId", input."pipelineTaskId", input."state", input."ordinal", work."scopeKey"
        FROM input JOIN "ShopWork" work
          ON work."shopId" = input."shopId"
          AND work."workType" = 'crux_bigquery'::"ShopWorkType"
          AND work."state" = 'processing'::"ShopWorkState"
          AND work."processingRunId" = ${input.runId}
          AND work."processingPipelineTaskId" = input."pipelineTaskId"
        ORDER BY input."ordinal" ASC, work."scopeKey" ASC
      ` : [];
      const counts = new Map();
      for (const row of rows) {
        if (!/^month:20\d{4}$/u.test(row.scopeKey))
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        counts.set(row.shopId, (counts.get(row.shopId) || 0) + 1);
      }
      if ([...counts.values()].some((count) => count !== 1))
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      return rows.map(({ ordinal: _ordinal, ...row }) => row);
    });
  }

  async publishAwsFinalResults(input, now = new Date(), { afterStep = async () => {} } = {}) {
    if (typeof afterStep !== "function" || !Array.isArray(input.dataForSeoLedgerEvidence))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    await afterStep("input_shape_validated");
    const ledgerEvidence = [...input.dataForSeoLedgerEvidence];
    requireUniqueBatchKeys("AWS final DataForSEO ledger evidence", ledgerEvidence,
      ({ requestFingerprint }) => requestFingerprint);
    if (ledgerEvidence.some((entry, index) => !/^[a-f0-9]{64}$/u.test(entry.requestFingerprint) ||
        !Number.isInteger(entry.targetCount) || entry.targetCount < 1 || entry.targetCount > 1000 ||
        !["succeeded", "failed", "ambiguous"].includes(entry.state) ||
        (entry.state === "succeeded") !== /^[a-f0-9]{64}$/u.test(entry.resultFingerprint || "") ||
        (index > 0 && entry.requestFingerprint <= ledgerEvidence[index - 1].requestFingerprint)))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    await afterStep("ledger_evidence_validated");
    const cacheRows = input.cacheRows.map((row) => trafficCacheRecordToUpsert(cacheId(row), row));
    const trafficRows = input.leadTrafficRows.map((row) => leadTrafficEnrichmentRecordToCreate(
      childId("lead_traffic", input.runId, `${row.leadId}:${row.source}`), input.runId, row.leadId, row));
    requireUniqueBatchKeys("AWS final cache rows", cacheRows,
      (row) => `${row.source}:${row.identity}:${row.scopeKey}:${row.metricSetKey}:${row.contractVersion}`);
    requireUniqueBatchKeys("AWS final traffic rows", trafficRows, (row) => `${row.leadId}:${row.source}`);
    requireUniqueBatchKeys("AWS final work outcomes", input.workOutcomes || [],
      (row) => `${row.shopId}\0${row.workType}\0${row.scopeKey}`);
    requireUniqueBatchKeys("AWS final lead profile outcomes", input.leadProfileOutcomes,
      (row) => row.shopId);
    await afterStep("publication_input_validated");
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const owned = await assertCompleteAggregatorInTransaction(transaction, { runId: input.runId,
        stage: "traffic_crux", generation: input.generation, token: input.aggregationToken }, now);
      if (owned.run.resultsAvailable) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      await afterStep("publication_ownership_validated");
      const ledgers = await transaction.$queryRaw`
        SELECT "runId", "requestFingerprint", "scopeKey", "targetCount", "state", "resultFingerprint"
        FROM "DataForSeoRequestLedger" WHERE "runId" = ${input.runId}
        ORDER BY "requestFingerprint" ASC FOR UPDATE
      `;
      if (ledgers.length !== ledgerEvidence.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      for (let index = 0; index < ledgers.length; index += 1) {
        const row = ledgers[index]; const evidence = ledgerEvidence[index];
        if (row.runId !== input.runId || row.requestFingerprint !== evidence.requestFingerprint ||
            row.scopeKey !== evidence.scopeKey || row.targetCount !== evidence.targetCount ||
            row.state !== evidence.state || (row.resultFingerprint ?? null) !== evidence.resultFingerprint)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      await afterStep("ledger_rows_validated");
      const writtenCache = await bulkUpsertTrafficCache(transaction, cacheRows, now);
      if (writtenCache.length !== cacheRows.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      await afterStep("cache_written");
      const writtenTraffic = await bulkUpsertLeadTraffic(transaction, trafficRows);
      if (writtenTraffic.length !== trafficRows.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      await afterStep("traffic_written");
      const workOutcomes = input.workOutcomes || [];
      const lockedWork = workOutcomes.length ? await transaction.$queryRaw`
        WITH input AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(workOutcomes.map((outcome, ordinal) =>
            ({ shopId: outcome.shopId, workType: outcome.workType, scopeKey: outcome.scopeKey, ordinal })))}::jsonb)
            AS value("shopId" text, "workType" text, "scopeKey" text, "ordinal" integer)
        )
        SELECT work.*, input."ordinal" FROM input JOIN "ShopWork" work
          ON work."shopId" = input."shopId"
          AND work."workType" = input."workType"::"ShopWorkType"
          AND work."scopeKey" = input."scopeKey"
        ORDER BY input."ordinal" ASC FOR UPDATE OF work
      ` : [];
      if (lockedWork.length !== workOutcomes.length)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const mutableWork = [];
      for (let index = 0; index < workOutcomes.length; index += 1) {
        const outcome = workOutcomes[index];
        const targetState = ["available", "no_coverage"].includes(outcome.state) ? "completed" :
          outcome.state === "ambiguous" ? "ambiguous" : outcome.state === "reused" ? "reused" : "failed";
        const work = lockedWork[index];
        if (!work) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        if (targetState === "reused") {
          if (work.state !== "completed") throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          continue;
        }
        if (work.state === targetState) continue;
        if (work.state !== "processing" || work.processingRunId !== input.runId ||
            work.processingPipelineTaskId !== outcome.pipelineTaskId)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        mutableWork.push({ id: work.id, pipelineTaskId: outcome.pipelineTaskId, targetState,
          safeErrorCode: targetState === "completed" ? null : targetState === "ambiguous"
            ? "WORK_OUTCOME_AMBIGUOUS" : "PIPELINE_PROVIDER_UNAVAILABLE",
          safeErrorMessage: targetState === "completed" ? null : targetState === "ambiguous"
            ? "WORK_OUTCOME_AMBIGUOUS" : "PIPELINE_PROVIDER_UNAVAILABLE" });
      }
      const settledWork = mutableWork.length ? await transaction.$queryRaw`
        WITH input AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(mutableWork)}::jsonb) AS value(
            "id" text, "pipelineTaskId" text, "targetState" text,
            "safeErrorCode" text, "safeErrorMessage" text
          )
        )
        UPDATE "ShopWork" work SET "state" = input."targetState"::"ShopWorkState",
          "completedAt" = ${now}, "safeErrorCode" = input."safeErrorCode",
          "safeErrorMessage" = input."safeErrorMessage", "updatedAt" = ${now}
        FROM input WHERE work."id" = input."id" AND work."state" = 'processing'::"ShopWorkState"
          AND work."processingRunId" = ${input.runId}
          AND work."processingPipelineTaskId" = input."pipelineTaskId"
        RETURNING work."id"
      ` : [];
      if (settledWork.length !== mutableWork.length ||
          new Set(settledWork.map(({ id }) => id)).size !== mutableWork.length)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      await afterStep("work_settled");
      const parsedProfiles = new Map(input.leadProfileOutcomes.filter(({ state }) => state === "new")
        .map((outcome) => {
          const profile = parseShopLeadProfile(outcome.profile);
          if (fingerprintJson(profile) !== outcome.profileFingerprint)
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          return [outcome.shopId, profile];
        }));
      const profileShopIds = input.leadProfileOutcomes.filter(({ state }) => state !== "failed")
        .map(({ shopId }) => shopId);
      const existingProfiles = profileShopIds.length ? await transaction.$queryRaw`
        SELECT profile.* FROM "ShopLeadProfile" profile
        WHERE profile."shopId" IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(profileShopIds)}::jsonb))
        FOR UPDATE
      ` : [];
      const existingProfileByShop = new Map(existingProfiles.map((profile) => [profile.shopId, profile]));
      const existingProfileFingerprintByShop = new Map(existingProfiles.map((profile) => [profile.shopId,
        profile.state === "completed" ? fingerprintJson(parseShopLeadProfile(profile.profilePayload)) : null]));
      const workProfileOutcomes = input.leadProfileOutcomes.filter(({ state }) => state !== "existing");
      const profileWorkRows = workProfileOutcomes.length ? await transaction.$queryRaw`
        WITH input AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(workProfileOutcomes.map(({ shopId }, ordinal) =>
            ({ shopId, ordinal })))}::jsonb) AS value("shopId" text, "ordinal" integer)
        )
        SELECT work.*, input."ordinal" FROM input JOIN "ShopWork" work
          ON work."shopId" = input."shopId"
          AND work."workType" = 'lead_discovery'::"ShopWorkType" AND work."scopeKey" = 'current'
        ORDER BY input."ordinal" FOR UPDATE OF work
      ` : [];
      if (profileWorkRows.length !== workProfileOutcomes.length)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const profileWorkByShop = new Map(workProfileOutcomes.map((outcome, index) =>
        [outcome.shopId, profileWorkRows[index]]));
      const missingProfiles = [];
      const profileWorkUpdates = [];
      for (let index = 0; index < input.leadProfileOutcomes.length; index += 1) {
        const outcome = input.leadProfileOutcomes[index];
        const existingProfile = existingProfileByShop.get(outcome.shopId);
        if (outcome.state === "new") {
          if (existingProfile && (existingProfile.state !== "completed" ||
              existingProfileFingerprintByShop.get(outcome.shopId) !== outcome.profileFingerprint))
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          if (!existingProfile) missingProfiles.push({ shopId: outcome.shopId, state: "completed",
            profilePayload: parsedProfiles.get(outcome.shopId), processingRunId: null,
            safeErrorCode: null, safeErrorMessage: null });
          const work = profileWorkByShop.get(outcome.shopId);
          if (work.state !== "completed" && (work.state !== "processing" ||
              work.processingRunId !== input.runId || work.processingPipelineTaskId !== outcome.sourceTaskId))
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          if (work.state === "processing") profileWorkUpdates.push({ id: work.id,
            pipelineTaskId: outcome.sourceTaskId, targetState: "completed", safeErrorCode: null,
            safeErrorMessage: null });
        } else if (outcome.state === "existing") {
          if (!existingProfile || existingProfile.state !== "completed" ||
              existingProfileFingerprintByShop.get(outcome.shopId) !== outcome.profileFingerprint)
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
        } else if (outcome.state === "failed") {
          const work = profileWorkByShop.get(outcome.shopId);
          if (!work || (work.state === "processing" && (work.processingRunId !== input.runId ||
              work.processingPipelineTaskId !== outcome.sourceTaskId)))
            throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
          if (work.state === "processing") profileWorkUpdates.push({ id: work.id,
            pipelineTaskId: outcome.sourceTaskId, targetState: "failed",
            safeErrorCode: "LEAD_DISCOVERY_FAILED", safeErrorMessage: "LEAD_DISCOVERY_FAILED" });
        }
      }
      if (missingProfiles.length) await transaction.shopLeadProfile.createMany({ data: missingProfiles,
        skipDuplicates: true });
      const requiredProfiles = profileShopIds.length ? await transaction.shopLeadProfile.findMany({
        where: { shopId: { in: profileShopIds } }
      }) : [];
      const requiredProfileByShop = new Map(requiredProfiles.map((profile) => [profile.shopId, profile]));
      for (const outcome of input.leadProfileOutcomes.filter(({ state }) => state !== "failed")) {
        const profile = requiredProfileByShop.get(outcome.shopId);
        const verifiedFingerprint = existingProfileFingerprintByShop.get(outcome.shopId) ||
          (profile ? fingerprintJson(parseShopLeadProfile(profile.profilePayload)) : null);
        if (!profile || profile.state !== "completed" || verifiedFingerprint !== outcome.profileFingerprint)
          throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      }
      const linked = profileShopIds.length ? await transaction.$queryRaw`
        UPDATE "Lead" lead SET "shopLeadProfileId" = input."shopId"
        FROM jsonb_to_recordset(${JSON.stringify(profileShopIds.map((shopId) => ({ shopId })))}::jsonb)
          AS input("shopId" text)
        WHERE lead."runId" = ${input.runId} AND lead."shopId" = input."shopId"
        RETURNING lead."shopId"
      ` : [];
      if (linked.length !== profileShopIds.length ||
          new Set(linked.map(({ shopId }) => shopId)).size !== profileShopIds.length)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      const settledProfiles = profileWorkUpdates.length ? await transaction.$queryRaw`
        WITH input AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(profileWorkUpdates)}::jsonb) AS value(
            "id" text, "pipelineTaskId" text, "targetState" text,
            "safeErrorCode" text, "safeErrorMessage" text
          )
        )
        UPDATE "ShopWork" work SET "state" = input."targetState"::"ShopWorkState",
          "completedAt" = ${now}, "safeErrorCode" = input."safeErrorCode",
          "safeErrorMessage" = input."safeErrorMessage", "updatedAt" = ${now}
        FROM input WHERE work."id" = input."id" AND work."state" = 'processing'::"ShopWorkState"
          AND work."processingRunId" = ${input.runId}
          AND work."processingPipelineTaskId" = input."pipelineTaskId"
        RETURNING work."id"
      ` : [];
      if (settledProfiles.length !== profileWorkUpdates.length)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      await afterStep("profiles_settled");
      const diagnosticRows = (input.diagnostics || []).map(({ value }, index) => diagnosticRecordToCreate(
        input.runId, childId("diag", input.runId, `aws-traffic:${2_000_000 + index}`), 2_000_000 + index, value));
      if ((await bulkUpsertDiagnostics(transaction, diagnosticRows)).length !== diagnosticRows.length)
        throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      await afterStep("diagnostics_written");
      const scoredLeads = [];
      const scoringVersion = await finalizePersistedLeadScoresV3(transaction, input.runId, owned.run,
        { captureLeads: scoredLeads });
      await afterStep("scores_finalized");
      const leads = scoredLeads.length ? scoredLeads : await transaction.lead.findMany({
        where: { runId: input.runId }, orderBy: { id: "asc" } });
      const leadSummary = leads.reduce((summary, lead) => { summary.total += 1;
        if (lead.status in summary) summary[lead.status] += 1; return summary; },
      { total: 0, qualified: 0, rejected: 0, failed: 0 });
      await grantRunShopsToOwner(transaction, input.runId, leads, now);
      await afterStep("grants_written");
      const audits = await transaction.queryAudit.findMany({ where: { runId: input.runId },
        orderBy: [{ sequence: "asc" }, { id: "asc" }] });
      const diagnostics = await transaction.runDiagnostic.findMany({ where: { runId: input.runId },
        orderBy: [{ sequence: "asc" }, { id: "asc" }] });
      const durableTraffic = await transaction.leadTrafficEnrichment.findMany({ where: { runId: input.runId },
        orderBy: [{ leadId: "asc" }, { source: "asc" }] });
      const resultFingerprint = fingerprintJson({ contractVersion: "aws-final-publication-v1",
        runId: input.runId, generation: input.generation, leads, trafficEnrichments: durableTraffic,
        queryAudits: audits, diagnostics, leadSummary,
        trafficSummary: input.trafficSummary, pipelineVersion: 2, scoringVersion });
      await completeAggregatorInTransaction(transaction, { stageId: input.stageId,
        token: input.aggregationToken, state: "completed" }, now);
      await afterStep("stage_completed");
      await afterStep("before_run_visibility");
      const updated = await transaction.run.updateMany({ where: { id: input.runId, state: "running",
        executionBackend: "aws", pipelineGeneration: input.generation, resultsAvailable: false }, data: {
        state: "completed", phase: "finished", stage: "completed", completedAt: now,
        resultsAvailable: true, leadSummary, trafficEnrichmentSummary: input.trafficSummary, pipelineVersion: 2,
        scoringVersion, resultFingerprint, safeErrorCode: null, safeErrorMessage: null,
        leaseOwner: null, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null, lastHeartbeatAt: null } });
      if (updated.count !== 1) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
      return { run: await transaction.run.findUnique({ where: { id: input.runId } }),
        stage: await transaction.pipelineStage.findUnique({ where: { id: input.stageId } }), resultFingerprint };
    }, { maxWait: 5_000, timeout: 15_000 });
  }

  async claimShopWork(
    runIdentifier,
    lease,
    shopId,
    workType,
    scopeKey,
    now = new Date(),
    retryAfterConflict = true
  ) {
    requireShopWorkKey(workType, scopeKey);
    if (typeof shopId !== "string" || !/^shop_[A-Za-z0-9_-]{16,80}$/u.test(shopId)) {
      throw new Error("Shop work shop ID is invalid");
    }
    const identifier = shopWorkId(shopId, workType, scopeKey);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        requireLeaseMutation(await transaction.run.updateMany({
          where: activeLeaseWhere(runIdentifier, lease, now),
          data: { lastHeartbeatAt: now }
        }));
        let current = await transaction.shopWork.findUnique({
          where: { shopId_workType_scopeKey: { shopId, workType, scopeKey } }
        });
        if (!current) {
          current = await transaction.shopWork.create({
            data: {
              id: identifier,
              shopId,
              workType,
              scopeKey,
              state: "processing",
              processingRunId: runIdentifier,
              processingLeaseToken: lease.token,
              startedAt: now
            }
          });
          if (workType === "lead_discovery") {
            await transaction.shopLeadProfile.upsert({
              where: { shopId },
              create: { shopId, state: "processing", processingRunId: runIdentifier },
              update: {
                state: "processing",
                processingRunId: runIdentifier,
                safeErrorCode: null,
                safeErrorMessage: null
              }
            });
          }
          return { outcome: "won", networkAllowed: true, work: current };
        }
        if (current.state === "completed") {
          return { outcome: "completed", networkAllowed: false, work: current };
        }
        if (current.state === "ambiguous") {
          return { outcome: "ambiguous", networkAllowed: false, work: current };
        }
        if (current.state === "processing") {
          const taskOwner = current.processingPipelineTaskId
            ? await transaction.pipelineTask.findUnique({ where: { id: current.processingPipelineTaskId },
                include: { stage: { include: { run: { select: { state: true } } } } } }) : null;
          const owner = !current.processingPipelineTaskId && current.processingRunId
            ? await transaction.run.findUnique({
                where: { id: current.processingRunId },
                select: { state: true, leaseToken: true, leaseExpiresAt: true }
              })
            : null;
          const activeOwner = current.processingPipelineTaskId
            ? taskOwner?.stage?.run?.state === "running" && taskOwner.state !== "cancelled"
            : owner?.state === "running" &&
            owner.leaseToken === current.processingLeaseToken &&
            owner.leaseExpiresAt instanceof Date && owner.leaseExpiresAt > now;
          if (activeOwner) {
            return { outcome: "processing", networkAllowed: false, work: current };
          }
        }
        if (current.state === "failed" && current.processingRunId === runIdentifier) {
          return { outcome: "failed", networkAllowed: false, retryable: true, work: current };
        }
        const reclaimed = await transaction.shopWork.updateMany({
          where: {
            id: current.id,
            state: current.state,
            processingRunId: current.processingRunId,
            processingLeaseToken: current.processingLeaseToken
          },
          data: {
            state: "processing",
            processingRunId: runIdentifier,
            processingLeaseToken: lease.token,
            processingPipelineTaskId: null,
            safeErrorCode: null,
            safeErrorMessage: null,
            startedAt: now,
            completedAt: null
          }
        });
        if (reclaimed.count !== 1) {
          const latest = await transaction.shopWork.findUnique({ where: { id: current.id } });
          return { outcome: latest?.state || "processing", networkAllowed: false, work: latest };
        }
        current = await transaction.shopWork.findUnique({ where: { id: current.id } });
        if (workType === "lead_discovery") {
          await transaction.shopLeadProfile.upsert({
            where: { shopId },
            create: { shopId, state: "processing", processingRunId: runIdentifier },
            update: {
              state: "processing",
              processingRunId: runIdentifier,
              safeErrorCode: null,
              safeErrorMessage: null
            }
          });
        }
        return { outcome: "won", networkAllowed: true, work: current };
      });
    } catch (error) {
      if (retryAfterConflict && isUniqueConstraint(error)) {
        return this.claimShopWork(
          runIdentifier, lease, shopId, workType, scopeKey, now, false
        );
      }
      throw error;
    }
  }

  async claimShopWorkBatch(
    runIdentifier,
    lease,
    claims,
    now = new Date()
  ) {
    const normalized = requireBoundedBatch(
      "Shop work claims",
      claims,
      DATAFORSEO_TARGET_LIMIT
    ).map((claim) => {
      requireShopWorkKey(claim?.workType, claim?.scopeKey);
      if (typeof claim?.shopId !== "string" ||
          !/^shop_[A-Za-z0-9_-]{16,80}$/u.test(claim.shopId)) {
        throw new Error("Shop work shop ID is invalid");
      }
      return {
        id: shopWorkId(claim.shopId, claim.workType, claim.scopeKey),
        shopId: claim.shopId,
        workType: claim.workType,
        scopeKey: claim.scopeKey
      };
    });
    requireUniqueBatchKeys("Shop work claims", normalized, shopWorkBatchKey);
    if (!normalized.length) return [];

    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      await transaction.shopWork.createMany({
        data: normalized.map((claim) => ({ ...claim, state: "pending" })),
        skipDuplicates: true
      });
      const ids = normalized.map(({ id }) => id);
      const currentRows = await transaction.shopWork.findMany({
        where: { id: { in: ids } },
        include: {
          processingRun: {
            select: { state: true, leaseToken: true, leaseExpiresAt: true }
          }
        }
      });
      if (currentRows.length !== normalized.length) {
        throw new Error("Shop work batch did not materialize every requested key");
      }
      const pipelineOwnerIds = [...new Set(currentRows.map((row) => row.processingPipelineTaskId).filter(Boolean))];
      const pipelineOwners = pipelineOwnerIds.length ? await transaction.pipelineTask.findMany({
        where: { id: { in: pipelineOwnerIds } },
        include: { stage: { include: { run: { select: { state: true } } } } }
      }) : [];
      const pipelineOwnerById = new Map(pipelineOwners.map((row) => [row.id, row]));
      const eligible = currentRows.flatMap((work) => {
        if (work.state === "pending") return [work];
        if (work.state === "failed" && work.processingRunId !== runIdentifier) return [work];
        if (work.state !== "processing") return [];
        if (work.processingPipelineTaskId) {
          const taskOwner = pipelineOwnerById.get(work.processingPipelineTaskId);
          const activeTaskOwner = taskOwner?.stage?.run?.state === "running" && taskOwner.state !== "cancelled";
          return activeTaskOwner ? [] : [work];
        }
        const owner = work.processingRun;
        const activeOwner = owner?.state === "running" &&
          owner.leaseToken === work.processingLeaseToken &&
          owner.leaseExpiresAt instanceof Date && owner.leaseExpiresAt > now;
        return activeOwner ? [] : [work];
      }).map((work) => ({
        id: work.id,
        shopId: work.shopId,
        workType: work.workType,
        scopeKey: work.scopeKey,
        expectedState: work.state,
        expectedRunId: work.processingRunId,
        expectedLeaseToken: work.processingLeaseToken,
        expectedPipelineTaskId: work.processingPipelineTaskId
      }));
      const wonRows = await bulkClaimShopWorkRows(
        transaction, eligible, runIdentifier, lease, now
      );
      const won = new Set(wonRows.map(({ id }) => id));
      const durableRows = await transaction.shopWork.findMany({
        where: { id: { in: ids } }
      });
      if (durableRows.length !== normalized.length) {
        throw new Error("Shop work batch result did not reconcile every requested key");
      }
      const durableById = new Map(durableRows.map((row) => [row.id, row]));
      return normalized.map((claim) => {
        const work = durableById.get(claim.id);
        if (won.has(claim.id)) {
          return { outcome: "won", networkAllowed: true, work };
        }
        const outcome = ["completed", "failed", "ambiguous"].includes(work.state)
          ? work.state
          : "processing";
        return {
          outcome,
          networkAllowed: false,
          ...(outcome === "failed" ? { retryable: true } : {}),
          work
        };
      });
    });
  }

  async readReusableShopLeadProfile(runIdentifier, lease, shopId, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const row = await transaction.shopLeadProfile.findUnique({ where: { shopId } });
      if (!row || row.state !== "completed" || row.profilePayload == null) return null;
      return {
        shopId: row.shopId,
        state: row.state,
        profilePayload: parseShopLeadProfile(row.profilePayload),
        updatedAt: row.updatedAt
      };
    });
  }

  async saveDiscoveredShopLeadProfile(
    runIdentifier,
    lease,
    runStoreIdentifier,
    profile,
    now = new Date()
  ) {
    const profilePayload = profile == null ? null : parseShopLeadProfile(profile);
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const runStore = await transaction.runStore.findFirst({
        where: { id: runStoreIdentifier, runId: runIdentifier },
        include: { shop: true }
      });
      if (!runStore || runStore.state !== "processing") {
        throw new Error("Run store is not owned for profile publication");
      }
      if (profilePayload) assertProfileMatchesShop(profilePayload, runStore.shop.stableKey);
      const work = await transaction.shopWork.findUnique({
        where: {
          shopId_workType_scopeKey: {
            shopId: runStore.shopId,
            workType: "lead_discovery",
            scopeKey: "current"
          }
        }
      });
      const terminalState = profilePayload ? "completed" : "failed";
      if (work?.state === terminalState && work.processingRunId === runIdentifier &&
          work.processingLeaseToken === lease.token) {
        const durableProfile = await transaction.shopLeadProfile.findUnique({
          where: { shopId: runStore.shopId }
        });
        if (profilePayload && (durableProfile?.state !== "completed" ||
            canonicalJson(durableProfile.profilePayload) !== canonicalJson(profilePayload))) {
          throw new Error("Conflicting completed shop profile cannot be overwritten");
        }
        if (!profilePayload && durableProfile?.state === "completed") {
          throw new Error("Completed shop profile cannot be replaced by a failed outcome");
        }
        return { state: terminalState, shopId: runStore.shopId };
      }
      if (work?.state !== "processing" || work.processingRunId !== runIdentifier ||
          work.processingLeaseToken !== lease.token) {
        throw new Error("Lead discovery work is not owned by this lease");
      }
      const existingProfile = await transaction.shopLeadProfile.findUnique({
        where: { shopId: runStore.shopId }
      });
      if (existingProfile?.state === "completed" &&
          (!profilePayload || canonicalJson(existingProfile.profilePayload) !==
            canonicalJson(profilePayload))) {
        throw new Error("Conflicting completed shop profile cannot be overwritten");
      }
      if (profilePayload) {
        await transaction.shopLeadProfile.upsert({
          where: { shopId: runStore.shopId },
          create: {
            shopId: runStore.shopId,
            state: "completed",
            profilePayload,
            processingRunId: null
          },
          update: {
            state: "completed",
            profilePayload,
            processingRunId: null,
            safeErrorCode: null,
            safeErrorMessage: null
          }
        });
      } else if (existingProfile?.state !== "completed") {
        await transaction.shopLeadProfile.upsert({
          where: { shopId: runStore.shopId },
          create: {
            shopId: runStore.shopId,
            state: "failed",
            processingRunId: null,
            safeErrorCode: "PROFILE_NOT_REUSABLE",
            safeErrorMessage: "No reusable contact profile was produced for this store."
          },
          update: {
            state: "failed",
            profilePayload: null,
            processingRunId: null,
            safeErrorCode: "PROFILE_NOT_REUSABLE",
            safeErrorMessage: "No reusable contact profile was produced for this store."
          }
        });
      }
      requireLeaseMutation(await transaction.shopWork.updateMany({
        where: {
          id: work.id,
          state: "processing",
          processingRunId: runIdentifier,
          processingLeaseToken: lease.token
        },
        data: {
          state: terminalState,
          completedAt: now,
          ...(profilePayload
            ? { safeErrorCode: null, safeErrorMessage: null }
            : {
                safeErrorCode: "PROFILE_NOT_REUSABLE",
                safeErrorMessage: "No reusable contact profile was produced for this store."
              })
        }
      }));
      return { state: terminalState, shopId: runStore.shopId };
    });
  }

  async failShopLeadDiscovery(
    runIdentifier,
    lease,
    runStoreIdentifier,
    now = new Date()
  ) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const runStore = await transaction.runStore.findFirst({
        where: { id: runStoreIdentifier, runId: runIdentifier }
      });
      if (!runStore || runStore.state !== "processing") {
        throw new Error("Run store is not owned for failed profile publication");
      }
      const work = await transaction.shopWork.findUnique({
        where: {
          shopId_workType_scopeKey: {
            shopId: runStore.shopId,
            workType: "lead_discovery",
            scopeKey: "current"
          }
        }
      });
      if (work?.state === "failed" && work.processingRunId === runIdentifier &&
          work.processingLeaseToken === lease.token) {
        return { state: "failed", shopId: runStore.shopId };
      }
      if (work?.state !== "processing" || work.processingRunId !== runIdentifier ||
          work.processingLeaseToken !== lease.token) {
        throw new Error("Lead discovery work is not owned by this lease");
      }
      const profile = await transaction.shopLeadProfile.findUnique({
        where: { shopId: runStore.shopId }
      });
      if (profile?.state !== "completed") {
        await transaction.shopLeadProfile.upsert({
          where: { shopId: runStore.shopId },
          create: {
            shopId: runStore.shopId,
            state: "failed",
            processingRunId: null,
            safeErrorCode: "LEAD_DISCOVERY_FAILED",
            safeErrorMessage: "Lead discovery failed safely for this store."
          },
          update: {
            state: "failed",
            profilePayload: null,
            processingRunId: null,
            safeErrorCode: "LEAD_DISCOVERY_FAILED",
            safeErrorMessage: "Lead discovery failed safely for this store."
          }
        });
      }
      requireLeaseMutation(await transaction.shopWork.updateMany({
        where: {
          id: work.id,
          state: "processing",
          processingRunId: runIdentifier,
          processingLeaseToken: lease.token
        },
        data: {
          state: "failed",
          safeErrorCode: "LEAD_DISCOVERY_FAILED",
          safeErrorMessage: "Lead discovery failed safely for this store.",
          completedAt: now
        }
      }));
      return { state: "failed", shopId: runStore.shopId };
    });
  }

  async saveLeadBatch(
    runIdentifier,
    lease,
    outcomes,
    status = null,
    now = new Date()
  ) {
    const normalized = requireBoundedBatch("Lead outcomes", outcomes)
      .map((outcome) => {
        if (!outcome || typeof outcome.runStoreId !== "string" ||
            !["completed", "failed"].includes(outcome.state)) {
          throw new Error("Lead batch outcome is invalid");
        }
        const leadRow = leadRecordToCreate(
          runIdentifier,
          stableLeadId(runIdentifier, outcome.lead, 0),
          outcome.lead
        );
        const profileReusable = outcome.profileReusable === true;
        if (outcome.state === "failed" && profileReusable) {
          throw new Error("A failed lead outcome cannot reference a reusable profile");
        }
        const diagnostic = outcome.diagnostic == null
          ? null
          : diagnosticRecordToCreate(
              runIdentifier,
              childId("diag", runIdentifier, `lead:${outcome.runStoreId}`),
              0,
              outcome.diagnostic
            );
        return {
          runStoreId: outcome.runStoreId,
          state: outcome.state,
          leadValue: outcome.lead,
          leadRow,
          profileReusable,
          diagnostic
        };
      })
      .sort((left, right) => left.runStoreId.localeCompare(right.runStoreId));
    requireUniqueBatchKeys("Lead outcomes", normalized, ({ runStoreId }) => runStoreId);
    const progress = status ? progressFromStatus(status) : null;

    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const runStoreIds = normalized.map(({ runStoreId }) => runStoreId);
      const runStores = runStoreIds.length
        ? await transaction.runStore.findMany({
            where: { runId: runIdentifier, id: { in: runStoreIds } },
            include: { shop: true }
          })
        : [];
      if (runStores.length !== runStoreIds.length) {
        throw new Error("Lead batch references a run store outside this run");
      }
      const runStoreById = new Map(runStores.map((row) => [row.id, row]));
      const expectedLeadRows = normalized.map((outcome) => {
        const runStore = runStoreById.get(outcome.runStoreId);
        if (runStore.state !== "processing" && runStore.state !== outcome.state) {
          throw new Error("Run-store terminal state conflicts with lead batch replay");
        }
        assertLeadMatchesShop(outcome.leadValue, runStore.shop.stableKey);
        return {
          ...outcome.leadRow,
          shopId: runStore.shopId,
          shopLeadProfileId: outcome.profileReusable ? runStore.shopId : null
        };
      });
      const profileShopIds = expectedLeadRows
        .filter(({ shopLeadProfileId }) => shopLeadProfileId)
        .map(({ shopLeadProfileId }) => shopLeadProfileId);
      const profiles = profileShopIds.length
        ? await transaction.shopLeadProfile.findMany({
            where: { shopId: { in: profileShopIds }, state: "completed" }
          })
        : [];
      if (profiles.length !== profileShopIds.length) {
        throw new Error("Lead batch references a missing reusable shop profile");
      }
      const stableKeyByShopId = new Map(runStores.map(({ shopId, shop }) => [shopId, shop.stableKey]));
      for (const profile of profiles) {
        assertProfileMatchesShop(profile.profilePayload, stableKeyByShopId.get(profile.shopId));
      }
      const shopIds = expectedLeadRows.map(({ shopId }) => shopId);
      const existingLeads = shopIds.length
        ? await transaction.lead.findMany({
            where: { runId: runIdentifier, shopId: { in: shopIds } }
          })
        : [];
      const expectedByShopId = new Map(expectedLeadRows.map((row) => [row.shopId, row]));
      for (const existing of existingLeads) {
        const expected = expectedByShopId.get(existing.shopId);
        for (const [key, value] of Object.entries(expected)) {
          if (value !== undefined && canonicalJson(existing[key]) !== canonicalJson(value)) {
            throw new Error("Conflicting lead batch replay cannot overwrite durable data");
          }
        }
      }
      const existingShopIds = new Set(existingLeads.map(({ shopId }) => shopId));
      const missingLeads = expectedLeadRows.filter(({ shopId }) => !existingShopIds.has(shopId));
      if (missingLeads.length) {
        await transaction.lead.createMany({ data: missingLeads });
      }
      await grantRunShopsToOwner(transaction, runIdentifier, expectedLeadRows, now);
      const completedIds = normalized
        .filter(({ state, runStoreId }) =>
          state === "completed" && runStoreById.get(runStoreId).state === "processing")
        .map(({ runStoreId }) => runStoreId);
      const failedIds = normalized
        .filter(({ state, runStoreId }) =>
          state === "failed" && runStoreById.get(runStoreId).state === "processing")
        .map(({ runStoreId }) => runStoreId);
      if (completedIds.length) {
        const completed = await transaction.runStore.updateMany({
          where: { runId: runIdentifier, id: { in: completedIds }, state: "processing" },
          data: { state: "completed", safeErrorCode: null, safeErrorMessage: null }
        });
        if (completed.count !== completedIds.length) {
          throw new Error("Bulk completed run-store transition was not fully reconciled");
        }
      }
      if (failedIds.length) {
        const failed = await transaction.runStore.updateMany({
          where: { runId: runIdentifier, id: { in: failedIds }, state: "processing" },
          data: {
            state: "failed",
            safeErrorCode: "LEAD_DISCOVERY_FAILED",
            safeErrorMessage: "Lead discovery failed safely for this store."
          }
        });
        if (failed.count !== failedIds.length) {
          throw new Error("Bulk failed run-store transition was not fully reconciled");
        }
      }
      const diagnostics = normalized
        .filter(({ diagnostic }) => diagnostic)
        .map(({ diagnostic }, index) => ({
          ...diagnostic,
          sequence: 1_000_000 + index
        }));
      const writtenDiagnostics = await bulkUpsertDiagnostics(transaction, diagnostics);
      if (writtenDiagnostics.length !== diagnostics.length) {
        throw new Error("Bulk lead diagnostics were not reconciled");
      }
      const nonterminal = await transaction.runStore.count({
        where: { runId: runIdentifier, state: { in: ["discovered", "processing"] } }
      });
      if (nonterminal) throw new Error("Lead batch cannot complete with unfinished stores");
      const durableLeads = await transaction.lead.findMany({
        where: { runId: runIdentifier },
        select: { status: true }
      });
      const summary = durableLeads.reduce((counts, row) => {
        counts.total += 1;
        counts[row.status] += 1;
        return counts;
      }, { total: 0, qualified: 0, rejected: 0, failed: 0 });
      const currentRun = await transaction.run.findUnique({ where: { id: runIdentifier } });
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          stage: "leads_persisted",
          resultsAvailable: !dataForSeoScoringEnabled(currentRun),
          leadSummary: summary,
          pipelineVersion: 2,
          scoringVersion: 2,
          ...(progress ? { progress: {
            ...progress,
            outputRows: summary.total,
            storesProcessed: summary.total
          } } : {})
        }
      }));
      return summary;
    });
  }

  async saveDiscoveredLead(
    runIdentifier,
    lease,
    runStoreIdentifier,
    { profile, lead },
    now = new Date()
  ) {
    const profilePayload = profile == null ? null : parseShopLeadProfile(profile);
    return this.#saveProgressiveLead(
      runIdentifier,
      lease,
      runStoreIdentifier,
      { profilePayload, lead, reuse: false },
      now
    );
  }

  async saveReusedLead(
    runIdentifier,
    lease,
    runStoreIdentifier,
    lead,
    now = new Date()
  ) {
    return this.#saveProgressiveLead(
      runIdentifier,
      lease,
      runStoreIdentifier,
      { profilePayload: null, lead, reuse: true },
      now
    );
  }

  async #saveProgressiveLead(
    runIdentifier,
    lease,
    runStoreIdentifier,
    { profilePayload, lead, reuse },
    now
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const runStore = await transaction.runStore.findFirst({
        where: { id: runStoreIdentifier, runId: runIdentifier },
        include: { shop: true }
      });
      if (!runStore) {
        throw new Error("Run store is not owned for lead publication");
      }
      if (runStore.state === "completed") {
        const durableLead = await transaction.lead.findUnique({
          where: { runId_shopId: { runId: runIdentifier, shopId: runStore.shopId } }
        });
        if (!durableLead) throw new Error("Completed run store has no durable lead");
        assertLeadMatchesShop(lead, runStore.shop.stableKey);
        const expectedLead = leadRecordToCreate(
          runIdentifier,
          stableLeadId(runIdentifier, lead, 0),
          lead
        );
        for (const [key, value] of Object.entries(expectedLead)) {
          if (value !== undefined && canonicalJson(durableLead[key]) !== canonicalJson(value)) {
            throw new Error("Conflicting progressive lead replay cannot overwrite durable data");
          }
        }
        if (profilePayload) {
          assertProfileMatchesShop(profilePayload, runStore.shop.stableKey);
          const durableProfile = await transaction.shopLeadProfile.findUnique({
            where: { shopId: runStore.shopId }
          });
          if (durableProfile?.state !== "completed" ||
              canonicalJson(durableProfile.profilePayload) !== canonicalJson(profilePayload)) {
            throw new Error("Conflicting completed shop profile cannot be overwritten");
          }
        }
        return durableLead;
      }
      if (runStore.state !== "processing") {
        throw new Error("Run store is not owned for lead publication");
      }
      assertLeadMatchesShop(lead, runStore.shop.stableKey);
      if (profilePayload) assertProfileMatchesShop(profilePayload, runStore.shop.stableKey);
      if (reuse) {
        const reusable = await transaction.shopLeadProfile.findUnique({
          where: { shopId: runStore.shopId }
        });
        if (reusable?.state !== "completed" || reusable.profilePayload == null) {
          throw new Error("Reusable shop profile disappeared before lead publication");
        }
        parseShopLeadProfile(reusable.profilePayload);
      } else {
        const work = await transaction.shopWork.findUnique({
          where: {
            shopId_workType_scopeKey: {
              shopId: runStore.shopId,
              workType: "lead_discovery",
              scopeKey: "current"
            }
          }
        });
        if (work?.state !== "processing" || work.processingRunId !== runIdentifier ||
            work.processingLeaseToken !== lease.token) {
          throw new Error("Lead discovery work is not owned by this lease");
        }
        if (profilePayload) {
          const existingProfile = await transaction.shopLeadProfile.findUnique({
            where: { shopId: runStore.shopId }
          });
          if (existingProfile?.state === "completed" &&
              canonicalJson(existingProfile.profilePayload) !== canonicalJson(profilePayload)) {
            throw new Error("Conflicting completed shop profile cannot be overwritten");
          }
          await transaction.shopLeadProfile.upsert({
            where: { shopId: runStore.shopId },
            create: {
              shopId: runStore.shopId,
              state: "completed",
              profilePayload,
              processingRunId: null
            },
            update: {
              state: "completed",
              profilePayload,
              processingRunId: null,
              safeErrorCode: null,
              safeErrorMessage: null
            }
          });
        }
        const terminalWorkState = profilePayload ? "completed" : "failed";
        requireLeaseMutation(await transaction.shopWork.updateMany({
          where: {
            id: work.id,
            state: "processing",
            processingRunId: runIdentifier,
            processingLeaseToken: lease.token
          },
          data: {
            state: terminalWorkState,
            completedAt: now,
            ...(profilePayload
              ? { safeErrorCode: null, safeErrorMessage: null }
              : {
                  safeErrorCode: "PROFILE_NOT_REUSABLE",
                  safeErrorMessage: "No reusable contact profile was produced for this store."
                })
          }
        }));
      }
      const leadIdentifier = stableLeadId(runIdentifier, lead, 0);
      const leadRow = {
        ...leadRecordToCreate(runIdentifier, leadIdentifier, lead),
        shopId: runStore.shopId,
        shopLeadProfileId: profilePayload || reuse ? runStore.shopId : null
      };
      const existingLead = await transaction.lead.findUnique({
        where: { runId_shopId: { runId: runIdentifier, shopId: runStore.shopId } }
      });
      if (existingLead) {
        for (const [key, value] of Object.entries(leadRow)) {
          if (value !== undefined && canonicalJson(existingLead[key]) !== canonicalJson(value)) {
            throw new Error("Conflicting progressive lead replay cannot overwrite durable data");
          }
        }
      } else {
        await transaction.lead.create({ data: leadRow });
      }
      await grantRunShopsToOwner(transaction, runIdentifier, [leadRow], now);
      requireLeaseMutation(await transaction.runStore.updateMany({
        where: { id: runStore.id, runId: runIdentifier, state: "processing" },
        data: { state: "completed", safeErrorCode: null, safeErrorMessage: null }
      }));
      return transaction.lead.findUnique({ where: { id: leadIdentifier } });
    });
  }

  async saveFailedLead(
    runIdentifier,
    lease,
    runStoreIdentifier,
    lead,
    diagnostic,
    now = new Date()
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const runStore = await transaction.runStore.findFirst({
        where: { id: runStoreIdentifier, runId: runIdentifier },
        include: { shop: true }
      });
      if (!runStore) {
        throw new Error("Run store is not owned for failed lead publication");
      }
      if (runStore.state === "completed") {
        return transaction.lead.findUnique({
          where: { runId_shopId: { runId: runIdentifier, shopId: runStore.shopId } }
        });
      }
      if (runStore.state !== "processing") {
        throw new Error("Run store is not owned for failed lead publication");
      }
      assertLeadMatchesShop(lead, runStore.shop.stableKey);
      const leadIdentifier = stableLeadId(runIdentifier, lead, 0);
      const leadRow = {
        ...leadRecordToCreate(runIdentifier, leadIdentifier, lead),
        shopId: runStore.shopId,
        shopLeadProfileId: null
      };
      await transaction.lead.upsert({
        where: { runId_shopId: { runId: runIdentifier, shopId: runStore.shopId } },
        create: leadRow,
        update: leadRow
      });
      await grantRunShopsToOwner(transaction, runIdentifier, [leadRow], now);
      await transaction.runStore.update({
        where: { id: runStore.id },
        data: {
          state: "failed",
          safeErrorCode: "LEAD_DISCOVERY_FAILED",
          safeErrorMessage: "Lead discovery failed safely for this store."
        }
      });
      await transaction.shopWork.updateMany({
        where: {
          shopId: runStore.shopId,
          workType: "lead_discovery",
          scopeKey: "current",
          state: "processing",
          processingRunId: runIdentifier,
          processingLeaseToken: lease.token
        },
        data: {
          state: "failed",
          safeErrorCode: "LEAD_DISCOVERY_FAILED",
          safeErrorMessage: "Lead discovery failed safely for this store.",
          completedAt: now
        }
      });
      const existingProfile = await transaction.shopLeadProfile.findUnique({
        where: { shopId: runStore.shopId }
      });
      if (existingProfile?.state !== "completed") {
        await transaction.shopLeadProfile.upsert({
          where: { shopId: runStore.shopId },
          create: {
            shopId: runStore.shopId,
            state: "failed",
            processingRunId: null,
            safeErrorCode: "LEAD_DISCOVERY_FAILED",
            safeErrorMessage: "Lead discovery failed safely for this store."
          },
          update: {
            state: "failed",
            processingRunId: null,
            safeErrorCode: "LEAD_DISCOVERY_FAILED",
            safeErrorMessage: "Lead discovery failed safely for this store."
          }
        });
      }
      const sequence = await transaction.runDiagnostic.count({ where: { runId: runIdentifier } });
      const row = diagnosticRecordToCreate(
        runIdentifier,
        childId("diag", runIdentifier, `lead:${runStore.id}`),
        sequence,
        diagnostic
      );
      await transaction.runDiagnostic.create({ data: row });
      return leadRow;
    });
  }

  async completeLeadDiscovery(runIdentifier, lease, status = null, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const nonterminal = await transaction.runStore.count({
        where: { runId: runIdentifier, state: { in: ["discovered", "processing"] } }
      });
      if (nonterminal) throw new Error("Lead discovery cannot complete with unfinished stores");
      const rows = await transaction.lead.findMany({
        where: { runId: runIdentifier },
        select: { status: true }
      });
      const summary = rows.reduce((counts, row) => {
        counts.total += 1;
        counts[row.status] += 1;
        return counts;
      }, { total: 0, qualified: 0, rejected: 0, failed: 0 });
      const currentRun = await transaction.run.findUnique({ where: { id: runIdentifier } });
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          stage: "leads_persisted",
          resultsAvailable: !dataForSeoScoringEnabled(currentRun),
          leadSummary: summary,
          pipelineVersion: 2,
          scoringVersion: 2,
          ...(status ? { progress: {
            ...progressFromStatus(status),
            outputRows: summary.total,
            storesProcessed: summary.total
          } } : {})
        }
      }));
      return summary;
    });
  }

  async listPersistedQualifiedLeads(runIdentifier, lease, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const rows = await transaction.lead.findMany({
        where: { runId: runIdentifier, status: "qualified" },
        orderBy: { id: "asc" }
      });
      return rows.map((row) => ({ ...serializeLead(row), shop_id: row.shopId }));
    });
  }

  async readReusableTrafficCache(runIdentifier, lease, keys, now = new Date()) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const OR = keys.map((key) => {
      for (const field of ["source", "identity", "scopeKey", "metricSetKey", "contractVersion"]) {
        if (typeof key?.[field] !== "string" || !key[field]) {
          throw new Error("Traffic cache lookup key is invalid");
        }
      }
      return {
        source: key.source,
        identity: key.identity,
        scopeKey: key.scopeKey,
        metricSetKey: key.metricSetKey,
        contractVersion: key.contractVersion
      };
    });
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      return transaction.trafficEnrichmentCache.findMany({
        where: { expiresAt: { gt: now }, OR }
      });
    });
  }

  async readReusableLatestCruxBigQueryCache(
    runIdentifier,
    lease,
    identities,
    now = new Date()
  ) {
    if (!Array.isArray(identities) || identities.length === 0) return [];
    if (identities.some((identity) => typeof identity !== "string" || !identity)) {
      throw new Error("CrUX BigQuery cache identities are invalid");
    }
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      return transaction.trafficEnrichmentCache.findMany({
        where: {
          source: "crux_bigquery",
          identity: { in: [...new Set(identities)] },
          scopeKey: { startsWith: "month:" },
          expiresAt: { gt: now }
        },
        orderBy: [{ scopeKey: "desc" }, { identity: "asc" }]
      });
    });
  }

  async saveTrafficSourceResults(
    runIdentifier,
    lease,
    { sourceKey, records = [], summary = null, diagnostics = [] },
    now = new Date()
  ) {
    const allowedSources = sourceKey === "dataforseo"
      ? new Set(["dataforseo"])
      : sourceKey === "cruxRest"
        ? new Set(["crux_rest"])
        : sourceKey === "cruxBigQuery"
          ? new Set(["crux_bigquery"])
          : null;
    if (!allowedSources || records.some(({ source }) => !allowedSources.has(source))) {
      throw new Error("Traffic source publication is invalid");
    }
    const rows = records.map((record) => leadTrafficEnrichmentRecordToCreate(
      childId("lead_traffic", runIdentifier, `${record.leadId}:${record.source}`),
      runIdentifier,
      record.leadId,
      record
    ));
    requireBoundedBatch("Traffic source records", rows, DATAFORSEO_TARGET_LIMIT);
    requireUniqueBatchKeys(
      "Traffic source records",
      rows,
      ({ leadId, source }) => `${leadId}\u0000${source}`
    );
    const diagnosticBase = sourceKey === "dataforseo"
      ? 2_000_000
      : sourceKey === "cruxRest"
        ? 2_100_000
        : 2_200_000;
    const diagnosticRows = requireBoundedBatch("Traffic source diagnostics", diagnostics)
      .map((diagnostic, index) => diagnosticRecordToCreate(
        runIdentifier,
        childId(
          "diag",
          runIdentifier,
          `traffic:${sourceKey}:${index}:${diagnostic.code || "unknown"}`
        ),
        diagnosticBase + index,
        diagnostic
      ));
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now, stage: "enriching_traffic" }
      }));
      const leadIds = [...new Set(rows.map(({ leadId }) => leadId))];
      const owned = leadIds.length
        ? await transaction.lead.count({ where: { runId: runIdentifier, id: { in: leadIds } } })
        : 0;
      if (owned !== leadIds.length) {
        throw new Error("Traffic enrichment references a lead outside this run");
      }
      const written = await bulkUpsertLeadTraffic(transaction, rows);
      if (written.length !== rows.length) {
        throw new Error("Bulk traffic source rows were not reconciled");
      }
      const run = await transaction.run.findUnique({ where: { id: runIdentifier } });
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          trafficEnrichmentSummary: {
            ...(run?.trafficEnrichmentSummary || {}),
            version: "traffic-enrichment-summary-v1",
            ...(summary == null ? {} : { [sourceKey]: summary })
          }
        }
      }));
      const writtenDiagnostics = await bulkUpsertDiagnostics(transaction, diagnosticRows);
      if (writtenDiagnostics.length !== diagnosticRows.length) {
        throw new Error("Bulk traffic diagnostics were not reconciled");
      }
      return rows.length;
    });
  }

  async completeTrafficEnrichment(
    runIdentifier,
    lease,
    summary,
    diagnostics = [],
    status = null,
    now = new Date()
  ) {
    const diagnosticRows = requireBoundedBatch("Final traffic diagnostics", diagnostics)
      .map((diagnostic, index) => diagnosticRecordToCreate(
        runIdentifier,
        childId(
          "diag",
          runIdentifier,
          `traffic-final:${index}:${diagnostic.code || "unknown"}`
        ),
        2_900_000 + index,
        diagnostic
      ));
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const currentRun = await transaction.run.findUnique({ where: { id: runIdentifier } });
      const writtenDiagnostics = await bulkUpsertDiagnostics(transaction, diagnosticRows);
      if (writtenDiagnostics.length !== diagnosticRows.length) {
        throw new Error("Bulk final traffic diagnostics were not reconciled");
      }
      const priorTraffic = currentRun?.trafficEnrichmentSummary || null;
      const priorHasMaterial = priorTraffic && [
        "dataforseo", "cruxRest", "cruxBigQuery"
      ].some((key) => priorTraffic[key] != null);
      const finalTrafficSummary = summary?.state === "failed" && priorHasMaterial
        ? { ...priorTraffic, ...summary, state: "partial" }
        : summary;
      const scoringVersion = await finalizePersistedLeadScoresV3(
        transaction,
        runIdentifier,
        currentRun
      );
      const completed = await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          state: "completed",
          phase: "finished",
          stage: "completed",
          completedAt: now,
          resultsAvailable: true,
          pipelineVersion: 2,
          scoringVersion,
          ...(finalTrafficSummary != null
            ? { trafficEnrichmentSummary: finalTrafficSummary }
            : {}),
          ...(status ? { progress: progressFromStatus(status) } : {}),
          safeErrorCode: null,
          safeErrorMessage: null,
          leaseOwner: null,
          leaseToken: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null
        }
      });
      requireLeaseMutation(completed);
      return transaction.run.findUnique({ where: { id: runIdentifier } });
    });
  }

  parseRunStoreCandidate(value) {
    return parseRunStoreCandidate(value);
  }

  async readFreshTrafficCache(runIdentifier, lease, keys, now = new Date()) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const OR = keys.map((key) => {
      for (const field of ["source", "identity", "scopeKey", "metricSetKey", "contractVersion"]) {
        if (typeof key?.[field] !== "string" || !key[field]) {
          throw new Error("Traffic cache lookup key is invalid");
        }
      }
      return {
        source: key.source,
        identity: key.identity,
        scopeKey: key.scopeKey,
        metricSetKey: key.metricSetKey,
        contractVersion: key.contractVersion
      };
    });
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      return transaction.trafficEnrichmentCache.findMany({
        where: { expiresAt: { gt: now }, OR }
      });
    });
  }

  async readFreshLatestCruxBigQueryCache(
    runIdentifier,
    lease,
    identities,
    now = new Date()
  ) {
    if (!Array.isArray(identities) || identities.length === 0) return [];
    if (identities.some((identity) => typeof identity !== "string" || !identity)) {
      throw new Error("CrUX BigQuery cache identities are invalid");
    }
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      return transaction.trafficEnrichmentCache.findMany({
        where: {
          source: "crux_bigquery",
          identity: { in: [...new Set(identities)] },
          scopeKey: { startsWith: "month:" },
          expiresAt: { gt: now }
        },
        orderBy: [{ scopeKey: "desc" }, { identity: "asc" }]
      });
    });
  }

  async saveCruxTrafficCache(
    runIdentifier,
    lease,
    cacheRows,
    workClaimsOrNow = [],
    requestedNow = new Date()
  ) {
    const workClaims = workClaimsOrNow instanceof Date ? [] : workClaimsOrNow;
    const now = workClaimsOrNow instanceof Date ? workClaimsOrNow : requestedNow;
    if (!Array.isArray(cacheRows)) throw new Error("CrUX cache rows are required");
    if (cacheRows.some(({ source }) => !["crux_rest", "crux_bigquery"].includes(source))) {
      throw new Error("Only CrUX cache rows can be written through this method");
    }
    const rows = cacheRows.map((record) =>
      trafficCacheRecordToUpsert(cacheId(record), record)
    );
    requireBoundedBatch("CrUX cache rows", rows, DATAFORSEO_TARGET_LIMIT);
    requireUniqueBatchKeys("CrUX cache rows", rows, (row) => canonicalJson([
      row.source, row.identity, row.scopeKey, row.metricSetKey, row.contractVersion
    ]));
    const normalizedClaims = requireBoundedBatch(
      "CrUX work claims", workClaims, DATAFORSEO_TARGET_LIMIT
    ).map((claim) => {
      requireShopWorkKey(claim?.workType, claim?.scopeKey);
      if (!["crux_rest", "crux_bigquery"].includes(claim.workType) ||
          typeof claim.shopId !== "string") {
        throw new Error("CrUX work claim is invalid");
      }
      return { shopId: claim.shopId, workType: claim.workType, scopeKey: claim.scopeKey };
    });
    requireUniqueBatchKeys("CrUX work claims", normalizedClaims, shopWorkBatchKey);
    if (normalizedClaims.length) {
      if (normalizedClaims.length !== rows.length) {
        throw new Error("CrUX cache rows do not reconcile with work claims");
      }
      const expectedWorkType = rows[0]?.source;
      const expectedScopeKey = rows[0]?.scopeKey;
      if (!expectedWorkType || !expectedScopeKey || rows.some((row) =>
        row.source !== expectedWorkType || row.scopeKey !== expectedScopeKey
      ) || normalizedClaims.some((claim) =>
        claim.workType !== expectedWorkType || claim.scopeKey !== expectedScopeKey
      )) {
        throw new Error("CrUX cache rows and work claims have mismatched source or scope");
      }
    }
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const written = await bulkUpsertTrafficCache(transaction, rows, now);
      if (written.length !== rows.length) {
        throw new Error("Bulk CrUX cache rows were not reconciled");
      }
      const completed = await bulkFinishOwnedShopWork(
        transaction,
        normalizedClaims,
        runIdentifier,
        lease,
        "completed",
        now
      );
      if (completed.length !== normalizedClaims.length) {
        throw new Error("Bulk CrUX work completion was not reconciled");
      }
      return rows.length;
    });
  }

  async planDataForSeoRequest(
    runIdentifier,
    lease,
    descriptor,
    now = new Date(),
    retryAfterConflict = true
  ) {
    const request = requirePaidDescriptor(descriptor);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        requireLeaseMutation(await transaction.run.updateMany({
          where: activeLeaseWhere(runIdentifier, lease, now),
          data: { lastHeartbeatAt: now }
        }));
        const existing = await transaction.dataForSeoRequestLedger.findUnique({
          where: { requestFingerprint: request.requestFingerprint }
        });
        if (existing &&
            (existing.targetCount !== request.targetCount || existing.scopeKey !== request.scopeKey)) {
          throw new Error("DataForSEO request fingerprint metadata does not match");
        }
        if (existing?.state === "planned" && existing.runId !== runIdentifier) {
          const priorRun = await transaction.run.findUnique({
            where: { id: existing.runId },
            select: { state: true, leaseExpiresAt: true }
          });
          if (priorRun?.state === "running" && priorRun.leaseExpiresAt > now) {
            return { outcome: "in_flight", ledger: existing };
          }
        }
        if (existing && existing.state !== "planned") {
          const succeededExpired =
            existing.state === "succeeded" &&
            existing.runId !== runIdentifier &&
            Number.isSafeInteger(request.refreshSucceededAfterMs) &&
            existing.completedAt instanceof Date &&
            existing.completedAt.getTime() + request.refreshSucceededAfterMs <= now.getTime();
          const knownFailureRetryable =
            existing.state === "failed" && existing.runId !== runIdentifier;
          if (!succeededExpired && !knownFailureRetryable) {
            return { outcome: existing.state, ledger: existing };
          }
        }
        const data = {
          runId: runIdentifier,
          targetCount: request.targetCount,
          scopeKey: request.scopeKey,
          state: "planned",
          plannedAt: now,
          safeErrorCode: null,
          safeErrorMessage: null,
          reservationCostUsd: null,
          providerCostUsd: null,
          leaseOwner: null,
          leaseToken: null,
          leaseAttempt: null,
          claimedAt: null,
          ambiguousAfter: null,
          completedAt: null
        };
        const ledger = existing
          ? await transaction.dataForSeoRequestLedger.update({
              where: { requestFingerprint: request.requestFingerprint }, data
            })
          : await transaction.dataForSeoRequestLedger.create({
              data: { requestFingerprint: request.requestFingerprint, ...data }
            });
        return { outcome: "planned", ledger };
      });
    } catch (error) {
      if (retryAfterConflict && isUniqueConstraint(error)) {
        return this.planDataForSeoRequest(
          runIdentifier, lease, descriptor, now, false
        );
      }
      throw error;
    }
  }

  async claimDataForSeoRequest(runIdentifier, lease, requestFingerprint, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const run = await transaction.run.findUnique({
        where: { id: runIdentifier },
        select: { trafficEnrichmentConfig: true }
      });
      const policy = requirePaidPolicy(run?.trafficEnrichmentConfig);
      const currentLedger = await transaction.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint }
      });
      if (!currentLedger) throw new Error("DataForSEO request was not planned");
      if (currentLedger.runId !== runIdentifier || currentLedger.state !== "planned") {
        return {
          outcome: currentLedger.state,
          networkAllowed: false,
          ledger: currentLedger
        };
      }
      const exposureRows = await transaction.dataForSeoRequestLedger.findMany({
        where: {
          runId: runIdentifier,
          state: { in: ["in_flight", "ambiguous", "succeeded"] }
        },
        select: { state: true, reservationCostUsd: true, providerCostUsd: true }
      });
      const exposureUsd = paidExposure(exposureRows, policy);
      if (exposureUsd + policy.estimatedCostPerTaskUsd > policy.maxCostPerRunUsd) {
        const ledger = await transaction.dataForSeoRequestLedger.findUnique({
          where: { requestFingerprint }
        });
        if (!ledger) throw new Error("DataForSEO request was not planned");
        return { outcome: "budget_exceeded", networkAllowed: false, exposureUsd, ledger };
      }
      const claimed = await transaction.dataForSeoRequestLedger.updateMany({
        where: { requestFingerprint, runId: runIdentifier, state: "planned" },
        data: {
          state: "in_flight",
          attempt: { increment: 1 },
          leaseOwner: lease.owner,
          leaseToken: lease.token,
          leaseAttempt: lease.attempt ?? null,
          claimedAt: now,
          reservationCostUsd: policy.estimatedCostPerTaskUsd,
          ambiguousAfter: new Date(now.getTime() + policy.paidRequestStaleMs)
        }
      });
      const ledger = await transaction.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint }
      });
      if (!ledger) throw new Error("DataForSEO request was not planned");
      return {
        outcome: claimed.count === 1 ? "in_flight" : ledger.state,
        networkAllowed: claimed.count === 1,
        exposureUsd: claimed.count === 1
          ? exposureUsd + policy.estimatedCostPerTaskUsd
          : exposureUsd,
        ledger
      };
    });
  }

  async markDataForSeoRequestSucceeded(
    runIdentifier,
    lease,
    requestFingerprint,
    { providerCostUsd, cacheRows, workClaims = [] },
    now = new Date()
  ) {
    if (!Number.isFinite(providerCostUsd) || providerCostUsd < 0) {
      throw new Error("DataForSEO provider cost is invalid");
    }
    if (!Array.isArray(cacheRows)) throw new Error("DataForSEO cache rows are required");
    if (cacheRows.some(({ source }) => source !== "dataforseo")) {
      throw new Error("A DataForSEO ledger can commit only DataForSEO cache rows");
    }
    for (const claim of workClaims) {
      requireShopWorkKey(claim.workType, claim.scopeKey);
      if (claim.workType !== "dataforseo" || typeof claim.shopId !== "string") {
        throw new Error("DataForSEO work claim is invalid");
      }
    }
    requireBoundedBatch("DataForSEO work claims", workClaims, DATAFORSEO_TARGET_LIMIT);
    requireUniqueBatchKeys("DataForSEO work claims", workClaims, shopWorkBatchKey);
    const rows = cacheRows.map((record) => trafficCacheRecordToUpsert(cacheId(record), record));
    requireBoundedBatch("DataForSEO cache rows", rows, DATAFORSEO_TARGET_LIMIT);
    const identities = new Set(rows.map((row) => canonicalJson([
      row.source, row.identity, row.scopeKey, row.metricSetKey, row.contractVersion
    ])));
    if (identities.size !== rows.length) throw new Error("Traffic cache rows contain duplicates");

    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const ledger = await transaction.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint }
      });
      if (!ledger || ledger.runId !== runIdentifier || ledger.state !== "in_flight" ||
          ledger.leaseOwner !== lease.owner || ledger.leaseToken !== lease.token) {
        throw new Error("DataForSEO success does not own the in-flight ledger");
      }
      if (rows.some((row) => row.scopeKey !== ledger.scopeKey) ||
          workClaims.some((claim) => claim.scopeKey !== ledger.scopeKey)) {
        throw new Error("DataForSEO success scope does not match its ledger");
      }
      if (rows.length > ledger.targetCount ||
          (workClaims.length && workClaims.length !== ledger.targetCount)) {
        throw new Error("DataForSEO success count does not match its ledger");
      }
      const succeeded = await transaction.dataForSeoRequestLedger.updateMany({
        where: {
          requestFingerprint,
          runId: runIdentifier,
          state: "in_flight",
          leaseOwner: lease.owner,
          leaseToken: lease.token
        },
        data: {
          state: "succeeded",
          providerCostUsd,
          reservationCostUsd: null,
          ambiguousAfter: null,
          completedAt: now,
          safeErrorCode: null,
          safeErrorMessage: null
        }
      });
      requireLeaseMutation(succeeded);
      const written = await bulkUpsertTrafficCache(transaction, rows, now);
      if (written.length !== rows.length) {
        throw new Error("Bulk DataForSEO cache rows were not reconciled");
      }
      const completed = await bulkFinishOwnedShopWork(
        transaction,
        workClaims,
        runIdentifier,
        lease,
        "completed",
        now
      );
      if (completed.length !== workClaims.length) {
        throw new Error("Bulk DataForSEO work completion was not reconciled");
      }
      return transaction.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint }
      });
    });
  }

  async finishShopWorkClaims(
    runIdentifier,
    lease,
    claims,
    state,
    now = new Date()
  ) {
    if (!Array.isArray(claims) || !["completed", "failed", "ambiguous"].includes(state)) {
      throw new Error("Shop work completion is invalid");
    }
    const normalized = requireBoundedBatch(
      "Shop work completions", claims, DATAFORSEO_TARGET_LIMIT
    ).map((claim) => {
      requireShopWorkKey(claim?.workType, claim?.scopeKey);
      if (typeof claim.shopId !== "string") throw new Error("Shop work shop ID is invalid");
      return { shopId: claim.shopId, workType: claim.workType, scopeKey: claim.scopeKey };
    });
    requireUniqueBatchKeys("Shop work completions", normalized, shopWorkBatchKey);
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const completed = await bulkFinishOwnedShopWork(
        transaction, normalized, runIdentifier, lease, state, now
      );
      if (completed.length !== normalized.length) {
        throw new Error("Bulk shop work completion was not fully reconciled");
      }
      return { count: completed.length };
    });
  }

  async markDataForSeoRequestFailed(
    runIdentifier,
    lease,
    requestFingerprint,
    { code },
    now = new Date()
  ) {
    const safeError = safeLedgerError(code);
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const failed = await transaction.dataForSeoRequestLedger.updateMany({
        where: {
          requestFingerprint,
          runId: runIdentifier,
          state: "in_flight",
          leaseOwner: lease.owner,
          leaseToken: lease.token
        },
        data: {
          state: "failed",
          reservationCostUsd: null,
          ambiguousAfter: null,
          safeErrorCode: safeError.code,
          safeErrorMessage: safeError.message,
          completedAt: now
        }
      });
      requireLeaseMutation(failed);
      return transaction.dataForSeoRequestLedger.findUnique({ where: { requestFingerprint } });
    });
  }

  async markDataForSeoRequestAmbiguous(
    runIdentifier,
    lease,
    requestFingerprint,
    now = new Date()
  ) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const ambiguous = await transaction.dataForSeoRequestLedger.updateMany({
        where: {
          requestFingerprint,
          runId: runIdentifier,
          state: "in_flight",
          leaseOwner: lease.owner,
          leaseToken: lease.token
        },
        data: {
          state: "ambiguous",
          safeErrorCode: "PAID_REQUEST_OUTCOME_AMBIGUOUS",
          safeErrorMessage: "The paid request outcome could not be confirmed safely.",
          completedAt: now
        }
      });
      requireLeaseMutation(ambiguous);
      return transaction.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint }
      });
    });
  }

  async getDataForSeoRunCostUsd(runIdentifier, lease, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const aggregate = await transaction.dataForSeoRequestLedger.aggregate({
        where: { runId: runIdentifier, state: "succeeded" },
        _sum: { providerCostUsd: true }
      });
      const value = aggregate._sum.providerCostUsd;
      return value == null ? 0 : Number(value);
    });
  }

  async getDataForSeoRunExposureUsd(runIdentifier, lease, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const run = await transaction.run.findUnique({
        where: { id: runIdentifier },
        select: { trafficEnrichmentConfig: true }
      });
      const policy = requirePaidPolicy(run?.trafficEnrichmentConfig);
      const rows = await transaction.dataForSeoRequestLedger.findMany({
        where: {
          runId: runIdentifier,
          state: { in: ["in_flight", "ambiguous", "succeeded"] }
        },
        select: { state: true, reservationCostUsd: true, providerCostUsd: true }
      });
      return paidExposure(rows, policy);
    });
  }

  async markStaleDataForSeoRequestsAmbiguous(now = new Date()) {
    const where = {
      state: "in_flight",
      OR: [
        { ambiguousAfter: { lte: now } },
        { ambiguousAfter: null }
      ],
      run: {
        OR: [
          { state: { not: "running" } },
          { leaseExpiresAt: { lte: now } },
          { leaseExpiresAt: null }
        ]
      }
    };
    return this.prisma.$transaction(async (transaction) => {
      await selectBulkSchema(transaction, this.databaseSchema);
      const ledgers = await transaction.dataForSeoRequestLedger.findMany({
        where,
        select: { requestFingerprint: true, runId: true, scopeKey: true }
      });
      const transitioned = ledgers.length
        ? await transaction.dataForSeoRequestLedger.updateMany({
            where: {
              ...where,
              requestFingerprint: {
                in: ledgers.map(({ requestFingerprint }) => requestFingerprint)
              }
            },
            data: {
              state: "ambiguous",
              safeErrorCode: "PAID_REQUEST_OUTCOME_AMBIGUOUS",
              safeErrorMessage: "The paid request outcome could not be confirmed safely.",
              completedAt: now
            }
          })
        : { count: 0 };
      const workCount = await markPaidWorkForAmbiguousLedgers(transaction, now);
      return { count: transitioned.count, workCount };
    });
  }

  async saveCompletedResults(runIdentifier, lease, {
    leads,
    trafficEnrichments = [],
    trafficEnrichmentSummary = null,
    queryAudits = [],
    diagnostics = [],
    summary,
    pipelineVersion = 2,
    scoringVersion = 2
  }, status = null, now = new Date()) {
    const leadRows = leads.map((record, index) =>
      leadRecordToCreate(
        runIdentifier,
        stableLeadId(runIdentifier, record, index),
        record
      )
    );
    const leadIds = new Set(leadRows.map(({ id }) => id));
    const enrichmentRows = trafficEnrichments.map((record) => {
      if (!leadIds.has(record.leadId)) {
        throw new Error("Traffic enrichment references an unknown lead");
      }
      return leadTrafficEnrichmentRecordToCreate(
        childId("lead_traffic", runIdentifier, `${record.leadId}:${record.source}`),
        runIdentifier,
        record.leadId,
        record
      );
    });
    const enrichmentIdentities = new Set(
      enrichmentRows.map(({ leadId, source }) => `${leadId}\u0000${source}`)
    );
    if (enrichmentIdentities.size !== enrichmentRows.length) {
      throw new Error("Traffic enrichment contains duplicate lead/source rows");
    }
    const auditRows = queryAudits.map((record, index) =>
      queryAuditRecordToCreate(runIdentifier, childId("audit", runIdentifier, index), index, record)
    );
    const diagnosticRows = diagnostics.map((record, index) =>
      diagnosticRecordToCreate(runIdentifier, childId("diag", runIdentifier, index), index, record)
    );
    const finalProgress = status
      ? { ...progressFromStatus(status), outputRows: leads.length }
      : undefined;
    const fingerprint = resultFingerprint({
      leads: leadRows,
      queryAudits: auditRows,
      diagnostics: diagnosticRows,
      trafficEnrichments: enrichmentRows,
      trafficEnrichmentSummary,
      summary,
      pipelineVersion,
      scoringVersion
    });

    return this.prisma.$transaction(async (transaction) => {
      const published = await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          state: "completed",
          phase: "finished",
          stage: "completed",
          completedAt: now,
          resultsAvailable: true,
          leadSummary: summary,
          ...(trafficEnrichmentSummary != null
            ? { trafficEnrichmentSummary }
            : {}),
          pipelineVersion,
          scoringVersion,
          resultFingerprint: fingerprint,
          ...(finalProgress ? { progress: finalProgress } : {}),
          safeErrorCode: null,
          safeErrorMessage: null
        }
      });
      if (published.count !== 1) {
        const existing = await transaction.run.findUnique({
          where: { id: runIdentifier }
        });
        if (
          existing?.state === "completed" &&
          existing.leaseOwner === lease.owner &&
          existing.leaseToken === lease.token &&
          existing.resultFingerprint === fingerprint
        ) {
          return existing;
        }
        throw new RunTerminalConflictError();
      }
      await transaction.leadTrafficEnrichment.deleteMany({ where: { runId: runIdentifier } });
      await transaction.lead.deleteMany({ where: { runId: runIdentifier } });
      if (auditRows.length) {
        await transaction.queryAudit.deleteMany({ where: { runId: runIdentifier } });
      }
      await transaction.runDiagnostic.deleteMany({ where: { runId: runIdentifier } });
      if (leadRows.length) {
        await transaction.lead.createMany({ data: leadRows });
      }
      if (enrichmentRows.length) {
        await transaction.leadTrafficEnrichment.createMany({ data: enrichmentRows });
      }
      if (auditRows.length) await transaction.queryAudit.createMany({ data: auditRows });
      if (diagnosticRows.length) {
        await transaction.runDiagnostic.createMany({ data: diagnosticRows });
      }
      return transaction.run.findUnique({ where: { id: runIdentifier } });
    });
  }

  async markFailed(
    runIdentifier,
    lease,
    {
      code = "RUN_FAILED",
      message = "The run could not be completed. Please try again."
    } = {},
    status = null,
    now = new Date()
  ) {
    const result = await this.prisma.run.updateMany({
      where: activeLeaseWhere(runIdentifier, lease, now),
      data: {
        state: "failed",
        phase: "finished",
        stage: "failed",
        completedAt: now,
        resultsAvailable: false,
        safeErrorCode: code,
        safeErrorMessage: message,
        pipelineVersion: 2,
        scoringVersion: 2,
        ...(status ? { progress: progressFromStatus(status) } : {})
      }
    });
    return requireLeaseMutation(result);
  }

  async getResultsPage(runIdentifier, ownerId, filters) {
    const where = resultWhere(runIdentifier, ownerId, filters);
    const skip = (filters.page - 1) * filters.pageSize;
    const [totalItems, items] = await this.prisma.$transaction([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: resultOrder(filters),
        skip,
        take: filters.pageSize
      })
    ]);
    return { totalItems, items };
  }

  async getResultSummary(runIdentifier, ownerId, filters) {
    const where = resultWhere(runIdentifier, ownerId, { ...filters, status: null });
    const groups = await this.prisma.lead.groupBy({
      by: ["status"],
      where,
      _count: { _all: true }
    });
    return groups.reduce((summary, group) => {
      const count = group._count._all;
      summary.total += count;
      if (group.status in summary) summary[group.status] += count;
      return summary;
    }, { total: 0, qualified: 0, rejected: 0, failed: 0 });
  }

  async getMasterLeadsPage(ownerId, filters) {
    const where = {
      userId: ownerId,
      ...(filters.archived ? {} : { archivedAt: null })
    };
    if (filters.search) {
      where.OR = [
        ...["stableKey", "resolvedDomain", "myshopifyDomain"].map((field) => ({
          shop: { [field]: { contains: filters.search, mode: "insensitive" } }
        })),
        {
          shop: { leads: { some: {
            run: { ownerId, state: "completed", resultsAvailable: true },
            OR: ["storeName", "email", "phone", "shopType"].map((field) => ({
              [field]: { contains: filters.search, mode: "insensitive" }
            }))
          } } }
        }
      ];
    }
    if (filters.discoveryQueries?.length) {
      const attributed = filters.discoveryQueries.filter((query) => query !== "__unattributed__");
      const includeUnattributed = filters.discoveryQueries.includes("__unattributed__");
      const queryFilter = { run: { ownerId, state: "completed", resultsAvailable: true }, OR: [
        ...(attributed.length ? [{ generatedQuery: { in: attributed } }, { searchQuery: { in: attributed } }] : []),
        ...(includeUnattributed ? [{ AND: [{ generatedQuery: null }, { searchQuery: null }] }] : [])
      ] };
      where.AND = [{ shop: { leads: { some: queryFilter } } }];
    }
    const skip = (filters.page - 1) * filters.pageSize;
    const orderBy = filters.sortBy === "first_discovered"
      ? [{ firstDiscoveredAt: filters.sortDirection }, { id: "asc" }]
      : [{ lastDiscoveredAt: filters.sortDirection }, { id: "asc" }];
    const include = {
      shop: {
        include: {
          leadProfile: true,
          leads: {
            where: { run: { ownerId, state: "completed", resultsAvailable: true } },
            orderBy: [
              { leadScore: { sort: "desc", nulls: "last" } },
              { run: { createdAt: "desc" } }
            ]
          }
        }
      },
      discoveries: {
        orderBy: [{ discoveredAt: "desc" }, { id: "desc" }],
        include: { run: { select: { createdAt: true, normalizedShopTypes: true } } }
      }
    };
    const [totalItems, queriedItems] = await this.prisma.$transaction([
      this.prisma.userShop.count({ where }),
      this.prisma.userShop.findMany({
        where,
        orderBy,
        ...(filters.sortBy === "lead_quality" ? {} : { skip, take: filters.pageSize }),
        include
      })
    ]);
    const items = filters.sortBy === "lead_quality"
      ? queriedItems.sort((left, right) => {
          const leftScore = left.shop.leads[0]?.leadScore ?? -1;
          const rightScore = right.shop.leads[0]?.leadScore ?? -1;
          return (rightScore - leftScore) * (filters.sortDirection === "desc" ? 1 : -1)
            || left.id.localeCompare(right.id);
        }).slice(skip, skip + filters.pageSize)
      : queriedItems;
    const hostnames = new Set();
    const origins = new Set();
    for (const item of items) {
      for (const value of [item.shop.stableKey, item.shop.resolvedDomain, item.shop.myshopifyDomain]) {
        if (value) hostnames.add(value.toLowerCase());
      }
      for (const value of [item.shop.canonicalUrl, item.shop.resolvedDomain && `https://${item.shop.resolvedDomain}`]) {
        if (!value) continue;
        try { origins.add(new URL(value).origin); } catch { /* Invalid stored URL is ignored. */ }
      }
    }
    const OR = [
      ...(hostnames.size ? [{ source: "dataforseo", identity: { in: [...hostnames] } }] : []),
      ...(origins.size ? [{ source: { in: ["crux_rest", "crux_bigquery"] }, identity: { in: [...origins] } }] : [])
    ];
    const cacheRows = OR.length
      ? await this.prisma.trafficEnrichmentCache.findMany({
          where: { OR },
          orderBy: [{ fetchedAt: "desc" }, { scopeKey: "asc" }]
        })
      : [];
    return { totalItems, items, cacheRows };
  }

  async getTrafficEnrichmentsForLeadIds(runIdentifier, ownerId, leadIds) {
    if (!leadIds.length) return [];
    return this.prisma.leadTrafficEnrichment.findMany({
      where: {
        runId: runIdentifier,
        leadId: { in: leadIds },
        lead: { run: { ownerId } }
      },
      orderBy: [{ leadId: "asc" }, { source: "asc" }]
    });
  }

  async getTrafficEnrichmentsForRun(runIdentifier, ownerId) {
    return this.prisma.leadTrafficEnrichment.findMany({
      where: { runId: runIdentifier, lead: { run: { ownerId } } },
      orderBy: [{ leadId: "asc" }, { source: "asc" }]
    });
  }

  async getTrafficOverviewRows(runIdentifier, ownerId, { search, discoveryQueries = [] }) {
    return this.prisma.lead.findMany({
      where: resultWhere(runIdentifier, ownerId, { status: null, search, discoveryQueries }),
      select: {
        id: true,
        generatedQuery: true,
        searchQuery: true,
        trafficEnrichments: {
          orderBy: { source: "asc" }
        }
      },
      orderBy: { id: "asc" }
    });
  }

  async getQueryAuditsPage(runIdentifier, ownerId, { page, pageSize }) {
    const where = { runId: runIdentifier, run: { ownerId } };
    const skip = (page - 1) * pageSize;
    const [totalItems, items] = await this.prisma.$transaction([
      this.prisma.queryAudit.count({ where }),
      this.prisma.queryAudit.findMany({ where, orderBy: { sequence: "asc" }, skip, take: pageSize })
    ]);
    return { totalItems, items };
  }

  async getDiagnosticsPage(runIdentifier, ownerId, { page, pageSize }) {
    const where = { runId: runIdentifier, run: { ownerId } };
    const skip = (page - 1) * pageSize;
    const [totalItems, items] = await this.prisma.$transaction([
      this.prisma.runDiagnostic.count({ where }),
      this.prisma.runDiagnostic.findMany({ where, orderBy: { sequence: "asc" }, skip, take: pageSize })
    ]);
    return { totalItems, items };
  }

  async recoverExpiredRuns(now = new Date()) {
    const expiredLease = {
      state: "running",
      OR: [
        { leaseExpiresAt: { lte: now } },
        { leaseExpiresAt: null }
      ]
    };
    return this.prisma.$transaction(async (transaction) => {
      const resumable = await transaction.run.updateMany({
        where: {
          ...expiredLease,
          executionBackend: "local",
          phase: "scraping",
          stage: { in: [
            "stores_persisted",
            "discovering_leads",
            "leads_persisted",
            "enriching_traffic"
          ] }
        },
        data: {
          state: "queued",
          resultsAvailable: false,
          leaseOwner: null,
          leaseToken: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
          safeErrorCode: null,
          safeErrorMessage: null
        }
      });
      const awsPreHandoff = await transaction.run.updateMany({
        where: {
          ...expiredLease,
          executionBackend: "aws",
          phase: "scraping",
          stage: { in: ["validating_confirmed_queries", "probing_confirmed_queries"] }
        },
        data: {
          state: "queued", resultsAvailable: false, leaseOwner: null, leaseToken: null,
          leaseAcquiredAt: null, leaseExpiresAt: null, lastHeartbeatAt: null,
          safeErrorCode: null, safeErrorMessage: null
        }
      });
      const failed = await transaction.run.updateMany({
        where: { ...expiredLease, executionBackend: "local" },
        data: {
          state: "failed",
          phase: "finished",
          stage: "failed",
          completedAt: now,
          resultsAvailable: false,
          safeErrorCode: "RUN_LEASE_EXPIRED",
          safeErrorMessage:
            "The worker stopped renewing this run. Please start a new run."
        }
      });
      return { count: resumable.count + awsPreHandoff.count + failed.count,
        resumable: resumable.count + awsPreHandoff.count, failed: failed.count };
    });
  }
}

export function createPrismaRunRepository(prisma, config = loadConfig()) {
  return new PrismaRunRepository(prisma, config);
}
