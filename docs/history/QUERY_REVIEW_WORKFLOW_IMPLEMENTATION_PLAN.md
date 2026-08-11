# Query Review Workflow — Execution Plan

## Status

Implemented on 2026-08-01. The Prisma migration has been applied to the
configured Neon database, the backend and BFF contracts are live in source, and
the authenticated run workspace now contains the durable query editor. This
document remains the implementation rationale; the authoritative frontend JSON
contract is `BACKEND_FRONTEND_JSON_HANDOFF_SPEC.md`.

The existing one-shot `run:once` CSV command remains supported. The HTTP workflow
will change from "submit categories and immediately run everything" to "submit
categories, review queries, then start scraping."

## Outcome

After authentication, a new user lands on the category/query preparation page.
The complete application flow becomes:

```text
Enter categories
      |
      v
Generate and probe proposed Shopify queries
      |
      v
Persist the proposed query set against the run ID
      |
      v
User adds, edits, removes, or restores queries
      |
      v
Backend validates and probes the confirmed revision
      |
      +---- validation problem ----> return to query review with row-level errors
      |
      v
Run store discovery, contact extraction, and lead scoring
      |
      v
Persist indefinitely downloadable results against the same run ID
```

No store resolution, storefront fetching, contact extraction, or lead scoring
starts before the query list has been confirmed and has passed the final sanity
check.

## Fixed implementation decisions

These decisions remove ambiguity from the build:

1. One `Run` is used for the entire lifecycle. Query planning does not create a
   second run or a browser-only temporary object.
2. Draft queries are stored in PostgreSQL. They cannot remain only in process
   memory because review may span server restarts, deployments, or multiple
   browser sessions.
3. A dedicated `RunQuery` model stores the current editable list. `QueryAudit`
   remains an immutable diagnostic/provenance record and is not used as the
   editable source of truth.
4. The backend generates 10 selected queries **per normalized category** using
   `GENERATED_QUERY_COUNT=10`.
5. Users may add, edit, delete, and reorder queries. At least one query must
   remain for every category included in the run.
6. The maximum is 20 queries per category and `MAX_QUERIES` for the whole run.
7. Every query remains category-scoped. The browser may choose from categories
   already attached to the run, but cannot invent or alter normalized category
   metadata.
8. Query saving performs deterministic validation immediately. Confirmation is
   asynchronous because Google probing can exceed an HTTP request timeout.
9. A final revision must pass both deterministic validation and the live Google
   probe before scraping begins. Any failed query returns the run to review; it
   is not silently discarded.
10. Unchanged generated queries may reuse their persisted probe results for 24
    hours. New, edited, stale, or previously failed queries are probed again.
11. The exact confirmed query revision is locked for the scrape. Later edits are
    rejected once validation/scraping has started.
12. Existing owner isolation remains in force. The browser never supplies
    `X-User-Id`; the trusted frontend BFF derives it from the verified login
    session and adds the backend service token.
13. The global one-running-worker database constraint remains. Runs awaiting
    user review do not occupy the worker slot and do not block other runs.
14. Lead results retain the current no-expiry application policy.

## State machine

Add `awaiting_query_confirmation` to `RunState`. Add an explicit `RunPhase` so
the queue worker does not have to infer what work to perform from presentation
text in `stage`.

```text
RunState                         RunPhase          Stage
---------                        --------          -----
queued                           query_planning    queued_query_planning
running                          query_planning    researching_category ...
awaiting_query_confirmation      query_review      awaiting_query_confirmation
queued                           scraping          queued_query_validation
running                          scraping          validating_confirmed_queries
running                          scraping          probing_confirmed_queries
running                          scraping          discovering_stores ...
completed                        finished          completed
failed                           finished          failed
cancelled                        finished          cancelled
```

Allowed transitions:

```text
queued/query_planning
  -> running/query_planning
  -> awaiting_query_confirmation/query_review

awaiting_query_confirmation/query_review
  -> awaiting_query_confirmation/query_review  (save another draft revision)
  -> queued/scraping                         (confirm current revision)

queued/scraping
  -> running/scraping
  -> awaiting_query_confirmation/query_review  (sanity check failed)
  -> completed/finished
  -> failed/finished
```

The transition from review to queued scraping must be an atomic conditional
database update. Two confirmation requests must never queue the scrape twice.

## Database changes

### Run changes

Add:

```prisma
enum RunState {
  queued
  running
  awaiting_query_confirmation
  completed
  failed
  cancelled
}

enum RunPhase {
  query_planning
  query_review
  scraping
  finished
}
```

Add these fields to `Run`:

```prisma
phase                    RunPhase
queryRevision            Int       @default(0)
confirmedQueryRevision   Int?
queryPlanReadyAt         DateTime?
queriesConfirmedAt       DateTime?
queries                  RunQuery[]
```

Backfill existing rows in the migration:

- completed, failed, or cancelled rows become `finished`;
- queued/running historical rows become `scraping`, preserving their existing
  one-shot behavior during deployment;
- new rows are created as `query_planning`.

### New RunQuery model

The exact Prisma spelling may be adjusted during implementation, but the data
contract must contain the following information:

```prisma
enum RunQuerySource {
  generated
  user_added
  user_edited
}

enum RunQueryValidationState {
  pending
  valid
  invalid
}

model RunQuery {
  id                    String                  @id
  runId                 String
  run                   Run                     @relation(fields: [runId], references: [id], onDelete: Cascade)
  categoryIndex         Int
  sequence              Int
  query                 String
  source                RunQuerySource
  validationState       RunQueryValidationState @default(pending)
  rejectionReason       String?
  queryScore             Float?
  generationReason      String?
  sourceUrls             String[]                @default([])
  categoryVocabulary     Json?
  probeSummary           Json?
  probeResults           Json?
  probeContractVersion   String?
  probedAt               DateTime?
  createdAt              DateTime                @default(now())
  updatedAt              DateTime                @updatedAt

  @@unique([runId, sequence])
  @@index([runId, categoryIndex, sequence])
  @@index([runId, validationState])
}
```

`probeResults` stores only the normalized Google result fields required by the
discovery stage: query, rank, URL, title, snippet, and rejection reason. It must
not contain provider credentials, response headers, or an unbounded raw provider
payload.

### Migration rules

1. Create a new additive migration; never modify already-applied migrations.
2. Extend the PostgreSQL enum safely before writing the new state.
3. Preserve the partial unique index that permits only one `running` row.
4. Add indexes before enabling the new frontend workflow.
5. Verify the migration against a non-production Neon branch first.
6. Verify existing completed fixtures and result downloads remain readable.

## Backend refactor

### 1. Split planning from discovery

Refactor [pipeline.js](../../src/pipeline.js) into three public operations:

```js
planQueriesForReview(config, status, { categories })
validateConfirmedQueries(config, status, { queries })
runDiscoveryFromQueryPlans(config, status, { queryPlans })
```

Responsibilities:

- `planQueriesForReview` uses the existing research, candidate validation,
  probing, repair, and diverse selection logic. It returns selected queries,
  audits, and bounded reusable probe results. It does not resolve or fetch a
  store.
- `validateConfirmedQueries` normalizes the saved revision, performs the final
  deterministic checks, reuses fresh compatible probes, and probes anything
  changed or stale.
- `runDiscoveryFromQueryPlans` begins at the current `discovering_stores` loop
  and performs all existing resolution, merging, validation, extraction, and
  scoring behavior.

Keep `runPipeline` as a compatibility wrapper that calls all three operations in
sequence. This preserves `npm run run:once` and existing direct pipeline users.

### 2. Separate reusable query validation from AI candidate validation

The current validator expects model-only metadata such as confidence, market
signal, and generation reason. A user-entered query does not have those fields.

Add a provider-neutral validator with an interface similar to:

```js
validateQueryText(query, {
  shopType,
  categoryVocabulary,
  seenQueries
})
```

It must enforce:

- exact `site:myshopify.com/products <phrase>` structure;
- normalization to lowercase and single spaces;
- no quotation marks or unsupported operators;
- a two-to-five-word concrete product phrase;
- no informational or instruction-like wording;
- category relevance;
- no exact or near duplicate within that category;
- per-category and total count limits.

The AI candidate validator will call this shared function after validating the
model-specific candidate schema.

### 3. Preserve and invalidate probe data correctly

Calculate a deterministic probe fingerprint from:

```text
normalized query
normalized category intent
query validation contract version
Google probe contract version
relevant threshold configuration
```

Probe reuse is permitted only when:

- the fingerprint matches;
- the prior probe passed;
- `probedAt` is no more than 24 hours old; and
- the normalized query text was not edited.

Otherwise mark the row `pending` and probe it on confirmation. This avoids a
second Google request for an immediately confirmed generated query without using
stale results indefinitely.

### 4. Make the worker phase-aware

Replace the current assumption that every queued run executes `runPipeline`.
After claiming a queued run:

- `query_planning`: generate the proposed list, transactionally store
  `RunQuery` rows and planning audits, transition to
  `awaiting_query_confirmation`, release the lease, then claim the next run;
- `scraping`: load the locked query revision, perform final query validation,
  and either return the run to review with row-level problems or continue into
  discovery and completion.

The lease must protect every state-changing worker transaction. Returning to
review must clear lease fields so the global running slot is released.

### 5. Repository operations

Add:

```text
saveGeneratedQueryPlan(runId, lease, plan, status)
getEditableQueries(runId, ownerId)
replaceEditableQueries(runId, ownerId, expectedRevision, queries)
confirmQueryRevision(runId, ownerId, expectedRevision)
loadConfirmedQueryPlans(runId, lease)
saveQueryValidation(runId, lease, validation)
returnRunToQueryReview(runId, lease, safeSummary)
```

Repository invariants:

- all read/write operations include `runId + ownerId` unless protected by an
  active worker lease;
- draft replacement and `queryRevision` increment happen in one transaction;
- stale revisions return a conflict instead of overwriting another browser;
- confirmation stores `confirmedQueryRevision` and queues the phase atomically;
- a worker only consumes rows from the confirmed revision;
- editing is allowed only in `awaiting_query_confirmation`;
- final lead publication remains one transaction and retains the query/audit
  provenance used for the scrape.

### 6. Recovery and idempotency

- Repeating `PUT /queries` with the same revision after a successful save returns
  the current representation or a safe revision conflict; it never duplicates
  rows.
- Repeating confirmation for the already-confirmed revision returns the current
  run state and never schedules duplicate work.
- An expired lease during query planning or scraping follows the existing safe
  failure behavior.
- A run waiting for review has no lease to expire and remains editable
  indefinitely.
- A failed final query probe returns the run to review. Provider errors are
  distinguished from semantic rejection so the UI can offer Retry.

## HTTP API changes

Every route below remains private, owner-scoped, and `Cache-Control: no-store`.

### Create the planning run

Keep:

```http
POST /api/runs
Content-Type: application/json

{
  "shopTypes": ["Eyewear Brands", "Kitchen Utensil Retailers"]
}
```

It still returns `202`, but the initial work now ends at query review rather than
continuing directly into scraping.

Add to the response:

```json
{
  "runId": "run_...",
  "state": "queued",
  "stage": "queued_query_planning",
  "statusUrl": "/api/runs/run_...",
  "queriesUrl": "/api/runs/run_.../queries",
  "resultsUrl": "/api/runs/run_.../results"
}
```

### Read the editable query set

```http
GET /api/runs/{runId}/queries
```

Response shape:

```json
{
  "runId": "run_...",
  "revision": 1,
  "editable": true,
  "categories": [
    {
      "categoryIndex": 0,
      "originalShopType": "Eyewear Brands",
      "shopType": "eyewear",
      "businessQualifier": "brand"
    }
  ],
  "queries": [
    {
      "id": "query_...",
      "categoryIndex": 0,
      "sequence": 0,
      "query": "site:myshopify.com/products photochromic sunglasses",
      "source": "generated",
      "validationState": "valid",
      "rejectionReason": null,
      "queryScore": 91,
      "generationReason": "Concrete product-title vocabulary",
      "probedAt": "2026-08-01T12:00:00.000Z"
    }
  ]
}
```

Do not expose full probe result payloads in the default response. The UI needs
the score and validation state, not duplicated Google result content.

### Save the editable list

```http
PUT /api/runs/{runId}/queries
Content-Type: application/json

{
  "revision": 1,
  "queries": [
    {
      "id": "query_existing_optional_for_new_rows",
      "categoryIndex": 0,
      "query": "site:myshopify.com/products acetate eyeglass frames"
    }
  ]
}
```

The backend ignores client attempts to set score, source, validation status,
probe data, normalized category, timestamps, or generation evidence.

Success returns `200` with revision 2 and the normalized list. Deterministic
field errors return `422 QUERY_LIST_INVALID` with errors keyed by item index.
An outdated revision returns `409 QUERY_REVISION_CONFLICT` with the current
revision number.

### Confirm and continue

```http
POST /api/runs/{runId}/start
Content-Type: application/json

{
  "revision": 2
}
```

Success returns `202` and transitions the run to:

```json
{
  "runId": "run_...",
  "state": "queued",
  "stage": "queued_query_validation",
  "revision": 2
}
```

Use `409 RUN_NOT_AWAITING_QUERY_CONFIRMATION` for an illegal lifecycle state and
`409 QUERY_REVISION_CONFLICT` for a stale browser revision.

### Run status additions

`GET /api/runs/{runId}` adds:

```json
{
  "state": "awaiting_query_confirmation",
  "stage": "awaiting_query_confirmation",
  "queryReview": {
    "revision": 2,
    "editable": true,
    "queriesUrl": "/api/runs/run_.../queries",
    "valid": false,
    "invalidQueryCount": 1
  }
}
```

`queryReview` is `null` for historical completed runs that predate the feature.
`resultsAvailable` remains false throughout planning and review.

### Standard safe errors

Add:

```text
QUERY_LIST_INVALID                    422
QUERY_REVISION_CONFLICT               409
RUN_NOT_AWAITING_QUERY_CONFIRMATION   409
QUERY_CONFIRMATION_IN_PROGRESS        409
```

Owner mismatch continues to return `404 RUN_NOT_FOUND`, preventing run-ID
enumeration across users.

## Frontend execution plan

### Route and login behavior

Make the category/query preparation screen the authenticated application's
default route. After login:

- a user without a pending run sees the category form;
- a user with a run awaiting review resumes that run's query editor;
- completed and active runs remain reachable through run history;
- anonymous run-intent claiming, if retained, redirects to the same query-review
  experience after the intent becomes an owned run.

The Next.js BFF proxies only approved bodies and query parameters. It derives
`X-User-Id` from the authenticated session and attaches `BACKEND_API_TOKEN`
server-side.

### Screen states

Implement these explicit views:

```text
category_entry
generating_queries
query_review
validating_confirmed_queries
scraping
completed
failed
```

The same page may render all states; it does not need separate browser routes.

### Query editor behavior

Group rows by category and provide:

- editable query text;
- Add query;
- Delete query;
- Restore last deleted generated query while the page remains open;
- drag or button-based reordering;
- generated/user-added/user-edited badge;
- query score and generation reason for generated rows;
- inline deterministic or probe rejection messages;
- query count per category and total count;
- Save changes;
- Continue to scraping.

The UI should insert `site:myshopify.com/products ` when a user adds a row, but
the server remains authoritative. Do not allow the UI to edit category metadata,
scores, or provider evidence.

### Save and concurrency behavior

- Maintain the server revision returned by every GET/PUT.
- Debounce optional auto-save, but never submit while another save is in flight.
- Disable Continue while there are unsaved local changes or visible validation
  errors.
- On `QUERY_REVISION_CONFLICT`, refetch and warn the user rather than silently
  overwriting changes from another tab.
- On Continue, send the exact saved revision and begin polling run status.
- If live validation returns the run to review, refetch queries and focus the
  first invalid row.

### Polling behavior

Continue using polling rather than WebSockets:

- every 3 seconds while queued, planning, validating, or scraping;
- stop polling in review, completed, failed, or cancelled states;
- refetch `/queries` when status enters review;
- refetch `/results` only when `resultsAvailable` becomes true;
- cancel timers on unmount and avoid duplicate Strict Mode timers.

## Security and resource controls

1. Keep the existing 32 KiB request limit or introduce a narrowly bounded 128
   KiB limit only for the query-list PUT route. The limit must be explicit.
2. Reject unknown request fields and duplicate query parameters.
3. Treat category and query text as untrusted data in prompts, logs, and HTML.
4. Never accept API keys, model settings, thresholds, probe results, scores, or
   arbitrary URLs from the client.
5. Limit each normalized query to 200 characters.
6. Enforce 1–20 queries per category and `MAX_QUERIES` globally on the backend.
7. Rate-limit repeated confirmation/probe attempts independently of new-run
   creation to protect Google quota.
8. Redact query text only if future categories may be sensitive; current logs may
   include normalized queries but never headers, tokens, or provider payloads.
9. Continue enforcing owner filters in PostgreSQL queries, not only in route
   handlers.

## Test plan

### Unit tests

- user-query validation accepts normalized valid queries without AI metadata;
- malformed prefixes, operators, quotes, vague phrases, category mismatch,
  duplicates, and near duplicates are rejected;
- category and total limits are enforced;
- editing changes the source to `user_edited` and invalidates the probe;
- unchanged fresh probes are reusable;
- stale or contract-mismatched probes are not reusable;
- rank/order serialization is deterministic.

### Repository tests

- generated plan and run transition commit atomically;
- awaiting-review runs release the worker lease;
- draft replacement increments revision exactly once;
- stale revision writes cannot overwrite current rows;
- confirmation locks the exact revision and is idempotent;
- owner A cannot read, edit, or confirm owner B's queries;
- only review-state runs are editable;
- final results preserve the confirmed query provenance;
- deletion of a run cascades to its `RunQuery` rows;
- existing completed rows remain readable after migration.

### Server contract tests

- `POST /runs` stops at review rather than scraping;
- `GET /queries`, `PUT /queries`, and `POST /start` success cases;
- validation error shapes and status codes;
- stale revision conflict;
- duplicate confirmation does not duplicate a queue job;
- a failed live probe returns the run to review with row-level errors;
- a valid final revision reaches discovery and completion;
- results are unavailable during planning/review;
- missing/foreign run IDs remain indistinguishable;
- backend token and trusted-user rules remain enforced.

### Pipeline tests

- planning never calls store resolution or page fetching;
- discovery from supplied query plans never calls AI generation;
- persisted probe results are accepted through the normalized contract;
- new/edited queries are probed exactly once;
- the exact confirmed list, order, and category provenance reach discovery;
- `runPipeline` and `run:once` retain one-shot compatibility.

### End-to-end verification

Use a guarded non-production Neon branch and provider quota:

1. Log in and land on the category form.
2. Submit at least two categories.
3. Observe query-planning progress.
4. Restart the backend while the run awaits review.
5. Confirm the same editable query list is still available.
6. Edit one query, add one, delete one, and reorder the list.
7. Trigger and display one deterministic validation error.
8. Correct it and save a new revision.
9. Confirm the list and observe final live validation.
10. Verify only changed/stale queries consume new Google probes.
11. Verify scraping uses the confirmed revision.
12. Restart the API and download the completed result again.
13. Confirm another user cannot access the run or query list.

## Documentation updates during implementation

Update these files as part of the code change:

- `BACKEND_FRONTEND_JSON_HANDOFF_SPEC.md`: replace the one-shot user flow and add
  the query endpoints, state, stages, request/response schemas, and errors;
- `FRONTEND_BACKEND_QUICKSTART.md`: add BFF proxy examples, TypeScript types,
  query-editor polling, revision conflict handling, and a review fixture;
- `README.md`: explain the two-stage HTTP behavior and preserve the one-shot CLI
  distinction;
- `.env.example`: document probe freshness and confirmation rate-limit settings
  if they are configurable;
- frontend stage-label mapping: add all planning/review/validation labels.

The handshake specification becomes authoritative once updated. This plan is the
execution guide, not a substitute for the final API contract.

## Recommended implementation order

1. Add the additive Prisma migration and repository data types.
2. Extract shared query-text validation.
3. Split planning and discovery while preserving `runPipeline` compatibility.
4. Persist selected query plans and bounded probe results.
5. Make queue execution phase-aware and implement lease-safe review transitions.
6. Add repository revision, edit, confirm, and reload operations.
7. Add and test the three query-review API endpoints.
8. Update serializers, status stages, safe errors, and run-list behavior.
9. Update the handshake and frontend quickstart documents.
10. Add the authenticated landing/query-editor frontend.
11. Add fixtures and complete unit, contract, integration, and end-to-end tests.
12. Deploy the migration first, then the backward-compatible backend, and then
    the frontend that depends on the new endpoints.

## Completion gate

The feature is complete only when all of the following are true:

- category submission produces a durable, editable proposed query list;
- no store scraping occurs before confirmation;
- edits survive process restarts and are owner-isolated;
- stale tabs cannot overwrite or confirm a newer revision;
- final validation either returns actionable row errors or continues
  automatically into scraping;
- the scraper consumes exactly the confirmed revision;
- the existing completed-run/results/download experience still works;
- `run:once` remains functional;
- Prisma validation, offline tests, guarded Neon integration tests, and one
  quota-bounded end-to-end run pass;
- the frontend handshake documentation matches the implemented JSON exactly.

## Scope exclusions

The following are deliberately not part of this change:

- changing the query-generation model or ranking formula;
- allowing arbitrary Google operators or non-Shopify search patterns;
- editing categories after query generation;
- live collaborative editing;
- WebSockets or server-sent events;
- automatic run/query deletion;
- changing the lead CSV/output schema; and
- replacing the existing authentication/BFF trust boundary.
