import assert from "node:assert/strict";
import test from "node:test";
import {
  GOOGLE_PROBE_CONTRACT_VERSION,
  queryProbeFingerprint,
  validateConfirmedQueryRows,
  validateEditableQueryList
} from "../src/query-review.js";
import { validateQueryText } from "../src/query-validator.js";

const categories = [{
  originalShopType: "Eyewear Brands",
  shopType: "eyewear",
  businessQualifier: "brand"
}];

const config = {
  maxQueries: 500,
  generatedQueryCount: 1,
  queryProbeConcurrency: 1,
  minQueryResults: 1,
  minQueryUniqueHosts: 1,
  minQueryRelevantResults: 1,
  minQueryRelevanceRatio: 0.5,
  minQueryBaseScore: 60,
  googleResultsPerQuery: 10,
  queryProbeFreshnessMs: 86_400_000
};

test("v2 probe fingerprints include every quality threshold", () => {
  assert.equal(GOOGLE_PROBE_CONTRACT_VERSION, "google-probe-v2");
  const baseline = queryProbeFingerprint(
    "site:myshopify.com/products acetate eyeglass frames",
    categories[0],
    config
  );
  assert.notEqual(baseline, queryProbeFingerprint(
    "site:myshopify.com/products acetate eyeglass frames",
    categories[0],
    { ...config, minQueryRelevanceRatio: 0.6 }
  ));
  assert.notEqual(baseline, queryProbeFingerprint(
    "site:myshopify.com/products acetate eyeglass frames",
    categories[0],
    { ...config, minQueryBaseScore: 61 }
  ));
});

test("user query validation normalizes the fixed Shopify search form", () => {
  const result = validateQueryText(
    "  SITE:MYSHOPIFY.COM/PRODUCTS   acetate eyeglass frames  ",
    { shopType: "eyewear", categoryVocabulary: ["acetate eyeglass frames"] }
  );
  assert.equal(result.valid, true);
  assert.equal(result.query, "site:myshopify.com/products acetate eyeglass frames");
  assert.equal(validateQueryText(
    "site:myshopify.com/products best eyewear guide",
    { shopType: "eyewear" }
  ).rejectionReason, "non_product_intent");
});

test("editable lists enforce category coverage, per-category duplicates, and limits", () => {
  const duplicate = validateEditableQueryList([
    { categoryIndex: 0, query: "site:myshopify.com/products acetate eyeglass frames" },
    { categoryIndex: 0, query: "site:myshopify.com/products acetate eyeglass frames" }
  ], categories, {
    ...config,
    categoryVocabularyByIndex: [["acetate eyeglass frames"]]
  });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.errors.some(({ reason }) => reason === "duplicate_candidate"), true);

  const missing = validateEditableQueryList([], categories, config);
  assert.equal(missing.valid, false);
  assert.equal(missing.errors[0].reason, "category_requires_exact_query_count");
});

test("editable and confirmed lists require the exact configured count", async () => {
  const exactConfig = { ...config, generatedQueryCount: 10 };
  const rows = Array.from({ length: 11 }, (_, index) => ({
    categoryIndex: 0,
    query: `site:myshopify.com/products acetate frame model ${index}`
  }));
  const nine = validateEditableQueryList(rows.slice(0, 9), categories, exactConfig);
  const eleven = validateEditableQueryList(rows, categories, exactConfig);
  assert.equal(nine.valid, false);
  assert.equal(nine.errors.some((error) =>
    error.reason === "category_requires_exact_query_count" && error.actual === 9
  ), true);
  assert.equal(eleven.valid, false);
  assert.equal(eleven.errors.some((error) =>
    error.reason === "category_requires_exact_query_count" && error.actual === 11
  ), true);

  const confirmed = await validateConfirmedQueryRows(
    Array.from({ length: 9 }, (_, sequence) => ({
      id: `query_${sequence}`,
      categoryIndex: 0,
      sequence,
      query: `site:myshopify.com/products acetate frame model ${sequence}`,
      categoryVocabulary: ["acetate frame model"],
      validationState: "pending"
    })),
    categories,
    exactConfig,
    { stage: "" },
    {
      probe: async (candidates) => candidates.map((entry) => ({
        candidate: entry,
        results: [],
        rawResults: 10,
        relevantResults: 10,
        relevantRatio: 1,
        uniqueHosts: ["a.myshopify.com"],
        duplicateProducts: 0,
        estimatedTotalResults: 10,
        nextPageAvailable: false,
        baseScore: 100,
        rejectionReason: "",
        error: ""
      }))
    }
  );
  assert.equal(confirmed.valid, false);
  assert.equal(confirmed.errors[0].actual, 9);
  assert.deepEqual(confirmed.queryPlans, []);
});

test("confirmation reuses a fresh matching probe and reprobes an edited row", async () => {
  const now = new Date("2026-08-01T12:00:00.000Z");
  const query = "site:myshopify.com/products acetate eyeglass frames";
  const fingerprint = queryProbeFingerprint(query, categories[0], config);
  let probeCalls = 0;
  const fresh = await validateConfirmedQueryRows([{
    id: "query_fresh",
    categoryIndex: 0,
    sequence: 0,
    query,
    source: "generated",
    validationState: "valid",
    rejectionReason: null,
    categoryVocabulary: ["acetate eyeglass frames"],
    probeFingerprint: fingerprint,
    probeContractVersion: GOOGLE_PROBE_CONTRACT_VERSION,
    probedAt: new Date(now.getTime() - 1000),
    probeResults: [{
      query,
      rank: 1,
      url: "https://fixture.myshopify.com/products/frame",
      title: "Acetate eyeglass frames",
      snippet: "",
      rejectionReason: ""
    }]
  }], categories, config, { stage: "" }, {
    now,
    probe: async () => { probeCalls += 1; return []; }
  });
  assert.equal(fresh.valid, true);
  assert.equal(probeCalls, 0);
  assert.equal(fresh.queryPlans[0].results.length, 1);

  const edited = await validateConfirmedQueryRows([{
    ...fresh.rows[0],
    source: "user_edited",
    validationState: "pending",
    query: "site:myshopify.com/products round acetate frames",
    categoryVocabulary: ["round acetate frames"],
    probeFingerprint: null,
    probeResults: null,
    probedAt: null
  }], categories, config, { stage: "" }, {
    now,
    probe: async (candidates) => {
      probeCalls += 1;
      return candidates.map((candidate) => ({
        candidate,
        results: [{
          query: candidate.query,
          rank: 1,
          url: "https://fixture.myshopify.com/products/round-frame",
          title: "Round acetate frames",
          snippet: "",
          rejectionReason: ""
        }],
        rawResults: 1,
        relevantResults: 1,
        uniqueHosts: ["fixture.myshopify.com"],
        duplicateProducts: 0,
        estimatedTotalResults: 1,
        nextPageAvailable: false,
        baseScore: 100,
        rejectionReason: "",
        error: ""
      }));
    }
  });
  assert.equal(edited.valid, true);
  assert.equal(probeCalls, 1);
  assert.equal(edited.rows[0].validationState, "valid");
});
