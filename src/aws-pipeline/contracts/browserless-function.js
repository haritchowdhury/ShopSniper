import { z } from "zod";
import { PipelineContractError } from "./errors.js";

export const BROWSERLESS_FUNCTION_CONTRACT = "browserless-domain-render-documents-v1";
const path = z.string().startsWith("/").max(2048).refine((value) => !value.includes("?") && !value.includes("#"));
const duration = z.number().int().nonnegative().max(45000);
const rendered = z.object({ inputIndex: z.number().int().min(0).max(4), disposition: z.literal("rendered"),
  status: z.number().int().min(200).max(299), finalPath: path, durationMs: duration,
  html: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 1000000)
}).strict();
const rejected = z.object({ inputIndex: z.number().int().min(0).max(4), disposition: z.literal("rejected"),
  reason: z.enum(["host_not_allowed", "redirect_host_not_allowed"]), durationMs: duration.optional() }).strict();
const skipped = z.object({ inputIndex: z.number().int().min(0).max(4), disposition: z.literal("skipped"),
  reason: z.literal("sufficient_evidence") }).strict();
const failed = z.object({ inputIndex: z.number().int().min(0).max(4), disposition: z.literal("failed"),
  status: z.number().int().min(100).max(599).optional(), errorType: z.string().min(1).max(128), durationMs: duration.optional() }).strict();
export const browserlessFunctionEnvelopeSchema = z.object({
  data: z.object({ contractVersion: z.literal(BROWSERLESS_FUNCTION_CONTRACT), activeSessionCount: z.literal(1),
    pageLimit: z.number().int().min(1).max(5), successes: z.number().int().min(0).max(5),
    earlyStopReason: z.enum(["sufficient_evidence", "pages_exhausted", "session_ceiling"]), durationMs: duration,
    cleanup: z.literal("automatic_function_api"), results: z.array(z.discriminatedUnion("disposition", [rendered, rejected, skipped, failed])).min(1).max(5)
  }).strict(), type: z.literal("application/json")
}).strict().superRefine((value, context) => {
  if (value.data.results.length !== value.data.pageLimit ||
      value.data.successes !== value.data.results.filter((result) => result.disposition === "rendered").length) {
    context.addIssue({ code: "custom", message: "result counts" });
  }
  const indexes = value.data.results.map(({ inputIndex }) => inputIndex);
  if (indexes.some((index, position) => index !== position)) context.addIssue({ code: "custom", message: "result order" });
});

const requestSchema = z.object({ pages: z.array(z.object({ url: z.string().url().max(2048), purpose: z.string().max(128) }).strict()).min(1).max(5),
  allowedHostnames: z.array(z.string().min(1).max(253)).min(1).max(20), stopOnSufficientEvidence: z.boolean().default(true) }).strict();

export function buildBrowserlessFunctionRequest(input) {
  const parsed = requestSchema.parse(input);
  for (const page of parsed.pages) {
    const url = new URL(page.url);
    if (url.protocol !== "https:" || url.username || url.password || !parsed.allowedHostnames.includes(url.hostname)) {
      throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
    }
  }
  return {
    code: `module.exports = async ({ page, context }) => {
  const startedAt = Date.now();
  const results = [];
  let successes = 0;
  let earlyStopReason = "pages_exhausted";
  for (let inputIndex = 0; inputIndex < context.pages.length; inputIndex += 1) {
    if (Date.now() - startedAt >= context.sessionCeilingMs) {
      earlyStopReason = "session_ceiling";
      results.push({ inputIndex, disposition: "failed", errorType: "session_ceiling" });
      continue;
    }
    const input = context.pages[inputIndex];
    const requested = new URL(input.url);
    if (!context.allowedHostnames.includes(requested.hostname)) {
      results.push({ inputIndex, disposition: "rejected", reason: "host_not_allowed" });
      continue;
    }
    const pageStartedAt = Date.now();
    try {
      const response = await page.goto(input.url, {
        waitUntil: "domcontentloaded",
        timeout: context.navigationTimeoutMs
      });
      const final = new URL(page.url());
      if (!context.allowedHostnames.includes(final.hostname)) {
        results.push({ inputIndex, disposition: "rejected", reason: "redirect_host_not_allowed",
          durationMs: Date.now() - pageStartedAt });
        continue;
      }
      const status = response?.status() || 0;
      if (status < 200 || status > 299) {
        results.push({ inputIndex, disposition: "failed", status, errorType: "http_status",
          durationMs: Date.now() - pageStartedAt });
        continue;
      }
      const html = await page.content();
      results.push({ inputIndex, disposition: "rendered", status,
        finalPath: final.pathname, durationMs: Date.now() - pageStartedAt, html });
      successes += 1;
      if (context.stopOnSufficientEvidence && /(?:mailto:|tel:|@[a-z0-9.-]+\.[a-z]{2,})/iu.test(html)) {
        earlyStopReason = "sufficient_evidence";
        for (let skippedIndex = inputIndex + 1; skippedIndex < context.pages.length; skippedIndex += 1) {
          results.push({ inputIndex: skippedIndex, disposition: "skipped", reason: "sufficient_evidence" });
        }
        break;
      }
    } catch (error) {
      results.push({ inputIndex, disposition: "failed", errorType: error?.name || "navigation_failed",
        durationMs: Math.min(Date.now() - pageStartedAt, context.sessionCeilingMs) });
    }
  }
  return { contractVersion: context.contractVersion, activeSessionCount: 1,
    pageLimit: context.pages.length, successes, earlyStopReason,
    durationMs: Math.min(Date.now() - startedAt, context.sessionCeilingMs),
    cleanup: "automatic_function_api", results };
};`,
    context: { contractVersion: BROWSERLESS_FUNCTION_CONTRACT, ...parsed, navigationTimeoutMs: 8000, sessionCeilingMs: 45000 }
  };
}

export function parseBrowserlessFunctionEnvelope(value) {
  const result = browserlessFunctionEnvelopeSchema.safeParse(value);
  if (!result.success) throw new PipelineContractError("PIPELINE_CONTRACT_DRIFT");
  return result.data;
}
