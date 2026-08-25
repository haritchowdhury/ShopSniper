import assert from "node:assert/strict";
import test from "node:test";
import { fetchAwsDomainPages } from "../src/aws-pipeline/lead/domain-page-fetcher.js";
import {
  createJinaFallbackExecutor,
  executeJinaDomainBatch
} from "../scripts/lib/jina-render-fallback.js";

const taskContext = { assertActive() {} };

test("Jina renderer uses browser-rendered HTML and returns Browserless-compatible documents", async () => {
  const requests = [];
  const result = await executeJinaDomainBatch({
    pages: [{ url: "https://fixture.example/contact", purpose: "evidence" }],
    allowedHostnames: ["fixture.example"],
    taskContext,
    apiKey: "fixture-jina-key"
  }, {
    assertUrl: async () => {},
    now: () => 100,
    request: async (url, options) => {
      requests.push({ url: String(url), options });
      return { body: JSON.stringify({
        code: 200,
        status: 20000,
        data: {
          title: "Fixture",
          url: "https://fixture.example/contact",
          html: "<html><body><a href=\"mailto:test@fixture.example\">Email</a></body></html>",
          httpStatus: 200
        }
      }) };
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://r.jina.ai/https://fixture.example/contact");
  assert.equal(requests[0].options.headers.authorization, "Bearer fixture-jina-key");
  assert.equal(requests[0].options.headers["x-engine"], "browser");
  assert.equal(requests[0].options.headers["x-respond-with"], "html");
  assert.equal(requests[0].options.headers["x-timeout"], "8");
  assert.equal(result.documents[0].requestedUrl, "https://fixture.example/contact");
  assert.equal(result.documents[0].rendered, true);
  assert.equal(result.earlyStopReason, "sufficient_evidence");
});

test("the unchanged domain fetcher sends only failed or unusable HTTP pages to Jina", async () => {
  const renderedPlans = [];
  const request = async (url) => {
    const href = String(url);
    if (href === "https://fixture.example/") {
      return { body: "<html>ordinary storefront</html>", finalUrl: href, status: 200 };
    }
    if (href === "https://fixture.example/contact") {
      return { body: "enable javascript", finalUrl: href, status: 200 };
    }
    throw new Error(`Unexpected request: ${href}`);
  };
  const executeJina = createJinaFallbackExecutor("fixture-jina-key", {
    assertUrl: async () => {},
    now: () => 100,
    request: async (_url, options) => {
      renderedPlans.push(options);
      return { body: JSON.stringify({ code: 200, status: 20000, data: {
        url: "https://fixture.example/contact",
        html: "<html>rendered contact@test.example</html>",
        httpStatus: 200
      } }) };
    }
  });

  const result = await fetchAwsDomainPages({
    candidate: {
      url: "https://fixture.example/",
      finalUrl: "https://fixture.example/",
      allowedHostnames: ["fixture.example"]
    },
    taskContext,
    config: {
      leadFetch: { requestTimeoutMs: 20_000, maxPagesPerStore: 5, pageFetchConcurrency: 2 },
      browserless: { enabled: true }
    }
  }, {
    request,
    assertUrl: async () => {},
    sameHostname: () => true,
    discoverPages: async () => [
      "https://fixture.example/",
      "https://fixture.example/contact"
    ],
    rankPages: (pages) => pages,
    assess: (response) => ({ usable: !response.body.includes("enable javascript") }),
    executeBrowserless: async (input) => {
      assert.deepEqual(input.pages, [
        { url: "https://fixture.example/contact", purpose: "evidence" }
      ]);
      return executeJina(input);
    }
  });

  assert.equal(renderedPlans.length, 1);
  assert.deepEqual(result.documents.map(({ requestedUrl, rendered }) => ({ requestedUrl, rendered })), [
    { requestedUrl: "https://fixture.example/", rendered: false },
    { requestedUrl: "https://fixture.example/contact", rendered: true }
  ]);
});
