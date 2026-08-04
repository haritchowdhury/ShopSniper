import fs from "node:fs/promises";
import path from "node:path";
import { stringifyCsv } from "./csv.js";
import { assertPublicLeadScoreState } from "./lead-state.js";
import { parsePublicTrafficEnrichment } from "./api-serializer.js";

export const OUTPUT_HEADERS = [
  "shop_type",
  "generated_query",
  "query_score",
  "query_generation_reason",
  "search_query",
  "google_rank",
  "google_result_url",
  "myshopify_domain",
  "final_url",
  "canonical_url",
  "resolved_domain",
  "store_name",
  "email",
  "email_source_url",
  "phone",
  "phone_source_url",
  "contact_url",
  "social_profiles",
  "additional_information",
  "shopify_confidence",
  "relevance_score",
  "lead_score",
  "status",
  "rejection_reason",
  "error",
  "business_qualifier",
  "pipeline_version",
  "scoring_version",
  "store_fit_state",
  "store_fit_evidence",
  "contactability_tier",
  "contact_evidence",
  "identity_confidence",
  "identity_evidence",
  "score_breakdown",
  "score_semantics",
  "discovery_occurrences",
  "matched_categories",
  "original_shop_type"
];

const TRAFFIC_METRIC_COLUMNS = Object.freeze([
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
const DATAFORSEO_MARKETS = Object.freeze(["US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"]);
const DATAFORSEO_HEADERS = Object.freeze([
  "dataforseo_state",
  "dataforseo_label",
  ...TRAFFIC_METRIC_COLUMNS.map((field) => `dataforseo_worldwide_${field}`),
  ...DATAFORSEO_MARKETS.flatMap((country) =>
    TRAFFIC_METRIC_COLUMNS.map((field) => `dataforseo_${country.toLowerCase()}_${field}`)
  ),
  "dataforseo_observed_at"
]);
const CRUX_HEADERS = Object.freeze([
  "crux_state",
  "crux_origin_metrics_state",
  "crux_origin",
  "crux_largest_contentful_paint_p75_ms",
  "crux_interaction_to_next_paint_p75_ms",
  "crux_cumulative_layout_shift_p75",
  "crux_first_contentful_paint_p75_ms",
  "crux_time_to_first_byte_p75_ms",
  "crux_observed_desktop_fraction",
  "crux_observed_phone_fraction",
  "crux_observed_tablet_fraction",
  "crux_collection_first_date",
  "crux_collection_last_date",
  "crux_origin_metrics_observed_at",
  "crux_popularity_state",
  "crux_popularity_label",
  "crux_popularity_dataset_month",
  "crux_popularity_rank",
  "crux_popularity_band",
  "crux_popularity_phone_fraction",
  "crux_popularity_desktop_fraction",
  "crux_popularity_tablet_fraction",
  "crux_popularity_observed_at"
]);
const TRAFFIC_PROVENANCE_HEADERS = Object.freeze([
  "traffic_sources",
  "traffic_attribution_text",
  "traffic_source_urls",
  "traffic_license_urls",
  "traffic_transformations"
]);

function validateTrafficRecords(records) {
  return records.map((record) => record.traffic_enrichment == null
    ? record
    : { ...record, traffic_enrichment: parsePublicTrafficEnrichment(record.traffic_enrichment) });
}

function headersForValidatedRecords(records) {
  const enrichments = records.map(({ traffic_enrichment }) => traffic_enrichment)
    .filter((value) => value && typeof value === "object");
  const hasDataForSeo = enrichments.some(({ dataforseo }) => dataforseo != null);
  const hasCrux = enrichments.some(({ crux }) => crux != null);
  const hasMaterial = enrichments.some(({ traffic_sources }) =>
    Array.isArray(traffic_sources) && traffic_sources.length > 0
  );
  return [
    ...OUTPUT_HEADERS,
    ...(hasDataForSeo ? DATAFORSEO_HEADERS : []),
    ...(hasCrux ? CRUX_HEADERS : []),
    ...(hasMaterial ? TRAFFIC_PROVENANCE_HEADERS : [])
  ];
}

export function outputHeaders(records) {
  return headersForValidatedRecords(validateTrafficRecords(records));
}

function trafficCsvFields(record) {
  const enrichment = record.traffic_enrichment;
  if (!enrichment || typeof enrichment !== "object") return {};
  const output = {};
  if (enrichment.dataforseo) {
    const source = enrichment.dataforseo;
    output.dataforseo_state = source.state;
    output.dataforseo_label = source.label;
    for (const field of TRAFFIC_METRIC_COLUMNS) {
      output[`dataforseo_worldwide_${field}`] = source.worldwide?.[field];
    }
    const markets = new Map(
      (Array.isArray(source.markets) ? source.markets : [])
        .map((market) => [market.country_code, market])
    );
    for (const country of DATAFORSEO_MARKETS) {
      for (const field of TRAFFIC_METRIC_COLUMNS) {
        output[`dataforseo_${country.toLowerCase()}_${field}`] = markets.get(country)?.[field];
      }
    }
    output.dataforseo_observed_at = source.observed_at;
  }
  if (enrichment.crux) {
    const source = enrichment.crux;
    const rest = source.origin_metrics || {};
    const popularity = source.popularity || {};
    output.crux_state = source.state;
    output.crux_origin_metrics_state = rest.state;
    output.crux_origin = rest.origin || popularity.origin;
    output.crux_largest_contentful_paint_p75_ms = rest.metrics?.largest_contentful_paint_p75_ms;
    output.crux_interaction_to_next_paint_p75_ms = rest.metrics?.interaction_to_next_paint_p75_ms;
    output.crux_cumulative_layout_shift_p75 = rest.metrics?.cumulative_layout_shift_p75;
    output.crux_first_contentful_paint_p75_ms = rest.metrics?.first_contentful_paint_p75_ms;
    output.crux_time_to_first_byte_p75_ms = rest.metrics?.time_to_first_byte_p75_ms;
    output.crux_observed_desktop_fraction = rest.observed_form_factor_fractions?.desktop;
    output.crux_observed_phone_fraction = rest.observed_form_factor_fractions?.phone;
    output.crux_observed_tablet_fraction = rest.observed_form_factor_fractions?.tablet;
    output.crux_collection_first_date = rest.collection_period?.first_date;
    output.crux_collection_last_date = rest.collection_period?.last_date;
    output.crux_origin_metrics_observed_at = rest.observed_at;
    output.crux_popularity_state = popularity.state;
    output.crux_popularity_label = popularity.label;
    output.crux_popularity_dataset_month = popularity.dataset_month;
    output.crux_popularity_rank = popularity.popularity_rank;
    output.crux_popularity_band = popularity.popularity_band;
    output.crux_popularity_phone_fraction = popularity.observed_device_fractions?.phone;
    output.crux_popularity_desktop_fraction = popularity.observed_device_fractions?.desktop;
    output.crux_popularity_tablet_fraction = popularity.observed_device_fractions?.tablet;
    output.crux_popularity_observed_at = popularity.observed_at;
  }
  const attributions = Array.isArray(enrichment.traffic_attributions)
    ? enrichment.traffic_attributions
    : [];
  if (Array.isArray(enrichment.traffic_sources) && enrichment.traffic_sources.length) {
    output.traffic_sources = enrichment.traffic_sources.join(" | ");
    output.traffic_attribution_text = attributions.map(({ text }) => text).filter(Boolean).join(" | ");
    output.traffic_source_urls = attributions.map(({ source_url }) => source_url).filter(Boolean).join(" | ");
    output.traffic_license_urls = attributions.map(({ license_url }) => license_url).filter(Boolean).join(" | ");
    output.traffic_transformations = attributions.map(({ transformation }) => transformation)
      .filter(Boolean).join(" | ");
  }
  return output;
}

export async function writeOutput(filePath, records) {
  records.forEach(assertPublicLeadScoreState);
  const validatedRecords = validateTrafficRecords(records);
  const headers = headersForValidatedRecords(validatedRecords);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  const normalized = validatedRecords.map((record) => ({
    ...record,
    ...trafficCsvFields(record),
    social_profiles: Array.isArray(record.social_profiles)
      ? JSON.stringify(record.social_profiles)
      : record.social_profiles || "",
    ...Object.fromEntries([
      "store_fit_evidence",
      "contact_evidence",
      "identity_evidence",
      "score_breakdown",
      "discovery_occurrences",
      "matched_categories"
    ].map((field) => [
      field,
      record[field] == null || record[field] === "" ? "" : JSON.stringify(record[field])
    ]))
  }));

  try {
    await fs.writeFile(temporaryPath, stringifyCsv(normalized, headers), "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
