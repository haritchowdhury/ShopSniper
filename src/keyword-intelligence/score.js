import { normalizeVolume, pyRound, trendToZeroOne } from "./normalize.js";
import { isLeadFindingConfig } from "./config.js";
import { jaccard, signature, tokenize } from "./dedup.js";

export const BLOCKING_FLAGS = new Set([
  "too_little_traffic", "too_broad", "declining_traffic", "brand_competitor", "informational_dropped",
]);

export const LEAD_FINDING_BLOCKING_FLAGS = new Set([
  ...BLOCKING_FLAGS, "local_intent", "junk_quality",
]);

export const LEAD_FINDING_SHORTLIST_PENALTY_FLAGS = Object.freeze([
  "brand_competitor", "local_intent", "junk_quality",
]);

export function leadFindingShortlistGroup(entry) {
  const flags = entry?.flags || [];
  if (flags.includes("informational_dropped")) return 2;
  if (LEAD_FINDING_SHORTLIST_PENALTY_FLAGS.some((flag) => flags.includes(flag))) return 1;
  return 0;
}

export function compareLeadFindingShortlist(left, right, fallback) {
  const leftGroup = leadFindingShortlistGroup(left);
  const rightGroup = leadFindingShortlistGroup(right);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  return fallback(left, right);
}

function unusualPunctuationCount(keyword) {
  const matches = String(keyword || "").match(/[^\p{L}\p{N}\s'’-]/gu);
  return matches ? matches.length : 0;
}

function hasConsecutiveDuplicateTokens(keyword) {
  const raw = tokenize(keyword, []);
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === raw[i - 1]) return true;
  }
  return false;
}

export function isJunkQuality(keyword) {
  const text = String(keyword || "");
  if (/^\s*\d/u.test(text)) return true;
  if (hasConsecutiveDuplicateTokens(text)) return true;
  if (unusualPunctuationCount(text) > 2) return true;
  return false;
}

export function flagRecord(rec, config) {
  rec.flags = [];
  const filters = config.filters;
  const volume = rec.searchVolume || 0;
  if (volume < filters.minVolumeKeep) rec.flags.push("too_little_traffic");
  const wordCount = rec.keyword.split(/\s+/).length;
  if (wordCount <= filters.tooBroadMaxWords && volume >= filters.tooBroadMinVolume) rec.flags.push("too_broad");
  if (rec.trendSlope !== null && rec.trendSlope !== undefined && rec.trendSlope < filters.decliningSlopeThreshold) {
    rec.flags.push("declining_traffic");
  }
  if (rec.lane === "brand_competitor") rec.flags.push("brand_competitor");
  if ((rec.mainIntent || "").toLowerCase() === "informational") rec.flags.push("informational_dropped");
  if (isLeadFindingConfig(config)) {
    if (rec.lane === "local_discovery") rec.flags.push("local_intent");
    if (isJunkQuality(rec.keyword)) rec.flags.push("junk_quality");
  }
}

export function populationStats(records) {
  const volumes = records.map((r) => r.searchVolume || 0);
  const cpcs = records.map((r) => r.cpc).filter((c) => c !== null && c !== undefined);
  return {
    maxVolume: volumes.length ? Math.max(...volumes) : 1.0,
    maxCpc: cpcs.length ? Math.max(...cpcs) : 1.0,
  };
}

export function scoreRecord(rec, stats, config) {
  if (isLeadFindingConfig(config)) {
    scoreRecordLeadFinding(rec, config);
    return;
  }
  const weights = config.scoring.weights;
  const scfg = config.scoring;

  const volNorm = normalizeVolume(rec.searchVolume, stats.maxVolume, scfg.volumeLogBase);
  const maxCpc = Math.max(stats.maxCpc, 0.01);
  const cpcNorm = Math.max(0.0, Math.min(1.0, (rec.cpc || 0.0) / maxCpc));
  const difficulty = rec.keywordDifficulty !== null && rec.keywordDifficulty !== undefined
    ? rec.keywordDifficulty : scfg.difficultyMax / 2;
  let invDiff = 1.0 - (difficulty / scfg.difficultyMax);
  invDiff = Math.max(0.0, Math.min(1.0, invDiff));
  const competition = rec.competition !== null && rec.competition !== undefined
    ? rec.competition : scfg.competitionMax / 2;
  let invComp = 1.0 - (competition / scfg.competitionMax);
  invComp = Math.max(0.0, Math.min(1.0, invComp));
  const trendNorm = trendToZeroOne(rec.trendSlope);
  const ci = rec.commercialIntent;

  const raw = weights.volume * volNorm
    + weights.commercialIntent * ci
    + weights.trend * trendNorm
    + weights.inverseDifficulty * invDiff
    + weights.inverseCompetition * invComp
    + weights.cpc * cpcNorm;
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0) || 1.0;
  rec.opportunityScore = pyRound(Math.max(0.0, Math.min(1.0, raw / totalW)) * 100);

  const blocking = new Set(rec.flags).intersection(BLOCKING_FLAGS);
  rec.recommended = rec.opportunityScore >= config.scoring.recommendThreshold && blocking.size === 0;
}

function stableVolumeNorm(volume, cap, logBase) {
  if (!volume || volume <= 0) return 0.0;
  const denom = Math.log(Math.max(cap, 1.0) + 1.0) / Math.log(logBase);
  if (denom <= 0) return 0.0;
  return Math.max(0.0, Math.min(1.0, (Math.log(volume + 1.0) / Math.log(logBase)) / denom));
}

function seedOverlapScore(rec, config) {
  const strip = [
    ...(config.dedup?.stripTokens || []),
    ...(config.classification?.clusterKeyStripTokens || []),
  ];
  const keywordTokens = signature(rec.keyword, strip);
  const seeds = rec.sourceSeeds && rec.sourceSeeds.length ? rec.sourceSeeds : [rec.seed].filter(Boolean);
  const seedTokens = new Set();
  for (const seed of seeds) {
    for (const token of signature(seed, strip)) seedTokens.add(token);
  }
  return jaccard(keywordTokens, seedTokens);
}

function scoreRecordLeadFinding(rec, config) {
  const weights = config.scoring.weights;
  const scfg = config.scoring;
  const volNorm = stableVolumeNorm(rec.searchVolume, scfg.volumeLogCap, scfg.volumeLogBase);
  const cpcNorm = Math.max(0.0, Math.min(1.0, (rec.cpc || 0.0) / Math.max(scfg.cpcCap, 0.01)));
  const trendNorm = trendToZeroOne(rec.trendSlope);
  const overlap = seedOverlapScore(rec, config);
  const raw = weights.volume * volNorm
    + weights.commercialIntent * rec.commercialIntent
    + weights.trend * trendNorm
    + weights.seedOverlap * overlap
    + weights.cpc * cpcNorm;
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0) || 1.0;
  rec.opportunityScore = pyRound(Math.max(0.0, Math.min(1.0, raw / totalW)) * 100);
  rec.recommended = false;
}

export function scoreAndFlagAll(records, config, options = {}) {
  const includeMerged = options.includeMerged === true;
  const scoringRows = includeMerged ? records : records.filter((r) => r.is_active);
  const stats = populationStats(scoringRows);
  for (const rec of records) {
    if (!includeMerged && !rec.is_active) continue;
    flagRecord(rec, config);
    scoreRecord(rec, stats, config);
  }
  return stats;
}

export function aggregateCluster(cluster) {
  const members = cluster.records;
  if (!members || members.length === 0) return 1.0;
  const volumes = members.map((m) => m.searchVolume || 0);
  const cpcs = members.map((m) => m.cpc).filter((c) => c !== null && c !== undefined);
  const cis = members.map((m) => m.commercialIntent);
  const trends = members.map((m) => trendToZeroOne(m.trendSlope));

  const canonicalVolume = volumes.reduce((a, b) => a + b, 0);
  if (!cluster.adjustedClusterVolume) cluster.adjustedClusterVolume = canonicalVolume;
  if (!cluster.rawVariantVolume) cluster.rawVariantVolume = canonicalVolume;
  cluster.combinedVolume = cluster.rawVariantVolume;
  if (!cluster.headlineVolume) cluster.headlineVolume = volumes.length ? Math.max(...volumes) : 0;
  cluster.avgCpc = cpcs.length ? cpcs.reduce((a, b) => a + b, 0) / cpcs.length : 0.0;
  cluster.avgCommercialIntent = cis.length ? cis.reduce((a, b) => a + b, 0) / cis.length : 0.0;
  cluster.trendScore = trends.length ? trends.reduce((a, b) => a + b, 0) / trends.length : 0.0;

  return members.filter((m) => new Set(m.flags).intersection(BLOCKING_FLAGS).size > 0).length / members.length;
}

export function scoreCluster(cluster, config, stats = null) {
  const members = cluster.records;
  if (!members || members.length === 0) return;
  const blockingShare = aggregateCluster(cluster);

  if (isLeadFindingConfig(config)) {
    const scfg = config.scoring;
    const weights = scfg.weights;
    const volNorm = stableVolumeNorm(cluster.adjustedClusterVolume, scfg.volumeLogCap, scfg.volumeLogBase);
    const cpcNorm = Math.max(0.0, Math.min(1.0, (cluster.avgCpc || 0.0) / Math.max(scfg.cpcCap, 0.01)));
    const overlapMean = members.reduce((sum, rec) => sum + seedOverlapScore(rec, config), 0) / members.length;
    const raw = weights.volume * volNorm
      + weights.commercialIntent * cluster.avgCommercialIntent
      + weights.trend * cluster.trendScore
      + weights.seedOverlap * overlapMean
      + weights.cpc * cpcNorm;
    const totalW = Object.values(weights).reduce((a, b) => a + b, 0) || 1.0;
    cluster.opportunityScore = pyRound(Math.max(0.0, Math.min(1.0, raw / totalW)) * 100);
    cluster.recommended = false;
    return;
  }

  const weights = config.scoring.weights;
  const scfg = config.scoring;
  if (stats === null) {
    stats = {
      maxVolume: Math.max(Number(cluster.rawVariantVolume), 1.0),
      maxCpc: Math.max(Number(cluster.avgCpc), 0.01),
    };
  }
  const volNorm = normalizeVolume(cluster.rawVariantVolume, Math.max(stats.maxVolume, 1.0), scfg.volumeLogBase);
  const maxCpc = Math.max(stats.maxCpc, 0.01);
  const cpcNorm = Math.max(0.0, Math.min(1.0, (cluster.avgCpc || 0.0) / maxCpc));
  const meanDifficulty = members.reduce((a, m) => a + (m.keywordDifficulty !== null && m.keywordDifficulty !== undefined
    ? m.keywordDifficulty : scfg.difficultyMax / 2), 0) / members.length;
  let invDiff = 1.0 - (meanDifficulty / scfg.difficultyMax);
  invDiff = Math.max(0.0, Math.min(1.0, invDiff));
  const meanCompetition = members.reduce((a, m) => a + (m.competition !== null && m.competition !== undefined
    ? m.competition : scfg.competitionMax / 2), 0) / members.length;
  let invComp = 1.0 - (meanCompetition / scfg.competitionMax);
  invComp = Math.max(0.0, Math.min(1.0, invComp));

  const raw = weights.volume * volNorm
    + weights.commercialIntent * cluster.avgCommercialIntent
    + weights.trend * cluster.trendScore
    + weights.inverseDifficulty * invDiff
    + weights.inverseCompetition * invComp
    + weights.cpc * cpcNorm;
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0) || 1.0;
  cluster.opportunityScore = pyRound(Math.max(0.0, Math.min(1.0, raw / totalW)) * 100);
  cluster.recommended = cluster.opportunityScore >= config.scoring.clusterRecommendThreshold && blockingShare < 0.5;
}

export function scoreAllClusters(clusters, config) {
  for (const cluster of clusters) aggregateCluster(cluster);
  const stats = {
    maxVolume: clusters.length ? Math.max(...clusters.map((c) => Number(c.rawVariantVolume))) : 1.0,
    maxCpc: clusters.length ? Math.max(...clusters.map((c) => Number(c.avgCpc))) : 0.01,
  };
  for (const cluster of clusters) scoreCluster(cluster, config, stats);
}