const V2_SCORE_COMPONENTS = Object.freeze([
  "identity",
  "shopifyValidation",
  "categoryFit",
  "contactEvidence"
]);

const V2_BREAKDOWN_SEMANTICS = "deterministic_evidence_rank_not_probability";

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
  if (!unversioned && !v2) fail("versions_must_be_both_v2_or_unversioned");

  if (unversioned) {
    if (!absent(scoreSemantics) && scoreSemantics !== "legacy_v1") {
      fail("legacy_semantics_required");
    }
    return "legacy_v1";
  }

  if (status === "qualified") {
    if (!exactV2Integer(leadScore)) fail("qualified_v2_integer_score_required");
    validateV2Breakdown(scoreBreakdown, leadScore);
    if (!absent(scoreSemantics) && scoreSemantics !== "evidence_rank_v2") {
      fail("qualified_v2_semantics_required");
    }
    return "evidence_rank_v2";
  }

  if (!absent(leadScore)) fail("unscored_v2_score_must_be_null");
  if (!absent(scoreBreakdown)) fail("unscored_v2_breakdown_must_be_null");
  if (!absent(scoreSemantics) && scoreSemantics !== "not_scored_v2") {
    fail("unscored_v2_semantics_required");
  }
  return "not_scored_v2";
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
