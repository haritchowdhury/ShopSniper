# Backend-to-Frontend JSON Handoff Specification

## Purpose

This document defines the exact backend contract required before building the
frontend. The backend remains responsible for running the lead-generation job,
validating and scoring results, and retaining results by run ID in Neon
PostgreSQL through Prisma ORM. The frontend is responsible for accepting manual
category entries, displaying the JSON results, and generating downloadable CSV
files.

This specification supersedes both the CSV-download and DynamoDB/S3 result-storage
portions of `AWS_ASYNC_DEPLOYMENT_DIRECTION.md`. The overall asynchronous job
architecture in that document remains valid.

## Product decision

Use JSON as the source of truth between the backend and frontend.

- The backend must not require the frontend to read a server-side CSV.
- The backend must expose lead results as JSON using the same logical field names
  and order as the existing output CSV.
- The frontend must generate CSV only when the user selects an export action.
- Categories are entered manually in the frontend. CSV upload is not part of the
  first frontend.
- Query candidates and query-audit records are internal planning data. They may
  remain in memory during a run and are discarded after the run completes.
- A run must be addressable by an opaque `runId`.
- Refreshing the browser must not start a new run.
- Production results must survive an API process restart.
- Completed runs and lead results have no application expiry and remain available
  until they are explicitly deleted or the database itself is removed.
- The API must never return API keys, filesystem paths, internal stack traces, or
  raw HTML collected from stores.

## Confirmed frontend stack

The frontend will use:

- Next.js with the App Router.
- TypeScript.
- Vercel for hosting and deployment.
- Client-side CSV generation after JSON results are fetched.

The long-running scraper must not execute inside a Vercel Function. Vercel will
host the UI and short-lived Next.js Route Handlers only. The scraper remains on
the separate backend worker described in `AWS_ASYNC_DEPLOYMENT_DIRECTION.md`.

The required deployment boundary is:

```text
Browser
  |
  v
Next.js application on Vercel
  |
  | short HTTP requests through Next.js Route Handlers
  v
Backend run API and Prisma ORM
  |
  v
Long-running scraper worker and Neon PostgreSQL
```

No Vercel request may remain open while the scraper runs. The start request must
return a `runId`, and all subsequent communication must use polling and paginated
result requests.

## Next.js backend-for-frontend requirement

Use Next.js Route Handlers as a thin backend-for-frontend proxy. The browser
should call same-origin Next.js endpoints such as `/api/runs`, and those handlers
should call the actual backend URL.

Benefits of this required structure:

- The real backend base URL does not need to be exposed as a `NEXT_PUBLIC_`
  variable.
- Browser-to-backend CORS is avoided.
- Authentication can be checked on the Vercel server before proxying.
- A backend service token can remain server-only.
- The frontend has one same-origin API contract in local, preview, and production
  deployments.

Route Handlers must remain thin. They may authenticate, validate a small amount of
request metadata, proxy the request, and normalize network failures. They must not
run scraping logic, store complete result sets, generate CSV, or wait for a run to
finish.

### Required Vercel environment variables

Configure these in Vercel Project Settings for Development, Preview, and
Production as appropriate:

```text
BACKEND_API_BASE_URL=https://api.example.com
BACKEND_API_TOKEN=<server-to-server token if required>
```

Rules:

- `BACKEND_API_BASE_URL` must not end with `/`.
- Neither variable may use the `NEXT_PUBLIC_` prefix.
- `BACKEND_API_TOKEN` must be stored as a Vercel secret/environment variable and
  must never be returned to the browser.
- Local development values belong in `.env.local`, which must remain ignored by
  Git.
- The frontend must fail with a clear server-side configuration error if
  `BACKEND_API_BASE_URL` is missing.
- Do not copy Google, OpenAI, Browserless, AWS, or database credentials into the
  Vercel project. Those credentials belong only to the scraper backend.

### Required Next.js Route Handlers

Create these files in the frontend repository:

```text
app/api/health/route.ts
app/api/runs/route.ts
app/api/runs/[runId]/route.ts
app/api/runs/[runId]/results/route.ts
```

Their responsibilities are:

| Next.js route | Backend request |
|---|---|
| `GET /api/health` | `GET {BACKEND_API_BASE_URL}/api/health` |
| `POST /api/runs` | `POST {BACKEND_API_BASE_URL}/api/runs` |
| `GET /api/runs/{runId}` | `GET {BACKEND_API_BASE_URL}/api/runs/{runId}` |
| `GET /api/runs/{runId}/results` | Same backend path and query string |

Every handler must:

- Use the Node.js runtime unless a later dependency explicitly supports Edge.
- Call the backend with `cache: "no-store"`.
- Forward the backend response status code and JSON body.
- Forward only approved query parameters.
- Set `Cache-Control: no-store` on its response.
- Apply a short request timeout with `AbortController`.
- Convert an unreachable backend into a `502 BACKEND_UNAVAILABLE` response.
- Never include the backend token or backend response headers in an error message.
- Validate `runId` as an opaque path value and URL-encode it before constructing
  the backend URL.

For the first version, a valid run ID must match
`^run_[A-Za-z0-9_-]{16,80}$`. The frontend must treat it as an opaque string and
must never parse meaning from it.

If `BACKEND_API_TOKEN` is configured, send it only on the server-to-server
request:

```http
Authorization: Bearer <BACKEND_API_TOKEN>
```

Do not blindly forward all browser headers, cookies, or query parameters to the
backend.

### Route Handler timeout behavior

The route-handler timeout applies only to the individual control or data request,
not to the complete scraping run. Suggested limits:

```text
POST /api/runs                         15 seconds
GET  /api/runs/{runId}                 10 seconds
GET  /api/runs/{runId}/results         20 seconds
```

If one of these calls times out, return:

```http
HTTP/1.1 504 Gateway Timeout
```

```json
{
  "error": {
    "code": "BACKEND_TIMEOUT",
    "message": "The backend did not respond in time. Please try again."
  }
}
```

### Required Next.js pages and client modules

Create at least:

```text
app/page.tsx
app/runs/[runId]/page.tsx
components/run-form.tsx
components/run-progress.tsx
components/results-table.tsx
components/results-filters.tsx
components/export-csv-button.tsx
lib/api-types.ts
lib/csv-export.ts
lib/stages.ts
```

Recommended ownership:

- `app/page.tsx`: page shell and run-creation presentation.
- `run-form.tsx`: category input, validation display, and `POST /api/runs`.
- `app/runs/[runId]/page.tsx`: reads the route parameter and renders the run view.
- `run-progress.tsx`: polling lifecycle and progress counters.
- `results-table.tsx`: paginated lead rows.
- `results-filters.tsx`: status, text search, and sorting controls.
- `export-csv-button.tsx`: fetch-all-pages workflow and download state.
- `api-types.ts`: TypeScript types matching this document exactly.
- `csv-export.ts`: CSV mapping, escaping, formula protection, and browser download.
- `stages.ts`: backend stage-to-user-label mapping.

Do not place CSV serialization in a React component. Keep it as a tested pure
function in `lib/csv-export.ts`.

### Next.js data-fetching rules

- The run form and interactive run screen will be Client Components.
- Use `fetch` against same-origin `/api/...` Route Handlers.
- Do not use a Server Action to wait for the scraper.
- Do not statically render or cache run status and result pages.
- Any server-side fetch of run data must use `cache: "no-store"`.
- The run page must be directly addressable and reload-safe at `/runs/{runId}`.
- Store filter and pagination values in URL search parameters so that browser
  back/forward navigation behaves correctly.
- Do not put complete lead result arrays in `localStorage`, cookies, page URLs, or
  React Server Component payloads.

### Polling implementation requirements

Use a self-scheduling timeout instead of an unconditional `setInterval` so slow
requests cannot overlap.

- Poll every three seconds while state is `queued` or `running`.
- Start the next timer only after the previous request finishes.
- Cancel the active fetch with `AbortController` when the component unmounts or
  the `runId` changes.
- Stop polling on `completed`, `failed`, or `cancelled`.
- On a temporary network failure, retain the last successful status and retry.
- Use a bounded retry delay, for example 3, 5, 10, then 15 seconds.
- Show a connection warning after a failed poll; do not incorrectly mark the run
  as failed.
- When `resultsAvailable` becomes `true`, invalidate/refetch result queries.

React Strict Mode in development may mount effects more than once. Polling cleanup
must prevent duplicate active timers and duplicate requests.

### Vercel preview deployment behavior

Preview deployments must use a non-production backend when available. If previews
must use the production backend temporarily:

- Require authentication.
- Tag or otherwise identify preview-created runs.
- Apply the same run-creation rate limits.
- Never place production backend secrets in source code.

Because the browser calls same-origin Route Handlers, dynamically generated Vercel
preview domains do not need to be added to the scraper backend's CORS allowlist.

## Required user flow

```text
User enters one or more shop types
             |
             v
Frontend sends POST /api/runs
             |
             v
Backend validates input and immediately returns runId
             |
             v
Frontend polls GET /api/runs/{runId}
             |
             v
Backend completes and stores JSON results by runId
             |
             v
Frontend fetches GET /api/runs/{runId}/results
             |
             v
Frontend displays, filters, and exports the data as CSV
```

The initial frontend does not need WebSockets, Server-Sent Events, or live
streaming of individual leads. Polling once every three seconds is sufficient.

## Required endpoints

### 1. Health check

```http
GET /api/health
```

Successful response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "status": "ok"
}
```

The backend health check must perform a lightweight Prisma database query. If
PostgreSQL is unavailable, return `503 DATABASE_UNAVAILABLE` using the standard
safe error shape. Do not include Prisma error text or connection details.

### 2. Start a run

```http
POST /api/runs
Content-Type: application/json
```

Request body:

```json
{
  "shopTypes": ["clothing", "eyewear", "baby food"]
}
```

The frontend builds this array from manual category-entry controls. It must not
upload or send an input CSV. `shopTypes` is the JSON equivalent of the existing
one-column input CSV headed `Shop Type`.

Validation requirements:

- `Content-Type` must be `application/json`.
- The body must not exceed 32 KiB.
- `shopTypes` must be an array.
- The array must contain between 1 and `MAX_SHOP_TYPES` entries.
- Every entry must be a string.
- Every entry must pass the existing `normalizeShopType` validation.
- Blank values must be rejected instead of silently accepted through the API.
- Duplicate normalized categories must be collapsed while preserving the first
  occurrence.
- The API must not accept API keys, model names, filesystem paths, scoring
  thresholds, concurrency settings, or arbitrary environment overrides.

Successful response:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
Cache-Control: no-store
Location: /api/runs/run_01J...
```

```json
{
  "runId": "run_01J...",
  "state": "queued",
  "statusUrl": "/api/runs/run_01J...",
  "resultsUrl": "/api/runs/run_01J.../results",
  "createdAt": "2026-07-31T12:00:00.000Z"
}
```

The endpoint must return after validating the request, creating the run record,
and scheduling the work. It must not wait for AI research, Google searches, store
fetches, or lead extraction.

For the local MVP, only one run may execute at a time. If another run is active,
return:

```http
HTTP/1.1 409 Conflict
```

```json
{
  "error": {
    "code": "RUN_ALREADY_ACTIVE",
    "message": "A lead-generation run is already active.",
    "details": {
      "runId": "run_01J..."
    }
  }
}
```

### 3. Read run status

```http
GET /api/runs/{runId}
```

Running response:

```json
{
  "runId": "run_01J...",
  "state": "running",
  "stage": "extracting_leads",
  "createdAt": "2026-07-31T12:00:00.000Z",
  "startedAt": "2026-07-31T12:00:01.000Z",
  "completedAt": null,
  "progress": {
    "shopTypesTotal": 3,
    "shopTypesProcessed": 3,
    "blankShopTypesSkipped": 0,
    "invalidShopTypes": 0,
    "queryCandidatesGenerated": 75,
    "queryCandidatesValidated": 62,
    "queryCandidatesProbed": 62,
    "queriesSelected": 30,
    "planningWarnings": 0,
    "queriesTotal": 30,
    "queriesProcessed": 30,
    "storesDiscovered": 146,
    "storesQualified": 82,
    "storesRejected": 11,
    "failures": 2,
    "outputRows": 95
  },
  "resultsAvailable": false,
  "error": null
}
```

Completed response:

```json
{
  "runId": "run_01J...",
  "state": "completed",
  "stage": "completed",
  "createdAt": "2026-07-31T12:00:00.000Z",
  "startedAt": "2026-07-31T12:00:01.000Z",
  "completedAt": "2026-07-31T12:31:22.000Z",
  "progress": {
    "shopTypesTotal": 3,
    "shopTypesProcessed": 3,
    "blankShopTypesSkipped": 0,
    "invalidShopTypes": 0,
    "queryCandidatesGenerated": 75,
    "queryCandidatesValidated": 62,
    "queryCandidatesProbed": 62,
    "queriesSelected": 30,
    "planningWarnings": 0,
    "queriesTotal": 30,
    "queriesProcessed": 30,
    "storesDiscovered": 146,
    "storesQualified": 90,
    "storesRejected": 20,
    "failures": 4,
    "outputRows": 114
  },
  "resultsAvailable": true,
  "error": null
}
```

Allowed `state` values:

```text
queued
running
completed
failed
cancelled
```

Allowed `stage` values:

```text
queued
reading_categories
researching_category
generating_candidates
validating_candidates
probing_queries
selecting_queries
discovering_stores
extracting_leads
writing_results
completed
failed
cancelled
```

The backend must set `resultsAvailable` to `true` only after the complete result
set has been stored successfully. It must not report `completed` before that point.

If the run fails, `error` must contain a safe user-facing message:

```json
{
  "runId": "run_01J...",
  "state": "failed",
  "stage": "failed",
  "resultsAvailable": false,
  "error": {
    "code": "RUN_FAILED",
    "message": "The run could not be completed. Please try again."
  }
}
```

Log the detailed internal error on the backend, but do not send stack traces,
credentials, request headers, or local paths to the browser.

### 4. Read lead results

```http
GET /api/runs/{runId}/results?page=1&pageSize=100&status=qualified
```

Query parameters:

| Parameter | Required | Rules |
|---|---:|---|
| `page` | No | Integer, minimum 1, default 1 |
| `pageSize` | No | Integer from 1 to 200, default 100 |
| `status` | No | `qualified`, `rejected`, or `failed` |
| `search` | No | Case-insensitive match on store name, domain, email, or shop type |
| `sortBy` | No | `lead_score`, `store_name`, `shop_type`, or `google_rank` |
| `sortDirection` | No | `asc` or `desc` |

Do not accept arbitrary database column names for sorting.
`search` must be trimmed, limited to 200 characters, and matched against
`store_name`, `resolved_domain`, `myshopify_domain`, `email`, and `shop_type`.
Reject malformed supported parameters and unknown parameters with
`400 INVALID_QUERY_PARAMETERS`.

Successful response:

```json
{
  "runId": "run_01J...",
  "summary": {
    "total": 114,
    "qualified": 90,
    "rejected": 20,
    "failed": 4
  },
  "pagination": {
    "page": 1,
    "pageSize": 100,
    "totalItems": 90,
    "totalPages": 1
  },
  "items": [
    {
      "id": "lead_01J...",
      "shop_type": "eyewear",
      "generated_query": "site:myshopify.com/products photochromic sunglasses",
      "query_score": 100,
      "query_generation_reason": "Combines a concrete product with an established adaptive-lens term.",
      "search_query": "site:myshopify.com/products photochromic sunglasses",
      "google_rank": 1,
      "google_result_url": "https://example.myshopify.com/products/item",
      "myshopify_domain": "example.myshopify.com",
      "final_url": "https://example.com/products/item",
      "canonical_url": "https://example.com/products/item",
      "resolved_domain": "example.com",
      "store_name": "Example Store",
      "email": "hello@example.com",
      "email_source_url": "https://example.com/pages/contact",
      "phone": null,
      "phone_source_url": null,
      "contact_url": "https://example.com/pages/contact",
      "social_profiles": [
        "https://www.instagram.com/example"
      ],
      "additional_information": "pages_examined=5",
      "shopify_confidence": 100,
      "relevance_score": 80,
      "lead_score": 94,
      "status": "qualified",
      "rejection_reason": null,
      "error": null
    }
  ]
}
```

Results endpoint rules:

- Return `409 RESULTS_NOT_READY` if the run is queued or running.
- Return `409 RESULTS_UNAVAILABLE` if the run failed or was cancelled without a
  successfully committed result set.
- Return `404 RUN_NOT_FOUND` for an unknown run ID.
- `items` must always be an array.
- Each item must have a stable, opaque `id` suitable for a frontend table key.
- Missing text values must be `null`, not empty strings.
- Missing numeric values must be `null`, not empty strings.
- Scores and ranks must be JSON numbers.
- `social_profiles` must always be a JSON array of strings.
- `status` must be `qualified`, `rejected`, or `failed`.
- All URLs must remain plain strings. The backend must not return HTML anchor tags.
- `id` is transport metadata for stable frontend table keys and is not included in
  the generated CSV.
- `summary` always describes the complete run. `pagination.totalItems` describes
  the result set after applying the current filters.
- The default result order must be `lead_score` descending, then `store_name`
  ascending, then `id` ascending. Null scores sort last in both directions.

### Internal query-planning data

There is no public query-audit endpoint in the first version. Query candidates,
probe results, rankings, and rejected-query audits may remain in process memory or
temporary worker storage while a run is active. They are not part of the
backend-to-frontend contract and do not need to survive a process restart after
the final lead results have been committed.

The selected query metadata already present on each lead
(`generated_query`, `query_score`, `query_generation_reason`, and `search_query`)
must be retained with that lead in PostgreSQL.

## Standard API error shape

Every non-2xx JSON response must use:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Safe user-facing explanation.",
    "details": {}
  }
}
```

`details` is optional. It may contain validation field names and row indexes, but
must never contain secrets or internal stack traces.

Required status codes:

| Status | Use |
|---:|---|
| 400 | Invalid JSON or invalid shop types |
| 404 | Unknown endpoint or run ID |
| 409 | Active run conflict or results not ready |
| 413 | Request body exceeds 32 KiB |
| 415 | Unsupported content type |
| 429 | Rate limit reached |
| 500 | Unexpected internal error |
| 503 | Required backend configuration or external service unavailable |
| 502 | Next.js proxy cannot reach the backend |
| 504 | Next.js proxy request to the backend timed out |

## Backend data model

Neon PostgreSQL is the durable source of truth for run status and completed lead
results. Prisma ORM is the only application data-access layer. The HTTP run path
must not use an in-memory run repository, DynamoDB, S3 result objects, or local CSV
files as its durable store.

The database must contain a `Run` record and child `Lead` records. The Prisma
schema must model at least:

```prisma
enum RunState {
  queued
  running
  completed
  failed
  cancelled
}

enum LeadStatus {
  qualified
  rejected
  failed
}

model Run {
  id                  String    @id
  state               RunState
  stage               String
  normalizedShopTypes Json
  createdAt           DateTime  @default(now())
  startedAt           DateTime?
  completedAt         DateTime?
  progress            Json
  resultsAvailable    Boolean   @default(false)
  leadSummary         Json?
  safeErrorCode       String?
  safeErrorMessage    String?
  leads               Lead[]

  @@index([state])
  @@index([createdAt])
}

model Lead {
  id                       String     @id
  runId                    String
  run                      Run        @relation(fields: [runId], references: [id], onDelete: Cascade)
  shopType                 String?
  generatedQuery           String?
  queryScore               Int?
  queryGenerationReason    String?
  searchQuery              String?
  googleRank               Int?
  googleResultUrl          String?
  myshopifyDomain          String?
  finalUrl                 String?
  canonicalUrl             String?
  resolvedDomain           String?
  storeName                String?
  email                    String?
  emailSourceUrl           String?
  phone                    String?
  phoneSourceUrl           String?
  contactUrl               String?
  socialProfiles           String[]   @default([])
  additionalInformation    String?
  shopifyConfidence        Int?
  relevanceScore           Int?
  leadScore                Int?
  status                   LeadStatus
  rejectionReason          String?
  error                    String?

  @@index([runId, status])
  @@index([runId, leadScore])
  @@index([runId, storeName])
  @@index([runId, shopType])
  @@index([runId, googleRank])
}
```

Exact table and column mappings may use `@map` and `@@map`, but the public JSON
serializer must use the snake_case output names defined by this document.

There is deliberately no `expiresAt` field, TTL, lifecycle deletion, or automatic
cleanup job. Completed results remain downloadable for as long as:

- the Neon project and database are retained;
- the records are not explicitly deleted;
- database migrations preserve the data; and
- the database can be restored after an operational failure.

“Indefinitely downloadable” is therefore an application retention policy, not a
guarantee independent of the database provider. Neon backups or point-in-time
restore, an appropriate paid plan when needed, and periodic external backups are
operational requirements before the data becomes business-critical.

### Prisma and Neon configuration

The database connection belongs only to the scraper backend:

```text
DATABASE_URL=<pooled Neon runtime connection URL>
# Optional fallback for migrations only:
DIRECT_URL=<direct Neon connection URL>
```

- Never copy a database URL into the frontend repository or Vercel frontend
  environment variables.
- `DATABASE_URL` is used by Prisma Client at runtime and, by default, by Prisma
  Migrate and other CLI operations.
- `prisma.config.ts` uses `DIRECT_URL` when provided and otherwise falls back to
  `DATABASE_URL`.
- The confirmed first-version configuration uses only the pooled `DATABASE_URL`.
  Add `DIRECT_URL` later only if a migration demonstrates that a non-pooled
  connection is required.
- Connection strings and Prisma errors must never be returned through the API.

Use Prisma migrations for all schema changes. Do not use automatic destructive
schema synchronization against production.

### Result commit behavior

After the pipeline finishes, the backend must save all lead rows and the final run
summary in a database transaction. In the same transaction it must set
`resultsAvailable = true`, `state = completed`, `stage = completed`, and
`completedAt`.

If that transaction fails, the run must not report completed or make a partial
result set downloadable. Retry safely by making the result commit idempotent for
the `runId`. Query-planning records are discarded after a successful result
commit.

## Required changes to the current Node.js backend

### `src/server.js`

Replace the single global status object with a Prisma-backed run repository keyed
by `runId`.

Add:

- JSON request-body parsing with a 32 KiB limit.
- `GET /api/health`.
- `POST /api/runs`.
- `GET /api/runs/:runId`.
- `GET /api/runs/:runId/results`.
- Standard error serialization.
- Private backend access enforcement described below.

The current `/health`, `/run`, and `/status` routes may temporarily remain as
compatibility routes, but the frontend must use the `/api` contract.

Capture the pipeline result instead of discarding it:

```js
const result = await pipeline(runConfig, status);
await runRepository.saveCompletedResults(runId, result);
```

### `src/pipeline.js`

Stop treating CSV writing as the only terminal sink.

Return the lead collection and summary:

```js
{
  leads: [...],
  summary: {
    total: 0,
    qualified: 0,
    rejected: 0,
    failed: 0
  }
}
```

The web-server execution path must not require `OUTPUT_CSV` or
`GENERATED_QUERIES_CSV`.

The pipeline may continue using its existing internal snake_case records. The
Prisma repository maps those records to its model fields, and the API serializer
returns the snake_case JSON schema defined in this document while normalizing
blank strings to `null`.

### `src/query-planner.js`

Stop requiring the HTTP path to read categories from `config.inputCsv`. Pass the
normalized manual `shopTypes` from the accepted run record directly into the
planner. `readCategories` remains available only to `npm run run:once`.

The planner may continue producing `audits` internally and may write a temporary
audit for local debugging, but audits are not persisted in PostgreSQL and are not
returned by the public API.

### `src/output.js` and `src/query-audit.js`

Keep these modules only for:

- The optional `npm run run:once` command.
- Tests of legacy CSV compatibility.
- Emergency server-side exports if explicitly required later.

The HTTP run path must not depend on these files being writable.

### Suggested new modules

```text
prisma/schema.prisma          Run and Lead models
prisma.config.ts              Prisma CLI and migration configuration
src/prisma-client.js          One backend Prisma Client instance
src/prisma-run-repository.js  Run status, result commit, filters, and pagination
src/api-serializer.js         Internal/Prisma record to public JSON conversion
src/api-errors.js             Safe typed API errors
src/request-json.js           Size-limited JSON body parser
```

Do not put Prisma queries, CSV formatting, and request routing into one file.

## Frontend requirements

### Run creation

- Provide manual category-entry controls that support multiple shop types.
- Do not provide CSV upload in the first frontend.
- Trim client-side whitespace before submission.
- Do not rely only on frontend validation; display backend validation errors.
- Disable the start button while the request is being submitted.
- After a successful response, route to `/runs/{runId}`.

### Progress screen

- Poll `GET /api/runs/{runId}` every three seconds.
- Stop polling for `completed`, `failed`, or `cancelled`.
- Do not create another run when the page reloads.
- Keep the `runId` in the URL.
- Display the current stage and the available counters.
- Do not display a fabricated percentage when a reliable total is not yet known.
- Fetch results only when `resultsAvailable` is `true`.
- After completion, show that the results have no scheduled expiry and keep the
  direct `/runs/{runId}` URL reloadable. The user can bookmark that URL to return
  to the stored result set.

### Results screen

Provide:

- Summary cards for total, qualified, rejected, and failed rows.
- Tabs or filters for `qualified`, `rejected`, and `failed`.
- Search by store, domain, email, or category.
- Sort by lead score, store name, category, and Google rank.
- Server-side pagination.
- Links for store, source, contact, and social URLs.
- A clear empty state when a filter has no results.
- A visible error/rejection reason for non-qualified records.
- “Export all results” and “Export current filtered results” actions.

Treat all returned text as untrusted. Render it as text, not HTML. External links
must use `target="_blank"` with `rel="noopener noreferrer"`.

## Frontend CSV export rules

The frontend must export the same logical lead fields in this order:

```text
shop_type
generated_query
query_score
query_generation_reason
search_query
google_rank
google_result_url
myshopify_domain
final_url
canonical_url
resolved_domain
store_name
email
email_source_url
phone
phone_source_url
contact_url
social_profiles
additional_information
shopify_confidence
relevance_score
lead_score
status
rejection_reason
error
```

CSV implementation requirements:

- Encode as UTF-8.
- A UTF-8 BOM may be added for Microsoft Excel compatibility.
- Use CRLF or LF consistently.
- Quote any field containing a comma, quote, carriage return, or newline.
- Escape an embedded quote by doubling it.
- Convert `null` and `undefined` to an empty field.
- Serialize `social_profiles` using `JSON.stringify`.
- Preserve numeric fields as numbers.
- Protect string cells from spreadsheet formula injection. If a string begins,
  after optional whitespace, with `=`, `+`, `-`, `@`, tab, or carriage return,
  prefix it with a single quote before CSV escaping.
- Use a tested CSV library when the frontend stack is selected rather than a
  hand-built `array.join(",")` implementation.

Recommended filename:

```text
leads-{runId}-{YYYY-MM-DD}.csv
```

To export all results from a paginated API, the frontend must fetch every page for
the selected filter before building the file. It must show an export-in-progress
state and must not silently export only the currently visible page.

## Network boundary, private access, and data protection

The first version has no application user accounts and no per-user run ownership.
It is a private-access deployment.

- The browser communicates only with same-origin Next.js Route Handlers, so the
  scraper backend does not need browser CORS.
- The scraper backend must not be publicly callable. Restrict it through private
  networking, an infrastructure allowlist, or a server-to-server
  `BACKEND_API_TOKEN`.
- The Next.js deployment itself must remain privately reachable through platform
  deployment protection, a private network, or an equivalent access restriction.
- An opaque `runId` is a lookup key, not an authentication mechanism.
- Do not add `userId` to the first database schema. Add users and ownership checks
  before changing the product to a public or multi-user deployment.
- Rate-limit run creation globally even on the private deployment.
- Do not place database, OpenAI, Google, or Browserless credentials in frontend
  environment variables.
- Do not log complete result payloads because they contain emails and phone
  numbers.
- Do not automatically expire completed runs. Any future deletion feature must be
  explicit, auditable, and delete the associated leads transactionally.

## Required automated tests

### API tests

- Starting a valid run returns `202` and an opaque `runId`.
- Multiple category values are normalized and deduplicated.
- Empty arrays, blank strings, invalid types, and instruction-like values return
  `400`.
- Invalid JSON returns `400`.
- A body over 32 KiB returns `413`.
- A non-JSON content type returns `415`.
- A second active local run returns `409`.
- An unknown run ID returns `404`.
- A running job returns `resultsAvailable: false`.
- Results requested before completion return `409`.
- A completed job returns `resultsAvailable: true`.
- Failed runs expose a safe error and no stack trace.

### Result serialization tests

- Blank internal strings become `null`.
- Scores and ranks are numbers or `null`.
- `social_profiles` is always an array.
- Lead IDs are stable within a run.
- Summary totals match the returned complete collection.
- Status filtering returns only matching records.
- Pagination metadata is correct for the first, middle, and last pages.
- Unsupported sort fields are rejected.

### Prisma persistence tests

- Creating a run stores its normalized manual categories in PostgreSQL.
- Status remains readable after restarting the API process.
- Completing a run commits its leads and final status atomically.
- A failed result transaction never exposes a partial downloadable result set.
- Two completed runs retain separate lead collections.
- Result filtering, sorting, and pagination are scoped by `runId`.
- Query-planning audits are not stored in PostgreSQL.
- Prisma errors and connection strings are never serialized to API clients.

### Frontend tests

- The UI submits the exact `shopTypes` request.
- Polling stops on every terminal state.
- Reloading a run page does not start another job.
- Filters and pagination use API query parameters.
- CSV export includes all fetched pages.
- CSV correctly handles commas, quotes, newlines, Unicode, nulls, arrays, and
  formula-like strings.
- Links are rendered safely.

## Backend acceptance criteria

The backend is ready for frontend implementation when all of the following are
true:

- A category list can be submitted through JSON without modifying a local file.
- `POST /api/runs` returns within a few seconds with a `runId`.
- Status can be read using that specific `runId`.
- A completed run exposes leads as typed JSON.
- Results remain associated with their run and are not overwritten by a later run.
- Completed runs and results remain readable after an API process restart.
- The HTTP path does not depend on writing local CSV files.
- The HTTP path receives manual categories directly and does not read an input CSV.
- Pagination, filtering, safe errors, and Prisma persistence are covered by tests.
- No secret or local filesystem path appears in any API response.

## Explicitly out of scope for the first frontend

- WebSockets or Server-Sent Events.
- Streaming leads into the table one at a time.
- Editing scraped leads.
- Sending email from the application.
- CSV category upload.
- Query-audit API, query-audit UI, or query-audit export.
- Arbitrary user-provided scraper configuration.
- Public or multi-user access.
- Automatic result expiration or cleanup.
- Browser access to OpenAI, Google Search, or Browserless APIs.
- Browser or Next.js frontend access to Neon PostgreSQL.
- Generating CSV on the backend.

## Implementation references

- Prisma ORM with Neon:
  https://docs.prisma.io/docs/orm/v6/overview/databases/neon
- Prisma PostgreSQL connector and runtime/CLI connection configuration:
  https://docs.prisma.io/docs/orm/core-concepts/supported-databases/postgresql
- Neon connection pooling:
  https://neon.com/docs/connect/connection-pooling
- Neon backup and snapshot update:
  https://neon.com/docs/changelog/2025-10-31
