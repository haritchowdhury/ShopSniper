import { assertPublicUrl, parseHttpUrl } from "./url-security.js";

export class HttpError extends Error {
  constructor(message, { status = 0, url = "", body = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLimitedText(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new HttpError(`Response exceeds ${maxBytes} bytes`, {
      status: response.status,
      url: response.url
    });
  }
  const text = await response.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

export async function requestText(
  input,
  {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 20000,
    retries = 1,
    maxRedirects = 5,
    maxBytes = 2_000_000,
    validatePublic = true,
    fetchImpl = globalThis.fetch
  } = {}
) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      let currentUrl = parseHttpUrl(input);
      for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        if (validatePublic) await assertPublicUrl(currentUrl);
        const response = await fetchImpl(currentUrl, {
          method,
          headers: {
            "user-agent": "ShopifyLeadGenerator/1.0",
            accept: "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
            ...headers
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs)
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            throw new HttpError(`Redirect response has no Location header`, {
              status: response.status,
              url: currentUrl.href
            });
          }
          if (redirect === maxRedirects) {
            throw new HttpError("Too many redirects", {
              status: response.status,
              url: currentUrl.href
            });
          }
          currentUrl = parseHttpUrl(location, currentUrl);
          continue;
        }

        const responseBody = await readLimitedText(response, maxBytes);
        if (!response.ok) {
          throw new HttpError(`HTTP ${response.status}`, {
            status: response.status,
            url: currentUrl.href,
            body: responseBody.slice(0, 500)
          });
        }
        return {
          body: responseBody,
          status: response.status,
          finalUrl: currentUrl.href,
          contentType: response.headers.get("content-type") || ""
        };
      }
    } catch (error) {
      lastError = error;
      const transient =
        error?.name === "TimeoutError" ||
        error?.name === "AbortError" ||
        error instanceof TypeError ||
        (error instanceof HttpError && TRANSIENT_STATUSES.has(error.status));
      if (attempt >= retries || !transient) throw error;
      await wait(250 * 2 ** attempt);
    }
  }
  throw lastError;
}
