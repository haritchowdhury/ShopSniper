import { assertCruxConfig } from "../../config.js";
import { HttpError, requestText } from "../../http-client.js";
import { ENRICHMENT_ERROR_CODES, cruxError } from "../errors.js";
import { CRUX_API_RESPONSE_CONTRACT_VERSION } from "./api-request.js";
import { parseCruxNotFound } from "./api-contract.js";

function safeError(code, message, options = {}) {
  return cruxError(code, message, CRUX_API_RESPONSE_CONTRACT_VERSION, options);
}

export async function executeCruxApiRequest(
  descriptor,
  config,
  { request = requestText } = {}
) {
  try {
    assertCruxConfig({ ...config, cruxEnrichmentEnabled: true });
  } catch {
    throw safeError(
      ENRICHMENT_ERROR_CODES.configuration,
      "CrUX configuration is incomplete"
    );
  }
  const endpoint = new URL(descriptor.endpoint);
  endpoint.searchParams.set("key", config.cruxApiKey);
  try {
    const response = await request(endpoint.href, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(descriptor.body),
      timeoutMs: config.requestTimeoutMs,
      retries: 2,
      maxRedirects: 0,
      maxBytes: 1_000_000,
      validatePublic: true
    });
    if (response.status === 404) {
      return parseCruxNotFound(response.body);
    }
    if (response.status !== 200) {
      throw new HttpError("Unexpected HTTP status", { status: response.status });
    }
    return response.body;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return parseCruxNotFound(error.body);
    }
    throw safeError(
      ENRICHMENT_ERROR_CODES.providerHttp,
      "CrUX REST request failed",
      { httpStatus: error instanceof HttpError ? error.status : 0, retryable: false }
    );
  }
}
