import assert from "node:assert/strict";
import test from "node:test";
import { resolveStoreIdentity } from "../src/domain-resolver.js";
import { extractCanonical } from "../src/html.js";
import {
  contactLinksFromHtml,
  parseSitemap,
  rankStorePageUrls
} from "../src/sitemap.js";

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
  assert.equal(candidate.stableIdentity, "sample.myshopify.com");
  assert.equal(candidate.identityEvidence.canonical.trusted, true);
  assert(candidate.allowedHostnames.includes("sample.myshopify.com"));
  assert(candidate.allowedHostnames.includes("shop.example"));
});

test("cross-domain canonical remains evidence-only and outside fetch scope", async () => {
  const candidate = await resolveStoreIdentity(
    { url: "https://fixture-store.myshopify.com/products/item" },
    { requestTimeoutMs: 1000 },
    {
      request: async () => ({
        body: '<link rel="canonical" href="https://unrelated-canonical.dev/products/item">',
        finalUrl: "https://fixture-store.myshopify.com/products/item",
        status: 200,
        contentType: "text/html"
      })
    }
  );
  assert.equal(candidate.resolvedDomain, "fixture-store.myshopify.com");
  assert.equal(candidate.stableIdentity, "fixture-store.myshopify.com");
  assert.equal(candidate.identityConfidence, 70);
  assert.deepEqual(candidate.allowedHostnames, ["fixture-store.myshopify.com"]);
  assert.equal(candidate.identityEvidence.canonical.hostname, "unrelated-canonical.dev");
  assert.equal(candidate.identityEvidence.canonical.trusted, false);
  assert.equal(
    candidate.identityEvidence.canonical.reason,
    "cross_domain_canonical_unverified"
  );
});

test("same-host canonical remains usable without widening fetch scope", async () => {
  const candidate = await resolveStoreIdentity(
    { url: "https://fictional-shop.dev/products/item" },
    { requestTimeoutMs: 1000 },
    {
      request: async () => ({
        body: '<link rel="canonical" href="https://fictional-shop.dev/products/canonical-item">',
        finalUrl: "https://fictional-shop.dev/products/item",
        status: 200,
        contentType: "text/html"
      })
    }
  );
  assert.equal(candidate.resolvedDomain, "fictional-shop.dev");
  assert.deepEqual(candidate.allowedHostnames, ["fictional-shop.dev"]);
  assert.equal(candidate.identityEvidence.canonical.trusted, true);
});

test("initial identity resolution uses the storefront render policy", async () => {
  let purpose;
  const candidate = await resolveStoreIdentity(
    { url: "https://rendered.myshopify.com/products/frame" },
    { requestTimeoutMs: 1000 },
    {
      fetch: async (_url, _config, options) => {
        purpose = options.purpose;
        return {
          body: `<html><body><script src="/cdn/shop/theme.js"></script>${"Rendered eyewear ".repeat(10)}</body></html>`,
          finalUrl: "https://rendered.myshopify.com/products/frame",
          rendered: true,
          renderAttempted: true,
          fetchAssessment: { usable: true, reason: "usable_html" }
        };
      }
    }
  );
  assert.equal(purpose, "storefront");
  assert.deepEqual(candidate.initialFetch, {
    rendered: true,
    renderAttempted: true,
    assessment: { usable: true, reason: "usable_html" }
  });
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

test("contact discovery uses the strict route classifier", () => {
  const links = contactLinksFromHtml(
    `
      <a href="/products/customer-support-widget">Product</a>
      <a href="/collections/contact-lenses">Collection</a>
      <a href="/cdn/theme-support.js">Asset</a>
      <a href="/pages/about-us">About</a>
      <a href="/fr/pages/contact-us">Contact</a>
    `,
    "https://shop.example/",
    ["shop.example"]
  );
  assert.deepEqual(links, [
    "https://shop.example/pages/about-us",
    "https://shop.example/fr/pages/contact-us"
  ]);
});

test("page ranking reserves homepage and explicit contact evidence before products", () => {
  const candidate = {
    finalUrl: "https://shop.example/products/contact-lens-case",
    allowedHostnames: ["shop.example"],
    shopType: "eyewear",
    query: "site:myshopify.com/products aviator frames",
    categoryVocabulary: ["aviator frames"]
  };
  assert.deepEqual(rankStorePageUrls([
    "https://shop.example/products/customer-support-widget",
    "https://shop.example/products/aviator-frames",
    "https://shop.example/pages/about-us",
    "https://shop.example/pages/contact-us",
    "https://shop.example/"
  ], candidate, 3), [
    "https://shop.example/",
    "https://shop.example/pages/contact-us",
    "https://shop.example/pages/about-us"
  ]);
  assert.deepEqual(rankStorePageUrls([
    "https://shop.example/products/customer-support-widget",
    "https://shop.example/products/aviator-frames"
  ], candidate, 10), [
    "https://shop.example/products/aviator-frames"
  ]);
});
