import { z } from "zod";

const marketSchema = z.strictObject({
  code: z.enum(["US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"]),
  name: z.string(),
  locationCode: z.number().int(),
  languageCode: z.string(),
  languageName: z.string(),
});

const marketTupleSchema = z.array(marketSchema).length(9);

const lanes = z.enum([
  "category_discovery",
  "store_discovery",
  "local_discovery",
  "brand_competitor",
]);

const monthlyHistorySchema = z.array(z.strictObject({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  searchVolume: z.number().int(),
}));

const marketMetricSchema = z.strictObject({
  countryCode: z.string(),
  locationCode: z.number().int(),
  locationName: z.string(),
  languageName: z.string(),
  searchVolume: z.number().int(),
  cpc: z.number().nullable(),
  competition: z.number().nullable(),
  competitionLevel: z.string().nullable(),
  keywordDifficulty: z.number().int().nullable(),
  mainIntent: z.string().nullable(),
  commercialIntent: z.number(),
  monthlyHistory: monthlyHistorySchema,
  trendSlope: z.number(),
  flags: z.array(z.string()),
  opportunityScore: z.number().int(),
  recommended: z.boolean(),
});

const facetsSchema = z.strictObject({
  audience: z.array(z.string()),
  category: z.array(z.string()),
  channel: z.array(z.string()),
  fit: z.array(z.string()),
  modifier: z.array(z.string()),
});

const keywordRowSchema = z.strictObject({
  itemId: z.string(),
  keyword: z.string(),
  seed: z.string(),
  sourceSeeds: z.array(z.string()),
  searchVolume: z.number().int(),
  cpc: z.number().nullable(),
  competition: z.number().nullable(),
  competitionLevel: z.string().nullable(),
  keywordDifficulty: z.number().int().nullable(),
  mainIntent: z.string().nullable(),
  commercialIntent: z.number(),
  monthlyHistory: monthlyHistorySchema,
  trendSlope: z.number(),
  cluster: z.string().nullable(),
  clusterId: z.string().nullable(),
  lane: lanes,
  facets: facetsSchema,
  variantGroupId: z.string().nullable(),
  variantCanonical: z.string().nullable(),
  flags: z.array(z.string()),
  opportunityScore: z.number().int().nullable(),
  recommended: z.boolean(),
  mergedInto: z.string().nullable(),
  availableMarkets: z.array(z.string()),
  marketMetrics: z.strictObject({
    US: marketMetricSchema.nullable(),
    GB: marketMetricSchema.nullable(),
    CA: marketMetricSchema.nullable(),
    AU: marketMetricSchema.nullable(),
    NZ: marketMetricSchema.nullable(),
    DE: marketMetricSchema.nullable(),
    FR: marketMetricSchema.nullable(),
    IN: marketMetricSchema.nullable(),
    AE: marketMetricSchema.nullable(),
  }),
});

const variantGroupSchema = z.strictObject({
  variantGroupId: z.string(),
  canonical: z.string(),
  variants: z.array(z.string()),
  volume: z.number().int(),
  sourceSeeds: z.array(z.string()),
});

const clusterRowSchema = z.strictObject({
  cluster: z.string(),
  clusterId: z.string(),
  keywords: z.array(z.string()),
  combinedVolume: z.number().int(),
  headlineVolume: z.number().int(),
  adjustedClusterVolume: z.number().int(),
  rawVariantVolume: z.number().int(),
  variantGroups: z.array(variantGroupSchema),
  sourceSeeds: z.array(z.string()),
  laneCounts: z.strictObject({
    category_discovery: z.number().int().positive().optional(),
    store_discovery: z.number().int().positive().optional(),
    local_discovery: z.number().int().positive().optional(),
    brand_competitor: z.number().int().positive().optional(),
  }),
  facets: facetsSchema,
  avgCpc: z.number(),
  commercialIntent: z.number(),
  trendScore: z.number(),
  opportunityScore: z.number().int(),
  recommendedForStoreDiscovery: z.boolean(),
});

const summarySchema = z.strictObject({
  schemaVersion: z.literal(3),
  markets: z.array(marketSchema),
  seeds: z.array(z.string()),
  rawItemsCollected: z.number().int(),
  itemsWithMetrics: z.number().int(),
  informationalDropped: z.number().int(),
  uniquePhrases: z.number().int(),
  dedupMerged: z.number().int(),
  activeKeywords: z.number().int(),
  variantGroups: z.number().int(),
  clusters: z.number().int(),
  recommendedKeywords: z.number().int(),
  recommendedClusters: z.number().int(),
});

const keywordResearchResultV1Schema = z.strictObject({
  contractVersion: z.literal(1),
  researchId: z.string(),
  generation: z.number().int(),
  configFingerprint: z.string(),
  seeds: z.array(z.string()),
  markets: marketTupleSchema,
  summary: summarySchema,
  keywords: z.array(keywordRowSchema),
  clusters: z.array(clusterRowSchema),
});

export {
  marketSchema,
  marketTupleSchema,
  marketMetricSchema,
  facetsSchema,
  keywordRowSchema,
  variantGroupSchema,
  clusterRowSchema,
  summarySchema,
  keywordResearchResultV1Schema,
  lanes,
};
