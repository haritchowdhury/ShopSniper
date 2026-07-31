import { loadConfig } from "./config.js";
import { createPrismaRunRepository } from "./prisma-run-repository.js";
import { createInitialStatus } from "./status.js";

const config = loadConfig();

if (
  process.env.NODE_ENV === "production" ||
  process.env.FRONTEND_SEED_CONFIRM !== "non-production"
) {
  throw new Error(
    "Refusing to seed. Set FRONTEND_SEED_CONFIRM=non-production and use a non-production DATABASE_URL."
  );
}

const repository = createPrismaRunRepository();
const categories = [
  { originalShopType: "clothing", shopType: "clothing" },
  { originalShopType: "eyewear", shopType: "eyewear" }
];
const run = await repository.createRun(categories);
const status = {
  ...createInitialStatus(),
  state: "running",
  stage: "writing_results",
  runId: run.id,
  shopTypesTotal: 2,
  shopTypesProcessed: 2,
  queriesTotal: 3,
  queriesProcessed: 3,
  storesDiscovered: 3,
  storesQualified: 1,
  storesRejected: 1,
  failures: 1,
  outputRows: 3
};

await repository.markRunning(run.id);
await repository.saveCompletedResults(
  run.id,
  {
    leads: [
      {
        shop_type: "clothing",
        generated_query: "site:myshopify.com/products barrel jeans",
        query_score: 96,
        query_generation_reason: "Specific product intent with store diversity.",
        search_query: "site:myshopify.com/products barrel jeans",
        google_rank: 1,
        google_result_url: "https://fixture-fashion.myshopify.com/products/barrel-jeans",
        myshopify_domain: "fixture-fashion.myshopify.com",
        final_url: "https://fashion-fixture.example/products/barrel-jeans",
        canonical_url: "https://fashion-fixture.example/products/barrel-jeans",
        resolved_domain: "fashion-fixture.example",
        store_name: "Fashion Fixture",
        email: "hello@fashion-fixture.example",
        email_source_url: "https://fashion-fixture.example/pages/contact",
        phone: "",
        phone_source_url: "",
        contact_url: "https://fashion-fixture.example/pages/contact",
        social_profiles: ["https://instagram.com/fashionfixture"],
        additional_information: "Frontend-only fixture; pages_examined=3",
        shopify_confidence: 100,
        relevance_score: 92,
        lead_score: 96,
        status: "qualified",
        rejection_reason: "",
        error: ""
      },
      {
        shop_type: "eyewear",
        generated_query: "site:myshopify.com/products acetate sunglasses",
        query_score: 84,
        query_generation_reason: "Concrete eyewear product phrase.",
        search_query: "site:myshopify.com/products acetate sunglasses",
        google_rank: 4,
        google_result_url: "https://fixture-eyewear.myshopify.com/products/item",
        myshopify_domain: "fixture-eyewear.myshopify.com",
        final_url: "https://eyewear-fixture.example/products/item",
        canonical_url: "",
        resolved_domain: "eyewear-fixture.example",
        store_name: "Eyewear Fixture",
        email: "",
        email_source_url: "",
        phone: "",
        phone_source_url: "",
        contact_url: "",
        social_profiles: [],
        additional_information: "Frontend-only fixture",
        shopify_confidence: 100,
        relevance_score: 75,
        lead_score: 39,
        status: "rejected",
        rejection_reason: "no_contact_information",
        error: ""
      },
      {
        shop_type: "clothing",
        generated_query: "site:myshopify.com/products linen overshirt",
        query_score: 72,
        query_generation_reason: "Concrete apparel product phrase.",
        search_query: "site:myshopify.com/products linen overshirt",
        google_rank: 8,
        google_result_url: "https://fixture-error.myshopify.com/products/item",
        myshopify_domain: "fixture-error.myshopify.com",
        final_url: "",
        canonical_url: "",
        resolved_domain: "",
        store_name: "",
        email: "",
        email_source_url: "",
        phone: "",
        phone_source_url: "",
        contact_url: "",
        social_profiles: [],
        additional_information: "Frontend-only fixture",
        shopify_confidence: "",
        relevance_score: "",
        lead_score: "",
        status: "failed",
        rejection_reason: "resolution_failed",
        error: "Fixture storefront could not be resolved"
      }
    ],
    summary: { total: 3, qualified: 1, rejected: 1, failed: 1 }
  },
  status
);

console.log(run.id);
await repository.prisma.$disconnect();
