import { z } from "zod";
import {
  DATAFORSEO_COUNTRY_LOCATION_CODES, DATAFORSEO_ITEM_TYPES, DATAFORSEO_RESPONSE_CONTRACT_VERSION,
  DATAFORSEO_TARGET_LIMIT, DATAFORSEO_TRAFFIC_CONTRACT_VERSION
} from "../../enrichment/dataforseo/request.js";
import {
  CRUX_API_RESPONSE_CONTRACT_VERSION, CRUX_METRICS, CRUX_ORIGIN_METRICS_CONTRACT_VERSION
} from "../../enrichment/crux/api-request.js";
import {
  CRUX_BIGQUERY_ORIGIN_LIMIT, CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION, CRUX_POPULARITY_CONTRACT_VERSION
} from "../../enrichment/crux/bigquery-request.js";
import { PipelineInvariantError } from "./errors.js";
import { canonicalJson } from "../core/canonical.js";

const metricKey = (values) => [...values].sort().join(",");
const exactJson = (expected) => z.unknown().superRefine((value, context) => {
  try {
    if (canonicalJson(value) !== canonicalJson(expected)) context.addIssue({ code: "custom", message: "constant drift" });
  } catch { context.addIssue({ code: "custom", message: "constant drift" }); }
}).transform(() => structuredClone(expected));
const expectedScopes = ["worldwide", ...Object.entries(DATAFORSEO_COUNTRY_LOCATION_CODES)
  .map(([countryIsoCode, locationCode]) => ({ countryIsoCode, locationCode }))];
const bigQueryMetrics = ["popularity_rank", "phone_density", "desktop_density", "tablet_density"];

export const trafficRunConfigSchema = z.object({
  version: z.literal("traffic-enrichment-run-v1"),
  dataForSeo: z.object({
    enabled: z.boolean(), scopes: exactJson(expectedScopes),
    contractVersion: z.literal(DATAFORSEO_TRAFFIC_CONTRACT_VERSION),
    responseContractVersion: z.literal(DATAFORSEO_RESPONSE_CONTRACT_VERSION),
    metricSet: exactJson([...DATAFORSEO_ITEM_TYPES]), metricSetKey: z.literal(metricKey(DATAFORSEO_ITEM_TYPES)),
    targetLimit: z.literal(DATAFORSEO_TARGET_LIMIT),
    cacheFreshnessMs: z.number().finite().min(86400000).max(7776000000),
    noCoverageFreshnessMs: z.number().finite().min(60000).max(604800000),
    maxCostPerRunUsd: z.number().finite().min(0.01).max(1000), estimatedCostPerTaskUsd: z.literal(0.024),
    paidRequestStaleMs: z.number().finite().min(60000).max(86400000)
  }).strict(),
  crux: z.object({
    enabled: z.boolean(),
    rest: z.object({
      contractVersion: z.literal(CRUX_ORIGIN_METRICS_CONTRACT_VERSION),
      responseContractVersion: z.literal(CRUX_API_RESPONSE_CONTRACT_VERSION),
      metricSet: exactJson([...CRUX_METRICS]), metricSetKey: z.literal(metricKey(CRUX_METRICS)),
      concurrency: z.number().int().min(1).max(10),
      cacheFreshnessMs: z.number().finite().min(60000).max(604800000),
      noCoverageFreshnessMs: z.number().finite().min(60000).max(604800000)
    }).strict(),
    bigQuery: z.object({
      contractVersion: z.literal(CRUX_POPULARITY_CONTRACT_VERSION),
      responseContractVersion: z.literal(CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION),
      metricSet: exactJson(bigQueryMetrics), metricSetKey: z.literal(metricKey(bigQueryMetrics)),
      originLimit: z.literal(CRUX_BIGQUERY_ORIGIN_LIMIT), location: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
      maxBytesBilled: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
    }).strict()
  }).strict()
}).strict();

export function parseTrafficRunConfig(value) {
  const result = trafficRunConfigSchema.safeParse(value);
  if (!result.success) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  return result.data;
}
