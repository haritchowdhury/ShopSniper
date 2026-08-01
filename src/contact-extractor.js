import { decodeHtml, extractAttributeUrls, extractTitle, stripHtml } from "./html.js";
import {
  assessContactPage,
  classifyStorePageUrl,
  makeEvidence,
  validateSocialProfile
} from "./contact-evidence.js";
import { parseHttpUrl } from "./url-security.js";

const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const PHONE_LABEL = /\b(?:call|contact|customer\s+service|mobile|phone|telephone|tel|whats\s*app)\b/i;
const STRONG_PHONE_LABEL = /\b(?:call|mobile|phone|telephone|tel|whats\s*app)\b/i;
const NON_PHONE_LABEL = /\b(?:ean|invoice|isbn|item|model|order|product|quantity|reference|sku|tracking|upc|vat|year)\b/i;
const VENDOR_CREDIT_PATTERN = /\b(?:built|created|designed|developed|powered|site|theme)\s+(?:by|with)\b|\b(?:theme|template)\s+(?:author|vendor|credits?)\b/i;
const ORGANIZATION_TYPES = new Map([
  ["onlinestore", 100],
  ["localbusiness", 98],
  ["organization", 96],
  ["website", 88]
]);
const CONTACT_TYPES = new Set(["contactpoint", ...ORGANIZATION_TYPES.keys()]);
const PLACEHOLDER_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "localhost"
]);
const PLACEHOLDER_LOCAL_PARTS = new Set([
  "email",
  "example",
  "name",
  "sample",
  "test",
  "user",
  "username",
  "your-email",
  "yourname"
]);

function safelyDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizedSourceUrl(value) {
  try {
    const url = parseHttpUrl(value);
    if (url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const email = safelyDecode(value)
    .trim()
    .replace(/^mailto:/i, "")
    .split("?")[0]
    .toLowerCase()
    .replace(/[),.;:]+$/, "");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) return "";
  if (/\.(?:png|jpe?g|gif|webp|svg)$/i.test(email)) return "";
  return email;
}

export function validateEmailCandidate(value) {
  const email = normalizeEmail(value);
  if (!email) return { accepted: false, value: "", reason: "invalid_email" };
  const [localPart, domain] = email.split("@");
  if (
    PLACEHOLDER_DOMAINS.has(domain) ||
    domain.endsWith(".example") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".test") ||
    PLACEHOLDER_LOCAL_PARTS.has(localPart)
  ) {
    return { accepted: false, value: "", reason: "placeholder_email" };
  }
  if (/^(?:do-?not-?reply|no-?reply|mailer-daemon)$/.test(localPart)) {
    return { accepted: false, value: "", reason: "non_contact_mailbox" };
  }
  return { accepted: true, value: email, reason: "syntactically_valid_non_placeholder" };
}

export function normalizePhone(value) {
  if (typeof value !== "string") return "";
  const trimmed = safelyDecode(value)
    .replace(/^tel:/i, "")
    .trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return "";
  return `${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

function schemaTypes(item) {
  const values = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
  return values
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase().replace(/^https?:\/\/schema\.org\//, ""));
}

function structuredData(html) {
  const emails = [];
  const phones = [];
  const names = [];
  const socialProfiles = [];
  let hasContactPage = false;
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const value = JSON.parse(decodeHtml(match[1]));
      const queue = Array.isArray(value) ? [...value] : [value];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        const types = schemaTypes(item);
        if (types.includes("contactpage")) hasContactPage = true;
        const organizationType = types.find((type) => ORGANIZATION_TYPES.has(type));
        if (organizationType && typeof item.name === "string" && item.name.trim()) {
          names.push({
            value: item.name.trim(),
            method: `json_ld_${organizationType}`,
            confidence: ORGANIZATION_TYPES.get(organizationType)
          });
        }
        if (types.some((type) => CONTACT_TYPES.has(type))) {
          if (typeof item.email === "string") emails.push(item.email);
          if (typeof item.telephone === "string") phones.push(item.telephone);
        }
        if (organizationType) {
          const sameAs = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
          socialProfiles.push(...sameAs.filter((value) => typeof value === "string"));
        }
        for (const nested of Object.values(item)) {
          if (nested && typeof nested === "object") {
            queue.push(...(Array.isArray(nested) ? nested : [nested]));
          }
        }
      }
    } catch {
      // Invalid JSON-LD is ignored; it never becomes evidence.
    }
  }
  return { emails, phones, names, socialProfiles, hasContactPage };
}

function siteNameFromMetadata(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/\b(?:property|name)\s*=\s*["'](?:og:site_name|application-name)["']/i.test(tag)) {
      continue;
    }
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const value = decodeHtml(content?.[1] ?? content?.[2] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function confidenceFor(base, route, boost = 8) {
  return Math.min(100, base + (route.classification === "contact" ? boost : 0));
}

function emailEvidence(value, sourceUrl, method, confidence, route) {
  if (!sourceUrl) return null;
  const result = validateEmailCandidate(value);
  if (!result.accepted) return null;
  return makeEvidence({
    kind: "email",
    value: result.value,
    sourceUrl,
    method,
    confidence: confidenceFor(confidence, route),
    validationReason: result.reason
  });
}

function phoneEvidence(value, sourceUrl, method, confidence, route, textContext = "") {
  if (!sourceUrl) return null;
  const normalized = normalizePhone(value);
  if (!normalized) return null;
  if (!["json_ld", "tel", "visible_text"].includes(method)) return null;
  if (method === "visible_text") {
    const hasPhoneLabel = PHONE_LABEL.test(textContext);
    const candidateIndex = textContext.indexOf(value);
    const beforeCandidate = candidateIndex >= 0
      ? textContext.slice(Math.max(0, candidateIndex - 64), candidateIndex)
      : textContext;
    const negativeMatches = [...beforeCandidate.matchAll(new RegExp(NON_PHONE_LABEL.source, "gi"))];
    const strongMatches = [...beforeCandidate.matchAll(new RegExp(STRONG_PHONE_LABEL.source, "gi"))];
    const lastNegative = negativeMatches.at(-1)?.index ?? -1;
    const lastStrong = strongMatches.at(-1)?.index ?? -1;
    const isYearRange = /^\s*\d{4}\s*[-–—]\s*\d{4}\s*$/.test(value);
    const hasPhoneFormatting = /[+().-]|\d\s+\d/.test(value);
    if (isYearRange || (lastNegative >= 0 && lastNegative >= lastStrong)) return null;
    if (!hasPhoneLabel && !(route.classification === "contact" && hasPhoneFormatting)) {
      return null;
    }
  }
  return makeEvidence({
    kind: "phone",
    value: normalized,
    sourceUrl,
    method,
    confidence: confidenceFor(confidence, route),
    validationReason:
      method === "visible_text" ? "verified_contact_context" : "source_proven_phone"
  });
}

function insideElement(html, index, tagName) {
  const prefix = html.slice(0, index);
  const openings = [...prefix.matchAll(new RegExp(`<${tagName}\\b`, "gi"))];
  const closings = [...prefix.matchAll(new RegExp(`</${tagName}\\s*>`, "gi"))];
  return (openings.at(-1)?.index ?? -1) > (closings.at(-1)?.index ?? -1);
}

function associatedSocialEvidence(html, sourceUrl, route, structuredSocials) {
  const evidence = [];
  for (const value of structuredSocials) {
    const result = validateSocialProfile(value, { baseUrl: sourceUrl });
    if (!result.accepted) continue;
    evidence.push(makeEvidence({
      kind: "social_profile",
      value: result.url,
      sourceUrl,
      method: `json_ld_same_as_${result.platform}`,
      confidence: 94,
      validationReason: "organization_same_as"
    }));
  }

  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))[^>]*>[\s\S]*?<\/a>/gi)) {
    const value = decodeHtml(match[1] ?? match[2] ?? match[3] ?? "");
    const result = validateSocialProfile(value, { baseUrl: sourceUrl });
    if (!result.accepted) continue;
    const index = match.index ?? 0;
    const precedingContext = stripHtml(html.slice(Math.max(0, index - 140), index));
    const anchorText = stripHtml(match[0]);
    const vendorCredit = precedingContext.match(VENDOR_CREDIT_PATTERN);
    if (VENDOR_CREDIT_PATTERN.test(anchorText) ||
      (vendorCredit && precedingContext.length - (vendorCredit.index + vendorCredit[0].length) <= 60)) {
      continue;
    }
    const inOwnedLayout = ["header", "nav", "footer"].some((tag) => insideElement(html, index, tag));
    const onOwnedEvidencePage = route.classification === "contact" ||
      route.reason === "organization_evidence_route";
    if (!inOwnedLayout && !onOwnedEvidencePage) continue;
    evidence.push(makeEvidence({
      kind: "social_profile",
      value: result.url,
      sourceUrl,
      method: `associated_link_${result.platform}`,
      confidence: inOwnedLayout ? 86 : 82,
      validationReason: inOwnedLayout
        ? "store_owned_layout_link"
        : "store_owned_evidence_page_link"
    }));
  }
  return evidence;
}

function deduplicateEvidence(values) {
  const selected = new Map();
  for (const item of values.filter(Boolean)) {
    const key = `${item.kind}:${item.value.toLowerCase()}`;
    const current = selected.get(key);
    if (
      !current ||
      item.confidence > current.confidence ||
      (item.confidence === current.confidence && item.sourceUrl.localeCompare(current.sourceUrl) < 0)
    ) {
      selected.set(key, item);
    }
  }
  return [...selected.values()].sort(
    (a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value) || a.sourceUrl.localeCompare(b.sourceUrl)
  );
}

export function extractContactEvidence({
  html = "",
  url,
  requestedUrl = url,
  allowedHostnames = [],
  status = 200,
  fetchAssessment = null
}) {
  const sourceUrl = normalizedSourceUrl(url);
  if (!sourceUrl) {
    return {
      url: "",
      storeName: "",
      emails: [],
      phones: [],
      socialProfiles: [],
      contactUrl: "",
      textSnippet: "",
      evidence: {
        emails: [],
        phones: [],
        contactPages: [],
        socialProfiles: [],
        organizationNames: []
      }
    };
  }

  const text = stripHtml(html);
  const hrefs = extractAttributeUrls(html);
  const structured = structuredData(html);
  const route = classifyStorePageUrl(sourceUrl);

  const emails = [];
  for (const value of structured.emails) {
    emails.push(emailEvidence(value, sourceUrl, "json_ld", 92, route));
  }
  for (const href of hrefs.filter((value) => /^mailto:/i.test(value))) {
    emails.push(emailEvidence(href, sourceUrl, "mailto", 96, route));
  }
  for (const value of text.match(EMAIL_PATTERN) || []) {
    emails.push(emailEvidence(value, sourceUrl, "visible_text", 68, route));
  }

  const phones = [];
  for (const value of structured.phones) {
    phones.push(phoneEvidence(value, sourceUrl, "json_ld", 92, route));
  }
  for (const href of hrefs.filter((value) => /^tel:/i.test(value))) {
    phones.push(phoneEvidence(href, sourceUrl, "tel", 96, route));
  }
  for (const match of text.matchAll(PHONE_PATTERN)) {
    const context = text.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80);
    phones.push(phoneEvidence(match[0], sourceUrl, "visible_text", 65, route, context));
  }

  const socialEvidence = associatedSocialEvidence(
    html,
    sourceUrl,
    route,
    structured.socialProfiles
  );

  const extractedEmails = deduplicateEvidence(emails);
  const extractedPhones = deduplicateEvidence(phones);
  const extractedSocials = deduplicateEvidence(socialEvidence);
  const contact = assessContactPage({
    url: sourceUrl,
    requestedUrl,
    allowedHostnames,
    html,
    status,
    fetchAssessment,
    hasValidatedDirectMethod: Boolean(extractedEmails.length || extractedPhones.length),
    hasContactStructuredData: structured.hasContactPage
  });
  const usableSameStorePage = contact.pageUsable && contact.sameStore;
  const rankedEmails = usableSameStorePage ? extractedEmails : [];
  const rankedPhones = usableSameStorePage ? extractedPhones : [];
  const rankedSocials = usableSameStorePage ? extractedSocials : [];
  const contactPages = contact.accepted
    ? [makeEvidence({
        kind: "contact_page",
        value: contact.sourceUrl,
        sourceUrl,
        method: "contact_page_decision_v2",
        confidence: 100,
        validationReason: contact.validationReason,
        decision: contact
      })]
    : [];

  const organizationNames = structured.names.map((name) => makeEvidence({
    kind: "organization_name",
    value: name.value,
    sourceUrl,
    method: name.method,
    confidence: name.confidence,
    validationReason: "organization_schema_type"
  }));
  const metadataName = siteNameFromMetadata(html);
  if (metadataName) {
    organizationNames.push(makeEvidence({
      kind: "organization_name",
      value: metadataName,
      sourceUrl,
      method: "site_metadata",
      confidence: 86,
      validationReason: "site_name_metadata"
    }));
  } else if (route.reason === "store_homepage") {
    const homepageTitle = extractTitle(html);
    if (homepageTitle) {
      organizationNames.push(makeEvidence({
        kind: "organization_name",
        value: homepageTitle,
        sourceUrl,
        method: "homepage_title",
        confidence: 60,
        validationReason: "homepage_title_fallback"
      }));
    }
  }

  const rankedNames = deduplicateEvidence(organizationNames);
  return {
    url: sourceUrl,
    storeName: rankedNames[0]?.value || "",
    emails: rankedEmails.map(({ value }) => value),
    phones: rankedPhones.map(({ value }) => value),
    socialProfiles: rankedSocials.map(({ value }) => value),
    contactUrl: contactPages[0]?.value || "",
    textSnippet: text.slice(0, 2500),
    evidence: {
      emails: rankedEmails,
      phones: rankedPhones,
      contactPages,
      socialProfiles: rankedSocials,
      organizationNames: rankedNames
    }
  };
}

function legacyPageEvidence(page) {
  const sourceUrl = normalizedSourceUrl(page.url);
  const route = sourceUrl ? classifyStorePageUrl(sourceUrl) : { classification: "rejected" };
  const emails = (page.emails || [])
    .map((value) => emailEvidence(value, sourceUrl, "legacy_compatibility", 50, route))
    .filter(Boolean);
  const phones = [];
  const socialProfiles = [];
  const organizationNames = [];
  return {
    emails,
    phones,
    socialProfiles,
    contactPages: [],
    organizationNames
  };
}

export function consolidateEvidence(pages) {
  const all = {
    emails: [],
    phones: [],
    socialProfiles: [],
    contactPages: [],
    organizationNames: []
  };
  for (const page of pages) {
    const evidence = page.evidence || legacyPageEvidence(page);
    for (const key of Object.keys(all)) all[key].push(...(evidence[key] || []));
  }

  const ranked = Object.fromEntries(
    Object.entries(all).map(([key, values]) => [key, deduplicateEvidence(values)])
  );
  const emailEvidence = ranked.emails[0];
  const phoneEvidence = ranked.phones[0];
  return {
    storeName: ranked.organizationNames[0]?.value || "",
    email: emailEvidence?.value || "",
    emailSourceUrl: emailEvidence?.sourceUrl || "",
    phone: phoneEvidence?.value || "",
    phoneSourceUrl: phoneEvidence?.sourceUrl || "",
    contactUrl: ranked.contactPages[0]?.value || "",
    socialProfiles: ranked.socialProfiles.map(({ value }) => value),
    allEmails: ranked.emails.map(({ value }) => value),
    allPhones: ranked.phones.map(({ value }) => value),
    snippets: pages.map(({ url, textSnippet }) => ({ url, text: textSnippet || "" })),
    evidence: ranked
  };
}
