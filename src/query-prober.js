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

function isRelevant(result, query) {
  const terms = queryTerms(query);
  if (!terms.length) return false;
  const haystack = `${result.title} ${result.snippet} ${result.url}`.toLocaleLowerCase("en-US");
  return terms.some((term) => haystack.includes(term));
}

export function summarizeProbe(candidate, page, config) {
  const usable = page.results.filter((result) => !result.rejectionReason);
  const hosts = usable.map((result) => myshopifyHost(result.url)).filter(Boolean);
  const uniqueHosts = [...new Set(hosts)];
  const duplicatesPerHost = hosts.length - uniqueHosts.length;
  const relevantResults = usable.filter((result) => isRelevant(result, candidate.query)).length;
  const rawResults = page.results.length;

  const distinctStoreScore = Math.min(30, (uniqueHosts.length / 10) * 30);
  const relevanceScore = rawResults ? (relevantResults / rawResults) * 20 : 0;
  const productIntentScore = 15;
  const marketEvidenceScore = candidate.source_urls?.length ? 15 : 0;
  const paginationScore = page.nextPageAvailable ? 5 : 0;
  const baseScore = Math.round(
    (distinctStoreScore + relevanceScore + productIntentScore + marketEvidenceScore +
      paginationScore) * 100
  ) / 100;

  let rejectionReason = "";
  if (rawResults < config.minQueryResults) rejectionReason = "insufficient_results";
  else if (uniqueHosts.length < config.minQueryUniqueHosts) {
    rejectionReason = "insufficient_unique_hosts";
  } else if (!relevantResults) rejectionReason = "irrelevant_probe_results";

  return {
    candidate,
    results: page.results,
    rawResults,
    uniqueHosts,
    duplicateProducts: duplicatesPerHost,
    relevantResults,
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
