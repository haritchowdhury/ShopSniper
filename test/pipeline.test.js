import assert from "node:assert/strict";
import test from "node:test";
import { runPipeline } from "../src/pipeline.js";

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
    maxPagesPerStore: 5,
    qualificationThreshold: 45
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
      body: '<a href="mailto:hello@example.com">Email</a>',
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
  assert.equal(records[0].email, "hello@example.com");
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
      storeConcurrency: 1,
      qualificationThreshold: 0
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
  assert.equal(records[0].status, "failed");
  assert.equal(records[0].rejection_reason, "search_failed");
  assert.equal(records[1].status, "rejected");
  assert.equal(records[1].rejection_reason, "no_search_results");
  assert.equal(currentStatus.queriesProcessed, 2);
});

test("selected probe results enter the lead pipeline without another Google search", async () => {
  let searchCalls = 0;
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
      outputCsv: "/unused/output.csv",
      storeConcurrency: 1,
      maxPagesPerStore: 1,
      qualificationThreshold: 0
    },
    currentStatus,
    {
      planQueries: async () => ({
        selected: [
          {
            shopType: "clothing",
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
      resolve: async (entry) => ({
        ...entry,
        html: "<html><body>Shopify barrel jeans store with enough content</body></html>",
        finalUrl: "https://denim.example/products/barrel-jeans",
        canonicalUrl: "",
        myshopifyDomain: "denim.myshopify.com",
        resolvedDomain: "denim.example",
        allowedHostnames: ["denim.myshopify.com", "denim.example"],
        identityConfidence: 100
      }),
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
        phoneSourceUrl: ""
      }),
      normalizeAi: async () => null
    }
  );
  const records = result.leads;
  assert.equal(searchCalls, 0);
  assert.equal(records[0].shop_type, "clothing");
  assert.equal(records[0].generated_query, cachedResult.query);
  assert.equal(records[0].query_score, 91);
});

test("manual categories reach the planner without CSV reads or writes", async () => {
  const categories = [
    { originalShopType: "Eyewear", shopType: "eyewear" }
  ];
  const currentStatus = status();
  let receivedCategories;
  const result = await runPipeline(
    {
      storeConcurrency: 1,
      maxPagesPerStore: 1,
      qualificationThreshold: 0
    },
    currentStatus,
    {
      categories,
      planQueries: async (_config, _status, dependencies) => {
        receivedCategories = dependencies.categories;
        return { selected: [], audits: [] };
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
  assert.deepEqual(result, {
    leads: [],
    summary: { total: 0, qualified: 0, rejected: 0, failed: 0 }
  });
  assert.equal(currentStatus.stage, "writing_results");
});
