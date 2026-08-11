import { z } from "zod";
import {
  parseRunStoreCandidate, parseShopLeadProfile, parseStableShopIdentity,
  runStoreCandidateSchema, shopLeadProfileSchema
} from "../../shop-persistence-contract.js";
import { leadRecordToCreate, leadTrafficEnrichmentRecordToCreate, trafficCacheRecordToUpsert } from
  "../../api-serializer.js";
import { PipelineContractError, PipelineInvariantError } from "./errors.js";
import { candidateArtifactKey, providerArtifactKey } from "../core/keys.js";

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
const query = z.object({ id, categoryIndex: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(),
  query: z.string().max(1000), source: z.string().max(128), validationState: z.string().max(128),
  queryScore: z.number().finite().nullable(), generationReason: text,
  sourceUrls: z.array(url).max(8), categoryVocabulary: z.array(z.string().max(200)).max(100),
  probeContractVersion: z.string().max(128), probeFingerprint: fingerprint,
  probeResults: z.array(z.unknown()).max(1000) }).strict();

export const confirmedQueryManifestSchema = z.object({ contractVersion: z.literal("confirmed-query-manifest-v1"),
  runId, generation, confirmedRevision: z.number().int().positive(), categories: z.array(category).max(1000),
  queries: z.array(query).max(1000) }).strict();

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
export const domainManifestSchema = z.object({ contractVersion: z.literal("domain-manifest-v1"), runId,
  generation, confirmedRevision: z.number().int().positive(),
  inputQueryArtifactFingerprints: z.array(fingerprint).max(1000),
  probeEvidence: z.object({ queryOrderIndependent: z.literal(true), mergedOccurrenceCount: z.number().int().nonnegative(),
    duplicateCount: z.number().int().nonnegative() }).strict(), domains: z.array(domain).max(1000) }).strict();

const sourceKey = z.object({ source: z.enum(["dataforseo", "crux_rest", "crux_bigquery"]), identity: z.string().max(2048),
  scopeKey: z.string().max(128), metricSetKey: z.string().max(500), contractVersion: z.string().max(128) }).strict();
const workDomain = z.object({ shopId: id, runStoreId: id, candidateKey: z.string().max(2048),
  needsLead: z.boolean(), needsTraffic: z.boolean(), needsCruxRest: z.boolean(), needsCruxBigQuery: z.boolean(),
  needsCrux: z.boolean(), sourceKeys: z.object({ dataForSeo: z.array(sourceKey).max(100), cruxRest: sourceKey,
    cruxBigQuery: sourceKey }).strict() }).strict().superRefine((value, context) => {
      if (value.needsCrux !== (value.needsCruxRest || value.needsCruxBigQuery)) context.addIssue({ code: "custom", message: "needs" });
    });
export const domainWorkPlanSchema = z.object({ contractVersion: z.literal("domain-work-plan-v1"), runId, generation,
  evaluatedAt: z.string().datetime(), domainManifestKey: z.string().max(2048), domains: z.array(workDomain).max(1000) }).strict()
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
  state: z.enum(["available", "no_coverage", "unavailable", "ambiguous", "contract_mismatch", "reused", "skipped"]),
  cacheRows: z.array(z.record(z.string(), z.unknown())).max(1000), leadTrafficRows: z.array(z.record(z.string(), z.unknown())).max(1000),
  summary: z.record(z.string(), z.unknown()), diagnostics: z.array(diagnostic).max(1000) }).strict().superRefine((value, context) => {
    try {
      value.cacheRows.forEach((row, index) => trafficCacheRecordToUpsert(`cache_${index}`, row));
      value.leadTrafficRows.forEach((row, index) => leadTrafficEnrichmentRecordToCreate(`traffic_${index}`, value.runId, `lead_${value.shopId}`, row));
    } catch { context.addIssue({ code: "custom", message: "traffic" }); }
  });

const component = z.object({ state: z.enum(["available", "no_coverage", "unavailable", "ambiguous", "contract_mismatch", "reused", "skipped"]),
  contractVersion: z.string().max(128), artifactKey: z.string().max(2048).optional() }).strict();
export const combinedTrafficCruxResultSchema = z.object({ contractVersion: z.literal("combined-traffic-crux-result-v1"),
  runId, generation, shopId: id, components: z.object({ dataforseo: component, cruxRest: component, cruxBigQuery: component }).strict()
}).strict().superRefine((value, context) => {
  const mapping = [["dataforseo", "dataforseo"], ["cruxRest", "crux-rest"], ["cruxBigQuery", "crux-bigquery"]];
  for (const [name, source] of mapping) {
    const part = value.components[name];
    const material = ["available", "no_coverage", "contract_mismatch"].includes(part.state);
    if ((material && part.artifactKey !== providerArtifactKey(value.runId, value.shopId, source)) || (!material && part.artifactKey)) {
      context.addIssue({ code: "custom", message: "component" });
    }
  }
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
export const parseQueryDiscoveryArtifact = parser(queryDiscoveryArtifactSchema);
export const parseDomainManifest = parser(domainManifestSchema);
export const parseDomainWorkPlan = parser(domainWorkPlanSchema);
export const parseDomainStageManifest = parser(domainStageManifestSchema, true);
export const parseLeadResultArtifact = parser(leadResultArtifactSchema);
export const parseProviderSourceArtifact = parser(providerSourceArtifactSchema);
export const parseCombinedTrafficCruxResult = parser(combinedTrafficCruxResultSchema);
