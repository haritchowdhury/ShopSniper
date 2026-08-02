import { requestText } from "./http-client.js";
import { stripHtml } from "./html.js";
import { parseBrowserlessContentResponse } from "./browserless-adapter.js";
import { assessChallengeEvidence } from "./challenge-detector.js";
import {
  assertPublicUrl,
  normalizeHostname,
  parseHttpUrl,
  sameAllowedHostname
} from "./url-security.js";

const CONSENT_SHELL_PATTERN =
  /(?:enable javascript|javascript is required|please turn javascript on|cookie consent).{0,160}(?:continue|view|site|shop)/i;
const SHOPIFY_PATTERN =
  /(?:cdn\.shopify\.com|\/cdn\/shop\/|shopifycloud|Shopify\.(?:theme|routes|shop)|shopify-section|shopify-payment-button|name=["']form_type["'])/i;
const PRODUCT_PATTERN = /(?:\/products\/|\/collections\/|add-to-cart|product-form)/i;
const PASSWORD_FORM_ACTION =
  /<form\b[^>]*\baction\s*=\s*["'][^"']*\/password(?:[/?#][^"']*)?["'][^>]*>/i;
const PASSWORD_INPUT = /<input\b[^>]*\btype\s*=\s*["']password["'][^>]*>/i;
const PASSWORD_TEMPLATE =
  /(?:<body\b[^>]*\bclass\s*=\s*["'][^"']*\bpassword\b|data-template\s*=\s*["']password["'])/i;

function passwordLockAssessment(response, body, hasProductEvidence) {
  let passwordRoute = false;
  try {
    passwordRoute = /^\/password(?:\/|$)/iu.test(new URL(response?.finalUrl || "").pathname);
  } catch {
    passwordRoute = false;
  }
  const formAction = PASSWORD_FORM_ACTION.test(body);
  const templateWithInput = PASSWORD_TEMPLATE.test(body) && PASSWORD_INPUT.test(body);
  const signals = [
    passwordRoute ? "password_route" : "",
    formAction ? "password_form_action" : "",
    templateWithInput ? "password_template_and_input" : ""
  ].filter(Boolean);
  return {
    passwordProtected: signals.length > 0 && !hasProductEvidence,
    signals,
    normalCommerceContent: hasProductEvidence
  };
}

export function assessPageResponse(response, { purpose = "evidence" } = {}) {
  const body = response?.body || "";
  const text = stripHtml(body).slice(0, 100000);
  const contentType = response?.contentType || "";
  const htmlLike = contentType.includes("html") || /<html|<body|<main/i.test(body);
  const challengeEvidence = assessChallengeEvidence(body, text);
  const challenge = challengeEvidence.challenge;
  const consentOrJsShell = CONSENT_SHELL_PATTERN.test(text);
  const hasShopifyEvidence = SHOPIFY_PATTERN.test(body);
  const hasProductEvidence = PRODUCT_PATTERN.test(body);
  const lock = passwordLockAssessment(response, body, hasProductEvidence);
  const passwordProtected = lock.passwordProtected;
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
    challengeSignals: challengeEvidence.signals,
    passwordProtected,
    lockEvidence: lock,
    consentOrJsShell,
    hasShopifyEvidence,
    hasProductEvidence
  };
}

export async function fetchPage(
  url,
  config,
  { request = requestText, purpose = "evidence", allowedHostnames = [] } = {}
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

  if (
    config.browserlessEnabled === false ||
    !browserlessTokens.length ||
    !config.browserlessUrl
  ) {
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
  const renderAllowedHostnames = new Set(
    [parseHttpUrl(url).hostname, ...allowedHostnames].map(normalizeHostname)
  );
  if (ordinaryResponse?.finalUrl) {
    renderAllowedHostnames.add(normalizeHostname(parseHttpUrl(ordinaryResponse.finalUrl).hostname));
  }
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
        maxBytes: 3_000_000,
        responseHeaderNames: ["x-response-code", "x-response-url"]
      });
      const normalized = parseBrowserlessContentResponse(rendered);
      await assertPublicUrl(normalized.finalUrl);
      if (!sameAllowedHostname(normalized.finalUrl, [...renderAllowedHostnames])) {
        throw new Error("Browserless redirected outside verified store hostnames");
      }
      if (normalized.status < 200 || normalized.status >= 300) {
        throw new Error(`Browserless target returned HTTP ${normalized.status}`);
      }
      return {
        ...normalized,
        rendered: true,
        fetchAssessment: assessPageResponse(normalized, { purpose }),
        renderAttempted: true,
        ordinaryAssessment,
        renderContractVersion: normalized.contractVersion
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
