import { commercialIntentScore } from "./intent.js";

export function pyRound(value, digits = 0) {
  if (!Number.isFinite(value)) return value;
  const sign = value < 0 || Object.is(value, -0) ? -1 : 1;
  const abs = Math.abs(value);
  if (abs === 0) return value;
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setFloat64(0, abs);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const exponent = (hi >>> 20) & 0x7ff;
  if (exponent === 0x7ff) return value;
  const significand = exponent === 0
    ? (BigInt(hi & 0xfffff) << 32n) + BigInt(lo)
    : ((BigInt(hi & 0xfffff) + 0x100000n) << 32n) + BigInt(lo);
  const e = exponent - 1023 - 52;
  const scale = 10n ** BigInt(digits);
  const m = significand * scale;
  if (e >= 0) {
    const q = m << BigInt(e);
    const result = Number(q) / Number(scale);
    return sign < 0 ? -result : result;
  }
  const denom = 1n << BigInt(-e);
  let q = m / denom;
  const r = m % denom;
  const twice = r * 2n;
  if (twice > denom) q += 1n;
  else if (twice === denom && (q & 1n) === 1n) q += 1n;
  const result = Number(q) / Number(scale);
  return sign < 0 ? -result : result;
}

function leastSquaresSlope(values) {
  const n = values.length;
  if (n < 2) return 0.0;
  const xs = values.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  for (let i = 0; i < n; i++) num += (xs[i] - meanX) * (values[i] - meanY);
  let den = 0;
  for (const x of xs) den += (x - meanX) ** 2;
  if (den === 0) return 0.0;
  return num / den;
}

export function computeTrendSlope(monthlyHistory, periods) {
  if (!monthlyHistory || monthlyHistory.length === 0) return null;
  const series = monthlyHistory
    .map((m) => [Number(m.year) || 0, Number(m.month) || 0, Number(m.searchVolume ?? m.search_volume) || 0])
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const volumes = series.map((s) => s[2]);
  const tail = volumes.length >= periods ? volumes.slice(-periods) : volumes;
  const slope = leastSquaresSlope(tail);
  const meanVol = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0.0;
  if (meanVol <= 0) return 0.0;
  const recentLinear = slope / meanVol;

  const byMonth = new Map();
  for (const [year, month, volume] of series) byMonth.set(`${year}:${month}`, volume);
  const yoyPairs = [];
  for (let i = Math.max(0, series.length - periods); i < series.length; i++) {
    const [year, month, volume] = series[i];
    const prior = byMonth.get(`${year - 1}:${month}`);
    if (prior !== undefined) yoyPairs.push([volume, prior]);
  }
  let rel;
  if (yoyPairs.length >= Math.min(3, periods)) {
    const recentMean = yoyPairs.reduce((a, p) => a + p[0], 0) / yoyPairs.length;
    const priorMean = yoyPairs.reduce((a, p) => a + p[1], 0) / yoyPairs.length;
    const yoy = priorMean > 0 ? (recentMean - priorMean) / priorMean : 0.0;
    rel = 0.85 * yoy + 0.15 * recentLinear;
  } else {
    rel = recentLinear;
  }
  return Math.max(-1.0, Math.min(1.0, rel));
}

export function normalizeItem(item, seed, config) {
  const keyword = item?.keyword;
  if (!keyword) return null;
  const kinfo = item.keyword_info || {};
  const props = item.keyword_properties || {};
  const sinfo = item.search_intent_info || {};
  const monthly = kinfo.monthly_searches || [];
  const history = monthly.map((m) => [m.year, m.month, m.search_volume || 0]);
  const mainIntent = sinfo.main_intent;
  const slope = computeTrendSlope(monthly, config.filters.decliningPeriods);
  const rec = {
    keyword,
    seed,
    searchVolume: kinfo.search_volume ?? null,
    cpc: kinfo.cpc ?? null,
    competition: kinfo.competition ?? null,
    competitionLevel: kinfo.competition_level ?? null,
    keywordDifficulty: props.keyword_difficulty ?? null,
    mainIntent: mainIntent ?? null,
    monthlyHistory: history,
    trendSlope: slope !== null && slope !== undefined ? slope : 0.0,
    commercialIntent: commercialIntentScore(keyword, mainIntent, config),
    clusterId: null,
    clusterLabel: null,
    flags: [],
    opportunityScore: null,
    recommended: false,
    mergedInto: null,
    sourceSeeds: [],
    variantGroupId: null,
    variantCanonical: null,
    lane: "category_discovery",
    facets: { audience: [], category: [], channel: [], fit: [], modifier: [] },
    marketMetrics: {},
  };
  Object.defineProperty(rec, "is_active", {
    enumerable: false,
    get() { return this.mergedInto === null; },
  });
  return rec;
}

export function hasMetrics(rec) {
  return rec.searchVolume !== null && rec.searchVolume !== undefined && rec.searchVolume > 0;
}

export function trendToZeroOne(slope) {
  if (slope === null || slope === undefined) return 0.5;
  return (slope + 1.0) / 2.0;
}

export function normalizeVolume(volume, maxVolume, logBase) {
  if (!volume || volume <= 0) return 0.0;
  const denom = Math.log(Math.max(maxVolume, 1.0) + 1.0) / Math.log(logBase);
  if (denom <= 0) return 0.0;
  return Math.max(0.0, Math.min(1.0, (Math.log(volume + 1.0) / Math.log(logBase)) / denom));
}