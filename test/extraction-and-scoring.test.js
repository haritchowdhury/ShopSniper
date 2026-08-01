import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  consolidateEvidence,
  extractContactEvidence,
  normalizeEmail,
  normalizePhone,
  validateEmailCandidate
} from "../src/contact-extractor.js";
import { scoreLead, scoreLeadV2 } from "../src/lead-scorer.js";
import {
  AiNormalizationContractError,
  normalizeWithAi,
  parseAiNormalizationResponse,
  validateAiResult
} from "../src/ai-normalizer.js";
import {
  assessContactPage,
  classifyStorePageUrl,
  validateContactPageUrl,
  validateSocialProfile
} from "../src/contact-evidence.js";

function providerFixture(name) {
  return fs.readFileSync(new URL(`./fixtures/providers/openai/${name}.json`, import.meta.url), "utf8");
}

test("contact extraction keeps evidence and source pages", () => {
  const page = extractContactEvidence({
    url: "https://shop.example/pages/contact",
    html: `
      <title>Example Spices</title>
      <a href="mailto:Hello@Fictional-Spices.dev?subject=Hi">Email</a>
      <a href="tel:+1 (212) 555-0100">Call</a>
      <a href="https://instagram.com/example?ref=site">Instagram</a>
    `
  });
  const combined = consolidateEvidence([page]);
  assert.equal(combined.email, "hello@fictional-spices.dev");
  assert.equal(combined.phone, "+12125550100");
  assert.equal(combined.emailSourceUrl, page.url);
  assert.equal(combined.contactUrl, page.url);
  assert.deepEqual(combined.socialProfiles, ["https://instagram.com/example"]);
});

test("normalizers reject implausible values", () => {
  assert.equal(normalizeEmail("not-an-email"), "");
  assert.equal(normalizePhone("123"), "");
  assert.equal(normalizeEmail("hello@example.com"), "hello@example.com");
  assert.equal(validateEmailCandidate("hello@example.com").accepted, false);
  assert.equal(validateEmailCandidate("noreply@fictional-shop.dev").accepted, false);
});

test("contact routes reject keyword-bearing commerce and asset paths", () => {
  const rejected = [
    "/products/customer-support-widget",
    "/collections/contact-lenses",
    "/blogs/news/help-center-launch",
    "/search?q=contact",
    "/account/help",
    "/cart/contact",
    "/cdn/shopifycloud/themes_support.js",
    "/assets/contact.css"
  ];
  for (const pathname of rejected) {
    assert.equal(
      validateContactPageUrl(`https://fictional-shop.dev${pathname}`).accepted,
      false,
      pathname
    );
  }
  assert.equal(validateContactPageUrl("https://fictional-shop.dev/fr/pages/contact-us").accepted, true);
  assert.equal(
    validateContactPageUrl("https://fictional-shop.dev/policies/contact-information").accepted,
    true
  );
  assert.equal(
    classifyStorePageUrl("https://fictional-shop.dev/pages/about-us").classification,
    "organization_evidence"
  );
});

test("contact route validation rejects unsafe or unverified URLs", () => {
  const options = { allowedHostnames: ["fictional-shop.dev"] };
  assert.equal(validateContactPageUrl("https://other-shop.dev/pages/contact", options).accepted, false);
  assert.equal(validateContactPageUrl("https://user:pass@fictional-shop.dev/pages/contact", options).accepted, false);
  assert.equal(validateContactPageUrl("javascript:alert(1)", options).accepted, false);
  assert.equal(validateContactPageUrl("not a url", options).accepted, false);
  assert.equal(validateContactPageUrl("", options).accepted, false);
});

test("phone extraction requires source-proven or contextual evidence", () => {
  const product = extractContactEvidence({
    url: "https://fictional-shop.dev/products/support-widget",
    html: "<p>SKU 12345678</p><p>Order 2026123456</p>"
  });
  assert.deepEqual(product.phones, []);
  assert.equal(product.contactUrl, "");

  const contact = extractContactEvidence({
    url: "https://fictional-shop.dev/pages/contact-us",
    html: `
      <a href="tel:+44 20 7946 0958">Call London</a>
      <script type="application/ld+json">{
        "@type":"Organization",
        "name":"Fictional Shop",
        "telephone":"(212) 555-0199"
      }</script>
      <p>Phone: 415-555-0134</p>
    `
  });
  assert.deepEqual(contact.phones, ["+442079460958", "2125550199", "4155550134"]);
  assert.equal(contact.evidence.phones[0].method, "tel");
});

test("contact-page decisions require a usable same-store page with substantive signals", () => {
  const base = {
    url: "https://fictional-shop.dev/pages/contact-us",
    requestedUrl: "https://fictional-shop.dev/pages/contact-us",
    allowedHostnames: ["fictional-shop.dev"],
    status: 200
  };
  for (const html of [
    "",
    "   ",
    "<html><body>Not found</body></html>",
    "<html><title>404 Not Found</title><body>Try again</body></html>",
    "<html><body>Checking your browser. Verify you are human.</body></html>"
  ]) {
    assert.equal(assessContactPage({ ...base, html }).accepted, false, html);
  }
  const soft404WithTemplateContact = extractContactEvidence({
    url: base.url,
    allowedHostnames: base.allowedHostnames,
    html: '<html><body>Not found <a href="mailto:template@fictional-shop.dev">Email</a></body></html>'
  });
  assert.deepEqual(soft404WithTemplateContact.emails, []);
  assert.equal(soft404WithTemplateContact.contactUrl, "");
  assert.equal(assessContactPage({
    ...base,
    status: 503,
    html: "<html><body><h1>Contact us</h1>Service unavailable. Please try again later.</body></html>"
  }).accepted, false);
  assert.equal(assessContactPage({
    ...base,
    html: '<form><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button></form>'
  }).accepted, true);
  assert.equal(assessContactPage({
    ...base,
    url: "https://unrelated.dev/pages/contact-us",
    html: '<form><textarea name="message"></textarea><button type="submit">Send</button></form>'
  }).accepted, false);
});

test("contact pages ignore embedded CAPTCHA scripts but reject visible challenges", () => {
  const base = {
    url: "https://fictional-shop.dev/pages/contact-us",
    requestedUrl: "https://fictional-shop.dev/pages/contact-us",
    allowedHostnames: ["fictional-shop.dev"],
    status: 200
  };
  const ordinaryContact = assessContactPage({
    ...base,
    html: `<html><body>
      <script>window.ShopifyCaptcha = { enabled: true };</script>
      <form><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button></form>
      <small>This site is protected by reCAPTCHA and the Google privacy policy applies.</small>
    </body></html>`
  });
  const blockedContact = assessContactPage({
    ...base,
    html: `<html><body><h1>Verify that you are a human</h1><p>Complete the security check to continue.</p></body></html>`
  });

  assert.equal(ordinaryContact.accepted, true);
  assert.equal(ordinaryContact.validationReason, "validated_contact_page");
  assert.equal(blockedContact.accepted, false);
  assert.equal(blockedContact.validationReason, "challenge_page");
});

test("negative business identifiers beat generic contact words for visible phone candidates", () => {
  for (const text of [
    "Contact support with order number 1234 5678",
    "1234 5678 is your order number. Contact support for help.",
    "Contact us about SKU 8765 4321",
    "8765 4321 is the SKU. Call customer service with questions.",
    "Support can locate tracking reference 1122 3344",
    "1122 3344 is your tracking reference; contact us if it is missing.",
    "Contact accounting with VAT 9988 7766",
    "9988 7766 is our VAT identifier. Phone support can help.",
    "Support documentation for model 5566 7788"
  ]) {
    const rejected = extractContactEvidence({
      url: "https://fictional-shop.dev/pages/contact-us",
      html: `<p>${text}</p>`
    });
    assert.deepEqual(rejected.phones, [], text);
  }

  const accepted = extractContactEvidence({
    url: "https://fictional-shop.dev/pages/contact-us",
    html: "<p>Order enquiries are welcome. Phone: +44 (0)20 7946 0958 ext. 42</p>"
  });
  assert.deepEqual(accepted.phones, ["+4402079460958"]);

  const labelAfter = extractContactEvidence({
    url: "https://fictional-shop.dev/pages/contact-us",
    html: "<p>+44 20 7946 0958 is our phone number.</p>"
  });
  assert.deepEqual(labelAfter.phones, ["+442079460958"]);
});

test("email evidence requires store-owned outreach association", () => {
  const rejectedPages = [
    {
      url: "https://fictional-optics.dev/products/frame",
      html: "<main><p>Product support: support@themevendor.co</p></main>"
    },
    {
      url: "https://fictional-optics.dev/",
      html: "<footer>Theme developer support: support@themevendor.co</footer>"
    },
    {
      url: "https://fictional-optics.dev/blogs/news",
      html: "<article>Our guest can be reached at guest@outside-writer.dev.</article>"
    },
    {
      url: "https://fictional-optics.dev/products/frame",
      html: `<main>Frame details</main><script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        manufacturer: {
          "@type": "Organization",
          email: "factory@manufacturer.dev",
          telephone: "+1 212 555 0166"
        }
      })}</script>`
    }
  ];
  for (const fixture of rejectedPages) {
    const page = extractContactEvidence(fixture);
    assert.deepEqual(page.emails, [], fixture.html);
    assert.deepEqual(page.phones, [], fixture.html);
  }

  const header = extractContactEvidence({
    url: "https://fictional-optics.dev/",
    html: "<header>Customer care: care@fictional-optics.dev</header>"
  });
  assert.deepEqual(header.emails, ["care@fictional-optics.dev"]);
  assert.equal(header.evidence.emails[0].validationReason, "store_owned_header_visible_email");

  const contact = extractContactEvidence({
    url: "https://fictional-optics.dev/pages/contact-us",
    html: '<main><a href="mailto:hello@fictional-optics.dev">Write to us</a></main>'
  });
  assert.deepEqual(contact.emails, ["hello@fictional-optics.dev"]);
  assert.equal(contact.evidence.emails[0].validationReason, "store_owned_contact_page_mailto");

  const organization = extractContactEvidence({
    url: "https://fictional-optics.dev/",
    html: `<main>Fictional Optics official storefront and customer service.</main>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Organization",
        name: "Fictional Optics",
        email: "team@fictional-optics.dev",
        telephone: "+1 212 555 0199"
      })}</script>`
  });
  assert.deepEqual(organization.emails, ["team@fictional-optics.dev"]);
  assert.deepEqual(organization.phones, ["+12125550199"]);
  assert.equal(
    organization.evidence.emails[0].validationReason,
    "structured_store_organization_email"
  );
  assert.equal(organization.evidence.emails[0].structuredPath, "$.email");
  assert.equal(organization.evidence.phones[0].structuredPath, "$.telephone");
});

test("social validation keeps profiles and rejects sharing, intent, roots, and vendors", () => {
  const accepted = [
    "https://instagram.com/fictionaloptics",
    "https://facebook.com/fictionaloptics",
    "https://linkedin.com/company/fictional-optics",
    "https://x.com/fictionaloptics",
    "https://tiktok.com/@fictionaloptics",
    "https://youtube.com/@fictionaloptics",
    "https://pinterest.com/fictionaloptics"
  ];
  for (const value of accepted) assert.equal(validateSocialProfile(value).accepted, true, value);

  const rejected = [
    "https://facebook.com/sharer/sharer.php?u=https://fictional-shop.dev",
    "https://facebook.com/share.php?u=https://fictional-shop.dev",
    "https://twitter.com/intent/tweet?url=https://fictional-shop.dev",
    "https://pinterest.com/pin-builder/?url=https://fictional-shop.dev",
    "https://instagram.com/",
    "https://instagram.com/shopify",
    "https://linkedin.com/login",
    "https://youtube.com/watch?v=fixture",
    "https://instagram.com:8443/fictionaloptics"
  ];
  for (const value of rejected) assert.equal(validateSocialProfile(value).accepted, false, value);
});

test("social extraction requires store association and rejects theme/vendor credits", () => {
  const page = extractContactEvidence({
    url: "https://fictional-optics.dev/",
    html: `
      <script type="application/ld+json">{
        "@type":"Organization",
        "name":"Fictional Optics",
        "sameAs":["https://instagram.com/fictionaloptics"]
      }</script>
      <header><a href="https://facebook.com/fictionaloptics">Facebook</a></header>
      <main><a href="https://x.com/unassociatedguest">Guest profile</a></main>
      <footer>
        Theme by Vendor <a href="https://instagram.com/themevendor">Instagram</a>
      </footer>
    `
  });
  assert.deepEqual(page.socialProfiles.sort(), [
    "https://facebook.com/fictionaloptics",
    "https://instagram.com/fictionaloptics"
  ]);
  assert(page.evidence.socialProfiles.every(({ validationReason }) =>
    ["organization_same_as", "store_owned_layout_link"].includes(validationReason)));
});

test("organization and WebSite names beat Product names regardless of JSON-LD order", () => {
  for (const values of [
    [
      { "@type": "Product", name: "Prescription Lens Model 42" },
      { "@type": "Organization", name: "Fictional Optics" }
    ],
    [
      { "@type": "Organization", name: "Fictional Optics" },
      { "@type": "Product", name: "Prescription Lens Model 42" }
    ]
  ]) {
    const page = extractContactEvidence({
      url: "https://fictional-optics.dev/products/model-42",
      html: `<script type="application/ld+json">${JSON.stringify(values)}</script>`
    });
    assert.equal(page.storeName, "Fictional Optics");
    assert(!page.evidence.organizationNames.some(({ value }) => value === "Prescription Lens Model 42"));
  }
});

test("AI object validation enforces the single schema", () => {
  const valid = {
    store_url: "https://example.com",
    store_name: "Example",
    email: "",
    phone: "",
    contact_url: "",
    social_profiles: [],
    additional_information: ""
  };
  assert.deepEqual(validateAiResult(valid), valid);
  assert.equal(validateAiResult({ ...valid, social_profiles: "instagram" }), null);
  assert.equal(validateAiResult({ ...valid, phone: undefined }), null);
  assert.equal(validateAiResult({ ...valid, unexpected: true }), null);
});

test("versioned AI adapter accepts its sanitized fixture and ignores additive outer metadata", () => {
  const value = parseAiNormalizationResponse(providerFixture("chat-completions-normalization-v1-success"));
  assert.equal(value.store_name, "Fictional Optics");
  assert.equal(value.email, "hello@fictional-optics.dev");
});

test("versioned AI adapter rejects refusal, incomplete, missing, and additive inner fields", () => {
  for (const name of [
    "chat-completions-normalization-v1-refusal",
    "chat-completions-normalization-v1-incomplete",
    "chat-completions-normalization-v1-missing-content",
    "chat-completions-normalization-v1-missing-choices",
    "chat-completions-normalization-v1-additive-inner"
  ]) {
    assert.throws(
      () => parseAiNormalizationResponse(providerFixture(name)),
      AiNormalizationContractError,
      name
    );
  }
  assert.throws(
    () => parseAiNormalizationResponse(providerFixture("chat-completions-normalization-v1-malformed")),
    (error) =>
      error instanceof AiNormalizationContractError &&
      error.code === "invalid_json" &&
      !error.message.includes("fictional-private-value")
  );
});

test("AI normalization can only select validated deterministic evidence", async () => {
  const evidencePage = extractContactEvidence({
    url: "https://fictional-optics.dev/pages/contact-us",
    html: `
      <meta property="og:site_name" content="Fictional Optics">
      <a href="mailto:hello@fictional-optics.dev">Email</a>
      <a href="https://instagram.com/fictionaloptics">Instagram</a>
    `
  });
  const evidence = consolidateEvidence([evidencePage]);
  const successFixture = providerFixture("chat-completions-normalization-v1-success");
  const candidate = {
    resolvedDomain: "fictional-optics.dev",
    allowedHostnames: ["fictional-optics.dev"]
  };
  const config = {
    openaiApiKey: "fixture-key",
    enableAiNormalization: true,
    openaiModel: "fixture-model",
    requestTimeoutMs: 1000
  };
  const accepted = await normalizeWithAi(candidate, evidence, config, {
    request: async () => ({ body: successFixture })
  });
  assert.equal(accepted.store_name, "Fictional Optics");
  assert.equal(accepted.contact_url, "https://fictional-optics.dev/pages/contact-us");

  const fixture = JSON.parse(successFixture);
  fixture.choices[0].message.content = JSON.stringify({
    ...JSON.parse(fixture.choices[0].message.content),
    phone: "12345678",
    contact_url: "https://fictional-optics.dev/products/customer-support-widget",
    social_profiles: [
      "https://instagram.com/fictionaloptics",
      "https://facebook.com/sharer/sharer.php"
    ]
  });
  const normalized = await normalizeWithAi(
    candidate,
    evidence,
    config,
    { request: async () => ({ body: JSON.stringify(fixture) }) }
  );
  assert.equal(normalized.email, "hello@fictional-optics.dev");
  assert.equal(normalized.phone, "");
  assert.equal(normalized.contact_url, "");
  assert.deepEqual(normalized.social_profiles, ["https://instagram.com/fictionaloptics"]);
});

test("consolidation ranks verified contact-page evidence above product-page text", () => {
  const product = extractContactEvidence({
    url: "https://fictional-optics.dev/products/frame",
    html: "<p>sales@fictional-optics.dev</p>"
  });
  const contact = extractContactEvidence({
    url: "https://fictional-optics.dev/pages/contact-us",
    html: '<a href="mailto:care@fictional-optics.dev">Customer care</a>'
  });
  const evidence = consolidateEvidence([product, contact]);
  assert.equal(evidence.email, "care@fictional-optics.dev");
  assert.equal(evidence.emailSourceUrl, contact.url);
  assert.equal(evidence.evidence.emails[0].method, "mailto");
});

test("lead score uses the documented 100-point weighting", () => {
  assert.equal(
    scoreLead({
      relevanceScore: 100,
      shopifyConfidence: 100,
      identityConfidence: 100,
      email: "hello@example.com",
      phone: "+12125550100",
      contactUrl: "https://example.com/contact",
      socialProfiles: ["https://instagram.com/example"]
    }),
    100
  );
});

test("score v2 exposes exact components and gives social profiles no points", () => {
  const score = scoreLeadV2({
    relevanceScore: 80,
    shopifyConfidence: 80,
    identityConfidence: 70,
    contactEvidence: { email: true, phone: false, contactPage: true, social: true }
  });
  assert.deepEqual(score.components, {
    identity: 14,
    shopifyValidation: 20,
    categoryFit: 24,
    contactEvidence: 17
  });
  assert.equal(score.total, 75);
  assert.equal(Object.values(score.components).reduce((sum, value) => sum + value, 0), score.total);
});
