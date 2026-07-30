import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicUrl, normalizeHostname } from "../src/url-security.js";
import {
  queryTerms,
  relevanceScore,
  validateStorefront
} from "../src/storefront-validator.js";

test("URL safety rejects loopback and private literal addresses", async () => {
  await assert.rejects(assertPublicUrl("http://127.0.0.1"), /private network/);
  await assert.rejects(assertPublicUrl("http://10.0.0.1"), /private network/);
  await assert.rejects(assertPublicUrl("http://[::1]"), /private network/);
  assert.equal(normalizeHostname("WWW.Example.COM."), "example.com");
});

test("relevance ignores search operators and common Shopify words", () => {
  assert.deepEqual(
    queryTerms('site:myshopify.com/products "organic coffee brands"'),
    ["organic", "coffee"]
  );
  assert.equal(relevanceScore("organic coffee", "Fresh organic coffee beans"), 100);
});

test("password-protected Shopify storefront is rejected as inactive", () => {
  const result = validateStorefront(
    {
      resolvedDomain: "example.com",
      myshopifyDomain: "example.myshopify.com",
      query: "organic coffee",
      title: "Organic Coffee",
      snippet: "",
      html: `
        <html><body class="password">
          Enter using password
          <script src="/cdn/shop/theme.js"></script>
          Organic coffee opening soon
        </body></html>
      `
    },
    { minRelevanceScore: 15 }
  );
  assert.equal(result.valid, false);
  assert.equal(result.rejectionReason, "inactive_store");
});
