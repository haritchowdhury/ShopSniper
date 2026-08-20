import { pyRound } from "./normalize.js";

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(fields) {
  return fields.map(csvEscape).join(",");
}

function neutralizeTextCell(value) {
  if (typeof value !== "string") return value;
  if (/^[\t\r]/u.test(value) || /^\s*[=+\-@]/u.test(value)) return value.startsWith("'") ? value : "'" + value;
  return value;
}

function pyFloatStr(v) {
  if (Number.isInteger(v)) return `${v}.0`;
  return String(v);
}

function pyBoolStr(v) {
  return v ? "True" : "False";
}

function intStr(v) {
  return v === null || v === undefined ? "" : String(v);
}

function pyDumps(value, compact = false) {
  const seen = new WeakSet();
  const sep = compact ? [",", ":"] : [", ", ": "];
  function esc(s) {
    let out = "";
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (code < 0x20) {
        const table = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
        out += table[ch] ?? `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
      } else if (code === 0x22) {
        out += '\\"';
      } else if (code === 0x5c) {
        out += "\\\\";
      } else if (code < 0x80) {
        out += ch;
      } else if (code > 0xffff) {
        const c = code - 0x10000;
        out += `\\u${(0xd800 + (c >> 10)).toString(16).toUpperCase()}\\u${(0xdc00 + (c & 0x3ff)).toString(16).toUpperCase()}`;
      } else {
        out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
      }
    }
    return out;
  }
  function walk(v) {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "string") return `"${esc(v)}"`;
    if (t === "number") return Number.isFinite(v) ? String(v) : "null";
    if (t === "boolean") return String(v);
    if (t === "undefined") return "null";
    if (Array.isArray(v)) {
      if (seen.has(v)) return "null";
      seen.add(v);
      const out = v.map(walk).join(sep[0]);
      seen.delete(v);
      return `[${out}]`;
    }
    if (t === "object") {
      if (seen.has(v)) return "null";
      seen.add(v);
      const out = Object.keys(v).map((k) => `"${esc(k)}"${sep[1]}${walk(v[k])}`).join(sep[0]);
      seen.delete(v);
      return `{${out}}`;
    }
    return "null";
  }
  return walk(value);
}

function payloadMonthHistory(history) {
  return history.map(({ year, month, searchVolume }) => ({ year, month, search_volume: searchVolume }));
}

function variantGroupToPy(vg) {
  return {
    variant_group_id: vg.variantGroupId,
    canonical: vg.canonical,
    variants: vg.variants,
    volume: vg.volume,
    source_seeds: vg.sourceSeeds,
  };
}

function clusterRowToDict(c) {
  return {
    cluster: c.cluster,
    cluster_id: c.clusterId,
    keywords: c.keywords,
    combined_volume: c.combinedVolume,
    headline_volume: c.headlineVolume,
    adjusted_cluster_volume: c.adjustedClusterVolume,
    raw_variant_volume: c.rawVariantVolume,
    variant_groups: c.variantGroups.map(variantGroupToPy),
    source_seeds: c.sourceSeeds,
    lane_counts: c.laneCounts,
    facets: c.facets,
    avg_cpc: pyRound(c.avgCpc, 2),
    commercial_intent: pyRound(c.commercialIntent, 2),
    trend_score: pyRound(c.trendScore, 2),
    opportunity_score: c.opportunityScore,
    recommended_for_store_discovery: c.recommendedForStoreDiscovery,
  };
}

export function serializeClustersJson(clusters) {
  const payload = clusters.map(clusterRowToDict);
  return JSON.stringify(payload, null, 2);
}

const CLUSTER_CSV_COLS = [
  "cluster", "cluster_id", "combined_volume", "headline_volume",
  "adjusted_cluster_volume", "raw_variant_volume", "avg_cpc", "commercial_intent",
  "trend_score", "opportunity_score",
  "recommended_for_store_discovery", "num_keywords", "keywords",
  "source_seeds", "lane_counts", "facets", "variant_groups",
];

export function serializeClustersCsv(clusters) {
  const lines = [csvRow(CLUSTER_CSV_COLS)];
  for (const c of clusters) {
    const d = clusterRowToDict(c);
    lines.push(csvRow([
      d.cluster, d.cluster_id, intStr(d.combined_volume),
      intStr(d.headline_volume), intStr(d.adjusted_cluster_volume),
      intStr(d.raw_variant_volume), pyFloatStr(d.avg_cpc),
      pyFloatStr(d.commercial_intent), pyFloatStr(d.trend_score), intStr(d.opportunity_score),
      pyBoolStr(d.recommended_for_store_discovery), intStr(c.keywords.length),
      c.keywords.join("|"),
      (d.source_seeds || []).join("|"),
      pyDumps(d.lane_counts),
      pyDumps(d.facets),
      pyDumps(d.variant_groups),
    ]));
  }
  return lines.join("\n") + "\n";
}

function keywordRowToDict(r) {
  return {
    keyword: r.keyword,
    seed: r.seed,
    source_seeds: r.sourceSeeds && r.sourceSeeds.length ? r.sourceSeeds : [r.seed],
    search_volume: r.searchVolume,
    cpc: r.cpc,
    competition: r.competition,
    competition_level: r.competitionLevel,
    keyword_difficulty: r.keywordDifficulty,
    main_intent: r.mainIntent,
    commercial_intent: pyRound(r.commercialIntent, 2),
    monthly_history: payloadMonthHistory(r.monthlyHistory),
    trend_slope: r.trendSlope !== null && r.trendSlope !== undefined ? pyRound(r.trendSlope, 3) : null,
    cluster: r.cluster,
    cluster_id: r.clusterId,
    lane: r.lane,
    facets: r.facets,
    variant_group_id: r.variantGroupId,
    variant_canonical: r.variantCanonical,
    flags: r.flags,
    opportunity_score: r.opportunityScore,
    recommended: r.recommended,
    merged_into: r.mergedInto,
    available_markets: r.availableMarkets,
  };
}

export function serializeKeywordsJson(records) {
  const payload = records.map(keywordRowToDict);
  return JSON.stringify(payload, null, 2);
}

const KEYWORD_CSV_COLS = [
  "keyword", "seed", "source_seeds", "search_volume", "cpc", "competition",
  "competition_level", "keyword_difficulty", "main_intent",
  "commercial_intent", "trend_slope", "cluster", "cluster_id", "lane",
  "facets", "variant_group_id", "variant_canonical", "flags",
  "opportunity_score", "recommended", "merged_into",
  "monthly_history",
  "available_markets",
];

export function serializeKeywordsCsv(records) {
  const lines = [csvRow(KEYWORD_CSV_COLS)];
  for (const r of records) {
    const d = keywordRowToDict(r);
    lines.push(csvRow([
      neutralizeTextCell(d.keyword), neutralizeTextCell(d.seed),
      neutralizeTextCell(d.source_seeds.join("|")),
      intStr(d.search_volume), pyFloatStr(d.cpc), pyFloatStr(d.competition),
      neutralizeTextCell(d.competition_level || ""), intStr(d.keyword_difficulty),
      neutralizeTextCell(d.main_intent || ""),
      pyFloatStr(d.commercial_intent),
      d.trend_slope !== null && d.trend_slope !== undefined ? pyFloatStr(d.trend_slope) : "",
      neutralizeTextCell(d.cluster || ""), neutralizeTextCell(d.cluster_id || ""),
      neutralizeTextCell(d.lane),
      neutralizeTextCell(pyDumps(d.facets, true)),
      neutralizeTextCell(d.variant_group_id || ""), neutralizeTextCell(d.variant_canonical || ""),
      neutralizeTextCell((d.flags || []).join(";")),
      intStr(d.opportunity_score), pyBoolStr(d.recommended),
      neutralizeTextCell(d.merged_into || ""),
      neutralizeTextCell(pyDumps(d.monthly_history, true)),
      neutralizeTextCell(d.available_markets.join("|")),
    ]));
  }
  return lines.join("\n") + "\n";
}

export function serializeMarketsManifest(markets) {
  return JSON.stringify({
    schema_version: 3,
    default_market: "all",
    markets: markets.map((m) => ({
      code: m.code,
      name: m.name,
      location_code: m.locationCode,
      language_code: m.languageCode,
      language_name: m.languageName,
    })),
  }, null, 2);
}

export function serializeMarketJson(records, market, clusterMetrics, summary) {
  const code = market.code;
  const keywordMetrics = {};
  for (const record of records) {
    const metric = record.marketMetrics[code];
    if (metric !== undefined && metric !== null) {
      keywordMetrics[record.keyword.trim().toLowerCase()] = {
        country_code: metric.countryCode,
        location_code: metric.locationCode,
        location_name: metric.locationName,
        language_name: metric.languageName,
        search_volume: metric.searchVolume,
        cpc: metric.cpc,
        competition: metric.competition,
        competition_level: metric.competitionLevel,
        keyword_difficulty: metric.keywordDifficulty,
        main_intent: metric.mainIntent,
        commercial_intent: pyRound(metric.commercialIntent, 2),
        monthly_history: payloadMonthHistory(metric.monthlyHistory),
        trend_slope: metric.trendSlope !== null && metric.trendSlope !== undefined ? pyRound(metric.trendSlope, 3) : null,
        flags: metric.flags,
        opportunity_score: metric.opportunityScore,
        recommended: metric.recommended,
      };
    }
  }
  return JSON.stringify({
    schema_version: 3,
    market: {
      code: market.code,
      name: market.name,
      location_code: market.locationCode,
      language_code: market.languageCode,
      language_name: market.languageName,
    },
    summary,
    keywords: keywordMetrics,
    clusters: clusterMetrics,
  }, null, 2);
}