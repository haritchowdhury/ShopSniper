import { readCategories } from "./category-input.js";
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
    shop_type: shopType,
    query: "",
    query_score: "",
    raw_results: "",
    relevant_results: "",
    unique_hosts: "",
    duplicate_products: "",
    estimated_results: "",
    next_page_available: "",
    market_signal: "",
    seasonality: "",
    query_generation_reason: "",
    source_urls: [],
    status: "",
    rejection_reason: "",
    ...overrides
  };
}

function rejectedCandidateAudit(shopType, rejected) {
  const candidate = rejected.candidate || {};
  return blankAudit(shopType, {
    query: rejected.query || candidate.query || "",
    market_signal: candidate.market_signal || "",
    seasonality: candidate.seasonality || "",
    query_generation_reason: candidate.query_generation_reason || "",
    source_urls: candidate.source_urls || [],
    status: "rejected",
    rejection_reason: rejected.rejectionReason
  });
}

function probeAudit(shopType, probe, selectedScores) {
  const candidate = probe.candidate;
  const selectedScore = selectedScores.get(candidate.query);
  return blankAudit(shopType, {
    query: candidate.query,
    query_score: selectedScore ?? probe.baseScore,
    raw_results: probe.rawResults,
    relevant_results: probe.relevantResults,
    unique_hosts: probe.uniqueHosts.length,
    duplicate_products: probe.duplicateProducts,
    estimated_results: probe.estimatedTotalResults,
    next_page_available: probe.nextPageAvailable,
    market_signal: candidate.market_signal,
    seasonality: candidate.seasonality,
    query_generation_reason: candidate.query_generation_reason,
    source_urls: candidate.source_urls,
    status: selectedScore == null ? "rejected" : "selected",
    rejection_reason:
      selectedScore == null ? probe.rejectionReason || "not_selected" : ""
  });
}

async function planCategory(category, config, status, dependencies, cache, seenQueries) {
  status.stage = "researching_category";
  let generated;
  try {
    generated = await dependencies.generateInitial(category, config, dependencies);
  } catch (error) {
    status.failures += 1;
    log("category_generation_failed", { shopType: category.shopType, error });
    return {
      selected: [],
      audits: [
        blankAudit(category.shopType, {
          status: "failed",
          rejection_reason: "candidate_generation_failed",
          query_generation_reason: messageOf(error)
        })
      ]
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
    rejectedCandidateAudit(category.shopType, rejected)
  );

  status.stage = "probing_queries";
  const allProbes = await dependencies.probe(validated.accepted, config, {
    searchPage: dependencies.searchPage,
    cache,
    onProbed: () => {
      status.queryCandidatesProbed += 1;
    }
  });

  let repairRound = 0;
  while (
    allProbes.filter((probe) => !probe.rejectionReason).length <
      config.generatedQueryCount &&
    repairRound < config.queryRepairRounds
  ) {
    repairRound += 1;
    const failed = [
      ...validated.rejected.map((item) => ({
        query: item.candidate?.query || "",
        reason: item.rejectionReason
      })),
      ...allProbes
        .filter((probe) => probe.rejectionReason)
        .map((probe) => ({
          query: probe.candidate.query,
          reason: probe.rejectionReason
        }))
    ];
    const requested = Math.min(
      20,
      Math.max(
        5,
        config.generatedQueryCount -
          allProbes.filter((probe) => !probe.rejectionReason).length +
          3
      )
    );

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
    status.stage = "validating_candidates";
    validated = validateCandidates(repairs, category.shopType, {
      seenQueries,
      categoryVocabulary
    });
    status.queryCandidatesValidated += validated.accepted.length;
    rejectedAudits.push(
      ...validated.rejected.map((rejected) =>
        rejectedCandidateAudit(category.shopType, rejected)
      )
    );
    status.stage = "probing_queries";
    allProbes.push(
      ...(await dependencies.probe(validated.accepted, config, {
        searchPage: dependencies.searchPage,
        cache,
        onProbed: () => {
          status.queryCandidatesProbed += 1;
        }
      }))
    );
  }

  status.stage = "selecting_queries";
  const ranked = dependencies.select(allProbes, config.generatedQueryCount);
  const selectedScores = new Map(
    ranked.selected.map((probe) => [probe.candidate.query, probe.queryScore])
  );
  const selected = ranked.selected.map((probe) => ({
    originalShopType: category.originalShopType,
    shopType: category.shopType,
    query: probe.candidate.query,
    queryScore: probe.queryScore,
    queryGenerationReason: probe.candidate.query_generation_reason,
    results: probe.results
  }));
  status.queriesSelected += selected.length;
  if (selected.length < config.generatedQueryCount) status.planningWarnings += 1;

  return {
    selected,
    audits: [
      ...rejectedAudits,
      ...allProbes.map((probe) =>
        probeAudit(category.shopType, probe, selectedScores)
      )
    ]
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
  const input = await dependencies.readCategories(
    config.inputCsv,
    config.maxShopTypes
  );
  status.shopTypesTotal = input.categories.length;
  status.blankShopTypesSkipped = input.blanksSkipped;

  const audits = input.invalid.map((invalid) =>
    blankAudit(invalid.originalShopType, {
      status: "rejected",
      rejection_reason: `invalid_shop_type_row_${invalid.row}: ${invalid.error}`
    })
  );
  status.invalidShopTypes = input.invalid.length;
  const selected = [];
  const cache = new QueryProbeCache();
  const seenQueries = new Set();

  for (const category of input.categories) {
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
    status.shopTypesProcessed += 1;
  }

  await dependencies.writeAudit(config.generatedQueriesCsv, audits);
  status.queriesTotal = selected.length;
  return {
    selected,
    audits,
    blanksSkipped: input.blanksSkipped,
    invalidShopTypes: input.invalid.length,
    probeCacheSize: cache.size
  };
}
