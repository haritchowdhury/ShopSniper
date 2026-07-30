import { requestText } from "./http-client.js";
import { assertPublicUrl } from "./url-security.js";

function looksUsable(response) {
  return (
    response?.body?.length >= 300 &&
    (response.contentType.includes("html") || /<html|<body|<main/i.test(response.body))
  );
}

export async function fetchPage(url, config, { request = requestText } = {}) {
  let ordinaryResponse;
  let ordinaryError;
  try {
    ordinaryResponse = await request(url, {
      timeoutMs: config.requestTimeoutMs,
      retries: 1
    });
    if (looksUsable(ordinaryResponse)) {
      return { ...ordinaryResponse, rendered: false };
    }
  } catch (error) {
    ordinaryError = error;
  }

  const browserlessTokens = [
    config.browserlessToken,
    config.browserlessFallbackToken
  ].filter((token, index, values) => token && values.indexOf(token) === index);

  if (!browserlessTokens.length || !config.browserlessUrl) {
    if (ordinaryResponse) return { ...ordinaryResponse, rendered: false };
    throw ordinaryError || new Error("Page fetch failed");
  }

  await assertPublicUrl(url);
  const browserlessErrors = [];
  for (const token of browserlessTokens) {
    const browserlessUrl = new URL(config.browserlessUrl);
    browserlessUrl.searchParams.set("token", token);
    try {
      const rendered = await request(browserlessUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          gotoOptions: { waitUntil: "networkidle2", timeout: config.requestTimeoutMs }
        }),
        timeoutMs: config.requestTimeoutMs + 5000,
        retries: 0,
        maxBytes: 3_000_000
      });
      return { ...rendered, finalUrl: url, rendered: true };
    } catch (browserlessError) {
      browserlessErrors.push(browserlessError.message);
    }
  }

  if (ordinaryResponse) return { ...ordinaryResponse, rendered: false };
  throw new Error(
    `Normal fetch and Browserless failed: ${ordinaryError?.message || "unknown"}; ${browserlessErrors.join("; ")}`
  );
}
