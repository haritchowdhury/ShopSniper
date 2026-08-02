import { createInitialProgress } from "./status.js";
import { z } from "zod";
import {
  assertLeadScoreState,
  LeadStateInvariantError
} from "./lead-state.js";

const TEXT_FIELDS = {
  original_shop_type: "originalShopType",
  shop_type: "shopType",
  business_qualifier: "businessQualifier",
  generated_query: "generatedQuery",
  query_generation_reason: "queryGenerationReason",
  search_query: "searchQuery",
  google_result_url: "googleResultUrl",
  myshopify_domain: "myshopifyDomain",
  final_url: "finalUrl",
  canonical_url: "canonicalUrl",
  resolved_domain: "resolvedDomain",
  store_name: "storeName",
  email: "email",
  email_source_url: "emailSourceUrl",
  phone: "phone",
  phone_source_url: "phoneSourceUrl",
  contact_url: "contactUrl",
  additional_information: "additionalInformation",
  rejection_reason: "rejectionReason",
  error: "error",
  store_fit_state: "storeFitState",
  contactability_tier: "contactabilityTier"
};

const NUMBER_FIELDS = {
  query_score: "queryScore",
  google_rank: "googleRank",
  shopify_confidence: "shopifyConfidence",
  relevance_score: "relevanceScore",
  lead_score: "leadScore",
  pipeline_version: "pipelineVersion",
  scoring_version: "scoringVersion",
  identity_confidence: "identityConfidence"
};

const JSON_FIELDS = {
  store_fit_evidence: "storeFitEvidence",
  contact_evidence: "contactEvidence",
  identity_evidence: "identityEvidence",
  score_breakdown: "scoreBreakdown",
  discovery_occurrences: "discoveryOccurrences",
  matched_categories: "matchedCategories"
};

const finiteNonNegative = z.number().finite().nonnegative();
const isoTimestamp = z.string().datetime({ offset: true });
const isoDate = z.string().date();
const fraction = z.number().finite().min(0).max(1);
const dataForSeoMetric = z.object({
  etv: finiteNonNegative,
  count: z.number().int().nonnegative()
}).strict();
const dataForSeoPayload = z.object({
  contractVersion: z.literal("dataforseo-traffic-v1"),
  target: z.string().min(1),
  scope: z.union([
    z.literal("worldwide"),
    z.object({
      countryIsoCode: z.string().regex(/^[A-Z]{2}$/u),
      locationCode: z.number().int().positive()
    }).strict()
  ]),
  languageScope: z.literal("all_available"),
  metrics: z.object({
    organic: dataForSeoMetric,
    paid: dataForSeoMetric,
    featuredSnippet: dataForSeoMetric,
    localPack: dataForSeoMetric
  }).strict(),
  fetchedAt: isoTimestamp
}).strict();
const cruxRestPayload = z.object({
  contractVersion: z.literal("crux-origin-metrics-v1"),
  origin: z.string().url(),
  coverage: z.literal("available"),
  metrics: z.object({
    largestContentfulPaintP75Ms: finiteNonNegative.optional(),
    interactionToNextPaintP75Ms: finiteNonNegative.optional(),
    cumulativeLayoutShiftP75: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u).optional(),
    firstContentfulPaintP75Ms: finiteNonNegative.optional(),
    timeToFirstByteP75Ms: finiteNonNegative.optional()
  }).strict(),
  formFactors: z.object({
    desktop: fraction,
    phone: fraction,
    tablet: fraction
  }).strict().optional(),
  collectionPeriod: z.object({ firstDate: isoDate, lastDate: isoDate }).strict(),
  fetchedAt: isoTimestamp
}).strict();
const cruxPopularityPayload = z.object({
  contractVersion: z.literal("crux-popularity-v1"),
  origin: z.string().url(),
  coverage: z.literal("available"),
  datasetMonth: z.string().regex(/^20\d{4}$/u),
  popularityRank: z.number().int().positive(),
  deviceFractions: z.object({
    phone: fraction,
    desktop: fraction,
    tablet: fraction
  }).strict(),
  fetchedAt: isoTimestamp
}).strict();
const NORMALIZED_PAYLOAD_SCHEMAS = Object.freeze({
  dataforseo: dataForSeoPayload,
  crux_rest: cruxRestPayload,
  crux_bigquery: cruxPopularityPayload
});
const PUBLISHED_PAYLOAD_SCHEMAS = Object.freeze({
  dataforseo: z.object({
    records: z.array(dataForSeoPayload).min(1).max(10)
  }).strict(),
  crux_rest: cruxRestPayload,
  crux_bigquery: cruxPopularityPayload
});
const CACHE_STATES = new Set(["available", "no_coverage"]);
const PUBLISHED_STATES = new Set([
  "available", "partial", "no_coverage", "unavailable", "ambiguous", "contract_mismatch"
]);
const SOURCE_STORAGE_CONTRACTS = Object.freeze({
  dataforseo: {
    contractVersion: "dataforseo-traffic-v1",
    metricSetKey: "featured_snippet,local_pack,organic,paid"
  },
  crux_rest: {
    contractVersion: "crux-origin-metrics-v1",
    metricSetKey: "cumulative_layout_shift,experimental_time_to_first_byte,first_contentful_paint,form_factors,interaction_to_next_paint,largest_contentful_paint"
  },
  crux_bigquery: {
    contractVersion: "crux-popularity-v1",
    metricSetKey: "desktop_density,phone_density,popularity_rank,tablet_density"
  }
});

function requiredDate(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date;
}

function optionalDate(value, field) {
  return value == null ? null : requiredDate(value, field);
}

function normalizedPayload(source, state, payload, schemas = NORMALIZED_PAYLOAD_SCHEMAS) {
  const schema = schemas[source];
  if (!schema) throw new Error("Traffic enrichment source is invalid");
  if (state !== "available" && state !== "partial") {
    if (payload != null) throw new Error("Non-material enrichment state cannot contain a payload");
    return undefined;
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error("Traffic enrichment payload is not a normalized contract");
  return parsed.data;
}

export function trafficCacheRecordToUpsert(id, record) {
  if (!CACHE_STATES.has(record.state)) throw new Error("Traffic cache state is invalid");
  const payload = normalizedPayload(record.source, record.state, record.normalizedPayload);
  if (typeof record.identity !== "string" || !record.identity ||
      typeof record.scopeKey !== "string" || !record.scopeKey ||
      typeof record.metricSetKey !== "string" || !record.metricSetKey ||
      typeof record.contractVersion !== "string" || !record.contractVersion) {
    throw new Error("Traffic cache identity is invalid");
  }
  const storageContract = SOURCE_STORAGE_CONTRACTS[record.source];
  if (!storageContract || record.contractVersion !== storageContract.contractVersion ||
      record.metricSetKey !== storageContract.metricSetKey) {
    throw new Error("Traffic cache source contract is invalid");
  }
  if (payload && payload.contractVersion !== record.contractVersion) {
    throw new Error("Traffic cache contract version does not match its payload");
  }
  if (record.source === "dataforseo") {
    const expectedScope = !payload
      ? record.scopeKey
      : payload.scope === "worldwide"
        ? "worldwide"
        : `country:${payload.scope.countryIsoCode}:${payload.scope.locationCode}`;
    if (payload && payload.target !== record.identity || record.scopeKey !== expectedScope ||
        !/^(?:worldwide|country:[A-Z]{2}:[1-9]\d*)$/u.test(record.scopeKey)) {
      throw new Error("Traffic cache DataForSEO identity or scope does not match its payload");
    }
  }
  if (record.source === "crux_rest" &&
      (record.scopeKey !== "current" || (payload && payload.origin !== record.identity))) {
    throw new Error("Traffic cache CrUX REST identity or scope does not match its payload");
  }
  if (record.source === "crux_bigquery" &&
      (!/^month:20\d{4}$/u.test(record.scopeKey) ||
       (payload && (payload.origin !== record.identity || record.scopeKey !== `month:${payload.datasetMonth}`)))) {
    throw new Error("Traffic cache CrUX BigQuery identity or scope does not match its payload");
  }
  const fetchedAt = requiredDate(record.fetchedAt, "fetchedAt");
  const expiresAt = requiredDate(record.expiresAt, "expiresAt");
  if (expiresAt <= fetchedAt) throw new Error("Traffic cache expiry must follow fetch time");
  return {
    id,
    source: record.source,
    identity: record.identity,
    scopeKey: record.scopeKey,
    metricSetKey: record.metricSetKey,
    contractVersion: record.contractVersion,
    state: record.state,
    normalizedPayload: payload,
    fetchedAt,
    coverageStartedAt: optionalDate(record.coverageStartedAt, "coverageStartedAt"),
    coverageEndedAt: optionalDate(record.coverageEndedAt, "coverageEndedAt"),
    expiresAt
  };
}

export function leadTrafficEnrichmentRecordToCreate(id, runId, leadId, record) {
  if (!PUBLISHED_STATES.has(record.state)) throw new Error("Published traffic state is invalid");
  const payload = normalizedPayload(
    record.source,
    record.state,
    record.normalizedPayload,
    PUBLISHED_PAYLOAD_SCHEMAS
  );
  if (typeof record.contractVersion !== "string" || !record.contractVersion) {
    throw new Error("Published traffic contract version is invalid");
  }
  if (record.source === "dataforseo" && payload &&
      payload.records.some(({ contractVersion }) => contractVersion !== record.contractVersion)) {
    throw new Error("Published traffic contract version does not match its payload");
  }
  if (record.source !== "dataforseo" && payload?.contractVersion !== record.contractVersion) {
    throw new Error("Published traffic contract version does not match its payload");
  }
  return {
    id,
    runId,
    leadId,
    source: record.source,
    state: record.state,
    contractVersion: record.contractVersion,
    normalizedPayload: payload,
    fetchedAt: optionalDate(record.fetchedAt, "fetchedAt"),
    coverageStartedAt: optionalDate(record.coverageStartedAt, "coverageStartedAt"),
    coverageEndedAt: optionalDate(record.coverageEndedAt, "coverageEndedAt")
  };
}

function nullableText(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableNumber(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function serializeLead(lead) {
  const scoreSemantics = assertLeadScoreState({
    status: lead.status,
    pipelineVersion: lead.pipelineVersion,
    scoringVersion: lead.scoringVersion,
    leadScore: lead.leadScore,
    scoreBreakdown: lead.scoreBreakdown
  });
  const item = { id: lead.id };
  for (const [publicName, modelName] of Object.entries(TEXT_FIELDS)) {
    item[publicName] = nullableText(lead[modelName]);
  }
  for (const [publicName, modelName] of Object.entries(NUMBER_FIELDS)) {
    item[publicName] = nullableNumber(lead[modelName]);
  }
  item.social_profiles = Array.isArray(lead.socialProfiles)
    ? lead.socialProfiles.filter((value) => typeof value === "string")
    : [];
  item.status = lead.status;
  for (const [publicName, modelName] of Object.entries(JSON_FIELDS)) {
    item[publicName] = lead[modelName] ?? null;
  }
  item.score_semantics = scoreSemantics;
  return item;
}

export function serializeRun(run) {
  const progress = createInitialProgress();
  for (const key of Object.keys(progress)) {
    const value = Number(run.progress?.[key]);
    progress[key] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  const queryRows = Array.isArray(run.queries) ? run.queries : null;
  const invalidQueryCount = queryRows
    ? queryRows.filter(({ validationState }) => validationState === "invalid").length
    : null;
  return {
    runId: run.id,
    state: run.state,
    phase: run.phase || null,
    stage: run.stage,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() || null,
    completedAt: run.completedAt?.toISOString() || null,
    progress,
    resultsAvailable: Boolean(run.resultsAvailable),
    pipelineVersion: run.pipelineVersion ?? null,
    scoringVersion: run.scoringVersion ?? null,
    queryReview: run.queryRevision > 0
      ? {
          revision: run.queryRevision,
          confirmedRevision: run.confirmedQueryRevision ?? null,
          editable: run.state === "awaiting_query_confirmation" && run.phase === "query_review",
          queriesUrl: `/api/runs/${encodeURIComponent(run.id)}/queries`,
          valid: queryRows
            ? queryRows.length > 0 && queryRows.every(({ validationState }) => validationState === "valid")
            : null,
          invalidQueryCount
        }
      : null,
    error: run.safeErrorCode
      ? {
          code: run.safeErrorCode,
          message:
            run.safeErrorMessage ||
            "The run could not be completed. Please try again."
        }
      : null
  };
}

export function serializeRunQuery(row) {
  return {
    id: row.id,
    categoryIndex: row.categoryIndex,
    sequence: row.sequence,
    query: row.query,
    source: row.source,
    validationState: row.validationState,
    rejectionReason: row.rejectionReason || null,
    queryScore: row.queryScore ?? null,
    generationReason: row.generationReason || null,
    probedAt: row.probedAt?.toISOString?.() || (row.probedAt ? new Date(row.probedAt).toISOString() : null)
  };
}

export function serializeEditableQueries(run) {
  const categories = Array.isArray(run.normalizedShopTypes)
    ? run.normalizedShopTypes.map((category, categoryIndex) => ({ categoryIndex, ...category }))
    : [];
  return {
    runId: run.id,
    revision: run.queryRevision,
    editable: run.state === "awaiting_query_confirmation" && run.phase === "query_review",
    categories,
    queries: (run.queries || []).map(serializeRunQuery)
  };
}

export function leadRecordToCreate(runId, id, record) {
  const mapped = { id, runId, status: record.status };
  for (const [publicName, modelName] of Object.entries(TEXT_FIELDS)) {
    mapped[modelName] = nullableText(record[publicName]);
  }
  for (const [publicName, modelName] of Object.entries(NUMBER_FIELDS)) {
    mapped[modelName] = nullableNumber(record[publicName]);
  }
  mapped.socialProfiles = Array.isArray(record.social_profiles)
    ? record.social_profiles.filter((value) => typeof value === "string")
    : [];
  for (const [publicName, modelName] of Object.entries(JSON_FIELDS)) {
    if (record[publicName] != null) mapped[modelName] = record[publicName];
  }
  const scoreSemantics = assertLeadScoreState({
    status: mapped.status,
    pipelineVersion: mapped.pipelineVersion,
    scoringVersion: mapped.scoringVersion,
    leadScore: mapped.leadScore,
    scoreBreakdown: mapped.scoreBreakdown
  });
  if (scoreSemantics === "legacy_v1") {
    throw new LeadStateInvariantError("new_persistence_requires_v2");
  }
  return mapped;
}

export function queryAuditRecordToCreate(runId, id, sequence, record) {
  const known = new Set([
    "shop_type", "business_qualifier", "query", "status", "rejection_reason"
  ]);
  return {
    id,
    runId,
    sequence,
    shopType: nullableText(record.shop_type),
    businessQualifier: nullableText(record.business_qualifier),
    query: nullableText(record.query),
    status: nullableText(record.status) || "unknown",
    rejectionReason: nullableText(record.rejection_reason),
    details: Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key)))
  };
}

export function diagnosticRecordToCreate(runId, id, sequence, record) {
  return {
    id,
    runId,
    sequence,
    scope: nullableText(record.scope) || "run",
    code: nullableText(record.code) || "unknown",
    shopType: nullableText(record.shop_type),
    businessQualifier: nullableText(record.business_qualifier),
    query: nullableText(record.query),
    resultUrl: nullableText(record.result_url),
    details: record.details && typeof record.details === "object" ? record.details : {}
  };
}

export function serializeQueryAudit(record) {
  return {
    sequence: record.sequence,
    shop_type: record.shopType,
    business_qualifier: record.businessQualifier,
    query: record.query,
    status: record.status,
    rejection_reason: record.rejectionReason,
    details: record.details
  };
}

export function serializeDiagnostic(record) {
  return {
    sequence: record.sequence,
    scope: record.scope,
    code: record.code,
    shop_type: record.shopType,
    business_qualifier: record.businessQualifier,
    query: record.query,
    result_url: record.resultUrl,
    details: record.details
  };
}
