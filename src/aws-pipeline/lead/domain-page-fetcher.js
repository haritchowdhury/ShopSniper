import { requestText } from "../../http-client.js";
import { discoverStorePages, rankStorePageUrls } from "../../sitemap.js";
import { assessPageResponse } from "../../page-fetcher.js";
import { assertPublicUrl, sameAllowedHostname } from "../../url-security.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { executeBrowserlessDomainBatch } from "./browserless-function-client.js";

export async function fetchAwsDomainPages(
  { candidate, taskContext, config },
  { request = requestText, discoverPages = discoverStorePages, rankPages = rankStorePageUrls,
    assess = assessPageResponse, assertUrl = assertPublicUrl,
    sameHostname = sameAllowedHostname, executeBrowserless = executeBrowserlessDomainBatch } = {}
) {
  taskContext.assertActive();
  if (config.leadFetch.maxPagesPerStore !== 5 || config.leadFetch.pageFetchConcurrency !== 2)
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const ordinaryConfig = { requestTimeoutMs: config.leadFetch.requestTimeoutMs,
    maxPagesPerStore: 5, pageFetchConcurrency: 2, browserlessEnabled: false };
  const target = candidate.finalUrl || candidate.url;
  await assertUrl(target);
  const storefront = await request(target, { timeoutMs: ordinaryConfig.requestTimeoutMs,
    retries: 1, maxBytes: 2000000 });
  if (!sameHostname(storefront.finalUrl, candidate.allowedHostnames))
    throw new PipelineInvariantError("PIPELINE_IDENTITY_MISMATCH");
  const prepared = { ...candidate, html: storefront.body, finalUrl: storefront.finalUrl,
    initialFetch: { rendered: false, assessment: assess(storefront, { purpose: "storefront" }) } };
  let discovered;
  try { discovered = await discoverPages(prepared, ordinaryConfig, { request }); }
  catch { discovered = [prepared.finalUrl]; }
  const ranked = rankPages(discovered, prepared, 5);
  const ordinary = [];
  const renderPlan = [];
  for (const url of ranked) {
    taskContext.assertActive();
    const purpose = new URL(url).pathname === "/" ? "storefront" : "evidence";
    let response = url === prepared.finalUrl
      ? storefront
      : null;
    try {
      response ??= await request(url, { timeoutMs: ordinaryConfig.requestTimeoutMs,
        retries: 1, maxBytes: 2000000 });
      if (!sameHostname(response.finalUrl, prepared.allowedHostnames))
        throw new PipelineInvariantError("PIPELINE_IDENTITY_MISMATCH");
      const fetchAssessment = assess(response, { purpose });
      if (fetchAssessment.usable) ordinary.push({ requestedUrl: url, finalUrl: response.finalUrl,
        body: response.body, status: response.status, fetchAssessment, rendered: false });
      else renderPlan.push({ url, purpose });
    } catch { renderPlan.push({ url, purpose }); }
  }
  let rendered = { documents: [], diagnostics: [], earlyStopReason: "pages_exhausted", durationMs: 0 };
  if (renderPlan.length && config.browserless.enabled) {
    rendered = await executeBrowserless({ pages: renderPlan,
      allowedHostnames: prepared.allowedHostnames, taskContext, config: config.browserless });
  }
  const renderedByUrl = new Map(rendered.documents.map((item) => [item.requestedUrl, item]));
  const ordinaryByUrl = new Map(ordinary.map((item) => [item.requestedUrl, item]));
  const documents = ranked.flatMap((url) => ordinaryByUrl.get(url) || renderedByUrl.get(url) || []);
  return { candidate: prepared, documents: documents.slice(0, 5), diagnostics: rendered.diagnostics };
}
