import { z } from "zod";
import { PipelineInvariantError } from "./errors.js";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const timeout = z.number().int().min(1000).max(120000);
const httpsOrigin = z.string().max(2048).superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.pathname !== "/" || parsed.origin !== value) context.addIssue({ code: "custom", message: "origin" });
  } catch { context.addIssue({ code: "custom", message: "origin" }); }
});

export const awsProviderConfigSchema = z.object({
  version: z.literal("aws-provider-config-v1"),
  googleSearch: z.object({
    contractVersion: z.literal("google-custom-search-v1"), engineIdFingerprint: fingerprint,
    resultsPerQuery: z.number().int().min(1).max(10), requestTimeoutMs: timeout
  }).strict(),
  queryValidation: z.object({
    probeContractVersion: z.literal("google-probe-v2"),
    maxQueries: z.number().int().min(1).max(1000), generatedQueryCount: z.number().int().min(1).max(20),
    queryProbeFreshnessMs: z.number().int().min(60000).max(604800000),
    queryProbeConcurrency: z.number().int().min(1).max(10),
    minQueryResults: z.number().int().min(1).max(10),
    minQueryUniqueHosts: z.number().int().min(1).max(10),
    minQueryRelevantResults: z.number().int().min(1).max(10),
    minQueryRelevanceRatio: z.number().finite().min(0).max(1),
    minQueryBaseScore: z.number().finite().min(0).max(100)
  }).strict(),
  discoveryIdentity: z.object({ requestTimeoutMs: timeout, browserlessEnabled: z.literal(false) }).strict(),
  leadFetch: z.object({ requestTimeoutMs: timeout, maxPagesPerStore: z.literal(5), pageFetchConcurrency: z.literal(2) }).strict(),
  browserless: z.object({
    enabled: z.boolean(), origin: httpsOrigin,
    contractVersion: z.literal("browserless-domain-render-documents-v1"),
    primaryConfigured: z.boolean(), fallbackConfigured: z.boolean(),
    navigationTimeoutMs: z.literal(8000), requestTimeoutMs: z.literal(45000), clientAbortMs: z.literal(48000)
  }).strict(),
  aiNormalization: z.object({
    enabled: z.boolean(), contractVersion: z.literal("openai-chat-completions-shopify-lead-v1"),
    model: z.string().max(128), requestTimeoutMs: timeout
  }).strict(),
  trafficHttp: z.object({ requestTimeoutMs: timeout, cruxBigQueryProjectIdFingerprint: fingerprint.nullable() }).strict()
}).strict().superRefine((value, context) => {
  if (value.queryValidation.generatedQueryCount > value.queryValidation.maxQueries)
    context.addIssue({ code: "custom", message: "query count" });
  if (value.browserless.enabled && !value.browserless.primaryConfigured)
    context.addIssue({ code: "custom", message: "browserless primary" });
  if (value.aiNormalization.enabled && !value.aiNormalization.model)
    context.addIssue({ code: "custom", message: "ai model" });
});

export function parseAwsProviderConfig(value) {
  const result = awsProviderConfigSchema.safeParse(value);
  if (!result.success) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  return result.data;
}
