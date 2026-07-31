import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicUrl, normalizeHostname } from "../src/url-security.js";
import {
  evaluateStoreFit,
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

test("Google metadata cannot manufacture fetched storefront relevance", () => {
  const result = validateStorefront({
    resolvedDomain: "fixture.myshopify.com",
    myshopifyDomain: "fixture.myshopify.com",
    finalUrl: "https://fixture.myshopify.com/products/item",
    query: "site:myshopify.com/products organic coffee",
    shopType: "organic coffee",
    title: "Organic Coffee Store",
    snippet: "Organic coffee beans and roasts",
    html: `<html><body><script src="/cdn/shop/theme.js"></script>${"unrelated stationery and office supplies ".repeat(8)}</body></html>`
  }, { minRelevanceScore: 15 }, { final: true });
  assert.equal(result.storeFit.state, "mismatch");
  assert.equal(result.relevanceScore, 0);
  assert.equal(result.rejectionReason, "wrong_category");
});

test("an initially blocked representative page defers rejection until homepage evidence", () => {
  const candidate = {
    resolvedDomain: "blocked.myshopify.com",
    myshopifyDomain: "blocked.myshopify.com",
    finalUrl: "https://blocked.myshopify.com/products/frame",
    shopType: "eyewear",
    html: "<html><body>Checking your browser. Verify you are human.</body></html>"
  };
  assert.equal(validateStorefront(candidate, {}, { final: false }).valid, true);
  assert.equal(
    validateStorefront(candidate, {}, { final: true }).rejectionReason,
    "storefront_blocked"
  );
  const withHomepage = {
    ...candidate,
    evidencePages: [{
      url: "https://blocked.myshopify.com/",
      html: `<html><head><title>Fixture Eyewear</title></head><body><script src="/cdn/shop/theme.js"></script>${"Eyewear frames and lenses ".repeat(10)}</body></html>`
    }]
  };
  assert.equal(validateStorefront(withHomepage, {}, { final: true }).valid, true);
});

test("store fit distinguishes a general seller from a specialist and enforces brand intent", () => {
  const seller = {
    resolvedDomain: "general.myshopify.com",
    myshopifyDomain: "general.myshopify.com",
    finalUrl: "https://general.myshopify.com/products/aviator-glasses",
    shopType: "eyewear",
    businessQualifier: "brand",
    categoryVocabulary: ["aviator glasses"],
    html: `<html><body><script src="/cdn/shop/theme.js"></script>${"A large general department catalog ".repeat(8)} Aviator glasses</body></html>`
  };
  const sellerResult = validateStorefront(seller, {}, { final: true });
  assert.equal(sellerResult.storeFit.state, "category_seller");
  assert.equal(sellerResult.rejectionReason, "wrong_store_type");
  assert.equal(validateStorefront({
    ...seller,
    businessQualifier: "retailer"
  }, {}, { final: true }).valid, true);

  const homepageSeller = {
    ...seller,
    finalUrl: "https://general.myshopify.com/",
    html: `<html><head><title>Fixture Department Store</title></head><body><script src="/cdn/shop/theme.js"></script>${"General catalog home garden electronics ".repeat(8)} One eyewear promotion</body></html>`
  };
  assert.equal(evaluateStoreFit(homepageSeller).state, "category_seller");

  const specialist = {
    ...seller,
    finalUrl: "https://general.myshopify.com/",
    html: `<html><head><meta property="og:site_name" content="Fixture Eyewear"></head><body><script src="/cdn/shop/theme.js"></script>${"Independent eyewear studio frames lenses ".repeat(8)}</body></html>`
  };
  const fit = evaluateStoreFit(specialist);
  assert.equal(fit.state, "specialist");
  assert.deepEqual(fit.sourceUrls, ["https://general.myshopify.com/"]);
  assert.equal(validateStorefront(specialist, {}, { final: true }).valid, true);
});
