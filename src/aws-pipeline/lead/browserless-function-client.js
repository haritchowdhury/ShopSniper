import { requestText } from "../../http-client.js";
import {
  buildBrowserlessFunctionRequest,
  parseBrowserlessFunctionEnvelope
} from "../contracts/browserless-function.js";
import { PipelineInvariantError } from "../contracts/errors.js";

const FALLBACK_STATUSES = new Set([401, 403, 429]);

function parseOuterBody(body) {
  try { return JSON.parse(body); }
  catch { throw new PipelineInvariantError("PIPELINE_PROVIDER_AMBIGUOUS"); }
}

export async function executeBrowserlessDomainBatch(
  { pages, allowedHostnames, taskContext, config },
  { request = requestText, now = () => new Date(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random } = {}
) {
  taskContext.assertActive();
  if (config.navigationTimeoutMs !== 8000 || config.requestTimeoutMs !== 45000 ||
      config.clientAbortMs !== 48000) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const tokens = [config.primaryToken, config.fallbackToken]
    .filter((value, index, values) => value && values.indexOf(value) === index);
  if (!config.enabled || !tokens.length) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const payload = buildBrowserlessFunctionRequest({ pages, allowedHostnames,
    stopOnSufficientEvidence: true });
  const startedAt = now();
  let envelope;
  for (let index = 0; index < tokens.length; index += 1) {
    taskContext.assertActive();
    const endpoint = new URL("/function", config.origin);
    endpoint.searchParams.set("token", tokens[index]);
    try {
      const response = await request(endpoint, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        timeoutMs: 48000, retries: 0, maxBytes: 5000000 });
      envelope = parseBrowserlessFunctionEnvelope(parseOuterBody(response.body));
      break;
    } catch (error) {
      const mayFallback = index === 0 && tokens.length > 1 && FALLBACK_STATUSES.has(error?.status);
      if (!mayFallback) throw new PipelineInvariantError("PIPELINE_PROVIDER_AMBIGUOUS");
      if (error.status === 429) await delay(250 + Math.floor(random() * 501));
    }
  }
  if (!envelope) throw new PipelineInvariantError("PIPELINE_PROVIDER_AMBIGUOUS");
  const documents = envelope.data.results.flatMap((result) => {
    if (result.disposition !== "rendered") return [];
    const requested = pages[result.inputIndex];
    const finalUrl = new URL(result.finalPath, requested.url).href;
    return [{ requestedUrl: requested.url, finalUrl, body: result.html,
      status: result.status, rendered: true }];
  });
  return { documents,
    diagnostics: envelope.data.results.map(({ inputIndex, disposition }) => ({ inputIndex, disposition })),
    earlyStopReason: envelope.data.earlyStopReason,
    durationMs: Math.min(envelope.data.durationMs,
      Math.max(0, now().getTime() - startedAt.getTime())) };
}
