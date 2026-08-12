import { z } from "zod";
import {
  parseRunStoreCandidate, parseShopLeadProfile, parseStableShopIdentity,
  runStoreCandidateSchema, shopLeadProfileSchema, runStoreId, shopIdForStableKey
} from "../../shop-persistence-contract.js";
import { leadRecordToCreate, leadTrafficEnrichmentRecordToCreate, trafficCacheRecordToUpsert } from
  "../../api-serializer.js";
import { PipelineContractError, PipelineInvariantError } from "./errors.js";
import { candidateArtifactKey, providerArtifactKey } from "../core/keys.js";
import { fingerprintJson } from "../core/canonical.js";
import { awsProviderConfigSchema } from "./aws-provider-config.js";

const runId = z.string().regex(/^run_[A-Za-z0-9_-]{16,80}$/u);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const generation = z.number().int().min(1).max(2147483647);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().max(4000);
const url = z.string().max(2048).refine((value) => {
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password; }
  catch { return false; }
});
function containsForbiddenPersistedValue(value) {
  if (typeof value === "string") return /<(?:!doctype|html|body|head|script|style|div|span|form|input|main)\b/iu.test(value) ||
    /https?:\/\/[^\s/@]+:[^\s/@]+@/u.test(value);
  if (Array.isArray(value)) return value.some(containsForbiddenPersistedValue);
  if (value && typeof value === "object") return Object.entries(value).some(([key, child]) =>
    /(?:authorization|credential|html|password|providerBody|providerResponse|rawBody|rawHtml|secret|token)/iu.test(key) ||
    containsForbiddenPersistedValue(child));
  return false;
}
const persistedJson = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (containsForbiddenPersistedValue(value)) context.addIssue({ code: "custom", message: "forbidden persisted value" });
});
const diagnostic = z.object({ scope: z.string().max(128), code: z.string().max(128),
  shop_type: z.string().max(200).optional(), business_qualifier: z.string().max(100).optional(),
  query: z.string().max(1000).optional(), result_url: url.optional(), details: persistedJson }).strict();

const category = z.object({ categoryIndex: z.number().int().nonnegative(), originalShopType: z.string().max(200),
  shopType: z.string().max(200), businessQualifier: z.string().max(100),
  categoryVocabulary: z.array(z.string().max(200)).max(100) }).strict();
const probeResult = z.object({ query: z.string().min(1).max(1000), rank: z.number().int().min(1).max(10),
  url: z.string().max(2048), title: z.string().max(500), snippet: z.string().max(1000),
  rejectionReason: z.enum(["", "invalid_url", "unsupported_scheme", "asset_result"]) }).strict()
  .superRefine((value, context) => {
    if (!value.rejectionReason) {
      const parsed = url.safeParse(value.url);
      if (!parsed.success) context.addIssue({ code: "custom", message: "probe url" });
    } else if (value.url !== "") context.addIssue({ code: "custom", message: "rejected url" });
  });
const query = z.object({ id, categoryIndex: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(),
  query: z.string().max(1000), source: z.string().max(128), validationState: z.string().max(128),
  queryScore: z.number().finite().nullable(), generationReason: text,
  sourceUrls: z.array(url).max(8), categoryVocabulary: z.array(z.string().max(200)).max(100),
  probeContractVersion: z.string().max(128), probeFingerprint: fingerprint,
  probeResults: z.array(probeResult).min(1).max(10) }).strict().superRefine((value, context) => {
    if (value.validationState !== "valid" || value.probeContractVersion !== "google-probe-v2")
      context.addIssue({ code: "custom", message: "probe state" });
    const ranks = value.probeResults.map((entry) => entry.rank);
    if (new Set(ranks).size !== ranks.length || ranks.some((rank, index) => index > 0 && rank <= ranks[index - 1]))
      context.addIssue({ code: "custom", message: "probe order" });
    if (value.probeResults.some((entry) => entry.query !== value.query))
      context.addIssue({ code: "custom", message: "probe query" });
  });

export const confirmedQueryManifestSchema = z.object({ contractVersion: z.literal("confirmed-query-manifest-v1"),
  runId, generation, confirmedRevision: z.number().int().positive(), categories: z.array(category).max(1000),
  awsProviderConfig: awsProviderConfigSchema, queries: z.array(query).max(1000) }).strict();

const identity = z.unknown().transform((value, context) => {
  try { return parseStableShopIdentity(value); } catch { context.addIssue({ code: "custom", message: "identity" }); return z.NEVER; }
});
const candidate = runStoreCandidateSchema.superRefine((value, context) => {
  try { parseRunStoreCandidate(value); } catch { context.addIssue({ code: "custom", message: "candidate" }); }
});
const store = z.object({ identity, candidatePayload: candidate }).strict().superRefine((value, context) => {
  if (value.identity.stableKey !== value.candidatePayload.stableIdentity) context.addIssue({ code: "custom", message: "identity" });
});
export const queryDiscoveryArtifactSchema = z.object({ contractVersion: z.literal("query-discovery-artifact-v1"),
  runId, generation, queryId: id, confirmedRevision: z.number().int().positive(),
  pipelineVersion: z.number().int().positive(), scoringVersion: z.number().int().positive(),
  stores: z.array(store).max(1000), queryAudits: z.array(z.unknown()).max(1000),
  diagnostics: z.array(diagnostic).max(1000) }).strict();

const domain = z.object({ shopId: id, runStoreId: id, identity, candidatePayload: candidate }).strict()
  .superRefine((value, context) => {
    if (value.identity.stableKey !== value.candidatePayload.stableIdentity) context.addIssue({ code: "custom", message: "identity" });
  });
export const domainCandidateArtifactSchema = z.object({ contractVersion: z.literal("domain-candidate-v1"), runId,
  generation, shopId: id, runStoreId: id, identity, candidatePayload: candidate }).strict().superRefine((value, context) => {
    if (value.identity.stableKey !== value.candidatePayload.stableIdentity ||
        value.shopId !== shopIdForStableKey(value.identity.stableKey) ||
        value.runStoreId !== runStoreId(value.runId, value.shopId)) context.addIssue({ code: "custom", message: "candidate identity" });
  });
export const domainManifestSchema = z.object({ contractVersion: z.literal("domain-manifest-v1"), runId,
  generation, confirmedRevision: z.number().int().positive(),
  inputQueryArtifactFingerprints: z.array(fingerprint).max(1000),
  probeEvidence: z.object({ queryOrderIndependent: z.literal(true), mergedOccurrenceCount: z.number().int().nonnegative(),
    duplicateCount: z.number().int().nonnegative() }).strict(), domains: z.array(domain).max(1000) }).strict();

const reuse = z.object({ cacheId: id, cacheFingerprint: fingerprint }).strict();
const sourceKey = z.object({ source: z.enum(["dataforseo", "crux_rest", "crux_bigquery"]), identity: z.string().max(2048),
  scopeKey: z.string().max(128), metricSetKey: z.string().max(500), contractVersion: z.string().max(128),
  reuse: reuse.nullable() }).strict().superRefine((value, context) => {
    if (value.source === "crux_bigquery" && value.scopeKey === "latest" && value.reuse !== null)
      context.addIssue({ code: "custom", message: "latest reuse" });
    if (value.source === "crux_bigquery" && value.scopeKey !== "latest" && !/^month:20\d{4}$/u.test(value.scopeKey))
      context.addIssue({ code: "custom", message: "month scope" });
  });
const workDomain = z.object({ shopId: id, runStoreId: id, candidateKey: z.string().max(2048),
  candidateFingerprint: fingerprint, leadReuse: z.object({ profileShopId: id, profileFingerprint: fingerprint }).strict().nullable(),
  needsLead: z.boolean(), needsTraffic: z.boolean(), needsCruxRest: z.boolean(), needsCruxBigQuery: z.boolean(),
  needsCrux: z.boolean(), sourceKeys: z.object({ dataForSeo: z.array(sourceKey).max(100), cruxRest: sourceKey,
    cruxBigQuery: sourceKey }).strict() }).strict().superRefine((value, context) => {
      if (value.needsCrux !== (value.needsCruxRest || value.needsCruxBigQuery)) context.addIssue({ code: "custom", message: "needs" });
      if (value.needsLead !== (value.leadReuse === null)) context.addIssue({ code: "custom", message: "lead reuse" });
    });
export const domainWorkPlanSchema = z.object({ contractVersion: z.literal("domain-work-plan-v1"), runId, generation,
  evaluatedAt: z.string().datetime(), domainManifestKey: z.string().max(2048), awsProviderConfig: awsProviderConfigSchema,
  domains: z.array(workDomain).max(1000) }).strict()
  .superRefine((value, context) => {
    if (value.domainManifestKey !== `runs/${value.runId}/domains-manifest.json`) context.addIssue({ code: "custom", message: "manifest key" });
  });

export const domainStageManifestSchema = z.object({ contractVersion: z.literal("domain-stage-manifest-v1"),
  domainManifest: domainManifestSchema, workPlan: domainWorkPlanSchema }).strict().superRefine((value, context) => {
    const { domainManifest: manifest, workPlan: plan } = value;
    if (manifest.runId !== plan.runId || manifest.generation !== plan.generation) context.addIssue({ code: "custom", message: "run" });
    const manifestDomains = new Map(manifest.domains.map((entry) => [entry.shopId, entry]));
    if (manifestDomains.size !== manifest.domains.length || new Set(plan.domains.map((entry) => entry.shopId)).size !== plan.domains.length ||
        manifest.domains.length !== plan.domains.length) context.addIssue({ code: "custom", message: "set" });
    for (const entry of plan.domains) {
      const expected = manifestDomains.get(entry.shopId);
      if (!expected || expected.runStoreId !== entry.runStoreId ||
          entry.candidateKey !== candidateArtifactKey(plan.runId, entry.shopId)) context.addIssue({ code: "custom", message: "domain" });
      if (expected) {
        const candidateFingerprint = fingerprintJson(domainCandidateArtifactSchema.parse({
          contractVersion: "domain-candidate-v1", runId: plan.runId, generation: plan.generation,
          shopId: expected.shopId, runStoreId: expected.runStoreId, identity: expected.identity,
          candidatePayload: expected.candidatePayload
        }));
        if (entry.candidateFingerprint !== candidateFingerprint)
          context.addIssue({ code: "custom", message: "candidate fingerprint" });
      }
      const expectedSources = [
        ...entry.sourceKeys.dataForSeo.map((key) => [key, "dataforseo"]),
        [entry.sourceKeys.cruxRest, "crux-rest"], [entry.sourceKeys.cruxBigQuery, "crux-bigquery"]
      ];
      const expectedIdentity = expected?.identity;
      let expectedOrigin = null;
      try { expectedOrigin = expectedIdentity?.canonicalUrl ? new URL(expectedIdentity.canonicalUrl).origin : null; } catch {}
      for (const [key, source] of expectedSources) {
        const sourceMatches = key.source.replaceAll("_", "-") === source;
        const identityMatches = source === "dataforseo"
          ? key.identity === expectedIdentity?.resolvedDomain
          : expectedOrigin != null && key.identity === expectedOrigin;
        if (!sourceMatches || !identityMatches) context.addIssue({ code: "custom", message: "source key" });
      }
    }
  });

const leadOutcome = z.object({ runId, generation, shopId: id, runStoreId: id,
  state: z.enum(["completed", "failed", "rejected"]), profileReusable: z.boolean(), profile: shopLeadProfileSchema.optional(),
  lead: persistedJson, pageDiagnostics: persistedJson.optional(), diagnostic: diagnostic.optional()
}).strict().superRefine((value, context) => {
  try {
    if (value.profile) parseShopLeadProfile(value.profile);
    leadRecordToCreate(value.runId, `lead_${value.shopId}`, value.lead);
  } catch { context.addIssue({ code: "custom", message: "lead" }); }
});
export const leadResultArtifactSchema = z.object({ contractVersion: z.literal("lead-result-v1"), result: leadOutcome }).strict();

export const providerSourceArtifactSchema = z.object({ contractVersion: z.literal("provider-source-result-v1"), runId,
  generation, shopId: id, source: z.enum(["dataforseo", "crux_rest", "crux_bigquery"]),
  state: z.enum(["available", "partial", "no_coverage", "unavailable", "ambiguous", "contract_mismatch", "reused"]),
  scopeStates: z.array(z.object({ scopeKey: z.string().max(128), state: z.enum([
    "available", "no_coverage", "unavailable", "ambiguous", "contract_mismatch", "reused"
  ]) }).strict()).min(1).max(100),
  cacheRows: z.array(z.record(z.string(), z.unknown())).max(1000), leadTrafficRows: z.array(z.record(z.string(), z.unknown())).max(1000),
  summary: z.record(z.string(), z.unknown()), diagnostics: z.array(diagnostic).max(1000) }).strict().superRefine((value, context) => {
    try {
      value.cacheRows.forEach((row, index) => trafficCacheRecordToUpsert(`cache_${index}`, row));
      value.leadTrafficRows.forEach((row, index) => leadTrafficEnrichmentRecordToCreate(`traffic_${index}`, value.runId, `lead_${value.shopId}`, row));
    } catch { context.addIssue({ code: "custom", message: "traffic" }); }
    const scopes = value.scopeStates.map((entry) => entry.scopeKey);
    if (new Set(scopes).size !== scopes.length || scopes.some((scope, index) => index > 0 && scope <= scopes[index - 1]))
      context.addIssue({ code: "custom", message: "scope order" });
    if (value.source !== "dataforseo" && value.state === "partial") context.addIssue({ code: "custom", message: "partial source" });
    const states = new Set(value.scopeStates.map((entry) => entry.state));
    if (value.state === "partial") {
      if (states.size < 2 || !value.scopeStates.some((entry) => ["available", "no_coverage", "reused"].includes(entry.state)))
        context.addIssue({ code: "custom", message: "partial scopes" });
    } else if (states.size !== 1 || !states.has(value.state)) context.addIssue({ code: "custom", message: "uniform scopes" });
  });

const component = z.object({ state: z.enum(["available", "partial", "no_coverage", "unavailable", "ambiguous", "contract_mismatch", "reused", "skipped"]),
  contractVersion: z.string().max(128), artifactKey: z.string().max(2048).optional() }).strict();
export const combinedTrafficCruxResultSchema = z.object({ contractVersion: z.literal("combined-traffic-crux-result-v1"),
  runId, generation, shopId: id, components: z.object({ dataforseo: component, cruxRest: component, cruxBigQuery: component }).strict()
}).strict().superRefine((value, context) => {
  const mapping = [["dataforseo", "dataforseo"], ["cruxRest", "crux-rest"], ["cruxBigQuery", "crux-bigquery"]];
  for (const [name, source] of mapping) {
    const part = value.components[name];
    const material = part.state !== "skipped";
    if (name !== "dataforseo" && part.state === "partial") context.addIssue({ code: "custom", message: "partial component" });
    if ((material && part.artifactKey !== providerArtifactKey(value.runId, value.shopId, source)) || (!material && part.artifactKey)) {
      context.addIssue({ code: "custom", message: "component" });
    }
  }
});

export const googleProbeAttemptArtifactSchema = z.object({ contractVersion: z.literal("google-probe-attempt-v1"),
  runId, generation: z.literal(1), searchRequestFingerprint: fingerprint, providerConfigFingerprint: fingerprint }).strict();
export const googleProbeResultArtifactSchema = z.object({ contractVersion: z.literal("google-probe-result-v1"),
  runId, generation: z.literal(1), searchRequestFingerprint: fingerprint, providerConfigFingerprint: fingerprint,
  estimatedTotalResults: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), nextPageAvailable: z.boolean(),
  results: z.array(z.object({ rank: z.number().int().min(1).max(10), url, title: z.string().max(500),
    snippet: z.string().max(1000) }).strict()).max(10),
  rejections: z.array(z.object({ rank: z.number().int().min(1).max(10),
    reason: z.enum(["invalid_url", "unsupported_scheme", "asset_result"]) }).strict()).max(10)
}).strict().superRefine((value, context) => {
  const resultRanks = value.results.map((entry) => entry.rank);
  const rejectionRanks = value.rejections.map((entry) => entry.rank);
  const ranks = [...resultRanks, ...rejectionRanks];
  if (new Set(ranks).size !== ranks.length ||
      resultRanks.some((rank, index) => index > 0 && rank <= resultRanks[index - 1]) ||
      rejectionRanks.some((rank, index) => index > 0 && rank <= rejectionRanks[index - 1]))
    context.addIssue({ code: "custom", message: "rank order" });
});
export const browserlessAttemptArtifactSchema = z.object({ contractVersion: z.literal("browserless-attempt-v1"),
  runId, generation, shopId: id, taskInputFingerprint: fingerprint, pagePlanFingerprint: fingerprint }).strict();
export const aiNormalizationAttemptArtifactSchema = z.object({ contractVersion: z.literal("ai-normalization-attempt-v1"),
  runId, generation, shopId: id, taskInputFingerprint: fingerprint, normalizationInputFingerprint: fingerprint,
  clientRequestId: z.string().regex(/^openai-[a-f0-9]{32}$/u) }).strict().superRefine((value, context) => {
    if (value.clientRequestId !== `openai-${value.normalizationInputFingerprint.slice(0, 32)}`)
      context.addIssue({ code: "custom", message: "client request id" });
  });
export const providerSourceAttemptArtifactSchema = z.object({ contractVersion: z.literal("provider-source-attempt-v1"),
  runId, generation, shopId: id, source: z.literal("crux_rest"), taskInputFingerprint: fingerprint,
  sourceKeyFingerprint: fingerprint }).strict();
export const providerBatchAttemptSchema = z.object({ contractVersion: z.literal("provider-batch-attempt-v1"),
  runId, generation, source: z.literal("crux_bigquery"), scopeKey: z.string().regex(/^month:20\d{4}$/u),
  batchId: fingerprint, batchInputFingerprint: fingerprint, requestId: z.string().regex(/^crux-[a-f0-9]{31}$/u),
  datasetMonth: z.string().regex(/^20\d{4}$/u), dryRunBytesProcessed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dispatchedAt: z.string().datetime()
}).strict().superRefine((value, context) => {
  if (value.batchId !== value.batchInputFingerprint || value.datasetMonth !== value.scopeKey.slice(6) ||
      value.requestId !== `crux-${value.batchInputFingerprint.slice(0, 31)}`)
    context.addIssue({ code: "custom", message: "batch attempt" });
});
const batchItem = z.object({ shopId: id,
  state: z.enum(["available", "no_coverage", "unavailable", "contract_mismatch"]),
  cacheRows: z.array(z.record(z.string(), z.unknown())).max(1000),
  leadTrafficRows: z.array(z.record(z.string(), z.unknown())).max(1000), summary: z.record(z.string(), z.unknown()),
  diagnostics: z.array(diagnostic).max(1000) }).strict();
export const providerBatchArtifactSchema = z.object({ contractVersion: z.literal("provider-batch-result-v1"), runId,
  generation, source: z.enum(["dataforseo", "crux_bigquery"]), scopeKey: z.string().max(128), batchId: fingerprint,
  providerRequestFingerprint: z.string().min(1).max(128), items: z.array(batchItem).max(1000)
}).strict().superRefine((value, context) => {
  const shops = value.items.map((entry) => entry.shopId);
  if (new Set(shops).size !== shops.length || shops.some((shop, index) => index > 0 && shop <= shops[index - 1]))
    context.addIssue({ code: "custom", message: "item order" });
  if (value.source === "dataforseo" && value.items.some((entry) => !["available", "unavailable"].includes(entry.state)))
    context.addIssue({ code: "custom", message: "dataforseo state" });
  if (value.source === "crux_bigquery" && value.items.some((entry) => !["available", "no_coverage", "contract_mismatch"].includes(entry.state)))
    context.addIssue({ code: "custom", message: "bigquery state" });
  if (value.source === "dataforseo" && !/^[a-f0-9]{64}$/u.test(value.providerRequestFingerprint))
    context.addIssue({ code: "custom", message: "dataforseo request fingerprint" });
  if (value.source === "crux_bigquery" && !/^crux-[a-f0-9]{31}$/u.test(value.providerRequestFingerprint))
    context.addIssue({ code: "custom", message: "bigquery request id" });
  try {
    value.items.forEach((entry) => {
      entry.cacheRows.forEach((row, index) => trafficCacheRecordToUpsert(`cache_${index}`, row));
      entry.leadTrafficRows.forEach((row, index) => leadTrafficEnrichmentRecordToCreate(`traffic_${index}`, value.runId, `lead_${entry.shopId}`, row));
    });
  } catch { context.addIssue({ code: "custom", message: "batch rows" }); }
});

function parser(schema, mismatch = false) {
  return (value) => {
    const result = schema.safeParse(value);
    if (!result.success) throw mismatch ? new PipelineInvariantError("PIPELINE_INPUT_CONFLICT") :
      new PipelineContractError("PIPELINE_ARTIFACT_INVALID");
    return result.data;
  };
}
export const parseConfirmedQueryManifest = parser(confirmedQueryManifestSchema);
export const parseDomainCandidateArtifact = parser(domainCandidateArtifactSchema);
export const parseQueryDiscoveryArtifact = parser(queryDiscoveryArtifactSchema);
export const parseDomainManifest = parser(domainManifestSchema);
export const parseDomainWorkPlan = parser(domainWorkPlanSchema);
export const parseDomainStageManifest = parser(domainStageManifestSchema, true);
export const parseLeadResultArtifact = parser(leadResultArtifactSchema);
export const parseProviderSourceArtifact = parser(providerSourceArtifactSchema);
export const parseCombinedTrafficCruxResult = parser(combinedTrafficCruxResultSchema);
export const parseGoogleProbeAttemptArtifact = parser(googleProbeAttemptArtifactSchema);
export const parseGoogleProbeResultArtifact = parser(googleProbeResultArtifactSchema);
export const parseProviderBatchAttempt = parser(providerBatchAttemptSchema);
export const parseBrowserlessAttemptArtifact = parser(browserlessAttemptArtifactSchema);
export const parseAiNormalizationAttemptArtifact = parser(aiNormalizationAttemptArtifactSchema);
export const parseProviderSourceAttemptArtifact = parser(providerSourceAttemptArtifactSchema);
export const parseProviderBatchArtifact = parser(providerBatchArtifactSchema);
