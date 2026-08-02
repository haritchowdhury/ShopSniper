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

All categories use the same AI-researched product vocabulary and validation path.
There are no category-specific runtime catalogs. If initial category research fails,
the planner reports that failure rather than substituting canned queries for selected
example categories.

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

This legacy foreground command supports only unenriched CSV output. Keep both
`ENABLE_DATAFORSEO_ENRICHMENT` and `ENABLE_CRUX_ENRICHMENT` set to `false` when
using it. If either flag is enabled, the command stops before the pipeline or
output writer runs and directs the operator to the durable server workflow.

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

`POST /api/runs` returns `202 Accepted` and a durable `runId`, then performs only
query planning. The selected queries and bounded probe evidence are stored as
editable PostgreSQL rows. When status reaches
`awaiting_query_confirmation`, the frontend reads and replaces revisions through
`GET/PUT /api/runs/{runId}/queries`, then locks the saved revision with
`POST /api/runs/{runId}/start`. Store discovery and lead extraction begin only
after that final sanity check passes.

Multiple owned runs may wait in PostgreSQL, while a partial unique index and
atomic claim permit only one `running` row at a time. A run waiting for query
review holds no worker lease. Status, query, result, and list reads require the
same trusted `X-User-Id`; foreign and missing run IDs both return `404`.
Editable drafts and completed result rows have no application expiry.

The HTTP service is a long-running Node worker. Each database claim carries an
opaque owner/token lease, and progress, heartbeat, failure, and completion writes
must present that active unexpired lease. Another instance cannot fail or publish
the run. Workers renew leases during long provider calls; expired or legacy
unleased running work is marked failed once with a safe interruption error. This
does not make the complete scraper suitable for a single AWS Lambda invocation.

The private backend contract also provides:

- `POST /api/run-intents` to validate and store an anonymous search for one hour;
- `POST /api/run-intents/{intentId}/claim` to atomically and idempotently attach
  that search to the authenticated user and create its queued run;
- `GET /api/runs?page=1&pageSize=20` to list only the requesting user's runs; and
- owner-filtered `GET /api/runs/{runId}`, `/queries`, `/results`, `/query-audits`, and
  `/diagnostics` endpoints.

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
4. Scores meaningful query coverage and distinct usable Shopify hosts.
5. Repairs a weak set up to two times and selects approximately ten diverse queries.
6. Reuses the selected probes, so Google does not fetch those searches twice.
7. Rejects assets, resolves verified identities, and merges all store occurrences
   without losing category/query provenance.
8. Validates active Shopify evidence and category relevance.
9. Discovers contact pages and uses Browserless only as a fetch fallback.
10. Extracts deterministic contact evidence and optionally normalizes that evidence.
11. Applies mandatory store/contactability gates, calculates explainable score v2
    only for qualified stores, and writes one consolidated record per store.

Individual search results or stores may fail without ending the batch. Qualified,
rejected, and store-processing failed outcomes remain visible in the lead output.
Query and unresolved-occurrence failures are separate diagnostics and do not
inflate lead counts.

## Output and retention

The HTTP path stores leads, query audits, diagnostics, versions, summary, and the
publication flag in one PostgreSQL transaction. It returns backward-compatible
snake_case lead fields plus versioned evidence and score breakdowns. Historical
unversioned rows remain readable as legacy score-v1 records.

With both traffic flags disabled, `npm run run:once` still writes
`data/generated-queries.csv` and `data/leads.csv`. It does not create traffic
enrichment and is not permitted to call traffic providers, caches, or the paid
request ledger. Traffic-enriched runs use the durable HTTP server workflow. The
frontend builds customer-downloadable CSV from those runs' paginated JSON
results.

### Optional traffic enrichment

Traffic enrichment is disabled by default and is controlled by the independent
`ENABLE_DATAFORSEO_ENRICHMENT` and `ENABLE_CRUX_ENRICHMENT` server flags. Their
values, provider contracts, cache policy, scopes, and cost/byte caps are
snapshotted when a run is created. Clients cannot choose or change them.

When both sources were disabled, or when reading a historical run without a
snapshot, result leads retain the legacy shape and omit `traffic_enrichment`.
An enabled source has an explicit state, but source lists and attribution are
emitted only when accepted metrics are present. Missing coverage and provider
failure are not numeric zero. DataForSEO values are labelled estimated Google
search traffic and must not be presented as total site visits. CrUX popularity
is a coarse navigation rank, and its device fractions describe observed form
factors rather than geography.

The versioned `traffic-enrichment-public-v1` object groups current CrUX origin
metrics and monthly popularity under one `crux` source while keeping their
states separate. The durable result API contains only normalized metrics. The
backend CSV formatter can also flatten an already-serialized and validated
public traffic object for deterministic export, but that formatter capability
does not make `npm run run:once` an enrichment workflow. Cache entries,
paid-request ledger details, provider task IDs, raw responses, costs, and
internal errors are never public lead data. CSV source columns are selected
dynamically, so a disabled provider contributes no columns.

CrUX-derived API and CSV material includes links to the Chrome UX Report source
and its CC BY 4.0 license plus a transformation notice. Final attribution
wording still requires legal review before commercial release. Customer-facing
DataForSEO display/export must remain operationally disabled until written
permission for the intended use is recorded.

Before production enablement, also verify current provider pricing and quotas,
the DataForSEO per-run cost cap, the BigQuery maximum-bytes cap, and an approved
short-lived AWS-to-Google credential mechanism such as Workload Identity
Federation. Do not deploy Application Default Credential files or long-lived
Google service-account JSON keys.

See `FRONTEND_BACKEND_QUICKSTART.md` for proxy routes, TypeScript shapes,
polling, filters, and fixture seeding.

## Query-planning controls

The defaults favor quality while bounding spend:

```env
GENERATED_QUERY_COUNT=10
QUERY_CANDIDATE_COUNT=30
QUERY_REPAIR_ROUNDS=4
MAX_QUERY_PROBES_PER_CATEGORY=80
QUERY_PROBE_CONCURRENCY=3
MIN_QUERY_RELEVANT_RESULTS=3
MIN_QUERY_RELEVANCE_RATIO=0.50
MIN_QUERY_BASE_SCORE=60
MIN_QUERY_RESULTS=5
MIN_QUERY_UNIQUE_HOSTS=4
ENABLE_WEB_RESEARCH=true
MAX_RESEARCH_SOURCES=8
RESEARCH_GEOGRAPHY=global English-language market
```

Query planning now has a hard completion contract: each category produces exactly
`GENERATED_QUERY_COUNT` passing queries or the run fails with the auditable
`INSUFFICIENT_HIGH_QUALITY_QUERIES` code. It never publishes a partial query list.
One category normally uses one OpenAI research call and probes candidates in
adaptive batches. A weak set may add up to four targeted repair calls, but never
more than `MAX_QUERY_PROBES_PER_CATEGORY` unique Google requests.
Probe concurrency limits planning latency; `STORE_CONCURRENCY` controls parallel
stores and `PAGE_FETCH_CONCURRENCY` (default `2`) bounds evidence-page work within
one store. Google result-total estimates and next-page availability are recorded
for audit only and do not drive selection.

## Test

```bash
npm test
npm run check:secrets
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

Local n8n workflow exports are deliberately ignored and must not be force-added.
The redacted secret check scans repository files but reports only a pattern class,
path, and line number. Credential values must never be copied into test output or
handoff evidence.
