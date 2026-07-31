import { searchGooglePage } from "./search.js";
import { queryTerms } from "./storefront-validator.js";
import { QueryProbeCache } from "./query-cache.js";

function myshopifyHost(value) {
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase("en-US");
    return hostname === "myshopify.com" || hostname.endsWith(".myshopify.com")
      ? hostname
      : "";
  } catch {
    return "";
  }
}

function normalizedText(value) {
  return String(value || "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function probeResultRelevance(result, query) {
  const terms = queryTerms(query);
  if (terms.length < 2) return { relevant: false, matchedTerms: [], coverage: 0 };
  const haystack = normalizedText(`${result.title} ${result.snippet} ${result.url}`);
  const matchedTerms = terms.filter((term) =>
    new RegExp(`(?:^|\\s)${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\s)`, "u")
      .test(haystack)
  );
  const phraseMatched = haystack.includes(terms.join(" "));
  const requiredTerms = Math.max(2, Math.ceil(terms.length * 0.6));
  return {
    relevant: phraseMatched || matchedTerms.length >= requiredTerms,
    matchedTerms,
    coverage: matchedTerms.length / terms.length
  };
}

export function summarizeProbe(candidate, page, config) {
  const usable = page.results.filter((result) => !result.rejectionReason);
  const hosts = usable.map((result) => myshopifyHost(result.url)).filter(Boolean);
  const uniqueHosts = [...new Set(hosts)];
  const duplicatesPerHost = hosts.length - uniqueHosts.length;
  const relevance = usable.map((result) => probeResultRelevance(result, candidate.query));
  const relevantResults = relevance.filter(({ relevant }) => relevant).length;
  const rawResults = page.results.length;

  const distinctStoreScore = Math.min(40, (uniqueHosts.length / 10) * 40);
  const relevanceScore = usable.length ? (relevantResults / usable.length) * 40 : 0;
  // Candidate confidence and research source URLs remain audit provenance only.
  // They are model-authored and are not calibrated or independently linked to
  // probe coverage, so neither receives a fixed ranking bonus.
  const productIntentScore = 20;
  const baseScore = Math.round(
    (distinctStoreScore + relevanceScore + productIntentScore) * 100
  ) / 100;

  let rejectionReason = "";
  if (usable.length < config.minQueryResults) rejectionReason = "insufficient_results";
  else if (uniqueHosts.length < config.minQueryUniqueHosts) {
    rejectionReason = "insufficient_unique_hosts";
  } else if (relevantResults < (config.minQueryRelevantResults || 2)) {
    rejectionReason = "irrelevant_probe_results";
  }

  return {
    candidate,
    results: page.results,
    rawResults,
    uniqueHosts,
    duplicateProducts: duplicatesPerHost,
    relevantResults,
    relevanceCoverage: relevance.map(({ coverage }) => coverage),
    nextPageAvailable: page.nextPageAvailable,
    estimatedTotalResults: page.estimatedTotalResults,
    baseScore,
    rejectionReason,
    error: ""
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return output;
}

export async function probeCandidates(
  candidates,
  config,
  {
    searchPage = searchGooglePage,
    cache = new QueryProbeCache(),
    onProbed = () => {}
  } = {}
) {
  return mapWithConcurrency(candidates, config.queryProbeConcurrency, async (candidate) => {
    if (cache.has(candidate.query)) {
      const cached = cache.get(candidate.query);
      onProbed(cached, true);
      return cached;
    }
    try {
      const page = await searchPage(candidate.query, config);
      const probe = summarizeProbe(candidate, page, config);
      cache.set(candidate.query, probe);
      onProbed(probe, false);
      return probe;
    } catch (error) {
      const probe = {
        candidate,
        results: [],
        rawResults: 0,
        uniqueHosts: [],
        duplicateProducts: 0,
        relevantResults: 0,
        nextPageAvailable: false,
        estimatedTotalResults: 0,
        baseScore: 0,
        rejectionReason: "probe_failed",
        error: error instanceof Error ? error.message : String(error)
      };
      cache.set(candidate.query, probe);
      onProbed(probe, false);
      return probe;
    }
  });
}
