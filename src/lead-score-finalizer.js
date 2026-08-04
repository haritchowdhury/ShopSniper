import { scoreLeadV3 } from "./lead-scorer.js";

const DATAFORSEO_CONTRACT = "dataforseo-traffic-v1";
const CRUX_CONTRACT = "crux-origin-metrics-v1";

function normalizedHostname(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/^www\./u, "")
    : "";
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

function measuredWorldwideTraffic(row, lead) {
  if (!row || row.source !== "dataforseo" || row.contractVersion !== DATAFORSEO_CONTRACT ||
      !["available", "partial"].includes(row.state)) return null;
  const records = row.normalizedPayload?.records;
  if (!Array.isArray(records)) return null;
  const worldwide = records.filter(({ scope }) => scope === "worldwide");
  if (worldwide.length !== 1) return null;
  const value = worldwide[0];
  if (value?.contractVersion !== DATAFORSEO_CONTRACT ||
      value.target !== normalizedHostname(lead.resolved_domain) ||
      value.languageScope !== "all_available") return null;
  const organic = value.metrics?.organic?.etv;
  const paid = value.metrics?.paid?.etv;
  const observedAt = canonicalTimestamp(value.fetchedAt);
  if (typeof organic !== "number" || !Number.isFinite(organic) || organic < 0 ||
      typeof paid !== "number" || !Number.isFinite(paid) || paid < 0 || !observedAt) return null;
  const traffic = organic + paid;
  if (!Number.isFinite(traffic) || traffic < 0) return null;
  return {
    metric: "estimated_google_search_traffic",
    value: traffic,
    contractVersion: DATAFORSEO_CONTRACT,
    observedAt
  };
}

function cruxEvidence(row, enabled) {
  if (!enabled) return { state: "disabled" };
  if (!row || row.source !== "crux_rest") return { state: "unavailable" };
  if (row.state === "no_coverage") return { state: "no_coverage" };
  if (row.state !== "available" || row.contractVersion !== CRUX_CONTRACT) {
    return { state: "unavailable" };
  }
  const payload = row.normalizedPayload;
  const observedAt = canonicalTimestamp(payload?.fetchedAt);
  if (payload?.contractVersion !== CRUX_CONTRACT || payload.coverage !== "available" ||
      !payload.metrics || typeof payload.metrics !== "object" || !observedAt) {
    return { state: "unavailable" };
  }
  const metrics = {};
  for (const key of [
    "largestContentfulPaintP75Ms",
    "interactionToNextPaintP75Ms",
    "cumulativeLayoutShiftP75",
    "firstContentfulPaintP75Ms",
    "timeToFirstByteP75Ms"
  ]) {
    if (payload.metrics[key] !== undefined) metrics[key] = payload.metrics[key];
  }
  const scoringMetricCount = [
    "largestContentfulPaintP75Ms",
    "interactionToNextPaintP75Ms",
    "cumulativeLayoutShiftP75"
  ].filter((key) => metrics[key] !== undefined).length;
  if (scoringMetricCount === 0) return { state: "unavailable" };
  return {
    state: scoringMetricCount === 3 ? "available" : "partial",
    metrics,
    contractVersion: CRUX_CONTRACT,
    observedAt
  };
}

export function finalizeLeadScoresV3({
  leads,
  trafficEnrichments,
  cruxEnabled = false,
  leadIdFor = (lead) => lead.id
}) {
  if (!Array.isArray(leads) || !Array.isArray(trafficEnrichments)) {
    throw new Error("V3 score finalization requires lead and enrichment arrays");
  }
  const leadIds = leads.map((lead, index) => leadIdFor(lead, index));
  if (leadIds.some((id) => typeof id !== "string" || !id) ||
      new Set(leadIds).size !== leadIds.length) {
    throw new Error("V3 score finalization requires unique stable lead identities");
  }
  const knownLeadIds = new Set(leadIds);
  const byLead = new Map(leadIds.map((id) => [id, new Map()]));
  for (const row of trafficEnrichments) {
    if (!knownLeadIds.has(row?.leadId)) {
      throw new Error("Traffic enrichment references an unknown lead during v3 finalization");
    }
    const sources = byLead.get(row.leadId);
    if (sources.has(row.source)) {
      throw new Error("Traffic enrichment contains duplicate lead/source rows");
    }
    sources.set(row.source, row);
  }

  return leads.map((lead, index) => {
    if (!["qualified", "rejected", "failed"].includes(lead?.status)) {
      throw new Error("V3 score finalization encountered an unknown lead status");
    }
    const common = { ...lead, pipeline_version: 2, scoring_version: 3 };
    if (lead.status !== "qualified") {
      return { ...common, lead_score: null, score_breakdown: null };
    }
    const sources = byLead.get(leadIds[index]);
    const traffic = measuredWorldwideTraffic(sources.get("dataforseo"), lead);
    if (!traffic) return { ...common, lead_score: null, score_breakdown: null };
    const breakdown = scoreLeadV3({
      relevanceScore: lead.relevance_score,
      shopifyConfidence: lead.shopify_confidence,
      identityConfidence: lead.identity_confidence,
      contactEvidence: {
        email: typeof lead.email === "string" && lead.email.length > 0,
        phone: typeof lead.phone === "string" && lead.phone.length > 0,
        contactPage: typeof lead.contact_url === "string" && lead.contact_url.length > 0
      },
      traffic,
      crux: cruxEvidence(sources.get("crux_rest"), cruxEnabled)
    });
    return { ...common, lead_score: breakdown.total, score_breakdown: breakdown };
  });
}
