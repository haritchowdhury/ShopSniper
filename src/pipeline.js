import { readQueries } from "./csv.js";
import { searchGoogle } from "./search.js";
import { resolveStoreIdentity } from "./domain-resolver.js";
import { validateStorefront } from "./storefront-validator.js";
import { discoverStorePages } from "./sitemap.js";
import { fetchPage } from "./page-fetcher.js";
import {
  consolidateEvidence,
  extractContactEvidence
} from "./contact-extractor.js";
import { normalizeWithAi } from "./ai-normalizer.js";
import { scoreLead } from "./lead-scorer.js";
import { writeOutput } from "./output.js";
import { sameAllowedHostname } from "./url-security.js";
import { log } from "./logger.js";

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function blankRecord(overrides = {}) {
  return {
    search_query: "",
    google_rank: "",
    google_result_url: "",
    myshopify_domain: "",
    final_url: "",
    canonical_url: "",
    resolved_domain: "",
    store_name: "",
    email: "",
    email_source_url: "",
    phone: "",
    phone_source_url: "",
    contact_url: "",
    social_profiles: [],
    additional_information: "",
    shopify_confidence: "",
    relevance_score: "",
    lead_score: "",
    status: "",
    rejection_reason: "",
    error: "",
    ...overrides
  };
}

function recordFromCandidate(candidate, overrides = {}) {
  return blankRecord({
    search_query: candidate.query,
    google_rank: candidate.rank,
    google_result_url: candidate.url,
    myshopify_domain: candidate.myshopifyDomain || "",
    final_url: candidate.finalUrl || "",
    canonical_url: candidate.canonicalUrl || "",
    resolved_domain: candidate.resolvedDomain || "",
    ...overrides
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

async function processStore(candidate, config, dependencies) {
  const validation = dependencies.validate(candidate, config);
  if (!validation.valid) {
    return recordFromCandidate(candidate, {
      shopify_confidence: validation.shopifyConfidence,
      relevance_score: validation.relevanceScore,
      lead_score: scoreLead({
        relevanceScore: validation.relevanceScore,
        shopifyConfidence: validation.shopifyConfidence,
        identityConfidence: candidate.identityConfidence
      }),
      status: "rejected",
      rejection_reason: validation.rejectionReason,
      additional_information: JSON.stringify(validation.evidence)
    });
  }

  let pageUrls;
  try {
    pageUrls = await dependencies.discoverPages(candidate, config);
  } catch {
    pageUrls = [candidate.finalUrl];
  }

  const pages = [];
  const pageErrors = [];
  for (const pageUrl of pageUrls) {
    try {
      let html;
      let evidenceUrl = pageUrl;
      if (pageUrl === candidate.finalUrl || pageUrl === candidate.url) {
        html = candidate.html;
      } else {
        const response = await dependencies.fetchPage(pageUrl, config);
        if (!sameAllowedHostname(response.finalUrl, candidate.allowedHostnames)) {
          throw new Error("Page redirected outside the verified store hostnames");
        }
        html = response.body;
        evidenceUrl = response.finalUrl;
      }
      pages.push(dependencies.extractEvidence({ html, url: evidenceUrl }));
    } catch (error) {
      pageErrors.push(`${new URL(pageUrl).pathname}: ${messageOf(error)}`);
    }
  }

  const evidence = dependencies.consolidate(pages);
  let ai = null;
  let aiError = "";
  try {
    ai = await dependencies.normalizeAi(candidate, evidence, config);
  } catch (error) {
    aiError = messageOf(error);
  }

  const email = ai?.email || evidence.email;
  const phone = ai?.phone || evidence.phone;
  const contactUrl = ai?.contact_url || evidence.contactUrl;
  const socialProfiles = ai?.social_profiles?.length
    ? ai.social_profiles
    : evidence.socialProfiles;
  const emailPage = pages.find((page) => page.emails.includes(email));
  const phonePage = pages.find((page) => page.phones.includes(phone));
  const leadScore = scoreLead({
    relevanceScore: validation.relevanceScore,
    shopifyConfidence: validation.shopifyConfidence,
    identityConfidence: candidate.identityConfidence,
    email,
    phone,
    contactUrl,
    socialProfiles
  });

  let status = "qualified";
  let rejectionReason = "";
  if (!email && !phone && !contactUrl) {
    status = "rejected";
    rejectionReason = "no_contact_information";
  } else if (leadScore < config.qualificationThreshold) {
    status = "rejected";
    rejectionReason = "low_lead_score";
  }

  const notes = [
    ai?.additional_information || "",
    `pages_examined=${pages.length}`,
    candidate.duplicateCount ? `duplicate_results=${candidate.duplicateCount}` : "",
    pageErrors.length ? `page_errors=${pageErrors.join(" | ")}` : ""
  ].filter(Boolean);

  return recordFromCandidate(candidate, {
    store_name: ai?.store_name || evidence.storeName,
    email,
    email_source_url: emailPage?.url || evidence.emailSourceUrl,
    phone,
    phone_source_url: phonePage?.url || evidence.phoneSourceUrl,
    contact_url: contactUrl,
    social_profiles: socialProfiles,
    additional_information: notes.join("; "),
    shopify_confidence: validation.shopifyConfidence,
    relevance_score: validation.relevanceScore,
    lead_score: leadScore,
    status,
    rejection_reason: rejectionReason,
    error: aiError ? `AI normalization failed; deterministic evidence retained: ${aiError}` : ""
  });
}

const DEFAULT_DEPENDENCIES = {
  readQueries,
  search: searchGoogle,
  resolve: resolveStoreIdentity,
  validate: validateStorefront,
  discoverPages: discoverStorePages,
  fetchPage,
  extractEvidence: extractContactEvidence,
  consolidate: consolidateEvidence,
  normalizeAi: normalizeWithAi,
  writeOutput
};

export async function runPipeline(config, status, dependencyOverrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const { queries, blanksSkipped } = await dependencies.readQueries(
    config.inputCsv,
    config.maxQueries
  );
  status.queriesTotal = queries.length;
  status.blankQueriesSkipped = blanksSkipped;

  const records = [];
  const resolvedStores = new Map();

  for (const query of queries) {
    let results;
    try {
      results = await dependencies.search(query, config);
    } catch (error) {
      records.push(
        blankRecord({
          search_query: query,
          status: "failed",
          rejection_reason: "search_failed",
          error: messageOf(error)
        })
      );
      status.failures += 1;
      status.queriesProcessed += 1;
      log("query_failed", { query, error });
      continue;
    }

    if (!results.length) {
      records.push(
        blankRecord({
          search_query: query,
          status: "rejected",
          rejection_reason: "no_search_results"
        })
      );
    }

    for (const result of results) {
      if (result.rejectionReason) {
        records.push(
          recordFromCandidate(result, {
            status: "rejected",
            rejection_reason: result.rejectionReason
          })
        );
        continue;
      }
      try {
        const candidate = await dependencies.resolve(result, config);
        status.storesDiscovered += 1;
        const key = candidate.resolvedDomain;
        if (!key) throw new Error("Could not determine a storefront domain");
        if (resolvedStores.has(key)) {
          resolvedStores.get(key).duplicateCount += 1;
        } else {
          candidate.duplicateCount = 0;
          resolvedStores.set(key, candidate);
        }
      } catch (error) {
        records.push(
          recordFromCandidate(result, {
            status: "failed",
            rejection_reason: "resolution_failed",
            error: messageOf(error)
          })
        );
        status.failures += 1;
      }
    }
    status.queriesProcessed += 1;
  }

  const storeRecords = await mapWithConcurrency(
    [...resolvedStores.values()],
    config.storeConcurrency,
    async (candidate) => {
      try {
        const record = await processStore(candidate, config, dependencies);
        if (record.status === "qualified") status.storesQualified += 1;
        else status.storesRejected += 1;
        return record;
      } catch (error) {
        status.failures += 1;
        return recordFromCandidate(candidate, {
          status: "failed",
          rejection_reason: "processing_failed",
          error: messageOf(error)
        });
      }
    }
  );

  records.push(...storeRecords);
  await dependencies.writeOutput(config.outputCsv, records);
  status.outputRows = records.length;
  return records;
}
