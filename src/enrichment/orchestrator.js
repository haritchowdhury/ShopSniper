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
const TRAFFIC_WORK_WAIT_ATTEMPTS = 1200;
const TRAFFIC_WORK_WAIT_MS = 250;

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

export function eligibleTrafficIdentities(runId, leads, dependencies = {
  stableLeadId, normalizeDataForSeoHostname, normalizeCruxOrigin
}) {
  const byDataForSeo = new Map();
  const byOrigin = new Map();
  const dataForSeoShopIds = new Map();
  const originShopIds = new Map();
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
      if (lead.shop_id) dataForSeoShopIds.set(hostname, lead.shop_id);
    } catch {}

    try {
      const url = new URL(lead.final_url);
      if (url.username || url.password) throw new Error("credentialed URL is ineligible");
      const origin = dependencies.normalizeCruxOrigin(url.origin);
      const entries = byOrigin.get(origin) || [];
      entries.push(leadId);
      byOrigin.set(origin, entries);
      if (lead.shop_id) originShopIds.set(origin, lead.shop_id);
    } catch {}
  });
  return { byDataForSeo, byOrigin, dataForSeoShopIds, originShopIds };
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

function readTrafficCache(context, keys) {
  const method = typeof context.repository.readReusableTrafficCache === "function"
    ? context.repository.readReusableTrafficCache.bind(context.repository)
    : context.repository.readFreshTrafficCache.bind(context.repository);
  return method(context.runId, context.lease, keys, dateFrom(context.now));
}

function readLatestCruxCache(context, identities) {
  const method = typeof context.repository.readReusableLatestCruxBigQueryCache === "function"
    ? context.repository.readReusableLatestCruxBigQueryCache.bind(context.repository)
    : context.repository.readFreshLatestCruxBigQueryCache.bind(context.repository);
  return method(context.runId, context.lease, identities, dateFrom(context.now));
}

async function reserveTrafficIdentities(
  context,
  shopIds,
  identities,
  workType,
  scope
) {
  const reservations = new Map();
  const claimable = [];
  for (const identity of identities) {
    const shopId = shopIds.get(identity);
    if (!shopId) {
      reservations.set(identity, { networkAllowed: true, outcome: "legacy", work: null });
    } else {
      claimable.push({ identity, shopId, workType, scopeKey: scope });
    }
  }
  if (!claimable.length) return reservations;
  if (typeof context.repository.claimShopWorkBatch === "function") {
    const startedAt = performance.now();
    const claimed = await context.repository.claimShopWorkBatch(
      context.runId,
      context.lease,
      claimable.map(({ shopId, workType: type, scopeKey }) => ({
        shopId, workType: type, scopeKey
      })),
      dateFrom(context.now)
    );
    context.onBatchTelemetry({
      operation: "work_claim",
      source: workType,
      scope,
      rowCount: claimable.length,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10
    });
    if (!Array.isArray(claimed) || claimed.length !== claimable.length) {
      throw new Error("Traffic work claim batch did not reconcile every identity");
    }
    claimable.forEach(({ identity, shopId, workType: type, scopeKey }, index) => {
      const reservation = claimed[index];
      if (reservation?.work?.shopId !== shopId ||
          reservation.work.workType !== type || reservation.work.scopeKey !== scopeKey) {
        throw new Error("Traffic work claim batch returned a mismatched identity");
      }
      reservations.set(identity, reservation);
    });
    return reservations;
  }
  for (const claim of claimable) {
    reservations.set(claim.identity, await context.repository.claimShopWork(
      context.runId,
      context.lease,
      claim.shopId,
      claim.workType,
      claim.scopeKey,
      dateFrom(context.now)
    ));
  }
  return reservations;
}

async function settleTrafficReservations(
  context,
  shopIds,
  identities,
  workType,
  scope,
  dependencies
) {
  const reservations = await reserveTrafficIdentities(
    context, shopIds, identities, workType, scope
  );
  for (let attempt = 0; attempt < TRAFFIC_WORK_WAIT_ATTEMPTS; attempt += 1) {
    const processing = identities.filter((identity) =>
      reservations.get(identity)?.outcome === "processing"
    );
    if (!processing.length) break;
    await dependencies.waitForTrafficWork(TRAFFIC_WORK_WAIT_MS);
    context.assertLeaseActive();
    const refreshed = await reserveTrafficIdentities(
      context, shopIds, processing, workType, scope
    );
    for (const identity of processing) reservations.set(identity, refreshed.get(identity));
  }
  return reservations;
}

function workClaimsForIdentities(shopIds, identities, workType, scope) {
  return identities.flatMap((identity) => {
    const shopId = shopIds.get(identity);
    return shopId ? [{ shopId, workType, scopeKey: scope }] : [];
  });
}

export async function enrichDataForSeoSource(context, eligible, dependencies) {
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
    const cached = await readTrafficCache(context, keys);
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

    for (const candidateTargets of batches(missing, policy.targetLimit)) {
      if (budgetStopped ||
          actualCostUsd + policy.estimatedCostPerTaskUsd > policy.maxCostPerRunUsd) {
        budgetStopped = true;
        for (const target of candidateTargets) {
          results.get(target).set(key, { state: "unavailable" });
        }
        continue;
      }
      const targets = [];
      const reservations = await settleTrafficReservations(
        context,
        context.dataForSeoShopIds,
        candidateTargets,
        "dataforseo",
        key,
        dependencies
      );
      const completedIdentities = candidateTargets.filter((identity) =>
        reservations.get(identity)?.outcome === "completed"
      );
      const raced = completedIdentities.length
        ? await readTrafficCache(
            context,
            completedIdentities.map((identity) => cacheKey("dataforseo", identity, key, policy))
          )
        : [];
      const racedByIdentity = new Map(raced.map((row) => [row.identity, row]));
      for (const identity of candidateTargets) {
        const reservation = reservations.get(identity);
        if (reservation.networkAllowed) {
          targets.push(identity);
          continue;
        }
        if (reservation.outcome === "completed") {
          const row = racedByIdentity.get(identity);
          if (row) {
            cacheHits += 1;
            results.get(identity).set(key, cacheResult(row));
            continue;
          }
        }
        results.get(identity).set(key, {
          state: reservation.outcome === "ambiguous" ? "ambiguous" : "unavailable"
        });
      }
      if (!targets.length) continue;
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
        const raced = await readTrafficCache(
          context,
          targets.map((identity) => cacheKey("dataforseo", identity, key, policy))
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
        const commitStartedAt = performance.now();
        await context.repository.markDataForSeoRequestSucceeded(
          context.runId,
          context.lease,
          descriptor.requestFingerprint,
          {
            providerCostUsd: response.cost.providerReported,
            cacheRows,
            workClaims: targets.flatMap((identity) => {
              const shopId = context.dataForSeoShopIds.get(identity);
              return shopId ? [{ shopId, workType: "dataforseo", scopeKey: key }] : [];
            })
          },
          dateFrom(context.now)
        );
        context.onBatchTelemetry({
          operation: "cache_work_commit",
          source: "dataforseo",
          scope: key,
          rowCount: targets.length,
          durationMs: Math.round((performance.now() - commitStartedAt) * 10) / 10
        });
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
        if (typeof context.repository.finishShopWorkClaims === "function") {
          await context.repository.finishShopWorkClaims(
            context.runId,
            context.lease,
            workClaimsForIdentities(
              context.dataForSeoShopIds,
              targets,
              "dataforseo",
              key
            ),
            ["zero_cost_proven", "not_dispatched"].includes(error.paidOutcome)
              ? "failed"
              : "ambiguous",
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

export async function enrichCruxRestSource(context, eligible, dependencies) {
  const policy = context.runSnapshot.crux.rest;
  const identities = [...eligible.keys()].sort();
  const keys = identities.map((identity) => cacheKey("crux_rest", identity, "current", policy));
  context.assertLeaseActive();
  const cached = await readTrafficCache(context, keys);
  const results = new Map(cached.map((row) => [row.identity, cacheResult(row)]));
  let cacheHits = cached.length;
  const uncached = identities.filter((identity) => !results.has(identity));
  const reservations = await settleTrafficReservations(
    context,
    context.originShopIds,
    uncached,
    "crux_rest",
    "current",
    dependencies
  );
  const completedIdentities = uncached.filter((identity) =>
    reservations.get(identity)?.outcome === "completed"
  );
  const raced = completedIdentities.length
    ? await readTrafficCache(
        context,
        completedIdentities.map((identity) => cacheKey("crux_rest", identity, "current", policy))
      )
    : [];
  const racedByIdentity = new Map(raced.map((row) => [row.identity, row]));
  const missing = [];
  for (const identity of uncached) {
    const reservation = reservations.get(identity);
    if (reservation.networkAllowed) {
      missing.push(identity);
      continue;
    }
    if (reservation.outcome === "completed") {
      const row = racedByIdentity.get(identity);
      if (row) {
        cacheHits += 1;
        results.set(identity, cacheResult(row));
        continue;
      }
    }
    results.set(identity, {
      state: reservation.outcome === "ambiguous" ? "ambiguous" : "unavailable"
    });
  }
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
    const completedClaims = workClaimsForIdentities(
      context.originShopIds,
      missing.filter((origin) => ["available", "no_coverage"].includes(results.get(origin)?.state)),
      "crux_rest",
      "current"
    );
    const commitStartedAt = performance.now();
    await context.repository.saveCruxTrafficCache(
      context.runId,
      context.lease,
      cacheRows,
      completedClaims,
      dateFrom(context.now)
    );
    context.onBatchTelemetry({
      operation: "cache_work_commit",
      source: "crux_rest",
      scope: "current",
      rowCount: completedClaims.length,
      durationMs: Math.round((performance.now() - commitStartedAt) * 10) / 10
    });
  }
  if (typeof context.repository.finishShopWorkClaims === "function") {
    const completed = new Set(missing.filter((origin) =>
      ["available", "no_coverage"].includes(results.get(origin)?.state)
    ));
    const failed = missing.filter((origin) => !completed.has(origin));
    await context.repository.finishShopWorkClaims(
      context.runId,
      context.lease,
      workClaimsForIdentities(context.originShopIds, failed, "crux_rest", "current"),
      "failed",
      dateFrom(context.now)
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
      cacheHits,
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

export async function enrichCruxBigQuerySource(context, eligible, dependencies) {
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
  const latestRows = await readLatestCruxCache(context, identities);
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
    cached = await readTrafficCache(
      context,
      identities.map((identity) => cacheKey(
        "crux_bigquery", identity, `month:${datasetMonth}`, policy
      ))
    );
  }
  const results = new Map(cached.map((row) => [row.identity, cacheResult(row)]));
  let cacheHits = cached.length;
  const uncached = identities.filter((identity) => !results.has(identity));
  const reservations = await settleTrafficReservations(
    context,
    context.originShopIds,
    uncached,
    "crux_bigquery",
    `month:${datasetMonth}`,
    dependencies
  );
  const completedIdentities = uncached.filter((identity) =>
    reservations.get(identity)?.outcome === "completed"
  );
  const raced = completedIdentities.length
    ? await readTrafficCache(
        context,
        completedIdentities.map((identity) => cacheKey(
          "crux_bigquery", identity, `month:${datasetMonth}`, policy
        ))
      )
    : [];
  const racedByIdentity = new Map(raced.map((row) => [row.identity, row]));
  const missing = [];
  for (const identity of uncached) {
    const reservation = reservations.get(identity);
    if (reservation.networkAllowed) {
      missing.push(identity);
      continue;
    }
    if (reservation.outcome === "completed") {
      const row = racedByIdentity.get(identity);
      if (row) {
        cacheHits += 1;
        results.set(identity, cacheResult(row));
        continue;
      }
    }
    results.set(identity, {
      state: reservation.outcome === "ambiguous" ? "ambiguous" : "unavailable"
    });
  }
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
            const state = value.reason === "contract_mismatch"
              ? "contract_mismatch"
              : "no_coverage";
            results.set(value.origin, { state });
            if (state === "no_coverage") {
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
        }
        context.assertLeaseActive();
        const completedClaims = workClaimsForIdentities(
          context.originShopIds,
          missing.filter((origin) => ["available", "no_coverage"].includes(results.get(origin)?.state)),
          "crux_bigquery",
          `month:${datasetMonth}`
        );
        const commitStartedAt = performance.now();
        await context.repository.saveCruxTrafficCache(
          context.runId,
          context.lease,
          cacheRows,
          completedClaims,
          dateFrom(context.now)
        );
        context.onBatchTelemetry({
          operation: "cache_work_commit",
          source: "crux_bigquery",
          scope: `month:${datasetMonth}`,
          rowCount: completedClaims.length,
          durationMs: Math.round((performance.now() - commitStartedAt) * 10) / 10
        });
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
  if (typeof context.repository.finishShopWorkClaims === "function") {
    const completed = new Set(missing.filter((origin) =>
      ["available", "no_coverage"].includes(results.get(origin)?.state)
    ));
    const failed = missing.filter((origin) => !completed.has(origin));
    await context.repository.finishShopWorkClaims(
      context.runId,
      context.lease,
      workClaimsForIdentities(
        context.originShopIds,
        failed,
        "crux_bigquery",
        `month:${datasetMonth}`
      ),
      "failed",
      dateFrom(context.now)
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
      cacheHits,
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
  fetchCruxPopularityForMonth,
  waitForTrafficWork: (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  })
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
  onSourceComplete = async () => {},
  onBatchTelemetry = () => {},
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
    onBatchTelemetry,
    diagnostics
  };
  const eligible = eligibleTrafficIdentities(runId, leads, dependencies);
  context.dataForSeoShopIds = eligible.dataForSeoShopIds;
  context.originShopIds = eligible.originShopIds;
  const trafficEnrichments = [];
  const trafficEnrichmentSummary = { version: "traffic-enrichment-summary-v1" };

  if (runSnapshot.dataForSeo.enabled) {
    const output = await enrichDataForSeoSource(context, eligible.byDataForSeo, dependencies);
    trafficEnrichments.push(...output.published);
    trafficEnrichmentSummary.dataforseo = output.summary;
    await onSourceComplete({
      sourceKey: "dataforseo",
      records: output.published,
      summary: output.summary,
      diagnostics: diagnostics.filter(({ code }) => code.startsWith("dataforseo_"))
    });
  }
  if (runSnapshot.crux.enabled) {
    const rest = await enrichCruxRestSource(context, eligible.byOrigin, dependencies);
    trafficEnrichments.push(...rest.published);
    trafficEnrichmentSummary.cruxRest = rest.summary;
    await onSourceComplete({
      sourceKey: "cruxRest",
      records: rest.published,
      summary: rest.summary,
      diagnostics: diagnostics.filter(({ code }) => code.startsWith("crux_rest_"))
    });
    const bigQuery = await enrichCruxBigQuerySource(context, eligible.byOrigin, dependencies);
    trafficEnrichments.push(...bigQuery.published);
    trafficEnrichmentSummary.cruxBigQuery = bigQuery.summary;
    await onSourceComplete({
      sourceKey: "cruxBigQuery",
      records: bigQuery.published,
      summary: bigQuery.summary,
      diagnostics: diagnostics.filter(({ code }) => code.startsWith("crux_bigquery_"))
    });
  }

  diagnostics.sort((left, right) =>
    `${left.code}:${JSON.stringify(left.details)}`.localeCompare(
      `${right.code}:${JSON.stringify(right.details)}`
    )
  );

  return { trafficEnrichments, trafficEnrichmentSummary, diagnostics };
}
