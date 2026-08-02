import assert from "node:assert/strict";
import test from "node:test";
import { runPipeline } from "../src/pipeline.js";
import { normalizeShopType } from "../src/category-input.js";
import { leadRecordToCreate, serializeLead } from "../src/api-serializer.js";

function status() {
  return {
    queriesTotal: 0,
    queriesProcessed: 0,
    blankQueriesSkipped: 0,
    storesDiscovered: 0,
    storesQualified: 0,
    storesRejected: 0,
    failures: 0,
    outputRows: 0
  };
}

test("pipeline deduplicates results and emits one evidence-backed store row", async () => {
  const config = {
    inputCsv: "/unused/input.csv",
    outputCsv: "/unused/output.csv",
    maxQueries: 10,
    storeConcurrency: 2,
    maxPagesPerStore: 5
  };
  const currentStatus = status();
  const result = await runPipeline(config, currentStatus, {
    readQueries: async () => ({ queries: ["organic spices"], blanksSkipped: 1 }),
    search: async (query) => [
      { query, rank: 1, url: "https://one.myshopify.com/products/a", title: "A", snippet: "" },
      { query, rank: 2, url: "https://one.myshopify.com/products/b", title: "B", snippet: "" }
    ],
    resolve: async (result) => ({
      ...result,
      html: "<html>Shopify spice store</html>",
      finalUrl: `https://example.com/products/${result.rank}`,
      canonicalUrl: "",
      myshopifyDomain: "one.myshopify.com",
      resolvedDomain: "example.com",
      allowedHostnames: ["one.myshopify.com", "example.com"],
      identityConfidence: 100
    }),
    validate: () => ({
      valid: true,
      rejectionReason: "",
      shopifyConfidence: 100,
      relevanceScore: 100,
      evidence: {}
    }),
    discoverPages: async () => ["https://example.com/pages/contact"],
    fetchPage: async () => ({
      body: '<a href="mailto:hello@fictional-pipeline.dev">Email</a>',
      finalUrl: "https://example.com/pages/contact",
      contentType: "text/html"
    }),
    normalizeAi: async () => null
  });

  const records = result.leads;
  assert.equal(records.length, 1);
  assert.deepEqual(result.summary, {
    total: 1,
    qualified: 1,
    rejected: 0,
    failed: 0
  });
  assert.equal(records[0].email, "hello@fictional-pipeline.dev");
  assert.equal(records[0].status, "qualified");
  assert.match(records[0].additional_information, /duplicate_results=1/);
  assert.equal(currentStatus.storesDiscovered, 2);
  assert.equal(currentStatus.storesQualified, 1);
  assert.equal(currentStatus.outputRows, 1);
  assert.equal(currentStatus.blankQueriesSkipped, 1);
});

test("one failed query does not stop later queries", async () => {
  let calls = 0;
  const currentStatus = status();
  const result = await runPipeline(
    {
      inputCsv: "unused",
      outputCsv: "unused",
      maxQueries: 10,
      storeConcurrency: 1
    },
    currentStatus,
    {
      readQueries: async () => ({ queries: ["bad", "empty"], blanksSkipped: 0 }),
      search: async (query) => {
        calls += 1;
        if (query === "bad") throw new Error("quota");
        return [];
      }
    }
  );
  const records = result.leads;
  assert.equal(calls, 2);
  assert.equal(records.length, 0);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), [
    "search_failed",
    "no_search_results"
  ]);
  assert.equal(currentStatus.queriesProcessed, 2);
});

test("selected probe results enter the lead pipeline without another Google search", async () => {
  let searchCalls = 0;
  let resolverIntent;
  const intent = normalizeShopType("  eYeWeAr   BrAnD  ");
  const currentStatus = status();
  const cachedResult = {
    query: "site:myshopify.com/products barrel jeans",
    rank: 1,
    url: "https://denim.myshopify.com/products/barrel-jeans",
    title: "Barrel Jeans",
    snippet: "",
    rejectionReason: ""
  };
  const result = await runPipeline(
    {
      generatedQueryCount: 1,
      outputCsv: "/unused/output.csv",
      storeConcurrency: 1,
      maxPagesPerStore: 1
    },
    currentStatus,
    {
      planQueries: async () => ({
        complete: true,
        categoryCount: 1,
        selected: [
          {
            ...intent,
            categoryIntent: intent,
            categoryVocabulary: ["barrel jeans"],
            query: cachedResult.query,
            queryScore: 91,
            queryGenerationReason: "High store diversity",
            results: [cachedResult]
          }
        ]
      }),
      search: async () => {
        searchCalls += 1;
        return [];
      },
      resolve: async (entry) => {
        resolverIntent = entry;
        return {
          ...entry,
          html: "<html><body>Shopify barrel jeans store with enough content</body></html>",
          finalUrl: "https://denim.example/products/barrel-jeans",
          canonicalUrl: "",
          myshopifyDomain: "denim.myshopify.com",
          resolvedDomain: "denim.example",
          allowedHostnames: ["denim.myshopify.com", "denim.example"],
          identityConfidence: 100
        };
      },
      validate: () => ({
        valid: true,
        rejectionReason: "",
        shopifyConfidence: 100,
        relevanceScore: 100,
        evidence: {}
      }),
      discoverPages: async () => ["https://denim.example/products/barrel-jeans"],
      extractEvidence: () => ({
        url: "https://denim.example/products/barrel-jeans",
        storeName: "Denim",
        emails: ["hello@denim.example"],
        phones: [],
        contactUrl: "",
        socialProfiles: [],
        snippets: []
      }),
      consolidate: () => ({
        storeName: "Denim",
        email: "hello@denim.example",
        allEmails: ["hello@denim.example"],
        phone: "",
        allPhones: [],
        contactUrl: "",
        socialProfiles: [],
        snippets: [],
        emailSourceUrl: "https://denim.example/products/barrel-jeans",
        phoneSourceUrl: "",
        evidence: {
          emails: [{ value: "hello@denim.example", sourceUrl: "https://denim.example/products/barrel-jeans", method: "mailto", confidence: 96 }],
          phones: [], contactPages: [], socialProfiles: [], organizationNames: []
        }
      }),
      normalizeAi: async () => null
    }
  );
  const records = result.leads;
  assert.equal(searchCalls, 0);
  assert.equal(resolverIntent.originalShopType, "eYeWeAr BrAnD");
  assert.deepEqual(resolverIntent.categoryIntent, intent);
  assert.equal(records[0].original_shop_type, "eYeWeAr BrAnD");
  assert.equal(records[0].shop_type, "eyewear");
  assert.equal(records[0].business_qualifier, "brand");
  assert.equal(records[0].generated_query, cachedResult.query);
  assert.equal(records[0].query_score, 91);
});

test("per-store page fetching is bounded and preserves ranked discovery order", async () => {
  let active = 0;
  let maximumActive = 0;
  let consolidatedUrls;
  const urls = [
    "https://bounded.example/",
    "https://bounded.example/pages/contact-us",
    "https://bounded.example/pages/about-us",
    "https://bounded.example/collections/eyewear"
  ];
  const result = await runPipeline({
    storeConcurrency: 1,
    pageFetchConcurrency: 2
  }, status(), {
    readQueries: async () => ({ queries: ["eyewear"], blanksSkipped: 0 }),
    search: async (query) => [{
      query,
      rank: 1,
      url: "https://bounded.myshopify.com/products/frame",
      title: "Frame",
      snippet: ""
    }],
    resolve: async (entry) => ({
      ...entry,
      shopType: "eyewear",
      businessQualifier: "unspecified",
      html: "<html><body>Shopify eyewear product</body></html>",
      finalUrl: "https://bounded.example/products/frame",
      myshopifyDomain: "bounded.myshopify.com",
      resolvedDomain: "bounded.example",
      allowedHostnames: ["bounded.example", "bounded.myshopify.com"],
      identityConfidence: 100
    }),
    validate: () => ({
      valid: true,
      rejectionReason: "",
      shopifyConfidence: 100,
      relevanceScore: 100,
      evidence: {}
    }),
    discoverPages: async () => urls,
    fetchPage: async (url) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, url.includes("contact") ? 15 : 2));
      active -= 1;
      if (url.includes("about")) throw new Error("fixture partial failure");
      return {
        body: `<html><body>${url} ${"Shopify eyewear ".repeat(10)}</body></html>`,
        finalUrl: url,
        contentType: "text/html"
      };
    },
    extractEvidence: ({ url }) => ({
      url,
      emails: url.includes("contact") ? ["team@bounded.invalid"] : [],
      phones: [],
      contactUrl: url.includes("contact") ? url : "",
      socialProfiles: [],
      textSnippet: ""
    }),
    consolidate: (pages) => {
      consolidatedUrls = pages.map(({ url }) => url);
      return {
        storeName: "Bounded",
        email: "team@bounded.invalid",
        allEmails: ["team@bounded.invalid"],
        emailSourceUrl: urls[1],
        phone: "",
        allPhones: [],
        phoneSourceUrl: "",
        contactUrl: urls[1],
        socialProfiles: [],
        snippets: [],
        evidence: {
          emails: [{ value: "team@bounded.invalid", sourceUrl: urls[1], method: "mailto", confidence: 96 }],
          phones: [],
          contactPages: [{ value: urls[1], sourceUrl: urls[1], method: "route_classifier_v1", confidence: 100 }],
          socialProfiles: [], organizationNames: []
        }
      };
    },
    normalizeAi: async () => null
  });
  assert.equal(maximumActive, 2);
  assert.deepEqual(consolidatedUrls, [urls[0], urls[1], urls[3]]);
  assert.equal(result.leads[0].status, "qualified");
  assert.match(result.leads[0].additional_information, /page_errors=\/pages\/about-us/);
});

test("manual categories reach the planner without CSV reads or writes", async () => {
  const categories = [
    { originalShopType: "Eyewear", shopType: "eyewear" }
  ];
  const currentStatus = status();
  let receivedCategories;
  const result = await runPipeline(
    {
      generatedQueryCount: 1,
      storeConcurrency: 1,
      maxPagesPerStore: 1
    },
    currentStatus,
    {
      categories,
      planQueries: async (_config, _status, dependencies) => {
        receivedCategories = dependencies.categories;
        return {
          complete: true,
          categoryCount: 1,
          selected: [{
            ...categories[0],
            businessQualifier: "unspecified",
            categoryIntent: { ...categories[0], businessQualifier: "unspecified" },
            categoryVocabulary: ["eyewear frames"],
            query: "site:myshopify.com/products eyewear frames",
            results: []
          }],
          audits: []
        };
      },
      readCategories: async () => {
        throw new Error("HTTP pipeline must not read CSV");
      },
      writeAudit: async () => {
        throw new Error("HTTP pipeline must not write query audit CSV");
      }
    }
  );

  assert.deepEqual(receivedCategories, categories);
  assert.deepEqual(result.leads, []);
  assert.deepEqual(result.queryAudits, []);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ["no_search_results"]);
  assert.deepEqual(result.summary, { total: 0, qualified: 0, rejected: 0, failed: 0 });
  assert.equal(currentStatus.stage, "writing_results");
});

test("merged discovery is order-independent and retains every category occurrence", async () => {
  async function execute(results) {
    return runPipeline({ storeConcurrency: 1, pageFetchConcurrency: 1 }, status(), {
      readQueries: async () => ({ queries: ["fixture"], blanksSkipped: 0 }),
      search: async () => results,
      resolve: async (entry) => ({
        ...entry,
        html: `<html>Shopify ${entry.shopType || "eyewear"}</html>`,
        finalUrl: entry.finalUrl,
        resolvedDomain: entry.resolvedDomain,
        myshopifyDomain: entry.myshopifyDomain,
        stableIdentity: entry.myshopifyDomain || entry.resolvedDomain,
        allowedHostnames: entry.allowedHostnames,
        identityConfidence: entry.identityConfidence,
        identityEvidence: { confidence: entry.identityConfidence }
      }),
      validate: (candidate, _config, { final }) => ({
        valid: !final || candidate.shopType === "eyewear",
        rejectionReason: final && candidate.shopType !== "eyewear" ? "wrong_category" : "",
        shopifyConfidence: 100,
        relevanceScore: final ? (candidate.shopType === "eyewear" ? 100 : 60) : 100,
        storeFit: {
          state: candidate.shopType === "eyewear" ? "specialist" : "mismatch",
          score: candidate.shopType === "eyewear" ? 100 : 0
        },
        evidence: {}
      }),
      discoverPages: async () => ["https://merged.example/pages/contact"],
      fetchPage: async (url) => ({ body: '<a href="mailto:team@merged.example">Email</a>', finalUrl: url }),
      normalizeAi: async () => null
    });
  }
  const occurrences = [
    {
      query: "fixture", rank: 5, url: "https://merged.example/products/a",
      finalUrl: "https://merged.example/products/a", resolvedDomain: "merged.example",
      myshopifyDomain: "merged.myshopify.com", allowedHostnames: ["merged.example", "merged.myshopify.com"],
      originalShopType: "Clothing Retailer", shopType: "clothing", businessQualifier: "retailer",
      categoryVocabulary: ["clothing"], querySourceUrls: ["https://research.invalid/clothing"], identityConfidence: 70
    },
    {
      query: "fixture", rank: 1, url: "https://merged.myshopify.com/products/b",
      finalUrl: "https://merged.myshopify.com/products/b", resolvedDomain: "merged.myshopify.com",
      myshopifyDomain: "merged.myshopify.com", allowedHostnames: ["merged.myshopify.com"],
      originalShopType: "Eyewear Brand", shopType: "eyewear", businessQualifier: "brand",
      categoryVocabulary: ["eyewear"], querySourceUrls: ["https://research.invalid/eyewear"], identityConfidence: 100
    }
  ];
  const forward = await execute(occurrences);
  const reverse = await execute([...occurrences].reverse());
  assert.equal(forward.leads.length, 1);
  assert.equal(forward.leads[0].discovery_occurrences.length, 2);
  assert.equal(forward.leads[0].matched_categories.length, 1);
  assert.equal(forward.leads[0].matched_categories[0].originalShopType, "Eyewear Brand");
  assert.equal(forward.leads[0].discovery_occurrences[0].originalShopType.length > 0, true);
  assert.deepEqual(
    forward.leads[0].discovery_occurrences.flatMap(({ querySourceUrls }) => querySourceUrls).sort(),
    ["https://research.invalid/clothing", "https://research.invalid/eyewear"]
  );
  assert.equal(forward.leads[0].original_shop_type, "Eyewear Brand");
  assert.equal(forward.leads[0].shop_type, "eyewear");
  assert.deepEqual(forward.leads[0].discovery_occurrences, reverse.leads[0].discovery_occurrences);
  assert.deepEqual(forward.leads[0].matched_categories, reverse.leads[0].matched_categories);
  assert.equal(forward.leads[0].original_shop_type, reverse.leads[0].original_shop_type);

  const noMatches = await execute(occurrences.map((entry, index) => ({
    ...entry,
    originalShopType: index ? "Accessories Brand" : "Clothing Retailer",
    shopType: index ? "accessories" : "clothing"
  })));
  assert.deepEqual(noMatches.leads[0].matched_categories, []);
  assert.equal(noMatches.leads[0].original_shop_type, "Accessories Brand");
});

test("singular and plural exact category intents survive aggregation and API mapping", async () => {
  const plans = [
    {
      originalShopType: "Eyewear Brand",
      shopType: "eyewear",
      businessQualifier: "brand",
      categoryIntent: {
        originalShopType: "Eyewear Brand",
        shopType: "eyewear",
        businessQualifier: "brand"
      },
      categoryVocabulary: ["acetate frames"],
      query: "site:myshopify.com/products eyewear frames",
      queryScore: 91,
      queryGenerationReason: "singular exact input",
      querySourceUrls: ["https://research.invalid/singular"],
      results: [{
        query: "site:myshopify.com/products eyewear frames",
        rank: 1,
        url: "https://exact-intents.myshopify.com/products/frame"
      }]
    },
    {
      originalShopType: "Eyewear Brands",
      shopType: "eyewear",
      businessQualifier: "brand",
      categoryIntent: {
        originalShopType: "Eyewear Brands",
        shopType: "eyewear",
        businessQualifier: "brand"
      },
      categoryVocabulary: ["reading glasses"],
      query: "site:myshopify.com/products eyewear frames",
      queryScore: 83,
      queryGenerationReason: "plural exact input",
      querySourceUrls: ["https://research.invalid/plural"],
      results: [{
        query: "site:myshopify.com/products eyewear frames",
        rank: 1,
        url: "https://exact-intents.myshopify.com/products/frame"
      }]
    }
  ];

  async function execute(selected) {
    return runPipeline({
      generatedQueryCount: 1,
      storeConcurrency: 1,
      pageFetchConcurrency: 1
    }, status(), {
      planQueries: async () => ({
        complete: true,
        categoryCount: 2,
        selected,
        audits: []
      }),
      resolve: async (entry) => ({
        ...entry,
        html: "<html><body>Shopify eyewear specialist storefront</body></html>",
        finalUrl: "https://exact-intents.dev/products/frame",
        resolvedDomain: "exact-intents.dev",
        myshopifyDomain: "exact-intents.myshopify.com",
        stableIdentity: "exact-intents.myshopify.com",
        allowedHostnames: ["exact-intents.dev", "exact-intents.myshopify.com"],
        identityConfidence: 100
      }),
      validate: () => ({
        valid: true,
        rejectionReason: "",
        shopifyConfidence: 100,
        relevanceScore: 100,
        storeFit: { state: "specialist", score: 100, reason: "controlled_specialist" },
        evidence: {}
      }),
      discoverPages: async () => ["https://exact-intents.dev/pages/contact-us"],
      fetchPage: async (url) => ({
        body: '<a href="mailto:hello@exact-intents.dev">Email us</a>',
        finalUrl: url,
        status: 200,
        contentType: "text/html"
      }),
      normalizeAi: async () => null
    });
  }

  const forward = await execute(plans);
  const reverse = await execute([...plans].reverse());
  for (const result of [forward, reverse]) {
    const lead = result.leads[0];
    assert.equal(lead.status, "qualified");
    assert.deepEqual(lead.matched_categories.map(({ originalShopType }) => originalShopType), [
      "Eyewear Brand",
      "Eyewear Brands"
    ]);
    assert.deepEqual(lead.store_fit_evidence.map(({ intent }) => ({
      originalShopType: intent.originalShopType,
      vocabulary: intent.categoryVocabulary
    })), [
      { originalShopType: "Eyewear Brand", vocabulary: ["acetate frames"] },
      { originalShopType: "Eyewear Brands", vocabulary: ["reading glasses"] }
    ]);
    assert.deepEqual(lead.discovery_occurrences.map((item) => ({
      originalShopType: item.originalShopType,
      vocabulary: item.categoryVocabulary,
      reason: item.queryGenerationReason,
      sources: item.querySourceUrls,
      score: item.queryScore
    })), [
      {
        originalShopType: "Eyewear Brand",
        vocabulary: ["acetate frames"],
        reason: "singular exact input",
        sources: ["https://research.invalid/singular"],
        score: 91
      },
      {
        originalShopType: "Eyewear Brands",
        vocabulary: ["reading glasses"],
        reason: "plural exact input",
        sources: ["https://research.invalid/plural"],
        score: 83
      }
    ]);

    const persisted = leadRecordToCreate("run-fixture", "lead-fixture", lead);
    const api = serializeLead(persisted);
    assert.deepEqual(api.matched_categories, lead.matched_categories);
    assert.deepEqual(api.discovery_occurrences, lead.discovery_occurrences);
    assert.deepEqual(api.store_fit_evidence, lead.store_fit_evidence);
  }
  assert.deepEqual(forward.leads[0].matched_categories, reverse.leads[0].matched_categories);
  assert.deepEqual(forward.leads[0].discovery_occurrences, reverse.leads[0].discovery_occurrences);
  assert.deepEqual(forward.leads[0].store_fit_evidence, reverse.leads[0].store_fit_evidence);
  assert.equal(forward.leads[0].original_shop_type, "Eyewear Brand");
});

test("research-only stores are rejected with a null v2 score", async () => {
  const result = await runPipeline({ storeConcurrency: 1 }, status(), {
    readQueries: async () => ({ queries: ["eyewear"], blanksSkipped: 0 }),
    search: async (query) => [{ query, rank: 1, url: "https://social.myshopify.com/products/a" }],
    resolve: async (entry) => ({
      ...entry, html: "<html>Shopify eyewear specialist</html>", finalUrl: entry.url,
      resolvedDomain: "social.myshopify.com", myshopifyDomain: "social.myshopify.com",
      stableIdentity: "social.myshopify.com", allowedHostnames: ["social.myshopify.com"],
      identityConfidence: 70
    }),
    validate: () => ({ valid: true, rejectionReason: "", shopifyConfidence: 100,
      relevanceScore: 100, storeFit: { state: "specialist", score: 100 }, evidence: {} }),
    discoverPages: async () => ["https://social.myshopify.com/pages/about"],
    fetchPage: async (url) => ({ body: '<meta property="og:site_name" content="Social Store">', finalUrl: url }),
    normalizeAi: async () => null
  });
  assert.equal(result.leads[0].status, "rejected");
  assert.equal(result.leads[0].contactability_tier, "research_only");
  assert.equal(result.leads[0].lead_score, "");
  assert.equal(result.leads[0].score_breakdown, null);
  assert.equal(result.leads[0].pipeline_version, 2);
  assert.equal(result.leads[0].scoring_version, 2);
});

test("structural rejects and scalar-only contact URLs cannot score or qualify", async () => {
  async function execute(validation, consolidate) {
    return runPipeline({ storeConcurrency: 1 }, status(), {
      readQueries: async () => ({ queries: ["eyewear"], blanksSkipped: 0 }),
      search: async (query) => [{ query, rank: 1, url: "https://gate.myshopify.com/products/a" }],
      resolve: async (entry) => ({
        ...entry, html: "<html>Shopify eyewear</html>", finalUrl: entry.url,
        resolvedDomain: "gate.myshopify.com", stableIdentity: "gate.myshopify.com",
        allowedHostnames: ["gate.myshopify.com"], identityConfidence: 70
      }),
      validate: validation,
      discoverPages: async () => ["https://gate.myshopify.com/pages/contact"],
      fetchPage: async (url) => ({ body: "<html>contact</html>", finalUrl: url }),
      consolidate,
      normalizeAi: async () => null
    });
  }
  const inactive = await execute(() => ({
    valid: false, rejectionReason: "inactive_store", shopifyConfidence: 100,
    relevanceScore: 100, storeFit: { state: "specialist", score: 100 }, evidence: {}
  }), () => ({}));
  assert.equal(inactive.leads[0].lead_score, "");
  assert.equal(inactive.leads[0].status, "rejected");

  const scalarOnly = await execute(() => ({
    valid: true, rejectionReason: "", shopifyConfidence: 100,
    relevanceScore: 100, storeFit: { state: "specialist", score: 100 }, evidence: {}
  }), () => ({
    storeName: "Gate", email: "", phone: "",
    contactUrl: "https://gate.myshopify.com/pages/contact",
    socialProfiles: [], evidence: { emails: [], phones: [], contactPages: [], socialProfiles: [], organizationNames: [] }
  }));
  assert.equal(scalarOnly.leads[0].status, "rejected");
  assert.equal(scalarOnly.leads[0].contactability_tier, "research_only");
  assert.equal(scalarOnly.leads[0].contact_url, "");
});

test("a blank contact route cannot qualify, while a substantive same-store form can", async () => {
  async function execute(body) {
    return runPipeline({ storeConcurrency: 1, pageFetchConcurrency: 1 }, status(), {
      readQueries: async () => ({ queries: ["eyewear"], blanksSkipped: 0 }),
      search: async (query) => [{ query, rank: 1, url: "https://contact-gate.myshopify.com/products/frame" }],
      resolve: async (entry) => ({
        ...entry,
        html: "<html><body>Shopify eyewear specialist storefront</body></html>",
        finalUrl: entry.url,
        resolvedDomain: "contact-gate.myshopify.com",
        stableIdentity: "contact-gate.myshopify.com",
        allowedHostnames: ["contact-gate.myshopify.com"],
        identityConfidence: 70
      }),
      validate: () => ({
        valid: true,
        rejectionReason: "",
        shopifyConfidence: 100,
        relevanceScore: 100,
        storeFit: { state: "specialist", score: 100 },
        evidence: {}
      }),
      discoverPages: async () => ["https://contact-gate.myshopify.com/pages/contact-us"],
      fetchPage: async (url) => ({ body, finalUrl: url, status: 200, contentType: "text/html" }),
      normalizeAi: async () => null
    });
  }

  const blank = await execute("<html><body>Not found</body></html>");
  assert.equal(blank.leads[0].status, "rejected");
  assert.equal(blank.leads[0].contact_url, "");
  assert.equal(blank.leads[0].contactability_tier, "none");
  assert.equal(blank.leads[0].lead_score, "");
  assert.equal(blank.leads[0].score_breakdown, null);

  const form = await execute('<html><body><form><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button></form></body></html>');
  assert.equal(form.leads[0].status, "qualified");
  assert.equal(form.leads[0].contactability_tier, "indirect");
  assert.equal(form.leads[0].contact_url, "https://contact-gate.myshopify.com/pages/contact-us");
  assert.deepEqual(
    form.leads[0].contact_evidence.contactPages[0].decision.positiveSignals,
    ["contact_form"]
  );
});

test("unassociated emails and trailing business identifiers cannot qualify or score", async () => {
  async function execute(html) {
    return runPipeline({ storeConcurrency: 1, pageFetchConcurrency: 1 }, status(), {
      readQueries: async () => ({ queries: ["eyewear"], blanksSkipped: 0 }),
      search: async (query) => [{
        query,
        rank: 1,
        url: "https://association-gate.myshopify.com/products/frame"
      }],
      resolve: async (entry) => ({
        ...entry,
        html,
        finalUrl: entry.url,
        resolvedDomain: "association-gate.myshopify.com",
        stableIdentity: "association-gate.myshopify.com",
        allowedHostnames: ["association-gate.myshopify.com"],
        identityConfidence: 80
      }),
      validate: () => ({
        valid: true,
        rejectionReason: "",
        shopifyConfidence: 100,
        relevanceScore: 100,
        storeFit: { state: "specialist", score: 100 },
        evidence: {}
      }),
      discoverPages: async (candidate) => [candidate.finalUrl],
      normalizeAi: async () => null
    });
  }

  for (const html of [
    "<main><p>Product support: support@themevendor.co</p></main>",
    "<main><p>1234 5678 is your order number. Contact support for help.</p></main>"
  ]) {
    const result = await execute(html);
    assert.equal(result.leads[0].status, "rejected", html);
    assert.equal(result.leads[0].contactability_tier, "none", html);
    assert.equal(result.leads[0].email, "", html);
    assert.equal(result.leads[0].phone, "", html);
    assert.equal(result.leads[0].lead_score, "", html);
    assert.equal(result.leads[0].score_breakdown, null, html);
  }
});

test("a broad multi-department Organization claim is rejected for brand intent", async () => {
  const broadHtml = `<html><body><script src="/cdn/shop/theme.js"></script>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Organization",
      name: "Market Eyewear",
      description: "Eyewear, toys, electronics, furniture, groceries, and garden products"
    })}</script>
    ${"Shop eyewear, toys, electronics, furniture, groceries, and garden products. ".repeat(8)}
  </body></html>`;
  const result = await runPipeline({ storeConcurrency: 1 }, status(), {
    readQueries: async () => ({ queries: ["eyewear"], blanksSkipped: 0 }),
    search: async (query) => [{
      query,
      rank: 1,
      url: "https://broad-fit.myshopify.com/products/frame",
      shopType: "eyewear",
      originalShopType: "Eyewear Brand",
      businessQualifier: "brand",
      categoryVocabulary: ["eyewear"]
    }],
    resolve: async (entry) => ({
      ...entry,
      html: broadHtml,
      finalUrl: "https://broad-fit.example/",
      resolvedDomain: "broad-fit.example",
      myshopifyDomain: "broad-fit.myshopify.com",
      stableIdentity: "broad-fit.myshopify.com",
      allowedHostnames: ["broad-fit.example", "broad-fit.myshopify.com"],
      identityConfidence: 90
    }),
    discoverPages: async (candidate) => [candidate.finalUrl],
    normalizeAi: async () => null
  });
  assert.equal(result.leads[0].status, "rejected");
  assert.equal(result.leads[0].store_fit_state, "category_seller");
  assert.equal(result.leads[0].rejection_reason, "wrong_store_type");
  assert.equal(
    result.leads[0].store_fit_evidence[0].decisionEvidence.breadthBlockedSpecialist,
    true
  );
});
