import assert from "node:assert/strict";
import test from "node:test";
import {
  consolidateEvidence,
  extractContactEvidence,
  normalizeEmail,
  normalizePhone
} from "../src/contact-extractor.js";
import { scoreLead } from "../src/lead-scorer.js";
import { validateAiResult } from "../src/ai-normalizer.js";

test("contact extraction keeps evidence and source pages", () => {
  const page = extractContactEvidence({
    url: "https://shop.example/pages/contact",
    html: `
      <title>Example Spices</title>
      <a href="mailto:Hello@Example.com?subject=Hi">Email</a>
      <a href="tel:+1 (212) 555-0100">Call</a>
      <a href="https://instagram.com/example?ref=site">Instagram</a>
    `
  });
  const combined = consolidateEvidence([page]);
  assert.equal(combined.email, "hello@example.com");
  assert.equal(combined.phone, "+12125550100");
  assert.equal(combined.emailSourceUrl, page.url);
  assert.equal(combined.contactUrl, page.url);
  assert.deepEqual(combined.socialProfiles, ["https://instagram.com/example"]);
});

test("normalizers reject implausible values", () => {
  assert.equal(normalizeEmail("not-an-email"), "");
  assert.equal(normalizePhone("123"), "");
  assert.equal(normalizeEmail("hello@example.com"), "hello@example.com");
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
