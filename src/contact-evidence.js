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
  validationReason
}) {
  return Object.freeze({
    kind,
    value,
    sourceUrl,
    method,
    confidence,
    validationReason
  });
}
