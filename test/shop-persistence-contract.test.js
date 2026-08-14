import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLeadMatchesShop,
  assertProfileMatchesShop,
  assertRunStoreIdentityPair,
  parseRunStoreCandidate,
  parseShopLeadProfile,
  runStoreCandidateFromDiscovery,
  stableShopIdentity,
  trafficProviderIdentities
} from "../src/shop-persistence-contract.js";
import { materializeLeadFromProfile } from "../src/pipeline.js";

function candidate() {
  const intent = {
    originalShopType: "Eyewear brands",
    shopType: "eyewear",
    businessQualifier: "brand",
    categoryVocabulary: ["eyewear", "glasses"]
  };
  return {
    ...intent,
    categoryIntent: intent,
    categoryIntents: [intent],
    query: "site:myshopify.com eyewear glasses",
    rank: 1,
    url: "https://fixture.example/products/glasses",
    queryScore: 88,
    queryGenerationReason: "specific product query",
    querySourceUrls: ["https://example.org/research"],
    finalUrl: "https://fixture.example/products/glasses",
    canonicalUrl: "https://fixture.example/products/glasses",
    myshopifyDomain: "fixture.myshopify.com",
    resolvedDomain: "fixture.example",
    stableIdentity: "fixture.myshopify.com",
    allowedHostnames: ["fixture.example", "fixture.myshopify.com"],
    identityConfidence: 100,
    identityEvidence: {
      stableHostname: "fixture.myshopify.com",
      displayHostname: "fixture.example",
      observedHostnames: ["fixture.example", "fixture.myshopify.com"],
      canonical: {
        url: "https://fixture.example/products/glasses",
        hostname: "fixture.example",
        trusted: true,
        reason: "canonical_matches_observed_host"
      },
      method: "observed_myshopify_host",
      confidence: 100,
      mergedOccurrenceCount: 1
    },
    occurrences: [{
      categoryIntent: {
        originalShopType: intent.originalShopType,
        shopType: intent.shopType,
        businessQualifier: intent.businessQualifier
      },
      originalShopType: intent.originalShopType,
      shopType: intent.shopType,
      businessQualifier: intent.businessQualifier,
      query: "site:myshopify.com eyewear glasses",
      queryScore: 88,
      queryGenerationReason: "specific product query",
      querySourceUrls: [],
      categoryVocabulary: intent.categoryVocabulary,
      rank: 1,
      resultUrl: "https://fixture.example/products/glasses",
      finalUrl: "https://fixture.example/products/glasses",
      resolvedDomain: "fixture.example",
      myshopifyDomain: "fixture.myshopify.com"
    }],
    duplicateCount: 0
  };
}

function profile(identityEvidence) {
  return {
    contractVersion: "shop-lead-profile-v1",
    storeName: "Fixture Eyewear",
    email: "hello@fixture.example",
    emailSourceUrl: "https://fixture.example/contact",
    phone: "+64 9 555 0100",
    phoneSourceUrl: "https://fixture.example/contact",
    contactUrl: "https://fixture.example/contact",
    socialProfiles: ["https://instagram.com/fixture"],
    contactabilityTier: "direct",
    contactEvidence: { emails: [{ value: "hello@fixture.example" }] },
    identityConfidence: 100,
    identityEvidence,
    categoryAssessments: [{
      intent: {
        originalShopType: "Eyewear brands",
        shopType: "eyewear",
        businessQualifier: "brand",
        categoryVocabulary: ["eyewear", "glasses"]
      },
      shopifyConfidence: 100,
      relevanceScore: 90,
      storeFitState: "specialist",
      storeFitEvidence: { state: "specialist", reason: "fixture" },
      accepted: true
    }],
    pageDiagnostics: { pagesExamined: 2, pageErrorTypes: [], aiErrorType: "" }
  };
}

test("verified identity and candidate persistence strip transient documents", () => {
  const input = candidate();
  input.html = "<!doctype html><html><body>must not persist</body></html>";
  input.initialFetch = { rendered: true, token: "must-not-persist" };
  const identity = stableShopIdentity(input);
  assert.equal(identity.stableKey, "fixture.myshopify.com");
  const payload = runStoreCandidateFromDiscovery(input, []);
  assert.equal("html" in payload, false);
  assert.equal("initialFetch" in payload, false);
  assert.doesNotMatch(JSON.stringify(payload), /must not persist|must-not-persist/u);
  assert.deepEqual(parseRunStoreCandidate(payload), payload);
});

test("traffic provider identities use the verified hostname when canonical URL is absent", () => {
  const input = candidate();
  input.canonicalUrl = "";
  const identity = stableShopIdentity(input);
  assert.deepEqual(trafficProviderIdentities(identity), {
    hostname: "fixture.example",
    origin: "https://fixture.example"
  });

  identity.resolvedDomain = null;
  assert.deepEqual(trafficProviderIdentities(identity), {
    hostname: "fixture.myshopify.com",
    origin: "https://fixture.myshopify.com"
  });
});

test("unverified identities, raw documents, secrets, and run-owned profile data fail closed", () => {
  const input = candidate();
  input.identityEvidence.observedHostnames = ["unrelated.example"];
  assert.throws(() => stableShopIdentity(input), /verified stable shop identity/u);

  const valid = candidate();
  const persisted = runStoreCandidateFromDiscovery(valid, []);
  assert.throws(() => parseRunStoreCandidate({ ...persisted, html: "<html>raw</html>" }));
  const contact = profile(valid.identityEvidence);
  assert.throws(() => parseShopLeadProfile({ ...contact, ownerId: "user_fixture" }));
  assert.throws(() => parseShopLeadProfile({
    ...contact,
    contactEvidence: { authorization_token: "secret" }
  }), /Sensitive or raw field/u);
  assert.throws(() => parseShopLeadProfile({
    ...contact,
    contactEvidence: { document: "<div>raw storefront fragment</div>" }
  }), /Raw document content/u);
});

test("completed profile materializes a deterministic run lead without network input", () => {
  const input = candidate();
  const payload = runStoreCandidateFromDiscovery(input, []);
  const lead = materializeLeadFromProfile(payload, profile(input.identityEvidence));
  assert.equal(lead.status, "qualified");
  assert.equal(lead.email, "hello@fixture.example");
  assert.equal(lead.phone, "+64 9 555 0100");
  assert.equal(lead.contact_url, "https://fixture.example/contact");
  assert.equal(lead.social_profiles.length, 1);
  assert.equal(lead.lead_score, lead.score_breakdown.total);
});

test("cross-record identity checks reject candidate, profile, and lead reassignment", () => {
  const input = candidate();
  const identity = stableShopIdentity(input);
  const payload = runStoreCandidateFromDiscovery(input, []);
  const contact = profile(input.identityEvidence);
  assert.deepEqual(assertRunStoreIdentityPair(identity, payload).identity, identity);
  assert.throws(() => assertRunStoreIdentityPair(
    { ...identity, stableKey: "different.myshopify.com" },
    payload
  ), /observed identity evidence|does not match/u);
  assert.throws(() => assertProfileMatchesShop(contact, "different.myshopify.com"), /does not match/u);
  assert.throws(() => assertLeadMatchesShop({
    resolved_domain: "different.example"
  }, identity.stableKey), /does not match/u);
});
