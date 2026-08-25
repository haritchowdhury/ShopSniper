import { z } from "zod";
import { requestText } from "../../src/http-client.js";
import { assertPublicUrl, sameAllowedHostname } from "../../src/url-security.js";

const JINA_READER_ORIGIN = "https://r.jina.ai";
const MAX_RENDERED_HTML_BYTES = 1_000_000;
const SESSION_CEILING_MS = 45_000;
const CLIENT_ABORT_MS = 48_000;
const NAVIGATION_TIMEOUT_SECONDS = 8;

const readerProjectionSchema = z.object({
  code: z.literal(200),
  status: z.literal(20000),
  data: z.object({
    title: z.unknown().optional(),
    description: z.unknown().optional(),
    url: z.string().url().max(2048),
    html: z.string(),
    metadata: z.unknown().optional(),
    external: z.unknown().optional(),
    httpStatus: z.number().int().min(200).max(299),
    httpStatusText: z.unknown().optional(),
    usage: z.unknown().optional()
  }).strict(),
  meta: z.unknown().optional()
}).strict();

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function readerEndpoint(targetUrl) {
  return new URL(`${JINA_READER_ORIGIN}/${targetUrl}`);
}

function validateRequestedPage(page, allowedHostnames) {
  const url = new URL(page.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedHostnames.includes(url.hostname)
  ) {
    throw new Error("Jina render target violates the Browserless page boundary");
  }
  return url;
}

function failedResult(inputIndex) {
  return { inputIndex, disposition: "failed" };
}

/**
 * Local-test replacement for executeBrowserlessDomainBatch(). It intentionally
 * accepts and returns the same narrow shape so fetchAwsDomainPages() remains the
 * owner of HTTP-first selection, same-host checks, ranking, and fallback timing.
 */
export async function executeJinaDomainBatch(
  { pages, allowedHostnames, taskContext, apiKey },
  {
    request = requestText,
    assertUrl = assertPublicUrl,
    sameHostname = sameAllowedHostname,
    now = Date.now
  } = {}
) {
  taskContext.assertActive();
  if (!apiKey || !Array.isArray(pages) || pages.length < 1 || pages.length > 5) {
    throw new Error("Jina fallback configuration is invalid");
  }

  const startedAt = now();
  const documents = [];
  const diagnostics = [];
  let earlyStopReason = "pages_exhausted";

  for (let inputIndex = 0; inputIndex < pages.length; inputIndex += 1) {
    taskContext.assertActive();
    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= SESSION_CEILING_MS) {
      earlyStopReason = "session_ceiling";
      diagnostics.push(failedResult(inputIndex));
      continue;
    }

    try {
      const requested = validateRequestedPage(pages[inputIndex], allowedHostnames);
      await assertUrl(requested);
      const remainingMs = Math.max(1, SESSION_CEILING_MS - elapsedMs);
      const response = await request(readerEndpoint(requested.href), {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "x-engine": "browser",
          "x-respond-with": "html",
          "x-timeout": String(NAVIGATION_TIMEOUT_SECONDS),
          "x-no-cache": "true"
        },
        timeoutMs: Math.min(CLIENT_ABORT_MS, remainingMs),
        retries: 0,
        maxBytes: 1_250_000
      });
      let decoded;
      try {
        decoded = JSON.parse(response.body);
      } catch {
        throw new Error("JinaReaderContractError");
      }
      const parsed = readerProjectionSchema.safeParse(decoded);
      if (!parsed.success) throw new Error("JinaReaderContractError");

      const finalUrl = new URL(parsed.data.data.url);
      if (
        finalUrl.protocol !== "https:" ||
        finalUrl.username ||
        finalUrl.password ||
        !sameHostname(finalUrl, allowedHostnames) ||
        byteLength(parsed.data.data.html) > MAX_RENDERED_HTML_BYTES
      ) {
        throw new Error("JinaReaderContractError");
      }
      await assertUrl(finalUrl);

      documents.push({
        requestedUrl: requested.href,
        finalUrl: finalUrl.href,
        body: parsed.data.data.html,
        status: parsed.data.data.httpStatus,
        rendered: true
      });
      diagnostics.push({ inputIndex, disposition: "rendered" });

      if (/(?:mailto:|tel:|@[a-z0-9.-]+\.[a-z]{2,})/iu.test(parsed.data.data.html)) {
        earlyStopReason = "sufficient_evidence";
        for (let skippedIndex = inputIndex + 1; skippedIndex < pages.length; skippedIndex += 1) {
          diagnostics.push({ inputIndex: skippedIndex, disposition: "skipped" });
        }
        break;
      }
    } catch {
      diagnostics.push(failedResult(inputIndex));
    }
  }

  return {
    documents,
    diagnostics,
    earlyStopReason,
    durationMs: Math.min(Math.max(0, now() - startedAt), SESSION_CEILING_MS)
  };
}

export function createJinaFallbackExecutor(apiKey, dependencyOverrides = {}) {
  return ({ pages, allowedHostnames, taskContext }) => executeJinaDomainBatch(
    { pages, allowedHostnames, taskContext, apiKey },
    dependencyOverrides
  );
}
