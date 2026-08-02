import { stableLeadId } from "../prisma-run-repository.js";
import { ENRICHMENT_ERROR_CODES, EnrichmentError } from "./errors.js";
import { fetchDataForSeoTraffic } from "./dataforseo/adapter.js";
import {
  buildDataForSeoRequest,
  normalizeDataForSeoHostname
} from "./dataforseo/request.js";
import {
  dryRunCruxPopularity,
  fetchCruxLatestDatasetMonth,
  fetchCruxOriginMetrics,
  fetchCruxPopularityForMonth
} from "./crux/adapter.js";
import { normalizeCruxOrigin } from "./crux/api-request.js";

const FAILURE_PRIORITY = Object.freeze({
  unavailable: 1,
  no_coverage: 2,
  contract_mismatch: 3,
  ambiguous: 4
});

function dateFrom(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Traffic enrichment clock is invalid");
  return date;
}

function addMilliseconds(value, milliseconds) {
  return new Date(new Date(value).getTime() + milliseconds);
}

function scopeKey(scope) {
  return scope === "worldwide"
    ? "worldwide"
    : `country:${scope.countryIsoCode}:${scope.locationCode}`;
}

function scopeInput(scope) {
  return scope === "worldwide"
    ? "worldwide"
    : { countryIsoCode: scope.countryIsoCode };
}

function batches(values, limit) {
  const output = [];
  for (let index = 0; index < values.length; index += limit) {
    output.push(values.slice(index, index + limit));
  }
  return output;
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    () => worker()
  ));
  return output;
}

function safeProviderState(error) {
  if (!(error instanceof EnrichmentError)) return "unavailable";
  if (error.code === ENRICHMENT_ERROR_CODES.ambiguousRequest) return "ambiguous";
  if (error.code === ENRICHMENT_ERROR_CODES.contractMismatch) return "contract_mismatch";
  return "unavailable";
}

function ledgerFailureCode(error) {
  return error?.paidOutcome === "zero_cost_proven"
    ? "DATAFORSEO_ZERO_COST_REJECTION"
    : "DATAFORSEO_NOT_DISPATCHED";
}

function strongestState(states) {
  if (states.includes("available")) {
    return states.every((state) => state === "available") ? "available" : "partial";
  }
  return states.reduce(
    (selected, state) => FAILURE_PRIORITY[state] > FAILURE_PRIORITY[selected] ? state : selected,
    "unavailable"
  );
}

function sourceSummary(states, extra = {}) {
  const counts = {
    available: 0,
    partial: 0,
    no_coverage: 0,
    unavailable: 0,
    ambiguous: 0,
    contract_mismatch: 0
  };
  for (const state of states) counts[state] += 1;
  return { ...counts, ...extra };
}

function eligibleIdentities(runId, leads, dependencies) {
  const byDataForSeo = new Map();
  const byOrigin = new Map();
  leads.forEach((lead, index) => {
    if (lead.status !== "qualified") return;
    const leadId = dependencies.stableLeadId(runId, lead, index);
    const rawHostname = typeof lead.resolved_domain === "string"
      ? lead.resolved_domain.toLowerCase().replace(/^www\./u, "")
      : "";
    try {
      const hostname = dependencies.normalizeDataForSeoHostname(rawHostname);
      const entries = byDataForSeo.get(hostname) || [];
      entries.push(leadId);
      byDataForSeo.set(hostname, entries);
    } catch {}

    try {
      const url = new URL(lead.final_url);
      if (url.username || url.password) throw new Error("credentialed URL is ineligible");
      const origin = dependencies.normalizeCruxOrigin(url.origin);
      const entries = byOrigin.get(origin) || [];
      entries.push(leadId);
      byOrigin.set(origin, entries);
    } catch {}
  });
  return { byDataForSeo, byOrigin };
}

function cacheKey(source, identity, scope, policy) {
  return {
    source,
    identity,
    scopeKey: scope,
    metricSetKey: policy.metricSetKey,
    contractVersion: policy.contractVersion
  };
}

function cacheResult(row) {
  return row.state === "available"
    ? { state: "available", value: row.normalizedPayload, row }
    : { state: "no_coverage", row };
}

async function enrichDataForSeo(context, eligible, dependencies) {
  const policy = context.runSnapshot.dataForSeo;
  const identities = [...eligible.keys()].sort();
  const results = new Map(identities.map((identity) => [identity, new Map()]));
  let externalTasks = 0;
  let cacheHits = 0;
  let actualCostUsd = await context.repository.getDataForSeoRunCostUsd(
    context.runId, context.lease, dateFrom(context.now)
  );
  let budgetStopped = false;
  const providerConfig = {
    ...context.runtimeConfig,
    dataForSeoEnrichmentEnabled: true
  };

  for (const scope of policy.scopes) {
    const key = scopeKey(scope);
    const keys = identities.map((identity) => cacheKey("dataforseo", identity, key, policy));
    context.assertLeaseActive();
    const cached = await context.repository.readFreshTrafficCache(
      context.runId, context.lease, keys, dateFrom(context.now)
    );
    const cachedByIdentity = new Map(cached.map((row) => [row.identity, row]));
    const missing = [];
    for (const identity of identities) {
      const row = cachedByIdentity.get(identity);
      if (row) {
        cacheHits += 1;
        results.get(identity).set(key, cacheResult(row));
      } else {
        missing.push(identity);
      }
    }

    for (const targets of batches(missing, policy.targetLimit)) {
      if (budgetStopped ||
          actualCostUsd + policy.estimatedCostPerTaskUsd > policy.maxCostPerRunUsd) {
        budgetStopped = true;
        for (const target of targets) results.get(target).set(key, { state: "unavailable" });
        continue;
      }
      const descriptor = dependencies.buildDataForSeoRequest({
        targets,
        scope: scopeInput(scope)
      });
      context.assertLeaseActive();
      const planned = await context.repository.planDataForSeoRequest(
        context.runId,
        context.lease,
        {
          requestFingerprint: descriptor.requestFingerprint,
          targetCount: descriptor.targets.length,
          scopeKey: key,
          refreshSucceededAfterMs: policy.cacheFreshnessMs
        },
        dateFrom(context.now)
      );
      if (planned.outcome !== "planned") {
        const state = planned.outcome === "ambiguous" || planned.outcome === "in_flight"
          ? "ambiguous"
          : "unavailable";
        const raced = await context.repository.readFreshTrafficCache(
          context.runId,
          context.lease,
          targets.map((identity) => cacheKey("dataforseo", identity, key, policy)),
          dateFrom(context.now)
        );
        const racedByIdentity = new Map(raced.map((row) => [row.identity, row]));
        for (const target of targets) {
          const row = racedByIdentity.get(target);
          results.get(target).set(key, row ? cacheResult(row) : { state });
        }
        continue;
      }
      const claim = await context.repository.claimDataForSeoRequest(
        context.runId, context.lease, descriptor.requestFingerprint, dateFrom(context.now)
      );
      if (!claim.networkAllowed) {
        if (claim.outcome === "budget_exceeded") budgetStopped = true;
        const state = claim.outcome === "ambiguous" || claim.outcome === "in_flight"
          ? "ambiguous"
          : "unavailable";
        for (const target of targets) results.get(target).set(key, { state });
        continue;
      }

      context.assertLeaseActive();
      externalTasks += 1;
      try {
        const response = await dependencies.fetchDataForSeoTraffic({
          targets,
          scope: scopeInput(scope),
          config: providerConfig
        });
        context.assertLeaseActive();
        const fetchedAt = response.records.find(({ value }) => value)?.value?.fetchedAt ||
          dateFrom(context.now).toISOString();
        const cacheRows = response.records
          .filter(({ state }) => state === "available")
          .map(({ value }) => ({
            source: "dataforseo",
            identity: value.target,
            scopeKey: key,
            metricSetKey: policy.metricSetKey,
            contractVersion: policy.contractVersion,
            state: "available",
            normalizedPayload: value,
            fetchedAt: value.fetchedAt,
            expiresAt: addMilliseconds(value.fetchedAt, policy.cacheFreshnessMs)
          }));
        await context.repository.markDataForSeoRequestSucceeded(
          context.runId,
          context.lease,
          descriptor.requestFingerprint,
          { providerCostUsd: response.cost.providerReported, cacheRows },
          dateFrom(context.now)
        );
        actualCostUsd += response.cost.providerReported;
        for (const record of response.records) {
          const target = record.state === "available" ? record.value.target : record.target;
          results.get(target).set(key, record.state === "available"
            ? { state: "available", value: record.value, fetchedAt }
            : { state: "unavailable" });
        }
        if (actualCostUsd >= policy.maxCostPerRunUsd) budgetStopped = true;
      } catch (error) {
        if (!(error instanceof EnrichmentError)) throw error;
        const state = safeProviderState(error);
        if (!["zero_cost_proven", "not_dispatched"].includes(error.paidOutcome)) {
          await context.repository.markDataForSeoRequestAmbiguous(
            context.runId, context.lease, descriptor.requestFingerprint, dateFrom(context.now)
          );
        } else {
          await context.repository.markDataForSeoRequestFailed(
            context.runId,
            context.lease,
            descriptor.requestFingerprint,
            { code: ledgerFailureCode(error) },
            dateFrom(context.now)
          );
        }
        for (const target of targets) results.get(target).set(key, { state });
        context.diagnostics.push({
          scope: "run",
          code: `dataforseo_${state}`,
          details: { provider: "dataforseo", scope: key, targetCount: targets.length }
        });
      }
    }
  }

  const published = [];
  const states = [];
  for (const identity of identities) {
    const scoped = [...results.get(identity).values()];
    const state = strongestState(scoped.map((item) => item.state));
    states.push(state);
    const records = scoped.filter(({ state: itemState }) => itemState === "available")
      .map(({ value }) => value);
    for (const leadId of eligible.get(identity)) {
      published.push({
        leadId,
        source: "dataforseo",
        state,
        contractVersion: policy.contractVersion,
        ...(records.length && { normalizedPayload: { records } }),
        ...(records.length && { fetchedAt: records.map(({ fetchedAt }) => fetchedAt).sort().at(-1) })
      });
    }
  }
  return {
    published,
    summary: sourceSummary(states, {
      eligible: identities.length,
      cacheHits,
      externalTasks,
      actualCostUsd,
      budgetStopped
    })
  };
}

async function enrichCruxRest(context, eligible, dependencies) {
  const policy = context.runSnapshot.crux.rest;
  const identities = [...eligible.keys()].sort();
  const keys = identities.map((identity) => cacheKey("crux_rest", identity, "current", policy));
  context.assertLeaseActive();
  const cached = await context.repository.readFreshTrafficCache(
    context.runId, context.lease, keys, dateFrom(context.now)
  );
  const results = new Map(cached.map((row) => [row.identity, cacheResult(row)]));
  const missing = identities.filter((identity) => !results.has(identity));
  const providerConfig = { ...context.runtimeConfig, cruxEnrichmentEnabled: true };
  const cacheRows = [];
  await mapWithConcurrency(missing, policy.concurrency, async (origin) => {
    context.assertLeaseActive();
    try {
      const value = await dependencies.fetchCruxOriginMetrics({ origin, config: providerConfig });
      context.assertLeaseActive();
      if (value.coverage === "available") {
        results.set(origin, { state: "available", value });
        cacheRows.push({
          source: "crux_rest",
          identity: origin,
          scopeKey: "current",
          metricSetKey: policy.metricSetKey,
          contractVersion: policy.contractVersion,
          state: "available",
          normalizedPayload: value,
          fetchedAt: value.fetchedAt,
          coverageStartedAt: value.collectionPeriod.firstDate,
          coverageEndedAt: value.collectionPeriod.lastDate,
          expiresAt: addMilliseconds(value.fetchedAt, policy.cacheFreshnessMs)
        });
      } else {
        results.set(origin, { state: "no_coverage", fetchedAt: value.fetchedAt });
        cacheRows.push({
          source: "crux_rest",
          identity: origin,
          scopeKey: "current",
          metricSetKey: policy.metricSetKey,
          contractVersion: policy.contractVersion,
          state: "no_coverage",
          fetchedAt: value.fetchedAt,
          expiresAt: addMilliseconds(value.fetchedAt, policy.noCoverageFreshnessMs)
        });
      }
    } catch (error) {
      if (!(error instanceof EnrichmentError)) throw error;
      const state = safeProviderState(error);
      results.set(origin, { state });
      context.diagnostics.push({
        scope: "run",
        code: `crux_rest_${state}`,
        details: { provider: "crux_rest", originCount: 1 }
      });
    }
  });
  if (cacheRows.length) {
    context.assertLeaseActive();
    await context.repository.saveCruxTrafficCache(
      context.runId, context.lease, cacheRows, dateFrom(context.now)
    );
  }
  const published = [];
  const states = [];
  for (const origin of identities) {
    const result = results.get(origin) || { state: "unavailable" };
    states.push(result.state);
    for (const leadId of eligible.get(origin)) {
      published.push({
        leadId,
        source: "crux_rest",
        state: result.state,
        contractVersion: policy.contractVersion,
        ...(result.value && { normalizedPayload: result.value }),
        ...(result.value?.fetchedAt && { fetchedAt: result.value.fetchedAt }),
        ...(result.value?.collectionPeriod && {
          coverageStartedAt: result.value.collectionPeriod.firstDate,
          coverageEndedAt: result.value.collectionPeriod.lastDate
        })
      });
    }
  }
  return {
    published,
    summary: sourceSummary(states, {
      eligible: identities.length,
      cacheHits: cached.length,
      externalCalls: missing.length
    })
  };
}

function latestCommonMonth(rows, identities) {
  const byIdentity = new Map();
  for (const row of rows) {
    if (!byIdentity.has(row.identity)) byIdentity.set(row.identity, row);
  }
  if (identities.some((identity) => !byIdentity.has(identity))) return null;
  const scopes = new Set(identities.map((identity) => byIdentity.get(identity).scopeKey));
  return scopes.size === 1 ? [...scopes][0].slice("month:".length) : null;
}

async function enrichCruxBigQuery(context, eligible, dependencies) {
  const policy = context.runSnapshot.crux.bigQuery;
  const identities = [...eligible.keys()].sort();
  if (identities.length === 0) {
    return {
      published: [],
      summary: sourceSummary([], {
        eligible: 0,
        cacheHits: 0,
        tableListCalls: 0,
        queryCalls: 0
      })
    };
  }
  const providerConfig = {
    ...context.runtimeConfig,
    cruxEnrichmentEnabled: true,
    cruxBigQueryLocation: policy.location,
    cruxBigQueryMaxBytesBilled: policy.maxBytesBilled
  };
  context.assertLeaseActive();
  const latestRows = await context.repository.readFreshLatestCruxBigQueryCache(
    context.runId, context.lease, identities, dateFrom(context.now)
  );
  let datasetMonth = latestCommonMonth(latestRows, identities);
  let cached = datasetMonth ? latestRows.filter(({ scopeKey }) => scopeKey === `month:${datasetMonth}`) : [];
  let tableListCalls = 0;
  if (!datasetMonth) {
    context.assertLeaseActive();
    tableListCalls += 1;
    try {
      datasetMonth = await dependencies.fetchCruxLatestDatasetMonth({ config: providerConfig });
    } catch (error) {
      if (!(error instanceof EnrichmentError)) throw error;
      const state = safeProviderState(error);
      const published = [];
      for (const leadIds of eligible.values()) {
        for (const leadId of leadIds) published.push({
          leadId,
          source: "crux_bigquery",
          state,
          contractVersion: policy.contractVersion
        });
      }
      context.diagnostics.push({
        scope: "run",
        code: `crux_bigquery_${state}`,
        details: { provider: "crux_bigquery", phase: "latest_month" }
      });
      return {
        published,
        summary: sourceSummary(identities.map(() => state), {
          eligible: identities.length,
          cacheHits: 0,
          tableListCalls,
          queryCalls: 0
        })
      };
    }
    cached = await context.repository.readFreshTrafficCache(
      context.runId,
      context.lease,
      identities.map((identity) => cacheKey(
        "crux_bigquery", identity, `month:${datasetMonth}`, policy
      )),
      dateFrom(context.now)
    );
  }
  const results = new Map(cached.map((row) => [row.identity, cacheResult(row)]));
  const missing = identities.filter((identity) => !results.has(identity));
  let queryCalls = 0;
  let dryRunBytesProcessed = 0;
  let bytesProcessed = 0;
  let bytesBilled = 0;
  let queryCacheHit = false;
  if (missing.length) {
    if (missing.length > policy.originLimit) {
      for (const origin of missing) results.set(origin, { state: "unavailable" });
      context.diagnostics.push({
        scope: "run",
        code: "crux_bigquery_origin_limit",
        details: { provider: "crux_bigquery", originCount: missing.length }
      });
    } else {
      try {
        context.assertLeaseActive();
        const dryRun = await dependencies.dryRunCruxPopularity({
          origins: missing,
          datasetMonth,
          config: providerConfig
        });
        dryRunBytesProcessed = dryRun.bytesProcessed;
        context.assertLeaseActive();
        queryCalls += 1;
        const response = await dependencies.fetchCruxPopularityForMonth({
          origins: missing,
          datasetMonth,
          config: providerConfig,
          dryRun
        });
        bytesProcessed = response.bytesProcessed;
        bytesBilled = response.bytesBilled;
        queryCacheHit = response.cacheHit;
        const cacheRows = [];
        for (const value of response.records) {
          if (value.coverage === "available") {
            results.set(value.origin, { state: "available", value });
            cacheRows.push({
              source: "crux_bigquery",
              identity: value.origin,
              scopeKey: `month:${datasetMonth}`,
              metricSetKey: policy.metricSetKey,
              contractVersion: policy.contractVersion,
              state: "available",
              normalizedPayload: value,
              fetchedAt: value.fetchedAt,
              expiresAt: addMilliseconds(value.fetchedAt, 86400000)
            });
          } else {
            results.set(value.origin, { state: "no_coverage", fetchedAt: value.fetchedAt });
            cacheRows.push({
              source: "crux_bigquery",
              identity: value.origin,
              scopeKey: `month:${datasetMonth}`,
              metricSetKey: policy.metricSetKey,
              contractVersion: policy.contractVersion,
              state: "no_coverage",
              fetchedAt: value.fetchedAt,
              expiresAt: addMilliseconds(value.fetchedAt, 86400000)
            });
          }
        }
        context.assertLeaseActive();
        await context.repository.saveCruxTrafficCache(
          context.runId, context.lease, cacheRows, dateFrom(context.now)
        );
      } catch (error) {
        if (!(error instanceof EnrichmentError)) throw error;
        const state = safeProviderState(error);
        for (const origin of missing) results.set(origin, { state });
        context.diagnostics.push({
          scope: "run",
          code: `crux_bigquery_${state}`,
          details: { provider: "crux_bigquery", phase: "query", originCount: missing.length }
        });
      }
    }
  }
  const published = [];
  const states = [];
  for (const origin of identities) {
    const result = results.get(origin) || { state: "unavailable" };
    states.push(result.state);
    for (const leadId of eligible.get(origin)) {
      published.push({
        leadId,
        source: "crux_bigquery",
        state: result.state,
        contractVersion: policy.contractVersion,
        ...(result.value && { normalizedPayload: result.value }),
        ...(result.value?.fetchedAt && { fetchedAt: result.value.fetchedAt })
      });
    }
  }
  return {
    published,
    summary: sourceSummary(states, {
      eligible: identities.length,
      datasetMonth,
      cacheHits: cached.length,
      tableListCalls,
      queryCalls,
      dryRunBytesProcessed,
      bytesProcessed,
      bytesBilled,
      queryCacheHit
    })
  };
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  stableLeadId,
  normalizeDataForSeoHostname,
  normalizeCruxOrigin,
  buildDataForSeoRequest,
  fetchDataForSeoTraffic,
  fetchCruxOriginMetrics,
  fetchCruxLatestDatasetMonth,
  dryRunCruxPopularity,
  fetchCruxPopularityForMonth
});

export async function enrichTraffic({
  runId,
  lease,
  runSnapshot,
  runtimeConfig,
  leads,
  repository,
  now = () => new Date(),
  assertLeaseActive = () => {},
  dependencyOverrides = {}
}) {
  if (!runSnapshot || runSnapshot.version !== "traffic-enrichment-run-v1") {
    throw new Error("Traffic enrichment requires the immutable run snapshot");
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (!runSnapshot.dataForSeo.enabled && !runSnapshot.crux.enabled) {
    return { trafficEnrichments: [], trafficEnrichmentSummary: null, diagnostics: [] };
  }
  const diagnostics = [];
  const context = {
    runId,
    lease,
    runSnapshot,
    runtimeConfig,
    repository,
    now,
    assertLeaseActive,
    diagnostics
  };
  const eligible = eligibleIdentities(runId, leads, dependencies);
  const trafficEnrichments = [];
  const trafficEnrichmentSummary = { version: "traffic-enrichment-summary-v1" };

  if (runSnapshot.dataForSeo.enabled) {
    const output = await enrichDataForSeo(context, eligible.byDataForSeo, dependencies);
    trafficEnrichments.push(...output.published);
    trafficEnrichmentSummary.dataforseo = output.summary;
  }
  if (runSnapshot.crux.enabled) {
    const rest = await enrichCruxRest(context, eligible.byOrigin, dependencies);
    trafficEnrichments.push(...rest.published);
    trafficEnrichmentSummary.cruxRest = rest.summary;
    const bigQuery = await enrichCruxBigQuery(context, eligible.byOrigin, dependencies);
    trafficEnrichments.push(...bigQuery.published);
    trafficEnrichmentSummary.cruxBigQuery = bigQuery.summary;
  }

  diagnostics.sort((left, right) =>
    `${left.code}:${JSON.stringify(left.details)}`.localeCompare(
      `${right.code}:${JSON.stringify(right.details)}`
    )
  );

  return { trafficEnrichments, trafficEnrichmentSummary, diagnostics };
}
