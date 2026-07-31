# Email Scraper

A Node.js Shopify lead-generation backend that replaces the two n8n workflows.
The JSON API accepts manually entered shop types, researches and generates
product-oriented Shopify searches, discovers qualified stores, extracts
evidence-backed contacts, and durably stores run status and leads in Neon
PostgreSQL through Prisma. A legacy foreground command still supports CSV input
and output.

## Requirements

- Node.js 20 or newer
- A Neon PostgreSQL database
- A Google Custom Search API key and Programmable Search Engine ID
- An OpenAI API key for category research and candidate generation
- Optional Browserless credentials for pages that require rendering

Install the pinned Prisma and Neon dependencies with `npm install`.

## Configure

Copy the example configuration:

```bash
cp .env.example .env
```

At minimum, set:

```env
DATABASE_URL=your_pooled_neon_runtime_url
GOOGLE_API_KEY=your_new_key
GOOGLE_SEARCH_ENGINE_ID=your_search_engine_id
OPENAI_API_KEY=your_openai_key
BACKEND_API_TOKEN=one-long-random-service-token
```

`prisma.config.ts` uses `DATABASE_URL` for Prisma CLI commands as well as
application runtime. A separate `DIRECT_URL` is optional and should be added only
if a future migration requires a non-pooled connection.

Apply the reviewed Prisma migration to a non-production branch before starting
the API:

```bash
npm run db:migrate:deploy
npm run db:generate
```

The Google and Browserless values found in the old n8n exports must be treated as
exposed and rotated. Do not copy those old values into `.env`.

Browserless is used only when a normal HTML request fails or returns incomplete
content:

```env
BROWSERLESS_TOKEN=your_new_token
BROWSERLESS_FALLBACK_TOKEN=an_optional_second_token
```

The query planner uses the Responses API with a bounded web-search operation and a
strict JSON schema. The lead extractor can also use a separate, smaller model to
normalize only evidence that has already been discovered:

```env
OPENAI_API_KEY=your_key
QUERY_GENERATION_MODEL=gpt-5.6-luna
OPENAI_MODEL=gpt-4.1-mini
ENABLE_AI_NORMALIZATION=false
```

If an AI request fails during a run, the planner can fall back to built-in product
catalogs for clothing, baby food, and kitchen utensils. The fallback does not claim
live market evidence. A key is still required when a run starts because arbitrary
categories depend on AI generation.

Lead normalization is disabled by default so adding the query-planning key does not
silently add one model call per store. Set `ENABLE_AI_NORMALIZATION=true` only when
that additional cost is intentional.

The service binds to `127.0.0.1` by default. Set `HOST` deliberately if another
machine must reach it. `BACKEND_API_TOKEN` is mandatory when `NODE_ENV=production`;
keep the service behind a private network and let only the Next.js BFF send this
token.

## HTTP input

The API accepts only manually entered categories in JSON:

```json
{"shopTypes":["clothing","baby food","kitchen utensils"]}
```

Aliases such as `babyfood` and `utensils` are normalized, duplicate normalized
categories are collapsed, and blank, malformed, or instruction-like values are
rejected atomically.

The foreground `npm run run:once` command retains the one-column CSV input and
CSV outputs. Its paths can be changed only through trusted server environment:

```env
INPUT_CSV=./data/categories.csv
OUTPUT_CSV=./data/leads.csv
GENERATED_QUERIES_CSV=./data/generated-queries.csv
```

The API does not accept arbitrary filesystem paths.

## Run

Start the server:

```bash
npm start
```

For a single foreground batch without starting the HTTP server:

```bash
npm run run:once
```

In another terminal:

```bash
curl http://127.0.0.1:3000/api/health
curl -X POST http://127.0.0.1:3000/api/runs \
  -H 'Authorization: Bearer your-service-token' \
  -H 'X-User-Id: user-id-derived-by-the-frontend' \
  -H 'Content-Type: application/json' \
  -d '{"shopTypes":["clothing","eyewear"]}'
curl -H 'Authorization: Bearer your-service-token' \
  -H 'X-User-Id: user-id-derived-by-the-frontend' \
  http://127.0.0.1:3000/api/runs/{runId}
```

`POST /api/runs` returns `202 Accepted` and a durable `runId` before the scraper
work begins. Multiple owned runs may wait in PostgreSQL, while a partial unique
index and atomic claim permit only one `running` row at a time. Status, result,
and list reads require the same trusted `X-User-Id`; foreign and missing run IDs
both return `404`. Completed result rows have no application expiry.

The private backend contract also provides:

- `POST /api/run-intents` to validate and store an anonymous search for one hour;
- `POST /api/run-intents/{intentId}/claim` to atomically and idempotently attach
  that search to the authenticated user and create its queued run;
- `GET /api/runs?page=1&pageSize=20` to list only the requesting user's runs; and
- owner-filtered `GET /api/runs/{runId}` and `/results` endpoints.

The browser must never send or choose `X-User-Id`. Only the private Next.js BFF
derives it from a verified Neon Auth session and forwards it with the service
token.

If required Google or OpenAI configuration is missing, `POST /run` returns `503`
and names the missing variables.

## Processing behavior

For each shop type, the application:

1. Performs one bounded, web-assisted research and candidate-generation call.
2. Validates syntax, product intent, category fit, and duplicates in Node.js.
3. Probes candidates against the first Google Custom Search result page.
4. Scores relevance, distinct Shopify hosts, evidence, and pagination.
5. Repairs a weak set up to two times and selects approximately ten diverse queries.
6. Reuses the selected probes, so Google does not fetch those searches twice.
7. Rejects assets, resolves canonical domains, and deduplicates stores.
8. Validates active Shopify evidence and category relevance.
9. Discovers contact pages and uses Browserless only as a fetch fallback.
10. Extracts deterministic contact evidence and optionally normalizes that evidence.
11. Scores the lead and writes one consolidated record per store.

Individual search results or stores may fail without ending the batch. Qualified,
rejected, and failed outcomes remain visible in the output for auditing.

## Output and retention

The HTTP path stores the complete result set transactionally in PostgreSQL and
returns snake_case JSON fields matching the legacy lead CSV. Query-planning audits
remain temporary and are not stored or exposed through the API.

`npm run run:once` still writes `data/generated-queries.csv` and
`data/leads.csv`. The frontend is responsible for building downloadable CSV from
the paginated JSON results.

See `FRONTEND_BACKEND_QUICKSTART.md` for proxy routes, TypeScript shapes,
polling, filters, and fixture seeding.

## Query-planning controls

The defaults favor quality while bounding spend:

```env
GENERATED_QUERY_COUNT=10
QUERY_CANDIDATE_COUNT=25
QUERY_REPAIR_ROUNDS=2
QUERY_PROBE_CONCURRENCY=3
MIN_QUERY_RESULTS=5
MIN_QUERY_UNIQUE_HOSTS=4
ENABLE_WEB_RESEARCH=true
MAX_RESEARCH_SOURCES=8
RESEARCH_GEOGRAPHY=global English-language market
```

One category normally uses one OpenAI research call and up to 25 Google probe
requests. A weak set may add up to two OpenAI repair calls and more Google probes.
Probe concurrency limits planning latency; `STORE_CONCURRENCY` controls the heavier
storefront/contact stage. Google result-total estimates are recorded for audit only
and do not drive selection.

## Test

```bash
npm test
```

The suite covers API contract behavior, result serialization, category safety and
aliases, strict AI request shape, fallback and
repair behavior, candidate validation, probe scoring and caching, diversity
selection, CSV behavior, domain resolution, sitemap variants, host restrictions,
contact extraction, lead scoring, store deduplication, failure isolation, cached
probe handoff, and server job control.

Default tests make no Google, Browserless, OpenAI, or database calls. Database
integration tests require both `ALLOW_DATABASE_TESTS=true` and a dedicated
`TEST_DATABASE_URL`.
