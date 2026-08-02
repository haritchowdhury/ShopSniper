export const ENRICHMENT_ERROR_CODES = Object.freeze({
  configuration: "configuration_error",
  invalidRequest: "invalid_request",
  ambiguousRequest: "provider_request_ambiguous",
  providerHttp: "provider_http_error",
  providerRejected: "provider_rejected",
  contractMismatch: "provider_contract_mismatch"
});

export class EnrichmentError extends Error {
  constructor(message, {
    code,
    provider,
    contractVersion,
    retryable = false,
    httpStatus = 0,
    paidOutcome = "possibly_charged"
  }) {
    super(message);
    this.name = "EnrichmentError";
    this.code = code;
    this.provider = provider;
    this.contractVersion = contractVersion;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.paidOutcome = paidOutcome;
  }
}

export function dataForSeoError(code, message, options = {}) {
  return new EnrichmentError(message, {
    code,
    provider: "dataforseo",
    contractVersion: "dataforseo-bulk-traffic-v1",
    ...options
  });
}

export function cruxError(code, message, contractVersion, options = {}) {
  return new EnrichmentError(message, {
    code,
    provider: "crux",
    contractVersion,
    ...options
  });
}
