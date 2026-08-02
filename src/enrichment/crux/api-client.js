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
  {
    request = requestText,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  } = {}
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
  let lastError;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      const response = await request(endpoint.href, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(descriptor.body),
        timeoutMs: config.requestTimeoutMs,
        retries: 0,
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
      lastError = error;
      const retryable =
        error?.name === "TimeoutError" ||
        error?.name === "AbortError" ||
        error instanceof TypeError ||
        (error instanceof HttpError && [500, 502, 503, 504].includes(error.status));
      if (!retryable || attempt === 2) break;
      await delay(250 * 2 ** attempt);
    }
  }
  throw safeError(
    ENRICHMENT_ERROR_CODES.providerHttp,
    "CrUX REST request failed",
    { httpStatus: lastError instanceof HttpError ? lastError.status : 0, retryable: false }
  );
}
