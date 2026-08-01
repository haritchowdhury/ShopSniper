import { parseHttpUrl } from "./url-security.js";

export const BROWSERLESS_CONTENT_CONTRACT = "browserless-content-response-headers-v1";

export class BrowserlessContractError extends Error {
  constructor(reason) {
    super(`Browserless response contract violation: ${reason}`);
    this.name = "BrowserlessContractError";
    this.code = "BROWSERLESS_CONTRACT_ERROR";
  }
}

function requiredHeader(response, name) {
  const value = response?.responseHeaders?.[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new BrowserlessContractError(`missing ${name}`);
  }
  return value.trim();
}

export function parseBrowserlessContentResponse(response) {
  if (typeof response?.body !== "string") {
    throw new BrowserlessContractError("body must be text");
  }
  const contentType = String(response.contentType || "").toLowerCase();
  if (!contentType.startsWith("text/html")) {
    throw new BrowserlessContractError("content-type must be text/html");
  }

  const responseCode = requiredHeader(response, "x-response-code");
  if (!/^\d{3}$/u.test(responseCode)) {
    throw new BrowserlessContractError("x-response-code must be a three-digit status");
  }
  const status = Number(responseCode);
  if (status < 100 || status > 599) {
    throw new BrowserlessContractError("x-response-code is outside the HTTP status range");
  }

  let finalUrl;
  try {
    finalUrl = parseHttpUrl(requiredHeader(response, "x-response-url")).href;
  } catch {
    throw new BrowserlessContractError("x-response-url must be an absolute HTTP URL");
  }

  return Object.freeze({
    body: response.body,
    contentType: response.contentType,
    status,
    finalUrl,
    contractVersion: BROWSERLESS_CONTENT_CONTRACT
  });
}
