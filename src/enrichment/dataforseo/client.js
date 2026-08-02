import { assertDataForSeoConfig } from "../../config.js";
import { HttpError, requestText } from "../../http-client.js";
import { ENRICHMENT_ERROR_CODES, dataForSeoError } from "../errors.js";

function configurationError() {
  return dataForSeoError(
    ENRICHMENT_ERROR_CODES.configuration,
    "DataForSEO credentials are not configured"
  );
}

function mapRequestError(error) {
  const status = error instanceof HttpError ? error.status : 0;
  const ambiguous =
    !status || [408, 425, 429, 500, 502, 503, 504].includes(status) ||
    error?.name === "TimeoutError" || error?.name === "AbortError" ||
    error instanceof TypeError;
  if (ambiguous) {
    return dataForSeoError(
      ENRICHMENT_ERROR_CODES.ambiguousRequest,
      "DataForSEO request outcome is ambiguous",
      { httpStatus: status }
    );
  }
  return dataForSeoError(
    ENRICHMENT_ERROR_CODES.providerHttp,
    "DataForSEO returned an unsuccessful HTTP response",
    { httpStatus: status }
  );
}

export async function executeDataForSeoRequest(
  descriptor,
  config,
  { request = requestText } = {}
) {
  try {
    assertDataForSeoConfig({ ...config, dataForSeoEnrichmentEnabled: true });
  } catch {
    throw configurationError();
  }

  const authorization = Buffer.from(
    `${config.dataForSeoLogin}:${config.dataForSeoPassword}`,
    "utf8"
  ).toString("base64");
  try {
    const response = await request(descriptor.endpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${authorization}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(descriptor.body),
      timeoutMs: config.requestTimeoutMs,
      retries: 0,
      maxRedirects: 0,
      maxBytes: 2_000_000,
      validatePublic: true
    });
    if (response.status !== 200) {
      throw new HttpError("Unexpected HTTP status", { status: response.status });
    }
    return response.body;
  } catch (error) {
    if (error?.code && Object.values(ENRICHMENT_ERROR_CODES).includes(error.code)) {
      throw error;
    }
    throw mapRequestError(error);
  }
}
