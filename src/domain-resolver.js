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
  const observedHostnames = [...new Set([originalHost, finalHost].filter(Boolean))];
  const myshopifyDomain = observedHostnames.find(isMyShopifyHostname) || "";
  const canonicalTrusted = Boolean(
    canonicalHost && observedHostnames.includes(canonicalHost)
  );

  let resolvedDomain = "";
  if (finalHost && !isMyShopifyHostname(finalHost)) {
    resolvedDomain = finalHost;
  } else if (originalHost && !isMyShopifyHostname(originalHost)) {
    resolvedDomain = originalHost;
  } else {
    resolvedDomain = myshopifyDomain || finalHost || originalHost;
  }

  const allowedHostnames = observedHostnames;
  const stableIdentity = myshopifyDomain || resolvedDomain;
  const identityConfidence =
    resolvedDomain && !isMyShopifyHostname(resolvedDomain)
      ? 100
      : myshopifyDomain
        ? 70
        : 35;

  return {
    ...result,
    html: response.body,
    finalUrl: response.finalUrl,
    canonicalUrl,
    myshopifyDomain,
    resolvedDomain,
    stableIdentity,
    allowedHostnames,
    identityConfidence,
    identityEvidence: {
      stableHostname: stableIdentity,
      displayHostname: resolvedDomain,
      observedHostnames,
      canonical: {
        url: canonicalUrl,
        hostname: canonicalHost,
        trusted: canonicalTrusted,
        reason: canonicalTrusted
          ? "canonical_matches_observed_host"
          : canonicalHost
            ? "cross_domain_canonical_unverified"
            : "canonical_absent"
      },
      method: myshopifyDomain
        ? "observed_myshopify_host"
        : finalHost !== originalHost
          ? "observed_redirect_host"
          : "directly_fetched_host",
      confidence: identityConfidence
    }
  };
}
