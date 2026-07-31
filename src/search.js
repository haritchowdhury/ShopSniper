import { z } from "zod";
import { requestText } from "./http-client.js";

export const GOOGLE_SEARCH_CONTRACT_VERSION = "google-custom-search-v1";

const ASSET_EXTENSIONS =
  /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|css|js|map|xml|json|txt|zip|gz|mp4|webm|woff2?|ttf|eot)(?:$|[?#])/i;
const ASSET_HOSTS = /(?:^|\.)cdn\.shopify\.com$|(?:^|\.)shopifycdn\.net$/i;

const googleSearchSchema = z.object({
  kind: z.literal("customsearch#search"),
  items: z.array(z.object({
    title: z.string(),
    link: z.string(),
    snippet: z.string()
  }).passthrough()).optional(),
  searchInformation: z.object({ totalResults: z.string().regex(/^\d+$/) }).passthrough(),
  queries: z.object({
    nextPage: z.array(z.object({ startIndex: z.number().int().positive() }).passthrough()).optional()
  }).passthrough().optional()
}).passthrough();

export class GoogleSearchContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GoogleSearchContractError";
    this.code = code;
    this.contractVersion = GOOGLE_SEARCH_CONTRACT_VERSION;
  }
}

function contractError(code, message) {
  return new GoogleSearchContractError(code, message);
}

export function rejectionReasonForSearchUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "invalid_url";
  }
  if (!["http:", "https:"].includes(url.protocol)) return "unsupported_scheme";
  if (ASSET_EXTENSIONS.test(url.pathname) || ASSET_HOSTS.test(url.hostname)) {
    return "asset_result";
  }
  return "";
}

export function parseGoogleSearchResponse(body, query) {
  let payload;
  try {
    payload = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    throw contractError("invalid_json", "Google Custom Search payload was not valid JSON");
  }
  if (payload?.error) {
    throw contractError("provider_error", "Google Custom Search returned a provider error");
  }
  const parsed = googleSearchSchema.safeParse(payload);
  if (!parsed.success) {
    throw contractError(
      "response_shape_mismatch",
      "Google Custom Search payload did not match the v1 contract"
    );
  }
  const results = (parsed.data.items || []).map((item, index) => ({
    query,
    rank: index + 1,
    url: item.link,
    title: item.title,
    snippet: item.snippet,
    rejectionReason: rejectionReasonForSearchUrl(item.link)
  }));
  return {
    results,
    estimatedTotalResults: Number.parseInt(parsed.data.searchInformation.totalResults, 10),
    nextPageAvailable: Boolean(parsed.data.queries?.nextPage?.length)
  };
}

export async function searchGooglePage(query, config, { request = requestText } = {}) {
  const url = new URL("https://customsearch.googleapis.com/customsearch/v1");
  url.searchParams.set("key", config.googleApiKey);
  url.searchParams.set("cx", config.googleSearchEngineId);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(config.googleResultsPerQuery));

  const response = await request(url, {
    timeoutMs: config.requestTimeoutMs,
    retries: 1,
    maxBytes: 1_000_000
  });
  return parseGoogleSearchResponse(response.body, query);
}

export async function searchGoogle(query, config, dependencies = {}) {
  return (await searchGooglePage(query, config, dependencies)).results;
}
