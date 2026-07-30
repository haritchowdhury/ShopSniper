# Shopify Lead Generator

A small, dependency-free Node.js server that replaces the two n8n workflows. It reads
search queries from a designated CSV file, discovers and qualifies Shopify stores,
extracts evidence-backed contact details, and atomically writes one row per store to
an output CSV.

## Requirements

- Node.js 20 or newer
- A Google Custom Search API key and Programmable Search Engine ID
- Optional Browserless credentials for pages that require rendering
- Optional OpenAI credentials for evidence normalization

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
```

The Google and Browserless values found in the old n8n exports must be treated as
exposed and rotated. Do not copy those old values into `.env`.

Browserless is used only when a normal HTML request fails or returns incomplete
content:

```env
BROWSERLESS_TOKEN=your_new_token
BROWSERLESS_FALLBACK_TOKEN=an_optional_second_token
```

OpenAI is optional. Without it, deterministic email, phone, contact-page, JSON-LD,
and social-profile extraction still runs:

```env
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4.1-mini
```

The service binds to `127.0.0.1` by default. Set `HOST` deliberately if another
machine must reach it; add authentication or keep it behind a private trusted
network before exposing it.

## Input

Edit `data/input.csv`. The required header is exactly `Search Query`:

```csv
Search Query
"site:myshopify.com/products ""salt free seasoning"""
"site:myshopify.com/collections ""organic skincare"""
```

Paths can be changed only through trusted server environment configuration:

```env
INPUT_CSV=./data/input.csv
OUTPUT_CSV=./data/output.csv
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
job can run at a time; another request returns `409 Conflict`. When `state` becomes
`completed`, the result is available at `data/output.csv` by default.

If required Google configuration is missing, `POST /run` returns `503` and names the
missing variables.

## Processing behavior

For each query, the application:

1. Retrieves up to ten Google Custom Search results.
2. Rejects assets and unsupported URLs.
3. Follows redirects and reads canonical metadata.
4. Resolves `myshopify.com` results to verified custom storefront domains.
5. Deduplicates before Browserless or OpenAI work.
6. Validates active Shopify evidence and category relevance.
7. Reads direct sitemaps and sitemap indexes for high-value contact routes.
8. Fetches normally first and uses Browserless only as a fallback.
9. Extracts deterministic contact evidence and retains source URLs.
10. Optionally uses OpenAI to normalize—but never create—supplied evidence.
11. Scores the lead and writes one consolidated record per store.

Individual search results or stores may fail without ending the batch. Qualified,
rejected, and failed outcomes remain visible in the output for auditing.

## Output

The output includes discovery, domain identity, contact evidence, confidence scores,
status, rejection reason, and error columns. Social profiles are encoded as a JSON
array within the CSV field.

The output is first written to a temporary file in the output directory and renamed
only after the complete CSV is ready. An interrupted run therefore does not replace
the previous completed output.

## Test

```bash
npm test
```

The suite covers CSV behavior, domain resolution, sitemap variants, host
restrictions, contact extraction, AI schema validation, scoring, store
deduplication, failure isolation, and server job control.

Tests make no Google, Browserless, or OpenAI calls.
