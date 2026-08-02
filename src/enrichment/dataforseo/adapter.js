import { ENRICHMENT_ERROR_CODES, dataForSeoError } from "../errors.js";
import { executeDataForSeoRequest } from "./client.js";
import { parseDataForSeoResponse } from "./contract.js";
import {
  DATAFORSEO_TRAFFIC_CONTRACT_VERSION,
  buildDataForSeoRequest
} from "./request.js";

function fetchedAtFrom(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw dataForSeoError(
      ENRICHMENT_ERROR_CODES.invalidRequest,
      "DataForSEO fetchedAt clock is invalid"
    );
  }
  return date.toISOString();
}

function normalizeResult(descriptor, parsed, fetchedAt) {
  const records = descriptor.targets.map((target) => {
    const metrics = parsed.itemsByTarget.get(target);
    if (!metrics) {
      return Object.freeze({
        state: "unavailable",
        target,
        reason: "provider_omitted_target"
      });
    }
    return Object.freeze({
      state: "available",
      value: Object.freeze({
        contractVersion: DATAFORSEO_TRAFFIC_CONTRACT_VERSION,
        target,
        scope: descriptor.scope,
        languageScope: "all_available",
        metrics: Object.freeze({
          organic: Object.freeze({ ...metrics.organic }),
          paid: Object.freeze({ ...metrics.paid }),
          featuredSnippet: Object.freeze({ ...metrics.featured_snippet }),
          localPack: Object.freeze({ ...metrics.local_pack })
        }),
        fetchedAt
      })
    });
  });
  return Object.freeze({
    requestFingerprint: descriptor.requestFingerprint,
    scope: descriptor.scope,
    records: Object.freeze(records),
    cost: Object.freeze({ providerReported: parsed.cost })
  });
}

export function normalizeDataForSeoResponse(
  { descriptor, body },
  { now = () => new Date() } = {}
) {
  return normalizeResult(
    descriptor,
    parseDataForSeoResponse(body, descriptor),
    fetchedAtFrom(now)
  );
}

export async function fetchDataForSeoTraffic(
  { targets, scope = "worldwide", config },
  { request, now = () => new Date() } = {}
) {
  const descriptor = buildDataForSeoRequest({ targets, scope });
  const body = await executeDataForSeoRequest(descriptor, config, { request });
  return normalizeDataForSeoResponse({ descriptor, body }, { now });
}
