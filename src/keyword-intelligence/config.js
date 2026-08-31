import { z } from "zod";

const marketConfigSchema = z.strictObject({
  code: z.string(),
  name: z.string(),
  locationCode: z.number().int(),
  languageCode: z.string(),
  languageName: z.string(),
});

const keywordResearchConfigV1Schema = z.strictObject({
  contractVersion: z.literal(1),
  schemaVersion: z.literal("keyword-research-config-v1"),
  markets: z.array(marketConfigSchema).length(9),
  expansionAnchor: marketConfigSchema,
  expansionPerSeedLimit: z.literal(60),
  screenCandidateLimit: z.literal(300),
  shortlistLimit: z.literal(200),
  overviewBatchLimit: z.literal(700),
  maxCostPerResearchUsd: z.literal("3.00000000"),
  api: z.strictObject({
    baseUrl: z.literal("https://api.dataforseo.com/v3"),
    timeoutSeconds: z.literal(120),
    rateLimit: z.strictObject({ requestsPerMinute: z.literal(30) }),
    retry: z.strictObject({
      maxAttempts: z.literal(4),
      backoffBaseSeconds: z.literal(2.0),
      backoffMaxSeconds: z.literal(60.0),
      retryableStatus: z.array(z.number().int()),
      retryableApiCodes: z.array(z.number().int()),
    }),
  }),
  search: z.strictObject({
    defaultMarket: z.literal("all"),
    locationName: z.literal("United States"),
    languageName: z.literal("English"),
  }),
  expansion: z.strictObject({
    enabled: z.literal(true),
    maxKeywordsPerSeed: z.literal(60),
    suggestionsLimit: z.literal(30),
    relatedLimit: z.literal(30),
    relatedDepth: z.literal(2),
  }),
  intent: z.strictObject({
    commercialLabels: z.array(z.enum(["transactional", "commercial"])),
    informationalLabels: z.array(z.literal("informational")),
    keepNavigational: z.literal(true),
    commercialModifiers: z.array(z.string()),
    informationalModifiers: z.array(z.string()),
  }),
  filters: z.strictObject({
    minVolumeKeep: z.literal(100),
    tooBroadMaxWords: z.literal(1),
    tooBroadMinVolume: z.literal(200000),
    decliningPeriods: z.literal(6),
    decliningSlopeThreshold: z.literal(-0.05),
  }),
  dedup: z.strictObject({
    stripTokens: z.array(z.string()),
    similarityThreshold: z.literal(0.88),
  }),
  clustering: z.strictObject({
    method: z.literal("jaccard"),
    similarityThreshold: z.literal(0.34),
    minClusterSize: z.literal(2),
    clusterLabelStrategy: z.literal("highest_volume"),
  }),
  scoring: z.strictObject({
    weights: z.strictObject({
      volume: z.literal(0.25),
      commercialIntent: z.literal(0.25),
      trend: z.literal(0.20),
      inverseDifficulty: z.literal(0.15),
      inverseCompetition: z.literal(0.10),
      cpc: z.literal(0.05),
    }),
    difficultyMax: z.literal(100),
    competitionMax: z.literal(1.0),
    volumeLogBase: z.literal(10),
    recommendThreshold: z.literal(55),
    clusterRecommendThreshold: z.literal(60),
  }),
});

const MARKET_TUPLE = [
  { code: "US", name: "United States", locationCode: 2840, languageCode: "en", languageName: "English" },
  { code: "GB", name: "United Kingdom", locationCode: 2826, languageCode: "en", languageName: "English" },
  { code: "CA", name: "Canada", locationCode: 2124, languageCode: "en", languageName: "English" },
  { code: "AU", name: "Australia", locationCode: 2036, languageCode: "en", languageName: "English" },
  { code: "NZ", name: "New Zealand", locationCode: 2554, languageCode: "en", languageName: "English" },
  { code: "DE", name: "Germany", locationCode: 2276, languageCode: "de", languageName: "German" },
  { code: "FR", name: "France", locationCode: 2250, languageCode: "fr", languageName: "French" },
  { code: "IN", name: "India", locationCode: 2356, languageCode: "en", languageName: "English" },
  { code: "AE", name: "United Arab Emirates", locationCode: 2784, languageCode: "en", languageName: "English" },
];

const KEYWORD_RESEARCH_CONFIG_V1 = Object.freeze({
  contractVersion: 1,
  schemaVersion: "keyword-research-config-v1",
  markets: MARKET_TUPLE,
  expansionAnchor: { code: "US", name: "United States", locationCode: 2840, languageCode: "en", languageName: "English" },
  expansionPerSeedLimit: 60,
  screenCandidateLimit: 300,
  shortlistLimit: 200,
  overviewBatchLimit: 700,
  maxCostPerResearchUsd: "3.00000000",
  api: {
    baseUrl: "https://api.dataforseo.com/v3",
    timeoutSeconds: 120,
    rateLimit: { requestsPerMinute: 30 },
    retry: {
      maxAttempts: 4,
      backoffBaseSeconds: 2.0,
      backoffMaxSeconds: 60.0,
      retryableStatus: [429, 500, 502, 503, 504],
      retryableApiCodes: [40601, 40602, 50001, 50002, 40107],
    },
  },
  search: { defaultMarket: "all", locationName: "United States", languageName: "English" },
  expansion: { enabled: true, maxKeywordsPerSeed: 60, suggestionsLimit: 30, relatedLimit: 30, relatedDepth: 2 },
  intent: {
    commercialLabels: ["transactional", "commercial"],
    informationalLabels: ["informational"],
    keepNavigational: true,
    commercialModifiers: [
      "buy", "best", "cheap", "deal", "sale", "discount", "review", "reviews",
      "price", "cost", "for sale", "online", "shop", "store", "order", "shipping",
      "premium", "professional", "pro", "top", "vs", "comparison", "near me",
    ],
    informationalModifiers: ["what is", "how to", "why", "history of", "wiki", "meaning", "definition", "rules", "reddit"],
  },
  filters: {
    minVolumeKeep: 100,
    tooBroadMaxWords: 1,
    tooBroadMinVolume: 200000,
    decliningPeriods: 6,
    decliningSlopeThreshold: -0.05,
  },
  dedup: {
    stripTokens: ["a", "an", "the", "for", "and", "of", "with", "to", "in", "on"],
    similarityThreshold: 0.88,
  },
  clustering: {
    method: "jaccard",
    similarityThreshold: 0.34,
    minClusterSize: 2,
    clusterLabelStrategy: "highest_volume",
  },
  scoring: {
    weights: {
      volume: 0.25,
      commercialIntent: 0.25,
      trend: 0.20,
      inverseDifficulty: 0.15,
      inverseCompetition: 0.10,
      cpc: 0.05,
    },
    difficultyMax: 100,
    competitionMax: 1.0,
    volumeLogBase: 10,
    recommendThreshold: 55,
    clusterRecommendThreshold: 60,
  },
});

export function keywordResearchConfigV1() {
  return KEYWORD_RESEARCH_CONFIG_V1;
}

export const LEAD_FINDING_LOCAL_PHRASES = Object.freeze([
  "near me", "close to me", "closest to me", "closest", "nearest", "nearby",
]);

export const LEAD_FINDING_STORE_TOKENS = Object.freeze([
  "shop", "shops", "store", "stores", "boutique", "boutiques",
  "outlet", "outlets", "retailer", "retailers",
]);

export const LEAD_FINDING_RETAILER_TOKENS = Object.freeze([
  "amazon", "walmart", "target", "ebay", "etsy", "aliexpress", "alibaba",
  "shein", "temu", "costco", "ikea", "bestbuy", "macys", "kohls",
  "nordstrom", "wayfair", "wish", "overstock", "rakuten", "flipkart",
  "homedepot", "lowes",
]);

export const LEAD_FINDING_CLUSTER_KEY_STRIP = Object.freeze([
  "buy", "buying", "bought", "order", "ordering", "purchase",
  "cheap", "cheapest", "affordable", "sale", "sales", "discount", "discounts",
  "deal", "deals", "clearance", "best", "top", "new", "arrivals", "arrival",
  "online", "price", "prices", "cost", "under", "review", "reviews", "vs",
  "comparison", "shopping", "retail", "shipping",
]);

const keywordResearchConfigV2Schema = z.strictObject({
  contractVersion: z.literal(2),
  schemaVersion: z.literal("keyword-research-config-v2"),
  markets: z.array(marketConfigSchema).length(9),
  expansionAnchor: marketConfigSchema,
  expansionPerSeedLimit: z.literal(60),
  screenCandidateLimit: z.literal(300),
  shortlistLimit: z.literal(200),
  overviewBatchLimit: z.literal(700),
  maxCostPerResearchUsd: z.literal("3.00000000"),
  api: keywordResearchConfigV1Schema.shape.api,
  search: keywordResearchConfigV1Schema.shape.search,
  expansion: keywordResearchConfigV1Schema.shape.expansion,
  intent: z.strictObject({
    commercialLabels: z.array(z.enum(["transactional", "commercial"])),
    informationalLabels: z.array(z.literal("informational")),
    keepNavigational: z.literal(true),
    commercialModifiers: z.array(z.string()),
    informationalModifiers: z.array(z.string()),
  }),
  filters: keywordResearchConfigV1Schema.shape.filters,
  dedup: keywordResearchConfigV1Schema.shape.dedup,
  classification: z.strictObject({
    localPhrases: z.array(z.string()),
    storeTokens: z.array(z.string()),
    retailerTokens: z.array(z.string()),
    clusterKeyStripTokens: z.array(z.string()),
  }),
  clustering: z.strictObject({
    method: z.literal("concept_key"),
    similarityThreshold: z.literal(0.8),
    minClusterSize: z.literal(1),
    clusterLabelStrategy: z.literal("representative_keyword"),
  }),
  scoring: z.strictObject({
    weights: z.strictObject({
      volume: z.literal(0.30),
      commercialIntent: z.literal(0.25),
      trend: z.literal(0.15),
      seedOverlap: z.literal(0.10),
      cpc: z.literal(0.20),
    }),
    difficultyMax: z.literal(100),
    competitionMax: z.literal(1.0),
    volumeLogBase: z.literal(10),
    volumeLogCap: z.literal(1_000_000),
    cpcCap: z.literal(20),
    clusterRecommendThreshold: z.literal(60),
  }),
});

const KEYWORD_RESEARCH_CONFIG_V2 = Object.freeze({
  ...KEYWORD_RESEARCH_CONFIG_V1,
  contractVersion: 2,
  schemaVersion: "keyword-research-config-v2",
  intent: {
    ...KEYWORD_RESEARCH_CONFIG_V1.intent,
    commercialModifiers: KEYWORD_RESEARCH_CONFIG_V1.intent.commercialModifiers.filter(
      (term) => term !== "near me",
    ),
  },
  classification: {
    localPhrases: [...LEAD_FINDING_LOCAL_PHRASES],
    storeTokens: [...LEAD_FINDING_STORE_TOKENS],
    retailerTokens: [...LEAD_FINDING_RETAILER_TOKENS],
    clusterKeyStripTokens: [...LEAD_FINDING_CLUSTER_KEY_STRIP],
  },
  clustering: {
    method: "concept_key",
    similarityThreshold: 0.8,
    minClusterSize: 1,
    clusterLabelStrategy: "representative_keyword",
  },
  scoring: {
    weights: {
      volume: 0.30,
      commercialIntent: 0.25,
      trend: 0.15,
      seedOverlap: 0.10,
      cpc: 0.20,
    },
    difficultyMax: 100,
    competitionMax: 1.0,
    volumeLogBase: 10,
    volumeLogCap: 1_000_000,
    cpcCap: 20,
    clusterRecommendThreshold: 60,
  },
});

export function keywordResearchConfigV2() {
  return KEYWORD_RESEARCH_CONFIG_V2;
}

export function isLeadFindingConfig(config) {
  return config?.schemaVersion === "keyword-research-config-v2";
}

export function parseKeywordResearchConfig(snapshot) {
  const v2 = keywordResearchConfigV2Schema.safeParse(snapshot);
  if (v2.success) return { ok: true, data: v2.data, version: 2 };
  const v1 = keywordResearchConfigV1Schema.safeParse(snapshot);
  if (v1.success) return { ok: true, data: v1.data, version: 1 };
  return { ok: false, data: null, version: null };
}

export {
  keywordResearchConfigV1Schema,
  keywordResearchConfigV2Schema,
  marketConfigSchema,
  MARKET_TUPLE,
  KEYWORD_RESEARCH_CONFIG_V1,
  KEYWORD_RESEARCH_CONFIG_V2,
};