import fs from "node:fs/promises";
import path from "node:path";
import { stringifyCsv } from "./csv.js";
import { assertPublicLeadScoreState } from "./lead-state.js";

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
  "discovery_occurrences",
  "matched_categories",
  "original_shop_type"
];

export async function writeOutput(filePath, records) {
  records.forEach(assertPublicLeadScoreState);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  const normalized = records.map((record) => ({
    ...record,
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
    await fs.writeFile(temporaryPath, stringifyCsv(normalized, OUTPUT_HEADERS), "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
