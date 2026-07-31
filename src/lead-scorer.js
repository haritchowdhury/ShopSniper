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
