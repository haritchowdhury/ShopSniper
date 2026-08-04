import assert from "node:assert/strict";
import test from "node:test";
import {
  LeadScoringInputError,
  V3_SCORE_COMPONENT_MAXIMA,
  coreWebVitalRatingV3,
  cruxPointsV3,
  scoreLeadV3,
  trafficPointsV3
} from "../src/lead-scorer.js";
import { finalizeLeadScoresV3 } from "../src/lead-score-finalizer.js";

const OBSERVED_AT = "2026-08-04T00:00:00.000Z";

function score(overrides = {}) {
  return scoreLeadV3({
    relevanceScore: 100,
    shopifyConfidence: 100,
    identityConfidence: 100,
    contactEvidence: { email: true, phone: true, contactPage: true, social: true },
    traffic: {
      metric: "estimated_google_search_traffic",
      value: 100_000,
      contractVersion: "dataforseo-traffic-v1",
      observedAt: OBSERVED_AT
    },
    crux: {
      state: "available",
      metrics: {
        largestContentfulPaintP75Ms: 2500,
        interactionToNextPaintP75Ms: 200,
        cumulativeLayoutShiftP75: "0.1"
      },
      contractVersion: "crux-origin-metrics-v1",
      observedAt: OBSERVED_AT
    },
    ...overrides
  });
}

function lead(overrides = {}) {
  return {
    id: "lead_one",
    status: "qualified",
    resolved_domain: "shop.example",
    relevance_score: 100,
    shopify_confidence: 100,
    identity_confidence: 100,
    email: "hello@shop.example",
    phone: "+12125550100",
    contact_url: "https://shop.example/contact",
    pipeline_version: 2,
    scoring_version: 2,
    lead_score: 100,
    score_breakdown: null,
    ...overrides
  };
}

function dataForSeo({ value = 1000, state = "partial", records, target = "shop.example" } = {}) {
  const worldwide = {
    contractVersion: "dataforseo-traffic-v1",
    target,
    scope: "worldwide",
    languageScope: "all_available",
    metrics: {
      organic: { etv: value, count: 1 },
      paid: { etv: 0, count: 0 },
      featuredSnippet: { etv: 999_999, count: 1 },
      localPack: { etv: 999_999, count: 1 }
    },
    fetchedAt: OBSERVED_AT
  };
  return {
    leadId: "lead_one",
    source: "dataforseo",
    state,
    contractVersion: "dataforseo-traffic-v1",
    normalizedPayload: { records: records ?? [worldwide] },
    fetchedAt: OBSERVED_AT
  };
}

function crux(metrics = {
  largestContentfulPaintP75Ms: 2500,
  interactionToNextPaintP75Ms: 200,
  cumulativeLayoutShiftP75: "0.1"
}) {
  return {
    leadId: "lead_one",
    source: "crux_rest",
    state: "available",
    contractVersion: "crux-origin-metrics-v1",
    normalizedPayload: {
      contractVersion: "crux-origin-metrics-v1",
      origin: "https://shop.example",
      coverage: "available",
      metrics,
      collectionPeriod: { firstDate: "2026-07-01", lastDate: "2026-07-28" },
      fetchedAt: OBSERVED_AT
    },
    fetchedAt: OBSERVED_AT
  };
}

test("v3 maxima preserve the locked 55/40/5 allocation", () => {
  assert.deepEqual(V3_SCORE_COMPONENT_MAXIMA, {
    identity: 11,
    shopifyValidation: 14,
    categoryFit: 16,
    contactEvidence: 14,
    traffic: 40,
    crux: 5
  });
  const result = score();
  assert.deepEqual(result.components, V3_SCORE_COMPONENT_MAXIMA);
  assert.equal(result.total, 100);
  assert.equal(Object.values(result.components).reduce((sum, value) => sum + value, 0), 100);
});

test("v3 traffic uses fixed logarithmic anchors and caps safely", () => {
  assert.deepEqual(
    [0, 10, 100, 1000, 10_000, 100_000, Number.MAX_VALUE].map(trafficPointsV3),
    [0, 8, 16, 24, 32, 40, 40]
  );
  assert.equal(trafficPointsV3(10.5), 8);
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1000", null]) {
    assert.throws(() => trafficPointsV3(invalid), LeadScoringInputError);
  }
});

test("v3 confidence and contact components are strict and social earns nothing", () => {
  const result = score({
    identityConfidence: 70,
    shopifyConfidence: 80,
    relevanceScore: 80,
    contactEvidence: { email: true, phone: false, contactPage: true, social: true },
    traffic: {
      metric: "estimated_google_search_traffic",
      value: 0,
      contractVersion: "dataforseo-traffic-v1",
      observedAt: OBSERVED_AT
    },
    crux: { state: "disabled" }
  });
  assert.deepEqual(result.components, {
    identity: 8,
    shopifyValidation: 11,
    categoryFit: 13,
    contactEvidence: 10,
    traffic: 0,
    crux: 0
  });
  for (const invalid of [-0.01, 100.01, Number.NaN, Number.POSITIVE_INFINITY, "80", null]) {
    assert.throws(() => score({ relevanceScore: invalid }), LeadScoringInputError);
  }
});

test("CrUX ratings honor exact good and poor boundaries", () => {
  const cases = [
    ["lcp", 2500, "good"], ["lcp", 2500.01, "needs_improvement"],
    ["lcp", 4000, "needs_improvement"], ["lcp", 4000.01, "poor"],
    ["inp", 200, "good"], ["inp", 200.01, "needs_improvement"],
    ["inp", 500, "needs_improvement"], ["inp", 500.01, "poor"],
    ["cls", 0.1, "good"], ["cls", 0.1001, "needs_improvement"],
    ["cls", 0.25, "needs_improvement"], ["cls", 0.2501, "poor"]
  ];
  for (const [metric, value, expected] of cases) {
    assert.equal(coreWebVitalRatingV3(metric, value), expected, `${metric}:${value}`);
  }
});

test("CrUX points sum fractional metric points before one final rounding", () => {
  assert.equal(cruxPointsV3({
    largestContentfulPaintP75Ms: 3000,
    interactionToNextPaintP75Ms: 300,
    cumulativeLayoutShiftP75: "0.2"
  }).points, 3);
  assert.equal(cruxPointsV3({ cumulativeLayoutShiftP75: "0.2" }).points, 1);
  assert.equal(cruxPointsV3({
    largestContentfulPaintP75Ms: 5000,
    interactionToNextPaintP75Ms: 600,
    cumulativeLayoutShiftP75: "0.3"
  }).points, 0);
  assert.equal(cruxPointsV3({
    largestContentfulPaintP75Ms: 2500,
    firstContentfulPaintP75Ms: 1,
    timeToFirstByteP75Ms: 1
  }).points, 2);
});

test("v3 finalization scores measured worldwide traffic and ignores featured/local ETV", () => {
  const [result] = finalizeLeadScoresV3({
    leads: [lead()],
    trafficEnrichments: [dataForSeo({ value: 1000 }), crux()],
    cruxEnabled: true
  });
  assert.equal(result.scoring_version, 3);
  assert.equal(result.score_breakdown.components.traffic, 24);
  assert.equal(result.score_breakdown.components.crux, 5);
  assert.equal(result.lead_score, 84);
  assert.equal(result.score_breakdown.evidence.traffic.value, 1000);
});

test("valid measured zero receives v3 while unavailable worldwide traffic receives null", () => {
  const [zero] = finalizeLeadScoresV3({
    leads: [lead()],
    trafficEnrichments: [dataForSeo({ value: 0 })]
  });
  assert.equal(zero.scoring_version, 3);
  assert.equal(zero.score_breakdown.components.traffic, 0);
  assert.equal(zero.lead_score, 55);

  for (const row of [
    undefined,
    { ...dataForSeo(), state: "unavailable", normalizedPayload: undefined },
    { ...dataForSeo(), contractVersion: "wrong" },
    dataForSeo({ target: "other.example" }),
    dataForSeo({ records: [] }),
    dataForSeo({ records: [dataForSeo().normalizedPayload.records[0], dataForSeo().normalizedPayload.records[0]] })
  ]) {
    const [result] = finalizeLeadScoresV3({
      leads: [lead()],
      trafficEnrichments: row ? [row] : []
    });
    assert.equal(result.lead_score, null);
    assert.equal(result.score_breakdown, null);
    assert.equal(result.scoring_version, 3);
  }
});

test("CrUX absence and partial coverage are explicit bonus-only states", () => {
  const [missing] = finalizeLeadScoresV3({
    leads: [lead()], trafficEnrichments: [dataForSeo()], cruxEnabled: true
  });
  assert.equal(missing.score_breakdown.components.crux, 0);
  assert.deepEqual(missing.score_breakdown.evidence.crux, { state: "unavailable" });

  const [partial] = finalizeLeadScoresV3({
    leads: [lead()],
    trafficEnrichments: [dataForSeo(), crux({ cumulativeLayoutShiftP75: "0.2" })],
    cruxEnabled: true
  });
  assert.equal(partial.score_breakdown.components.crux, 1);
  assert.equal(partial.score_breakdown.evidence.crux.state, "partial");
  assert.deepEqual(partial.score_breakdown.evidence.crux.ratings, {
    cls: "needs_improvement"
  });
});

test("v3 finalization is order-independent and rejects ambiguous joins", () => {
  const leads = [lead(), lead({
    id: "lead_two",
    resolved_domain: "other.example",
    status: "rejected",
    lead_score: null
  })];
  const rows = [dataForSeo(), crux()];
  const forward = finalizeLeadScoresV3({ leads, trafficEnrichments: rows, cruxEnabled: true });
  const reversed = finalizeLeadScoresV3({
    leads: [...leads].reverse(), trafficEnrichments: [...rows].reverse(), cruxEnabled: true
  });
  assert.deepEqual(
    [...forward].sort((a, b) => a.id.localeCompare(b.id)),
    [...reversed].sort((a, b) => a.id.localeCompare(b.id))
  );
  assert.throws(() => finalizeLeadScoresV3({
    leads: [lead()], trafficEnrichments: [dataForSeo(), dataForSeo()]
  }), /duplicate lead\/source/u);
  assert.throws(() => finalizeLeadScoresV3({
    leads: [lead()], trafficEnrichments: [{ ...dataForSeo(), leadId: "unknown" }]
  }), /unknown lead/u);
});
