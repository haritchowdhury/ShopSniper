import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { computeResearchResult, resultFingerprint } from "../src/keyword-intelligence/pipeline.js";
import { keywordResearchConfigV1Schema, keywordResearchResultV1Schema } from "../src/keyword-intelligence/schemas.js";
import {
  serializeClustersJson, serializeClustersCsv, serializeKeywordsJson, serializeKeywordsCsv,
} from "../src/keyword-intelligence/export.js";
import { selectionItemId } from "../src/keyword-intelligence/selection.js";
import { blake2s } from "@noble/hashes/blake2.js";

const FIXTURE_DIR = "test/fixtures/keyword-intelligence";
const input = JSON.parse(readFileSync(`${FIXTURE_DIR}/parity-input-v1.json`, "utf8"));
const golden = JSON.parse(readFileSync(`${FIXTURE_DIR}/parity-output-v1.json`, "utf8"));

function deepEqual(a, b, path = "") {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b) return `${path}: type ${typeof a} vs ${typeof b}`;
  if (a === null || b === null) return `${path}: null mismatch`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array mismatch`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const err = deepEqual(a[i], b[i], `${path}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return `${path}: keycount ${ka.length} vs ${kb.length}`;
    for (const k of ka) {
      if (!(k in b)) return `${path}.${k}: missing in golden`;
      const err = deepEqual(a[k], b[k], `${path}.${k}`);
      if (err) return err;
    }
    return null;
  }
  return `${path}: value ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

test("config snapshot parses under the strict keyword-research-config-v1 schema", () => {
  const parsed = keywordResearchConfigV1Schema.parse(input.config);
  assert.equal(parsed.contractVersion, 1);
  assert.equal(parsed.markets.length, 9);
  assert.equal(parsed.expansionAnchor.code, "US");
});

test("computeResearchResult matches the Python golden parity output exactly", () => {
  const result = computeResearchResult({
    ...input,
    researchId: golden.researchId,
    generation: golden.generation,
    configFingerprint: golden.configFingerprint,
  });
  const err = deepEqual(result, golden);
  assert.equal(err, null, err ?? "golden mismatch");
  assert.equal(result.summary.rawItemsCollected, 108);
  assert.equal(result.summary.uniquePhrases, 12);
  assert.equal(result.summary.activeKeywords, 12);
  assert.equal(result.summary.dedupMerged, 0);
  assert.equal(result.summary.recommendedKeywords, 8);
  assert.equal(result.summary.recommendedClusters, 3);
});

test("computeResearchResult result conforms to the strict keyword-research-result-v1 schema", () => {
  const result = computeResearchResult({
    ...input,
    researchId: golden.researchId,
    generation: golden.generation,
    configFingerprint: golden.configFingerprint,
  });
  keywordResearchResultV1Schema.parse(result);
  assert.equal(result.keywords.length, 12);
  assert.equal(result.clusters.length, 5);
});

test("result fingerprint is deterministic and distinct for different inputs", () => {
  const result = computeResearchResult({
    ...input,
    researchId: golden.researchId,
    generation: golden.generation,
    configFingerprint: golden.configFingerprint,
  });
  const fp1 = resultFingerprint(result);
  const fp2 = resultFingerprint(result);
  assert.equal(fp1, fp2);
  assert.match(fp1, /^krf_[a-f0-9]{64}$/u);
  const changed = computeResearchResult({
    ...input,
    researchId: golden.researchId,
    generation: 2,
    configFingerprint: golden.configFingerprint,
  });
  assert.notEqual(resultFingerprint(changed), fp1);
});

test("six-byte BLAKE2s item IDs match DEC-KI-002 exactly", () => {
  const calc = (k) => selectionItemId("calculated", k);
  const expected = (text) => {
    const digest = blake2s(new TextEncoder().encode(text), { dkLen: 6 });
    return Buffer.from(digest).toString("hex");
  };
  assert.equal(calc("synthetic keyword one"), `ksi_${expected("calculated\nsynthetic keyword one")}`);
  assert.equal(calc("pickleball paddles"), `ksi_${expected("calculated\npickleball paddles")}`);
  assert.equal(calc("pickleball paddles").length, 16);
  assert.match(calc("pickleball paddles"), /^ksi_[a-f0-9]{12}$/u);
});

test("keyword CSV serialization matches Python bytes (raw_ref deleted per DEC-KI-011)", () => {
  const result = computeResearchResult({
    ...input,
    researchId: golden.researchId,
    generation: golden.generation,
    configFingerprint: golden.configFingerprint,
  });
  const csv = serializeKeywordsCsv(result.keywords);
  assert.ok(csv.endsWith("\n"));
  assert.ok(!csv.includes("raw_ref"));
  assert.ok(!csv.includes("\r"));
  const lines = csv.split("\n").filter(Boolean);
  assert.equal(lines.length, 13);
  assert.equal(lines[0], "keyword,seed,source_seeds,search_volume,cpc,competition,competition_level,keyword_difficulty,main_intent,commercial_intent,trend_slope,cluster,cluster_id,lane,facets,variant_group_id,variant_canonical,flags,opportunity_score,recommended,merged_into,monthly_history,available_markets");
  assert.match(csv, /pickleball paddles,pickleball,pickleball,1809000,1\.34,1\.0,/, "first row values");
  assert.match(csv, /,82,True,/, "integer score and Python boolean");
  assert.match(csv, /"category_discovery": 5/, "clusters embedded JSON with spaced separators");
  assert.ok(csv.includes("commercial_intent"));
});

test("cluster CSV serialization matches Python bytes", () => {
  const result = computeResearchResult({
    ...input,
    researchId: golden.researchId,
    generation: golden.generation,
    configFingerprint: golden.configFingerprint,
  });
  const csv = serializeClustersCsv(result.clusters);
  assert.ok(csv.endsWith("\n"));
  assert.ok(!csv.includes("\r"));
  const lines = csv.split("\n").filter(Boolean);
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "cluster,cluster_id,combined_volume,headline_volume,adjusted_cluster_volume,raw_variant_volume,avg_cpc,commercial_intent,trend_score,opportunity_score,recommended_for_store_discovery,num_keywords,keywords,source_seeds,lane_counts,facets,variant_groups");
  assert.match(csv, /pickleball paddles,c_d0273365acb9,2968200,1809000,2968200,2968200,1\.57,0\.94,0\.78,83,True,5/, "first cluster row");
  assert.match(csv, /"variant_group_id": "v_/, "snake_case embedded variant group keys");
});

test("keyword and cluster JSON serialization round-trips and drops raw_ref", () => {
  const result = computeResearchResult({
    ...input,
    researchId: golden.researchId,
    generation: golden.generation,
    configFingerprint: golden.configFingerprint,
  });
  const kwJson = JSON.parse(serializeKeywordsJson(result.keywords));
  assert.equal(kwJson.length, 12);
  assert.ok(!("raw_ref" in kwJson[0]));
  assert.equal(kwJson[0].search_volume, 1809000);
  assert.equal(kwJson[0].recommended, true);
  const clJson = JSON.parse(serializeClustersJson(result.clusters));
  assert.equal(clJson.length, 5);
  assert.ok(!("raw_ref" in clJson[0]));
  assert.equal(clJson[0].variant_groups[0].variant_group_id.startsWith("v_"), true);
});

test("export embedded JSON uses Python-style spaced separators for cluster CSV", () => {
  const result = computeResearchResult({
    ...input,
    researchId: golden.researchId,
    generation: golden.generation,
    configFingerprint: golden.configFingerprint,
  });
  const csv = serializeClustersCsv(result.clusters);
  assert.match(csv, /"{""category_discovery"": 5}"/, "spaced object separators");
  assert.match(csv, /"{""audience"": \[\], ""category"": \[\], ""channel"": \[\], ""fit"": \[\], ""modifier"": \[\]}"/, "spaced empty facets");
});