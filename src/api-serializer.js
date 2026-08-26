import { createInitialProgress } from "./status.js";
import { z } from "zod";
import {
  assertLeadScoreState,
  LeadStateInvariantError
} from "./lead-state.js";
import {
  DATAFORSEO_COUNTRY_LOCATION_CODES,
  normalizeDataForSeoHostname
} from "./enrichment/dataforseo/request.js";
import { normalizeCruxOrigin } from "./enrichment/crux/api-request.js";

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
const canonicalDataForSeoHostname = z.string().refine((value) => {
  try {
    return normalizeDataForSeoHostname(value) === value;
  } catch {
    return false;
  }
}, "DataForSEO target must be a canonical hostname");
const canonicalCruxOrigin = z.string().refine((value) => {
  try {
    return normalizeCruxOrigin(value) === value;
  } catch {
    return false;
  }
}, "CrUX origin must be an exact canonical HTTPS origin");
const fractions = z.object({
  desktop: fraction,
  phone: fraction,
  tablet: fraction
}).strict().refine(
  ({ desktop, phone, tablet }) =>
    Math.abs(desktop + phone + tablet - 1) <= 0.010000001,
  "Traffic fractions must sum to one"
);
const collectionPeriod = z.object({
  firstDate: isoDate,
  lastDate: isoDate
}).strict().refine(
  ({ firstDate, lastDate }) => firstDate <= lastDate,
  "CrUX collection period must be ordered"
);
const dataForSeoMetric = z.object({
  etv: finiteNonNegative,
  count: z.number().int().nonnegative()
}).strict();
const dataForSeoPayload = z.object({
  contractVersion: z.literal("dataforseo-traffic-v1"),
  target: canonicalDataForSeoHostname,
  scope: z.union([
    z.literal("worldwide"),
    z.object({
      countryIsoCode: z.enum(Object.keys(DATAFORSEO_COUNTRY_LOCATION_CODES)),
      locationCode: z.number().int().positive()
    }).strict().refine(
      ({ countryIsoCode, locationCode }) =>
        DATAFORSEO_COUNTRY_LOCATION_CODES[countryIsoCode] === locationCode,
      "DataForSEO country and location code must match"
    )
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
  origin: canonicalCruxOrigin,
  coverage: z.literal("available"),
  metrics: z.object({
    largestContentfulPaintP75Ms: finiteNonNegative.optional(),
    interactionToNextPaintP75Ms: finiteNonNegative.optional(),
    cumulativeLayoutShiftP75: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u).optional(),
    firstContentfulPaintP75Ms: finiteNonNegative.optional(),
    timeToFirstByteP75Ms: finiteNonNegative.optional()
  }).strict(),
  formFactors: fractions.optional(),
  collectionPeriod,
  fetchedAt: isoTimestamp
}).strict().refine(
  ({ metrics, formFactors }) => Object.keys(metrics).length > 0 || formFactors != null,
  "Available CrUX REST material must contain a metric or form factors"
);
const cruxPopularityPayload = z.object({
  contractVersion: z.literal("crux-popularity-v1"),
  origin: canonicalCruxOrigin,
  coverage: z.literal("available"),
  datasetMonth: z.string().regex(/^20\d{2}(?:0[1-9]|1[0-2])$/u),
  popularityRank: z.number().int().positive(),
  deviceFractions: fractions,
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
  }).strict().refine(({ records }) => {
    const targets = new Set(records.map(({ target }) => target));
    const scopes = records.map(({ scope }) => scope === "worldwide"
      ? "worldwide"
      : `country:${scope.countryIsoCode}:${scope.locationCode}`);
    return targets.size === 1 && new Set(scopes).size === scopes.length;
  }, "Published DataForSEO records must use one target and unique scopes"),
  crux_rest: cruxRestPayload,
  crux_bigquery: cruxPopularityPayload
});
const CACHE_STATES = new Set(["available", "no_coverage"]);
const PUBLISHED_STATES = new Set([
  "available", "partial", "no_coverage", "unavailable", "ambiguous", "contract_mismatch"
]);
const PUBLIC_TRAFFIC_VERSION = "traffic-enrichment-public-v1";
const DATAFORSEO_COUNTRY_ORDER = Object.freeze([
  "US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"
]);
const DATAFORSEO_METRIC_KEYS = Object.freeze([
  "estimated_google_search_traffic",
  "organic_estimated_traffic",
  "organic_keyword_count",
  "paid_estimated_traffic",
  "paid_keyword_count",
  "featured_snippet_estimated_traffic",
  "featured_snippet_keyword_count",
  "local_pack_estimated_traffic",
  "local_pack_keyword_count"
]);
const PUBLIC_SOURCE_STATES = new Set(["available", "partial", "no_coverage", "unavailable"]);
const CRUX_ATTRIBUTION = Object.freeze({
  source: "crux",
  name: "Chrome UX Report",
  text: "Performance and popularity data sourced from the Chrome UX Report by Google, licensed under CC BY 4.0. Values are selected, renamed, and may be combined by Email Scraper.",
  source_url: "https://developer.chrome.com/docs/crux/",
  license: "CC BY 4.0",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  transformation: "Metrics are selected and renamed; DataForSEO values are not combined with CrUX values."
});
const DATAFORSEO_ATTRIBUTION = Object.freeze({
  source: "dataforseo",
  name: "DataForSEO Labs",
  text: "Estimated Google search traffic data sourced from DataForSEO Labs.",
  source_url: "https://dataforseo.com/apis/dataforseo-labs-api"
});
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
const publicDataForSeoMetricShape = {
  estimated_google_search_traffic: finiteNonNegative,
  organic_estimated_traffic: finiteNonNegative,
  organic_keyword_count: z.number().int().nonnegative(),
  paid_estimated_traffic: finiteNonNegative,
  paid_keyword_count: z.number().int().nonnegative(),
  featured_snippet_estimated_traffic: finiteNonNegative,
  featured_snippet_keyword_count: z.number().int().nonnegative(),
  local_pack_estimated_traffic: finiteNonNegative,
  local_pack_keyword_count: z.number().int().nonnegative()
};
const derivedSearchTotalMatches = (value) => value.estimated_google_search_traffic ===
  value.organic_estimated_traffic + value.paid_estimated_traffic;
const publicDataForSeoMetric = z.object(publicDataForSeoMetricShape).strict().refine(
  derivedSearchTotalMatches,
  "Estimated search traffic must equal organic plus paid"
);
const publicDataForSeoMaterial = z.object({
  state: z.enum(["available", "partial"]),
  label: z.literal("Estimated Google search traffic"),
  target: canonicalDataForSeoHostname.optional(),
  worldwide: publicDataForSeoMetric.optional(),
  markets: z.array(z.object({
    country_code: z.enum(Object.keys(DATAFORSEO_COUNTRY_LOCATION_CODES)),
    ...publicDataForSeoMetricShape
  }).strict().refine(derivedSearchTotalMatches)).max(9),
  observed_at: isoTimestamp.optional()
}).strict().refine(({ worldwide, markets }) => worldwide != null || markets.length > 0,
  "DataForSEO public material cannot be empty").refine(({ state, worldwide, markets }) =>
  (state === "available") === (worldwide != null && markets.length === 9),
  "DataForSEO public state must match complete scope material").refine(({ markets }) => {
  const positions = markets.map(({ country_code }) => DATAFORSEO_COUNTRY_ORDER.indexOf(country_code));
  return new Set(positions).size === positions.length &&
    positions.every((position, index) => index === 0 || position > positions[index - 1]);
}, "DataForSEO public markets must be unique and ordered");
const publicDataForSeo = z.union([
  publicDataForSeoMaterial,
  z.object({ state: z.enum(["no_coverage", "unavailable"]) }).strict()
]);
const publicCruxRest = z.union([
  z.object({
    state: z.literal("available"),
    origin: canonicalCruxOrigin,
    metrics: z.object({
      largest_contentful_paint_p75_ms: finiteNonNegative.optional(),
      interaction_to_next_paint_p75_ms: finiteNonNegative.optional(),
      cumulative_layout_shift_p75: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u).optional(),
      first_contentful_paint_p75_ms: finiteNonNegative.optional(),
      time_to_first_byte_p75_ms: finiteNonNegative.optional()
    }).strict(),
    observed_form_factor_fractions: fractions.optional(),
    collection_period: z.object({ first_date: isoDate, last_date: isoDate }).strict()
      .refine(({ first_date, last_date }) => first_date <= last_date),
    observed_at: isoTimestamp
  }).strict().refine(({ metrics, observed_form_factor_fractions: formFactors }) =>
    Object.keys(metrics).length > 0 || formFactors != null),
  z.object({ state: z.enum(["no_coverage", "unavailable"]) }).strict()
]);
const publicCruxPopularity = z.union([
  z.object({
    state: z.literal("available"),
    origin: canonicalCruxOrigin,
    label: z.literal("Coarse CrUX navigation popularity rank"),
    dataset_month: z.string().regex(/^20\d{2}(?:0[1-9]|1[0-2])$/u),
    popularity_rank: z.number().int().positive(),
    popularity_band: z.string(),
    observed_device_fractions: fractions,
    observed_at: isoTimestamp
  }).strict().refine(({ popularity_rank, popularity_band }) =>
    popularity_band === `top_${popularity_rank}`),
  z.object({ state: z.enum(["no_coverage", "unavailable"]) }).strict()
]);
const publicCrux = z.object({
  state: z.enum(["available", "partial", "no_coverage", "unavailable"]),
  origin_metrics: publicCruxRest,
  popularity: publicCruxPopularity
}).strict().refine(({ state, origin_metrics: rest, popularity }) => {
  const restMaterial = rest.state === "available";
  const popularityMaterial = popularity.state === "available";
  const expected = restMaterial && popularityMaterial
    ? "available"
    : restMaterial || popularityMaterial
      ? "partial"
      : rest.state === "no_coverage" && popularity.state === "no_coverage"
        ? "no_coverage"
        : "unavailable";
  return state === expected && (!restMaterial || !popularityMaterial || rest.origin === popularity.origin);
}, "CrUX public state and origin must agree");
const publicAttribution = z.object({
  source: z.enum(["dataforseo", "crux"]),
  name: z.string().min(1),
  text: z.string().min(1),
  source_url: z.string().url().refine((value) => value.startsWith("https://")),
  license: z.string().optional(),
  license_url: z.string().url().refine((value) => value.startsWith("https://")).optional(),
  transformation: z.string().optional()
}).strict();
const publicTrafficEnrichmentSchema = z.object({
  version: z.literal(PUBLIC_TRAFFIC_VERSION),
  dataforseo: publicDataForSeo.optional(),
  crux: publicCrux.optional(),
  traffic_sources: z.array(z.enum(["dataforseo", "crux"])).optional(),
  traffic_attributions: z.array(publicAttribution).optional()
}).refine(({ dataforseo, crux }) => dataforseo != null || crux != null)
  .refine((value) => {
    const expected = [];
    if (value.dataforseo && ["available", "partial"].includes(value.dataforseo.state)) {
      expected.push("dataforseo");
    }
    if (value.crux && ["available", "partial"].includes(value.crux.state)) expected.push("crux");
    if (expected.length === 0) {
      return value.traffic_sources == null && value.traffic_attributions == null;
    }
    return value.traffic_sources?.length === expected.length &&
      value.traffic_attributions?.length === expected.length &&
      expected.every((source, index) => value.traffic_sources[index] === source &&
        value.traffic_attributions[index].source === source) &&
      value.traffic_attributions.every((item) => item.source !== "crux" ||
        Boolean(item.license && item.license_url && item.transformation));
  }, "Traffic sources and attribution must match serialized material");

export function parsePublicTrafficEnrichment(value) {
  const parsed = publicTrafficEnrichmentSchema.safeParse(value);
  if (!parsed.success) throw new Error("Public traffic enrichment contract is invalid");
  return parsed.data;
}

function requiredDate(value, field) {
  if (value == null || value === "") throw new Error(`${field} must be a valid timestamp`);
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date;
}

function optionalDate(value, field) {
  return value == null ? null : requiredDate(value, field);
}

function sameInstant(left, right) {
  return requiredDate(left, "timestamp").getTime() === requiredDate(right, "timestamp").getTime();
}

function assertStoredTiming(source, payload, record, { cache = false } = {}) {
  const fetchedAt = requiredDate(record.fetchedAt, "fetchedAt");
  const coverageStartedAt = optionalDate(record.coverageStartedAt, "coverageStartedAt");
  const coverageEndedAt = optionalDate(record.coverageEndedAt, "coverageEndedAt");
  if (coverageStartedAt && coverageEndedAt && coverageStartedAt > coverageEndedAt) {
    throw new Error("Traffic enrichment coverage period must be ordered");
  }
  if (payload && !sameInstant(fetchedAt, payload.fetchedAt)) {
    throw new Error("Traffic enrichment fetch time does not match its payload");
  }
  if (source === "crux_rest" && payload) {
    if (!coverageStartedAt || !coverageEndedAt ||
        coverageStartedAt.toISOString().slice(0, 10) !== payload.collectionPeriod.firstDate ||
        coverageEndedAt.toISOString().slice(0, 10) !== payload.collectionPeriod.lastDate) {
      throw new Error("CrUX coverage time does not match its payload");
    }
  } else if (coverageStartedAt || coverageEndedAt) {
    throw new Error("Traffic enrichment source cannot contain coverage dates");
  }
  if (!cache && !payload && record.fetchedAt != null) {
    throw new Error("Non-material published enrichment cannot contain fetch time");
  }
  return { fetchedAt, coverageStartedAt, coverageEndedAt };
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
    const countryScope = /^country:([A-Z]{2}):([1-9]\d*)$/u.exec(record.scopeKey);
    const supportedScope = record.scopeKey === "worldwide" ||
      (countryScope && DATAFORSEO_COUNTRY_LOCATION_CODES[countryScope[1]] === Number(countryScope[2]));
    const expectedScope = !payload
      ? record.scopeKey
      : payload.scope === "worldwide"
        ? "worldwide"
        : `country:${payload.scope.countryIsoCode}:${payload.scope.locationCode}`;
    if (!canonicalDataForSeoHostname.safeParse(record.identity).success || !supportedScope ||
        (payload && payload.target !== record.identity) || record.scopeKey !== expectedScope) {
      throw new Error("Traffic cache DataForSEO identity or scope does not match its payload");
    }
  }
  if (record.source === "crux_rest" &&
      (!canonicalCruxOrigin.safeParse(record.identity).success || record.scopeKey !== "current" ||
       (payload && payload.origin !== record.identity))) {
    throw new Error("Traffic cache CrUX REST identity or scope does not match its payload");
  }
  if (record.source === "crux_bigquery" &&
      (!canonicalCruxOrigin.safeParse(record.identity).success ||
       !/^month:20\d{2}(?:0[1-9]|1[0-2])$/u.test(record.scopeKey) ||
       (payload && (payload.origin !== record.identity || record.scopeKey !== `month:${payload.datasetMonth}`)))) {
    throw new Error("Traffic cache CrUX BigQuery identity or scope does not match its payload");
  }
  const { fetchedAt, coverageStartedAt, coverageEndedAt } = assertStoredTiming(
    record.source,
    payload,
    record,
    { cache: true }
  );
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
    coverageStartedAt,
    coverageEndedAt,
    expiresAt
  };
}

export function leadTrafficEnrichmentRecordToCreate(id, runId, leadId, record) {
  if (!PUBLISHED_STATES.has(record.state)) throw new Error("Published traffic state is invalid");
  if (record.source !== "dataforseo" && record.state === "partial") {
    throw new Error("Published component state is invalid");
  }
  const payload = normalizedPayload(
    record.source,
    record.state,
    record.normalizedPayload,
    PUBLISHED_PAYLOAD_SCHEMAS
  );
  if (typeof record.contractVersion !== "string" || !record.contractVersion) {
    throw new Error("Published traffic contract version is invalid");
  }
  const storageContract = SOURCE_STORAGE_CONTRACTS[record.source];
  if (!storageContract || record.contractVersion !== storageContract.contractVersion) {
    throw new Error("Published traffic source contract is invalid");
  }
  if (record.source === "dataforseo" && payload &&
      payload.records.some(({ contractVersion }) => contractVersion !== record.contractVersion)) {
    throw new Error("Published traffic contract version does not match its payload");
  }
  if (record.source === "dataforseo" && payload &&
      ((record.state === "available") !== (payload.records.length === 10))) {
    throw new Error("Published DataForSEO state does not match its scopes");
  }
  if (record.source !== "dataforseo" && payload &&
      payload.contractVersion !== record.contractVersion) {
    throw new Error("Published traffic contract version does not match its payload");
  }
  let timing;
  if (record.source === "dataforseo" && payload) {
    const fetchedAt = requiredDate(record.fetchedAt, "fetchedAt");
    const newestPayloadTime = Math.max(...payload.records.map(({ fetchedAt: value }) =>
      requiredDate(value, "payload.fetchedAt").getTime()));
    if (fetchedAt.getTime() !== newestPayloadTime ||
        record.coverageStartedAt != null || record.coverageEndedAt != null) {
      throw new Error("Published DataForSEO timing does not match its payload");
    }
    timing = { fetchedAt, coverageStartedAt: null, coverageEndedAt: null };
  } else if (payload) {
    timing = assertStoredTiming(record.source, payload, record);
  } else {
    if (record.fetchedAt != null || record.coverageStartedAt != null ||
        record.coverageEndedAt != null) {
      throw new Error("Non-material published enrichment cannot contain timing");
    }
    timing = { fetchedAt: null, coverageStartedAt: null, coverageEndedAt: null };
  }
  return {
    id,
    runId,
    leadId,
    source: record.source,
    state: record.state,
    contractVersion: record.contractVersion,
    normalizedPayload: payload,
    ...timing
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

function publicState(value) {
  return PUBLIC_SOURCE_STATES.has(value) ? value : "unavailable";
}

function isoValue(value) {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function dataForSeoMetrics(metrics) {
  return {
    estimated_google_search_traffic: metrics.organic.etv + metrics.paid.etv,
    organic_estimated_traffic: metrics.organic.etv,
    organic_keyword_count: metrics.organic.count,
    paid_estimated_traffic: metrics.paid.etv,
    paid_keyword_count: metrics.paid.count,
    featured_snippet_estimated_traffic: metrics.featuredSnippet.etv,
    featured_snippet_keyword_count: metrics.featuredSnippet.count,
    local_pack_estimated_traffic: metrics.localPack.etv,
    local_pack_keyword_count: metrics.localPack.count
  };
}

function validatedPublishedRow(row, source) {
  if (!row) return null;
  try {
    const payload = row.normalizedPayload;
    const compatibilityTiming = source === "crux_rest" && payload
      ? {
          coverageStartedAt: payload.collectionPeriod?.firstDate,
          coverageEndedAt: payload.collectionPeriod?.lastDate
        }
      : {};
    return leadTrafficEnrichmentRecordToCreate(
      "traffic_validation",
      "run_validation",
      "lead_validation",
      {
        ...compatibilityTiming,
        ...row,
        source,
        contractVersion: Object.hasOwn(row, "contractVersion")
          ? row.contractVersion
          : SOURCE_STORAGE_CONTRACTS[source]?.contractVersion,
        fetchedAt: Object.hasOwn(row, "fetchedAt") ? row.fetchedAt : payload?.fetchedAt
      }
    );
  } catch {
    return null;
  }
}

function materializeDataForSeo(row) {
  const state = publicState(row?.state);
  const validated = validatedPublishedRow(row, "dataforseo");
  const parsed = PUBLISHED_PAYLOAD_SCHEMAS.dataforseo.safeParse(validated?.normalizedPayload);
  if (!parsed.success && ["available", "partial"].includes(state)) {
    return { value: { state: "unavailable" }, material: false };
  }
  if (!parsed.success || !["available", "partial"].includes(state)) {
    return { value: { state }, material: false };
  }
  const worldwideRecord = parsed.data.records.find(({ scope }) => scope === "worldwide");
  const countryRecords = new Map(parsed.data.records
    .filter(({ scope }) => scope !== "worldwide")
    .map((record) => [record.scope.countryIsoCode, record]));
  const value = {
    state,
    label: "Estimated Google search traffic",
    ...(worldwideRecord && {
      target: worldwideRecord.target,
      worldwide: dataForSeoMetrics(worldwideRecord.metrics)
    }),
    markets: DATAFORSEO_COUNTRY_ORDER.flatMap((country_code) => {
      const record = countryRecords.get(country_code);
      return record ? [{ country_code, ...dataForSeoMetrics(record.metrics) }] : [];
    }),
    ...(isoValue(validated.fetchedAt) && { observed_at: isoValue(validated.fetchedAt) })
  };
  return { value, material: Boolean(worldwideRecord || countryRecords.size) };
}

function cruxRestMetrics(payload) {
  return {
    ...(payload.metrics.largestContentfulPaintP75Ms != null && {
      largest_contentful_paint_p75_ms: payload.metrics.largestContentfulPaintP75Ms
    }),
    ...(payload.metrics.interactionToNextPaintP75Ms != null && {
      interaction_to_next_paint_p75_ms: payload.metrics.interactionToNextPaintP75Ms
    }),
    ...(payload.metrics.cumulativeLayoutShiftP75 != null && {
      cumulative_layout_shift_p75: payload.metrics.cumulativeLayoutShiftP75
    }),
    ...(payload.metrics.firstContentfulPaintP75Ms != null && {
      first_contentful_paint_p75_ms: payload.metrics.firstContentfulPaintP75Ms
    }),
    ...(payload.metrics.timeToFirstByteP75Ms != null && {
      time_to_first_byte_p75_ms: payload.metrics.timeToFirstByteP75Ms
    })
  };
}

function materializeCruxComponent(row, source) {
  const state = publicState(row?.state);
  const validated = validatedPublishedRow(row, source);
  const parsed = PUBLISHED_PAYLOAD_SCHEMAS[source].safeParse(validated?.normalizedPayload);
  if (!parsed.success && state === "available") {
    return { value: { state: "unavailable" }, material: false };
  }
  if (!parsed.success || state !== "available") return { value: { state }, material: false };
  if (source === "crux_rest") {
    const metrics = cruxRestMetrics(parsed.data);
    const material = Object.keys(metrics).length > 0 || parsed.data.formFactors != null;
    return {
      value: {
        state,
        origin: parsed.data.origin,
        metrics,
        ...(parsed.data.formFactors && {
          observed_form_factor_fractions: {
            desktop: parsed.data.formFactors.desktop,
            phone: parsed.data.formFactors.phone,
            tablet: parsed.data.formFactors.tablet
          }
        }),
        collection_period: {
          first_date: parsed.data.collectionPeriod.firstDate,
          last_date: parsed.data.collectionPeriod.lastDate
        },
        observed_at: parsed.data.fetchedAt
      },
      material
    };
  }
  return {
    value: {
      state,
      origin: parsed.data.origin,
      label: "Coarse CrUX navigation popularity rank",
      dataset_month: parsed.data.datasetMonth,
      popularity_rank: parsed.data.popularityRank,
      popularity_band: `top_${parsed.data.popularityRank}`,
      observed_device_fractions: {
        phone: parsed.data.deviceFractions.phone,
        desktop: parsed.data.deviceFractions.desktop,
        tablet: parsed.data.deviceFractions.tablet
      },
      observed_at: parsed.data.fetchedAt
    },
    material: true
  };
}

function combinedCruxState(rest, popularity) {
  const states = [rest.value.state, popularity.value.state];
  const materialCount = Number(rest.material) + Number(popularity.material);
  if (materialCount === 2) return "available";
  if (materialCount === 1) return "partial";
  if (states.every((state) => state === "no_coverage")) return "no_coverage";
  return "unavailable";
}

export function serializeTrafficEnrichment(rows, runSnapshot) {
  const dataForSeoEnabled = runSnapshot?.dataForSeo?.enabled === true;
  const cruxEnabled = runSnapshot?.crux?.enabled === true;
  if (!dataForSeoEnabled && !cruxEnabled) return undefined;
  const bySource = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.source, row]));
  const value = { version: PUBLIC_TRAFFIC_VERSION };
  const sources = [];
  const attributions = [];
  if (dataForSeoEnabled) {
    const dataForSeo = materializeDataForSeo(bySource.get("dataforseo"));
    value.dataforseo = dataForSeo.value;
    if (dataForSeo.material) {
      sources.push("dataforseo");
      attributions.push(DATAFORSEO_ATTRIBUTION);
    }
  }
  if (cruxEnabled) {
    let rest = materializeCruxComponent(bySource.get("crux_rest"), "crux_rest");
    let popularity = materializeCruxComponent(
      bySource.get("crux_bigquery"), "crux_bigquery"
    );
    if (rest.material && popularity.material &&
        rest.value.origin !== popularity.value.origin) {
      rest = { value: { state: "unavailable" }, material: false };
      popularity = { value: { state: "unavailable" }, material: false };
    }
    value.crux = {
      state: combinedCruxState(rest, popularity),
      origin_metrics: rest.value,
      popularity: popularity.value
    };
    if (rest.material || popularity.material) {
      sources.push("crux");
      attributions.push(CRUX_ATTRIBUTION);
    }
  }
  if (sources.length) {
    value.traffic_sources = sources;
    value.traffic_attributions = attributions;
  }
  return value;
}

export function serializeCurrentShopTraffic(cacheRows, shop) {
  const rows = Array.isArray(cacheRows) ? cacheRows : [];
  const hostnames = new Set(
    [shop?.stableKey, shop?.resolvedDomain, shop?.myshopifyDomain]
      .filter(Boolean)
      .map((value) => value.toLowerCase())
  );
  const origins = new Set();
  for (const value of [shop?.canonicalUrl, shop?.resolvedDomain && `https://${shop.resolvedDomain}`]) {
    if (!value) continue;
    try { origins.add(new URL(value).origin); } catch { /* Ignore invalid durable URLs. */ }
  }
  const selected = [];
  const dataForSeoRows = rows.filter((row) =>
    row.source === "dataforseo" && hostnames.has(row.identity.toLowerCase()));
  const availableDataForSeo = dataForSeoRows
    .filter((row) => row.state === "available" && row.normalizedPayload)
    .filter((row, index, all) => all.findIndex((item) => item.scopeKey === row.scopeKey) === index)
    .sort((left, right) => {
      const position = (scope) => scope === "worldwide"
        ? -1
        : DATAFORSEO_COUNTRY_ORDER.indexOf(scope.split(":")[1]);
      return position(left.scopeKey) - position(right.scopeKey);
    });
  if (availableDataForSeo.length) {
    selected.push({
      source: "dataforseo",
      state: availableDataForSeo.length === 10 ? "available" : "partial",
      contractVersion: "dataforseo-traffic-v1",
      normalizedPayload: { records: availableDataForSeo.map((row) => row.normalizedPayload) },
      fetchedAt: new Date(Math.max(...availableDataForSeo.map((row) =>
        new Date(row.fetchedAt).getTime()))),
      coverageStartedAt: null,
      coverageEndedAt: null
    });
  } else if (dataForSeoRows.some((row) => row.state === "no_coverage")) {
    selected.push({ source: "dataforseo", state: "no_coverage", normalizedPayload: null });
  }
  for (const source of ["crux_rest", "crux_bigquery"]) {
    const row = rows.find((item) => item.source === source && origins.has(item.identity));
    if (row) selected.push({ ...row, state: row.state === "available" ? "available" : "no_coverage" });
  }
  return serializeTrafficEnrichment(selected, {
    dataForSeo: { enabled: true },
    crux: { enabled: true }
  });
}

function emptyPublicDataForSeoMetrics() {
  return Object.fromEntries(DATAFORSEO_METRIC_KEYS.map((key) => [key, 0]));
}

function addPublicDataForSeoMetrics(target, source) {
  for (const key of DATAFORSEO_METRIC_KEYS) {
    const value = target[key] + source[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Traffic overview metric aggregation is invalid");
    }
    target[key] = value;
  }
}

export function serializeTrafficOverview(runId, leads, runSnapshot, search = null) {
  let worldwide;
  let leadsWithTraffic = 0;
  const markets = new Map();
  const queryGroups = new Map();
  const safeLeads = Array.isArray(leads) ? leads : [];

  for (const lead of safeLeads) {
    const enrichment = serializeTrafficEnrichment(
      lead.trafficEnrichments,
      runSnapshot
    );
    const traffic = enrichment?.dataforseo;
    const query = typeof lead.generatedQuery === "string" && lead.generatedQuery.trim()
      ? lead.generatedQuery.trim()
      : typeof lead.searchQuery === "string" && lead.searchQuery.trim()
        ? lead.searchQuery.trim()
        : null;
    const queryKey = query || "__unattributed__";
    let queryGroup = queryGroups.get(queryKey);
    if (!queryGroup) {
      queryGroup = {
        query,
        shopsFound: 0,
        leadsWithTraffic: 0,
        worldwide: undefined,
        markets: new Map()
      };
      queryGroups.set(queryKey, queryGroup);
    }
    queryGroup.shopsFound += 1;
    if (!traffic?.worldwide && !traffic?.markets?.length) continue;
    leadsWithTraffic += 1;
    queryGroup.leadsWithTraffic += 1;
    if (traffic.worldwide) {
      worldwide ??= emptyPublicDataForSeoMetrics();
      addPublicDataForSeoMetrics(worldwide, traffic.worldwide);
      queryGroup.worldwide ??= emptyPublicDataForSeoMetrics();
      addPublicDataForSeoMetrics(queryGroup.worldwide, traffic.worldwide);
    }
    for (const market of traffic.markets || []) {
      let aggregate = markets.get(market.country_code);
      if (!aggregate) {
        aggregate = {
          country_code: market.country_code,
          ...emptyPublicDataForSeoMetrics()
        };
        markets.set(market.country_code, aggregate);
      }
      addPublicDataForSeoMetrics(aggregate, market);
      let queryMarket = queryGroup.markets.get(market.country_code);
      if (!queryMarket) {
        queryMarket = {
          country_code: market.country_code,
          ...emptyPublicDataForSeoMetrics()
        };
        queryGroup.markets.set(market.country_code, queryMarket);
      }
      addPublicDataForSeoMetrics(queryMarket, market);
    }
  }

  return {
    version: "traffic-overview-v1",
    runId,
    scope: {
      search,
      matchedLeads: safeLeads.length,
      leadsWithTraffic
    },
    ...(worldwide ? { worldwide } : {}),
    markets: DATAFORSEO_COUNTRY_ORDER.flatMap((countryCode) => {
      const market = markets.get(countryCode);
      return market ? [market] : [];
    }),
    queries: [...queryGroups.values()]
      .map((group) => ({
        query: group.query,
        shopsFound: group.shopsFound,
        leadsWithTraffic: group.leadsWithTraffic,
        ...(group.worldwide ? { worldwide: group.worldwide } : {}),
        markets: DATAFORSEO_COUNTRY_ORDER.flatMap((countryCode) => {
          const market = group.markets.get(countryCode);
          return market ? [market] : [];
        })
      }))
      .sort((left, right) =>
        (right.worldwide?.estimated_google_search_traffic ?? 0)
        - (left.worldwide?.estimated_google_search_traffic ?? 0)
        || (left.query ?? "").localeCompare(right.query ?? "")
      )
  };
}

export function serializeLead(lead, { trafficEnrichments, trafficEnrichmentConfig } = {}) {
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
  const trafficEnrichment = serializeTrafficEnrichment(
    trafficEnrichments,
    trafficEnrichmentConfig
  );
  if (trafficEnrichment) item.traffic_enrichment = trafficEnrichment;
  return item;
}

export function runResultsAvailable(run) {
  if (!run?.resultsAvailable) return false;
  const requiresV3 = run.trafficEnrichmentConfig?.dataForSeo?.enabled === true;
  return !requiresV3 || run.scoringVersion === 3;
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
    categories: Array.isArray(run.normalizedShopTypes)
      ? run.normalizedShopTypes.map((category) => ({
          originalShopType: category?.originalShopType || "",
          shopType: category?.shopType || "",
          businessQualifier: category?.businessQualifier || "unspecified"
        }))
      : [],
    state: run.state,
    phase: run.phase || null,
    stage: run.stage,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() || null,
    completedAt: run.completedAt?.toISOString() || null,
    progress,
    resultsAvailable: runResultsAvailable(run),
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
      : null,
    ...(run.queryPlanSource === "keyword_research"
      ? {
          queryPlanSource: "keyword_research",
          keywordResearchId: run.keywordResearchId,
          keywordSelectionRevision: run.keywordSelectionRevision
        }
      : {})
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
    probedAt: row.probedAt?.toISOString?.() || (row.probedAt ? new Date(row.probedAt).toISOString() : null),
    ...(row.keywordResearchItemId != null ? { keywordResearchItemId: row.keywordResearchItemId } : {})
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

export function serializeSelectionItem(item) {
  return {
    itemId: item.itemId,
    sourceKind: item.sourceKind,
    sourceKeywordId: item.sourceKeywordId ?? null,
    originalKeyword: item.originalKeyword,
    keyword: item.keyword,
    sourceSeeds: Array.isArray(item.sourceSeeds) ? item.sourceSeeds : [],
    lane: item.lane,
    facets: item.facets,
    metricsSnapshot: item.metricsSnapshot ?? null
  };
}

function keywordResearchStage(research) {
  const stages = Array.isArray(research.stages) ? research.stages : [];
  const latestByStage = new Map();
  for (const stage of stages) {
    if (stage && typeof stage.stage === "string") latestByStage.set(stage.stage, stage);
  }
  let stage;
  if (research.state === "completed") {
    stage = "completed";
  } else if (research.state === "failed") {
    stage = "failed";
  } else if (stages.length === 0) {
    stage = "queued";
  } else {
    stage = "finalizing";
    for (const name of ["expansion", "anchor_screen", "market_overview"]) {
      const row = latestByStage.get(name);
      if (!row || row.state !== "completed") {
        stage = name;
        break;
      }
    }
  }
  return { stage, latestByStage };
}

export function serializeKeywordResearchSummary(research) {
  const { stage } = keywordResearchStage(research);
  return {
    researchId: research.id,
    seeds: Array.isArray(research.seeds) ? research.seeds : [],
    state: research.state,
    stage,
    selectionRevision: research.selectionRevision ?? 0,
    createdAt: research.createdAt.toISOString(),
    updatedAt: research.updatedAt.toISOString(),
    completedAt: research.completedAt ? research.completedAt.toISOString() : null
  };
}

export function serializeKeywordResearch(research) {
  const { stage, latestByStage } = keywordResearchStage(research);
  const stageCounts = (name) => {
    const row = latestByStage.get(name);
    return {
      expected: row?.expectedCount ?? 0,
      terminal: row?.terminalCount ?? 0,
      succeeded: row?.succeededCount ?? 0,
      skipped: row?.skippedCount ?? 0,
      failed: row?.failedCount ?? 0
    };
  };
  return {
    id: research.id,
    statusUrl: `/api/keyword-research/${encodeURIComponent(research.id)}`,
    state: research.state,
    generation: research.generation,
    contractVersion: research.contractVersion,
    seeds: Array.isArray(research.seeds) ? research.seeds : [],
    markets: Array.isArray(research.markets) ? research.markets : [],
    progress: {
      stage,
      expansion: stageCounts("expansion"),
      anchorScreen: stageCounts("anchor_screen"),
      marketOverview: stageCounts("market_overview")
    },
    result: research.state === "completed" ? (research.result ?? null) : null,
    selection: Array.isArray(research.selection?.items)
      ? research.selection.items.map(serializeSelectionItem)
      : [],
    selectionRevision: research.selectionRevision ?? 0,
    selectionConflicts: Array.isArray(research.selectionConflicts) ? research.selectionConflicts : [],
    safeError: research.safeErrorCode
      ? { code: research.safeErrorCode, message: research.safeErrorMessage ?? "" }
      : null,
    createdAt: research.createdAt.toISOString(),
    startedAt: research.startedAt ? research.startedAt.toISOString() : null,
    completedAt: research.completedAt ? research.completedAt.toISOString() : null,
    updatedAt: research.updatedAt.toISOString()
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
