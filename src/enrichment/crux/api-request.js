import { ENRICHMENT_ERROR_CODES, cruxError } from "../errors.js";

export const CRUX_API_RESPONSE_CONTRACT_VERSION = "crux-query-record-v1";
export const CRUX_ORIGIN_METRICS_CONTRACT_VERSION = "crux-origin-metrics-v1";
export const CRUX_API_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
export const CRUX_METRICS = Object.freeze([
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
  "first_contentful_paint",
  "experimental_time_to_first_byte",
  "form_factors"
]);

function invalidRequest(message) {
  throw cruxError(
    ENRICHMENT_ERROR_CODES.invalidRequest,
    message,
    CRUX_API_RESPONSE_CONTRACT_VERSION
  );
}

export function normalizeCruxOrigin(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    invalidRequest("CrUX origin must be a canonical HTTPS origin");
  }
  if (!/^[\x00-\x7F]+$/u.test(value)) {
    invalidRequest("CrUX origin must be unambiguous ASCII");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalidRequest("CrUX origin is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    parsed.origin !== value ||
    /(?:^|\.)xn--/iu.test(parsed.hostname)
  ) {
    invalidRequest("CrUX origin must be an exact canonical HTTPS origin");
  }
  return value;
}

export function buildCruxApiRequest(origin) {
  const normalizedOrigin = normalizeCruxOrigin(origin);
  return Object.freeze({
    endpoint: CRUX_API_ENDPOINT,
    origin: normalizedOrigin,
    body: Object.freeze({
      origin: normalizedOrigin,
      metrics: CRUX_METRICS
    })
  });
}
