import { readCategories, toCategoryIntent } from "./category-input.js";
import {
  generateInitialCandidates,
  generateRepairs
} from "./query-generator.js";
import { probeCandidates } from "./query-prober.js";
import { selectDiverseQueries } from "./query-ranker.js";
import { validateCandidates } from "./query-validator.js";
import { QueryProbeCache } from "./query-cache.js";
import { writeQueryAudit } from "./query-audit.js";
import { log } from "./logger.js";

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function blankAudit(shopType, overrides = {}) {
  return {
    original_shop_type: "",
    shop_type: shopType,
    query: "",
    query_score: "",
    raw_results: "",
    relevant_results: "",
    relevance_ratio: "",
    unique_hosts: "",
    duplicate_products: "",
    estimated_results: "",
    next_page_available: "",
    market_signal: "",
    seasonality: "",
    query_generation_reason: "",
    source_urls: [],
    category_vocabulary: [],
    status: "",
    rejection_reason: "",
    business_qualifier: "",
    ...overrides
  };
}

function rejectedCandidateAudit(category, rejected, categoryVocabulary) {
  const candidate = rejected.candidate || {};
  return blankAudit(category.shopType, {
    original_shop_type: category.originalShopType,
    query: rejected.query || candidate.query || "",
    market_signal: candidate.market_signal || "",
    seasonality: candidate.seasonality || "",
    query_generation_reason: candidate.query_generation_reason || "",
    source_urls: candidate.source_urls || [],
    category_vocabulary: categoryVocabulary,
    business_qualifier: category.businessQualifier || "unspecified",
    status: "rejected",
    rejection_reason: rejected.rejectionReason
  });
}

function probeAudit(
  category,
  probe,
  selectedScores,
  categoryVocabulary,
  selectionRejections = new Map()
) {
  const candidate = probe.candidate;
  const selectedScore = selectedScores.get(candidate.query);
  return blankAudit(category.shopType, {
    original_shop_type: category.originalShopType,
    query: candidate.query,
    query_score: selectedScore ?? probe.baseScore,
    raw_results: probe.rawResults,
    relevant_results: probe.relevantResults,
    relevance_ratio: probe.relevantRatio,
    unique_hosts: probe.uniqueHosts.length,
    duplicate_products: probe.duplicateProducts,
    estimated_results: probe.estimatedTotalResults,
    next_page_available: probe.nextPageAvailable,
    market_signal: candidate.market_signal,
    seasonality: candidate.seasonality,
    query_generation_reason: candidate.query_generation_reason,
    source_urls: candidate.source_urls,
    category_vocabulary: categoryVocabulary,
    business_qualifier: category.businessQualifier || "unspecified",
    status: selectedScore == null ? "rejected" : "selected",
    rejection_reason:
      selectedScore == null
        ? probe.rejectionReason ||
          selectionRejections.get(candidate.query) ||
          "not_selected"
        : ""
  });
}

function repairBatchSize(shortfall) {
  return Math.min(20, Math.max(8, shortfall * 2));
}

function rejectionCounts(audits) {
  const counts = {};
  for (const audit of audits) {
    const reason = audit.rejection_reason;
    if (reason) counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

async function planCategory(category, config, status, dependencies, cache, seenQueries) {
  const target = config.generatedQueryCount;
  const maxProbes = config.maxQueryProbesPerCategory ?? 80;
  status.stage = "researching_category";
  let generated;
  try {
    generated = await dependencies.generateInitial(category, config, dependencies);
  } catch (error) {
    status.failures += 1;
    log("category_generation_failed", { shopType: category.shopType, error });
    return {
      complete: false,
      selected: [],
      audits: [
        blankAudit(category.shopType, {
          original_shop_type: category.originalShopType,
          business_qualifier: category.businessQualifier || "unspecified",
          status: "failed",
          rejection_reason: "candidate_generation_failed",
          query_generation_reason: messageOf(error)
        })
      ],
      shortfall: {
        shopType: category.shopType,
        originalShopType: category.originalShopType,
        businessQualifier: category.businessQualifier || "unspecified",
        target,
        selected: 0,
        generated: 0,
        probed: 0,
        cacheHits: 0,
        repairRounds: 0,
        rejectionCounts: { candidate_generation_failed: 1 },
        budgetExhausted: false
      }
    };
  }

  if (generated.mode === "fallback") {
    status.planningWarnings += 1;
    log("category_generation_fallback", {
      shopType: category.shopType,
      reason: generated.error
    });
  }

  status.stage = "generating_candidates";
  status.queryCandidatesGenerated += generated.candidates.length;
  let candidatesGenerated = generated.candidates.length;
  status.stage = "validating_candidates";
  const categoryVocabulary = [
    ...(generated.research.concrete_products || []),
    ...(generated.research.growing_products || []),
    ...(generated.research.evergreen_products || []),
    ...(generated.research.product_title_terms || [])
  ];
  let validated = validateCandidates(generated.candidates, category.shopType, {
    seenQueries,
    categoryVocabulary
  });
  status.queryCandidatesValidated += validated.accepted.length;
  const rejectedAudits = validated.rejected.map((rejected) =>
    rejectedCandidateAudit(category, rejected, categoryVocabulary)
  );
  const pendingCandidates = [...validated.accepted];
  const allProbes = [];
  let providerProbes = 0;
  let cacheHits = 0;
  let repairRound = 0;
  let noProgressRounds = 0;

  async function probeBatch(candidates) {
    if (!candidates.length) return [];
    let callbackEvents = 0;
    let uniqueProviderCalls = 0;
    status.stage = "probing_queries";
    const probes = await dependencies.probe(candidates, config, {
      searchPage: dependencies.searchPage,
      cache,
      onProbed: (_probe, cacheHit) => {
        callbackEvents += 1;
        status.queryCandidatesProbed += 1;
        if (cacheHit) {
          cacheHits += 1;
          status.queryProbeCacheHits += 1;
        } else {
          uniqueProviderCalls += 1;
        }
      }
    });
    // Test doubles and alternate probe adapters may not emit callbacks. Treat
    // their returned rows conservatively as provider calls for budget accounting.
    if (callbackEvents === 0) {
      uniqueProviderCalls = probes.length;
      status.queryCandidatesProbed += probes.length;
    }
    providerProbes += uniqueProviderCalls;
    allProbes.push(...probes);
    return probes;
  }

  function rankedNow() {
    return dependencies.select(allProbes, target);
  }

  while (pendingCandidates.length && providerProbes < maxProbes) {
    const selectedCount = rankedNow().selected.length;
    if (selectedCount >= target) break;
    const batchSize = Math.min(
      pendingCandidates.length,
      repairBatchSize(target - selectedCount),
      maxProbes - providerProbes
    );
    await probeBatch(pendingCandidates.splice(0, batchSize));
  }

  let currentSelectedCount = rankedNow().selected.length;
  while (
    currentSelectedCount < target &&
    repairRound < config.queryRepairRounds &&
    providerProbes < maxProbes &&
    noProgressRounds < 2
  ) {
    repairRound += 1;
    status.queryRepairRounds += 1;
    const failed = [
      ...rejectedAudits.map((item) => ({
        query: item.query || "",
        reason: item.rejection_reason
      })),
      ...allProbes
        .filter((probe) => probe.rejectionReason)
        .map((probe) => ({
          query: probe.candidate.query,
          reason: probe.rejectionReason
        }))
    ];
    const requested = repairBatchSize(target - currentSelectedCount);

    let repairs;
    try {
      status.stage = "generating_candidates";
      repairs = await dependencies.generateRepairs(
        category,
        generated.research,
        failed,
        [...seenQueries],
        requested,
        config,
        dependencies
      );
    } catch (error) {
      status.planningWarnings += 1;
      log("query_repair_failed", {
        shopType: category.shopType,
        repairRound,
        error
      });
      break;
    }

    status.queryCandidatesGenerated += repairs.length;
    candidatesGenerated += repairs.length;
    status.stage = "validating_candidates";
    validated = validateCandidates(repairs, category.shopType, {
      seenQueries,
      categoryVocabulary
    });
    status.queryCandidatesValidated += validated.accepted.length;
    rejectedAudits.push(
      ...validated.rejected.map((rejected) =>
        rejectedCandidateAudit(category, rejected, categoryVocabulary)
      )
    );
    const availableBudget = maxProbes - providerProbes;
    const toProbe = validated.accepted.slice(0, availableBudget);
    const unprobed = validated.accepted.slice(availableBudget);
    rejectedAudits.push(
      ...unprobed.map((candidate) => rejectedCandidateAudit(category, {
        candidate,
        query: candidate.query,
        rejectionReason: "probe_budget_exhausted"
      }, categoryVocabulary))
    );
    await probeBatch(toProbe);
    const nextSelectedCount = rankedNow().selected.length;
    noProgressRounds = nextSelectedCount > currentSelectedCount
      ? 0
      : noProgressRounds + 1;
    currentSelectedCount = nextSelectedCount;
  }

  if (pendingCandidates.length) {
    const pendingReason = rankedNow().selected.length >= target
      ? "not_probed_target_satisfied"
      : "probe_budget_exhausted";
    rejectedAudits.push(
      ...pendingCandidates.map((candidate) => rejectedCandidateAudit(category, {
        candidate,
        query: candidate.query,
        rejectionReason: pendingReason
      }, categoryVocabulary))
    );
  }

  status.stage = "selecting_queries";
  const ranked = rankedNow();
  const selectedScores = new Map(
    ranked.selected.map((probe) => [probe.candidate.query, probe.queryScore])
  );
  const selected = ranked.selected.map((probe) => ({
    ...toCategoryIntent(category),
    categoryIntent: toCategoryIntent(category),
    categoryVocabulary,
    query: probe.candidate.query,
    queryScore: probe.queryScore,
    queryGenerationReason: probe.candidate.query_generation_reason,
    querySourceUrls: probe.candidate.source_urls || [],
    results: probe.results
  }));
  status.queriesSelected += selected.length;
  const complete = selected.length === target;
  if (!complete) status.planningWarnings += 1;

  const audits = [
    ...rejectedAudits,
    ...allProbes.map((probe) =>
      probeAudit(
        category,
        probe,
        selectedScores,
        categoryVocabulary,
        ranked.selectionRejections
      )
    )
  ];
  const shortfall = complete ? null : {
    shopType: category.shopType,
    originalShopType: category.originalShopType,
    businessQualifier: category.businessQualifier || "unspecified",
    target,
    selected: selected.length,
    generated: candidatesGenerated,
    probed: providerProbes,
    cacheHits,
    repairRounds: repairRound,
    rejectionCounts: rejectionCounts(audits),
    budgetExhausted: providerProbes >= maxProbes
  };

  log("query_category_planned", {
    shopType: category.shopType,
    businessQualifier: category.businessQualifier || "unspecified",
    candidatesGenerated,
    candidatesProbed: providerProbes,
    cacheHits,
    repairRounds: repairRound,
    acceptedCount: selected.length,
    rejectionCounts: rejectionCounts(audits),
    complete
  });

  return {
    complete,
    selected,
    audits,
    shortfall
  };
}

const DEFAULT_DEPENDENCIES = {
  readCategories,
  generateInitial: generateInitialCandidates,
  generateRepairs,
  probe: probeCandidates,
  select: selectDiverseQueries,
  writeAudit: writeQueryAudit
};

export async function planGeneratedQueries(
  config,
  status,
  dependencyOverrides = {}
) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  status.stage = "reading_categories";
  const manualCategories = dependencyOverrides.categories;
  const input = manualCategories
    ? { categories: manualCategories, invalid: [], blanksSkipped: 0 }
    : await dependencies.readCategories(config.inputCsv, config.maxShopTypes);
  status.shopTypesTotal = input.categories.length;
  status.blankShopTypesSkipped = input.blanksSkipped;

  const audits = input.invalid.map((invalid) =>
    blankAudit("", {
      original_shop_type: invalid.originalShopType,
      status: "rejected",
      rejection_reason: `invalid_shop_type_row_${invalid.row}: ${invalid.error}`
    })
  );
  status.invalidShopTypes = input.invalid.length;
  const selected = [];
  const shortfalls = [];
  const cache = new QueryProbeCache();

  for (const category of input.categories) {
    // Query uniqueness is category-intent scoped. The shared probe cache still
    // prevents a repeated Google call when brand/retailer/unspecified variants
    // generate the same product query.
    const seenQueries = new Set();
    const result = await planCategory(
      category,
      config,
      status,
      dependencies,
      cache,
      seenQueries
    );
    selected.push(...result.selected);
    audits.push(...result.audits);
    if (!result.complete && result.shortfall) {
      shortfalls.push({
        categoryIndex: input.categories.indexOf(category),
        ...result.shortfall
      });
    }
    status.shopTypesProcessed += 1;
  }

  if (!manualCategories && dependencyOverrides.writeAudit !== false) {
    await dependencies.writeAudit(config.generatedQueriesCsv, audits);
  }
  status.queriesTotal = selected.length;
  const complete = shortfalls.length === 0 &&
    selected.length === input.categories.length * config.generatedQueryCount;
  return {
    complete,
    selected: complete ? selected : [],
    audits,
    shortfalls,
    categoryCount: input.categories.length,
    blanksSkipped: input.blanksSkipped,
    invalidShopTypes: input.invalid.length,
    probeCacheSize: cache.size
  };
}
