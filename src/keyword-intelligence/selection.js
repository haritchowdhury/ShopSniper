import { createHash } from "node:crypto";
import { compactSignature, jaccard, signature, stableId } from "./dedup.js";

const LANES = ["category_discovery", "store_discovery", "local_discovery", "brand_competitor"];
const MAX_SEEDS = 5;
const MAX_SEED_LENGTH = 100;
const MAX_KEYWORD_LENGTH = 160;
const MAX_DRAFT_ITEMS = 200;
const MAX_DEFAULT_ITEMS = 100;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export function selectionItemId(sourceKind, originalNormalizedKeyword) {
  if (sourceKind !== "calculated" && sourceKind !== "manual") {
    throw new TypeError("invalid source kind");
  }
  if (typeof originalNormalizedKeyword !== "string" || originalNormalizedKeyword.length === 0 ||
      [...originalNormalizedKeyword].length > MAX_KEYWORD_LENGTH) {
    throw new TypeError("invalid keyword");
  }
  return stableId("ksi", `${sourceKind}\n${originalNormalizedKeyword}`);
}

function normalizeSeed(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeSeeds(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SEEDS) {
    return { ok: false, error: "seeds must be an array of 1-5 strings", issues: [{ field: "seeds", code: "seeds_length" }] };
  }
  const seen = new Map();
  const seeds = [];
  const issues = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (typeof raw !== "string") {
      issues.push({ field: `seeds[${i}]`, code: "seed_not_text" });
      continue;
    }
    if (CONTROL_RE.test(raw)) {
      issues.push({ field: `seeds[${i}]`, code: "seed_control_character" });
      continue;
    }
    const normalized = normalizeSeed(raw);
    const length = [...normalized].length;
    if (length < 1 || length > MAX_SEED_LENGTH) {
      issues.push({ field: `seeds[${i}]`, code: "seed_length", length });
      continue;
    }
    const key = normalized.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      issues.push({ field: `seeds[${i}]`, code: "seed_duplicate" });
      continue;
    }
    seen.set(key, i);
    seeds.push(normalized);
  }
  if (issues.length) {
    return { ok: false, error: "invalid seed list", issues, seeds };
  }
  return { ok: true, seeds };
}

function lower(itemId) {
  return itemId.toLowerCase();
}

function sortDefaultCompare(a, b) {
  const ar = a.recommended === true ? 1 : 0;
  const br = b.recommended === true ? 1 : 0;
  if (ar !== br) return br - ar;
  const ao = a.opportunityScore === null || a.opportunityScore === undefined ? -1 : a.opportunityScore;
  const bo = b.opportunityScore === null || b.opportunityScore === undefined ? -1 : b.opportunityScore;
  if (ao !== bo) return bo - ao;
  const av = a.searchVolume === null || a.searchVolume === undefined ? -1 : a.searchVolume;
  const bv = b.searchVolume === null || b.searchVolume === undefined ? -1 : b.searchVolume;
  if (av !== bv) return bv - av;
  const ak = lower(a.keyword);
  const bk = lower(b.keyword);
  if (ak !== bk) return ak < bk ? -1 : 1;
  const ai = lower(a.itemId);
  const bi = lower(b.itemId);
  if (ai !== bi) return ai < bi ? -1 : 1;
  return 0;
}

function metricsSnapshotOf(row) {
  if (!row || row.metricsSnapshot) return row?.metricsSnapshot ?? null;
  const allowed = [
    "searchVolume", "cpc", "competition", "competitionLevel", "keywordDifficulty",
    "mainIntent", "commercialIntent", "monthlyHistory", "trendSlope", "cluster",
    "clusterId", "variantGroupId", "variantCanonical", "flags",
    "opportunityScore", "recommended", "mergedInto", "availableMarkets", "marketMetrics",
  ];
  const snapshot = {};
  for (const key of allowed) {
    if (key in row) snapshot[key] = row[key];
  }
  return snapshot;
}

export function createDefaultSelection(rows, options = {}) {
  if (!Array.isArray(rows)) {
    return { ok: false, error: "rows must be an array", issues: [{ field: "rows", code: "rows_not_array" }] };
  }
  const onePerCluster = options.onePerCluster === true;
  const blockingFlags = options.blockingFlags instanceof Set ? options.blockingFlags : null;
  const eligible = rows.filter((row) => {
    if (row.mergedInto !== null && row.mergedInto !== undefined) return false;
    if (blockingFlags) {
      const flags = Array.isArray(row.flags) ? row.flags : (row.metricsSnapshot?.flags ?? []);
      if (flags.some((flag) => blockingFlags.has(flag))) return false;
    } else if (row.recommended !== true) {
      return false;
    }
    return true;
  });
  let chosen = eligible;
  if (onePerCluster) {
    const groups = new Map();
    for (const row of eligible) {
      const clusterId = row.clusterId
        || row.metricsSnapshot?.clusterId
        || selectionItemId("calculated", row.keyword);
      if (!groups.has(clusterId)) groups.set(clusterId, []);
      groups.get(clusterId).push(row);
    }
    chosen = [...groups.values()].map((members) => [...members].sort(sortDefaultCompare)[0]);
  }
  const sorted = [...chosen].sort(sortDefaultCompare);
  const items = sorted.slice(0, MAX_DEFAULT_ITEMS).map((row) => ({
    itemId: row.itemId ?? selectionItemId("calculated", row.keyword),
    sourceKind: "calculated",
    sourceKeywordId: row.itemId ?? null,
    originalKeyword: row.originalKeyword ?? row.keyword,
    keyword: row.keyword,
    sourceSeeds: Array.isArray(row.sourceSeeds) ? [...row.sourceSeeds] : [row.seed].filter(Boolean),
    lane: row.lane ?? "category_discovery",
    facets: row.facets ? { ...row.facets } : { audience: [], category: [], channel: [], fit: [], modifier: [] },
    metricsSnapshot: metricsSnapshotOf(row),
  }));
  const totalRecommended = sorted.length;
  return {
    ok: true,
    items,
    revision: 1,
    capped: totalRecommended > MAX_DEFAULT_ITEMS,
    totalRecommended,
    retained: items.length,
  };
}

export function validateSelectionDraft(items) {
  if (!Array.isArray(items)) {
    return { ok: false, error: "selection must be an array", issues: [{ field: "items", code: "items_not_array" }] };
  }
  if (items.length > MAX_DRAFT_ITEMS) {
    return { ok: false, error: "selection exceeds 200 items", issues: [{ field: "items", code: "draft_too_large", length: items.length }] };
  }
  const issues = [];
  const seenIds = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") {
      issues.push({ field: `items[${i}]`, code: "item_not_object" });
      continue;
    }
    if (item.sourceKind !== "calculated" && item.sourceKind !== "manual") {
      issues.push({ field: `items[${i}].sourceKind`, code: "invalid_source_kind" });
    }
    if (typeof item.itemId !== "string" || !/^ksi_[a-f0-9]{12}$/u.test(item.itemId)) {
      issues.push({ field: `items[${i}].itemId`, code: "invalid_item_id" });
    } else if (seenIds.has(item.itemId)) {
      issues.push({ field: `items[${i}].itemId`, code: "duplicate_item_id" });
    } else {
      seenIds.add(item.itemId);
    }
    if (typeof item.keyword !== "string" || [...item.keyword].length > MAX_KEYWORD_LENGTH) {
      issues.push({ field: `items[${i}].keyword`, code: "keyword_length" });
    }
    if (!Array.isArray(item.sourceSeeds)) {
      issues.push({ field: `items[${i}].sourceSeeds`, code: "source_seeds_not_array" });
    }
    if (!LANES.includes(item.lane)) {
      issues.push({ field: `items[${i}].lane`, code: "invalid_lane" });
    }
  }
  if (issues.length) {
    return { ok: false, error: "invalid selection draft", issues };
  }
  return { ok: true, items, revision: 1 };
}

function similarityReason(left, right, config) {
  const strip = config?.dedup?.stripTokens ?? ["a", "an", "the", "for", "and", "of", "with", "to", "in", "on"];
  if (compactSignature(left) === compactSignature(right)) {
    return { reason: "compact", similarity: 1 };
  }
  const sim = jaccard(similarityTokens(left, strip), similarityTokens(right, strip));
  if (sim >= (config?.dedup?.similarityThreshold ?? 0.88)) {
    return { reason: "similarity", similarity: sim };
  }
  return null;
}

function similarityTokens(keyword, strip) {
  return signature(keyword, strip);
}

export function analyzeSelectionConflicts(items, config = {}) {
  const list = Array.isArray(items) ? items : [];
  const seenIds = new Set();
  const unique = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = item.itemId;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    unique.push(item);
  }
  const parent = unique.map((_, index) => index);
  const pairs = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const result = similarityReason(unique[i].keyword, unique[j].keyword, config);
      if (result) {
        const left = unique[i].itemId;
        const right = unique[j].itemId;
        pairs.push({ left, right, ...result });
      }
    }
  }
  pairs.sort((a, b) => {
    if (a.left !== b.left) return a.left < b.left ? -1 : 1;
    if (a.right !== b.right) return a.right < b.right ? -1 : 1;
    return 0;
  });
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const byItemId = new Map();
  unique.forEach((item, index) => byItemId.set(item.itemId, index));
  for (const pair of pairs) {
    const a = byItemId.get(pair.left);
    const b = byItemId.get(pair.right);
    if (a !== undefined && b !== undefined) union(a, b);
  }
  const components = new Map();
  for (let i = 0; i < unique.length; i++) {
    const root = find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(i);
  }
  const ordered = [...components.values()].sort((a, b) => a[0] - b[0]);
  const results = [];
  for (const memberIndexes of ordered) {
    if (memberIndexes.length < 2) continue;
    const members = memberIndexes.map((index) => unique[index]);
    const itemIds = members.map((item) => item.itemId).sort();
    const conflictPairs = pairs.filter((pair) => itemIds.includes(pair.left) && itemIds.includes(pair.right));
    const canonical = canonicalItem(members);
    results.push({
      conflictId: conflictId(itemIds),
      itemIds,
      pairs: conflictPairs.map((pair) => ({
        leftItemId: pair.left,
        rightItemId: pair.right,
        reason: pair.reason,
        similarity: pair.reason === "compact" ? 1 : pair.similarity,
      })),
      canonicalItemId: canonical.itemId,
    });
  }
  return { ok: true, conflicts: results };
}

function conflictId(itemIds) {
  const digest = createHash("sha256").update(itemIds.join("\n")).digest("hex");
  return `ksc_${digest.slice(0, 16)}`;
}

function canonicalItem(members) {
  const rank = (item) => {
    const source = item.sourceKind === "calculated" ? 0 : 1;
    const opportunity = item.metricsSnapshot?.opportunityScore ?? -1;
    const volume = item.metricsSnapshot?.searchVolume ?? -1;
    const shortest = item.keyword ? [...item.keyword].length : Number.MAX_SAFE_INTEGER;
    const lowerKeyword = item.keyword ? item.keyword.toLocaleLowerCase("en-US") : "";
    const itemId = item.itemId ?? "";
    return [source, opportunity, volume, shortest, lowerKeyword, itemId];
  };
  return [...members].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return rb[1] - ra[1];
    if (ra[2] !== rb[2]) return rb[2] - ra[2];
    if (ra[3] !== rb[3]) return ra[3] - rb[3];
    if (ra[4] !== rb[4]) return ra[4] < rb[4] ? -1 : 1;
    if (ra[5] !== rb[5]) return ra[5] < rb[5] ? -1 : 1;
    return 0;
  })[0];
}
