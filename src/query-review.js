import { createHash } from "node:crypto";
import { probeCandidates } from "./query-prober.js";
import {
  QUERY_VALIDATION_CONTRACT_VERSION,
  validateQueryText
} from "./query-validator.js";

export const GOOGLE_PROBE_CONTRACT_VERSION = "google-probe-v2";
export const DEFAULT_PROBE_FRESHNESS_MS = 24 * 60 * 60 * 1000;
export const MAX_QUERIES_PER_CATEGORY = 20;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function queryProbeFingerprint(query, category, config) {
  return createHash("sha256").update(canonicalJson({
    query,
    category: {
      shopType: category.shopType || "",
      businessQualifier: category.businessQualifier || "unspecified"
    },
    queryContract: QUERY_VALIDATION_CONTRACT_VERSION,
    probeContract: GOOGLE_PROBE_CONTRACT_VERSION,
    thresholds: {
      minQueryResults: config.minQueryResults,
      minQueryUniqueHosts: config.minQueryUniqueHosts,
      minQueryRelevantResults: config.minQueryRelevantResults,
      minQueryRelevanceRatio: config.minQueryRelevanceRatio,
      minQueryBaseScore: config.minQueryBaseScore,
      googleResultsPerQuery: config.googleResultsPerQuery
    }
  })).digest("hex");
}

export function normalizeProbeResults(results) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, 10).map((result) => ({
    query: typeof result.query === "string" ? result.query : "",
    rank: Number.isFinite(Number(result.rank)) ? Number(result.rank) : null,
    url: typeof result.url === "string" ? result.url : "",
    title: typeof result.title === "string" ? result.title.slice(0, 500) : "",
    snippet: typeof result.snippet === "string" ? result.snippet.slice(0, 1000) : "",
    rejectionReason: typeof result.rejectionReason === "string"
      ? result.rejectionReason
      : ""
  }));
}

export function validateEditableQueryList(queries, categories, config) {
  const errors = [];
  if (!Array.isArray(queries)) {
    return { valid: false, queries: [], errors: [{ path: "queries", reason: "must_be_an_array" }] };
  }
  if (queries.length > config.maxQueries) {
    errors.push({ path: "queries", reason: "too_many_queries", limit: config.maxQueries });
  }

  const counts = new Array(categories.length).fill(0);
  const seenByCategory = categories.map(() => new Set());
  const normalized = [];
  for (const [index, item] of queries.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ index, field: "query", reason: "invalid_query_row" });
      continue;
    }
    const unknown = Object.keys(item).filter((key) => !["id", "categoryIndex", "query"].includes(key));
    if (unknown.length) errors.push({ index, field: "row", reason: "unsupported_fields", fields: unknown });
    if (!Number.isInteger(item.categoryIndex) || !categories[item.categoryIndex]) {
      errors.push({ index, field: "categoryIndex", reason: "invalid_category" });
      continue;
    }
    counts[item.categoryIndex] += 1;
    const category = categories[item.categoryIndex];
    const checked = validateQueryText(item.query, {
      shopType: category.shopType,
      categoryVocabulary: config.categoryVocabularyByIndex?.[item.categoryIndex] || [],
      seenQueries: seenByCategory[item.categoryIndex]
    });
    if (!checked.valid) {
      errors.push({ index, field: "query", reason: checked.rejectionReason });
    }
    normalized.push({
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      categoryIndex: item.categoryIndex,
      query: checked.query
    });
  }

  const requiredCount = config.generatedQueryCount ?? 10;
  for (const [categoryIndex, count] of counts.entries()) {
    if (count !== requiredCount) {
      errors.push({
        categoryIndex,
        field: "queries",
        reason: "category_requires_exact_query_count",
        expected: requiredCount,
        actual: count
      });
    }
    if (count > MAX_QUERIES_PER_CATEGORY) {
      errors.push({
        categoryIndex,
        field: "queries",
        reason: "too_many_queries_for_category",
        limit: MAX_QUERIES_PER_CATEGORY
      });
    }
  }
  return { valid: errors.length === 0, queries: normalized, errors };
}

function freshReusableProbe(row, fingerprint, now, freshnessMs) {
  const probedAt = row.probedAt ? new Date(row.probedAt) : null;
  return row.validationState === "valid" &&
    row.probeFingerprint === fingerprint &&
    row.probeContractVersion === GOOGLE_PROBE_CONTRACT_VERSION &&
    probedAt && Number.isFinite(probedAt.getTime()) &&
    now.getTime() - probedAt.getTime() <= freshnessMs &&
    Array.isArray(row.probeResults);
}

export async function validateConfirmedQueryRows(
  rows,
  categories,
  config,
  status,
  {
    probe = probeCandidates,
    now = new Date(),
    freshnessMs = config.queryProbeFreshnessMs || DEFAULT_PROBE_FRESHNESS_MS,
    searchPage
  } = {}
) {
  status.stage = "validating_confirmed_queries";
  const seenByCategory = categories.map(() => new Set());
  const validation = [];
  const toProbe = [];
  const counts = new Array(categories.length).fill(0);

  for (const row of rows) {
    const category = categories[row.categoryIndex];
    if (category) counts[row.categoryIndex] += 1;
    const checked = category
      ? validateQueryText(row.query, {
          shopType: category.shopType,
          categoryVocabulary: Array.isArray(row.categoryVocabulary)
            ? row.categoryVocabulary
            : [],
          seenQueries: seenByCategory[row.categoryIndex]
        })
      : { valid: false, rejectionReason: "invalid_category", query: row.query };
    const fingerprint = category
      ? queryProbeFingerprint(checked.query, category, config)
      : null;
    const item = { ...row, query: checked.query, probeFingerprint: fingerprint };
    if (!checked.valid) {
      validation.push({
        ...item,
        validationState: "invalid",
        rejectionReason: checked.rejectionReason,
        probeResults: null,
        probeSummary: null,
        probedAt: null
      });
    } else if (freshReusableProbe(row, fingerprint, now, freshnessMs)) {
      validation.push({ ...item, reusedProbe: true });
    } else {
      toProbe.push({ item, category });
    }
  }

  if (toProbe.length) {
    status.stage = "probing_confirmed_queries";
    const candidates = toProbe.map(({ item }) => ({
      query: item.query,
      product_phrase: item.query.replace(/^site:myshopify\.com\/products\s+/iu, ""),
      product_family: item.query.replace(/^site:myshopify\.com\/products\s+/iu, ""),
      market_signal: "user_confirmed",
      seasonality: "unknown",
      query_generation_reason: item.generationReason || "User-confirmed query",
      source_urls: item.sourceUrls || [],
      confidence: 1
    }));
    const probes = await probe(candidates, config, { searchPage });
    for (const [index, probeResult] of probes.entries()) {
      const { item } = toProbe[index];
      validation.push({
        ...item,
        validationState: probeResult.rejectionReason ? "invalid" : "valid",
        rejectionReason: probeResult.rejectionReason || null,
        probeContractVersion: GOOGLE_PROBE_CONTRACT_VERSION,
        probedAt: now,
        probeResults: normalizeProbeResults(probeResult.results),
        probeSummary: {
          rawResults: probeResult.rawResults,
          relevantResults: probeResult.relevantResults,
          relevantRatio: probeResult.relevantRatio,
          uniqueHosts: probeResult.uniqueHosts?.length || 0,
          duplicateProducts: probeResult.duplicateProducts,
          estimatedTotalResults: probeResult.estimatedTotalResults,
          nextPageAvailable: Boolean(probeResult.nextPageAvailable),
          baseScore: probeResult.baseScore,
          error: probeResult.error || ""
        }
      });
    }
  }

  validation.sort((left, right) => left.sequence - right.sequence);
  const requiredCount = config.generatedQueryCount ?? 10;
  const errors = counts.flatMap((count, categoryIndex) => count === requiredCount
    ? []
    : [{
        categoryIndex,
        field: "queries",
        reason: "category_requires_exact_query_count",
        expected: requiredCount,
        actual: count
      }]);
  const valid = errors.length === 0 &&
    validation.every((row) => row.validationState === "valid");
  return {
    valid,
    errors,
    rows: validation,
    queryPlans: valid ? validation.map((row) => {
      const category = categories[row.categoryIndex];
      return {
        ...category,
        categoryIntent: category,
        categoryVocabulary: Array.isArray(row.categoryVocabulary) ? row.categoryVocabulary : [],
        query: row.query,
        queryScore: row.queryScore ?? "",
        queryGenerationReason: row.generationReason || "User-confirmed query",
        querySourceUrls: row.sourceUrls || [],
        results: row.probeResults || []
      };
    }) : []
  };
}
