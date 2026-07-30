import { requestText } from "./http-client.js";

const ASSET_EXTENSIONS =
  /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|css|js|map|xml|json|txt|zip|gz|mp4|webm|woff2?|ttf|eot)(?:$|[?#])/i;
const ASSET_HOSTS = /(?:^|\.)cdn\.shopify\.com$|(?:^|\.)shopifycdn\.net$/i;

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
  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error("Google Custom Search returned invalid JSON");
  }
  if (payload.error) {
    throw new Error(`Google Custom Search error: ${payload.error.message || "unknown error"}`);
  }

  const results = (payload.items || []).map((item, index) => ({
    query,
    rank: index + 1,
    url: item.link || "",
    title: item.title || "",
    snippet: item.snippet || "",
    rejectionReason: rejectionReasonForSearchUrl(item.link || "")
  }));

  return {
    results,
    estimatedTotalResults: Number.parseInt(
      payload.searchInformation?.totalResults || "0",
      10
    ) || 0,
    nextPageAvailable: Boolean(payload.queries?.nextPage?.length)
  };
}

export async function searchGoogle(query, config, dependencies = {}) {
  const page = await searchGooglePage(query, config, dependencies);
  return page.results;
}
