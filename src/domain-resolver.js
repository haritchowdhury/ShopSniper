import { requestText } from "./http-client.js";
import { extractCanonical } from "./html.js";
import {
  isMyShopifyHostname,
  normalizeHostname,
  parseHttpUrl
} from "./url-security.js";

function hostnameOf(value) {
  try {
    return normalizeHostname(parseHttpUrl(value).hostname);
  } catch {
    return "";
  }
}

export async function resolveStoreIdentity(
  result,
  config,
  { request = requestText } = {}
) {
  const original = parseHttpUrl(result.url);
  let response;
  try {
    response = await request(original, {
      timeoutMs: config.requestTimeoutMs,
      retries: 1
    });
  } catch (error) {
    const homepage = new URL("/", original);
    if (homepage.href === original.href) throw error;
    response = await request(homepage, {
      timeoutMs: config.requestTimeoutMs,
      retries: 1
    });
  }

  const canonicalUrl = extractCanonical(response.body, response.finalUrl);
  const originalHost = hostnameOf(original.href);
  const finalHost = hostnameOf(response.finalUrl);
  const canonicalHost = hostnameOf(canonicalUrl);
  const myshopifyDomain = [originalHost, finalHost, canonicalHost].find(isMyShopifyHostname) || "";

  let resolvedDomain = "";
  if (finalHost && !isMyShopifyHostname(finalHost)) {
    resolvedDomain = finalHost;
  } else if (canonicalHost && !isMyShopifyHostname(canonicalHost)) {
    resolvedDomain = canonicalHost;
  } else {
    resolvedDomain = myshopifyDomain || finalHost || originalHost;
  }

  const allowedHostnames = [...new Set(
    [originalHost, finalHost, canonicalHost, myshopifyDomain, resolvedDomain].filter(Boolean)
  )];

  return {
    ...result,
    html: response.body,
    finalUrl: response.finalUrl,
    canonicalUrl,
    myshopifyDomain,
    resolvedDomain,
    allowedHostnames,
    identityConfidence:
      resolvedDomain && !isMyShopifyHostname(resolvedDomain)
        ? 100
        : myshopifyDomain
          ? 70
          : 35
  };
}
