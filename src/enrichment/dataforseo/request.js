import { createHash } from "node:crypto";
import net from "node:net";
import { ENRICHMENT_ERROR_CODES, dataForSeoError } from "../errors.js";

export const DATAFORSEO_RESPONSE_CONTRACT_VERSION = "dataforseo-bulk-traffic-v1";
export const DATAFORSEO_TRAFFIC_CONTRACT_VERSION = "dataforseo-traffic-v1";
export const DATAFORSEO_OBSERVED_API_VERSION = "0.1.20260806";
export const DATAFORSEO_API_VERSION_PATTERN = /^0\.1\.20\d{6}$/u;
export const DATAFORSEO_BULK_TRAFFIC_ENDPOINT =
  "https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_traffic_estimation/live";
export const DATAFORSEO_TARGET_LIMIT = 1000;
export const DATAFORSEO_ITEM_TYPES = Object.freeze([
  "organic",
  "paid",
  "featured_snippet",
  "local_pack"
]);
export const DATAFORSEO_COUNTRY_LOCATION_CODES = Object.freeze({
  US: 2840,
  GB: 2826,
  CA: 2124,
  AU: 2036,
  NZ: 2554,
  DE: 2276,
  FR: 2250,
  IN: 2356,
  AE: 2784
});

function invalidRequest(message) {
  throw dataForSeoError(ENRICHMENT_ERROR_CODES.invalidRequest, message);
}

export function normalizeDataForSeoHostname(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    invalidRequest("DataForSEO targets must be non-empty canonical hostnames");
  }
  if (!/^[\x00-\x7F]+$/u.test(value) || /(?:^|\.)xn--/iu.test(value)) {
    invalidRequest("DataForSEO targets must be unambiguous ASCII hostnames");
  }
  if (/^www\./iu.test(value)) {
    invalidRequest("DataForSEO targets must not begin with www");
  }
  if (/[:\/@?#\\]/u.test(value)) {
    invalidRequest("DataForSEO targets must not contain URL components");
  }

  const hostname = value.toLowerCase().replace(/\.$/u, "");
  if (
    !hostname ||
    hostname.length > 253 ||
    net.isIP(hostname) ||
    !hostname.includes(".")
  ) {
    invalidRequest("DataForSEO targets must be public DNS hostnames");
  }
  const labels = hostname.split(".");
  if (labels.some((label) =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  )) {
    invalidRequest("DataForSEO targets contain an invalid DNS label");
  }
  return hostname;
}

export function normalizeDataForSeoTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    invalidRequest("DataForSEO requests require at least one target");
  }
  if (targets.length > DATAFORSEO_TARGET_LIMIT) {
    invalidRequest("DataForSEO requests exceed the 1000-target limit");
  }
  const normalized = targets.map(normalizeDataForSeoHostname);
  if (new Set(normalized).size !== normalized.length) {
    invalidRequest("DataForSEO requests contain duplicate normalized targets");
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

export function normalizeDataForSeoScope(scope = "worldwide") {
  if (scope === "worldwide") return "worldwide";
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    invalidRequest("DataForSEO scope is not supported");
  }
  const keys = Object.keys(scope);
  if (keys.length !== 1 || keys[0] !== "countryIsoCode") {
    invalidRequest("DataForSEO country scope must contain only countryIsoCode");
  }
  const countryIsoCode = String(scope.countryIsoCode).toUpperCase();
  const locationCode = DATAFORSEO_COUNTRY_LOCATION_CODES[countryIsoCode];
  if (!locationCode) invalidRequest("DataForSEO country scope is not supported");
  return Object.freeze({ countryIsoCode, locationCode });
}

function canonicalFingerprint(task) {
  const canonical = JSON.stringify({
    contractVersion: DATAFORSEO_RESPONSE_CONTRACT_VERSION,
    endpoint: DATAFORSEO_BULK_TRAFFIC_ENDPOINT,
    task
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function buildDataForSeoRequest({ targets, scope = "worldwide" }) {
  const normalizedTargets = normalizeDataForSeoTargets(targets);
  const normalizedScope = normalizeDataForSeoScope(scope);
  const task = {
    targets: normalizedTargets,
    item_types: [...DATAFORSEO_ITEM_TYPES]
  };
  if (normalizedScope !== "worldwide") {
    task.location_code = normalizedScope.locationCode;
  }
  return Object.freeze({
    endpoint: DATAFORSEO_BULK_TRAFFIC_ENDPOINT,
    task: Object.freeze(task),
    body: Object.freeze([task]),
    targets: Object.freeze(normalizedTargets),
    scope: normalizedScope,
    requestFingerprint: canonicalFingerprint(task)
  });
}
