import assert from "node:assert/strict";
import test from "node:test";
import { resolveStoreIdentity } from "../src/domain-resolver.js";
import { extractCanonical } from "../src/html.js";
import { parseSitemap, contactLinksFromHtml } from "../src/sitemap.js";

test("canonical link resolves against the fetched URL", () => {
  const html = '<link href="/products/item" rel="canonical">';
  assert.equal(
    extractCanonical(html, "https://example.com/path"),
    "https://example.com/products/item"
  );
});

test("myshopify result resolves to a custom redirect domain", async () => {
  const candidate = await resolveStoreIdentity(
    {
      query: "spices",
      rank: 1,
      url: "https://sample.myshopify.com/products/spice",
      title: "Spice",
      snippet: ""
    },
    { requestTimeoutMs: 1000 },
    {
      request: async () => ({
        body: '<link rel="canonical" href="https://shop.example/products/spice">',
        finalUrl: "https://shop.example/products/spice",
        status: 200,
        contentType: "text/html"
      })
    }
  );
  assert.equal(candidate.myshopifyDomain, "sample.myshopify.com");
  assert.equal(candidate.resolvedDomain, "shop.example");
  assert.equal(candidate.identityConfidence, 100);
  assert(candidate.allowedHostnames.includes("sample.myshopify.com"));
  assert(candidate.allowedHostnames.includes("shop.example"));
});

test("sitemap parser supports indexes and direct urlsets", () => {
  assert.deepEqual(
    parseSitemap(
      '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.test/pages.xml</loc></sitemap></sitemapindex>'
    ),
    { type: "index", urls: ["https://x.test/pages.xml"] }
  );
  assert.deepEqual(
    parseSitemap(
      '<urlset xmlns="x"><url><loc>https://x.test/pages/contact?x=1&amp;y=2</loc></url></urlset>'
    ),
    { type: "urlset", urls: ["https://x.test/pages/contact?x=1&y=2"] }
  );
});

test("contact links stay on verified hosts", () => {
  const links = contactLinksFromHtml(
    '<a href="/pages/contact">Contact</a><a href="https://evil.test/contact">Bad</a>',
    "https://shop.example/",
    ["shop.example"]
  );
  assert.deepEqual(links, ["https://shop.example/pages/contact"]);
});
