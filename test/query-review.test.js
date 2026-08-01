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
  queryProbeConcurrency: 1,
  minQueryResults: 1,
  minQueryUniqueHosts: 1,
  minQueryRelevantResults: 1,
  googleResultsPerQuery: 10,
  queryProbeFreshnessMs: 86_400_000
};

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
  assert.equal(missing.errors[0].reason, "category_requires_query");
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
