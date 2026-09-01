import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyKeywordForSelection,
  clusterKeywords,
} from "../src/keyword-intelligence/cluster.js";
import { readFileSync } from "node:fs";
import {
  keywordResearchConfigV1,
  keywordResearchConfigV2,
  keywordResearchConfigV2Schema,
} from "../src/keyword-intelligence/config.js";
import { computeResearchResult } from "../src/keyword-intelligence/pipeline.js";
import { LEAD_FINDING_BLOCKING_FLAGS, compareLeadFindingShortlist, flagRecord, leadFindingShortlistGroup, scoreRecord } from "../src/keyword-intelligence/score.js";
import {
  analyzeSelectionConflicts,
  createDefaultSelection,
} from "../src/keyword-intelligence/selection.js";

const CONFIG = keywordResearchConfigV2();

function activeRecord(keyword, extras = {}) {
  const rec = {
    keyword,
    seed: extras.seed ?? "seed",
    sourceSeeds: extras.sourceSeeds ?? [extras.seed ?? "seed"],
    searchVolume: extras.searchVolume ?? 1000,
    cpc: extras.cpc ?? 1.5,
    competition: 0.4,
    competitionLevel: "MEDIUM",
    keywordDifficulty: 40,
    mainIntent: extras.mainIntent ?? "commercial",
    monthlyHistory: [[2026, 1, extras.searchVolume ?? 1000]],
    trendSlope: 0.1,
    commercialIntent: extras.commercialIntent ?? 0.85,
    clusterId: extras.clusterId ?? null,
    clusterLabel: null,
    flags: extras.flags ?? [],
    opportunityScore: extras.opportunityScore ?? null,
    recommended: extras.recommended ?? false,
    mergedInto: extras.mergedInto ?? null,
    variantGroupId: null,
    variantCanonical: null,
    lane: extras.lane ?? "category_discovery",
    facets: { audience: [], category: [], channel: [], fit: [], modifier: [] },
    marketMetrics: {},
  };
  Object.defineProperty(rec, "is_active", {
    enumerable: false,
    get() { return this.mergedInto === null; },
  });
  return rec;
}

test("CASE-KR-L-000 v2 config snapshot is strict", () => {
  const parsed = keywordResearchConfigV2Schema.parse(CONFIG);
  assert.equal(parsed.schemaVersion, "keyword-research-config-v2");
  assert.equal(parsed.clustering.method, "concept_key");
  assert.equal("recommendThreshold" in parsed.scoring, false);
});

test("CASE-KR-L-001 pickleball store is store_discovery, not brand", () => {
  const classified = classifyKeywordForSelection("pickleball store", {
    stripTokens: CONFIG.dedup.stripTokens,
    classification: CONFIG.classification,
  });
  assert.equal(classified.lane, "store_discovery");
  assert.deepEqual(classified.facets.audience, []);
  assert.deepEqual(classified.facets.category, []);
});

test("CASE-KR-L-002 best ceramic mugs online is category_discovery", () => {
  const classified = classifyKeywordForSelection("best ceramic mugs online", {
    stripTokens: CONFIG.dedup.stripTokens,
    classification: CONFIG.classification,
  });
  assert.equal(classified.lane, "category_discovery");
  assert.ok(classified.facets.channel.includes("online"));
});

test("CASE-KR-L-003 walmart women's clothes is brand_competitor", () => {
  const classified = classifyKeywordForSelection("walmart women's clothes clearance", {
    stripTokens: CONFIG.dedup.stripTokens,
    classification: CONFIG.classification,
  });
  assert.equal(classified.lane, "brand_competitor");
});

test("CASE-KR-L-004 five near-me variants share one cluster and are not default-selected", () => {
  const phrases = [
    "clothing store near me",
    "clothing shopping stores near me",
    "clothing store close to me",
    "clothing store closest to me",
    "clothing shopping near me",
  ];
  const records = phrases.map((keyword, index) => activeRecord(keyword, { searchVolume: 2000 - index }));
  clusterKeywords(records, CONFIG);
  const ids = new Set(records.map((row) => row.clusterId));
  assert.equal(ids.size, 1, `expected one cluster, got ${[...ids].join(",")}`);
  for (const row of records) {
    assert.equal(row.lane, "local_discovery");
    flagRecord(row, CONFIG);
    assert.ok(row.flags.includes("local_intent"));
    row.opportunityScore = 70;
  }
  const selection = createDefaultSelection(records, {
    onePerCluster: true,
    blockingFlags: LEAD_FINDING_BLOCKING_FLAGS,
  });
  assert.equal(selection.items.length, 0);
});

test("CASE-KR-L-005 paddle paraphrases share a cluster; one default representative", () => {
  const records = [
    activeRecord("pickleball paddles", { seed: "pickleball", searchVolume: 4000, opportunityScore: 80 }),
    activeRecord("buy pickleball paddles online", { seed: "pickleball", searchVolume: 1200, opportunityScore: 70 }),
  ];
  clusterKeywords(records, CONFIG);
  assert.equal(records[0].clusterId, records[1].clusterId);
  assert.equal(records[0].lane, "category_discovery");
  const selection = createDefaultSelection(records, {
    onePerCluster: true,
    blockingFlags: LEAD_FINDING_BLOCKING_FLAGS,
  });
  assert.equal(selection.items.length, 1);
  assert.equal(selection.items[0].keyword, "pickleball paddles");
});

test("CASE-KR-L-006 numeric junk is flagged and not default-selected", () => {
  const records = [
    activeRecord("4.12 4 clothing store", { searchVolume: 5000, opportunityScore: 75 }),
    activeRecord("clothing store", { searchVolume: 800, opportunityScore: 60 }),
  ];
  clusterKeywords(records, CONFIG);
  for (const row of records) flagRecord(row, CONFIG);
  assert.ok(records[0].flags.includes("junk_quality"));
  const selection = createDefaultSelection(records, {
    onePerCluster: true,
    blockingFlags: LEAD_FINDING_BLOCKING_FLAGS,
  });
  assert.equal(selection.items.length, 1);
  assert.equal(selection.items[0].keyword, "clothing store");
});

test("CASE-KR-L-007 informational stays selectable but is not defaulted", () => {
  const records = [
    activeRecord("how to start a clothing brand", { mainIntent: "informational", opportunityScore: 90 }),
    activeRecord("clothing store", { opportunityScore: 50, searchVolume: 2000 }),
  ];
  clusterKeywords(records, CONFIG);
  for (const row of records) flagRecord(row, CONFIG);
  assert.ok(records[0].flags.includes("informational_dropped"));
  const selection = createDefaultSelection(records, {
    onePerCluster: true,
    blockingFlags: LEAD_FINDING_BLOCKING_FLAGS,
  });
  assert.ok(selection.items.every((item) => item.keyword !== "how to start a clothing brand"));
});

test("CASE-KR-L-008 canonical suggestion keeps the higher score", () => {
  const items = [
    {
      itemId: "ksi_aaaaaaaaaaaa",
      sourceKind: "calculated",
      keyword: "leather handbags",
      metricsSnapshot: { opportunityScore: 10, searchVolume: 100 },
    },
    {
      itemId: "ksi_bbbbbbbbbbbb",
      sourceKind: "calculated",
      keyword: "leather handbag",
      metricsSnapshot: { opportunityScore: 90, searchVolume: 1000 },
    },
  ];
  const analysis = analyzeSelectionConflicts(items, CONFIG);
  assert.equal(analysis.conflicts.length, 1);
  assert.equal(analysis.conflicts[0].canonicalItemId, "ksi_bbbbbbbbbbbb");
});

test("CASE-KR-L-009 lead score is stable across peer populations", () => {
  const rec = activeRecord("pickleball paddles", { searchVolume: 500, cpc: 2, seed: "pickleball" });
  rec.lane = "category_discovery";
  rec.flags = [];
  scoreRecord(rec, { maxVolume: 600, maxCpc: 3 }, CONFIG);
  const weak = rec.opportunityScore;
  scoreRecord(rec, { maxVolume: 250000, maxCpc: 80 }, CONFIG);
  assert.equal(rec.opportunityScore, weak);
});

test("CASE-KR-L-010 v1 golden computeResearchResult stays on the v1 path", () => {
  const input = JSON.parse(readFileSync("test/fixtures/keyword-intelligence/parity-input-v1.json", "utf8"));
  const golden = JSON.parse(readFileSync("test/fixtures/keyword-intelligence/parity-output-v1.json", "utf8"));
  const result = computeResearchResult({
    ...input,
    researchId: golden.researchId,
    generation: golden.generation,
    configFingerprint: golden.configFingerprint,
  });
  assert.equal(result.contractVersion, 1);
  assert.equal(result.summary.recommendedKeywords, golden.summary.recommendedKeywords);
  assert.equal(keywordResearchConfigV1().schemaVersion, "keyword-research-config-v1");
});

const RETAILER_CLASSIFY = {
  stripTokens: CONFIG.dedup.stripTokens,
  classification: CONFIG.classification,
};

test("CASE-KR-L-011 retailer folds, aliases, and edit-distance 1 are brand_competitor", () => {
  const phrases = [
    "walmart women's clothes clearance",
    "wal-mart clothes",
    "wal mart clothes",
    "wallmart clothes",
    "amazom shoes",
    "home depot paint supplies",
    "best buy headphones",
    "macys dresses",
  ];
  for (const keyword of phrases) {
    const classified = classifyKeywordForSelection(keyword, RETAILER_CLASSIFY);
    assert.equal(classified.lane, "brand_competitor", keyword);
  }
});

test("CASE-KR-L-012 short retailer tokens do not match lookalikes", () => {
  const phrases = [
    ["wishlist clothing", "category_discovery"],
    ["idea clothes", "category_discovery"],
    ["fish store", "store_discovery"],
    ["pickleball store", "store_discovery"],
    ["best ceramic mugs online", "category_discovery"],
    ["targeted ads clothing", "category_discovery"],
  ];
  for (const [keyword, lane] of phrases) {
    const classified = classifyKeywordForSelection(keyword, RETAILER_CLASSIFY);
    assert.equal(classified.lane, lane, keyword);
  }
});

test("CASE-KR-L-013 v2 shortlist spends overview slots on clean phrases first", () => {
  const cleanLow = {
    keyword: "pickleball paddles",
    recommended: false,
    opportunityScore: 20,
    searchVolume: 200,
    itemId: "kw_clean",
    flags: [],
  };
  const retailerHigh = {
    keyword: "wallmart clothes",
    recommended: false,
    opportunityScore: 90,
    searchVolume: 80000,
    itemId: "kw_retailer",
    flags: ["brand_competitor"],
  };
  const localHigh = {
    keyword: "clothing store near me",
    recommended: false,
    opportunityScore: 80,
    searchVolume: 50000,
    itemId: "kw_local",
    flags: ["local_intent"],
  };
  const junkHigh = {
    keyword: "4.12 4 clothing store",
    recommended: false,
    opportunityScore: 70,
    searchVolume: 40000,
    itemId: "kw_junk",
    flags: ["junk_quality"],
  };
  const informational = {
    keyword: "how to start a clothing brand",
    recommended: false,
    opportunityScore: 95,
    searchVolume: 90000,
    itemId: "kw_info",
    flags: ["informational_dropped"],
  };
  const rows = [informational, retailerHigh, junkHigh, localHigh, cleanLow];
  const sorted = [...rows].sort((left, right) => compareLeadFindingShortlist(left, right, (a, b) => {
    if (a.opportunityScore !== b.opportunityScore) return b.opportunityScore - a.opportunityScore;
    return String(a.itemId).localeCompare(String(b.itemId));
  }));
  assert.deepEqual(sorted.map((row) => row.itemId), [
    "kw_clean", "kw_retailer", "kw_local", "kw_junk", "kw_info",
  ]);
  assert.equal(leadFindingShortlistGroup(cleanLow), 0);
  assert.equal(leadFindingShortlistGroup(retailerHigh), 1);
  assert.equal(leadFindingShortlistGroup(informational), 2);
});

test("CASE-KR-L-014 v2 shortlist demotion is wired in the anchor aggregator; v1 comparator stays bare", () => {
  const service = readFileSync(new URL("../src/aws-pipeline/keyword-intelligence/service.js", import.meta.url), "utf8");
  assert.match(service, /compareLeadFindingShortlist\(left, right, shortlistComparator\)/);
  assert.match(service, /leadFinding[\s\S]{0,80}\? compareLeadFindingShortlist/);
  assert.match(service, /: shortlistComparator\(left, right\)/);
});

test("CASE-KR-L-015 frontend retailer matcher literals stay locked to backend", () => {
  const frontend = readFileSync(new URL("../../frontend/lib/keyword-intelligence-view-model.ts", import.meta.url), "utf8");
  assert.match(frontend, /RETAILER_ALIASES = \["wallmart", "amazom"\]/);
  assert.match(frontend, /minCompactSubstringLength: 7/);
  assert.match(frontend, /minEditDistanceLength: 6/);
  assert.match(frontend, /maxEditDistance: 1/);
});
