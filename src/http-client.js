import { assertPublicUrl, parseHttpUrl } from "./url-security.js";

export class HttpError extends Error {
  constructor(message, { status = 0, url = "", body = "", code = "HTTP_ERROR" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
    this.code = code;
  }
}

export class HttpResponseSizeLimitError extends HttpError {
  constructor(maxBytes, { status = 0, url = "" } = {}) {
    super(`Response exceeds ${maxBytes} bytes`, {
      status,
      url,
      code: "HTTP_RESPONSE_SIZE_LIMIT"
    });
    this.name = "HttpResponseSizeLimitError";
    this.maxBytes = maxBytes;
  }
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cancelBody(body, reason) {
  if (!body) return;
  try {
    await body.cancel(reason);
  } catch {
    // Cancellation is best-effort after the response has already failed safely.
  }
}

export async function readLimitedText(response, maxBytes, responseUrl = response.url) {
  const declared = response.headers.get("content-length");
  const contentLength = /^\d+$/u.test(declared || "") ? Number(declared) : null;
  if (contentLength != null && contentLength > maxBytes) {
    await cancelBody(response.body, "declared response size exceeds limit");
    throw new HttpResponseSizeLimitError(maxBytes, {
      status: response.status,
      url: responseUrl
    });
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        try {
          await reader.cancel("streamed response size exceeds limit");
        } catch {
          // The typed size-limit result remains authoritative if cancellation fails.
        }
        throw new HttpResponseSizeLimitError(maxBytes, {
          status: response.status,
          url: responseUrl
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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
    responseHeaderNames = [],
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

        const responseBody = await readLimitedText(response, maxBytes, currentUrl.href);
        if (!response.ok) {
          throw new HttpError(`HTTP ${response.status}`, {
            status: response.status,
            url: currentUrl.href,
            body: responseBody.slice(0, 500)
          });
        }
        const responseHeaders = Object.fromEntries(
          responseHeaderNames.map((name) => {
            const normalized = String(name).toLowerCase();
            return [normalized, response.headers.get(normalized) || ""];
          })
        );
        return {
          body: responseBody,
          status: response.status,
          finalUrl: currentUrl.href,
          contentType: response.headers.get("content-type") || "",
          responseHeaders
        };
      }
    } catch (error) {
      lastError = error;
      const transient =
        error?.name === "TimeoutError" ||
        error?.name === "AbortError" ||
        error instanceof TypeError ||
        (error instanceof HttpError &&
          error.code !== "HTTP_RESPONSE_SIZE_LIMIT" &&
          TRANSIENT_STATUSES.has(error.status));
      if (attempt >= retries || !transient) throw error;
      await wait(250 * 2 ** attempt);
    }
  }
  throw lastError;
}
