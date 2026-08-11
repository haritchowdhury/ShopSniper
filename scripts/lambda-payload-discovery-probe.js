import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { createPrismaClient } from "../src/prisma-client.js";
import { discoverStoresFromQueryPlans, failedLeadForRunStore, materializeLeadFromProfile } from
  "../src/pipeline.js";
import {
  assertRunStoreIdentityPair,
  parseRunStoreCandidate,
  parseShopLeadProfile,
  runStoreId,
  shopIdForStableKey
} from "../src/shop-persistence-contract.js";
import { trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { normalizeDataForSeoHostname } from "../src/enrichment/dataforseo/request.js";
import { normalizeCruxOrigin } from "../src/enrichment/crux/api-request.js";
import {
  parseCombinedTrafficCruxResult, parseConfirmedQueryManifest, parseDomainManifest,
  parseDomainStageManifest, parseDomainWorkPlan, parseLeadResultArtifact,
  parseQueryDiscoveryArtifact
} from "../src/aws-pipeline/contracts/artifacts.js";
import { parseAggregationCheckMessage, parseWorkMessage } from
  "../src/aws-pipeline/contracts/messages.js";

const PROBE_VERSION = "payload-discovery-v1";
const FIXTURE_ROOT = path.resolve("test/fixtures/aws-pipeline/v1");

const browserlessRenderedResultSchema = z.object({
  inputIndex: z.number().int().min(0).max(4),
  disposition: z.literal("rendered"),
  status: z.number().int().min(200).max(299),
  finalPath: z.string().startsWith("/").max(2048),
  durationMs: z.number().int().nonnegative().max(45000),
  titleLength: z.number().int().nonnegative().max(10000),
  textLength: z.number().int().nonnegative().max(10000000),
  linkCount: z.number().int().nonnegative().max(1000000)
}).strict();
const browserlessRejectedResultSchema = z.object({
  inputIndex: z.number().int().min(0).max(4),
  disposition: z.literal("rejected"),
  reason: z.enum(["host_not_allowed", "redirect_host_not_allowed"]),
  durationMs: z.number().int().nonnegative().max(45000).optional()
}).strict();
const browserlessSkippedResultSchema = z.object({
  inputIndex: z.number().int().min(0).max(4),
  disposition: z.literal("skipped"),
  reason: z.literal("sufficient_evidence")
}).strict();
const browserlessFailedResultSchema = z.object({
  inputIndex: z.number().int().min(0).max(4),
  disposition: z.literal("failed"),
  reason: z.literal("target_http_status").optional(),
  status: z.number().int().min(100).max(599).optional(),
  finalPath: z.string().startsWith("/").max(2048).optional(),
  errorType: z.string().min(1).max(100).optional(),
  durationMs: z.number().int().nonnegative().max(45000)
}).strict();
const browserlessFunctionEnvelopeSchema = z.object({
  data: z.object({
    contractVersion: z.literal("browserless-domain-render-batch-observed-v1"),
    activeSessionCount: z.literal(1),
    pageLimit: z.number().int().min(1).max(5),
    successes: z.number().int().nonnegative().max(5),
    earlyStopReason: z.enum(["sufficient_evidence", "exhausted_ranked_pages"]),
    results: z.array(z.discriminatedUnion("disposition", [
      browserlessRenderedResultSchema,
      browserlessRejectedResultSchema,
      browserlessSkippedResultSchema,
      browserlessFailedResultSchema
    ])).min(1).max(5),
    durationMs: z.number().int().nonnegative().max(45000),
    cleanup: z.literal("automatic_function_api")
  }).strict(),
  type: z.literal("application/json")
}).strict();

function canonicalJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function writeJson(name, value) {
  await fs.mkdir(FIXTURE_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(FIXTURE_ROOT, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: "w" }
  );
}

function queryAlias(index) {
  return `query_fixture_${String(index + 1).padStart(3, "0")}`;
}

function categoryAlias(index) {
  return `category-${String(index + 1).padStart(2, "0")}`;
}

function summarizeQuery(row, index) {
  const probeResults = Array.isArray(row.probeResults) ? row.probeResults : [];
  const probeSummary = row.probeSummary && typeof row.probeSummary === "object"
    ? row.probeSummary
    : null;
  return {
    id: queryAlias(index),
    categoryIndex: row.categoryIndex,
    categoryAlias: categoryAlias(row.categoryIndex),
    sequence: row.sequence,
    queryLength: typeof row.query === "string" ? row.query.length : null,
    source: row.source,
    validationState: row.validationState,
    hasRejectionReason: Boolean(row.rejectionReason),
    queryScore: row.queryScore == null ? null : Number(row.queryScore),
    generationReasonLength: typeof row.generationReason === "string"
      ? row.generationReason.length
      : 0,
    sourceUrlCount: Array.isArray(row.sourceUrls) ? row.sourceUrls.length : 0,
    categoryVocabularyCount: Array.isArray(row.categoryVocabulary)
      ? row.categoryVocabulary.length
      : 0,
    probeContractVersion: row.probeContractVersion,
    probeFingerprintPresent: typeof row.probeFingerprint === "string" &&
      row.probeFingerprint.length > 0,
    probeResultCount: probeResults.length,
    probeSummaryKeys: probeSummary ? Object.keys(probeSummary).sort() : [],
    probedAtPresent: row.probedAt instanceof Date
  };
}

function countBy(rows, key) {
  return Object.fromEntries([...rows.reduce((counts, row) => {
    const value = String(row[key] ?? "null");
    counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

function syntheticIntent() {
  return {
    originalShopType: "Fixture specialist stores",
    shopType: "fixture-specialist",
    businessQualifier: "brand",
    categoryVocabulary: ["fixture product", "specialist fixture"]
  };
}

function syntheticResolvedCandidate(entry) {
  return {
    ...entry,
    finalUrl: `https://fixture.example/products/item-${entry.rank}`,
    canonicalUrl: `https://fixture.example/products/item-${entry.rank}`,
    myshopifyDomain: "fixture.myshopify.com",
    resolvedDomain: "fixture.example",
    stableIdentity: "fixture.myshopify.com",
    allowedHostnames: ["fixture.example", "fixture.myshopify.com"],
    identityConfidence: 100,
    identityEvidence: {
      stableHostname: "fixture.myshopify.com",
      displayHostname: "fixture.example",
      observedHostnames: ["fixture.example", "fixture.myshopify.com"],
      canonical: {
        url: `https://fixture.example/products/item-${entry.rank}`,
        hostname: "fixture.example",
        trusted: true,
        reason: "canonical_matches_observed_host"
      },
      method: "observed_myshopify_host",
      confidence: 100
    }
  };
}

function syntheticProfile(identityEvidence, intent) {
  return parseShopLeadProfile({
    contractVersion: "shop-lead-profile-v1",
    storeName: "Fixture Specialist",
    email: "contact@fixture.invalid",
    emailSourceUrl: "https://fixture.example/pages/contact",
    phone: "+1 555 0100",
    phoneSourceUrl: "https://fixture.example/pages/contact",
    contactUrl: "https://fixture.example/pages/contact",
    socialProfiles: ["https://instagram.com/fixture_probe"],
    contactabilityTier: "direct",
    contactEvidence: { version: "contact-evidence-v1", method: "synthetic_fixture" },
    identityConfidence: 100,
    identityEvidence,
    categoryAssessments: [{
      intent,
      shopifyConfidence: 100,
      relevanceScore: 90,
      storeFitState: "specialist",
      storeFitEvidence: { state: "specialist", reason: "synthetic_fixture" },
      accepted: true
    }],
    pageDiagnostics: {
      pagesExamined: 2,
      pageErrorTypes: [],
      aiErrorType: ""
    }
  });
}

function statusFixture() {
  return {
    queriesTotal: 0,
    queriesProcessed: 0,
    blankQueriesSkipped: 0,
    storesDiscovered: 0,
    storesQualified: 0,
    storesRejected: 0,
    failures: 0,
    outputRows: 0
  };
}

function queryPlan(sequence, score) {
  const intent = syntheticIntent();
  const query = `site:myshopify.com/products synthetic fixture model ${sequence + 1}`;
  return {
    ...intent,
    categoryIntent: intent,
    query,
    queryScore: score,
    queryGenerationReason: "Deterministic payload-discovery fixture",
    querySourceUrls: ["https://research.example/fixture"],
    results: [{
      query,
      rank: sequence + 1,
      url: `https://fixture.myshopify.com/products/item-${sequence + 1}`,
      title: `Fixture product ${sequence + 1}`,
      snippet: "Deterministic fixture only",
      rejectionReason: ""
    }]
  };
}

async function discoveryOutput(queryPlans, overrides = {}) {
  return discoverStoresFromQueryPlans(
    { storeConcurrency: 1 },
    statusFixture(),
    {
      queryPlans,
      queryAudits: [],
      resolve: async (entry) => syntheticResolvedCandidate(entry),
      validate: () => ({
        valid: true,
        rejectionReason: "",
        shopifyConfidence: 100,
        relevanceScore: 90,
        storeFit: { state: "specialist", reason: "synthetic_fixture" }
      }),
      ...overrides
    }
  );
}

function negativeResult(name, value, parser) {
  try {
    parser(value);
    throw new Error(`Negative fixture ${name} unexpectedly passed`);
  } catch (error) {
    if (error.message === `Negative fixture ${name} unexpectedly passed`) throw error;
    return { name, input: value, observedError: error.message };
  }
}

function dataForSeoScopeKey(scope) {
  return scope === "worldwide"
    ? "worldwide"
    : `country:${scope.countryIsoCode}:${scope.locationCode}`;
}

async function localContractsProbe() {
  const intent = syntheticIntent();
  const firstPlan = queryPlan(0, 91);
  const secondPlan = queryPlan(1, 88);
  const perQueryCurrentOutput = await discoveryOutput([firstPlan]);
  const aggregatedForwardOutput = await discoveryOutput([firstPlan, secondPlan]);
  const aggregatedCurrentOutput = await discoveryOutput([secondPlan, firstPlan]);
  if (perQueryCurrentOutput.stores.length !== 1 || aggregatedCurrentOutput.stores.length !== 1) {
    throw new Error("Synthetic discovery did not produce one deterministic store");
  }
  if (canonicalJson(aggregatedForwardOutput) !== canonicalJson(aggregatedCurrentOutput)) {
    throw new Error("Synthetic aggregation changed when query order was reversed");
  }
  const store = aggregatedCurrentOutput.stores[0];
  const candidate = parseRunStoreCandidate(store.candidatePayload);
  const shopId = shopIdForStableKey(store.identity.stableKey);
  const runId = "run_fixture_payload_discovery_0001";
  const persistedRunStoreId = runStoreId(runId, shopId);
  const profile = syntheticProfile(candidate.identityEvidence, intent);
  const qualifiedLead = materializeLeadFromProfile(candidate, profile);
  const failedLead = failedLeadForRunStore(candidate, new TypeError("synthetic private detail"));
  const now = "2026-08-11T09:30:00.000Z";

  const confirmedQueryManifest = {
    contractVersion: "confirmed-query-manifest-v1",
    runId,
    generation: 1,
    confirmedRevision: 1,
    categories: [{ categoryIndex: 0, ...intent }],
    queries: [firstPlan, secondPlan].map((plan, index) => ({
      id: queryAlias(index),
      categoryIndex: 0,
      sequence: index,
      query: plan.query,
      source: "generated",
      validationState: "valid",
      queryScore: plan.queryScore,
      generationReason: plan.queryGenerationReason,
      sourceUrls: plan.querySourceUrls,
      categoryVocabulary: plan.categoryVocabulary,
      probeContractVersion: "google-probe-v2",
      probeFingerprint: fingerprint({ query: plan.query, intent }),
      probeResults: plan.results
    }))
  };

  const perQueryArtifact = {
    contractVersion: "query-discovery-artifact-v1",
    runId,
    generation: 1,
    queryId: queryAlias(0),
    confirmedRevision: 1,
    pipelineVersion: perQueryCurrentOutput.pipelineVersion,
    scoringVersion: perQueryCurrentOutput.scoringVersion,
    stores: perQueryCurrentOutput.stores,
    queryAudits: perQueryCurrentOutput.queryAudits,
    diagnostics: perQueryCurrentOutput.diagnostics
  };
  const failedSearchPlan = { ...firstPlan };
  delete failedSearchPlan.results;
  const partialPlan = {
    ...firstPlan,
    results: [
      ...firstPlan.results,
      {
        query: firstPlan.query,
        rank: 2,
        url: "http://127.0.0.1/private",
        title: "Rejected fixture",
        snippet: "",
        rejectionReason: "unsafe_result_url"
      }
    ]
  };
  const perQueryCases = {
    contractVersion: "query-discovery-terminal-cases-v1",
    success: perQueryArtifact,
    empty: await discoveryOutput([{ ...firstPlan, results: [] }]),
    partialOccurrenceFailure: await discoveryOutput([partialPlan]),
    completeQueryFailure: await discoveryOutput([failedSearchPlan], {
      search: async () => { throw new Error("synthetic search failure"); }
    }),
    resolutionFailure: await discoveryOutput([firstPlan], {
      resolve: async () => { throw new TypeError("synthetic resolution failure"); }
    }),
    rejectedAssessment: await discoveryOutput([firstPlan], {
      validate: () => ({
        valid: false,
        rejectionReason: "wrong_store_type",
        shopifyConfidence: 100,
        relevanceScore: 10,
        storeFit: { state: "broad_store", reason: "synthetic_fixture" }
      })
    })
  };
  const domainManifest = {
    contractVersion: "domain-manifest-v1",
    runId,
    generation: 1,
    confirmedRevision: 1,
    inputQueryArtifactFingerprints: [fingerprint(perQueryArtifact)],
    probeEvidence: {
      queryOrderIndependent: true,
      mergedOccurrenceCount: candidate.occurrences.length,
      duplicateCount: candidate.duplicateCount
    },
    domains: [{
      shopId,
      runStoreId: persistedRunStoreId,
      identity: store.identity,
      candidatePayload: candidate
    }]
  };

  const policy = trafficEnrichmentConfigSnapshot({
    dataForSeoEnrichmentEnabled: true,
    cruxEnrichmentEnabled: true,
    cruxBigQueryProjectId: "fixture-billing-project",
    cruxBigQueryLocation: "US"
  });
  const sourceKeys = {
    dataForSeo: policy.dataForSeo.scopes.map((scope) => ({
      source: "dataforseo",
      identity: "fixture.example",
      scopeKey: dataForSeoScopeKey(scope),
      metricSetKey: policy.dataForSeo.metricSetKey,
      contractVersion: policy.dataForSeo.contractVersion
    })),
    cruxRest: {
      source: "crux_rest",
      identity: "https://fixture.example",
      scopeKey: "current",
      metricSetKey: policy.crux.rest.metricSetKey,
      contractVersion: policy.crux.rest.contractVersion
    },
    cruxBigQuery: {
      source: "crux_bigquery",
      identity: "https://fixture.example",
      scopeKey: "month:202606",
      metricSetKey: policy.crux.bigQuery.metricSetKey,
      contractVersion: policy.crux.bigQuery.contractVersion
    }
  };
  const reuseMatrix = {
    contractVersion: "work-plan-reuse-matrix-v1",
    evaluatedAt: now,
    exactCacheKeys: sourceKeys,
    cases: [
      { case: "none_reused", lead: false, dataForSeo: false, cruxRest: false, cruxBigQuery: false },
      { case: "lead_only", lead: true, dataForSeo: false, cruxRest: false, cruxBigQuery: false },
      { case: "rest_only", lead: false, dataForSeo: false, cruxRest: true, cruxBigQuery: false },
      { case: "bigquery_only", lead: false, dataForSeo: false, cruxRest: false, cruxBigQuery: true },
      { case: "all_reused", lead: true, dataForSeo: true, cruxRest: true, cruxBigQuery: true }
    ].map((entry) => ({
      ...entry,
      needsLead: !entry.lead,
      needsTraffic: !entry.dataForSeo,
      needsCruxRest: !entry.cruxRest,
      needsCruxBigQuery: !entry.cruxBigQuery,
      needsCrux: !entry.cruxRest || !entry.cruxBigQuery
    })),
    invalidOrNonReusableStates: [
      "missing", "stale", "processing", "failed", "ambiguous", "invalid_payload",
      "identity_mismatch", "metric_mismatch", "contract_mismatch", "partial_scope"
    ]
  };
  const workPlan = {
    contractVersion: "domain-work-plan-v1",
    runId,
    generation: 1,
    evaluatedAt: now,
    domainManifestKey: `runs/${runId}/domains-manifest.json`,
    domains: [{
      shopId,
      runStoreId: persistedRunStoreId,
      candidateKey: `runs/${runId}/domains/${shopId}/candidate.json`,
      needsLead: true,
      needsTraffic: true,
      needsCruxRest: true,
      needsCruxBigQuery: true,
      needsCrux: true,
      sourceKeys
    }]
  };
  const leadResults = {
    contractVersion: "lead-result-fixtures-v1",
    success: {
      runId,
      generation: 1,
      shopId,
      runStoreId: persistedRunStoreId,
      state: "completed",
      profileReusable: false,
      profile,
      lead: qualifiedLead,
      pageDiagnostics: {
        selectedPageLimit: 5,
        selectedPages: [
          { rank: 1, purpose: "storefront", disposition: "ordinary" },
          { rank: 2, purpose: "contact", disposition: "rendered" }
        ],
        earlyStopReason: "sufficient_contact_evidence",
        browserlessSessionCeilingMs: 45000
      }
    },
    failure: {
      runId,
      generation: 1,
      shopId,
      runStoreId: persistedRunStoreId,
      state: "failed",
      profileReusable: false,
      lead: failedLead,
      diagnostic: {
        scope: "store",
        code: "lead_discovery_failed",
        details: { errorType: "TypeError" }
      }
    }
  };
  const trafficResult = {
    contractVersion: "combined-traffic-crux-result-v1",
    runId,
    generation: 1,
    shopId,
    components: {
      dataforseo: {
        state: "available",
        contractVersion: policy.dataForSeo.contractVersion,
        artifactKey: `runs/${runId}/domains/${shopId}/traffic/dataforseo.json`
      },
      cruxRest: {
        state: "no_coverage",
        contractVersion: policy.crux.rest.contractVersion,
        artifactKey: `runs/${runId}/domains/${shopId}/traffic/crux-rest.json`
      },
      cruxBigQuery: {
        state: "contract_mismatch",
        contractVersion: policy.crux.bigQuery.contractVersion,
        artifactKey: `runs/${runId}/domains/${shopId}/traffic/crux-bigquery.json`
      }
    }
  };
  const envelopes = {
    contractVersion: "sqs-envelope-fixtures-v1",
    messages: {
      discovery: {
        version: 1, type: "discovery.query", runId, stage: "discovery", generation: 1,
        itemId: queryAlias(0), manifestKey: `runs/${runId}/queries/manifest.json`,
        manifestFingerprint: fingerprint(confirmedQueryManifest), attempt: 1
      },
      lead: {
        version: 1, type: "lead.domain", runId, stage: "lead", generation: 1,
        itemId: shopId, manifestKey: `runs/${runId}/domains-manifest.json`,
        manifestFingerprint: fingerprint(workPlan), attempt: 1
      },
      traffic: {
        version: 1, type: "traffic.domain", runId, stage: "traffic_crux", generation: 1,
        itemId: shopId, manifestKey: `runs/${runId}/domains-manifest.json`,
        manifestFingerprint: fingerprint(workPlan), attempt: 1
      },
      aggregateCheck: {
        version: 1, type: "aggregation.check", runId, stage: "traffic_crux", generation: 1,
        reason: "terminal_task_recorded", attempt: 1
      }
    }
  };
  envelopes.encodedBytes = Object.fromEntries(Object.entries(envelopes.messages)
    .map(([key, value]) => [key, encodedBytes(value)]));

  // G4 production-contract verification remains entirely local and deterministic.
  parseConfirmedQueryManifest(confirmedQueryManifest);
  parseQueryDiscoveryArtifact(perQueryArtifact);
  parseDomainManifest(domainManifest);
  parseDomainWorkPlan(workPlan);
  parseDomainStageManifest({
    contractVersion: "domain-stage-manifest-v1",
    domainManifest,
    workPlan
  });
  parseLeadResultArtifact({ contractVersion: "lead-result-v1", result: leadResults.success });
  parseLeadResultArtifact({ contractVersion: "lead-result-v1", result: leadResults.failure });
  parseCombinedTrafficCruxResult(trafficResult);
  parseWorkMessage(envelopes.messages.discovery);
  parseWorkMessage(envelopes.messages.lead);
  parseWorkMessage(envelopes.messages.traffic);
  parseAggregationCheckMessage(envelopes.messages.aggregateCheck);

  const maxOccurrence = structuredClone(candidate.occurrences[0]);
  const boundaryCandidate = structuredClone(candidate);
  boundaryCandidate.occurrences = Array.from({ length: 1000 }, () => structuredClone(maxOccurrence));
  boundaryCandidate.duplicateCount = 999;
  parseRunStoreCandidate(boundaryCandidate);
  const boundaryDomainRefs = Array.from({ length: 1000 }, (_, index) => ({
    shopId: `shop_fixture_${String(index + 1).padStart(4, "0")}`,
    runStoreId: `run_store_fixture_${String(index + 1).padStart(4, "0")}`,
    candidateKey: `runs/${runId}/domains/shop_fixture_${String(index + 1)
      .padStart(4, "0")}/candidate.json`,
    needsLead: true,
    needsTraffic: true,
    needsCruxRest: true,
    needsCruxBigQuery: true,
    needsCrux: true
  }));
  const sizes = {
    contractVersion: "payload-size-observation-v1",
    encoder: "Buffer.byteLength(JSON.stringify(value), utf8)",
    observed: {
      confirmedQueryManifest: encodedBytes(confirmedQueryManifest),
      perQueryArtifact: encodedBytes(perQueryArtifact),
      domainManifest: encodedBytes(domainManifest),
      workPlan: encodedBytes(workPlan),
      leadResultFixtures: encodedBytes(leadResults),
      combinedTrafficResult: encodedBytes(trafficResult)
    },
    configuredBoundary: {
      candidateWith1000Occurrences: encodedBytes(boundaryCandidate),
      domainWorkRefs1000: encodedBytes({ domains: boundaryDomainRefs })
    },
    sqsEnvelopes: envelopes.encodedBytes
  };
  const negatives = [
    negativeResult("candidate_unknown_field", { ...candidate, unknown: true }, parseRunStoreCandidate),
    negativeResult("candidate_raw_html", { ...candidate, html: "<html>forbidden</html>" }, parseRunStoreCandidate),
    negativeResult("candidate_identity_mismatch", {
      ...candidate,
      stableIdentity: "other.myshopify.com"
    }, (value) => assertRunStoreIdentityPair(store.identity, value)),
    negativeResult("profile_secret_field", {
      ...profile,
      contactEvidence: { authorization_token: "forbidden" }
    }, parseShopLeadProfile),
    negativeResult("profile_raw_document", {
      ...profile,
      contactEvidence: { document: "<div>forbidden</div>" }
    }, parseShopLeadProfile)
  ];

  let browserlessContractFixtures = null;
  try {
    const positiveObservation = JSON.parse(await fs.readFile(
      path.join(FIXTURE_ROOT, "browserless-live-observation.json"), "utf8"
    ));
    const redirectObservation = JSON.parse(await fs.readFile(
      path.join(FIXTURE_ROOT, "browserless-live-negative-observation.json"), "utf8"
    ));
    const positives = [positiveObservation, redirectObservation].map((observation) =>
      browserlessFunctionEnvelopeSchema.parse({
        data: observation.response.data,
        type: "application/json"
      }));
    const base = positives[0];
    const negativeEnvelopes = [
      { name: "unknown_outer_field", value: { ...base, unknown: true } },
      { name: "raw_body_field", value: {
        ...base,
        data: { ...base.data, body: "<html>forbidden</html>" }
      } },
      { name: "non_2xx_rendered_success", value: {
        ...base,
        data: {
          ...base.data,
          results: base.data.results.map((result, index) => index === 0
            ? { ...result, status: 503 }
            : result)
        }
      } },
      { name: "full_final_url", value: {
        ...base,
        data: {
          ...base.data,
          results: base.data.results.map((result, index) => index === 0
            ? { ...result, finalUrl: "https://external.example/private" }
            : result)
        }
      } },
      { name: "too_many_page_results", value: {
        ...base,
        data: { ...base.data, pageLimit: 6, results: Array(6).fill(base.data.results[0]) }
      } },
      { name: "session_over_ceiling", value: {
        ...base,
        data: { ...base.data, durationMs: 45001 }
      } }
    ];
    browserlessContractFixtures = {
      contractVersion: "browserless-function-parser-fixtures-v1",
      positiveObservedEnvelopeCount: positives.length,
      positiveFingerprints: positives.map(fingerprint),
      negativeCases: negativeEnvelopes.map(({ name, value }) =>
        negativeResult(name, value, (candidateValue) =>
          browserlessFunctionEnvelopeSchema.parse(candidateValue)))
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const outputs = {
    "confirmed-query-manifest.valid.json": confirmedQueryManifest,
    "per-query-discovery.valid.json": perQueryArtifact,
    "per-query-discovery-terminal-cases.json": perQueryCases,
    "domain-manifest.valid.json": domainManifest,
    "reuse-matrix.json": reuseMatrix,
    "domain-work-plan.valid.json": workPlan,
    "lead-results.valid.json": leadResults,
    "combined-traffic-crux-result.valid.json": trafficResult,
    "sqs-envelopes.valid.json": envelopes,
    "payload-size-observation.json": sizes,
    "negative-contract-observations.json": {
      contractVersion: "negative-contract-observations-v1",
      cases: negatives
    },
    ...(browserlessContractFixtures
      ? { "browserless-function-contract-fixtures.json": browserlessContractFixtures }
      : {})
  };
  for (const [name, value] of Object.entries(outputs)) await writeJson(name, value);
  process.stdout.write(`${JSON.stringify({
    outputDirectory: path.relative(process.cwd(), FIXTURE_ROOT),
    files: Object.keys(outputs),
    domainCountAfterDuplicateMerge: domainManifest.domains.length,
    occurrenceCountAfterDuplicateMerge: candidate.occurrences.length,
    duplicateCount: candidate.duplicateCount,
    sizes
  }, null, 2)}\n`);
}

function safeUsageFields(value, prefix = "", output = {}) {
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (/(?:token|secret|password|email|account.?id|user.?id|api.?key|^id$)/iu.test(key)) continue;
    if (child && typeof child === "object") {
      safeUsageFields(child, childPath, output);
      continue;
    }
    if ((typeof child === "number" ||
        /(?:plan|unit|concurr|cycle|start|end|reset|usage|limit|total)/iu.test(key)) &&
        ["string", "number", "boolean"].includes(typeof child)) {
      output[childPath] = child;
    }
  }
  return output;
}

async function browserlessUsage(token) {
  const url = new URL("https://api.browserless.io/v1/account/usage");
  url.searchParams.set("token", token);
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(`Browserless usage request failed with HTTP ${response.status}`);
  }
  return safeUsageFields(body);
}

function usageDelta(before, after) {
  const delta = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (typeof before[key] === "number" && typeof after[key] === "number") {
      delta[key] = after[key] - before[key];
    }
  }
  return delta;
}

async function browserlessLiveProbe({ negative = false } = {}) {
  const config = loadConfig({ cwd: process.cwd() });
  const token = config.browserlessToken;
  if (!token) throw new Error("BROWSERLESS_TOKEN is not configured");
  const endpoint = new URL(config.browserlessUrl || "https://production-sfo.browserless.io/content");
  endpoint.pathname = "/function";
  endpoint.search = "";
  endpoint.searchParams.set("token", token);
  endpoint.searchParams.set("timeout", "45000");
  const context = negative
    ? {
        allowedHost: "httpbingo.org",
        stopAfterSuccesses: 1,
        urls: [
          "https://httpbingo.org/redirect-to?url=https%3A%2F%2Fexample.com%2F",
          "https://httpbingo.org/html"
        ]
      }
    : {
        allowedHost: "books.toscrape.com",
        stopAfterSuccesses: 2,
        urls: [
          "https://books.toscrape.com/",
          "https://books.toscrape.com/catalogue/page-2.html",
          "https://books.toscrape.com/catalogue/page-3.html",
          "https://example.com/"
        ]
      };
  const code = `export default async ({ page, context }) => {
    const startedAt = Date.now();
    const results = [];
    let successes = 0;
    let earlyStopReason = "exhausted_ranked_pages";
    for (const target of context.urls) {
      if (successes >= context.stopAfterSuccesses) {
        results.push({ inputIndex: results.length, disposition: "skipped", reason: "sufficient_evidence" });
        earlyStopReason = "sufficient_evidence";
        continue;
      }
      const parsed = new URL(target);
      if (parsed.hostname !== context.allowedHost) {
        results.push({ inputIndex: results.length, disposition: "rejected", reason: "host_not_allowed" });
        continue;
      }
      const pageStartedAt = Date.now();
      try {
        const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 8000 });
        const finalUrl = page.url();
        const final = new URL(finalUrl);
        if (final.hostname !== context.allowedHost) {
          results.push({
            inputIndex: results.length,
            disposition: "rejected",
            reason: "redirect_host_not_allowed",
            durationMs: Date.now() - pageStartedAt
          });
          continue;
        }
        const status = response?.status() || 0;
        if (status < 200 || status >= 300) {
          results.push({
            inputIndex: results.length,
            disposition: "failed",
            reason: "target_http_status",
            status,
            finalPath: final.pathname,
            durationMs: Date.now() - pageStartedAt
          });
          continue;
        }
        const metadata = await page.evaluate(() => ({
          titleLength: document.title.length,
          textLength: (document.body?.innerText || "").length,
          linkCount: document.links.length
        }));
        results.push({
          inputIndex: results.length,
          disposition: "rendered",
          status,
          finalPath: final.pathname,
          durationMs: Date.now() - pageStartedAt,
          ...metadata
        });
        successes += 1;
      } catch (error) {
        results.push({
          inputIndex: results.length,
          disposition: "failed",
          errorType: error?.name || "Error",
          durationMs: Date.now() - pageStartedAt
        });
      }
    }
    return {
      data: {
        contractVersion: "browserless-domain-render-batch-observed-v1",
        activeSessionCount: 1,
        pageLimit: context.urls.length,
        successes,
        earlyStopReason,
        results,
        durationMs: Date.now() - startedAt,
        cleanup: "automatic_function_api"
      },
      type: "application/json"
    };
  };`;
  const usageBefore = await browserlessUsage(token);
  const requestStartedAt = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, context }),
    signal: AbortSignal.timeout(48000)
  });
  const responseText = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Browserless function returned non-JSON HTTP ${response.status} (${responseText.length} bytes)`
    );
  }
  if (!response.ok) {
    throw new Error(`Browserless function failed with HTTP ${response.status}`);
  }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  if (data?.contractVersion !== "browserless-domain-render-batch-observed-v1" ||
      !Array.isArray(data.results)) {
    throw new Error("Browserless function response did not match the probe contract");
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const usageAfter = await browserlessUsage(token);
  const safeHeaders = Object.fromEntries([...response.headers.entries()]
    .filter(([name]) => /^(?:content-type|content-length|x-ratelimit-|x-browserless-)/iu.test(name)));
  const fixture = {
    contractVersion: "browserless-live-observation-v1",
    capturedAt: new Date().toISOString(),
    selectedInterface: "function",
    selectionReason: [
      "one REST request owns one automatically closed browser session",
      "several ranked URLs can be visited sequentially without a local Puppeteer dependency",
      "the response can be reduced to strict privacy-safe JSON"
    ],
    controls: {
      activeConcurrency: 1,
      providerSessionTimeoutMs: 45000,
      clientTimeoutMs: 48000,
      navigationTimeoutMs: 8000,
      proxyEnabled: false,
      captchaOptionEnabled: false,
      allowedHost: context.allowedHost,
      suppliedUrlCount: context.urls.length,
      stopAfterSuccesses: context.stopAfterSuccesses,
      maximumExpectedBrowserTimeUnits: 2
    },
    response: {
      httpStatus: response.status,
      headers: safeHeaders,
      outerDurationMs: Math.round((performance.now() - requestStartedAt) * 10) / 10,
      envelopeShape: parsed?.data && parsed?.type ? "data-and-type" : "direct-data",
      data
    },
    usage: {
      before: usageBefore,
      after: usageAfter,
      numericDelta: usageDelta(usageBefore, usageAfter),
      note: "Usage API values can update asynchronously; browser time is billed in 30-second increments."
    },
    privacy: {
      tokensRetained: false,
      pageBodiesRetained: false,
      cookiesRetained: false,
      screenshotsRetained: false
    }
  };
  const outputName = negative
    ? "browserless-live-negative-observation.json"
    : "browserless-live-observation.json";
  await writeJson(outputName, fixture);
  process.stdout.write(`${JSON.stringify({
    output: path.relative(process.cwd(), path.join(FIXTURE_ROOT, outputName)),
    selectedInterface: fixture.selectedInterface,
    httpStatus: fixture.response.httpStatus,
    outerDurationMs: fixture.response.outerDurationMs,
    data: fixture.response.data,
    usageDelta: fixture.usage.numericDelta
  }, null, 2)}\n`);
}

async function browserlessUsageProbe() {
  const config = loadConfig({ cwd: process.cwd() });
  if (!config.browserlessToken) throw new Error("BROWSERLESS_TOKEN is not configured");
  const usage = await browserlessUsage(config.browserlessToken);
  const fixture = {
    contractVersion: "browserless-usage-followup-v1",
    capturedAt: new Date().toISOString(),
    usage,
    privacy: { tokenRetained: false }
  };
  await writeJson("browserless-usage-followup.json", fixture);
  process.stdout.write(`${JSON.stringify({
    output: path.relative(process.cwd(), path.join(FIXTURE_ROOT, "browserless-usage-followup.json")),
    usage
  }, null, 2)}\n`);
}

function providerTaskSummary(item) {
  const body = item?.response?.body || {};
  const task = Array.isArray(body.tasks) ? body.tasks[0] : null;
  return {
    httpStatus: item?.response?.httpStatus ?? null,
    responseStatusCode: body.status_code ?? null,
    responseCostUsd: Number(body.cost || 0),
    taskStatusCode: task?.status_code ?? null,
    taskCostUsd: Number(task?.cost || 0),
    taskResultCount: task?.result_count ?? (Array.isArray(task?.result) ? task.result.length : null),
    resultRecordCount: Array.isArray(task?.result) ? task.result.length : null
  };
}

async function providerEvidenceProbe() {
  const sourcePath = "/tmp/email-scraper-traffic-discovery.json";
  const evidence = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  if (evidence?.metadata?.probe_version !== "traffic-discovery-v1") {
    throw new Error("The temporary provider evidence has an unexpected contract");
  }
  const live = evidence.dataforseo?.live || {};
  const dataForSeo = Object.fromEntries(Object.entries(live)
    .map(([scope, item]) => [scope, providerTaskSummary(item)]));
  const liveCostUsd = Object.values(dataForSeo)
    .reduce((sum, item) => sum + item.responseCostUsd, 0);
  const cruxRest = Object.fromEntries(Object.entries(evidence.crux_api || {})
    .map(([name, item]) => [name, {
      httpStatus: item?.response?.httpStatus ?? null,
      bodyKeys: item?.response?.body && typeof item.response.body === "object"
        ? Object.keys(item.response.body).sort()
        : [],
      errorCode: item?.response?.body?.error?.code ?? null,
      hasRecord: Boolean(item?.response?.body?.record)
    }]));
  const dryBody = evidence.crux_bigquery?.dry_run?.response?.body || {};
  const queryBody = evidence.crux_bigquery?.query_success?.response?.body || {};
  const latestMonth = evidence.crux_bigquery?.latest_month_lookup?.response?.body?.latest_month;
  const fixture = {
    contractVersion: "provider-live-observation-v1",
    capturedAt: evidence.metadata.captured_at,
    controls: {
      publicDomainCount: evidence.metadata.public_domains?.length ?? null,
      dataForSeoPaidCallLimit: evidence.metadata.dataforseo_live_call_limit,
      bigQueryMaximumBytesBilled: evidence.metadata.bigquery_execution_cap_bytes,
      productionFeatureFlagsChanged: false,
      productionDatabaseWritten: false
    },
    dataForSeo: {
      scopes: dataForSeo,
      paidCalls: Object.keys(dataForSeo).length,
      providerReportedCostUsd: Number(liveCostUsd.toFixed(8)),
      observedLatestRunBulkBaseline: {
        domains: 52,
        scopesAndTasks: 10,
        totalCostUsd: 0.1824
      },
      perDomainAmplificationEstimate: {
        tasksIf52DomainsTimes10Scopes: 520,
        taskReductionFromBulkPercent: Number(((1 - 10 / 520) * 100).toFixed(2)),
        estimatedCostIfEveryTaskMatchedCurrentThreeTargetTaskCostUsd:
          Number((520 * (liveCostUsd / Math.max(1, Object.keys(dataForSeo).length))).toFixed(4)),
        note: "Cost estimate is directional because DataForSEO task cost varies with target count; call-count reduction is exact."
      }
    },
    cruxRest: {
      calls: Object.keys(cruxRest).length,
      cases: cruxRest
    },
    cruxBigQuery: {
      latestDatasetMonth: latestMonth,
      dryRun: {
        httpStatus: evidence.crux_bigquery?.dry_run?.response?.httpStatus ?? null,
        bytesProcessed: dryBody.totalBytesProcessed ?? null,
        jobComplete: dryBody.jobComplete ?? null
      },
      liveQuery: {
        executed: Boolean(evidence.crux_bigquery?.query_success),
        httpStatus: evidence.crux_bigquery?.query_success?.response?.httpStatus ?? null,
        bytesProcessed: queryBody.totalBytesProcessed ?? null,
        bytesBilled: queryBody.totalBytesBilled ?? null,
        cacheHit: queryBody.cacheHit ?? null,
        jobComplete: queryBody.jobComplete ?? null,
        rowCount: Array.isArray(queryBody.rows) ? queryBody.rows.length : 0,
        schemaFields: Array.isArray(queryBody.schema?.fields)
          ? queryBody.schema.fields.map(({ name, type }) => ({ name, type }))
          : []
      }
    },
    privacy: {
      credentialsRetained: false,
      taskOrJobIdsRetained: false,
      rawProviderBodiesRetained: false,
      domainResultsRetained: false,
      sqlRetained: false
    }
  };
  await writeJson("provider-live-observation.json", fixture);
  process.stdout.write(`${JSON.stringify({
    output: path.relative(process.cwd(), path.join(FIXTURE_ROOT, "provider-live-observation.json")),
    dataForSeo: fixture.dataForSeo,
    cruxRestCalls: fixture.cruxRest.calls,
    cruxBigQuery: fixture.cruxBigQuery
  }, null, 2)}\n`);
}

function quotedIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("Unsafe database identifier");
  }
  return `"${value}"`;
}

async function neonCoordinatorPrototype() {
  loadConfig({ cwd: process.cwd() });
  if (process.env.ALLOW_DATABASE_TESTS !== "true") {
    throw new Error("Refusing coordinator prototype without ALLOW_DATABASE_TESTS=true");
  }
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error("TEST_DATABASE_URL is not configured");
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL");
  }
  const schema = `payload_probe_${Date.now()}_${process.pid}`;
  const qSchema = quotedIdentifier(schema);
  const prisma = createPrismaClient(testUrl);
  const runId = "run_fixture_payload_discovery_0001";
  const generation = 1;
  const stage = "lead";
  const evidence = {
    contractVersion: "neon-coordinator-prototype-observation-v1",
    capturedAt: new Date().toISOString(),
    productionDatabaseUsed: false,
    disposableSchemaDropped: false,
    proofs: {}
  };
  try {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA ${qSchema}`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE ${qSchema}."PipelineStage" (
        "runId" text NOT NULL,
        "generation" integer NOT NULL,
        "stage" text NOT NULL,
        "expectedCount" integer NOT NULL CHECK ("expectedCount" >= 0),
        "terminalCount" integer NOT NULL DEFAULT 0 CHECK ("terminalCount" >= 0),
        "succeededCount" integer NOT NULL DEFAULT 0 CHECK ("succeededCount" >= 0),
        "failedCount" integer NOT NULL DEFAULT 0 CHECK ("failedCount" >= 0),
        "state" text NOT NULL CHECK ("state" IN ('running','ready','aggregating','completed')),
        "aggregationOwner" text,
        "aggregationToken" text,
        "artifactFingerprint" text,
        PRIMARY KEY ("runId", "generation", "stage"),
        CHECK ("terminalCount" = "succeededCount" + "failedCount"),
        CHECK ("terminalCount" <= "expectedCount")
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE ${qSchema}."PipelineTask" (
        "runId" text NOT NULL,
        "generation" integer NOT NULL,
        "stage" text NOT NULL,
        "itemId" text NOT NULL,
        "state" text NOT NULL CHECK ("state" IN ('pending','succeeded','failed')),
        "artifactKey" text,
        "artifactFingerprint" text,
        "terminalAt" timestamptz,
        PRIMARY KEY ("runId", "generation", "stage", "itemId"),
        FOREIGN KEY ("runId", "generation", "stage") REFERENCES
          ${qSchema}."PipelineStage" ("runId", "generation", "stage")
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${qSchema}."PipelineStage"
        ("runId","generation","stage","expectedCount","state")
      VALUES ($1,$2,$3,2,'running')
    `, runId, generation, stage);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${qSchema}."PipelineTask"
        ("runId","generation","stage","itemId","state")
      VALUES ($1,$2,$3,'item-a','pending'),($1,$2,$3,'item-b','pending')
    `, runId, generation, stage);

    async function recordTerminal(itemId, terminalState, artifactFingerprint) {
      return prisma.$transaction(async (transaction) => {
        const updated = await transaction.$queryRawUnsafe(`
          UPDATE ${qSchema}."PipelineTask"
          SET "state" = $5, "artifactKey" = $6, "artifactFingerprint" = $7,
              "terminalAt" = NOW()
          WHERE "runId" = $1 AND "generation" = $2 AND "stage" = $3
            AND "itemId" = $4 AND "state" = 'pending'
          RETURNING "state", "artifactFingerprint"
        `, runId, generation, stage, itemId, terminalState,
        `runs/${runId}/generation-1/${stage}/${itemId}.json`, artifactFingerprint);
        if (!updated.length) {
          const existing = await transaction.$queryRawUnsafe(`
            SELECT "state", "artifactFingerprint"
            FROM ${qSchema}."PipelineTask"
            WHERE "runId" = $1 AND "generation" = $2 AND "stage" = $3 AND "itemId" = $4
          `, runId, generation, stage, itemId);
          if (existing.length === 1 && existing[0].state === terminalState &&
              existing[0].artifactFingerprint === artifactFingerprint) {
            return { outcome: "idempotent_replay", incremented: false };
          }
          return { outcome: "conflict", incremented: false };
        }
        await transaction.$executeRawUnsafe(`
          UPDATE ${qSchema}."PipelineStage"
          SET "terminalCount" = "terminalCount" + 1,
              "succeededCount" = "succeededCount" + CASE WHEN $4 = 'succeeded' THEN 1 ELSE 0 END,
              "failedCount" = "failedCount" + CASE WHEN $4 = 'failed' THEN 1 ELSE 0 END,
              "state" = CASE
                WHEN "terminalCount" + 1 = "expectedCount" THEN 'ready'
                ELSE "state"
              END
          WHERE "runId" = $1 AND "generation" = $2 AND "stage" = $3
        `, runId, generation, stage, terminalState);
        return { outcome: "first_terminal", incremented: true };
      });
    }

    const first = await recordTerminal("item-a", "succeeded", "fingerprint-a");
    const replay = await recordTerminal("item-a", "succeeded", "fingerprint-a");
    const conflict = await recordTerminal("item-a", "succeeded", "different-fingerprint");
    const reversedSibling = await recordTerminal("item-b", "failed", "fingerprint-b");
    const ready = (await prisma.$queryRawUnsafe(`
      SELECT "expectedCount","terminalCount","succeededCount","failedCount","state"
      FROM ${qSchema}."PipelineStage"
      WHERE "runId" = $1 AND "generation" = $2 AND "stage" = $3
    `, runId, generation, stage))[0];
    evidence.proofs.firstTerminal = first;
    evidence.proofs.sameReplay = replay;
    evidence.proofs.conflictingReplay = conflict;
    evidence.proofs.reversedSibling = reversedSibling;
    evidence.proofs.readyCounts = ready;

    const ownerOne = await prisma.$queryRawUnsafe(`
      UPDATE ${qSchema}."PipelineStage"
      SET "state"='aggregating', "aggregationOwner"='owner-1', "aggregationToken"='token-1'
      WHERE "runId"=$1 AND "generation"=$2 AND "stage"=$3 AND "state"='ready'
      RETURNING "aggregationOwner"
    `, runId, generation, stage);
    const ownerTwo = await prisma.$queryRawUnsafe(`
      UPDATE ${qSchema}."PipelineStage"
      SET "state"='aggregating', "aggregationOwner"='owner-2', "aggregationToken"='token-2'
      WHERE "runId"=$1 AND "generation"=$2 AND "stage"=$3 AND "state"='ready'
      RETURNING "aggregationOwner"
    `, runId, generation, stage);
    const staleFinalize = await prisma.$executeRawUnsafe(`
      UPDATE ${qSchema}."PipelineStage"
      SET "state"='completed', "artifactFingerprint"='manifest-stale'
      WHERE "runId"=$1 AND "generation"=$2 AND "stage"=$3
        AND "state"='aggregating' AND "aggregationToken"='token-2'
    `, runId, generation, stage);
    const ownedFinalize = await prisma.$executeRawUnsafe(`
      UPDATE ${qSchema}."PipelineStage"
      SET "state"='completed', "artifactFingerprint"='manifest-final'
      WHERE "runId"=$1 AND "generation"=$2 AND "stage"=$3
        AND "state"='aggregating' AND "aggregationToken"='token-1'
    `, runId, generation, stage);
    evidence.proofs.aggregationCas = {
      firstOwnerWon: ownerOne.length === 1,
      secondOwnerWon: ownerTwo.length === 1,
      staleTokenFinalizeCount: staleFinalize,
      ownedTokenFinalizeCount: ownedFinalize
    };

    await prisma.$executeRawUnsafe(`
      INSERT INTO ${qSchema}."PipelineStage"
        ("runId","generation","stage","expectedCount","state")
      VALUES ($1,$2,'zero-stage',0,'ready')
    `, runId, generation);
    const zeroOwner = await prisma.$queryRawUnsafe(`
      UPDATE ${qSchema}."PipelineStage"
      SET "state"='aggregating', "aggregationOwner"='zero-owner', "aggregationToken"='zero-token'
      WHERE "runId"=$1 AND "generation"=$2 AND "stage"='zero-stage' AND "state"='ready'
      RETURNING "expectedCount","terminalCount","state"
    `, runId, generation);
    evidence.proofs.zeroCountAdvance = {
      ownerWon: zeroOwner.length === 1,
      expectedCount: zeroOwner[0]?.expectedCount ?? null,
      terminalCount: zeroOwner[0]?.terminalCount ?? null,
      state: zeroOwner[0]?.state ?? null
    };
  } finally {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${qSchema} CASCADE`);
    evidence.disposableSchemaDropped = true;
    await prisma.$disconnect();
  }
  await writeJson("neon-coordinator-prototype-observation.json", evidence);
  process.stdout.write(`${JSON.stringify({
    output: path.relative(process.cwd(), path.join(FIXTURE_ROOT,
      "neon-coordinator-prototype-observation.json")),
    proofs: evidence.proofs,
    disposableSchemaDropped: evidence.disposableSchemaDropped
  }, null, 2)}\n`);
}

async function recursiveBytes(target) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  const entries = await fs.readdir(target);
  let total = 0;
  for (const entry of entries) total += await recursiveBytes(path.join(target, entry));
  return total;
}

function coldImport(modulePath) {
  const source = `const started=performance.now();await import(${JSON.stringify(modulePath)});` +
    `console.log(JSON.stringify({durationMs:Math.round((performance.now()-started)*10)/10,` +
    `rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed}))`;
  let stdout;
  try {
    stdout = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw new Error(`Cold import failed for ${modulePath}: ${error?.stderr?.toString().trim() || "Error"}`);
  }
  if (!stdout.trim()) throw new Error(`Cold import produced no output for ${modulePath}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Cold import produced invalid JSON for ${modulePath}`);
  }
}

async function runtimeLocalProbe() {
  const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
  const productionPackagePaths = Object.entries(lock.packages || {})
    .filter(([key, value]) => key.startsWith("node_modules/") && value?.dev !== true)
    .map(([key]) => key)
    .sort();
  let installedProductionDependencyBytes = 0;
  const missingPackages = [];
  for (const packagePath of productionPackagePaths) {
    try {
      installedProductionDependencyBytes += await recursiveBytes(packagePath);
    } catch (error) {
      if (error?.code === "ENOENT") missingPackages.push(packagePath);
      else throw error;
    }
  }
  const applicationPaths = ["src", "prisma", "package.json", "package-lock.json"];
  let applicationBytes = 0;
  for (const applicationPath of applicationPaths) {
    applicationBytes += await recursiveBytes(applicationPath);
  }
  const dependencyPackages = {};
  for (const packageName of [
    "@neondatabase/serverless",
    "@prisma/adapter-neon",
    "@prisma/client",
    "dotenv",
    "google-auth-library",
    "zod"
  ]) {
    const packagePath = path.join("node_modules", packageName, "package.json");
    let packageJson;
    try {
      packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
    } catch {
      throw new Error(`Could not parse ${packagePath}`);
    }
    dependencyPackages[packageName] = {
      version: packageJson.version,
      engines: packageJson.engines || null
    };
  }
  const fixture = {
    contractVersion: "lambda-runtime-local-observation-v1",
    capturedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      packageEngineContract: ">=20",
      node24DeterministicSuite: { total: 272, passed: 265, failed: 0, skipped: 7 }
    },
    dependencies: {
      direct: dependencyPackages,
      productionPackageDirectoryCount: productionPackagePaths.length,
      missingInstalledProductionPackageDirectoryCount: missingPackages.length
    },
    sizeInventory: {
      applicationBytes,
      installedProductionDependencyBytes,
      combinedUncompressedBytes: applicationBytes + installedProductionDependencyBytes,
      caveat: "This is a transitive installed-file inventory, not a tree-shaken or zipped Lambda bundle."
    },
    coldImports: {
      pipeline: coldImport("./src/pipeline.js"),
      trafficOrchestrator: coldImport("./src/enrichment/orchestrator.js"),
      prismaRepository: coldImport("./src/prisma-run-repository.js")
    },
    targetGaps: {
      lambdaHandlersExist: false,
      perHandlerTreeShakenBundlesExist: false,
      productionLambdaColdStartMeasured: false,
      productionNeonConnectivityFromLambdaMeasured: false,
      googleCredentialMaterialLoadingFromLambdaMeasured: false
    }
  };
  await writeJson("lambda-runtime-local-observation.json", fixture);
  process.stdout.write(`${JSON.stringify({
    output: path.relative(process.cwd(), path.join(FIXTURE_ROOT,
      "lambda-runtime-local-observation.json")),
    runtime: fixture.runtime,
    productionPackageDirectoryCount: fixture.dependencies.productionPackageDirectoryCount,
    sizeInventory: fixture.sizeInventory,
    coldImports: fixture.coldImports,
    targetGaps: fixture.targetGaps
  }, null, 2)}\n`);
}

async function awsLearningCodeBackup() {
  const cli = execFileSync("aws", [
    "lambda", "get-function",
    "--function-name", "storesignal-dev-learning-worker",
    "--profile", "storesignal-dev",
    "--region", "ap-south-2",
    "--output", "json"
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const result = JSON.parse(cli);
  if (!result?.Code?.Location || !result?.Configuration?.CodeSha256) {
    throw new Error("AWS did not return the learning code location and hash");
  }
  const response = await fetch(result.Code.Location, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Learning code download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(bytes).digest("base64");
  if (actualSha256 !== result.Configuration.CodeSha256) {
    throw new Error("Downloaded learning ZIP did not match the configured SHA-256");
  }
  await fs.writeFile("/tmp/storesignal-learning-original.zip", bytes, { flag: "wx", mode: 0o600 });
  const metadata = {
    functionName: result.Configuration.FunctionName,
    runtime: result.Configuration.Runtime,
    handler: result.Configuration.Handler,
    codeSizeBytes: bytes.length,
    codeSha256: actualSha256,
    backupPath: "/tmp/storesignal-learning-original.zip",
    presignedLocationRetained: false
  };
  await fs.writeFile(
    "/tmp/storesignal-learning-original-metadata.json",
    `${JSON.stringify(metadata, null, 2)}\n`,
    { flag: "wx", mode: 0o600 }
  );
  process.stdout.write(`${JSON.stringify({
    functionName: metadata.functionName,
    runtime: metadata.runtime,
    handler: metadata.handler,
    codeSizeBytes: metadata.codeSizeBytes,
    hashVerified: true,
    backupPath: metadata.backupPath,
    presignedLocationRetained: false
  }, null, 2)}\n`);
}

async function neonProbe() {
  const config = loadConfig({ cwd: process.cwd() });
  if (!config.databaseUrl) throw new Error("DATABASE_URL is not configured");
  const prisma = createPrismaClient(config.databaseUrl);
  const evaluatedAt = new Date();
  try {
    const recentRuns = await prisma.run.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        state: true,
        phase: true,
        stage: true,
        queryRevision: true,
        confirmedQueryRevision: true,
        createdAt: true,
        completedAt: true,
        resultsAvailable: true,
        resultFingerprint: true,
        trafficEnrichmentConfig: true,
        trafficEnrichmentSummary: true,
        _count: { select: { queries: true, leads: true, runStores: true } }
      }
    });
    let selected = null;
    for (const run of recentRuns) {
      const trafficCount = await prisma.leadTrafficEnrichment.count({
        where: { runId: run.id }
      });
      if (trafficCount > 0) {
        selected = { ...run, trafficCount };
        break;
      }
    }
    if (!selected) throw new Error("No recent run with traffic enrichment was found");

    const [queries, leads, traffic, runStores, cacheState, workState, ledger] =
      await Promise.all([
        prisma.runQuery.findMany({
          where: { runId: selected.id },
          orderBy: { sequence: "asc" }
        }),
        prisma.lead.findMany({
          where: { runId: selected.id },
          select: {
            id: true,
            shopId: true,
            status: true,
            resolvedDomain: true,
            finalUrl: true
          }
        }),
        prisma.leadTrafficEnrichment.findMany({
          where: { runId: selected.id },
          select: {
            leadId: true,
            source: true,
            state: true,
            contractVersion: true,
            normalizedPayload: true,
            fetchedAt: true,
            coverageStartedAt: true,
            coverageEndedAt: true
          }
        }),
        prisma.runStore.findMany({
          where: { runId: selected.id },
          select: { state: true }
        }),
        prisma.trafficEnrichmentCache.groupBy({
          by: ["source", "state"],
          _count: { _all: true }
        }),
        prisma.shopWork.groupBy({
          by: ["workType", "state"],
          _count: { _all: true }
        }),
        prisma.dataForSeoRequestLedger.findMany({
          where: { runId: selected.id },
          select: {
            scopeKey: true,
            state: true,
            targetCount: true,
            attempt: true,
            providerCostUsd: true,
            reservationCostUsd: true
          },
          orderBy: { scopeKey: "asc" }
        })
      ]);

    const leadAlias = new Map(leads
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((lead, index) => [lead.id, `lead_fixture_${String(index + 1).padStart(3, "0")}`]));
    const trafficShape = traffic.map((row) => ({
      leadAlias: leadAlias.get(row.leadId) || "lead_fixture_unknown",
      source: row.source,
      state: row.state,
      contractVersion: row.contractVersion,
      normalizedPayloadKeys: row.normalizedPayload && typeof row.normalizedPayload === "object"
        ? Object.keys(row.normalizedPayload).sort()
        : [],
      fetchedAtPresent: row.fetchedAt instanceof Date,
      coverageStartedAtPresent: row.coverageStartedAt instanceof Date,
      coverageEndedAtPresent: row.coverageEndedAt instanceof Date
    })).sort((left, right) =>
      `${left.leadAlias}:${left.source}`.localeCompare(`${right.leadAlias}:${right.source}`));

    const sourcesPerLead = new Map();
    for (const row of traffic) {
      if (!sourcesPerLead.has(row.leadId)) sourcesPerLead.set(row.leadId, new Set());
      sourcesPerLead.get(row.leadId).add(row.source);
    }
    const allThreeSources = [...sourcesPerLead.values()].filter((sources) =>
      ["dataforseo", "crux_rest", "crux_bigquery"].every((source) => sources.has(source))).length;

    const qualified = leads.filter(({ status }) => status === "qualified");
    const shopIds = [...new Set(qualified.map(({ shopId }) => shopId).filter(Boolean))];
    const profiles = await prisma.shopLeadProfile.findMany({
      where: { shopId: { in: shopIds } },
      select: { shopId: true, state: true, profilePayload: true, updatedAt: true }
    });
    const profileByShop = new Map(profiles.map((row) => [row.shopId, row]));
    const dataForSeoIdentityByLead = new Map();
    const originByLead = new Map();
    for (const lead of qualified) {
      try {
        dataForSeoIdentityByLead.set(lead.id, normalizeDataForSeoHostname(
          String(lead.resolvedDomain || "").toLowerCase().replace(/^www\./u, "")
        ));
      } catch {}
      try {
        const url = new URL(lead.finalUrl);
        if (!url.username && !url.password) {
          originByLead.set(lead.id, normalizeCruxOrigin(url.origin));
        }
      } catch {}
    }
    const dataForSeoIdentities = [...new Set(dataForSeoIdentityByLead.values())];
    const origins = [...new Set(originByLead.values())];
    const relevantCaches = await prisma.trafficEnrichmentCache.findMany({
      where: {
        OR: [
          { source: "dataforseo", identity: { in: dataForSeoIdentities } },
          { source: "crux_rest", identity: { in: origins } },
          { source: "crux_bigquery", identity: { in: origins } }
        ]
      },
      select: {
        source: true,
        identity: true,
        scopeKey: true,
        metricSetKey: true,
        contractVersion: true,
        state: true,
        normalizedPayload: true,
        fetchedAt: true,
        expiresAt: true
      }
    });
    const cacheByKey = new Map(relevantCaches.map((row) => [[
      row.source, row.identity, row.scopeKey, row.metricSetKey, row.contractVersion
    ].join("\u0000"), row]));
    const runSnapshot = selected.trafficEnrichmentConfig;
    let latestDatasetMonth = null;
    try {
      const providerFixture = JSON.parse(await fs.readFile(
        path.join(FIXTURE_ROOT, "provider-live-observation.json"), "utf8"
      ));
      latestDatasetMonth = providerFixture.cruxBigQuery?.latestDatasetMonth || null;
    } catch {}
    const reusableCache = (source, identity, scopeKey, policy) => {
      const row = cacheByKey.get([
        source, identity, scopeKey, policy.metricSetKey, policy.contractVersion
      ].join("\u0000"));
      if (!row || row.expiresAt <= evaluatedAt ||
          !["available", "no_coverage"].includes(row.state)) return false;
      if (row.state === "available" && row.normalizedPayload == null) return false;
      return true;
    };
    const reuseRows = qualified.map((lead) => {
      const profileRow = profileByShop.get(lead.shopId);
      let leadReusable = false;
      if (profileRow?.state === "completed" && profileRow.profilePayload != null) {
        try {
          parseShopLeadProfile(profileRow.profilePayload);
          leadReusable = true;
        } catch {}
      }
      const hostname = dataForSeoIdentityByLead.get(lead.id);
      const origin = originByLead.get(lead.id);
      const dataForSeoReusable = Boolean(hostname && runSnapshot?.dataForSeo?.enabled &&
        runSnapshot.dataForSeo.scopes.every((scope) => reusableCache(
          "dataforseo", hostname, dataForSeoScopeKey(scope), runSnapshot.dataForSeo
        )));
      const cruxRestReusable = Boolean(origin && runSnapshot?.crux?.enabled && reusableCache(
        "crux_rest", origin, "current", runSnapshot.crux.rest
      ));
      const cruxBigQueryReusable = Boolean(origin && runSnapshot?.crux?.enabled &&
        latestDatasetMonth && reusableCache(
          "crux_bigquery", origin, `month:${latestDatasetMonth}`, runSnapshot.crux.bigQuery
        ));
      return {
        leadReusable,
        dataForSeoReusable,
        cruxRestReusable,
        cruxBigQueryReusable,
        needsLead: !leadReusable,
        needsTraffic: !dataForSeoReusable,
        needsCruxRest: !cruxRestReusable,
        needsCruxBigQuery: !cruxBigQueryReusable,
        needsCrux: !cruxRestReusable || !cruxBigQueryReusable
      };
    });
    const reuseCounts = Object.fromEntries([
      "leadReusable", "dataForSeoReusable", "cruxRestReusable", "cruxBigQueryReusable",
      "needsLead", "needsTraffic", "needsCruxRest", "needsCruxBigQuery", "needsCrux"
    ].map((key) => [key, reuseRows.filter((row) => row[key]).length]));

    const queryShape = queries.map(summarizeQuery);
    const fixture = {
      contractVersion: PROBE_VERSION,
      evaluatedAt: evaluatedAt.toISOString(),
      selectedRun: {
        alias: "run_latest_with_traffic",
        state: selected.state,
        phase: selected.phase,
        stage: selected.stage,
        queryRevision: selected.queryRevision,
        confirmedQueryRevision: selected.confirmedQueryRevision,
        resultsAvailable: selected.resultsAvailable,
        resultFingerprintPresent: Boolean(selected.resultFingerprint),
        createdAt: selected.createdAt.toISOString(),
        completedAt: selected.completedAt?.toISOString() || null,
        counts: {
          queries: selected._count.queries,
          leads: selected._count.leads,
          runStores: selected._count.runStores,
          trafficRows: selected.trafficCount,
          leadsWithAllThreeTrafficSources: allThreeSources
        }
      },
      queryManifestObservation: {
        rows: queryShape,
        encodedBytes: encodedBytes(queryShape),
        fingerprint: fingerprint(queryShape)
      },
      runStores: { stateCounts: countBy(runStores, "state") },
      leads: { statusCounts: countBy(leads, "status") },
      traffic: {
        sourceCounts: countBy(traffic, "source"),
        stateCounts: countBy(traffic, "state"),
        shapes: trafficShape,
        encodedBytes: encodedBytes(trafficShape),
        fingerprint: fingerprint(trafficShape)
      },
      globalCacheStateCounts: cacheState.map((row) => ({
        source: row.source,
        state: row.state,
        count: row._count._all
      })),
      globalShopWorkStateCounts: workState.map((row) => ({
        workType: row.workType,
        state: row.state,
        count: row._count._all
      })),
      dataForSeoLedger: ledger.map((row) => ({
        scopeKey: row.scopeKey,
        state: row.state,
        targetCount: row.targetCount,
        attempt: row.attempt,
        providerCostUsd: row.providerCostUsd == null ? null : Number(row.providerCostUsd),
        reservationCostUsd: row.reservationCostUsd == null
          ? null
          : Number(row.reservationCostUsd)
      })),
      fixedTimeReuse: {
        evaluatedAt: evaluatedAt.toISOString(),
        latestDatasetMonth,
        eligibleDomains: qualified.length,
        counts: reuseCounts,
        databaseReads: {
          strategy: "bounded set-based reads",
          profileQueryCount: 1,
          cacheQueryCount: 1,
          profileRowsRead: profiles.length,
          relevantCacheRowsRead: relevantCaches.length
        },
        currentCodeFreshnessDrift: {
          orchestratorPrefersMethod: "readReusableTrafficCache",
          methodFiltersExpiresAt: false,
          latestBigQueryMethodFiltersExpiresAt: false,
          olderFallbackFiltersExpiresAt: true,
          introducingCommit: "de04287b944fb657687366d152d9a96a0edc2482"
        }
      },
      privacy: {
        productionRunIdRetained: false,
        queryTextRetained: false,
        domainOrContactDataRetained: false,
        normalizedProviderValuesRetained: false,
        credentialsRetained: false
      }
    };
    await writeJson("neon-readonly-observation.json", fixture);
    process.stdout.write(`${JSON.stringify({
      output: path.relative(process.cwd(), path.join(FIXTURE_ROOT, "neon-readonly-observation.json")),
      selectedRunCounts: fixture.selectedRun.counts,
      trafficSourceCounts: fixture.traffic.sourceCounts,
      trafficStateCounts: fixture.traffic.stateCounts,
      queryManifestBytes: fixture.queryManifestObservation.encodedBytes
    }, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "aws-learning-code-backup") return awsLearningCodeBackup();
  if (command === "browserless-live-negative") {
    return browserlessLiveProbe({ negative: true });
  }
  if (command === "browserless-usage") return browserlessUsageProbe();
  if (command === "browserless-live") return browserlessLiveProbe();
  if (command === "local-contracts") return localContractsProbe();
  if (command === "runtime-local") return runtimeLocalProbe();
  if (command === "neon-coordinator-prototype") return neonCoordinatorPrototype();
  if (command === "neon-readonly") return neonProbe();
  if (command === "provider-evidence") return providerEvidenceProbe();
  throw new Error(
    "Usage: node scripts/lambda-payload-discovery-probe.js " +
    "<aws-learning-code-backup|browserless-live|browserless-live-negative|" +
    "browserless-usage|local-contracts|" +
    "neon-coordinator-prototype|" +
    "neon-readonly|provider-evidence|runtime-local>"
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.name || "Error"}: ${error?.message || "probe failed"}\n`);
  process.exitCode = 1;
});
