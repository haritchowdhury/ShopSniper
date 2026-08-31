import { createHash } from "node:crypto";
import { attachVariants, clusterKeywords } from "./cluster.js";
import { isLeadFindingConfig } from "./config.js";
import { dedupVariants } from "./dedup.js";
import { isInformational } from "./intent.js";
import { hasMetrics, normalizeItem, computeTrendSlope, pyRound } from "./normalize.js";
import { LEAD_FINDING_BLOCKING_FLAGS, scoreAllClusters, scoreAndFlagAll } from "./score.js";
import { createDefaultSelection, selectionItemId } from "./selection.js";

function emptyFacets() {
  return { audience: [], category: [], channel: [], fit: [], modifier: [] };
}

function baseRecord(keyword, seed, sourceSeeds) {
  const rec = {
    keyword,
    seed,
    searchVolume: null,
    cpc: null,
    competition: null,
    competitionLevel: null,
    keywordDifficulty: null,
    mainIntent: null,
    monthlyHistory: [],
    trendSlope: null,
    commercialIntent: 0.0,
    clusterId: null,
    clusterLabel: null,
    flags: [],
    opportunityScore: null,
    recommended: false,
    mergedInto: null,
    sourceSeeds,
    variantGroupId: null,
    variantCanonical: null,
    lane: "category_discovery",
    facets: emptyFacets(),
    marketMetrics: {},
  };
  Object.defineProperty(rec, "is_active", {
    enumerable: false,
    get() { return this.mergedInto === null; },
  });
  return rec;
}

function marketMetric(record, market) {
  return {
    countryCode: market.code,
    locationCode: market.locationCode,
    locationName: market.name,
    languageName: market.languageName,
    searchVolume: record.searchVolume,
    cpc: record.cpc,
    competition: record.competition,
    competitionLevel: record.competitionLevel,
    keywordDifficulty: record.keywordDifficulty,
    mainIntent: record.mainIntent,
    commercialIntent: record.commercialIntent,
    monthlyHistory: record.monthlyHistory,
    trendSlope: record.trendSlope,
    flags: [],
    opportunityScore: null,
    recommended: false,
  };
}

function weighted(metrics, field) {
  const values = metrics
    .filter((metric) => metric[field] !== null && metric[field] !== undefined)
    .map((metric) => [metric[field], metric.searchVolume || 0]);
  if (!values.length) return null;
  const totalWeight = values.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight <= 0) {
    return values.reduce((sum, [value]) => sum + Number(value), 0) / values.length;
  }
  return values.reduce((sum, [value, weight]) => sum + Number(value) * weight, 0) / totalWeight;
}

export function applyCumulativeMetrics(record, config) {
  const metrics = Object.values(record.marketMetrics);
  record.searchVolume = metrics.reduce((sum, metric) => sum + (metric.searchVolume || 0), 0);
  record.cpc = weighted(metrics, "cpc");
  record.competition = weighted(metrics, "competition");
  const difficulty = weighted(metrics, "keywordDifficulty");
  record.keywordDifficulty = difficulty !== null ? pyRound(difficulty, 0) : null;
  const commercial = weighted(metrics, "commercialIntent");
  record.commercialIntent = commercial !== null ? commercial : 0.0;
  const intents = new Map();
  for (const metric of metrics) {
    if (metric.mainIntent) {
      intents.set(metric.mainIntent, (intents.get(metric.mainIntent) || 0) + (metric.searchVolume || 1));
    }
  }
  let bestIntent = null;
  let bestCount = -1;
  for (const [intent, count] of intents) {
    if (count > bestCount) {
      bestIntent = intent;
      bestCount = count;
    }
  }
  record.mainIntent = bestIntent;
  const history = new Map();
  for (const metric of metrics) {
    for (const [year, month, volume] of metric.monthlyHistory) {
      const key = `${year}:${month}`;
      history.set(key, (history.get(key) || 0) + (volume || 0));
    }
  }
  const sortedKeys = [...history.keys()].sort((a, b) => {
    const [ay, am] = a.split(":").map(Number);
    const [by, bm] = b.split(":").map(Number);
    return (ay - by) || (am - bm);
  });
  record.monthlyHistory = sortedKeys.map((key) => {
    const [year, month] = key.split(":").map(Number);
    return [year, month, history.get(key)];
  });
  const historyPayload = record.monthlyHistory.map(([year, month, volume]) => ({ year, month, searchVolume: volume }));
  record.trendSlope = computeTrendSlope(historyPayload, config.filters.decliningPeriods);
}

function recordForMetric(record, metric) {
  return {
    keyword: record.keyword,
    seed: record.seed,
    searchVolume: metric.searchVolume,
    cpc: metric.cpc,
    competition: metric.competition,
    competitionLevel: metric.competitionLevel,
    keywordDifficulty: metric.keywordDifficulty,
    mainIntent: metric.mainIntent,
    monthlyHistory: metric.monthlyHistory,
    trendSlope: metric.trendSlope,
    commercialIntent: metric.commercialIntent,
    clusterId: record.clusterId,
    clusterLabel: record.clusterLabel,
    mergedInto: record.mergedInto,
    sourceSeeds: record.sourceSeeds,
    variantGroupId: record.variantGroupId,
    variantCanonical: record.variantCanonical,
    lane: record.lane,
    facets: record.facets,
    flags: [...metric.flags],
    opportunityScore: metric.opportunityScore,
    recommended: metric.recommended,
  };
}

export function scoreMarkets(records, markets, config) {
  for (const market of markets) {
    const code = market.code;
    const pairs = records
      .map((record) => [record, record.marketMetrics[code]])
      .filter(([, metric]) => metric !== undefined && metric !== null);
    const tempRecords = pairs.map(([record, metric]) => recordForMetric(record, metric));
    scoreAndFlagAll(tempRecords, config, { includeMerged: true });
    for (let i = 0; i < pairs.length; i++) {
      const metric = pairs[i][1];
      const scored = tempRecords[i];
      metric.flags = scored.flags;
      metric.opportunityScore = scored.opportunityScore;
      metric.recommended = scored.recommended;
    }
  }
}

export function marketClusterMetrics(clusters, code, config) {
  const marketClusters = [];
  for (const cluster of clusters) {
    const members = [];
    for (const record of cluster.records) {
      const metric = record.marketMetrics[code];
      if (metric !== undefined && metric !== null) {
        members.push(recordForMetric(record, metric));
      }
    }
    if (members.length) {
      marketClusters.push({
        label: cluster.label,
        records: members,
        clusterId: cluster.clusterId,
        combinedVolume: 0,
        avgCpc: 0.0,
        avgCommercialIntent: 0.0,
        trendScore: 0.0,
        opportunityScore: 0,
        recommended: false,
        headlineVolume: 0,
        adjustedClusterVolume: 0,
        rawVariantVolume: 0,
        variantGroups: [],
        sourceSeeds: [],
        laneCounts: {},
        facets: emptyFacets(),
      });
    }
  }
  scoreAllClusters(marketClusters, config);
  const out = {};
  for (const cluster of marketClusters) {
    out[cluster.clusterId] = {
      combinedVolume: cluster.combinedVolume,
      headlineVolume: cluster.headlineVolume,
      adjustedClusterVolume: cluster.adjustedClusterVolume,
      rawVariantVolume: cluster.rawVariantVolume,
      avgCpc: pyRound(cluster.avgCpc, 2),
      commercialIntent: pyRound(cluster.avgCommercialIntent, 2),
      trendScore: pyRound(cluster.trendScore, 3),
      opportunityScore: cluster.opportunityScore,
      recommendedForStoreDiscovery: cluster.recommended,
    };
  }
  return out;
}

function toIntOrNull(value) {
  return value === null || value === undefined ? null : value;
}

function keywordRow(record) {
  const metrics = {};
  for (const m of [
    "US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE",
  ]) {
    const metric = record.marketMetrics[m];
    metrics[m] = metric === undefined || metric === null ? null : {
      countryCode: metric.countryCode,
      locationCode: metric.locationCode,
      locationName: metric.locationName,
      languageName: metric.languageName,
      searchVolume: metric.searchVolume,
      cpc: metric.cpc,
      competition: metric.competition,
      competitionLevel: metric.competitionLevel,
      keywordDifficulty: toIntOrNull(metric.keywordDifficulty),
      mainIntent: metric.mainIntent,
      commercialIntent: pyRound(metric.commercialIntent, 2),
      monthlyHistory: metric.monthlyHistory.map(([year, month, volume]) => ({ year, month, searchVolume: volume })),
      trendSlope: pyRound(metric.trendSlope, 3),
      flags: metric.flags,
      opportunityScore: metric.opportunityScore,
      recommended: metric.recommended,
    };
  }
  return {
    itemId: selectionItemId("calculated", record.keyword),
    keyword: record.keyword,
    seed: record.seed,
    sourceSeeds: record.sourceSeeds,
    searchVolume: record.searchVolume,
    cpc: record.cpc,
    competition: record.competition,
    competitionLevel: record.competitionLevel,
    keywordDifficulty: toIntOrNull(record.keywordDifficulty),
    mainIntent: record.mainIntent,
    commercialIntent: pyRound(record.commercialIntent, 2),
    monthlyHistory: record.monthlyHistory.map(([year, month, volume]) => ({ year, month, searchVolume: volume })),
    trendSlope: pyRound(record.trendSlope, 3),
    cluster: record.clusterLabel,
    clusterId: record.clusterId,
    lane: record.lane,
    facets: record.facets,
    variantGroupId: record.variantGroupId,
    variantCanonical: record.variantCanonical,
    flags: record.flags,
    opportunityScore: record.opportunityScore,
    recommended: record.recommended,
    mergedInto: record.mergedInto,
    availableMarkets: Object.keys(record.marketMetrics).sort(),
    marketMetrics: metrics,
  };
}

function clusterRow(cluster) {
  return {
    cluster: cluster.label,
    clusterId: cluster.clusterId,
    keywords: cluster.records.map((r) => r.keyword),
    combinedVolume: cluster.combinedVolume,
    headlineVolume: cluster.headlineVolume,
    adjustedClusterVolume: cluster.adjustedClusterVolume,
    rawVariantVolume: cluster.rawVariantVolume,
    variantGroups: cluster.variantGroups,
    sourceSeeds: cluster.sourceSeeds,
    laneCounts: cluster.laneCounts,
    facets: cluster.facets,
    avgCpc: pyRound(cluster.avgCpc, 2),
    commercialIntent: pyRound(cluster.avgCommercialIntent, 2),
    trendScore: pyRound(cluster.trendScore, 2),
    opportunityScore: cluster.opportunityScore,
    recommendedForStoreDiscovery: cluster.recommended,
  };
}

export function computeResearchResult(input) {
  const { config, seeds, markets, expansion, overview } = input;
  if (!config || !Array.isArray(seeds) || !Array.isArray(markets)) {
    throw new TypeError("invalid research input");
  }

  const discovered = new Map();
  for (let s = 0; s < seeds.length; s++) {
    const seed = seeds[s];
    const keywords = expansion?.[seed] ?? [];
    for (const keyword of keywords) {
      const key = keyword.trim().toLowerCase();
      if (!key) continue;
      let entry = discovered.get(key);
      if (!entry) {
        entry = { keyword: keyword.trim(), seeds: new Set(), markets: new Set([input.anchorMarket ?? "US"]) };
        discovered.set(key, entry);
      }
      entry.seeds.add(seed);
    }
  }

  const keywordList = [...discovered.values()].map((entry) => entry.keyword);
  const baseRecords = new Map();
  const marketItemCounts = new Map();
  let rawItemsCollected = 0;
  let itemsWithMetrics = 0;
  let informationalDropped = 0;
  for (const market of markets) {
    for (const item of overview?.[market.code] ?? []) {
      rawItemsCollected += 1;
      const key = String(item.keyword ?? "").trim().toLowerCase();
      const source = discovered.get(key);
      if (!source) continue;
      const seed = [...source.seeds].sort()[0];
      const record = normalizeItem(item, seed, config);
      if (!record || !hasMetrics(record)) continue;
      itemsWithMetrics += 1;
      marketItemCounts.set(market.code, (marketItemCounts.get(market.code) || 0) + 1);
      if (isInformational(record.keyword, record.mainIntent, config)) informationalDropped += 1;
      let base = baseRecords.get(key);
      if (!base) {
        base = baseRecord(record.keyword, seed, [...source.seeds].sort());
        baseRecords.set(key, base);
      }
      const metric = marketMetric(record, market);
      const current = base.marketMetrics[market.code];
      if (!current || (metric.searchVolume || 0) > (current.searchVolume || 0)) {
        base.marketMetrics[market.code] = metric;
      }
    }
  }

  const missingMarkets = markets
    .filter((market) => (marketItemCounts.get(market.code) || 0) === 0)
    .map((market) => market.code);
  if (missingMarkets.length) {
    throw new Error(`no usable overview metrics returned for market(s): ${missingMarkets.join(", ")}`);
  }

  const kept = [...baseRecords.values()];
  for (const record of kept) applyCumulativeMetrics(record, config);

  const deduped = dedupVariants(kept, config);
  const active = deduped.filter((r) => r.is_active);
  const merged = deduped.filter((r) => !r.is_active);
  const dedupMerged = merged.length;

  const clusters = clusterKeywords(active, config);
  attachVariants(clusters, deduped);
  scoreAndFlagAll(deduped, config, { includeMerged: true });
  scoreAllClusters(clusters, config);
  scoreMarkets(deduped, markets, config);

  const leadFinding = isLeadFindingConfig(config);
  if (leadFinding) {
    for (const record of deduped) record.recommended = false;
    const selection = createDefaultSelection(active, {
      onePerCluster: true,
      blockingFlags: LEAD_FINDING_BLOCKING_FLAGS,
    });
    const recommendedIds = new Set(selection.items.map((item) => item.itemId));
    for (const record of active) {
      record.recommended = recommendedIds.has(selectionItemId("calculated", record.keyword));
    }
    for (const cluster of clusters) {
      cluster.recommended = cluster.records.some((member) => member.recommended);
    }
    informationalDropped = new Set(
      active
        .filter((record) => record.flags.includes("informational_dropped"))
        .map((record) => record.keyword.trim().toLowerCase()),
    ).size;
  }

  const activeCount = active.length;
  const recommendedKeywords = active.filter((r) => r.recommended).length;
  const recommendedClusters = clusters.filter((c) => c.recommended).length;
  const variantGroups = clusters.reduce((sum, c) => sum + c.variantGroups.length, 0);

  return {
    contractVersion: leadFinding ? 2 : 1,
    researchId: input.researchId ?? "",
    generation: input.generation ?? 1,
    configFingerprint: input.configFingerprint ?? "",
    seeds,
    markets,
    summary: {
      schemaVersion: 3,
      markets,
      seeds,
      rawItemsCollected,
      itemsWithMetrics,
      informationalDropped,
      uniquePhrases: kept.length,
      dedupMerged,
      activeKeywords: activeCount,
      variantGroups,
      clusters: clusters.length,
      recommendedKeywords,
      recommendedClusters,
    },
    keywords: [...active, ...merged].map(keywordRow),
    clusters: clusters.map(clusterRow),
  };
}

export function resultFingerprint(result) {
  return createHash("sha256").update(canonicalJson(result)).digest("hex");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}