import { normalizeHostname, parseHttpUrl, sameAllowedHostname } from "./url-security.js";

const REJECTED_ROUTE_SEGMENTS = new Set([
  "account",
  "admin",
  "apps",
  "assets",
  "blogs",
  "cart",
  "cdn",
  "checkouts",
  "collections",
  "orders",
  "products",
  "search"
]);

const ASSET_EXTENSION = /\.(?:avif|bmp|css|csv|gif|ico|jpe?g|js|json|map|pdf|png|svg|txt|webp|xml|zip)$/i;
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const CONTACT_SLUG = /^(?:contact(?:-us|-form)?|customer-service|customer-support|get-in-touch|help(?:-center)?|support)$/;
const ORGANIZATION_SLUG = /^(?:about(?:-us)?|company|locations?|our-story|privacy(?:-policy)?|team|terms(?:-of-service)?)$/;

const SOCIAL_PLATFORM_BY_HOST = new Map([
  ["instagram.com", "instagram"],
  ["facebook.com", "facebook"],
  ["m.facebook.com", "facebook"],
  ["linkedin.com", "linkedin"],
  ["x.com", "x"],
  ["twitter.com", "x"],
  ["tiktok.com", "tiktok"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["pinterest.com", "pinterest"]
]);

const VENDOR_HANDLES = new Set([
  "shopify",
  "shopifydevs",
  "shopifypartners",
  "shopifyplus"
]);

const BLOCKED_SOCIAL_SEGMENTS = new Set([
  "accounts",
  "create",
  "dialog",
  "events",
  "explore",
  "groups",
  "home",
  "intent",
  "login",
  "marketplace",
  "messages",
  "pin-builder",
  "pinterest-pin",
  "plugins",
  "profile.php",
  "reel",
  "reels",
  "search",
  "share",
  "share.php",
  "sharer",
  "sharer.php",
  "stories",
  "watch"
]);

function safelyDecodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function normalizedSegments(url) {
  const segments = safelyDecodePath(url.pathname)
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  if (segments.length && LOCALE_SEGMENT.test(segments[0])) segments.shift();
  return segments;
}

function invalidRoute(reason) {
  return { accepted: false, classification: "rejected", reason, url: "" };
}

export function classifyStorePageUrl(
  value,
  { baseUrl, allowedHostnames = [] } = {}
) {
  let url;
  try {
    url = parseHttpUrl(value, baseUrl);
  } catch {
    return invalidRoute("invalid_url");
  }
  if (url.username || url.password) return invalidRoute("credentials_not_allowed");
  if (allowedHostnames.length) {
    try {
      if (!sameAllowedHostname(url, allowedHostnames)) {
        return invalidRoute("unverified_host");
      }
    } catch {
      return invalidRoute("invalid_url");
    }
  }

  const segments = normalizedSegments(url);
  if (ASSET_EXTENSION.test(url.pathname)) return invalidRoute("asset_path");
  if (segments.some((segment) => REJECTED_ROUTE_SEGMENTS.has(segment))) {
    return invalidRoute("excluded_store_route");
  }

  let classification = "other";
  let reason = "not_evidence_route";
  const [routeGroup, slug, ...rest] = segments;
  if (!segments.length) {
    classification = "organization_evidence";
    reason = "store_homepage";
  } else if (segments.length === 1 && CONTACT_SLUG.test(routeGroup)) {
    classification = "contact";
    reason = "explicit_contact_route";
  } else if (
    routeGroup === "pages" &&
    rest.length === 0 &&
    CONTACT_SLUG.test(slug || "")
  ) {
    classification = "contact";
    reason = "shopify_contact_page";
  } else if (
    routeGroup === "policies" &&
    rest.length === 0 &&
    slug === "contact-information"
  ) {
    classification = "contact";
    reason = "shopify_contact_policy";
  } else if (
    (segments.length === 1 && ORGANIZATION_SLUG.test(routeGroup)) ||
    (routeGroup === "pages" && rest.length === 0 && ORGANIZATION_SLUG.test(slug || "")) ||
    (routeGroup === "policies" && rest.length === 0 && ORGANIZATION_SLUG.test(slug || ""))
  ) {
    classification = "organization_evidence";
    reason = "organization_evidence_route";
  }

  url.hash = "";
  return {
    accepted: classification !== "other",
    classification,
    reason,
    url: url.href
  };
}

export function validateContactPageUrl(value, options = {}) {
  const result = classifyStorePageUrl(value, options);
  if (result.classification === "contact") return result;
  return {
    ...result,
    accepted: false,
    reason: result.reason === "not_evidence_route" ? "not_contact_route" : result.reason
  };
}

const CONTACT_HEADING_PATTERN = /\b(?:contact(?:\s+us)?|customer\s+(?:care|service|support)|get\s+in\s+touch|help(?:\s+center)?|support)\b/i;
const GENERIC_ERROR_PATTERN = /^(?:4(?:04|10)\b|not\s+found\b|page\s+not\s+found\b|the\s+page\s+(?:could\s+not\s+be\s+found|does\s+not\s+exist)\b|content\s+unavailable\b|service\s+unavailable\b)/i;
const SOFT_404_PATTERN = /\b(?:404|page\s+(?:was\s+)?not\s+found|page\s+(?:could\s+not\s+be\s+found|does\s+not\s+exist)|could(?:n['’]t|\s+not)\s+find\s+(?:that|the)\s+page|content\s+unavailable|service\s+unavailable)\b/i;
const CHALLENGE_PATTERN = /(?:captcha|cf-chl-|checking\s+your\s+browser|verify\s+you\s+are\s+human|access\s+denied|unusual\s+traffic)/i;

function visibleText(html = "") {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function hasUsableContactForm(html = "") {
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const form = `${match[1]} ${match[2]}`;
    if (/\b(?:search|login|password|cart|newsletter|subscribe)\b/i.test(form)) continue;
    const hasMessage = /<textarea\b/i.test(form) ||
      /<(?:input|select)\b[^>]*\bname\s*=\s*["'][^"']*(?:message|inquiry|enquiry|comment)[^"']*["']/i.test(form);
    const hasContactField = /<input\b[^>]*(?:type\s*=\s*["'](?:email|tel)["']|name\s*=\s*["'][^"']*(?:email|phone|telephone)[^"']*["'])/i.test(form);
    const hasSubmit = /<(?:button|input)\b[^>]*(?:type\s*=\s*["']submit["']|>\s*(?:send|submit|contact))/i.test(form);
    if ((hasMessage || hasContactField) && hasSubmit) return true;
  }
  return false;
}

function hasContactHeadingAndBody(html = "", text = visibleText(html)) {
  const heading = [...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((match) => visibleText(match[1]))
    .find((value) => CONTACT_HEADING_PATTERN.test(value));
  if (!heading) return false;
  const supportingText = text.replace(heading, "").trim();
  return supportingText.length >= 80 && supportingText.split(/\s+/).length >= 12;
}

/**
 * Decide whether a fetched page is usable contact-page evidence. Route shape is
 * deliberately only one gate; callers must provide the store's verified hosts.
 */
export function assessContactPage({
  url,
  requestedUrl = url,
  allowedHostnames = [],
  html = "",
  status = 200,
  fetchAssessment = null,
  hasValidatedDirectMethod = false,
  hasContactStructuredData = false
} = {}) {
  const route = validateContactPageUrl(url, { allowedHostnames });
  let sameStore = false;
  try {
    const trustedHosts = allowedHostnames.length
      ? allowedHostnames
      : [parseHttpUrl(requestedUrl).hostname];
    sameStore = sameAllowedHostname(url, trustedHosts);
  } catch {
    sameStore = false;
  }

  const text = visibleText(html);
  const contactForm = hasUsableContactForm(html);
  const contactHeadingBody = hasContactHeadingAndBody(html, text);
  const structuredContact = Boolean(hasContactStructuredData);
  const directMethod = Boolean(hasValidatedDirectMethod);
  const positiveSignals = [
    contactForm ? "contact_form" : "",
    directMethod ? "validated_direct_method" : "",
    structuredContact ? "contact_structured_data" : "",
    contactHeadingBody ? "contact_heading_with_substantive_body" : ""
  ].filter(Boolean);

  const httpUsable = Number(status) >= 200 && Number(status) < 300;
  const challenge = Boolean(fetchAssessment?.challenge) || CHALLENGE_PATTERN.test(html);
  const genericError = GENERIC_ERROR_PATTERN.test(text) ||
    (text.length <= 500 && SOFT_404_PATTERN.test(text)) ||
    /<title\b[^>]*>\s*(?:404|not found|page not found)\b/i.test(html);
  const blank = text.length === 0;
  const tinyWithoutSubstance = text.length < 40 && !contactForm && !structuredContact && !directMethod;
  const pageUsable = httpUsable && !challenge && !genericError && !blank && !tinyWithoutSubstance;
  const accepted = route.accepted && sameStore && pageUsable && positiveSignals.length > 0;

  let validationReason = "validated_contact_page";
  if (!route.accepted) validationReason = route.reason;
  else if (!sameStore) validationReason = "unverified_final_host";
  else if (!httpUsable) validationReason = "unsuccessful_http_status";
  else if (challenge) validationReason = "challenge_page";
  else if (genericError) validationReason = "soft_404_or_error_page";
  else if (blank) validationReason = "blank_page";
  else if (tinyWithoutSubstance) validationReason = "insufficient_page_content";
  else if (!positiveSignals.length) validationReason = "missing_contact_signals";

  return Object.freeze({
    accepted,
    routeAccepted: route.accepted,
    routeReason: route.reason,
    sameStore,
    httpUsable,
    pageUsable,
    positiveSignals: Object.freeze(positiveSignals),
    validationReason,
    sourceUrl: route.url || ""
  });
}

function socialResult(reason, overrides = {}) {
  return { accepted: false, reason, platform: "", url: "", ...overrides };
}

function canonicalSocialHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "m.facebook.com") return host;
  return host.startsWith("www.") ? host.slice(4) : host;
}

function profileHandle(platform, segments) {
  if (!segments.length) return "";
  if (segments.some((segment) => BLOCKED_SOCIAL_SEGMENTS.has(segment))) return "";
  if (platform === "instagram" || platform === "facebook" || platform === "x" || platform === "pinterest") {
    return segments.length === 1 ? segments[0] : "";
  }
  if (platform === "linkedin") {
    return segments.length === 2 && segments[0] === "company" ? segments[1] : "";
  }
  if (platform === "tiktok") {
    return segments.length === 1 && segments[0].startsWith("@")
      ? segments[0].slice(1)
      : "";
  }
  if (platform === "youtube") {
    if (segments.length === 1 && segments[0].startsWith("@")) return segments[0].slice(1);
    if (segments.length === 2 && ["c", "channel", "user"].includes(segments[0])) {
      return segments[1];
    }
  }
  return "";
}

export function validateSocialProfile(value, { baseUrl } = {}) {
  let url;
  try {
    url = parseHttpUrl(value, baseUrl);
  } catch {
    return socialResult("invalid_url");
  }
  if (url.username || url.password) return socialResult("credentials_not_allowed");
  if (url.port) return socialResult("non_default_port_not_allowed");

  const host = canonicalSocialHost(url.hostname);
  const platform = SOCIAL_PLATFORM_BY_HOST.get(host);
  if (!platform) return socialResult("unsupported_social_host");
  if (host === "youtu.be") return socialResult("content_url_not_profile", { platform });

  const segments = safelyDecodePath(url.pathname)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (url.searchParams.has("share") || url.searchParams.has("intent")) {
    return socialResult("share_or_intent_url", { platform });
  }
  const handle = profileHandle(platform, segments);
  if (!handle) return socialResult("not_profile_path", { platform });
  if (VENDOR_HANDLES.has(handle.replace(/^@/, ""))) {
    return socialResult("platform_or_vendor_profile", { platform });
  }

  url.hostname = host === "m.facebook.com" ? "facebook.com" : host;
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  url.pathname = `/${segments.join("/")}`;
  return {
    accepted: true,
    reason: "validated_store_profile_path",
    platform,
    url: url.href
  };
}

export function makeEvidence({
  kind,
  value,
  sourceUrl,
  method,
  confidence,
  validationReason,
  decision,
  structuredPath
}) {
  return Object.freeze({
    kind,
    value,
    sourceUrl,
    method,
    confidence,
    validationReason,
    ...(decision ? { decision } : {}),
    ...(structuredPath ? { structuredPath } : {})
  });
}
