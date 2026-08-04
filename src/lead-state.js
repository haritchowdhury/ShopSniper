import {
  V3_BREAKDOWN_SEMANTICS,
  V3_SCORE_COMPONENT_MAXIMA,
  V3_TRAFFIC_TRANSFORM,
  cruxPointsV3,
  trafficPointsV3
} from "./lead-scorer.js";

const V2_SCORE_COMPONENTS = Object.freeze([
  "identity",
  "shopifyValidation",
  "categoryFit",
  "contactEvidence"
]);

const V2_BREAKDOWN_SEMANTICS = "deterministic_evidence_rank_not_probability";
const V3_SCORE_COMPONENTS = Object.freeze(Object.keys(V3_SCORE_COMPONENT_MAXIMA));

export class LeadStateInvariantError extends Error {
  constructor(code) {
    super(`Lead score state violates ${code}`);
    this.name = "LeadStateInvariantError";
    this.code = code;
  }
}

function fail(code) {
  throw new LeadStateInvariantError(code);
}

function absent(value) {
  return value === "" || value == null;
}

function exactV2Integer(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

function validateV2Breakdown(breakdown, score) {
  if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) {
    fail("qualified_v2_breakdown_required");
  }
  if (breakdown.version !== 2) fail("qualified_v2_breakdown_version");
  if (breakdown.semantics !== V2_BREAKDOWN_SEMANTICS) {
    fail("qualified_v2_breakdown_semantics");
  }
  if (!exactV2Integer(breakdown.total) || breakdown.total !== score) {
    fail("qualified_v2_breakdown_total");
  }
  if (!breakdown.components || typeof breakdown.components !== "object" ||
    Array.isArray(breakdown.components)) {
    fail("qualified_v2_breakdown_components");
  }
  const keys = Object.keys(breakdown.components).sort();
  if (keys.length !== V2_SCORE_COMPONENTS.length ||
    keys.some((key, index) => key !== [...V2_SCORE_COMPONENTS].sort()[index])) {
    fail("qualified_v2_breakdown_components");
  }
  const components = V2_SCORE_COMPONENTS.map((key) => breakdown.components[key]);
  if (components.some((value) => !exactV2Integer(value))) {
    fail("qualified_v2_breakdown_components");
  }
  if (components.reduce((sum, value) => sum + value, 0) !== breakdown.total) {
    fail("qualified_v2_breakdown_component_total");
  }
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validateV3TrafficEvidence(evidence, points) {
  if (!exactObjectKeys(evidence, [
    "state", "metric", "value", "transform", "sourceContractVersion", "observedAt"
  ])) fail("qualified_v3_traffic_evidence");
  if (evidence.state !== "measured" ||
      evidence.metric !== "estimated_google_search_traffic" ||
      evidence.transform !== V3_TRAFFIC_TRANSFORM ||
      evidence.sourceContractVersion !== "dataforseo-traffic-v1" ||
      !canonicalTimestamp(evidence.observedAt)) {
    fail("qualified_v3_traffic_evidence");
  }
  let recomputed;
  try {
    recomputed = trafficPointsV3(evidence.value);
  } catch {
    fail("qualified_v3_traffic_evidence");
  }
  if (recomputed !== points) fail("qualified_v3_traffic_points");
}

function validateV3CruxEvidence(evidence, points) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    fail("qualified_v3_crux_evidence");
  }
  const states = new Set(["available", "partial", "no_coverage", "unavailable", "disabled"]);
  if (!states.has(evidence.state)) fail("qualified_v3_crux_evidence");
  if (!["available", "partial"].includes(evidence.state)) {
    if (!exactObjectKeys(evidence, ["state"]) || points !== 0) {
      fail("qualified_v3_crux_evidence");
    }
    return;
  }
  const metricKeys = {
    lcp: "largestContentfulPaintP75Ms",
    inp: "interactionToNextPaintP75Ms",
    cls: "cumulativeLayoutShiftP75"
  };
  const present = Object.entries(metricKeys).filter(([, key]) => evidence[key] !== undefined);
  const expectedKeys = [
    "state", "ratings", "sourceContractVersion", "observedAt",
    ...present.map(([, key]) => key)
  ];
  if (!exactObjectKeys(evidence, expectedKeys) ||
      evidence.sourceContractVersion !== "crux-origin-metrics-v1" ||
      !canonicalTimestamp(evidence.observedAt) ||
      !exactObjectKeys(evidence.ratings, present.map(([rating]) => rating)) ||
      present.length === 0 ||
      (evidence.state === "available") !== (present.length === 3)) {
    fail("qualified_v3_crux_evidence");
  }
  const metrics = Object.fromEntries(present.map(([, key]) => [key, evidence[key]]));
  let recomputed;
  try {
    recomputed = cruxPointsV3(metrics);
  } catch {
    fail("qualified_v3_crux_evidence");
  }
  if (recomputed.points !== points ||
      Object.entries(recomputed.ratings).some(([key, value]) => evidence.ratings[key] !== value)) {
    fail("qualified_v3_crux_points");
  }
}

function validateV3Breakdown(breakdown, score) {
  if (!exactObjectKeys(breakdown, ["version", "components", "total", "semantics", "evidence"])) {
    fail("qualified_v3_breakdown_required");
  }
  if (breakdown.version !== 3 || breakdown.semantics !== V3_BREAKDOWN_SEMANTICS) {
    fail("qualified_v3_breakdown_contract");
  }
  if (!Number.isSafeInteger(breakdown.total) || breakdown.total < 0 ||
      breakdown.total > 100 || breakdown.total !== score) {
    fail("qualified_v3_breakdown_total");
  }
  if (!exactObjectKeys(breakdown.components, V3_SCORE_COMPONENTS)) {
    fail("qualified_v3_breakdown_components");
  }
  for (const [key, maximum] of Object.entries(V3_SCORE_COMPONENT_MAXIMA)) {
    const value = breakdown.components[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      fail("qualified_v3_breakdown_components");
    }
  }
  if (V3_SCORE_COMPONENTS.reduce(
    (sum, key) => sum + breakdown.components[key], 0
  ) !== breakdown.total) {
    fail("qualified_v3_breakdown_component_total");
  }
  if (!exactObjectKeys(breakdown.evidence, ["traffic", "crux"])) {
    fail("qualified_v3_breakdown_evidence");
  }
  validateV3TrafficEvidence(breakdown.evidence.traffic, breakdown.components.traffic);
  validateV3CruxEvidence(breakdown.evidence.crux, breakdown.components.crux);
}

export function assertLeadScoreState({
  status,
  pipelineVersion,
  scoringVersion,
  leadScore,
  scoreBreakdown,
  scoreSemantics
}) {
  if (!["qualified", "rejected", "failed"].includes(status)) {
    fail("known_status_required");
  }
  const unversioned = absent(pipelineVersion) && absent(scoringVersion);
  const v2 = pipelineVersion === 2 && scoringVersion === 2;
  const v3 = pipelineVersion === 2 && scoringVersion === 3;
  if (!unversioned && !v2 && !v3) fail("versions_must_be_supported_pair");

  if (unversioned) {
    if (!absent(scoreSemantics) && scoreSemantics !== "legacy_v1") {
      fail("legacy_semantics_required");
    }
    return "legacy_v1";
  }

  if (v2 && status === "qualified") {
    if (!exactV2Integer(leadScore)) fail("qualified_v2_integer_score_required");
    validateV2Breakdown(scoreBreakdown, leadScore);
    if (!absent(scoreSemantics) && scoreSemantics !== "evidence_rank_v2") {
      fail("qualified_v2_semantics_required");
    }
    return "evidence_rank_v2";
  }

  if (v2) {
    if (!absent(leadScore)) fail("unscored_v2_score_must_be_null");
    if (!absent(scoreBreakdown)) fail("unscored_v2_breakdown_must_be_null");
    if (!absent(scoreSemantics) && scoreSemantics !== "not_scored_v2") {
      fail("unscored_v2_semantics_required");
    }
    return "not_scored_v2";
  }

  if (status === "qualified" && absent(leadScore) && absent(scoreBreakdown)) {
    if (!absent(scoreSemantics) && scoreSemantics !== "insufficient_traffic_v3") {
      fail("qualified_v3_insufficient_semantics_required");
    }
    return "insufficient_traffic_v3";
  }
  if (status === "qualified") {
    if (!Number.isSafeInteger(leadScore) || leadScore < 0 || leadScore > 100) {
      fail("qualified_v3_integer_score_required");
    }
    validateV3Breakdown(scoreBreakdown, leadScore);
    if (!absent(scoreSemantics) && scoreSemantics !== "traffic_evidence_rank_v3") {
      fail("qualified_v3_semantics_required");
    }
    return "traffic_evidence_rank_v3";
  }
  if (!absent(leadScore)) fail("unscored_v3_score_must_be_null");
  if (!absent(scoreBreakdown)) fail("unscored_v3_breakdown_must_be_null");
  if (!absent(scoreSemantics) && scoreSemantics !== "not_scored_v3") {
    fail("unscored_v3_semantics_required");
  }
  return "not_scored_v3";
}

export function assertPublicLeadScoreState(record) {
  return assertLeadScoreState({
    status: record.status,
    pipelineVersion: record.pipeline_version,
    scoringVersion: record.scoring_version,
    leadScore: absent(record.lead_score) ? null : record.lead_score,
    scoreBreakdown: record.score_breakdown,
    scoreSemantics: record.score_semantics
  });
}
