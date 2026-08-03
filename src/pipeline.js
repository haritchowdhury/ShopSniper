import { searchGoogle } from "./search.js";
import { planGeneratedQueries } from "./query-planner.js";
import { resolveStoreIdentity } from "./domain-resolver.js";
import {
  storeFitAcceptsIntent,
  storefrontRejectionPriority,
  validateStorefront
} from "./storefront-validator.js";
import { discoverStorePages } from "./sitemap.js";
import { fetchPage } from "./page-fetcher.js";
import {
  consolidateEvidence,
  extractContactEvidence
} from "./contact-extractor.js";
import { normalizeWithAi } from "./ai-normalizer.js";
import { scoreLeadV2 } from "./lead-scorer.js";
import { mergeDiscoveryCandidates } from "./discovery-aggregation.js";
import { sameAllowedHostname } from "./url-security.js";
import { log } from "./logger.js";
import { categoryIntentKey, compareCategoryIntents } from "./category-input.js";
import { assertPublicLeadScoreState } from "./lead-state.js";
import { validateConfirmedQueryRows } from "./query-review.js";
import {
  parseRunStoreCandidate,
  parseShopLeadProfile,
  runStoreCandidateFromDiscovery,
  stableShopIdentity
} from "./shop-persistence-contract.js";

function safeErrorType(error) {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/u.test(error.name)
    ? error.name
    : "Error";
}

function blankRecord(overrides = {}) {
  return {
    original_shop_type: "",
    shop_type: "",
    business_qualifier: "unspecified",
    generated_query: "",
    query_score: "",
    query_generation_reason: "",
    search_query: "",
    google_rank: "",
    google_result_url: "",
    myshopify_domain: "",
    final_url: "",
    canonical_url: "",
    resolved_domain: "",
    store_name: "",
    email: "",
    email_source_url: "",
    phone: "",
    phone_source_url: "",
    contact_url: "",
    social_profiles: [],
    additional_information: "",
    shopify_confidence: "",
    relevance_score: "",
    lead_score: "",
    pipeline_version: 2,
    scoring_version: 2,
    store_fit_state: "",
    store_fit_evidence: null,
    contactability_tier: "",
    contact_evidence: null,
    identity_confidence: "",
    identity_evidence: null,
    score_breakdown: null,
    discovery_occurrences: [],
    matched_categories: [],
    status: "",
    rejection_reason: "",
    error: "",
    ...overrides
  };
}

function recordFromCandidate(candidate, overrides = {}) {
  const record = blankRecord({
    original_shop_type: candidate.originalShopType || "",
    shop_type: candidate.shopType || "",
    business_qualifier: candidate.businessQualifier || "unspecified",
    generated_query: candidate.query || "",
    query_score: candidate.queryScore ?? "",
    query_generation_reason: candidate.queryGenerationReason || "",
    search_query: candidate.query,
    google_rank: candidate.rank,
    google_result_url: candidate.url,
    myshopify_domain: candidate.myshopifyDomain || "",
    final_url: candidate.finalUrl || "",
    canonical_url: candidate.canonicalUrl || "",
    resolved_domain: candidate.resolvedDomain || "",
    ...overrides
  });
  assertPublicLeadScoreState(record);
  return record;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

async function processStore(candidate, config, dependencies) {
  let validation = dependencies.validate(candidate, config, { final: false });
  if (!validation.valid) {
    return recordFromCandidate(candidate, {
      shopify_confidence: validation.shopifyConfidence,
      relevance_score: validation.relevanceScore,
      lead_score: "",
      store_fit_state: validation.storeFit?.state || "",
      store_fit_evidence: validation.storeFit ? [{
        intent: {
          originalShopType: candidate.originalShopType || "",
          shopType: candidate.shopType || "",
          businessQualifier: candidate.businessQualifier || "unspecified"
        },
        ...validation.storeFit
      }] : null,
      contactability_tier: "none",
      identity_confidence: candidate.identityConfidence,
      identity_evidence: candidate.identityEvidence || null,
      discovery_occurrences: candidate.occurrences || [],
      matched_categories: [],
      status: "rejected",
      rejection_reason: validation.rejectionReason,
      additional_information: JSON.stringify(validation.evidence)
    });
  }

  let pageUrls;
  try {
    pageUrls = await dependencies.discoverPages(candidate, config);
  } catch {
    pageUrls = [candidate.finalUrl];
  }

  const pages = [];
  const evidencePages = [];
  const pageErrors = [];
  const fetched = await mapWithConcurrency(
    pageUrls,
    config.pageFetchConcurrency || 2,
    async (pageUrl) => {
    try {
      let html;
      let evidenceUrl = pageUrl;
      let fetchAssessment = null;
      let rendered = false;
      let responseStatus = 200;
      if (pageUrl === candidate.finalUrl || pageUrl === candidate.url) {
        html = candidate.html;
        fetchAssessment = candidate.initialFetch?.assessment || null;
        rendered = Boolean(candidate.initialFetch?.rendered);
      } else {
        const purpose = new URL(pageUrl).pathname === "/" ? "storefront" : "evidence";
        const response = await dependencies.fetchPage(pageUrl, config, {
          purpose,
          allowedHostnames: candidate.allowedHostnames
        });
        if (!sameAllowedHostname(response.finalUrl, candidate.allowedHostnames)) {
          throw new Error("Page redirected outside the verified store hostnames");
        }
        html = response.body;
        evidenceUrl = response.finalUrl;
        fetchAssessment = response.fetchAssessment || null;
        rendered = Boolean(response.rendered);
        responseStatus = response.status ?? 200;
      }
      return {
        page: dependencies.extractEvidence({
          html,
          url: evidenceUrl,
          requestedUrl: pageUrl,
          allowedHostnames: candidate.allowedHostnames,
          status: responseStatus,
          fetchAssessment
        }),
        document: { url: evidenceUrl, html, assessment: fetchAssessment, rendered },
        error: ""
      };
    } catch (error) {
      return {
        page: null,
        document: null,
        error: `${new URL(pageUrl).pathname}: ${safeErrorType(error)}`
      };
    }
  });
  for (const result of fetched) {
    if (result.page) pages.push(result.page);
    if (result.document) evidencePages.push(result.document);
    if (result.error) pageErrors.push(result.error);
  }

  const intents = candidate.categoryIntents?.length
    ? candidate.categoryIntents
    : [{
        originalShopType: candidate.originalShopType || "",
        shopType: candidate.shopType,
        businessQualifier: candidate.businessQualifier || "unspecified",
        categoryVocabulary: candidate.categoryVocabulary || []
      }];
  const validations = intents.map((intent) => {
    const item = dependencies.validate(
      {
        ...candidate,
        ...intent,
        categoryIntent: {
          originalShopType: intent.originalShopType || "",
          shopType: intent.shopType || "",
          businessQualifier: intent.businessQualifier || "unspecified"
        },
        evidencePages
      },
      config,
      { final: true }
    );
    return {
      intent,
      validation: item,
      accepted: storeFitAcceptsIntent(
        intent.businessQualifier || "unspecified",
        item.storeFit?.state
      )
    };
  });
  validations.sort((left, right) =>
    Number(right.accepted) - Number(left.accepted) ||
    Number(right.validation.valid) - Number(left.validation.valid) ||
    storefrontRejectionPriority(left.validation.rejectionReason) -
      storefrontRejectionPriority(right.validation.rejectionReason) ||
    Number(right.validation.relevanceScore || 0) - Number(left.validation.relevanceScore || 0) ||
    compareCategoryIntents(left.intent, right.intent)
  );
  const matchedCategories = validations
    .filter(({ accepted }) => accepted)
    .map(({ intent }) => intent);
  ({ validation } = validations[0]);
  const selectedIntent = validations[0].intent;
  if (!validation.valid) {
    return recordFromCandidate(candidate, {
      shop_type: selectedIntent.shopType,
      original_shop_type: selectedIntent.originalShopType || "",
      business_qualifier: selectedIntent.businessQualifier,
      shopify_confidence: validation.shopifyConfidence,
      relevance_score: validation.relevanceScore,
      lead_score: "",
      store_fit_state: validation.storeFit?.state || "",
      store_fit_evidence: validations.map(({ intent, validation: item, accepted }) => ({
        intent,
        accepted,
        ...item.storeFit
      })),
      identity_confidence: candidate.identityConfidence,
      identity_evidence: candidate.identityEvidence || null,
      discovery_occurrences: candidate.occurrences || [],
      matched_categories: matchedCategories,
      status: "rejected",
      rejection_reason: validation.rejectionReason,
      additional_information: JSON.stringify(validation.evidence)
    });
  }

  const evidence = dependencies.consolidate(pages);
  let ai = null;
  let aiError = "";
  try {
    ai = await dependencies.normalizeAi(candidate, evidence, config);
  } catch (error) {
    aiError = safeErrorType(error);
  }

  const proposedEmail = ai?.email || evidence.email;
  const proposedPhone = ai?.phone || evidence.phone;
  const proposedContactUrl = ai?.contact_url || evidence.contactUrl;
  const proposedSocialProfiles = ai?.social_profiles?.length
    ? ai.social_profiles
    : evidence.socialProfiles;
  const emailEvidence = evidence.evidence?.emails?.find(({ value }) => value === proposedEmail);
  const phoneEvidence = evidence.evidence?.phones?.find(({ value }) => value === proposedPhone);
  const contactPageEvidence = evidence.evidence?.contactPages?.find(
    ({ value }) => value === proposedContactUrl
  );
  const validSocials = new Set((evidence.evidence?.socialProfiles || []).map(({ value }) => value));
  const email = emailEvidence?.value || "";
  const phone = phoneEvidence?.value || "";
  const contactUrl = contactPageEvidence?.value || "";
  const socialProfiles = proposedSocialProfiles.filter((value) => validSocials.has(value));
  const contactabilityTier = email || phone
    ? "direct"
    : contactUrl
      ? "indirect"
      : socialProfiles.length || evidence.storeName
        ? "research_only"
        : "none";
  const scoreBreakdown = scoreLeadV2({
    relevanceScore: validation.relevanceScore,
    shopifyConfidence: validation.shopifyConfidence,
    identityConfidence: candidate.identityConfidence,
    contactEvidence: { email: Boolean(email), phone: Boolean(phone), contactPage: Boolean(contactUrl) }
  });

  let leadStatus = "qualified";
  let rejectionReason = "";
  if (!["direct", "indirect"].includes(contactabilityTier)) {
    leadStatus = "rejected";
    rejectionReason = "insufficient_contact_evidence";
  }

  const notes = [
    ai?.additional_information || "",
    `pages_examined=${pages.length}`,
    candidate.duplicateCount ? `duplicate_results=${candidate.duplicateCount}` : "",
    pageErrors.length ? `page_errors=${pageErrors.join(" | ")}` : ""
  ].filter(Boolean);

  return recordFromCandidate(candidate, {
    shop_type: selectedIntent.shopType,
    original_shop_type: selectedIntent.originalShopType || "",
    business_qualifier: selectedIntent.businessQualifier,
    store_name: ai?.store_name || evidence.storeName,
    email,
    email_source_url: emailEvidence?.sourceUrl || "",
    phone,
    phone_source_url: phoneEvidence?.sourceUrl || "",
    contact_url: contactUrl,
    social_profiles: socialProfiles,
    additional_information: notes.join("; "),
    shopify_confidence: validation.shopifyConfidence,
    relevance_score: validation.relevanceScore,
    lead_score: leadStatus === "qualified" ? scoreBreakdown.total : "",
    scoring_version: 2,
    store_fit_state: validation.storeFit?.state || "",
    store_fit_evidence: validations.map(({ intent, validation: item, accepted }) => ({
      intent,
      accepted,
      ...item.storeFit
    })),
    contactability_tier: contactabilityTier,
    contact_evidence: evidence.evidence || null,
    identity_confidence: candidate.identityConfidence,
    identity_evidence: candidate.identityEvidence || null,
    score_breakdown: leadStatus === "qualified" ? scoreBreakdown : null,
    discovery_occurrences: candidate.occurrences || [],
    matched_categories: matchedCategories,
    status: leadStatus,
    rejection_reason: rejectionReason,
    error: aiError ? `AI normalization failed; deterministic evidence retained (${aiError})` : ""
  });
}

const DEFAULT_DEPENDENCIES = {
  planQueries: planGeneratedQueries,
  search: searchGoogle,
  resolve: resolveStoreIdentity,
  validate: validateStorefront,
  discoverPages: discoverStorePages,
  fetchPage,
  extractEvidence: extractContactEvidence,
  consolidate: consolidateEvidence,
  normalizeAi: normalizeWithAi
};

export async function planQueriesForReview(config, status, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  return dependencies.planQueries(config, status, dependencyOverrides);
}

export async function validateConfirmedQueries(
  config,
  status,
  { rows, categories, ...dependencyOverrides }
) {
  return validateConfirmedQueryRows(rows, categories, config, status, dependencyOverrides);
}

export async function runDiscoveryFromQueryPlans(
  config,
  status,
  { queryPlans, queryAudits = [], ...dependencyOverrides }
) {
  const discovery = await resolveStoresFromQueryPlans(config, status, {
    queryPlans,
    queryAudits,
    ...dependencyOverrides
  });
  const { dependencies, diagnostics, mergedStores } = discovery;
  status.stage = "extracting_leads";
  const storeRecords = await mapWithConcurrency(
    mergedStores,
    config.storeConcurrency,
    async (candidate) => {
      try {
        const record = await processStore(candidate, config, dependencies);
        if (record.status === "qualified") status.storesQualified += 1;
        else status.storesRejected += 1;
        return record;
      } catch (error) {
        status.failures += 1;
        status.storeProcessingFailures = (status.storeProcessingFailures || 0) + 1;
        return recordFromCandidate(candidate, {
          lead_score: "",
          identity_confidence: candidate.identityConfidence,
          identity_evidence: candidate.identityEvidence || null,
          discovery_occurrences: candidate.occurrences || [],
          matched_categories: [],
          status: "failed",
          rejection_reason: "processing_failed",
          error: `Store processing failed (${safeErrorType(error)})`
        });
      }
    }
  );

  status.stage = "writing_results";
  status.outputRows = storeRecords.length;
  const summary = summarizeLeads(storeRecords);
  return {
    pipelineVersion: 2,
    scoringVersion: 2,
    leads: storeRecords,
    queryAudits,
    diagnostics,
    summary
  };
}

function persistedAssessments(candidate, config, dependencies) {
  const intents = candidate.categoryIntents?.length
    ? candidate.categoryIntents
    : [candidate.categoryIntent || candidate];
  return intents.flatMap((intent) => {
    try {
      const validation = dependencies.validate({
        ...candidate,
        ...intent,
        categoryIntent: {
          originalShopType: intent.originalShopType || "",
          shopType: intent.shopType || "",
          businessQualifier: intent.businessQualifier || "unspecified"
        }
      }, config, { final: false });
      return [{
        intent: {
          originalShopType: intent.originalShopType || "",
          shopType: intent.shopType || "",
          businessQualifier: intent.businessQualifier || "unspecified",
          categoryVocabulary: intent.categoryVocabulary || []
        },
        valid: Boolean(validation.valid),
        accepted: storeFitAcceptsIntent(
          intent.businessQualifier || "unspecified",
          validation.storeFit?.state
        ),
        shopifyConfidence: Number(validation.shopifyConfidence || 0),
        relevanceScore: Number(validation.relevanceScore || 0),
        rejectionReason: validation.rejectionReason || "",
        storeFit: validation.storeFit || {}
      }];
    } catch {
      return [];
    }
  });
}

async function resolveStoresFromQueryPlans(
  config,
  status,
  { queryPlans, queryAudits = [], ...dependencyOverrides }
) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (!Array.isArray(queryPlans)) throw new Error("queryPlans must be an array");
  status.queriesTotal = queryPlans.length;
  status.queriesProcessed = 0;
  const diagnostics = [];
  const resolvedCandidates = [];
  status.stage = "discovering_stores";

  for (const queryPlan of queryPlans) {
    const query = queryPlan.query;
    let results;
    try {
      results = queryPlan.results || await dependencies.search(query, config);
      results = results.map((result) => ({
        ...result,
        originalShopType: queryPlan.originalShopType || result.originalShopType || "",
        shopType: queryPlan.shopType || result.shopType || "",
        businessQualifier: queryPlan.shopType
          ? queryPlan.businessQualifier || "unspecified"
          : result.businessQualifier || "unspecified",
        categoryVocabulary: queryPlan.categoryVocabulary?.length
          ? queryPlan.categoryVocabulary
          : result.categoryVocabulary || [],
        queryScore: queryPlan.queryScore,
        queryGenerationReason: queryPlan.queryGenerationReason,
        querySourceUrls: queryPlan.querySourceUrls?.length
          ? queryPlan.querySourceUrls
          : result.querySourceUrls || [],
        categoryIntent: queryPlan.categoryIntent || {
          originalShopType: queryPlan.originalShopType || result.originalShopType || "",
          shopType: queryPlan.shopType || result.shopType || "",
          businessQualifier: queryPlan.shopType
            ? queryPlan.businessQualifier || "unspecified"
            : result.businessQualifier || "unspecified"
        }
      }));
    } catch (error) {
      diagnostics.push({
        scope: "query",
        code: "search_failed",
        shop_type: queryPlan.shopType || "",
        business_qualifier: queryPlan.businessQualifier || "unspecified",
        query,
        details: { errorType: error?.name || "Error" }
      });
      status.failures += 1;
      status.queryFailures = (status.queryFailures || 0) + 1;
      status.queriesProcessed += 1;
      log("query_failed", { query, error });
      continue;
    }

    if (!results.length) {
      diagnostics.push({
        scope: "query",
        code: "no_search_results",
        shop_type: queryPlan.shopType || "",
        business_qualifier: queryPlan.businessQualifier || "unspecified",
        query,
        details: {}
      });
    }

    for (const result of results) {
      if (result.rejectionReason) {
        diagnostics.push({
          scope: "occurrence",
          code: result.rejectionReason,
          shop_type: result.shopType || "",
          business_qualifier: result.businessQualifier || "unspecified",
          query: result.query || query,
          result_url: result.url || "",
          details: { rank: result.rank ?? null }
        });
        status.occurrenceFailures = (status.occurrenceFailures || 0) + 1;
        continue;
      }
      try {
        const candidate = await dependencies.resolve(result, config);
        status.storesDiscovered += 1;
        if (!candidate.stableIdentity && !candidate.resolvedDomain) {
          throw new Error("Could not determine a storefront domain");
        }
        resolvedCandidates.push(candidate);
      } catch (error) {
        diagnostics.push({
          scope: "occurrence",
          code: "resolution_failed",
          shop_type: result.shopType || "",
          business_qualifier: result.businessQualifier || "unspecified",
          query: result.query || query,
          result_url: result.url || "",
          details: { errorType: error?.name || "Error", rank: result.rank ?? null }
        });
        status.failures += 1;
        status.occurrenceFailures = (status.occurrenceFailures || 0) + 1;
      }
    }
    status.queriesProcessed += 1;
  }

  const mergedStores = mergeDiscoveryCandidates(resolvedCandidates);
  return { dependencies, diagnostics, mergedStores, queryAudits };
}

export async function discoverStoresFromQueryPlans(
  config,
  status,
  { queryPlans, queryAudits = [], ...dependencyOverrides }
) {
  const result = await resolveStoresFromQueryPlans(config, status, {
    queryPlans,
    queryAudits,
    ...dependencyOverrides
  });
  return {
    pipelineVersion: 2,
    scoringVersion: 2,
    queryAudits,
    diagnostics: result.diagnostics,
    stores: result.mergedStores.map((candidate) => ({
      identity: stableShopIdentity(candidate),
      candidatePayload: runStoreCandidateFromDiscovery(
        candidate,
        persistedAssessments(candidate, config, result.dependencies)
      )
    }))
  };
}

function summarizeLeads(storeRecords) {
  return storeRecords.reduce(
    (counts, record) => {
      counts.total += 1;
      if (record.status === "qualified") counts.qualified += 1;
      else if (record.status === "rejected") counts.rejected += 1;
      else if (record.status === "failed") counts.failed += 1;
      return counts;
    },
    { total: 0, qualified: 0, rejected: 0, failed: 0 }
  );
}

function candidateFromRunStorePayload(value) {
  const payload = parseRunStoreCandidate(value);
  return {
    originalShopType: payload.originalShopType,
    shopType: payload.shopType,
    businessQualifier: payload.businessQualifier,
    categoryVocabulary: payload.categoryVocabulary,
    categoryIntents: payload.categoryIntents,
    query: payload.representative.query,
    rank: payload.representative.rank,
    url: payload.representative.resultUrl,
    queryScore: payload.representative.queryScore,
    queryGenerationReason: payload.representative.queryGenerationReason,
    querySourceUrls: payload.representative.querySourceUrls,
    finalUrl: payload.finalUrl,
    canonicalUrl: payload.canonicalUrl,
    myshopifyDomain: payload.myshopifyDomain,
    resolvedDomain: payload.resolvedDomain,
    stableIdentity: payload.stableIdentity,
    allowedHostnames: payload.allowedHostnames,
    identityConfidence: payload.identityConfidence,
    identityEvidence: payload.identityEvidence,
    occurrences: payload.occurrences,
    duplicateCount: payload.duplicateCount
  };
}

async function refetchCandidate(candidate, config, dependencies) {
  const target = candidate.finalUrl || candidate.url;
  if (!target) throw new Error("Persisted store has no verified fetch URL");
  const response = await dependencies.fetchPage(target, config, {
    purpose: "storefront",
    allowedHostnames: candidate.allowedHostnames
  });
  if (!sameAllowedHostname(response.finalUrl, candidate.allowedHostnames)) {
    throw new Error("Storefront redirected outside the verified store hostnames");
  }
  return {
    ...candidate,
    html: response.body,
    finalUrl: response.finalUrl,
    initialFetch: {
      rendered: Boolean(response.rendered),
      renderAttempted: Boolean(response.renderAttempted),
      renderContractVersion: response.renderContractVersion || "",
      assessment: response.fetchAssessment || null
    }
  };
}

function normalizedProfileIntent(value) {
  return {
    originalShopType: value?.originalShopType || "",
    shopType: value?.shopType || "",
    businessQualifier: value?.businessQualifier || "unspecified",
    categoryVocabulary: [...new Set(value?.categoryVocabulary || [])].sort()
  };
}

function profileFromLead(candidate, lead) {
  if (!lead.contact_evidence && !/pages_examined=/u.test(lead.additional_information || "")) {
    return null;
  }
  const intentsByKey = new Map((candidate.categoryIntents || []).map((intent) => [
    categoryIntentKey(intent), normalizedProfileIntent(intent)
  ]));
  const categoryAssessments = (lead.store_fit_evidence || []).flatMap((item) => {
    const intent = normalizedProfileIntent(item.intent || {});
    if (!intent.shopType) return [];
    const known = intentsByKey.get(categoryIntentKey(intent));
    return [{
      intent: known || intent,
      shopifyConfidence: Number(lead.shopify_confidence || 0),
      relevanceScore: Number(lead.relevance_score || 0),
      storeFitState: item.state || lead.store_fit_state || "",
      storeFitEvidence: item,
      accepted: Boolean(item.accepted)
    }];
  });
  const pages = /pages_examined=(\d+)/u.exec(lead.additional_information || "");
  const pageErrors = /page_errors=([^;]+)/u.exec(lead.additional_information || "");
  return parseShopLeadProfile({
    contractVersion: "shop-lead-profile-v1",
    storeName: lead.store_name || "",
    email: lead.email || "",
    emailSourceUrl: lead.email_source_url || "",
    phone: lead.phone || "",
    phoneSourceUrl: lead.phone_source_url || "",
    contactUrl: lead.contact_url || "",
    socialProfiles: lead.social_profiles || [],
    contactabilityTier: lead.contactability_tier || "none",
    contactEvidence: lead.contact_evidence || null,
    identityConfidence: Number(lead.identity_confidence || candidate.identityConfidence || 0),
    identityEvidence: lead.identity_evidence || candidate.identityEvidence,
    categoryAssessments,
    pageDiagnostics: {
      pagesExamined: pages ? Number(pages[1]) : 0,
      pageErrorTypes: pageErrors ? pageErrors[1].split(" | ").map((value) => {
        const match = /([A-Za-z][A-Za-z0-9]*Error)$/u.exec(value.trim());
        return match?.[1] || "Error";
      }) : [],
      aiErrorType: /\(([A-Za-z][A-Za-z0-9]*Error)\)$/u.exec(lead.error || "")?.[1] || ""
    }
  });
}

function assessmentCandidates(payload, profile) {
  const intentKeys = new Set(payload.categoryIntents.map(categoryIntentKey));
  const completed = profile.categoryAssessments
    .filter(({ intent }) => intentKeys.has(categoryIntentKey(intent)))
    .map((item) => ({ ...item, final: true }));
  if (completed.length) return completed;
  return payload.assessments
    .filter(({ intent }) => intentKeys.has(categoryIntentKey(intent)))
    .map((item) => ({
      intent: item.intent,
      shopifyConfidence: item.shopifyConfidence,
      relevanceScore: item.relevanceScore,
      storeFitState: item.storeFit?.state || "",
      storeFitEvidence: item.storeFit,
      accepted: item.accepted,
      rejectionReason: item.rejectionReason,
      final: false
    }));
}

export function materializeLeadFromProfile(candidatePayload, profileValue) {
  const payload = parseRunStoreCandidate(candidatePayload);
  const profile = parseShopLeadProfile(profileValue);
  const candidate = candidateFromRunStorePayload(payload);
  const assessments = assessmentCandidates(payload, profile).sort((left, right) =>
    Number(right.accepted) - Number(left.accepted) ||
    Number(right.final) - Number(left.final) ||
    Number(right.relevanceScore) - Number(left.relevanceScore) ||
    compareCategoryIntents(left.intent, right.intent)
  );
  const selected = assessments[0] || {
    intent: payload.categoryIntents[0],
    shopifyConfidence: 0,
    relevanceScore: 0,
    storeFitState: "unknown",
    storeFitEvidence: null,
    accepted: false,
    rejectionReason: "insufficient_category_evidence"
  };
  const contactable = ["direct", "indirect"].includes(profile.contactabilityTier);
  const qualified = selected.accepted && contactable;
  const scoreBreakdown = scoreLeadV2({
    relevanceScore: selected.relevanceScore,
    shopifyConfidence: selected.shopifyConfidence,
    identityConfidence: profile.identityConfidence,
    contactEvidence: {
      email: Boolean(profile.email),
      phone: Boolean(profile.phone),
      contactPage: Boolean(profile.contactUrl)
    }
  });
  const safeNotes = [
    `pages_examined=${profile.pageDiagnostics.pagesExamined}`,
    payload.duplicateCount ? `duplicate_results=${payload.duplicateCount}` : "",
    profile.pageDiagnostics.pageErrorTypes.length
      ? `page_error_types=${profile.pageDiagnostics.pageErrorTypes.join(" | ")}`
      : "",
    profile.pageDiagnostics.aiErrorType
      ? `ai_error_type=${profile.pageDiagnostics.aiErrorType}`
      : ""
  ].filter(Boolean).join("; ");
  return recordFromCandidate(candidate, {
    original_shop_type: selected.intent.originalShopType,
    shop_type: selected.intent.shopType,
    business_qualifier: selected.intent.businessQualifier,
    store_name: profile.storeName,
    email: profile.email,
    email_source_url: profile.emailSourceUrl,
    phone: profile.phone,
    phone_source_url: profile.phoneSourceUrl,
    contact_url: profile.contactUrl,
    social_profiles: profile.socialProfiles,
    additional_information: safeNotes,
    shopify_confidence: selected.shopifyConfidence,
    relevance_score: selected.relevanceScore,
    lead_score: qualified ? scoreBreakdown.total : "",
    store_fit_state: selected.storeFitState,
    store_fit_evidence: assessments.map((item) => ({
      intent: item.intent,
      accepted: item.accepted,
      ...(item.storeFitEvidence || {})
    })),
    contactability_tier: profile.contactabilityTier,
    contact_evidence: profile.contactEvidence,
    identity_confidence: profile.identityConfidence,
    identity_evidence: profile.identityEvidence,
    score_breakdown: qualified ? scoreBreakdown : null,
    discovery_occurrences: payload.occurrences,
    matched_categories: assessments.filter(({ accepted }) => accepted).map(({ intent }) => intent),
    status: qualified ? "qualified" : "rejected",
    rejection_reason: qualified
      ? ""
      : selected.accepted
        ? "insufficient_contact_evidence"
        : selected.rejectionReason || "wrong_store_type",
    error: ""
  });
}

export async function discoverLeadForRunStore(
  config,
  runStore,
  dependencyOverrides = {}
) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const candidate = await refetchCandidate(
    candidateFromRunStorePayload(runStore.candidatePayload),
    config,
    dependencies
  );
  const lead = await processStore(candidate, config, dependencies);
  return { lead, profile: profileFromLead(candidate, lead) };
}

export function failedLeadForRunStore(candidatePayload, error) {
  const candidate = candidateFromRunStorePayload(candidatePayload);
  return recordFromCandidate(candidate, {
    lead_score: "",
    identity_confidence: candidate.identityConfidence,
    identity_evidence: candidate.identityEvidence,
    discovery_occurrences: candidate.occurrences,
    matched_categories: [],
    status: "failed",
    rejection_reason: "processing_failed",
    error: `Store processing failed (${safeErrorType(error)})`
  });
}

export async function runPipeline(config, status, dependencyOverrides = {}) {
  let queryPlans;
  let queryAudits = [];
  if (dependencyOverrides.readQueries) {
    const { queries, blanksSkipped } = await dependencyOverrides.readQueries(
      config.inputCsv,
      config.maxQueries
    );
    queryPlans = queries.map((query) => ({
      originalShopType: "",
      shopType: "",
      businessQualifier: "unspecified",
      categoryVocabulary: [],
      query,
      queryScore: "",
      queryGenerationReason: "",
      results: null
    }));
    queryAudits = queries.map((query) => ({
      shop_type: "",
      business_qualifier: "unspecified",
      query,
      status: "selected",
      rejection_reason: "",
      source: "legacy_query_csv"
    }));
    status.queriesTotal = queries.length;
    status.blankQueriesSkipped = blanksSkipped;
  } else {
    const planning = await planQueriesForReview(
      config,
      status,
      dependencyOverrides
    );
    const target = config.generatedQueryCount ?? 10;
    const expectedCount = Number.isInteger(planning.categoryCount)
      ? planning.categoryCount * target
      : null;
    if (
      planning.complete !== true ||
      (expectedCount != null && planning.selected.length !== expectedCount)
    ) {
      const first = planning.shortfalls?.[0];
      const detail = first
        ? `${first.selected} of ${first.target} required queries passed for ${first.shopType}`
        : "query planning did not meet the configured target";
      throw new Error(`INSUFFICIENT_HIGH_QUALITY_QUERIES: ${detail}`);
    }
    queryPlans = planning.selected;
    queryAudits = planning.audits || [];
  }

  return runDiscoveryFromQueryPlans(config, status, {
    ...dependencyOverrides,
    queryPlans,
    queryAudits
  });
}
