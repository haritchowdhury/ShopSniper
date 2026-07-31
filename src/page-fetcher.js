import { requestText } from "./http-client.js";
import { stripHtml } from "./html.js";
import { assertPublicUrl } from "./url-security.js";

const CHALLENGE_PATTERN =
  /(?:captcha|cf-chl-|cloudflare ray id|checking your browser|verify you are human|access denied|bot detection|unusual traffic)/i;
const CONSENT_SHELL_PATTERN =
  /(?:enable javascript|javascript is required|please turn javascript on|cookie consent).{0,160}(?:continue|view|site|shop)/i;
const PASSWORD_PATTERN =
  /(?:\/password(?:["'/?#])|class=["'][^"']*password|enter using password|opening soon)/i;
const SHOPIFY_PATTERN =
  /(?:cdn\.shopify\.com|\/cdn\/shop\/|shopifycloud|Shopify\.(?:theme|routes|shop)|shopify-section|shopify-payment-button|name=["']form_type["'])/i;
const PRODUCT_PATTERN = /(?:\/products\/|\/collections\/|add-to-cart|product-form)/i;

export function assessPageResponse(response, { purpose = "evidence" } = {}) {
  const body = response?.body || "";
  const text = stripHtml(body).slice(0, 100000);
  const contentType = response?.contentType || "";
  const htmlLike = contentType.includes("html") || /<html|<body|<main/i.test(body);
  const challenge = CHALLENGE_PATTERN.test(body);
  const passwordProtected = PASSWORD_PATTERN.test(body);
  const consentOrJsShell = CONSENT_SHELL_PATTERN.test(text);
  const hasShopifyEvidence = SHOPIFY_PATTERN.test(body);
  const hasProductEvidence = PRODUCT_PATTERN.test(body);
  const minimumText = purpose === "storefront" ? 120 : 80;
  const insufficientText = text.length < minimumText;
  const suspicious = challenge || consentOrJsShell;
  const usefulStorefrontEvidence = hasShopifyEvidence || hasProductEvidence;
  const usable = Boolean(
    htmlLike &&
    !suspicious &&
    !insufficientText &&
    (purpose !== "storefront" || usefulStorefrontEvidence || passwordProtected)
  );
  let reason = "usable_html";
  if (!htmlLike) reason = "non_html_response";
  else if (challenge) reason = "challenge_page";
  else if (consentOrJsShell) reason = "javascript_or_consent_shell";
  else if (insufficientText) reason = "insufficient_text";
  else if (purpose === "storefront" && !usefulStorefrontEvidence && !passwordProtected) {
    reason = "missing_storefront_evidence";
  }
  return {
    usable,
    reason,
    textLength: text.length,
    challenge,
    passwordProtected,
    consentOrJsShell,
    hasShopifyEvidence,
    hasProductEvidence
  };
}

export async function fetchPage(
  url,
  config,
  { request = requestText, purpose = "evidence" } = {}
) {
  let ordinaryResponse;
  let ordinaryError;
  let ordinaryAssessment;
  try {
    ordinaryResponse = await request(url, {
      timeoutMs: config.requestTimeoutMs,
      retries: 1,
      maxBytes: 2_000_000
    });
    ordinaryAssessment = assessPageResponse(ordinaryResponse, { purpose });
    if (ordinaryAssessment.usable) {
      return {
        ...ordinaryResponse,
        rendered: false,
        fetchAssessment: ordinaryAssessment,
        renderAttempted: false
      };
    }
  } catch (error) {
    ordinaryError = error;
  }

  const browserlessTokens = [
    config.browserlessToken,
    config.browserlessFallbackToken
  ].filter((token, index, values) => token && values.indexOf(token) === index);

  if (!browserlessTokens.length || !config.browserlessUrl) {
    if (ordinaryResponse) {
      return {
        ...ordinaryResponse,
        rendered: false,
        fetchAssessment: ordinaryAssessment,
        renderAttempted: false,
        renderUnavailable: true
      };
    }
    throw ordinaryError || new Error("Page fetch failed");
  }

  await assertPublicUrl(url);
  const browserlessErrors = [];
  for (const token of browserlessTokens) {
    const browserlessUrl = new URL(config.browserlessUrl);
    browserlessUrl.searchParams.set("token", token);
    try {
      const rendered = await request(browserlessUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          gotoOptions: { waitUntil: "networkidle2", timeout: config.requestTimeoutMs }
        }),
        timeoutMs: config.requestTimeoutMs + 5000,
        retries: 0,
        maxBytes: 3_000_000
      });
      const normalized = { ...rendered, finalUrl: url };
      return {
        ...normalized,
        rendered: true,
        fetchAssessment: assessPageResponse(normalized, { purpose }),
        renderAttempted: true,
        ordinaryAssessment
      };
    } catch (browserlessError) {
      browserlessErrors.push(
        browserlessError instanceof Error ? browserlessError.message : String(browserlessError)
      );
    }
  }

  if (ordinaryResponse) {
    return {
      ...ordinaryResponse,
      rendered: false,
      fetchAssessment: ordinaryAssessment,
      renderAttempted: true,
      renderError: "Rendered fetch failed"
    };
  }
  throw new Error(
    `Normal fetch and Browserless failed: ${ordinaryError?.message || "unknown"}; ${browserlessErrors.join("; ")}`
  );
}
