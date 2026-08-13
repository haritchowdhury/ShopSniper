import { ENRICHMENT_ERROR_CODES, EnrichmentError } from "../../enrichment/errors.js";
import { parseProviderBatchAttempt, parseProviderSourceAttemptArtifact } from "../contracts/artifacts.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { fingerprintJson } from "../core/canonical.js";

export const BIGQUERY_LIVE_RETRY_MS = 15 * 60 * 1000;
export const TRANSIENT_HTTP_STATUSES = Object.freeze(new Set([408, 429, 500, 502, 503, 504]));

export function trafficProviderConfigFingerprint(runSnapshot) {
  return fingerprintJson({ contractVersion: "traffic-provider-config-v1",
    trafficEnrichmentConfig: runSnapshot });
}

export function providerBatchIdentity({ runId, generation, source, scopeKey,
  manifestFingerprint, runSnapshot, providerRequestFingerprint, items }) {
  const ordered = [...items].sort((left, right) => left.shopId < right.shopId ? -1 : left.shopId > right.shopId ? 1 : 0);
  if (!ordered.length || ordered.length > 1000 || new Set(ordered.map(({ shopId }) => shopId)).size !== ordered.length ||
      ordered.some(({ shopId, sourceKey }) => typeof shopId !== "string" || !sourceKey))
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const batchInputFingerprint = fingerprintJson({ contractVersion: "provider-batch-input-v1",
    runId, generation, source, scopeKey, manifestFingerprint,
    providerConfigFingerprint: trafficProviderConfigFingerprint(runSnapshot),
    providerRequestFingerprint, items: ordered });
  return { batchId: batchInputFingerprint, batchInputFingerprint, items: ordered,
    requestId: source === "crux_bigquery" ? `crux-${batchInputFingerprint.slice(0, 31)}` : undefined };
}

export function sourceAttemptBody({ runId, generation, shopId, taskInputFingerprint, selection }) {
  return parseProviderSourceAttemptArtifact({ contractVersion: "provider-source-attempt-v1", runId,
    generation, shopId, source: "crux_rest", taskInputFingerprint,
    sourceKeyFingerprint: fingerprintJson(selection) });
}

export function bigQueryAttemptBody({ runId, generation, scopeKey, batchInputFingerprint,
  datasetMonth, dryRunBytesProcessed, dispatchedAt }) {
  return parseProviderBatchAttempt({ contractVersion: "provider-batch-attempt-v1", runId, generation,
    source: "crux_bigquery", scopeKey, batchId: batchInputFingerprint, batchInputFingerprint,
    requestId: `crux-${batchInputFingerprint.slice(0, 31)}`, datasetMonth, dryRunBytesProcessed,
    dispatchedAt: dispatchedAt instanceof Date ? dispatchedAt.toISOString() : dispatchedAt });
}

export function reconcileBigQueryAttempt(attempt, { now, scopeKey, maximumBytesBilled }) {
  const parsed = parseProviderBatchAttempt(attempt);
  const current = now instanceof Date ? now : new Date(now);
  const dispatched = new Date(parsed.dispatchedAt);
  if (!Number.isFinite(current.getTime()) || parsed.scopeKey !== scopeKey ||
      parsed.dryRunBytesProcessed > maximumBytesBilled)
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  return current.getTime() < dispatched.getTime() + BIGQUERY_LIVE_RETRY_MS
    ? { outcome: "retry", requestId: parsed.requestId,
      dryRun: { datasetMonth: parsed.datasetMonth, bytesProcessed: parsed.dryRunBytesProcessed } }
    : { outcome: "ambiguous" };
}

export function mapProviderError(source, phase, error, leaseAttempt = 1) {
  if (!(error instanceof EnrichmentError)) return { outcome: "throw" };
  if (source === "dataforseo") {
    return ["not_dispatched", "zero_cost_proven"].includes(error.paidOutcome)
      ? { outcome: "unavailable", ledger: "failed" }
      : { outcome: "ambiguous", ledger: "ambiguous" };
  }
  if (error.code === ENRICHMENT_ERROR_CODES.contractMismatch)
    return { outcome: "contract_mismatch" };
  const status = error.httpStatus || 0;
  if (source === "crux_bigquery" && ["table", "dry"].includes(phase) &&
      (status === 0 || TRANSIENT_HTTP_STATUSES.has(status)) && leaseAttempt < 3)
    return { outcome: "retry" };
  if (status === 0) return { outcome: "ambiguous" };
  return { outcome: "unavailable" };
}

export function assertTrafficCallCeilings(counts, domainCount) {
  const maximum = { dataForSeoAdapter: 10, cruxRestAdapter: domainCount,
    cruxRestHttp: domainCount * 3, bigQueryTableAdapter: 3, bigQueryTableHttp: 6,
    bigQueryDryAdapter: 3, bigQueryDryHttp: 6, bigQueryLiveAdapter: 1, bigQueryLiveHttp: 2 };
  for (const [key, limit] of Object.entries(maximum)) {
    if (!Number.isInteger(counts[key] || 0) || (counts[key] || 0) > limit)
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  return maximum;
}
