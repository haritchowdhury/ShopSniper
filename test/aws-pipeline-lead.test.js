import assert from "node:assert/strict";
import test from "node:test";
import { buildAiNormalizationInput, normalizeWithAi } from "../src/ai-normalizer.js";
import { executeBrowserlessDomainBatch } from "../src/aws-pipeline/lead/browserless-function-client.js";

const candidate = { resolvedDomain: "fixture.example", stableIdentity: "fixture.myshopify.com",
  allowedHostnames: ["fixture.example"] };
const evidence = { storeName: "Fixture", allEmails: [], allPhones: [], contactUrl: "",
  socialProfiles: [], snippets: ["one", "two", "three", "four", "five", "six"] };
const browserlessInput = { pages: [{ url: "https://fixture.example/contact", purpose: "evidence" }],
  allowedHostnames: ["fixture.example"], taskContext: { assertActive() {} },
  config: { enabled: true, origin: "https://production-sfo.browserless.io/",
    primaryToken: "primary", fallbackToken: "fallback", navigationTimeoutMs: 8000,
    requestTimeoutMs: 45000, clientAbortMs: 48000 } };

test("AI normalization input is deterministic, bounded, and can skip before HTTP", async () => {
  const config = { openaiModel: "fixture-model", openaiApiKey: "secret", enableAiNormalization: true,
    requestTimeoutMs: 1000 };
  const input = buildAiNormalizationInput(candidate, evidence, config);
  assert.equal(input.candidateStableIdentity, candidate.stableIdentity);
  assert.equal(input.suppliedEvidence.page_excerpts.length, 5);
  let requests = 0;
  const result = await normalizeWithAi(candidate, evidence, config, {
    request: async () => { requests += 1; throw new Error("must not run"); },
    beforeDispatch: async ({ clientRequestId }) => {
      assert.match(clientRequestId, /^openai-[a-f0-9]{32}$/u); return "skip";
    }
  });
  assert.equal(result, null);
  assert.equal(requests, 0);
});

test("Browserless uses one primary session and the 48 second outer timeout", async () => {
  const calls = [];
  const result = await executeBrowserlessDomainBatch(browserlessInput, {
    now: () => new Date("2026-08-12T00:00:00.000Z"),
    request: async (url, options) => {
      calls.push({ url: String(url), options });
      return { body: JSON.stringify({ type: "application/json", data: {
        contractVersion: "browserless-domain-render-documents-v1", activeSessionCount: 1,
        pageLimit: 1, successes: 1, earlyStopReason: "pages_exhausted", durationMs: 10,
        cleanup: "automatic_function_api", results: [{ inputIndex: 0, disposition: "rendered",
          status: 200, finalPath: "/contact", durationMs: 10, html: "<main>fixture</main>" }] } }) };
    }
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/function\?token=primary$/u);
  assert.equal(calls[0].options.timeoutMs, 48000);
  assert.equal(result.documents.length, 1);
});

test("Browserless fallback is status-only, delayed once for 429, and unknown outcomes do not retry", async () => {
  const delays = [];
  let calls = 0;
  await assert.rejects(() => executeBrowserlessDomainBatch(browserlessInput, { request: async () => {
    calls += 1; const error = new Error("ignored body"); error.status = calls === 1 ? 429 : 500; throw error;
  }, random: () => 1, delay: async (ms) => delays.push(ms) }), /PIPELINE_PROVIDER_AMBIGUOUS/u);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [751]);
  calls = 0;
  await assert.rejects(() => executeBrowserlessDomainBatch(browserlessInput, { request: async () => {
    calls += 1; throw new Error("unknown outcome");
  } }), /PIPELINE_PROVIDER_AMBIGUOUS/u);
  assert.equal(calls, 1);
});
