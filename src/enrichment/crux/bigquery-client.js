import { GoogleAuth } from "google-auth-library";
import { assertCruxConfig } from "../../config.js";
import { HttpError, requestText } from "../../http-client.js";
import { ENRICHMENT_ERROR_CODES, cruxError } from "../errors.js";
import { CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION } from "./bigquery-request.js";

function safeError(code, message, options = {}) {
  return cruxError(code, message, CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION, options);
}

export async function defaultCruxTokenProvider(credentials) {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/bigquery"],
    ...(credentials && { credentials })
  });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result?.token;
  if (!token) throw new Error("Google access token unavailable");
  return token;
}

export async function executeCruxBigQueryRequest(
  descriptor,
  config,
  { request = requestText, tokenProvider = defaultCruxTokenProvider } = {}
) {
  try {
    assertCruxConfig({ ...config, cruxEnrichmentEnabled: true });
  } catch {
    throw safeError(
      ENRICHMENT_ERROR_CODES.configuration,
      "CrUX configuration is incomplete"
    );
  }

  let token;
  try {
    token = await tokenProvider(config.googleApplicationCredentials);
    if (typeof token !== "string" || !token) throw new Error("missing token");
  } catch {
    throw safeError(
      ENRICHMENT_ERROR_CODES.configuration,
      "Google authentication is unavailable"
    );
  }

  try {
    const response = await request(descriptor.endpoint, {
      method: descriptor.method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(descriptor.body && { "content-type": "application/json" })
      },
      ...(descriptor.body && { body: JSON.stringify(descriptor.body) }),
      timeoutMs: config.requestTimeoutMs,
      retries: 1,
      maxRedirects: 0,
      maxBytes: 2_000_000,
      validatePublic: true
    });
    if (response.status !== 200) {
      throw new HttpError("Unexpected HTTP status", { status: response.status });
    }
    return response.body;
  } catch (error) {
    throw safeError(
      ENRICHMENT_ERROR_CODES.providerHttp,
      "CrUX BigQuery request failed",
      { httpStatus: error instanceof HttpError ? error.status : 0 }
    );
  }
}
