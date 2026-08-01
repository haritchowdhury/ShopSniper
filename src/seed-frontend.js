import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createPrismaRunRepository } from "./prisma-run-repository.js";
import { createInitialProgress, createInitialStatus } from "./status.js";

loadConfig();
const ownerId = process.env.FRONTEND_SEED_OWNER_ID?.trim();

if (
  process.env.NODE_ENV === "production" ||
  process.env.FRONTEND_SEED_CONFIRM !== "non-production"
) {
  throw new Error(
    "Refusing to seed. Set FRONTEND_SEED_CONFIRM=non-production and use a non-production DATABASE_URL."
  );
}
if (!ownerId || ownerId.length > 255) {
  throw new Error(
    "Set FRONTEND_SEED_OWNER_ID to the Neon Auth user ID that should own the fixture."
  );
}

const repository = createPrismaRunRepository();
const category = {
  originalShopType: "Independent Eyewear Brand",
  shopType: "eyewear",
  businessQualifier: "brand"
};
const run = await repository.createRun(ownerId, [category]);
const status = {
  ...createInitialStatus(),
  state: "running",
  stage: "writing_results",
  runId: run.id,
  shopTypesTotal: 1,
  shopTypesProcessed: 1,
  queriesTotal: 2,
  queriesProcessed: 2,
  storesDiscovered: 2,
  storesQualified: 1,
  storesRejected: 1,
  outputRows: 2
};

const pageEvidence = {
  sourceUrl: "https://fashion-fixture.example/collections/eyewear",
  pageType: "collection",
  matchedTerms: ["eyewear", "acetate frames"],
  claimTerms: [],
  signals: ["category_collection_assortment"],
  breadthTerms: [],
  negativeSignals: [],
  strength: 65,
  textLength: 1840
};
const contactDecision = {
  accepted: true,
  routeAccepted: true,
  routeReason: "contact_route",
  sameStore: true,
  httpUsable: true,
  pageUsable: true,
  positiveSignals: ["contact_form", "validated_direct_method"],
  validationReason: "validated_contact_page",
  sourceUrl: "https://fashion-fixture.example/pages/contact"
};
const occurrence = {
  categoryIntent: { ...category, categoryVocabulary: ["eyewear", "acetate frames"] },
  ...category,
  query: "site:myshopify.com/products acetate frames",
  queryScore: 82.29,
  queryGenerationReason: "Concrete category product phrase for an independent brand.",
  querySourceUrls: ["https://research-fixture.example/eyewear"],
  categoryVocabulary: ["eyewear", "acetate frames"],
  rank: 1,
  resultUrl: "https://fixture-fashion.myshopify.com/products/acetate-frames",
  finalUrl: "https://fashion-fixture.example/products/acetate-frames",
  resolvedDomain: "fashion-fixture.example",
  myshopifyDomain: "fixture-fashion.myshopify.com"
};

await repository.claimNextQueuedRun();
await repository.saveCompletedResults(
  run.id,
  {
    leads: [
      {
        original_shop_type: category.originalShopType,
        shop_type: category.shopType,
        business_qualifier: category.businessQualifier,
        generated_query: occurrence.query,
        query_score: occurrence.queryScore,
        query_generation_reason: occurrence.queryGenerationReason,
        search_query: occurrence.query,
        google_rank: 1,
        google_result_url: occurrence.resultUrl,
        myshopify_domain: occurrence.myshopifyDomain,
        final_url: occurrence.finalUrl,
        canonical_url: "https://fashion-fixture.example/products/acetate-frames",
        resolved_domain: occurrence.resolvedDomain,
        store_name: "Fashion Fixture",
        email: "hello@fashion-fixture.example",
        email_source_url: "https://fashion-fixture.example/pages/contact",
        phone: "+12125550100",
        phone_source_url: "https://fashion-fixture.example/pages/contact",
        contact_url: "https://fashion-fixture.example/pages/contact",
        social_profiles: ["https://instagram.com/fashionfixture"],
        additional_information: "Frontend-only scored-v2 fixture; pages_examined=3",
        shopify_confidence: 100,
        relevance_score: 92,
        lead_score: 90,
        pipeline_version: 2,
        scoring_version: 2,
        store_fit_state: "specialist",
        store_fit_evidence: [{
          intent: { ...category, categoryVocabulary: ["eyewear", "acetate frames"] },
          accepted: true,
          state: "specialist",
          score: 92,
          matchedTerms: ["eyewear", "acetate frames"],
          sourceUrls: [pageEvidence.sourceUrl],
          signalKinds: ["category_collection_assortment"],
          breadthEvidence: [],
          evidence: [pageEvidence],
          reason: "category_dominant_independent_assortment_signals"
        }],
        contactability_tier: "direct",
        contact_evidence: {
          emails: [{ kind: "email", value: "hello@fashion-fixture.example", sourceUrl: contactDecision.sourceUrl, method: "mailto", confidence: 96, validationReason: "same_store_contact_page" }],
          phones: [{ kind: "phone", value: "+12125550100", sourceUrl: contactDecision.sourceUrl, method: "tel", confidence: 96, validationReason: "same_store_contact_page" }],
          contactPages: [{ kind: "contact_page", value: contactDecision.sourceUrl, sourceUrl: contactDecision.sourceUrl, method: "contact_page_decision_v2", confidence: 100, validationReason: "validated_contact_page", decision: contactDecision }],
          socialProfiles: [{ kind: "social_profile", value: "https://instagram.com/fashionfixture", sourceUrl: contactDecision.sourceUrl, method: "associated_link_instagram", confidence: 86, validationReason: "store_owned_layout_link" }],
          organizationNames: [{ kind: "organization_name", value: "Fashion Fixture", sourceUrl: occurrence.finalUrl, method: "site_metadata", confidence: 86, validationReason: "site_name_metadata" }]
        },
        identity_confidence: 100,
        identity_evidence: {
          stableHostname: occurrence.myshopifyDomain,
          displayHostname: occurrence.resolvedDomain,
          observedHostnames: [occurrence.myshopifyDomain, occurrence.resolvedDomain],
          mergedOccurrenceCount: 1,
          canonical: { url: occurrence.finalUrl, hostname: occurrence.resolvedDomain, trusted: true, reason: "canonical_matches_observed_host" },
          method: "observed_myshopify_host",
          confidence: 100
        },
        score_breakdown: { version: 2, components: { identity: 20, shopifyValidation: 25, categoryFit: 30, contactEvidence: 15 }, total: 90, semantics: "evidence_rank_v2" },
        discovery_occurrences: [occurrence],
        matched_categories: [{ ...category, categoryVocabulary: occurrence.categoryVocabulary }],
        status: "qualified",
        rejection_reason: "",
        error: ""
      },
      {
        original_shop_type: "Eyewear Retailer",
        shop_type: "eyewear",
        business_qualifier: "retailer",
        generated_query: "site:myshopify.com/products sunglasses",
        query_score: 72,
        query_generation_reason: "Controlled not-scored-v2 fixture.",
        search_query: "site:myshopify.com/products sunglasses",
        google_rank: 4,
        google_result_url: "https://fixture-rejected.myshopify.com/products/item",
        myshopify_domain: "fixture-rejected.myshopify.com",
        final_url: "https://rejected-fixture.example/products/item",
        resolved_domain: "rejected-fixture.example",
        store_name: "Rejected Fixture",
        social_profiles: [],
        additional_information: "Frontend-only not-scored-v2 fixture",
        shopify_confidence: 100,
        relevance_score: 75,
        lead_score: "",
        pipeline_version: 2,
        scoring_version: 2,
        store_fit_state: "category_seller",
        contactability_tier: "none",
        identity_confidence: 100,
        score_breakdown: null,
        discovery_occurrences: [],
        matched_categories: [{ originalShopType: "Eyewear Retailer", shopType: "eyewear", businessQualifier: "retailer" }],
        status: "rejected",
        rejection_reason: "insufficient_contact_evidence",
        error: ""
      }
    ],
    summary: { total: 2, qualified: 1, rejected: 1, failed: 0 }
  },
  status
);

const legacyRunId = `run_${randomUUID().replaceAll("-", "")}`;
const now = new Date();
await repository.prisma.run.create({
  data: {
    id: legacyRunId,
    ownerId,
    state: "completed",
    stage: "completed",
    normalizedShopTypes: [{ shopType: "clothing" }],
    createdAt: now,
    startedAt: now,
    completedAt: now,
    progress: { ...createInitialProgress(), shopTypesTotal: 1, shopTypesProcessed: 1, storesDiscovered: 1, storesQualified: 1, outputRows: 1 },
    resultsAvailable: true,
    leadSummary: { total: 1, qualified: 1, rejected: 0, failed: 0 },
    pipelineVersion: null,
    scoringVersion: null,
    leads: {
      create: {
        id: `lead_${randomUUID().replaceAll("-", "")}`,
        shopType: "clothing",
        generatedQuery: "historical fixture query",
        googleRank: 1,
        resolvedDomain: "legacy-fixture.example",
        storeName: "Legacy Fixture",
        email: "legacy@fixture.example",
        socialProfiles: [],
        leadScore: 71,
        pipelineVersion: null,
        scoringVersion: null,
        status: "qualified"
      }
    }
  }
});

console.log(JSON.stringify({ v2RunId: run.id, legacyRunId }));
await repository.prisma.$disconnect();
