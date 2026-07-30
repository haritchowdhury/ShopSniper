# Shopify Lead Generator

A small, dependency-free Node.js server that replaces the two n8n workflows. It reads
broad shop types from a one-column CSV, researches and generates product-oriented
Shopify searches, probes and ranks those searches, discovers qualified stores,
extracts evidence-backed contact details, and writes auditable CSV outputs.

## Requirements

- Node.js 20 or newer
- A Google Custom Search API key and Programmable Search Engine ID
- An OpenAI API key for category research and candidate generation
- Optional Browserless credentials for pages that require rendering

No `npm install` is required because the application has no runtime dependencies.

## Configure

Copy the example configuration:

```bash
cp .env.example .env
```

At minimum, set:

```env
GOOGLE_API_KEY=your_new_key
GOOGLE_SEARCH_ENGINE_ID=your_search_engine_id
OPENAI_API_KEY=your_openai_key
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
machine must reach it; add authentication or keep it behind a private trusted
network before exposing it.

## Input

Edit `data/categories.csv`. The required header is exactly `Shop Type`:

```csv
Shop Type
clothing
baby food
kitchen utensils
```

Blank values are skipped, aliases such as `babyfood` and `utensils` are normalized,
and duplicate categories are collapsed. Malformed or instruction-like rows are
rejected into the generated-query audit instead of being sent to the model.

Paths can be changed only through trusted server environment configuration:

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
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/run
curl http://127.0.0.1:3000/status
```

`POST /run` returns `202 Accepted` and processes the batch asynchronously. Only one
job can run at a time; another request returns `409 Conflict`. `GET /status` reports
the current stage and planning counters. When `state` becomes `completed`, leads are
available at `data/leads.csv` and query decisions at
`data/generated-queries.csv`.

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

## Output

`data/generated-queries.csv` records every selected and rejected candidate with its
score, result count, distinct host count, pagination signal, market signal, source
URLs, status, and rejection reason.

`data/leads.csv` retains the original discovery, domain identity, contact evidence,
confidence, status, rejection, and error fields. It also records `shop_type`,
`generated_query`, `query_score`, and `query_generation_reason` on every lead row.
Social profiles are encoded as a JSON array within the CSV field.

The output is first written to a temporary file in the output directory and renamed
only after the complete CSV is ready. An interrupted run therefore does not replace
the previous completed output.

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

The suite covers category safety and aliases, strict AI request shape, fallback and
repair behavior, candidate validation, probe scoring and caching, diversity
selection, CSV behavior, domain resolution, sitemap variants, host restrictions,
contact extraction, lead scoring, store deduplication, failure isolation, cached
probe handoff, and server job control.

Tests make no Google, Browserless, or OpenAI calls.
