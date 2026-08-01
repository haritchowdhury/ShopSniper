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
  if (/^\/password(?:\/|$)/.test(pathname)) return "password";
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

function elementText(html, tags) {
  const values = [];
  const expression = new RegExp(`<(${tags})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, "gi");
  for (const match of html.matchAll(expression)) values.push(stripHtml(match[2]));
  return normalizedText(values.join(" "));
}

function structuredOrganizationClaims(html) {
  const claims = [];
  const blockedRelationships = new Set([
    "author", "brand", "manufacturer", "provider", "seller", "vendor"
  ]);
  const blockedTypes = new Set([
    "brand", "creativework", "person", "product", "service", "softwareapplication"
  ]);
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const root = JSON.parse(match[1]);
      const visit = (value, { blocked = false, path = "$" } = {}) => {
        if (Array.isArray(value)) {
          return value.forEach((item, index) => visit(item, { blocked, path: `${path}[${index}]` }));
        }
        if (!value || typeof value !== "object") return;
        const types = [value["@type"]].flat().map((type) => normalizedText(type));
        const blockedNode = blocked || types.some((type) => blockedTypes.has(type));
        if (!blockedNode && types.some((type) => [
          "organization", "localbusiness", "onlinestore", "store", "website"
        ].includes(type))) {
          for (const key of ["name", "description", "slogan", "category", "knowsAbout"]) {
            const field = value[key];
            const values = typeof field === "string"
              ? [field]
              : Array.isArray(field)
                ? field.filter((item) => typeof item === "string")
                : [];
            for (const text of values) {
              claims.push({
                field: key,
                text,
                path: `${path}.${key}`,
                explicit: key === "category" || key === "knowsAbout"
              });
            }
          }
        }
        for (const [key, child] of Object.entries(value)) {
          if (!child || typeof child !== "object") continue;
          visit(child, {
            blocked: blockedNode || blockedRelationships.has(key.toLowerCase()),
            path: `${path}.${key}`
          });
        }
      };
      visit(root);
    } catch {
      // Malformed structured data is not storefront-fit evidence.
    }
  }
  return claims;
}

function matchingPhrases(text, phrases) {
  return phrases.filter((phrase) => text.includes(phrase));
}

const GENERAL_DEPARTMENT_TERMS = [
  "appliances", "automotive", "beauty", "electronics", "furniture", "garden",
  "groceries", "grocery", "hardware", "home", "jewelry", "kitchen", "pets",
  "sports", "stationery", "toys"
];

function collectionLinks(html) {
  return [...html.matchAll(/\bhref\s*=\s*["']([^"']*\/collections\/[^"'?#]+)[^"']*["']/gi)]
    .map((match) => normalizedText(match[1]));
}

function evidenceForPage(document, phrases) {
  const text = stripHtml(document.html).slice(0, 100000);
  const normalized = normalizedText(text);
  const title = normalizedText(extractTitle(document.html));
  const type = pageType(document.url);
  const headings = elementText(document.html, "h1|h2");
  const navigation = elementText(document.html, "nav");
  const structuredClaims = structuredOrganizationClaims(document.html);
  const highLevel = ["homepage", "organization"].includes(type);
  const structuredIdentityText = normalizedText(structuredClaims
    .filter(({ explicit }) => !explicit)
    .map(({ text }) => text)
    .join(" "));
  const structuredExplicitText = normalizedText(structuredClaims
    .filter(({ explicit }) => explicit)
    .map(({ text }) => text)
    .join(" "));
  const siteIdentityText = highLevel
    ? normalizedText(`${title} ${headings} ${structuredIdentityText}`)
    : structuredIdentityText;
  const matchedTerms = matchingPhrases(normalizedText(`${normalized} ${title}`), phrases);
  const identityClaimTerms = matchingPhrases(siteIdentityText, phrases);
  const explicitClaimTerms = matchingPhrases(structuredExplicitText, phrases);
  const claimTerms = [...new Set([...explicitClaimTerms, ...identityClaimTerms])];
  const navigationTerms = matchingPhrases(navigation, phrases);
  const relevantCollectionLinks = collectionLinks(document.html).filter((value) =>
    matchingPhrases(value, phrases).length
  );
  const collectionMatch = type === "collection" && matchedTerms.length > 0;
  const productMatch = type === "product" && matchedTerms.length > 0;
  const breadthTerms = highLevel
    ? GENERAL_DEPARTMENT_TERMS.filter((term) =>
        normalized.includes(term) || navigation.includes(term)
      )
    : [];
  const signals = [
    explicitClaimTerms.length ? "explicit_typed_category_claim" : "",
    identityClaimTerms.length ? "category_site_identity" : "",
    navigationTerms.length ? "category_navigation" : "",
    collectionMatch || relevantCollectionLinks.length ? "category_collection_assortment" : "",
    productMatch ? "category_product_assortment" : "",
    matchedTerms.length && !claimTerms.length && !navigationTerms.length &&
      !collectionMatch && !productMatch && !relevantCollectionLinks.length
      ? "isolated_category_mention"
      : ""
  ].filter(Boolean);
  const strength = Math.min(100,
    (explicitClaimTerms.length ? 95 : 0) +
    (identityClaimTerms.length ? 45 : 0) +
    (navigationTerms.length ? 25 : 0) +
    (collectionMatch || relevantCollectionLinks.length ? 30 : 0) +
    (productMatch ? 20 : 0) +
    (matchedTerms.length ? 10 : 0)
  );
  return {
    sourceUrl: document.url,
    pageType: type,
    matchedTerms,
    claimTerms,
    explicitClaimTerms,
    identityClaimTerms,
    claimEvidence: structuredClaims
      .filter(({ text }) => matchingPhrases(normalizedText(text), phrases).length)
      .map(({ field, path, explicit }) => ({ field, path, explicit })),
    signals,
    breadthTerms,
    negativeSignals: breadthTerms.length >= 3 ? ["broad_multi_department_store"] : [],
    strength,
    textLength: text.length
  };
}

export function evaluateStoreFit(candidate, documents = uniqueDocuments(candidate)) {
  const phrases = vocabularyPhrases(candidate);
  const evidence = documents.map((document) => evidenceForPage(document, phrases));
  const matched = evidence.filter(({ matchedTerms, claimTerms }) =>
    matchedTerms.length || claimTerms.length
  );
  const explicitClaimEvidence = matched.filter(({ signals }) =>
    signals.includes("explicit_typed_category_claim")
  );
  const identityClaimEvidence = matched.filter(({ signals }) =>
    signals.includes("category_site_identity")
  );
  const productPages = matched.filter(({ signals }) =>
    signals.includes("category_product_assortment")
  ).length;
  const assortmentSignals = new Set(matched.flatMap(({ signals }) =>
    signals.filter((signal) =>
      signal === "category_navigation" ||
      signal === "category_collection_assortment" ||
      (signal === "category_product_assortment" && productPages >= 2)
    )
  ));
  const breadthEvidence = evidence.flatMap(({ sourceUrl, breadthTerms, negativeSignals }) =>
    negativeSignals.map((signal) => ({ sourceUrl, signal, terms: breadthTerms }))
  );
  const totalText = evidence.reduce((sum, item) => sum + item.textLength, 0);
  const hasContradictoryBreadth = breadthEvidence.length > 0;
  const strongExclusiveClaim = explicitClaimEvidence.length > 0 && !hasContradictoryBreadth;
  const identityWithAssortment = identityClaimEvidence.length > 0 &&
    assortmentSignals.size >= 1 &&
    !hasContradictoryBreadth;
  const independentAssortment = assortmentSignals.size >= 2 && !hasContradictoryBreadth;

  let state = "unknown";
  let reason = "insufficient_category_evidence";
  if (strongExclusiveClaim || identityWithAssortment || independentAssortment) {
    state = "specialist";
    reason = strongExclusiveClaim
      ? "explicit_typed_category_claim_without_breadth"
      : identityWithAssortment
        ? "category_identity_with_assortment_corroboration"
        : "category_dominant_independent_assortment_signals";
  } else if (matched.length) {
    state = "category_seller";
    reason = breadthEvidence.length
      ? "category_evidence_with_general_store_breadth"
      : "product_or_limited_category_evidence";
  } else if (totalText >= 120) {
    state = "mismatch";
    reason = "fetched_content_has_no_category_evidence";
  }

  return {
    state,
    score: matched.length ? Math.max(...matched.map(({ strength }) => strength)) : 0,
    matchedTerms: [...new Set(matched.flatMap(({ matchedTerms }) => matchedTerms))],
    sourceUrls: [...new Set(matched.map(({ sourceUrl }) => sourceUrl))],
    signalKinds: [...new Set(matched.flatMap(({ signals }) => signals))],
    breadthEvidence,
    evidence,
    decisionEvidence: {
      strongExclusiveClaimSourceUrls: explicitClaimEvidence.map(({ sourceUrl }) => sourceUrl),
      identityClaimSourceUrls: identityClaimEvidence.map(({ sourceUrl }) => sourceUrl),
      assortmentSignalKinds: [...assortmentSignals],
      breadthBlockedSpecialist: hasContradictoryBreadth,
      controllingReason: reason
    },
    reason
  };
}

export function storeFitAcceptsIntent(qualifier, state) {
  if (qualifier === "brand") return state === "specialist";
  return state === "specialist" || state === "category_seller";
}

export const STOREFRONT_REJECTION_PRIORITY = Object.freeze([
  "inactive_store",
  "not_shopify",
  "wrong_category",
  "wrong_store_type",
  "storefront_blocked",
  "insufficient_store_evidence",
  "insufficient_contact_evidence"
]);

export function storefrontRejectionPriority(reason) {
  const index = STOREFRONT_REJECTION_PRIORITY.indexOf(reason);
  return index < 0 ? 99 : index;
}

export function validateStorefront(candidate, config, { final = false } = {}) {
  const documents = uniqueDocuments(candidate);
  const assessments = documents.map((document) =>
    document.assessment || assessPageResponse(
      { body: document.html, contentType: "text/html", finalUrl: document.url },
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

  const passwordProtected = assessments.some((assessment, index) =>
    assessment.passwordProtected &&
    (index === 0 || ["homepage", "password"].includes(pageType(documents[index].url)))
  );
  const blocked = assessments.length > 0 && assessments.every(({ challenge }) => challenge);
  const usableEvidence = assessments.some(({ usable }) => usable);
  const storeFit = evaluateStoreFit(candidate, documents);
  const qualifier = candidate.businessQualifier || "unspecified";

  let rejectionReason = "";
  if (passwordProtected) rejectionReason = "inactive_store";
  else if (final && shopifyConfidence < 30) rejectionReason = "not_shopify";
  else if (final && storeFit.state === "mismatch") rejectionReason = "wrong_category";
  else if (final && storeFit.state === "category_seller" &&
    !storeFitAcceptsIntent(qualifier, storeFit.state)) {
    rejectionReason = "wrong_store_type";
  }
  else if (final && blocked) rejectionReason = "storefront_blocked";
  else if (final && (!usableEvidence || storeFit.state === "unknown")) {
    rejectionReason = "insufficient_store_evidence";
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
      activityEvidence: assessments.map((assessment, index) => ({
        sourceUrl: documents[index].url,
        passwordProtected: assessment.passwordProtected,
        lockEvidence: assessment.lockEvidence || null,
        challenge: assessment.challenge
      })),
      blocked,
      usableEvidence,
      fetchedSourceUrls: documents.map(({ url }) => url),
      storeFit
    }
  };
}
