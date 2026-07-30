import fs from "node:fs/promises";
import path from "node:path";
import { stringifyCsv } from "./csv.js";

export const QUERY_AUDIT_HEADERS = [
  "shop_type",
  "query",
  "query_score",
  "raw_results",
  "relevant_results",
  "unique_hosts",
  "duplicate_products",
  "estimated_results",
  "next_page_available",
  "market_signal",
  "seasonality",
  "query_generation_reason",
  "source_urls",
  "status",
  "rejection_reason"
];

export async function writeQueryAudit(filePath, records) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const normalized = records.map((record) => ({
    ...record,
    source_urls: Array.isArray(record.source_urls)
      ? JSON.stringify(record.source_urls)
      : record.source_urls || ""
  }));

  try {
    await fs.writeFile(
      temporaryPath,
      stringifyCsv(normalized, QUERY_AUDIT_HEADERS),
      "utf8"
    );
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
