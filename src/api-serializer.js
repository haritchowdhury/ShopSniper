import { createInitialProgress } from "./status.js";

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

function nullableText(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableNumber(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function serializeLead(lead) {
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
  const isV2 = lead.pipelineVersion === 2 || lead.scoringVersion === 2;
  item.score_semantics = !isV2
    ? "legacy_v1"
    : lead.leadScore == null
      ? "not_scored_v2"
      : "evidence_rank_v2";
  return item;
}

export function serializeRun(run) {
  const progress = createInitialProgress();
  for (const key of Object.keys(progress)) {
    const value = Number(run.progress?.[key]);
    progress[key] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return {
    runId: run.id,
    state: run.state,
    stage: run.stage,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() || null,
    completedAt: run.completedAt?.toISOString() || null,
    progress,
    resultsAvailable: Boolean(run.resultsAvailable),
    pipelineVersion: run.pipelineVersion ?? null,
    scoringVersion: run.scoringVersion ?? null,
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
