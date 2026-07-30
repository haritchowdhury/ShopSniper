import { stripHtml } from "./html.js";
import { isMyShopifyHostname } from "./url-security.js";

const STOP_WORDS = new Set([
  "site",
  "www",
  "com",
  "http",
  "https",
  "myshopify",
  "products",
  "collections",
  "shop",
  "store",
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "brand",
  "brands"
]);

export function queryTerms(query) {
  const cleaned = query
    .replace(/site:\S+/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase();
  return [...new Set(
    cleaned
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  )];
}

export function relevanceScore(query, text) {
  const terms = queryTerms(query);
  if (!terms.length) return 50;
  const haystack = text.toLowerCase();
  const matched = terms.filter((term) => haystack.includes(term)).length;
  const phrase = terms.join(" ");
  const ratio = matched / terms.length;
  return Math.min(100, Math.round(ratio * 80 + (phrase && haystack.includes(phrase) ? 20 : 0)));
}

export function validateStorefront(candidate, config) {
  const html = candidate.html || "";
  const text = stripHtml(html).slice(0, 100000);
  const combined = `${candidate.title || ""} ${candidate.snippet || ""} ${text}`;
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

  const relevance = relevanceScore(candidate.query, combined);
  const passwordProtected =
    /\/password(?:["'/?#])|class=["'][^"']*password|enter using password|opening soon/i.test(html);
  const insufficientContent = text.length < 80;

  let rejectionReason = "";
  if (passwordProtected) rejectionReason = "inactive_store";
  else if (insufficientContent) rejectionReason = "inactive_store";
  else if (shopifyConfidence < 30) rejectionReason = "not_shopify";
  else if (relevance < config.minRelevanceScore) rejectionReason = "wrong_category";

  return {
    valid: !rejectionReason,
    rejectionReason,
    shopifyConfidence,
    relevanceScore: relevance,
    evidence: {
      passwordProtected,
      textLength: text.length,
      queryTerms: queryTerms(candidate.query)
    }
  };
}
