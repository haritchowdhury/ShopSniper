export function scoreLeadV2({
  relevanceScore,
  shopifyConfidence,
  identityConfidence,
  contactEvidence = {}
}) {
  const components = {
    identity: Math.round((Number(identityConfidence) || 0) / 100 * 20),
    shopifyValidation: Math.round((Number(shopifyConfidence) || 0) / 100 * 25),
    categoryFit: Math.round((Number(relevanceScore) || 0) / 100 * 30),
    contactEvidence:
      (contactEvidence.email ? 12 : 0) +
      (contactEvidence.phone ? 8 : 0) +
      (contactEvidence.contactPage ? 5 : 0)
  };
  const total = Math.min(100, Object.values(components).reduce((sum, value) => sum + value, 0));
  return {
    version: 2,
    components,
    total,
    semantics: "deterministic_evidence_rank_not_probability"
  };
}

export const V3_SCORE_COMPONENT_MAXIMA = Object.freeze({
  identity: 11,
  shopifyValidation: 14,
  categoryFit: 16,
  contactEvidence: 14,
  traffic: 40,
  crux: 5
});

export const V3_BREAKDOWN_SEMANTICS =
  "deterministic_traffic_evidence_rank_not_probability";
export const V3_TRAFFIC_TRANSFORM = "log10_v1";

export class LeadScoringInputError extends Error {
  constructor(code) {
    super(`Lead scoring input violates ${code}`);
    this.name = "LeadScoringInputError";
    this.code = code;
  }
}

function requireFiniteRange(value, minimum, maximum, code) {
  if (typeof value !== "number" || !Number.isFinite(value) ||
      value < minimum || value > maximum) {
    throw new LeadScoringInputError(code);
  }
  return value;
}

function requireCanonicalTimestamp(value, code) {
  if (typeof value !== "string") throw new LeadScoringInputError(code);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new LeadScoringInputError(code);
  }
  return value;
}

function percentagePoints(value, maximum, code) {
  return Math.round(requireFiniteRange(value, 0, 100, code) / 100 * maximum);
}

export function trafficPointsV3(value) {
  const traffic = requireFiniteRange(
    value,
    0,
    Number.MAX_VALUE,
    "traffic_must_be_finite_non_negative"
  );
  if (traffic >= 100_000) return V3_SCORE_COMPONENT_MAXIMA.traffic;
  return Math.min(
    V3_SCORE_COMPONENT_MAXIMA.traffic,
    Math.round(8 * Math.log10(traffic + 1))
  );
}

export function coreWebVitalRatingV3(metric, value) {
  const thresholds = {
    lcp: [2500, 4000],
    inp: [200, 500],
    cls: [0.1, 0.25]
  };
  if (!Object.hasOwn(thresholds, metric)) {
    throw new LeadScoringInputError("known_crux_metric_required");
  }
  const numeric = requireFiniteRange(
    value,
    0,
    Number.MAX_VALUE,
    `${metric}_must_be_finite_non_negative`
  );
  const [good, poor] = thresholds[metric];
  return numeric <= good ? "good" : numeric <= poor ? "needs_improvement" : "poor";
}

function optionalCls(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new LeadScoringInputError("cls_must_be_a_non_negative_decimal_string");
  }
  return requireFiniteRange(
    Number(value),
    0,
    Number.MAX_VALUE,
    "cls_must_be_finite_non_negative"
  );
}

export function cruxPointsV3(metrics = {}) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new LeadScoringInputError("crux_metrics_must_be_an_object");
  }
  const allowed = new Set([
    "largestContentfulPaintP75Ms",
    "interactionToNextPaintP75Ms",
    "cumulativeLayoutShiftP75",
    "firstContentfulPaintP75Ms",
    "timeToFirstByteP75Ms"
  ]);
  if (Object.keys(metrics).some((key) => !allowed.has(key))) {
    throw new LeadScoringInputError("crux_metrics_contain_unknown_keys");
  }
  const definitions = [
    ["lcp", "largestContentfulPaintP75Ms", 2],
    ["inp", "interactionToNextPaintP75Ms", 2],
    ["cls", "cumulativeLayoutShiftP75", 1]
  ];
  const rawMetrics = {};
  const ratings = {};
  let unrounded = 0;
  for (const [metric, key, maximum] of definitions) {
    if (metrics[key] === undefined) continue;
    const value = metric === "cls"
      ? optionalCls(metrics[key])
      : requireFiniteRange(
          metrics[key],
          0,
          Number.MAX_VALUE,
          `${metric}_must_be_finite_non_negative`
        );
    const rating = coreWebVitalRatingV3(metric, value);
    rawMetrics[key] = metrics[key];
    ratings[metric] = rating;
    unrounded += rating === "good" ? maximum : rating === "needs_improvement" ? maximum / 2 : 0;
  }
  return Object.freeze({
    points: Math.round(unrounded),
    rawMetrics: Object.freeze(rawMetrics),
    ratings: Object.freeze(ratings),
    metricCount: Object.keys(ratings).length
  });
}

export function scoreLeadV3({
  relevanceScore,
  shopifyConfidence,
  identityConfidence,
  contactEvidence = {},
  traffic,
  crux = { state: "disabled" }
}) {
  if (!contactEvidence || typeof contactEvidence !== "object" || Array.isArray(contactEvidence)) {
    throw new LeadScoringInputError("contact_evidence_must_be_an_object");
  }
  if (!traffic || typeof traffic !== "object" || Array.isArray(traffic)) {
    throw new LeadScoringInputError("measured_traffic_evidence_required");
  }
  const trafficValue = requireFiniteRange(
    traffic.value,
    0,
    Number.MAX_VALUE,
    "traffic_must_be_finite_non_negative"
  );
  if (traffic.metric !== "estimated_google_search_traffic" ||
      traffic.contractVersion !== "dataforseo-traffic-v1") {
    throw new LeadScoringInputError("traffic_contract_required");
  }
  const trafficObservedAt = requireCanonicalTimestamp(
    traffic.observedAt,
    "traffic_observed_at_required"
  );
  const cruxStates = new Set([
    "available", "partial", "no_coverage", "unavailable", "disabled"
  ]);
  if (!crux || typeof crux !== "object" || Array.isArray(crux) ||
      !cruxStates.has(crux.state)) {
    throw new LeadScoringInputError("crux_state_invalid");
  }
  let cruxResult = { points: 0, rawMetrics: {}, ratings: {}, metricCount: 0 };
  let cruxEvidence = { state: crux.state };
  if (["available", "partial"].includes(crux.state)) {
    if (crux.contractVersion !== "crux-origin-metrics-v1") {
      throw new LeadScoringInputError("crux_contract_required");
    }
    cruxResult = cruxPointsV3(crux.metrics);
    if (cruxResult.metricCount === 0 ||
        (crux.state === "available" && cruxResult.metricCount !== 3) ||
        (crux.state === "partial" && cruxResult.metricCount === 3)) {
      throw new LeadScoringInputError("crux_state_does_not_match_metrics");
    }
    cruxEvidence = {
      state: crux.state,
      ...cruxResult.rawMetrics,
      ratings: cruxResult.ratings,
      sourceContractVersion: crux.contractVersion,
      observedAt: requireCanonicalTimestamp(crux.observedAt, "crux_observed_at_required")
    };
  }
  const components = {
    identity: percentagePoints(
      identityConfidence,
      V3_SCORE_COMPONENT_MAXIMA.identity,
      "identity_confidence_out_of_range"
    ),
    shopifyValidation: percentagePoints(
      shopifyConfidence,
      V3_SCORE_COMPONENT_MAXIMA.shopifyValidation,
      "shopify_confidence_out_of_range"
    ),
    categoryFit: percentagePoints(
      relevanceScore,
      V3_SCORE_COMPONENT_MAXIMA.categoryFit,
      "relevance_score_out_of_range"
    ),
    contactEvidence:
      (contactEvidence.email === true ? 7 : 0) +
      (contactEvidence.phone === true ? 4 : 0) +
      (contactEvidence.contactPage === true ? 3 : 0),
    traffic: trafficPointsV3(trafficValue),
    crux: cruxResult.points
  };
  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0 || total > 100) {
    throw new LeadScoringInputError("v3_total_out_of_range");
  }
  return Object.freeze({
    version: 3,
    components: Object.freeze(components),
    total,
    semantics: V3_BREAKDOWN_SEMANTICS,
    evidence: Object.freeze({
      traffic: Object.freeze({
        state: "measured",
        metric: "estimated_google_search_traffic",
        value: trafficValue,
        transform: V3_TRAFFIC_TRANSFORM,
        sourceContractVersion: traffic.contractVersion,
        observedAt: trafficObservedAt
      }),
      crux: Object.freeze(cruxEvidence)
    })
  });
}

// Kept as a compatibility surface for callers that only need the numeric rank.
export function scoreLead(input) {
  return scoreLeadV2({
    ...input,
    contactEvidence: {
      email: Boolean(input.email),
      phone: Boolean(input.phone),
      contactPage: Boolean(input.contactUrl)
    }
  }).total;
}
