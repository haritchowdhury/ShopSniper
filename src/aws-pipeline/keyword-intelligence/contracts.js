import { z } from "zod";
import { PipelineInvariantError } from "../contracts/errors.js";
import { keywordResearchResultV1Schema } from "../../keyword-intelligence/schemas.js";

export class KeywordContractError extends Error {
  constructor(errorCode = "KEYWORD_INPUT_CONFLICT") {
    super(errorCode);
    this.name = "KeywordContractError";
    this.code = errorCode;
  }
}

export const KEYWORD_CONTRACT_VERSION = 1;
export const KEYWORD_MESSAGE_INITIALIZE = "keyword.initialize.v1";
export const KEYWORD_MESSAGE_EXPANSION_TASK = "keyword.expansion.task.v1";
export const KEYWORD_MESSAGE_OVERVIEW_TASK = "keyword.overview.task.v1";
export const KEYWORD_MESSAGE_AGGREGATE_CHECK = "keyword.aggregate.check.v1";
export const KEYWORD_STAGES = Object.freeze(["expansion", "anchor_screen", "market_overview"]);
export const KEYWORD_MARKET_CODES = Object.freeze(["US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"]);
export const KEYWORD_REMAINING_MARKET_CODES = Object.freeze(["GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"]);
export const KEYWORD_ENDPOINT_SUGGESTIONS = "keyword_suggestions";
export const KEYWORD_ENDPOINT_RELATED = "related_keywords";
export const KEYWORD_ENDPOINT_OVERVIEW = "keyword_overview";
export const KEYWORD_ENDPOINTS = Object.freeze([
  KEYWORD_ENDPOINT_SUGGESTIONS, KEYWORD_ENDPOINT_RELATED, KEYWORD_ENDPOINT_OVERVIEW
]);

export const KEYWORD_PROVIDER_REQUEST_INVALID = "KEYWORD_PROVIDER_REQUEST_INVALID";
export const KEYWORD_PROVIDER_AUTH_FAILED = "KEYWORD_PROVIDER_AUTH_FAILED";
export const KEYWORD_PROVIDER_RETRY_EXHAUSTED = "KEYWORD_PROVIDER_RETRY_EXHAUSTED";
export const KEYWORD_PROVIDER_RETRY_NOT_SCHEDULED = "KEYWORD_PROVIDER_RETRY_NOT_SCHEDULED";
export const KEYWORD_PROVIDER_TASK_FAILED = "KEYWORD_PROVIDER_TASK_FAILED";
export const KEYWORD_PROVIDER_CONTRACT_MISMATCH = "KEYWORD_PROVIDER_CONTRACT_MISMATCH";
export const KEYWORD_PROVIDER_AMBIGUOUS = "KEYWORD_PROVIDER_AMBIGUOUS";
export const KEYWORD_PROVIDER_BUDGET_EXHAUSTED = "KEYWORD_PROVIDER_BUDGET_EXHAUSTED";
export const KEYWORD_PROVIDER_THROTTLED = "KEYWORD_PROVIDER_THROTTLED";
export const KEYWORD_PROVIDER_RETRYABLE = "KEYWORD_PROVIDER_RETRYABLE";
export const KEYWORD_MESSAGE_CONTRACT_MISMATCH = "KEYWORD_MESSAGE_CONTRACT_MISMATCH";
export const KEYWORD_RUNTIME_CONFIG_INVALID = "KEYWORD_RUNTIME_CONFIG_INVALID";
export const KEYWORD_INPUT_CONFLICT = "KEYWORD_INPUT_CONFLICT";
export const KEYWORD_RESULT_TOO_LARGE = "KEYWORD_RESULT_TOO_LARGE";
export const KEYWORD_RESEARCH_STAGE_FAILED = "KEYWORD_RESEARCH_STAGE_FAILED";

export const KEYWORD_ARTIFACT_EXPANSION_RESULT = "keyword-expansion-result-v1";
export const KEYWORD_ARTIFACT_EXPANSION_MANIFEST = "keyword-expansion-manifest-v1";
export const KEYWORD_ARTIFACT_ANCHOR_RESULT = "keyword-anchor-screen-result-v1";
export const KEYWORD_ARTIFACT_SHORTLIST_MANIFEST = "keyword-shortlist-manifest-v1";
export const KEYWORD_ARTIFACT_MARKET_RESULT = "keyword-market-overview-result-v1";
export const KEYWORD_ARTIFACT_MARKET_MANIFEST = "keyword-market-overview-manifest-v1";
export const KEYWORD_ARTIFACT_RESEARCH_RESULT = "keyword-research-result-v1";

const researchId = z.string().regex(/^kr_[A-Za-z0-9_-]{1,128}$/u);
const generation = z.number().int().min(1).max(2147483647);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const taskNaturalId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const itemId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u);

const initializeMessageSchema = z.object({
  contractVersion: z.literal(KEYWORD_CONTRACT_VERSION),
  type: z.literal(KEYWORD_MESSAGE_INITIALIZE),
  researchId,
  generation
}).strict();

const expansionTaskMessageSchema = z.object({
  contractVersion: z.literal(KEYWORD_CONTRACT_VERSION),
  type: z.literal(KEYWORD_MESSAGE_EXPANSION_TASK),
  researchId,
  generation,
  stage: z.literal("expansion"),
  taskNaturalId,
  inputFingerprint: fingerprint
}).strict();

const overviewTaskMessageSchema = z.object({
  contractVersion: z.literal(KEYWORD_CONTRACT_VERSION),
  type: z.literal(KEYWORD_MESSAGE_OVERVIEW_TASK),
  researchId,
  generation,
  stage: z.enum(["anchor_screen", "market_overview"]),
  taskNaturalId,
  inputFingerprint: fingerprint
}).strict();

const aggregateCheckMessageSchema = z.object({
  contractVersion: z.literal(KEYWORD_CONTRACT_VERSION),
  type: z.literal(KEYWORD_MESSAGE_AGGREGATE_CHECK),
  researchId,
  generation,
  stage: z.enum(["expansion", "anchor_screen", "market_overview"]),
  stageInputFingerprint: fingerprint.optional()
}).strict();

export const keywordMessageSchema = z.discriminatedUnion("type", [
  initializeMessageSchema,
  expansionTaskMessageSchema,
  overviewTaskMessageSchema,
  aggregateCheckMessageSchema
]);

export function parseKeywordMessage(value) {
  const result = keywordMessageSchema.safeParse(value);
  if (!result.success) throw new KeywordContractError(KEYWORD_MESSAGE_CONTRACT_MISMATCH);
  return result.data;
}

export const suggestionRequestSchema = z.object({
  keyword: z.string().min(1).max(100),
  location_code: z.number().int(),
  language_code: z.string(),
  limit: z.literal(30)
}).strict();

export const relatedRequestSchema = z.object({
  keyword: z.string().min(1).max(100),
  location_code: z.number().int(),
  language_code: z.string(),
  limit: z.literal(30),
  depth: z.literal(2)
}).strict();

export const overviewRequestSchema = z.object({
  keywords: z.array(z.string().min(1).max(100)).min(1).max(700),
  location_code: z.number().int(),
  language_code: z.string()
}).strict();

const monthlySearchSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  search_volume: z.number()
});

const rawKeywordInfoSchema = z.object({
  search_volume: z.number().int().nullable(),
  cpc: z.number().nullable(),
  competition: z.number(),
  competition_level: z.enum(["LOW", "MEDIUM", "HIGH"])
});

const rawOverviewItemSchema = z.object({
  keyword: z.string().nullable(),
  keyword_info: rawKeywordInfoSchema,
  monthly_searches: z.array(monthlySearchSchema).min(15).max(102),
  keyword_properties: z.object({ keyword_difficulty: z.number().int().nullable() }),
  search_intent_info: z.object({
    main_intent: z.enum(["transactional", "commercial", "informational", "navigational"])
  })
});

export const rootEnvelopeSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: z.number().finite().nullable().optional(),
  tasks: z.array(z.unknown())
});

export const taskEnvelopeSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: z.number().finite().nullable().optional()
});

const suggestionsTaskSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: z.number().finite().nullable().optional(),
  result: z.array(z.object({ items: z.array(z.object({ keyword: z.string() })) }))
});

const relatedTaskSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: z.number().finite().nullable().optional(),
  result: z.array(z.object({
    items: z.array(z.object({
      keyword_data: z.object({ keyword: z.string() }),
      depth: z.number(),
      related_keywords: z.array(z.string())
    }))
  }))
});

const overviewTaskSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: z.number().finite().nullable().optional(),
  result: z.array(z.object({
    location_code: z.number().int(),
    language_code: z.string(),
    items: z.array(rawOverviewItemSchema)
  }))
});

export const endpointTaskSchema = Object.freeze({
  keyword_suggestions: suggestionsTaskSchema,
  related_keywords: relatedTaskSchema,
  keyword_overview: overviewTaskSchema
});

export const keywordMarketMetricSchema = z.object({
  keyword: z.string().min(1).max(100),
  keyword_info: z.object({
    search_volume: z.number().int().nullable(),
    cpc: z.number().nullable(),
    competition: z.number(),
    competition_level: z.enum(["LOW", "MEDIUM", "HIGH"]),
    monthly_searches: z.array(monthlySearchSchema).min(15).max(102)
  }).strict(),
  keyword_properties: z.object({ keyword_difficulty: z.number().int().nullable() }).strict(),
  search_intent_info: z.object({
    main_intent: z.enum(["transactional", "commercial", "informational", "navigational"])
  }).strict()
}).strict();

export const keywordListResultSchema = z.object({ keywords: z.array(z.string()) }).strict();
export const keywordMetricsResultSchema = z.object({ metrics: z.array(keywordMarketMetricSchema) }).strict();

const commonHeader = {
  researchId,
  generation,
  itemId,
  inputFingerprint: fingerprint,
  producedAt: z.string().datetime()
};

export const keywordExpansionResultSchema = z.object({
  contractVersion: z.literal(KEYWORD_ARTIFACT_EXPANSION_RESULT),
  stage: z.literal("expansion"),
  status: z.literal("succeeded"),
  costUsd: z.string().nullable(),
  normalized: keywordListResultSchema,
  ...commonHeader
}).strict();

export const keywordExpansionManifestSchema = z.object({
  contractVersion: z.literal(KEYWORD_ARTIFACT_EXPANSION_MANIFEST),
  stage: z.literal("expansion"),
  itemId: z.literal("manifest"),
  seeds: z.array(z.string().min(1).max(100)).min(1).max(5),
  bySeed: z.array(z.object({ seed: z.string().min(1).max(100), keywords: z.array(z.string().min(1).max(160)).max(60) }).strict()).max(5),
  candidates: z.array(z.object({ keyword: z.string().min(1).max(160), seeds: z.array(z.string().min(1).max(100)).min(1).max(5) }).strict()).min(1).max(300),
  ...commonHeader
}).strict().superRefine((value, context) => {
  if (value.bySeed.length !== value.seeds.length ||
      value.bySeed.some((entry, index) => entry.seed !== value.seeds[index])) {
    context.addIssue({ code: "custom", message: "bySeed set" });
  }
  if (new Set(value.bySeed.map((entry) => entry.seed)).size !== value.bySeed.length) {
    context.addIssue({ code: "custom", message: "bySeed duplicate" });
  }
  const seen = new Set();
  for (const candidate of value.candidates) {
    if (seen.has(candidate.keyword)) {
      context.addIssue({ code: "custom", message: "candidate duplicate" });
      break;
    }
    seen.add(candidate.keyword);
  }
});

export const keywordAnchorScreenResultSchema = z.object({
  contractVersion: z.literal(KEYWORD_ARTIFACT_ANCHOR_RESULT),
  stage: z.literal("anchor_screen"),
  status: z.literal("succeeded"),
  costUsd: z.string().nullable(),
  normalized: keywordMetricsResultSchema,
  ...commonHeader
}).strict();

export const keywordShortlistManifestSchema = z.object({
  contractVersion: z.literal(KEYWORD_ARTIFACT_SHORTLIST_MANIFEST),
  stage: z.literal("anchor_screen"),
  itemId: z.literal("manifest"),
  keywords: z.array(z.string().min(1).max(160)).min(1).max(200),
  ...commonHeader
}).strict().superRefine((value, context) => {
  if (new Set(value.keywords).size !== value.keywords.length) {
    context.addIssue({ code: "custom", message: "shortlist duplicate" });
  }
});

export const keywordMarketOverviewResultSchema = z.object({
  contractVersion: z.literal(KEYWORD_ARTIFACT_MARKET_RESULT),
  stage: z.literal("market_overview"),
  status: z.literal("succeeded"),
  costUsd: z.string().nullable(),
  normalized: keywordMetricsResultSchema,
  ...commonHeader
}).strict();

export const keywordMarketOverviewManifestSchema = z.object({
  contractVersion: z.literal(KEYWORD_ARTIFACT_MARKET_MANIFEST),
  stage: z.literal("market_overview"),
  itemId: z.literal("manifest"),
  overview: z.record(z.string(), z.array(keywordMarketMetricSchema)),
  ...commonHeader
}).strict();

const researchResultFields = keywordResearchResultV1Schema.omit({ contractVersion: true });
export const keywordResearchResultArtifactSchema = z.object({
  contractVersion: z.literal(KEYWORD_ARTIFACT_RESEARCH_RESULT),
  ...researchResultFields.shape
}).strict();

export function parser(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  return result.data;
}