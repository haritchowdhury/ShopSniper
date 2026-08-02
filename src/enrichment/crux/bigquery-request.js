import { ENRICHMENT_ERROR_CODES, cruxError } from "../errors.js";
import { normalizeCruxOrigin } from "./api-request.js";

export const CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION =
  "crux-bigquery-json-row-v1";
export const CRUX_POPULARITY_CONTRACT_VERSION = "crux-popularity-v1";
export const CRUX_BIGQUERY_ORIGIN_LIMIT = 1000;
export const CRUX_TABLE_LIST_ENDPOINT =
  "https://bigquery.googleapis.com/bigquery/v2/projects/chrome-ux-report/datasets/all/tables?maxResults=1000";
export const CRUX_BIGQUERY_SQL = `SELECT
  TO_JSON_STRING(STRUCT(
    origin AS origin,
    CAST(yyyymm AS STRING) AS dataset_month,
    rank AS popularity_rank,
    phoneDensity AS phone_density,
    desktopDensity AS desktop_density,
    tabletDensity AS tablet_density
  )) AS payload
FROM \`chrome-ux-report.materialized.metrics_summary\`
WHERE yyyymm = @month
  AND origin IN UNNEST(@origins)
ORDER BY origin`;

function invalidRequest(message) {
  throw cruxError(
    ENRICHMENT_ERROR_CODES.invalidRequest,
    message,
    CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION
  );
}

export function normalizeCruxOrigins(origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    invalidRequest("CrUX BigQuery requires at least one origin");
  }
  if (origins.length > CRUX_BIGQUERY_ORIGIN_LIMIT) {
    invalidRequest("CrUX BigQuery origin limit exceeded");
  }
  const normalized = origins.map(normalizeCruxOrigin);
  if (new Set(normalized).size !== normalized.length) {
    invalidRequest("CrUX BigQuery origins must be unique");
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

export function validateCruxDatasetMonth(month) {
  if (typeof month !== "string" || !/^20\d{4}$/u.test(month)) {
    invalidRequest("CrUX dataset month must use YYYYMM");
  }
  const numericMonth = Number(month.slice(4));
  if (numericMonth < 1 || numericMonth > 12) {
    invalidRequest("CrUX dataset month is invalid");
  }
  return month;
}

export function buildCruxTableListRequest() {
  return Object.freeze({ endpoint: CRUX_TABLE_LIST_ENDPOINT, method: "GET" });
}

function queryParameters(origins, month) {
  return [
    {
      name: "origins",
      parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
      parameterValue: {
        arrayValues: origins.map((origin) => ({ value: origin }))
      }
    },
    {
      name: "month",
      parameterType: { type: "INT64" },
      parameterValue: { value: month }
    }
  ];
}

function baseQuery({ origins, month, projectId, location }) {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(projectId)) {
    invalidRequest("CrUX BigQuery billing project is invalid");
  }
  if (typeof location !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(location)) {
    invalidRequest("CrUX BigQuery location is invalid");
  }
  const normalizedOrigins = normalizeCruxOrigins(origins);
  const normalizedMonth = validateCruxDatasetMonth(month);
  return {
    endpoint: `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries`,
    method: "POST",
    origins: Object.freeze(normalizedOrigins),
    month: normalizedMonth,
    body: {
      query: CRUX_BIGQUERY_SQL,
      useLegacySql: false,
      parameterMode: "NAMED",
      queryParameters: queryParameters(normalizedOrigins, normalizedMonth),
      location
    }
  };
}

export function buildCruxBigQueryDryRunRequest(options) {
  const descriptor = baseQuery(options);
  return Object.freeze({
    ...descriptor,
    kind: "dry_run",
    body: Object.freeze({ ...descriptor.body, dryRun: true })
  });
}

export function buildCruxBigQueryLiveRequest(options) {
  const maximumBytesBilled = options.maximumBytesBilled;
  if (!Number.isSafeInteger(maximumBytesBilled) || maximumBytesBilled < 1) {
    invalidRequest("CrUX BigQuery maximum bytes billed is invalid");
  }
  const descriptor = baseQuery(options);
  return Object.freeze({
    ...descriptor,
    kind: "live",
    body: Object.freeze({
      ...descriptor.body,
      maximumBytesBilled: String(maximumBytesBilled),
      useQueryCache: true,
      timeoutMs: 60000
    })
  });
}
