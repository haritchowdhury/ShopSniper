import { blake2s } from "@noble/hashes/blake2.js";

const TOKEN_RE = /[a-z0-9]+/g;

export const TOKEN_ALIASES = Object.freeze({
  woman: "women", womens: "women", female: "women", females: "women",
  lady: "women", ladies: "women",
  man: "men", mens: "men", male: "men", males: "men",
  clothes: "clothing", apparel: "clothing", attire: "clothing",
  shops: "store", shop: "store", stores: "store",
  retailer: "store", retailers: "store",
  outfits: "outfit", hoodies: "hoodie", shirts: "shirt",
  jackets: "jacket", coats: "coat", dresses: "dress",
  skirts: "skirt", pants: "pant", jeans: "jean",
  shoes: "shoe", paddles: "paddle",
});

export const INVARIANT_S_TOKENS = Object.freeze([
  "tennis", "canvas", "always", "news", "species", "series", "business", "circus", "atlas",
]);

const INVARIANT_S_TOKEN_SET = new Set(INVARIANT_S_TOKENS);

export function singularPluralAlias(t) {
  if (INVARIANT_S_TOKEN_SET.has(t)) return t;
  if (t.endsWith("s") && t.length > 4 && !t.endsWith("ss") && !t.endsWith("us") && !t.endsWith("is")) {
    return t.slice(0, -1);
  }
  return t;
}

export function tokenize(text, stripTokens) {
  const clean = text.replace(/([a-z]+)['’]s\b/gi, "$1");
  const raw = clean.toLowerCase().match(TOKEN_RE) || [];
  const strip = new Set(stripTokens || []);
  return raw.filter((t) => !strip.has(t));
}

export function signature(keyword, stripTokens) {
  const toks = tokenize(keyword, stripTokens);
  const norm = new Set();
  for (const t of toks) {
    const aliased = TOKEN_ALIASES[t];
    if (aliased) norm.add(aliased);
    else norm.add(singularPluralAlias(t));
  }
  return norm;
}

export function compactSignature(keyword) {
  const matches = keyword.toLowerCase().match(TOKEN_RE) || [];
  return matches.join("");
}

export function stableId(prefix, text) {
  const digest = blake2s(new TextEncoder().encode(text), { dkLen: 6 });
  return `${prefix}_${Buffer.from(digest).toString("hex")}`;
}

export function jaccard(a, b) {
  if (!a || !a.size || !b || !b.size) return 0.0;
  let inter = 0;
  for (const token of a) {
    if (b.has(token)) inter++;
  }
  const union = a.size + b.size - inter;
  return union ? inter / union : 0.0;
}

export function dedupVariants(records, config, operations = {}) {
  const threshold = config.dedup.similarityThreshold;
  const strip = config.dedup.stripTokens || [];
  operations.pairComparisons = 0;

  const active = records.filter((r) => r.is_active);
  const sigs = new Map();
  const compact = new Map();
  for (const r of active) {
    sigs.set(r, signature(r.keyword, strip));
    compact.set(r, compactSignature(r.keyword));
  }

  const parent = new Map();
  for (const r of active) parent.set(r, r);

  function find(x) {
    let root = x;
    while (parent.get(root) !== root) {
      parent.set(root, parent.get(parent.get(root)));
      root = parent.get(root);
    }
    return root;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  const n = active.length;
  for (let i = 0; i < n; i++) {
    const ri = active[i];
    if (!sigs.get(ri).size) continue;
    for (let j = i + 1; j < n; j++) {
      operations.pairComparisons += 1;
      const rj = active[j];
      if (!sigs.get(rj).size) continue;
      if (jaccard(sigs.get(ri), sigs.get(rj)) >= threshold ||
          compact.get(ri) === compact.get(rj)) {
        union(ri, rj);
      }
    }
  }

  const groups = new Map();
  for (const r of active) {
    const root = find(r);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }

  const result = [];
  for (const members of groups.values()) {
    let canonical = members[0];
    for (const m of members) {
      if ((m.searchVolume || 0) > (canonical.searchVolume || 0)) canonical = m;
      else if ((m.searchVolume || 0) === (canonical.searchVolume || 0) &&
               m.keyword.length < canonical.keyword.length) canonical = m;
    }
    const allSeeds = new Set();
    for (const m of members) {
      const seeds = m.sourceSeeds && m.sourceSeeds.length ? m.sourceSeeds : [m.seed];
      for (const s of seeds) allSeeds.add(s);
    }
    const sortedSeeds = [...allSeeds].sort();
    const groupId = stableId("v", [...sigs.get(canonical)].sort().join(" "));
    canonical.sourceSeeds = sortedSeeds;
    canonical.variantGroupId = groupId;
    canonical.variantCanonical = canonical.keyword;
    result.push(canonical);
    for (const m of members) {
      if (m !== canonical) {
        m.mergedInto = canonical.keyword;
        m.sourceSeeds = sortedSeeds;
        m.variantGroupId = groupId;
        m.variantCanonical = canonical.keyword;
        result.push(m);
      }
    }
  }
  return result;
}