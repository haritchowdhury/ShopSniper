import { createInitialProgress } from "./status.js";

const TEXT_FIELDS = {
  shop_type: "shopType",
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
  error: "error"
};

const NUMBER_FIELDS = {
  query_score: "queryScore",
  google_rank: "googleRank",
  shopify_confidence: "shopifyConfidence",
  relevance_score: "relevanceScore",
  lead_score: "leadScore"
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
  return mapped;
}
