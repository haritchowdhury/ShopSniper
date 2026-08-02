import { ENRICHMENT_ERROR_CODES, cruxError } from "../errors.js";
import { parseCruxApiResponse } from "./api-contract.js";
import { executeCruxApiRequest } from "./api-client.js";
import {
  CRUX_API_RESPONSE_CONTRACT_VERSION,
  CRUX_ORIGIN_METRICS_CONTRACT_VERSION,
  buildCruxApiRequest
} from "./api-request.js";
import {
  parseCruxBigQueryDryRun,
  parseCruxBigQueryResponse,
  parseCruxTableList
} from "./bigquery-contract.js";
import { executeCruxBigQueryRequest } from "./bigquery-client.js";
import {
  CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION,
  CRUX_POPULARITY_CONTRACT_VERSION,
  buildCruxBigQueryDryRunRequest,
  buildCruxBigQueryLiveRequest,
  buildCruxTableListRequest
} from "./bigquery-request.js";

function fetchedAtFrom(now, contractVersion) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw cruxError(
      ENRICHMENT_ERROR_CODES.invalidRequest,
      "CrUX fetchedAt clock is invalid",
      contractVersion
    );
  }
  return date.toISOString();
}

export function normalizeCruxOriginMetricsResponse(
  { descriptor, body },
  { now = () => new Date() } = {}
) {
  const fetchedAt = fetchedAtFrom(now, CRUX_API_RESPONSE_CONTRACT_VERSION);
  if (body?.coverage === "unavailable") {
    return Object.freeze({
      contractVersion: CRUX_ORIGIN_METRICS_CONTRACT_VERSION,
      origin: descriptor.origin,
      coverage: "unavailable",
      reason: body.reason,
      fetchedAt
    });
  }
  const parsed = parseCruxApiResponse(body, descriptor);
  return Object.freeze({
    contractVersion: CRUX_ORIGIN_METRICS_CONTRACT_VERSION,
    origin: descriptor.origin,
    coverage: "available",
    metrics: parsed.metrics,
    ...(parsed.formFactors && { formFactors: parsed.formFactors }),
    collectionPeriod: parsed.collectionPeriod,
    fetchedAt
  });
}

export async function fetchCruxOriginMetrics(
  { origin, config },
  { request, now = () => new Date() } = {}
) {
  const descriptor = buildCruxApiRequest(origin);
  const body = await executeCruxApiRequest(descriptor, config, { request });
  return normalizeCruxOriginMetricsResponse({ descriptor, body }, { now });
}

export async function fetchCruxPopularity(
  { origins, config },
  { request, tokenProvider, now = () => new Date() } = {}
) {
  const execute = (descriptor) => executeCruxBigQueryRequest(descriptor, config, {
    request,
    tokenProvider
  });
  const tableBody = await execute(buildCruxTableListRequest());
  const datasetMonth = parseCruxTableList(tableBody);
  const common = {
    origins,
    month: datasetMonth,
    projectId: config.cruxBigQueryProjectId,
    location: config.cruxBigQueryLocation
  };
  const dryDescriptor = buildCruxBigQueryDryRunRequest(common);
  const dryRun = parseCruxBigQueryDryRun(await execute(dryDescriptor));
  if (dryRun.bytesProcessed > config.cruxBigQueryMaxBytesBilled) {
    throw cruxError(
      ENRICHMENT_ERROR_CODES.providerRejected,
      "CrUX BigQuery dry run exceeds the configured byte cap",
      CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION
    );
  }
  const liveDescriptor = buildCruxBigQueryLiveRequest({
    ...common,
    maximumBytesBilled: config.cruxBigQueryMaxBytesBilled
  });
  const parsed = parseCruxBigQueryResponse(await execute(liveDescriptor), liveDescriptor);
  const fetchedAt = fetchedAtFrom(now, CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION);
  const records = liveDescriptor.origins.map((origin) => {
    const row = parsed.rowsByOrigin.get(origin);
    if (!row) {
      return Object.freeze({
        contractVersion: CRUX_POPULARITY_CONTRACT_VERSION,
        origin,
        coverage: "unavailable",
        reason: "no_coverage",
        datasetMonth,
        fetchedAt
      });
    }
    return Object.freeze({
      contractVersion: CRUX_POPULARITY_CONTRACT_VERSION,
      origin,
      coverage: "available",
      datasetMonth,
      popularityRank: row.popularity_rank,
      deviceFractions: Object.freeze({
        phone: row.phone_density,
        desktop: row.desktop_density,
        tablet: row.tablet_density
      }),
      fetchedAt
    });
  });
  return Object.freeze({
    datasetMonth,
    records: Object.freeze(records),
    dryRunBytesProcessed: dryRun.bytesProcessed,
    bytesProcessed: parsed.bytesProcessed,
    bytesBilled: parsed.bytesBilled,
    cacheHit: parsed.cacheHit
  });
}
