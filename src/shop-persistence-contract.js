import { createHash } from "node:crypto";
import { z } from "zod";
import { isMyShopifyHostname, normalizeHostname, parseHttpUrl } from "./url-security.js";

const FORBIDDEN_KEY = /(?:^|_)(?:authorization|cookie|credential|html|password|provider(?:body|response)|raw(?:body|html|response)|secret|token)(?:$|_)/iu;
const RAW_DOCUMENT = /<(?:!doctype|html|body|head|script|style|div|span|form|input|a|p|h[1-6])\b/iu;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const finiteScore = z.number().finite().min(0).max(100);
const optionalText = z.string().max(4000);
const optionalUrl = z.string().max(2048).refine((value) => {
  if (!value) return true;
  try {
    const parsed = parseHttpUrl(value);
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "URL must be an HTTP(S) URL without credentials");
const hostname = z.string().max(253).refine(
  (value) => HOSTNAME.test(value) && normalizeHostname(value) === value &&
    value.includes(".") && value !== "myshopify.com",
  "Hostname must be normalized lower-case ASCII"
);
const nullableHostname = z.union([hostname, z.literal("")]);

function inspectSafeJson(value, path = "$") {
  if (typeof value === "string") {
    if (RAW_DOCUMENT.test(value)) throw new Error(`Raw document content is forbidden at ${path}`);
    return;
  }
  if (value == null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error(`Persisted array is too large at ${path}`);
    value.forEach((item, index) => inspectSafeJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`Persisted JSON value is invalid at ${path}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`Sensitive or raw field is forbidden at ${path}.${key}`);
    inspectSafeJson(child, `${path}.${key}`);
  }
}

const safeJson = z.unknown().superRefine((value, context) => {
  try {
    inspectSafeJson(value);
    JSON.stringify(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error.message });
  }
});

const categoryIntent = z.object({
  originalShopType: z.string().max(200),
  shopType: z.string().min(1).max(200),
  businessQualifier: z.string().min(1).max(100),
  categoryVocabulary: z.array(z.string().min(1).max(200)).max(100).default([])
}).strict();

const occurrence = z.object({
  categoryIntent,
  originalShopType: z.string().max(200),
  shopType: z.string().max(200),
  businessQualifier: z.string().max(100),
  query: z.string().max(1000),
  queryScore: z.number().finite().nullable(),
  queryGenerationReason: z.string().max(4000),
  querySourceUrls: z.array(optionalUrl).max(8),
  categoryVocabulary: z.array(z.string().min(1).max(200)).max(100),
  rank: z.number().int().positive().nullable(),
  resultUrl: optionalUrl,
  finalUrl: optionalUrl,
  resolvedDomain: nullableHostname,
  myshopifyDomain: nullableHostname
}).strict();

const identityEvidence = z.object({
  stableHostname: hostname,
  displayHostname: nullableHostname,
  observedHostnames: z.array(hostname).min(1).max(20),
  canonical: z.object({
    url: optionalUrl,
    hostname: nullableHostname,
    trusted: z.boolean(),
    reason: z.string().min(1).max(200)
  }).strict(),
  method: z.enum(["observed_myshopify_host", "observed_redirect_host", "directly_fetched_host"]),
  confidence: finiteScore,
  mergedOccurrenceCount: z.number().int().positive().optional()
}).strict();

const assessment = z.object({
  intent: categoryIntent,
  valid: z.boolean(),
  accepted: z.boolean(),
  shopifyConfidence: finiteScore,
  relevanceScore: finiteScore,
  rejectionReason: z.string().max(200),
  storeFit: safeJson
}).strict();

export const runStoreCandidateSchema = z.object({
  contractVersion: z.literal("run-store-candidate-v1"),
  representative: z.object({
    query: z.string().max(1000),
    rank: z.number().int().positive().nullable(),
    resultUrl: optionalUrl,
    queryScore: z.number().finite().nullable(),
    queryGenerationReason: z.string().max(4000),
    querySourceUrls: z.array(optionalUrl).max(8)
  }).strict(),
  originalShopType: z.string().max(200),
  shopType: z.string().max(200),
  businessQualifier: z.string().max(100),
  categoryVocabulary: z.array(z.string().min(1).max(200)).max(100),
  categoryIntents: z.array(categoryIntent).min(1).max(100),
  finalUrl: optionalUrl,
  canonicalUrl: optionalUrl,
  myshopifyDomain: nullableHostname,
  resolvedDomain: nullableHostname,
  stableIdentity: hostname,
  allowedHostnames: z.array(hostname).min(1).max(20),
  identityConfidence: finiteScore,
  identityEvidence,
  occurrences: z.array(occurrence).min(1).max(1000),
  duplicateCount: z.number().int().nonnegative(),
  assessments: z.array(assessment).max(100)
}).strict();

export const shopLeadProfileSchema = z.object({
  contractVersion: z.literal("shop-lead-profile-v1"),
  storeName: optionalText,
  email: z.string().max(320),
  emailSourceUrl: optionalUrl,
  phone: z.string().max(100),
  phoneSourceUrl: optionalUrl,
  contactUrl: optionalUrl,
  socialProfiles: z.array(optionalUrl).max(30),
  contactabilityTier: z.enum(["direct", "indirect", "research_only", "none"]),
  contactEvidence: safeJson.nullable(),
  identityConfidence: finiteScore,
  identityEvidence,
  categoryAssessments: z.array(z.object({
    intent: categoryIntent,
    shopifyConfidence: finiteScore,
    relevanceScore: finiteScore,
    storeFitState: z.string().max(100),
    storeFitEvidence: safeJson.nullable(),
    accepted: z.boolean()
  }).strict()).max(100),
  pageDiagnostics: z.object({
    pagesExamined: z.number().int().nonnegative().max(100),
    pageErrorTypes: z.array(z.string().max(200)).max(100),
    aiErrorType: z.string().max(100)
  }).strict()
}).strict();

function uniqueSorted(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => normalizeHostname(String(value))))]
    .sort();
}

function normalizedIntent(value) {
  return categoryIntent.parse({
    originalShopType: value?.originalShopType || "",
    shopType: value?.shopType || "",
    businessQualifier: value?.businessQualifier || "unspecified",
    categoryVocabulary: [...new Set(value?.categoryVocabulary || [])].sort()
  });
}

export function stableShopIdentity(candidate) {
  const evidence = identityEvidence.parse(candidate?.identityEvidence);
  const observed = new Set(evidence.observedHostnames);
  const myshopify = candidate.myshopifyDomain
    ? hostname.parse(normalizeHostname(candidate.myshopifyDomain))
    : "";
  const stable = hostname.parse(normalizeHostname(evidence.stableHostname));
  const resolved = candidate.resolvedDomain
    ? hostname.parse(normalizeHostname(candidate.resolvedDomain))
    : "";
  let stableKey = "";
  if (myshopify && isMyShopifyHostname(myshopify) && observed.has(myshopify)) {
    stableKey = myshopify;
  } else if (observed.has(stable)) {
    stableKey = stable;
  } else if (resolved && observed.has(resolved)) {
    stableKey = resolved;
  }
  if (!stableKey) throw new Error("A verified stable shop identity is required");
  return {
    stableKey,
    myshopifyDomain: myshopify || null,
    resolvedDomain: resolved || null,
    canonicalUrl: candidate.canonicalUrl || null,
    identityConfidence: evidence.confidence,
    identityEvidence: evidence
  };
}

export function parseStableShopIdentity(value) {
  const parsed = z.object({
    stableKey: hostname,
    myshopifyDomain: hostname.nullable(),
    resolvedDomain: hostname.nullable(),
    canonicalUrl: optionalUrl.nullable(),
    identityConfidence: finiteScore,
    identityEvidence
  }).strict().parse(value);
  if (!parsed.identityEvidence.observedHostnames.includes(parsed.stableKey)) {
    throw new Error("Stable shop key is not backed by observed identity evidence");
  }
  if (parsed.myshopifyDomain &&
      (!isMyShopifyHostname(parsed.myshopifyDomain) ||
       !parsed.identityEvidence.observedHostnames.includes(parsed.myshopifyDomain))) {
    throw new Error("MyShopify identity is not backed by observed evidence");
  }
  return parsed;
}

export function trafficProviderIdentities(value) {
  const identity = parseStableShopIdentity(value);
  const hostname = identity.resolvedDomain || identity.stableKey;
  let origin = null;
  if (identity.canonicalUrl) {
    const canonical = new URL(identity.canonicalUrl);
    if (canonical.protocol === "https:") origin = canonical.origin;
  }
  return Object.freeze({ hostname, origin: origin || `https://${hostname}` });
}

export function runStoreCandidateFromDiscovery(candidate, assessments = []) {
  const intents = candidate.categoryIntents?.length
    ? candidate.categoryIntents
    : [candidate.categoryIntent || candidate];
  const payload = {
    contractVersion: "run-store-candidate-v1",
    representative: {
      query: candidate.query || "",
      rank: Number.isInteger(candidate.rank) ? candidate.rank : null,
      resultUrl: candidate.url || "",
      queryScore: Number.isFinite(Number(candidate.queryScore)) ? Number(candidate.queryScore) : null,
      queryGenerationReason: candidate.queryGenerationReason || "",
      querySourceUrls: [...new Set(candidate.querySourceUrls || [])].sort().slice(0, 8)
    },
    originalShopType: candidate.originalShopType || "",
    shopType: candidate.shopType || "",
    businessQualifier: candidate.businessQualifier || "unspecified",
    categoryVocabulary: [...new Set(candidate.categoryVocabulary || [])].sort(),
    categoryIntents: intents.map(normalizedIntent),
    finalUrl: candidate.finalUrl || "",
    canonicalUrl: candidate.canonicalUrl || "",
    myshopifyDomain: candidate.myshopifyDomain
      ? normalizeHostname(candidate.myshopifyDomain)
      : "",
    resolvedDomain: candidate.resolvedDomain
      ? normalizeHostname(candidate.resolvedDomain)
      : "",
    stableIdentity: normalizeHostname(candidate.stableIdentity),
    allowedHostnames: uniqueSorted(candidate.allowedHostnames),
    identityConfidence: Number(candidate.identityConfidence || 0),
    identityEvidence: candidate.identityEvidence,
    occurrences: candidate.occurrences || [],
    duplicateCount: Number(candidate.duplicateCount || 0),
    assessments
  };
  return runStoreCandidateSchema.parse(payload);
}

export function parseRunStoreCandidate(value) {
  return runStoreCandidateSchema.parse(value);
}

export function parseShopLeadProfile(value) {
  return shopLeadProfileSchema.parse(value);
}

export function assertRunStoreIdentityPair(identityValue, candidateValue) {
  const identity = parseStableShopIdentity(identityValue);
  const candidate = parseRunStoreCandidate(candidateValue);
  if (identity.stableKey !== candidate.stableIdentity ||
      identity.stableKey !== candidate.identityEvidence.stableHostname ||
      (identity.myshopifyDomain || "") !== candidate.myshopifyDomain) {
    throw new Error("Run-store payload identity does not match its verified shop identity");
  }
  return { identity, candidatePayload: candidate };
}

export function assertProfileMatchesShop(profileValue, stableKey) {
  const profile = parseShopLeadProfile(profileValue);
  if (profile.identityEvidence.stableHostname !== stableKey) {
    throw new Error("Shop profile identity does not match its durable shop");
  }
  return profile;
}

export function assertLeadMatchesShop(lead, stableKey) {
  const leadStableKey = lead?.identity_evidence?.stableHostname || lead?.resolved_domain;
  if (leadStableKey !== stableKey) {
    throw new Error("Lead identity does not match its durable shop");
  }
  return lead;
}

export function shopIdForStableKey(stableKey) {
  const digest = createHash("sha256").update(hostname.parse(stableKey)).digest("base64url").slice(0, 24);
  return `shop_${digest}`;
}

export function runStoreId(runId, shopId) {
  const digest = createHash("sha256").update(`${runId}:${shopId}`).digest("base64url").slice(0, 24);
  return `run_store_${digest}`;
}

export function shopWorkId(shopId, workType, scopeKey) {
  const digest = createHash("sha256").update(`${shopId}:${workType}:${scopeKey}`).digest("base64url").slice(0, 24);
  return `shop_work_${digest}`;
}
