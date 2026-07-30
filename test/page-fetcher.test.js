import assert from "node:assert/strict";
import test from "node:test";
import { fetchPage } from "../src/page-fetcher.js";

test("Browserless uses the second configured token when the first one fails", async () => {
  const calls = [];
  const response = await fetchPage(
    "https://8.8.8.8/contact",
    {
      requestTimeoutMs: 1000,
      browserlessUrl: "https://browserless.example/content",
      browserlessToken: "primary",
      browserlessFallbackToken: "secondary"
    },
    {
      request: async (url, options) => {
        calls.push({ url: String(url), method: options.method || "GET" });
        if (calls.length < 3) throw new Error(`failure ${calls.length}`);
        return {
          body: "<html><body>Rendered contact page</body></html>",
          finalUrl: String(url),
          status: 200,
          contentType: "text/html"
        };
      }
    }
  );

  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[1].url).searchParams.get("token"), "primary");
  assert.equal(new URL(calls[2].url).searchParams.get("token"), "secondary");
  assert.equal(response.rendered, true);
  assert.equal(response.finalUrl, "https://8.8.8.8/contact");
});
