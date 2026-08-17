import { signature, stableId } from "./dedup.js";

export const AUDIENCE = new Set(["women", "men", "kid", "kids", "baby", "unisex", "family"]);
export const CHANNEL = new Set(["online", "store", "boutique", "outlet", "retail", "shopping", "shipping"]);
export const GENERIC = new Set([
  "clothing", "fashion", "wear", "brand", "brands", "best", "cheap", "sale",
  "discount", "deal", "price", "premium", "luxury", "top", "trending", "near",
  "me", "close", "owned", "black", "new", "older", "young",
]);
export const CATEGORY_TERMS = Object.freeze({
  activewear: new Set(["activewear", "yoga"]),
  streetwear: new Set(["streetwear"]),
  swimwear: new Set(["swimwear", "bathing", "swimsuit"]),
  outerwear: new Set(["jacket", "coat", "outerwear"]),
  tops: new Set(["top", "shirt", "hoodie", "sweatshirt", "sweater", "tee"]),
  bottoms: new Set(["pant", "jean", "trouser", "skirt", "shorts"]),
  dresses: new Set(["dress", "gown"]),
  underwear: new Set(["underwear", "lingerie", "bra", "brief"]),
  sleepwear: new Set(["sleepwear", "pajama", "loungewear"]),
  footwear: new Set(["shoe", "sneaker", "boot", "sandal"]),
  accessories: new Set(["belt", "bag", "hat", "accessory", "jewelry"]),
});
export const FIT_TERMS = Object.freeze({
  "plus size": new Set(["plus", "size"]), "big and tall": new Set(["big", "tall"]),
  petite: new Set(["petite"]), maternity: new Set(["maternity"]), oversized: new Set(["oversized"]),
});
export const MODIFIER_TERMS = Object.freeze({
  affordable: new Set(["cheap", "affordable", "discount", "sale"]),
  luxury: new Set(["luxury", "premium"]), sustainable: new Set(["sustainable", "ethical"]),
  vintage: new Set(["vintage"]), consignment: new Set(["consignment"]),
});

const KNOWN_RETAIL = new Set([
  ...AUDIENCE, ...CHANNEL, ...GENERIC,
  ...[...Object.values(CATEGORY_TERMS)].flat(),
  ...[...Object.values(FIT_TERMS)].flat(),
  ...[...Object.values(MODIFIER_TERMS)].flat(),
]);

function jac(a, b) {
  if (!a.size || !b.size) return 0.0;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter++;
  return inter / (a.size + b.size - inter);
}

function tokens(keyword, strip) {
  return signature(keyword, strip);
}

function facets(tokens, keyword) {
  const audience = [...tokens].filter((t) => AUDIENCE.has(t)).sort();
  const categories = Object.keys(CATEGORY_TERMS).filter((name) => {
    const terms = CATEGORY_TERMS[name];
    for (const t of tokens) if (terms.has(t)) return true;
    return false;
  }).sort();
  const fits = Object.keys(FIT_TERMS).filter((name) => {
    const terms = FIT_TERMS[name];
    if (terms.size === 1) {
      for (const t of tokens) if (terms.has(t)) return true;
      return false;
    }
    for (const t of terms) if (!tokens.has(t)) return false;
    return true;
  }).sort();
  const modifiers = Object.keys(MODIFIER_TERMS).filter((name) => {
    const terms = MODIFIER_TERMS[name];
    for (const t of tokens) if (terms.has(t)) return true;
    return false;
  }).sort();
  const channels = [];
  if (tokens.has("online")) channels.push("online");
  if ([...tokens].some((t) => CHANNEL.has(t) && t !== "online")) channels.push("store");
  if (/\b(near me|close to me|closest|nearest)\b/i.test(keyword)) channels.push("local");
  return {
    audience,
    category: categories,
    channel: [...new Set(channels)].sort(),
    fit: fits,
    modifier: modifiers,
  };
}

function lane(record, tokens) {
  const low = record.keyword.toLowerCase();
  if (/\b(near me|close to me|closest|nearest|nyc|new york|in [a-z]+)\b/i.test(low)) {
    return "local_discovery";
  }
  if (tokens.has("brand") || tokens.has("brands")) return "brand_competitor";
  const unknown = new Set([...tokens].filter((t) => !KNOWN_RETAIL.has(t)));
  if ((record.mainIntent || "").toLowerCase() === "navigational" && unknown.size) return "brand_competitor";
  if (unknown.size && [...tokens].some((t) => CHANNEL.has(t))) return "brand_competitor";
  if ([...tokens].some((t) => CHANNEL.has(t))) return "store_discovery";
  return "category_discovery";
}

function topicTokens(record, tokens) {
  const core = new Set([...tokens].filter((t) => !AUDIENCE.has(t) && !CHANNEL.has(t) && !GENERIC.has(t)));
  if (record.lane === "brand_competitor") {
    const unknown = new Set([...tokens].filter((t) => !KNOWN_RETAIL.has(t)));
    if (unknown.size) {
      const categoryTerms = new Set([...Object.values(CATEGORY_TERMS)].flat());
      return new Set([...unknown, ...[...core].filter((t) => categoryTerms.has(t))]);
    }
  }
  if (core.size) return core;
  const audience = new Set([...tokens].filter((t) => AUDIENCE.has(t)));
  if (audience.size) return new Set([...audience, "clothing"]);
  return tokens.has("clothing") ? new Set(["clothing"]) : tokens;
}

function compatible(a, b) {
  return (a.lane === "brand_competitor") === (b.lane === "brand_competitor");
}

function representative(members, topics) {
  let best = members[0];
  let bestRank = null;
  for (const rec of members) {
    const sims = members.map((other) => jac(topics.get(rec), topics.get(other)));
    const centrality = sims.reduce((a, b) => a + b, 0) / sims.length;
    const nonNav = (rec.mainIntent || "").toLowerCase() !== "navigational";
    const rank = [centrality, nonNav ? 1 : 0, -topics.get(rec).size, rec.searchVolume || 0, -rec.keyword.length];
    if (bestRank === null || compareRank(rank, bestRank) > 0) {
      bestRank = rank;
      best = rec;
    }
  }
  return best;
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function clusterLabel(members, topics) {
  const rep = representative(members, topics);
  if (members.length < 4 || members.every((r) => r.lane === "brand_competitor")) {
    return rep.keyword;
  }
  const categoryCounts = new Map();
  for (const r of members) for (const v of r.facets.category || []) categoryCounts.set(v, (categoryCounts.get(v) || 0) + 1);
  const audienceCounts = new Map();
  for (const r of members) for (const v of r.facets.audience || []) audienceCounts.set(v, (audienceCounts.get(v) || 0) + 1);
  const fitCounts = new Map();
  for (const r of members) for (const v of r.facets.fit || []) fitCounts.set(v, (fitCounts.get(v) || 0) + 1);
  const mostCommon = (counts, min) => {
    let best = "";
    let bestCount = 0;
    for (const [v, c] of counts) {
      if (c > bestCount) {
        best = v;
        bestCount = c;
      }
    }
    return bestCount >= min ? best : "";
  };
  const category = mostCommon(categoryCounts, members.length * 0.75);
  const audience = mostCommon(audienceCounts, members.length * 0.75);
  const fit = mostCommon(fitCounts, members.length * 0.75);
  const audienceLabel = { women: "women's", men: "men's", kid: "kids'", kids: "kids'" }[audience] ?? audience;
  if (category) {
    if (category === "activewear" || category === "streetwear") {
      return [audienceLabel, fit, category].filter(Boolean).join(" ");
    }
    return rep.keyword;
  }
  if (fit) {
    return [audienceLabel, fit, "clothing"].filter(Boolean).join(" ");
  }
  if (audience) {
    const storeShare = members.filter((r) => r.lane === "store_discovery" || r.lane === "local_discovery").length / members.length;
    if (storeShare >= 0.6) return `${audienceLabel} clothing stores`;
    return `${audienceLabel} clothing`;
  }
  return rep.keyword;
}

function metricFingerprint(record) {
  const history = record.monthlyHistory.map((h) => h[2]);
  return JSON.stringify([
    record.searchVolume || 0, history, record.cpc, record.competition, record.keywordDifficulty,
  ]);
}

function aggregateMetadata(cluster, records) {
  const rows = [...records];
  const uniqueVariants = new Map();
  for (const row of rows) {
    const key = row.keyword.trim().toLowerCase();
    uniqueVariants.set(key, Math.max(uniqueVariants.get(key) || 0, row.searchVolume || 0));
  }
  cluster.rawVariantVolume = [...uniqueVariants.values()].reduce((a, b) => a + b, 0);
  cluster.combinedVolume = cluster.rawVariantVolume;
  cluster.headlineVolume = rows.reduce((a, r) => Math.max(a, r.searchVolume || 0), 0);
  const distinctRows = new Map();
  for (const row of rows) {
    const key = row.keyword.trim().toLowerCase();
    const current = distinctRows.get(key);
    if (current === undefined || (row.searchVolume || 0) > (current.searchVolume || 0)) distinctRows.set(key, row);
  }
  const buckets = new Map();
  for (const row of distinctRows.values()) {
    const fp = metricFingerprint(row);
    buckets.set(fp, Math.max(buckets.get(fp) || 0, row.searchVolume || 0));
  }
  cluster.adjustedClusterVolume = [...buckets.values()].reduce((a, b) => a + b, 0);
  const seedSet = new Set();
  for (const r of rows) for (const s of (r.sourceSeeds && r.sourceSeeds.length ? r.sourceSeeds : [r.seed])) seedSet.add(s);
  cluster.sourceSeeds = [...seedSet].sort();
  const laneCounts = new Map();
  for (const r of rows) laneCounts.set(r.lane, (laneCounts.get(r.lane) || 0) + 1);
  cluster.laneCounts = Object.fromEntries([...laneCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const facetValues = new Map();
  for (const row of rows) {
    for (const [name, values] of Object.entries(row.facets)) {
      if (!facetValues.has(name)) facetValues.set(name, new Set());
      for (const v of values) facetValues.get(name).add(v);
    }
  }
  cluster.facets = Object.fromEntries([...facetValues.entries()].map(([name, set]) => [name, [...set].sort()]));
}

export function clusterKeywords(records, config, operations = {}) {
  const threshold = config.clustering.similarityThreshold;
  const strip = config.dedup.stripTokens || [];
  operations.pairComparisons = 0;
  const active = records.filter((r) => r.is_active);
  const topics = new Map();
  for (const record of active) {
    const toks = tokens(record.keyword, strip);
    record.facets = facets(toks, record.keyword);
    record.lane = lane(record, toks);
    topics.set(record, topicTokens(record, toks));
  }

  const groups = [];
  const sorted = [...active].sort((a, b) => (b.searchVolume || 0) - (a.searchVolume || 0));
  for (const record of sorted) {
    let bestGroup = null;
    let bestScore = -1.0;
    for (const members of groups) {
      const rep = representative(members, topics);
      if (!compatible(record, rep)) continue;
      const repScore = jac(topics.get(record), topics.get(rep));
      let minimum = Infinity;
      for (const m of members) {
        operations.pairComparisons += 1;
        minimum = Math.min(minimum, jac(topics.get(record), topics.get(m)));
      }
      if (repScore >= threshold && minimum > 0 && repScore > bestScore) {
        bestGroup = members;
        bestScore = repScore;
      }
    }
    if (bestGroup === null) groups.push([record]);
    else bestGroup.push(record);
  }

  const clusters = [];
  for (const members of groups) {
    const labelRec = representative(members, topics);
    const label = clusterLabel(members, topics);
    const cid = stableId("c", `${label.toLowerCase()}|${labelRec.keyword.toLowerCase()}|${labelRec.lane}`);
    for (const member of members) {
      member.clusterId = cid;
      member.clusterLabel = label;
    }
    const cluster = {
      label,
      records: members,
      clusterId: cid,
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
      facets: { audience: [], category: [], channel: [], fit: [], modifier: [] },
    };
    aggregateMetadata(cluster, members);
    clusters.push(cluster);
  }
  clusters.sort((a, b) => {
    const d = b.adjustedClusterVolume - a.adjustedClusterVolume;
    if (d !== 0) return d;
    return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0;
  });
  return clusters;
}

export function attachVariants(clusters, allRecords) {
  const canonicalByName = new Map();
  for (const c of clusters) for (const r of c.records) canonicalByName.set(r.keyword, r);
  const clusterById = new Map(clusters.map((c) => [c.clusterId, c]));
  const rowsByCluster = new Map();
  for (const record of allRecords) {
    const canonical = canonicalByName.get(record.mergedInto || record.keyword);
    if (!canonical) continue;
    record.clusterId = canonical.clusterId;
    record.clusterLabel = canonical.clusterLabel;
    record.lane = canonical.lane;
    record.facets = canonical.facets;
    if (!rowsByCluster.has(canonical.clusterId)) rowsByCluster.set(canonical.clusterId, []);
    rowsByCluster.get(canonical.clusterId).push(record);
  }

  for (const [cid, rows] of rowsByCluster) {
    const cluster = clusterById.get(cid);
    const groups = new Map();
    for (const row of rows) {
      const gid = row.variantGroupId || stableId("v", row.keyword);
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid).push(row);
    }
    const payload = [];
    for (const [groupId, variants] of groups) {
      const canonical = variants.find((r) => r.is_active) || variants[0];
      const seedSet = new Set();
      for (const v of variants) for (const s of (v.sourceSeeds && v.sourceSeeds.length ? v.sourceSeeds : [v.seed])) seedSet.add(s);
      payload.push({
        variantGroupId: groupId,
        canonical: canonical.keyword,
        variants: [...new Set(variants.map((v) => v.keyword))].sort(),
        volume: canonical.searchVolume || 0,
        sourceSeeds: [...seedSet].sort(),
      });
    }
    cluster.variantGroups = payload.sort((a, b) => {
      const d = b.volume - a.volume;
      if (d !== 0) return d;
      return a.canonical.localeCompare(b.canonical);
    });
    aggregateMetadata(cluster, rows);
  }
}