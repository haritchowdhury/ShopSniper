import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  analyzeSelectionConflicts, createDefaultSelection, normalizeSeeds, selectionItemId, validateSelectionDraft,
} from "../src/keyword-intelligence/selection.js";
import { jaccard, signature, compactSignature } from "../src/keyword-intelligence/dedup.js";

const FIXTURE = JSON.parse(readFileSync("test/fixtures/keyword-intelligence/selection-cases-v1.json", "utf8"));
const CONFLICT_CONFIG = { dedup: { stripTokens: ["a", "an", "the", "for", "and", "of", "with", "to", "in", "on"], similarityThreshold: 0.88 } };

test("selectionItemId is deterministic ksi_ plus 12 lowercase hex (DEC-KI-002)", () => {
  const first = selectionItemId("calculated", "pickleball paddles");
  const repeat = selectionItemId("calculated", "pickleball paddles");
  const manual = selectionItemId("manual", "pickleball paddles");
  const other = selectionItemId("calculated", "best pickleball paddle");
  assert.equal(first, repeat);
  assert.match(first, /^ksi_[a-f0-9]{12}$/u);
  assert.equal(first.length, 16);
  assert.notEqual(first, manual);
  assert.notEqual(first, other);
  assert.throws(() => selectionItemId("imported", "x"), TypeError);
  assert.throws(() => selectionItemId("calculated", ""), TypeError);
});

test("normalizeSeeds collapses whitespace, trims, dedupes case-insensitively", () => {
  const ok = normalizeSeeds(["  Pickleball  ", "golf accessories", "GOLF ACCESSORIES"]);
  assert.equal(ok.ok, false);
  assert.ok(ok.issues.some((issue) => issue.code === "seed_duplicate"));
  const good = normalizeSeeds([" Pickleball ", "Golf Accessories"]);
  assert.equal(good.ok, true);
  assert.deepEqual(good.seeds, ["Pickleball", "Golf Accessories"]);
  assert.equal(normalizeSeeds([]).ok, false);
  assert.equal(normalizeSeeds(["a", "b", "c", "d", "e", "f"]).ok, false);
});

test("createDefaultSelection sorts by recommended then opportunity then volume", () => {
  const rows = [
    { itemId: "ksi_a", keyword: "low opp", seed: "seed", sourceSeeds: ["seed"], recommended: true, opportunityScore: 40, searchVolume: 500, lane: "category_discovery", facets: { audience: [], category: [], channel: [], fit: [], modifier: [] } },
    { itemId: "ksi_b", keyword: "high opp", seed: "seed", sourceSeeds: ["seed"], recommended: true, opportunityScore: 90, searchVolume: 100, lane: "category_discovery", facets: { audience: [], category: [], channel: [], fit: [], modifier: [] } },
    { itemId: "ksi_c", keyword: "not recommended", seed: "seed", sourceSeeds: ["seed"], recommended: false, opportunityScore: 95, searchVolume: 1000, lane: "category_discovery", facets: { audience: [], category: [], channel: [], fit: [], modifier: [] } },
  ];
  const result = createDefaultSelection(rows);
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.keyword), ["high opp", "low opp", "not recommended"]);
  assert.equal(result.items.every((item) => item.sourceKind === "calculated"), true);
  assert.equal(result.totalRecommended, 2);
  assert.equal(result.retained, 3);
});

test("createDefaultSelection excludes mergedInto rows and caps at 100", () => {
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    rows.push({
      itemId: `ksi_${i.toString(16).padStart(12, "0")}`,
      keyword: `keyword ${i}`,
      seed: "seed",
      sourceSeeds: ["seed"],
      recommended: true,
      opportunityScore: 100 - i,
      searchVolume: i,
      lane: "category_discovery",
      facets: { audience: [], category: [], channel: [], fit: [], modifier: [] },
    });
  }
  rows.push({ itemId: "ksi_merged", keyword: "merged row", seed: "seed", sourceSeeds: ["seed"], recommended: true, opportunityScore: 999, searchVolume: 999, mergedInto: "keyword 0", lane: "category_discovery", facets: { audience: [], category: [], channel: [], fit: [], modifier: [] } });
  const result = createDefaultSelection(rows);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 100);
  assert.equal(result.capped, true);
  assert.ok(!result.items.some((item) => item.keyword === "merged row"));
});

test("validateSelectionDraft rejects invalid, duplicate, or oversized drafts", () => {
  const good = [
    { itemId: "ksi_a00000000000", sourceKind: "calculated", keyword: "pickleball", sourceSeeds: ["pickleball"], lane: "category_discovery" },
    { itemId: "ksi_b00000000000", sourceKind: "manual", keyword: "golf tees", sourceSeeds: ["golf"], lane: "store_discovery" },
  ];
  const ok = validateSelectionDraft(good);
  assert.equal(ok.ok, true);
  const dup = validateSelectionDraft([good[0], { ...good[0] }]);
  assert.equal(dup.ok, false);
  assert.ok(dup.issues.some((issue) => issue.code === "duplicate_item_id"));
  const badLane = validateSelectionDraft([{ ...good[0], lane: "no_lane" }]);
  assert.equal(badLane.ok, false);
  assert.ok(badLane.issues.some((issue) => issue.code === "invalid_lane"));
  const badId = validateSelectionDraft([{ ...good[0], itemId: "nope" }]);
  assert.equal(badId.ok, false);
  assert.ok(badId.issues.some((issue) => issue.code === "invalid_item_id"));
  const big = [];
  for (let i = 0; i < 201; i += 1) big.push({ ...good[0], itemId: `ksi_${i.toString(16).padStart(12, "0")}` });
  const oversized = validateSelectionDraft(big);
  assert.equal(oversized.ok, false);
  assert.ok(oversized.issues.some((issue) => issue.code === "draft_too_large"));
});

test("similarityTokens is the normalized signature set (aliases, singularization, strip)", () => {
  const strip = ["the"];
  const a = signature("the best paddle", strip);
  const b = signature("best paddles", strip);
  assert.ok(a.has("paddle"));
  assert.ok(b.has("paddle"));
  assert.ok(!a.has("the"));
  assert.ok(a.has("best"));
  assert.ok(jaccard(a, b) > 0);
  assert.equal(jaccard(a, a), 1);
});

test("compactSignature equivalence catches punctuation variants like s & s / ss", () => {
  assert.equal(compactSignature("s & s"), compactSignature("ss"));
  assert.notEqual(compactSignature("women shoes"), compactSignature("womens shoes"));
});

test("selection-cases-v1.json exact cases match the DEC-KI-015 conflict analysis", () => {
  const exact = FIXTURE.cases.exact;
  const conflicts = analyzeSelectionConflicts(exact.items, CONFLICT_CONFIG);
  assert.equal(conflicts.ok, true);
  assert.equal(conflicts.conflicts.length, 1);
  const group = conflicts.conflicts[0];
  assert.deepEqual(group.itemIds, exact.conflicts[0].itemIds);
  assert.equal(group.canonicalItemId, exact.conflicts[0].canonicalItemId);
  assert.ok(group.pairs.some((pair) => pair.reason === "compact"));
});

test("selection-cases-v1.json near-similar cases are caught by Jaccard threshold", () => {
  const near = FIXTURE.cases.near;
  const conflicts = analyzeSelectionConflicts(near.items, CONFLICT_CONFIG);
  assert.equal(conflicts.conflicts.length, 1);
  const group = conflicts.conflicts[0];
  assert.deepEqual(group.itemIds, near.conflicts[0].itemIds);
  assert.equal(group.canonicalItemId, near.conflicts[0].canonicalItemId);
  assert.ok(group.pairs.some((pair) => pair.reason === "similarity"));
  const pickleballPair = group.pairs.find((pair) => pair.reason === "similarity");
  assert.ok(pickleballPair.similarity >= 0.88);
});

test("selection-cases-v1.json transitive closure merges the whole chain", () => {
  const transitive = FIXTURE.cases.transitive;
  const conflicts = analyzeSelectionConflicts(transitive.items, CONFLICT_CONFIG);
  assert.equal(conflicts.conflicts.length, 1);
  const group = conflicts.conflicts[0];
  assert.deepEqual(group.itemIds, transitive.conflicts[0].itemIds);
  assert.equal(group.canonicalItemId, transitive.conflicts[0].canonicalItemId);
  assert.equal(group.itemIds.length, 3);
});

test("selection-cases-v1.json distinct keywords produce no conflicts", () => {
  const distinct = FIXTURE.cases.distinct;
  const conflicts = analyzeSelectionConflicts(distinct.items, CONFLICT_CONFIG);
  assert.equal(conflicts.ok, true);
  assert.equal(conflicts.conflicts.length, 0);
});

test("analyzeSelectionConflicts deduplicates repeated itemIds and is order-independent", () => {
  const items = [
    { itemId: "ksi_a00000000000", keyword: "s & s", sourceKind: "calculated" },
    { itemId: "ksi_b00000000000", keyword: "ss", sourceKind: "calculated" },
    { itemId: "ksi_a00000000000", keyword: "s & s", sourceKind: "calculated" },
  ];
  const shuffled = [...items.slice(0, 2)].reverse();
  const c1 = analyzeSelectionConflicts(items, CONFLICT_CONFIG);
  const c2 = analyzeSelectionConflicts(shuffled, CONFLICT_CONFIG);
  assert.equal(c1.conflicts.length, 1);
  assert.deepEqual(c1.conflicts[0].itemIds, c2.conflicts[0].itemIds);
  assert.equal(c1.conflicts[0].canonicalItemId, c2.conflicts[0].canonicalItemId);
});

test("conflictId is deterministic ksc_ plus 16 hex", () => {
  const conflicts = analyzeSelectionConflicts(FIXTURE.cases.near.items, CONFLICT_CONFIG);
  assert.match(conflicts.conflicts[0].conflictId, /^ksc_[a-f0-9]{16}$/u);
  const again = analyzeSelectionConflicts(FIXTURE.cases.near.items, CONFLICT_CONFIG);
  assert.equal(conflicts.conflicts[0].conflictId, again.conflicts[0].conflictId);
});