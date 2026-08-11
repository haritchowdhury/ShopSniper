# Backend Readiness Plan for Frontend Handoff

## Execution status — 2026-07-31

The backend implementation in this plan is complete and the initial reviewed
migration has been applied to the configured Neon branch. The live API health,
persisted fixture status, and filtered results endpoints passed against Neon. The
guarded frontend fixture run contains one qualified, one rejected, and one failed
row.

The default offline suite and the explicit Prisma integration test pass. A real
Google/OpenAI scraper run was deliberately not started as part of implementation
verification because the completed database fixture exercises the frontend
contract without consuming external API quota.

One operational configuration item remains: the local environment currently has
only a pooled `DATABASE_URL`. Add the direct Neon connection string as
`DIRECT_URL` before future Prisma migration work. The initial additive migration
succeeded, but a pooled migration connection should not be treated as the
long-term configuration.

## Goal

Make the current Node.js scraper backend fully implement
`BACKEND_FRONTEND_JSON_HANDOFF_SPEC.md` so frontend development can begin against
a stable, tested API.

The frontend-ready backend will:

- accept manually entered shop categories as JSON;
- return an opaque `runId` immediately;
- run the scraper asynchronously without holding an HTTP request open;
- persist run state and completed lead results in Neon PostgreSQL through Prisma;
- expose status and paginated lead results through the four documented `/api`
  endpoints;
- retain completed runs without an application expiry;
- return lead fields in the existing output CSV's snake_case structure; and
- keep query-planning audits temporary and private to the worker.

This plan changes the backend only. Frontend implementation begins after the
handoff gate at the end of this document passes.

## Fixed decisions

- Frontend input is manual category entry only.
- The request body is `{ "shopTypes": [...] }`.
- CSV category upload is out of scope.
- The frontend generates output CSV from returned JSON.
- Neon PostgreSQL is the durable store.
- Prisma ORM is the backend data-access layer.
- Runs and leads have no automatic expiry.
- Query candidates and query audits are temporary and are not stored in
  PostgreSQL.
- There is no public `/api/runs/{runId}/queries` endpoint.
- There are no application user accounts in the first version.
- The application remains privately accessible.
- Only one run may be queued or running at a time in the first version.

## Implementation order

The phases below are ordered. Do not build later phases on temporary interfaces
that contradict the handshake specification.

## Phase 1: Add Prisma and establish the Neon connection

### Work

1. Add compatible, pinned versions of:

   - `prisma` as a development dependency;
   - `@prisma/client`;
   - `@prisma/adapter-neon`;
   - the Neon serverless driver required by the adapter; and
   - `dotenv` for Prisma CLI configuration.

2. Add the following backend-only files:

   ```text
   prisma/schema.prisma
   prisma.config.ts
   src/prisma-client.js
   ```

3. Configure:

   ```text
   DATABASE_URL=<pooled Neon runtime URL>
   DIRECT_URL=<direct Neon migration URL>
   ```

   The existing local `DATABASE_URL` can be used to verify initial connectivity.
   Obtain a direct Neon URL before running Prisma migrations if the existing URL
   is a pooled `-pooler` URL.

4. Add safe placeholders to `.env.example`. Never copy a real connection string
   into source control, tests, logs, or documentation.

5. Add package scripts:

   ```json
   {
     "db:generate": "prisma generate",
     "db:migrate": "prisma migrate dev",
     "db:migrate:deploy": "prisma migrate deploy",
     "db:studio": "prisma studio"
   }
   ```

6. Create one shared Prisma Client instance for the backend process. Do not create
   a new client for every HTTP request.

### Verification

- `prisma validate` succeeds.
- `prisma generate` succeeds.
- A backend-only `SELECT 1`/Prisma query reaches Neon.
- Missing or invalid database configuration produces a safe backend startup or
  health error without printing the connection string.

### Exit condition

The backend can connect to Neon through Prisma without exposing credentials.

## Phase 2: Create and migrate the durable run/result schema

### Work

1. Implement the `Run`, `Lead`, `RunState`, and `LeadStatus` models from the
   handshake specification.

2. Preserve these relationships:

   ```text
   Run 1 ─── many Lead
   Lead.runId ─── Run.id
   ```

3. Add indexes for:

   - run state and creation time;
   - `runId + status`;
   - `runId + leadScore`;
   - `runId + storeName`;
   - `runId + shopType`; and
   - `runId + googleRank`.

4. Enforce the one-active-run rule atomically in PostgreSQL. Use a migration-level
   partial unique index or an equivalent database lock so two simultaneous start
   requests cannot both create active runs. Do not rely only on an in-process
   Boolean.

5. Create and review the initial migration before applying it to the Neon branch.

6. Do not create database models for query candidates or query audits.

### Verification

- The migration applies to a dedicated development/test Neon branch.
- Prisma can create a run and related leads.
- Deleting a run would cascade to its leads, although no deletion API is exposed.
- Multiple completed runs can coexist.
- PostgreSQL rejects a second queued/running run atomically.

### Exit condition

The database can durably represent every public run-status and lead-result field.

## Phase 3: Introduce a Prisma run repository

### Files

```text
src/prisma-run-repository.js
src/api-serializer.js
src/api-errors.js
```

### Required repository operations

```text
createRun(normalizedShopTypes)
markRunning(runId)
updateProgress(runId, statusSnapshot)
saveCompletedResults(runId, leads, summary)
markFailed(runId, safeError)
getRun(runId)
getResultsPage(runId, filters)
getActiveRun()
recoverInterruptedRuns()
```

### Work

1. Generate IDs with cryptographically strong randomness:

   ```text
   run_<opaque value>
   lead_<opaque value>
   ```

   Run IDs must satisfy the regex in the handshake specification.

2. Map Prisma model properties to the public snake_case output fields in one
   serializer. Do not scatter field-name conversion across route handlers.

3. Normalize blank internal strings to `null`.

4. Keep numeric scores/ranks as numbers or `null`.

5. Keep `social_profiles` as an array.

6. Implement `saveCompletedResults` as an idempotent database transaction:

   - replace or upsert only the leads belonging to the same `runId`;
   - store all lead rows;
   - store the final summary;
   - set `resultsAvailable = true`;
   - set run state/stage to `completed`; and
   - set `completedAt`.

7. Never expose partial results. If the transaction fails,
   `resultsAvailable` remains false.

8. Persist progress snapshots at meaningful stage changes and at a bounded
   interval while counters change. Do not execute one database write for every
   individual counter increment.

9. On backend startup, call `recoverInterruptedRuns`. With the current in-process
   worker, a run left queued/running by a previous process cannot still be
   executing; mark it failed with a safe `RUN_INTERRUPTED` error. This prevents a
   permanently stuck active-run lock.

### Verification

- Runs and leads remain readable after restarting the API process.
- Saving the same completed result twice does not duplicate leads.
- A failed transaction does not expose a partial result set.
- Prisma error messages remain in backend logs only.

### Exit condition

All durable state is accessed through the repository, not global variables or
local output files.

## Phase 4: Decouple the HTTP pipeline from CSV input and output

### Affected files

```text
src/pipeline.js
src/query-planner.js
src/category-input.js
src/run-once.js
src/output.js
src/query-audit.js
```

### Work

1. Add a manual-category path that:

   - accepts the `shopTypes` array from the run record;
   - applies the existing `normalizeShopType` function;
   - rejects blanks and invalid entries;
   - deduplicates normalized categories while preserving first occurrence; and
   - passes normalized category objects directly to the query planner.

2. Refactor `planGeneratedQueries` so the HTTP path does not call
   `readCategories(config.inputCsv)`.

3. Keep `readCategories` for `npm run run:once` legacy CSV execution.

4. Stop calling `writeQueryAudit` from the HTTP path. Audits may remain in memory
   until the run ends.

5. Stop calling `writeOutput` from the HTTP path.

6. Make the HTTP pipeline return:

   ```js
   {
     leads: [],
     summary: {
       total: 0,
       qualified: 0,
       rejected: 0,
       failed: 0
     }
   }
   ```

7. Preserve `npm run run:once` by placing CSV writing in that command after the
   pipeline returns. The server and worker must not require `INPUT_CSV`,
   `OUTPUT_CSV`, or `GENERATED_QUERIES_CSV`.

8. Rename the public terminal-write stage from `writing_output` to
   `writing_results`.

9. Compute summary counts from the actual returned lead records, not from progress
   counters. This keeps summary totals accurate for search-level rejection and
   failure rows.

### Verification

- Existing discovery, deduplication, extraction, and scoring tests still pass.
- An HTTP-mode pipeline test runs without readable/writable CSV paths.
- A `run:once` regression test still produces legacy CSV output.
- Query audits are not inserted into PostgreSQL.

### Exit condition

The HTTP pipeline consumes manual categories and returns in-memory lead records
without relying on filesystem artifacts.

## Phase 5: Build the documented backend API

### Affected and new files

```text
src/server.js
src/request-json.js
src/status.js
src/api-errors.js
src/api-serializer.js
src/prisma-run-repository.js
```

### Endpoints

```text
GET  /api/health
POST /api/runs
GET  /api/runs/{runId}
GET  /api/runs/{runId}/results
```

### `GET /api/health`

- Perform a lightweight Prisma database query.
- Return `{ "status": "ok" }` with `200` when healthy.
- Return safe `503 DATABASE_UNAVAILABLE` when PostgreSQL cannot be reached.

### `POST /api/runs`

- Require JSON and enforce the 32 KiB body limit for both content-length and
  chunked requests.
- Validate and normalize `shopTypes`.
- Reject all invalid input atomically with the documented error shape.
- Create a queued run in PostgreSQL.
- Return `202`, `Location`, `runId`, URLs, and `createdAt` immediately.
- Schedule work after responding.
- Convert the database active-run constraint into
  `409 RUN_ALREADY_ACTIVE`.
- Mark the run `running` when the worker actually starts.

### `GET /api/runs/{runId}`

- Validate the run ID before querying.
- Read state, stage, timestamps, progress, summary availability, and safe error
  data from PostgreSQL.
- Return `404 RUN_NOT_FOUND` for unknown valid IDs.
- Never return Prisma errors or worker exception details.

### `GET /api/runs/{runId}/results`

- Return `409 RESULTS_NOT_READY` for queued/running runs.
- Return `409 RESULTS_UNAVAILABLE` for failed/cancelled runs without a committed
  result set.
- Implement the exact allowed parameters:

  ```text
  page
  pageSize
  status
  search
  sortBy
  sortDirection
  ```

- Reject unknown and malformed query parameters.
- Map allowed sort names to fixed Prisma fields; never pass a user-provided column
  name directly into Prisma.
- Search case-insensitively across store name, resolved domain,
  `myshopify` domain, email, and shop type.
- Query only leads belonging to the requested `runId`.
- Use the stored full-run summary and calculate filtered pagination totals.
- Apply the deterministic `lead_score`, `store_name`, `id` default order.
- Return snake_case lead items matching the output CSV fields.

### Shared HTTP behavior

- Return the standard `{ error: { code, message, details? } }` shape for every
  non-2xx JSON response.
- Set `Cache-Control: no-store`.
- Return JSON content types consistently.
- Validate and URL-encode opaque run IDs.
- Keep compatibility `/health`, `/run`, and `/status` routes only if they do not
  complicate the new contract; the frontend must not use them.
- Do not add browser CORS because the browser will call the Next.js proxy.
- Optionally enforce `BACKEND_API_TOKEN` for the private server-to-server
  boundary.

### Exit condition

All four endpoints behave exactly as documented using only PostgreSQL-backed run
state and results.

## Phase 6: Add contract and persistence tests

### Unit/API tests

Extend or replace `test/server.test.js` using injected pipeline and repository
fakes to cover:

- valid `202` creation response;
- manual category normalization and deduplication;
- `400`, `404`, `409`, `413`, `415`, `429`, `500`, and `503` shapes;
- immediate response before the pipeline completes;
- polling transitions;
- safe failed-run responses;
- run-ID rejection;
- query-parameter validation;
- status filtering;
- search;
- every allowed sort;
- deterministic pagination; and
- absence of secrets, local paths, and stack traces.

### Pipeline tests

Update `test/pipeline.test.js` and query-planning tests to cover:

- category-array input;
- no HTTP-mode CSV reads or writes;
- temporary query audits;
- `{ leads, summary }` return shape;
- correct status summary; and
- continued `run:once` CSV compatibility.

### Database integration tests

Use a dedicated Neon test branch and separate test environment variables. Never
run destructive test cleanup against the development or production branch.

Cover:

- migrations apply cleanly;
- create/read run;
- atomic one-active-run constraint;
- progress persistence;
- atomic completed-result commit;
- idempotent retry;
- process restart readability;
- run-scoped filtering and pagination;
- separate results for multiple run IDs; and
- interrupted-run recovery.

Keep the existing default `npm test` suite free of Google, OpenAI, Browserless,
and production Neon calls. Add an explicit command such as:

```text
npm run test:integration
```

### Exit condition

All unit, regression, API contract, and database integration tests pass.

## Phase 7: Produce the frontend handoff kit

Create a short frontend quick-start document containing:

- the local backend base URL;
- required Next.js server-only environment variables;
- the four routes the Next.js proxy must implement;
- copyable request and response examples;
- all public TypeScript shapes;
- polling terminal states and retry behavior;
- allowed result filters and sorts;
- CSV header order;
- a reminder that JSON fields are snake_case;
- private-access assumptions; and
- a troubleshooting table for `409`, `502`, `503`, and `504`.

Add a development seed script that inserts one completed fixture run with
qualified, rejected, and failed lead rows and prints its `runId`. This lets
frontend development begin without spending Google/OpenAI quota or waiting for a
real scraper run.

Recommended scripts:

```text
npm run seed:frontend
npm start
```

The seed script must refuse to run unless explicitly pointed at a non-production
database.

### Exit condition

A frontend developer can start the backend, obtain a fixture `runId`, poll status,
fetch results, test filters/pagination, and export CSV without understanding the
scraper internals.

## Final smoke-test sequence

Before declaring the backend ready:

1. Apply the Prisma migration to the development Neon branch.
2. Start the backend.
3. Confirm `GET /api/health` returns `200`.
4. Submit two or more manually entered categories to `POST /api/runs`.
5. Confirm the response returns `202` before pipeline completion.
6. Poll `GET /api/runs/{runId}` through queued/running to completed.
7. Confirm `resultsAvailable` changes only after the database commit.
8. Fetch qualified, rejected, and failed result pages.
9. Test search and every allowed sort.
10. Restart the API process.
11. Fetch the same run and results again.
12. Generate a CSV from all pages and compare its headers and value types with
    `src/output.js`.
13. Confirm the database contains the run and leads but no query-audit rows.
14. Confirm no API response contains a database URL, API key, stack trace, raw
    HTML, or local filesystem path.

## Frontend-ready definition of done

Frontend work can begin when every item below is true:

- Prisma schema and reviewed migration are committed.
- Neon connectivity is healthy through the backend.
- Manual categories reach the planner without an input CSV.
- `POST /api/runs` returns a durable `runId` immediately.
- Run status is persisted and pollable by that ID.
- Completed leads are committed transactionally in PostgreSQL.
- Results survive an API restart.
- Results are filterable, sortable, and paginated through the documented API.
- Returned lead fields match the output CSV structure.
- Query audits remain temporary and have no public endpoint.
- The HTTP path does not require writable CSV files.
- Contract, persistence, and regression tests pass.
- A non-production completed fixture run is available for frontend development.
- The frontend quick-start and copyable API types are complete.

Until all of these conditions pass, the handshake document should be treated as
the target contract rather than a claim that the current backend already
implements it.
