import { extractTitle, stripHtml } from "./html.js";
import { assessPageResponse } from "./page-fetcher.js";
import { isMyShopifyHostname } from "./url-security.js";

const STOP_WORDS = new Set([
  "site", "www", "com", "http", "https", "myshopify", "products", "collections",
  "shop", "store", "the", "and", "for", "with", "from", "this", "that", "brand", "brands"
]);

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function queryTerms(query = "") {
  const cleaned = query
    .replace(/site:\S+/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase();
  return [...new Set(
    cleaned.split(/\s+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  )];
}

export function relevanceScore(query, text) {
  const terms = queryTerms(query);
  if (!terms.length) return 0;
  const haystack = normalizedText(text);
  const matched = terms.filter((term) => haystack.split(" ").includes(term)).length;
  const phrase = terms.join(" ");
  return Math.min(100, Math.round((matched / terms.length) * 80 +
    (phrase && haystack.includes(phrase) ? 20 : 0)));
}

function pageType(url) {
  let pathname = "/";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return "other";
  }
  if (pathname === "/" || !pathname.replaceAll("/", "")) return "homepage";
  if (/\/collections?\//.test(pathname)) return "collection";
  if (/\/products?\//.test(pathname)) return "product";
  if (/\/(?:pages\/)?(?:about|our-story|company|team)(?:[-/]|$)/.test(pathname)) {
    return "organization";
  }
  if (/\/policies\//.test(pathname)) return "policy";
  if (/\/(?:contact|support|help|customer-service)(?:[-/]|$)/.test(pathname)) {
    return "contact";
  }
  return "other";
}

function uniqueDocuments(candidate) {
  const documents = [{
    url: candidate.finalUrl || candidate.url ||
      (candidate.resolvedDomain ? `https://${candidate.resolvedDomain}/` : ""),
    html: candidate.html || "",
    rendered: Boolean(candidate.initialFetch?.rendered),
    assessment: candidate.initialFetch?.assessment || null
  }, ...(candidate.evidencePages || [])];
  const seen = new Set();
  return documents.filter(({ url, html }) => {
    if (!url || !html) return false;
    let key = url;
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      key = `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "") || "/"}${parsed.search}`;
    } catch {
      return false;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function vocabularyPhrases(candidate) {
  const values = [candidate.shopType, ...(candidate.categoryVocabulary || [])];
  return [...new Set(values.map(normalizedText).filter(Boolean))].slice(0, 100);
}

function evidenceForPage(document, phrases) {
  const text = stripHtml(document.html).slice(0, 100000);
  const normalized = normalizedText(text);
  const title = normalizedText(extractTitle(document.html));
  const type = pageType(document.url);
  const matchedTerms = phrases.filter((phrase) =>
    normalized.includes(phrase) || title.includes(phrase)
  );
  const corePhrase = phrases[0] || "";
  const highLevel = ["homepage", "organization"].includes(type);
  const strength = Math.min(100,
    (matchedTerms.includes(corePhrase) ? 45 : 0) +
    Math.min(35, matchedTerms.length * 10) +
    (highLevel && matchedTerms.length ? 20 : 0)
  );
  return {
    sourceUrl: document.url,
    pageType: type,
    matchedTerms,
    signals: [
      title && matchedTerms.some((term) => title.includes(term)) ? "site_title_match" : "",
      highLevel && matchedTerms.length ? "high_level_category_match" : "",
      type === "collection" && matchedTerms.length ? "collection_match" : "",
      type === "product" && matchedTerms.length ? "product_match" : ""
    ].filter(Boolean),
    strength,
    textLength: text.length
  };
}

export function evaluateStoreFit(candidate, documents = uniqueDocuments(candidate)) {
  const phrases = vocabularyPhrases(candidate);
  const evidence = documents.map((document) => evidenceForPage(document, phrases));
  const matched = evidence.filter(({ matchedTerms }) => matchedTerms.length);
  const highLevelIdentityCore = matched.some(({ pageType: type, matchedTerms, signals }) =>
    ["homepage", "organization"].includes(type) &&
    matchedTerms.includes(phrases[0]) &&
    signals.includes("site_title_match")
  );
  const highLevelBreadth = matched.some(({ pageType: type, matchedTerms }) =>
    ["homepage", "organization"].includes(type) && matchedTerms.length >= 2
  );
  const collectionMatches = matched.filter(({ pageType: type }) => type === "collection").length;
  const totalText = evidence.reduce((sum, item) => sum + item.textLength, 0);

  let state = "unknown";
  let reason = "insufficient_category_evidence";
  if (highLevelIdentityCore || highLevelBreadth || collectionMatches >= 2) {
    state = "specialist";
    reason = "high_level_or_assortment_category_evidence";
  } else if (matched.length) {
    state = "category_seller";
    reason = "product_or_limited_category_evidence";
  } else if (totalText >= 120) {
    state = "mismatch";
    reason = "fetched_content_has_no_category_evidence";
  }

  return {
    state,
    score: matched.length ? Math.max(...matched.map(({ strength }) => strength)) : 0,
    matchedTerms: [...new Set(matched.flatMap(({ matchedTerms }) => matchedTerms))],
    sourceUrls: [...new Set(matched.map(({ sourceUrl }) => sourceUrl))],
    evidence,
    reason
  };
}

function qualifierAccepts(qualifier, state) {
  if (qualifier === "brand") return state === "specialist";
  return state === "specialist" || state === "category_seller";
}

export function validateStorefront(candidate, config, { final = false } = {}) {
  const documents = uniqueDocuments(candidate);
  const assessments = documents.map((document) =>
    document.assessment || assessPageResponse(
      { body: document.html, contentType: "text/html" },
      { purpose: "storefront" }
    )
  );
  const html = documents.map(({ html: body }) => body).join("\n");
  let shopifyConfidence = 0;
  if (isMyShopifyHostname(candidate.resolvedDomain) || candidate.myshopifyDomain) {
    shopifyConfidence += 35;
  }
  if (/cdn\.shopify\.com|\/cdn\/shop\/|shopifycloud/i.test(html)) shopifyConfidence += 30;
  if (/Shopify\.(?:theme|routes|shop)|shopify-section|shopify-payment-button/i.test(html)) {
    shopifyConfidence += 25;
  }
  if (/\/products\/|\/collections\/|add-to-cart|name=["']form_type["']/i.test(html)) {
    shopifyConfidence += 10;
  }
  shopifyConfidence = Math.min(100, shopifyConfidence);

  const passwordProtected = assessments.some(({ passwordProtected }) => passwordProtected);
  const blocked = assessments.length > 0 && assessments.every(({ challenge }) => challenge);
  const usableEvidence = assessments.some(({ usable }) => usable);
  const storeFit = evaluateStoreFit(candidate, documents);
  const qualifier = candidate.businessQualifier || "unspecified";

  let rejectionReason = "";
  if (passwordProtected) rejectionReason = "inactive_store";
  else if (final && blocked) rejectionReason = "storefront_blocked";
  else if (final && shopifyConfidence < 30) rejectionReason = "not_shopify";
  else if (final && !usableEvidence) rejectionReason = "insufficient_store_evidence";
  else if (final && storeFit.state === "unknown") rejectionReason = "insufficient_store_evidence";
  else if (final && storeFit.state === "mismatch") rejectionReason = "wrong_category";
  else if (final && !qualifierAccepts(qualifier, storeFit.state)) {
    rejectionReason = "wrong_store_type";
  }

  return {
    valid: !rejectionReason,
    rejectionReason,
    shopifyConfidence,
    relevanceScore: storeFit.score,
    storeFit,
    activityState: passwordProtected ? "inactive" : blocked ? "blocked" : usableEvidence ? "active" : "unknown",
    evidence: {
      passwordProtected,
      blocked,
      usableEvidence,
      fetchedSourceUrls: documents.map(({ url }) => url),
      storeFit
    }
  };
}
