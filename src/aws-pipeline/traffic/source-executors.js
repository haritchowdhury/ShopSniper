import { stableLeadId } from "../../prisma-run-repository.js";
import { buildDataForSeoRequest, normalizeDataForSeoHostname } from "../../enrichment/dataforseo/request.js";
import { fetchDataForSeoTraffic } from "../../enrichment/dataforseo/adapter.js";
import { normalizeCruxOrigin } from "../../enrichment/crux/api-request.js";
import { dryRunCruxPopularity, fetchCruxLatestDatasetMonth, fetchCruxOriginMetrics,
  fetchCruxPopularityForMonth } from "../../enrichment/crux/adapter.js";
import { eligibleTrafficIdentities, enrichCruxBigQuerySource, enrichCruxRestSource,
  enrichDataForSeoSource } from "../../enrichment/orchestrator.js";
import { PipelineInvariantError } from "../contracts/errors.js";

function validateInput(input) {
  if (!input || typeof input.runId !== "string" || !Number.isInteger(input.generation) ||
      !input.runLease || !input.runSnapshot || !input.providerRuntimeConfig ||
      !Array.isArray(input.leads) || !Array.isArray(input.workPlanEntries) ||
      !Array.isArray(input.reuseRows) || typeof input.assertLeaseActive !== "function" ||
      typeof input.onTelemetry !== "function" || !(input.now instanceof Date))
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const shops = input.workPlanEntries.map(({ shopId }) => shopId);
  if (new Set(shops).size !== shops.length || shops.some((shop, index) => index > 0 && shop <= shops[index - 1]))
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
}

function exactDeps(overrides, defaults) {
  if (Object.keys(overrides || {}).some((key) => !(key in defaults)) ||
      Object.values(overrides || {}).some((value) => typeof value !== "function"))
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  return { ...defaults, ...overrides };
}

async function execute(input, deps, source) {
  validateInput(input);
  const cacheRows = [];
  const reuse = input.reuseRows;
  const repository = {
    getDataForSeoRunCostUsd: async () => 0,
    readReusableTrafficCache: async (_runId, _lease, keys) => keys.flatMap((key) =>
      reuse.filter((row) => row.source === key.source && row.identity === key.identity &&
        row.scopeKey === key.scopeKey && row.metricSetKey === key.metricSetKey &&
        row.contractVersion === key.contractVersion)),
    readReusableLatestCruxBigQueryCache: async (_runId, _lease, identities) => reuse.filter((row) =>
      row.source === "crux_bigquery" && identities.includes(row.identity)),
    claimShopWorkBatch: async (_runId, _lease, claims) => claims.map((work) =>
      ({ outcome: "won", networkAllowed: true, work })),
    planDataForSeoRequest: async () => ({ outcome: "planned" }),
    claimDataForSeoRequest: async () => ({ outcome: "in_flight", networkAllowed: true }),
    markDataForSeoRequestSucceeded: async (_runId, _lease, _fingerprint, value) => {
      cacheRows.push(...value.cacheRows);
    },
    markDataForSeoRequestFailed: async () => {}, markDataForSeoRequestAmbiguous: async () => {},
    saveCruxTrafficCache: async (_runId, _lease, rows) => { cacheRows.push(...rows); },
    finishShopWorkClaims: async () => ({ count: 0 })
  };
  const diagnostics = [];
  const context = { runId: input.runId, lease: input.runLease, runSnapshot: input.runSnapshot,
    runtimeConfig: input.providerRuntimeConfig, repository, now: () => new Date(input.now),
    assertLeaseActive: input.assertLeaseActive, onBatchTelemetry: input.onTelemetry, diagnostics };
  const eligible = eligibleTrafficIdentities(input.runId, input.leads, deps);
  context.dataForSeoShopIds = eligible.dataForSeoShopIds;
  context.originShopIds = eligible.originShopIds;
  const output = source === "dataforseo"
    ? await enrichDataForSeoSource(context, eligible.byDataForSeo, deps)
    : source === "crux_rest"
      ? await enrichCruxRestSource(context, eligible.byOrigin, deps)
      : await enrichCruxBigQuerySource(context, eligible.byOrigin, deps);
  return { sourceResults: output.published, cacheRows, leadTrafficRows: output.published,
    summary: output.summary, diagnostics, telemetry: [] };
}

const identity = { stableLeadId, normalizeDataForSeoHostname, normalizeCruxOrigin,
  waitForTrafficWork: async () => {} };

export function executeDataForSeoSource(input, deps = {}) {
  return execute(input, exactDeps(deps, { ...identity, buildDataForSeoRequest,
    fetchDataForSeoTraffic }), "dataforseo");
}

export function executeCruxRestSource(input, deps = {}) {
  return execute(input, exactDeps(deps, { ...identity, fetchCruxOriginMetrics }), "crux_rest");
}

export function executeCruxBigQuerySource(input, deps = {}) {
  return execute(input, exactDeps(deps, { ...identity, fetchCruxLatestDatasetMonth,
    dryRunCruxPopularity, fetchCruxPopularityForMonth }), "crux_bigquery");
}
