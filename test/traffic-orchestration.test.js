import assert from "node:assert/strict";
import test from "node:test";
import { enrichTraffic } from "../src/enrichment/orchestrator.js";
import { EnrichmentError } from "../src/enrichment/errors.js";
import { trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";

const RUN_ID = "run_trafficorchestration1";
const LEASE = { owner: "worker", token: "lease" };
const NOW = "2026-08-02T12:00:00.000Z";

function lead(index = 0) {
  return {
    status: "qualified",
    resolved_domain: `store-${index}.example`,
    final_url: `https://store-${index}.example/products/item`,
    identity_evidence: { stableHostname: `store-${index}.example` }
  };
}

function snapshot(dataForSeo, crux, overrides = {}) {
  return trafficEnrichmentConfigSnapshot({
    dataForSeoEnrichmentEnabled: dataForSeo,
    dataForSeoMaxCostPerRunUsd: overrides.maxCost ?? 2,
    cruxEnrichmentEnabled: crux,
    cruxRestConcurrency: 2
  });
}

function dataForSeoValue(target, scope) {
  return {
    contractVersion: "dataforseo-traffic-v1",
    target,
    scope,
    languageScope: "all_available",
    metrics: {
      organic: { etv: 10, count: 1 },
      paid: { etv: 0, count: 0 },
      featuredSnippet: { etv: 0, count: 0 },
      localPack: { etv: 0, count: 0 }
    },
    fetchedAt: NOW
  };
}

function normalizedDataForSeoScope(scope) {
  if (scope === "worldwide") return scope;
  const locationCode = snapshot(true, false).dataForSeo.scopes
    .find((entry) => entry.countryIsoCode === scope.countryIsoCode).locationCode;
  return { countryIsoCode: scope.countryIsoCode, locationCode };
}

function cruxRestValue(origin) {
  return {
    contractVersion: "crux-origin-metrics-v1",
    origin,
    coverage: "available",
    metrics: { largestContentfulPaintP75Ms: 1000 },
    collectionPeriod: { firstDate: "2026-07-01", lastDate: "2026-07-28" },
    fetchedAt: NOW
  };
}

function popularityValue(origin, datasetMonth = "202606") {
  return {
    contractVersion: "crux-popularity-v1",
    origin,
    coverage: "available",
    datasetMonth,
    popularityRank: 1000,
    deviceFractions: { phone: 0.7, desktop: 0.29, tablet: 0.01 },
    fetchedAt: NOW
  };
}

class MemoryRepository {
  constructor(cache = []) {
    this.cache = [...cache];
    this.ledger = new Map();
    this.calls = [];
  }

  async getDataForSeoRunCostUsd() {
    this.calls.push("cost");
    return [...this.ledger.values()]
      .filter(({ state }) => state === "succeeded")
      .reduce((total, row) => total + row.providerCostUsd, 0);
  }

  async readFreshTrafficCache(_runId, _lease, keys) {
    this.calls.push("cache.read");
    return this.cache.filter((row) => keys.some((key) =>
      ["source", "identity", "scopeKey", "metricSetKey", "contractVersion"]
        .every((field) => key[field] === row[field])
    ));
  }

  async readFreshLatestCruxBigQueryCache(_runId, _lease, identities) {
    this.calls.push("cache.latest");
    return this.cache.filter((row) =>
      row.source === "crux_bigquery" && identities.includes(row.identity)
    );
  }

  async saveCruxTrafficCache(_runId, _lease, rows) {
    this.calls.push("cache.crux.write");
    this.cache.push(...rows);
  }

  async planDataForSeoRequest(_runId, _lease, descriptor) {
    this.calls.push("ledger.plan");
    const existing = this.ledger.get(descriptor.requestFingerprint);
    if (existing) return { outcome: existing.state, ledger: existing };
    const ledger = { ...descriptor, state: "planned", providerCostUsd: 0 };
    this.ledger.set(descriptor.requestFingerprint, ledger);
    return { outcome: "planned", ledger };
  }

  async claimDataForSeoRequest(_runId, _lease, fingerprint) {
    this.calls.push("ledger.claim");
    const ledger = this.ledger.get(fingerprint);
    if (ledger.state !== "planned") {
      return { outcome: ledger.state, networkAllowed: false, ledger };
    }
    ledger.state = "in_flight";
    return { outcome: "in_flight", networkAllowed: true, ledger };
  }

  async markDataForSeoRequestSucceeded(_runId, _lease, fingerprint, result) {
    this.calls.push("ledger.succeeded");
    Object.assign(this.ledger.get(fingerprint), {
      state: "succeeded",
      providerCostUsd: result.providerCostUsd
    });
    this.cache.push(...result.cacheRows);
  }

  async markDataForSeoRequestFailed(_runId, _lease, fingerprint) {
    this.calls.push("ledger.failed");
    this.ledger.get(fingerprint).state = "failed";
  }

  async markDataForSeoRequestAmbiguous(_runId, _lease, fingerprint) {
    this.calls.push("ledger.ambiguous");
    this.ledger.get(fingerprint).state = "ambiguous";
  }
}

function options({ dataForSeo = false, crux = false, repository, leads = [lead()], dependencies = {}, maxCost } = {}) {
  return {
    runId: RUN_ID,
    lease: LEASE,
    runSnapshot: snapshot(dataForSeo, crux, { maxCost }),
    runtimeConfig: {
      dataForSeoLogin: "fixture",
      dataForSeoPassword: "fixture",
      cruxApiKey: "fixture",
      cruxBigQueryProjectId: "fixture",
      requestTimeoutMs: 1000
    },
    leads,
    repository,
    now: () => new Date(NOW),
    dependencyOverrides: {
      stableLeadId: (_runId, _lead, index) => `lead_${index}`,
      ...dependencies
    }
  };
}

test("off/off preserves the legacy result and performs no source interaction", async () => {
  const repository = new Proxy({}, {
    get() { throw new Error("disabled source interaction"); }
  });
  const result = await enrichTraffic(options({ repository }));
  assert.deepEqual(result, {
    trafficEnrichments: [],
    trafficEnrichmentSummary: null,
    diagnostics: []
  });
});

test("100 domains produce one paid task for each of ten scopes within the model", async () => {
  const repository = new MemoryRepository();
  let externalTasks = 0;
  const result = await enrichTraffic(options({
    dataForSeo: true,
    maxCost: 0.24,
    repository,
    leads: Array.from({ length: 100 }, (_, index) => lead(index)),
    dependencies: {
      fetchDataForSeoTraffic: async ({ targets, scope }) => {
        externalTasks += 1;
        return {
          records: targets.map((target) => ({
            state: "available",
            value: dataForSeoValue(target, scope === "worldwide"
              ? "worldwide"
              : {
                  countryIsoCode: scope.countryIsoCode,
                  locationCode: snapshot(true, false).dataForSeo.scopes
                    .find((entry) => entry.countryIsoCode === scope.countryIsoCode).locationCode
                })
          })),
          cost: { providerReported: 0.01236 }
        };
      }
    }
  }));
  assert.equal(externalTasks, 10);
  assert.equal(result.trafficEnrichmentSummary.dataforseo.externalTasks, 10);
  assert.ok(result.trafficEnrichmentSummary.dataforseo.actualCostUsd <= 0.24);
  assert.equal(result.trafficEnrichments.length, 100);
  assert.ok(result.trafficEnrichments.every(({ state }) => state === "available"));
});

test("paid ambiguity is durable and is never automatically retried", async () => {
  const repository = new MemoryRepository();
  let calls = 0;
  const ambiguous = new EnrichmentError("ambiguous", {
    code: "provider_request_ambiguous",
    provider: "dataforseo",
    contractVersion: "dataforseo-bulk-traffic-v1"
  });
  const run = () => enrichTraffic(options({
    dataForSeo: true,
    repository,
    dependencies: {
      fetchDataForSeoTraffic: async () => { calls += 1; throw ambiguous; }
    }
  }));
  const first = await run();
  const second = await run();
  assert.equal(calls, 10);
  assert.ok(repository.calls.includes("ledger.ambiguous"));
  assert.equal(first.trafficEnrichments[0].state, "ambiguous");
  assert.equal(second.trafficEnrichments[0].state, "ambiguous");
});

test("actual paid cost is authoritative and stops later scoped requests", async () => {
  const repository = new MemoryRepository();
  let calls = 0;
  const result = await enrichTraffic(options({
    dataForSeo: true,
    maxCost: 0.05,
    repository,
    dependencies: {
      fetchDataForSeoTraffic: async ({ targets, scope }) => {
        calls += 1;
        return {
          records: targets.map((target) => ({
            state: "available",
            value: dataForSeoValue(target, normalizedDataForSeoScope(scope))
          })),
          cost: { providerReported: 0.04 }
        };
      }
    }
  }));
  assert.equal(calls, 1);
  assert.equal(result.trafficEnrichmentSummary.dataforseo.actualCostUsd, 0.04);
  assert.equal(result.trafficEnrichmentSummary.dataforseo.budgetStopped, true);
  assert.equal(result.trafficEnrichments[0].state, "partial");
});

test("one country failure produces partial DataForSEO without losing other scopes", async () => {
  const repository = new MemoryRepository();
  const providerFailure = new EnrichmentError("known failure", {
    code: "provider_http_error",
    provider: "dataforseo",
    contractVersion: "dataforseo-bulk-traffic-v1"
  });
  let calls = 0;
  const result = await enrichTraffic(options({
    dataForSeo: true,
    repository,
    dependencies: {
      fetchDataForSeoTraffic: async ({ targets, scope }) => {
        calls += 1;
        if (scope?.countryIsoCode === "NZ") throw providerFailure;
        return {
          records: targets.map((target) => ({
            state: "available",
            value: dataForSeoValue(target, normalizedDataForSeoScope(scope))
          })),
          cost: { providerReported: 0.01 }
        };
      }
    }
  }));
  assert.equal(calls, 10);
  assert.equal(result.trafficEnrichments[0].state, "partial");
  assert.equal(result.trafficEnrichments[0].normalizedPayload.records.length, 9);
  assert.ok(result.diagnostics.some(({ code }) => code === "dataforseo_unavailable"));
});

test("CrUX-only runs use REST and BigQuery without DataForSEO artifacts", async () => {
  const repository = new MemoryRepository();
  const result = await enrichTraffic(options({
    crux: true,
    repository,
    dependencies: {
      fetchCruxOriginMetrics: async ({ origin }) => cruxRestValue(origin),
      fetchCruxLatestDatasetMonth: async () => "202606",
      dryRunCruxPopularity: async () => ({ datasetMonth: "202606", bytesProcessed: 100 }),
      fetchCruxPopularityForMonth: async ({ origins }) => ({
        datasetMonth: "202606",
        records: origins.map((origin) => popularityValue(origin)),
        dryRunBytesProcessed: 100,
        bytesProcessed: 90,
        bytesBilled: 100,
        cacheHit: false
      })
    }
  }));
  assert.equal(result.trafficEnrichments.length, 2);
  assert.deepEqual(result.trafficEnrichments.map(({ source }) => source).sort(), [
    "crux_bigquery", "crux_rest"
  ]);
  assert.equal(repository.calls.some((call) => call.startsWith("ledger.")), false);
});

test("all-cache CrUX run makes no provider or token-producing call", async () => {
  const policy = snapshot(false, true).crux;
  const origin = "https://store-0.example";
  const cache = [
    {
      ...{
        source: "crux_rest", identity: origin, scopeKey: "current",
        metricSetKey: policy.rest.metricSetKey, contractVersion: policy.rest.contractVersion
      },
      state: "available", normalizedPayload: cruxRestValue(origin)
    },
    {
      ...{
        source: "crux_bigquery", identity: origin, scopeKey: "month:202606",
        metricSetKey: policy.bigQuery.metricSetKey, contractVersion: policy.bigQuery.contractVersion
      },
      state: "available", normalizedPayload: popularityValue(origin)
    }
  ];
  const repository = new MemoryRepository(cache);
  const result = await enrichTraffic(options({
    crux: true,
    repository,
    dependencies: {
      fetchCruxOriginMetrics: async () => { throw new Error("REST call"); },
      fetchCruxLatestDatasetMonth: async () => { throw new Error("table call"); },
      dryRunCruxPopularity: async () => { throw new Error("dry run"); },
      fetchCruxPopularityForMonth: async () => { throw new Error("live query"); }
    }
  }));
  assert.equal(result.trafficEnrichmentSummary.cruxRest.cacheHits, 1);
  assert.equal(result.trafficEnrichmentSummary.cruxBigQuery.cacheHits, 1);
  assert.equal(result.trafficEnrichmentSummary.cruxBigQuery.tableListCalls, 0);
  assert.equal(result.trafficEnrichmentSummary.cruxBigQuery.queryCalls, 0);
});

test("CrUX REST 404 and BigQuery missing row remain explicit no coverage", async () => {
  const repository = new MemoryRepository();
  const result = await enrichTraffic(options({
    crux: true,
    repository,
    dependencies: {
      fetchCruxOriginMetrics: async ({ origin }) => ({
        contractVersion: "crux-origin-metrics-v1",
        origin,
        coverage: "unavailable",
        reason: "not_found",
        fetchedAt: NOW
      }),
      fetchCruxLatestDatasetMonth: async () => "202606",
      dryRunCruxPopularity: async () => ({ datasetMonth: "202606", bytesProcessed: 100 }),
      fetchCruxPopularityForMonth: async ({ origins }) => ({
        records: origins.map((origin) => ({
          contractVersion: "crux-popularity-v1",
          origin,
          coverage: "unavailable",
          reason: "no_coverage",
          datasetMonth: "202606",
          fetchedAt: NOW
        })),
        bytesProcessed: 90,
        bytesBilled: 100,
        cacheHit: false
      })
    }
  }));
  assert.ok(result.trafficEnrichments.every(({ state }) => state === "no_coverage"));
  assert.equal(repository.cache.filter(({ state }) => state === "no_coverage").length, 2);
});

test("one provider contract failure preserves accepted output from the other", async () => {
  const repository = new MemoryRepository();
  const mismatch = new EnrichmentError("drift", {
    code: "provider_contract_mismatch",
    provider: "dataforseo",
    contractVersion: "dataforseo-bulk-traffic-v1"
  });
  const result = await enrichTraffic(options({
    dataForSeo: true,
    crux: true,
    repository,
    dependencies: {
      fetchDataForSeoTraffic: async () => { throw mismatch; },
      fetchCruxOriginMetrics: async ({ origin }) => cruxRestValue(origin),
      fetchCruxLatestDatasetMonth: async () => "202606",
      dryRunCruxPopularity: async () => ({ datasetMonth: "202606", bytesProcessed: 100 }),
      fetchCruxPopularityForMonth: async ({ origins }) => ({
        records: origins.map((origin) => popularityValue(origin)),
        bytesProcessed: 90,
        bytesBilled: 100,
        cacheHit: true
      })
    }
  }));
  assert.equal(
    result.trafficEnrichments.find(({ source }) => source === "dataforseo").state,
    "contract_mismatch"
  );
  assert.ok(result.trafficEnrichments
    .filter(({ source }) => source.startsWith("crux_"))
    .every(({ state }) => state === "available"));
});
