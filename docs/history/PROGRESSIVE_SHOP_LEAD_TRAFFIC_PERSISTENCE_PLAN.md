# Progressive Shop, Lead, and Traffic Persistence Plan

**Status:** COMPLETE — IMPLEMENTED AND VERIFIED  
**Execution budget:** one focused 200K context window, followed by an independent review  
**Authoritative for:** progressive store/lead persistence and cross-run shop enrichment reuse  
**Governing rules:** `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md`  
**Existing traffic contract:** `TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md`  
**Backend root:** `email_scraper/`  
**Created:** August 3, 2026

This document is self-contained. A fresh agent must be able to continue after
context compaction by reading this document, the governing rules, and the
current source. Conversation history is not an execution dependency.

Do not implement cron refresh, freshness selection, historical backfill, an
AWS queue/worker split, or a broad frontend redesign in this plan.

---

## 1. Locked product outcome

The pipeline must progressively commit useful work in this order:

```text
persist queries
  -> discover, resolve, and merge stores
  -> persist unique shops and run-store rows
  -> reuse or perform lead/contact discovery
  -> persist each run-specific lead
  -> expose base results
  -> reuse or perform traffic discovery
  -> persist traffic independently
  -> finalize the run
```

Later-stage failure must never remove or hide a successfully committed earlier
stage.

The two required checkpoints are:

1. Every merged store is durable before lead/contact discovery is dispatched.
2. Every completed lead is durable before traffic discovery is dispatched.

Cross-run reuse is required:

- a globally known shop is not resolved into a second logical shop;
- completed shop lead/contact facts are reused instead of repeating expensive
  contact discovery;
- existing traffic cache material is reused instead of repeating provider
  calls; and
- simultaneous runs cannot both perform the same expensive shop work.

### 1.1 Lean v1 decisions

- There is no data-freshness decision in v1. Completed reusable data remains
  reusable indefinitely.
- Future cron refresh is explicitly deferred. It may replace stored reusable
  facts later without changing run ownership.
- Existing provider `contractVersion` fields remain internal constants because
  current strict adapters and database keys already require them. This plan
  adds no version-selection behavior for shop lead profiles.
- Failed work is not reusable and may be retried by a later run.
- Ambiguous paid work is not automatically retried.
- No raw storefront HTML is stored in PostgreSQL.
- Provider adapters, request payloads, strict Zod response parsers, scopes,
  attribution, and feature flags remain governed by the completed traffic
  checklist. No live provider discovery is required for this refactor.
- Historical runs and leads are preserved without backfill.

### 1.2 Run-specific versus globally reusable data

`Shop` identity and contact facts are global. `Lead` remains run-specific.

The following remain run-specific because they depend on query/category
intent:

- original shop type, normalized shop type, and business qualifier;
- generated/search query, rank, result URL, and query score;
- discovery occurrences and matched categories;
- category relevance/store-fit decision; and
- final lead status and score presented for that run.

The following may be reused from a shop profile:

- verified shop identity and domains;
- store name;
- email and its source URL;
- phone and its source URL;
- contact page;
- validated social profiles;
- category-independent contact evidence; and
- category assessments already recorded for the exact normalized category
  intent.

An existing shop profile eliminates contact/page discovery network calls. The
run-specific lead is still materialized deterministically from the current
`RunStore` provenance plus the reusable profile. If the exact current category
assessment is absent, only that deterministic assessment may be added; contact
discovery must not be repeated merely to create a run row.

---

## 2. Current-state evidence

### 2.1 Observed current behavior

The current source does the following:

- `RunQuery` rows and probe results are durable before confirmation.
- `runDiscoveryFromQueryPlans()` resolves all occurrences into an in-memory
  `resolvedCandidates` array.
- `mergeDiscoveryCandidates()` creates in-memory merged stores.
- `processStore()` performs storefront validation, page discovery, page fetch,
  contact extraction, normalization, and scoring entirely in memory.
- `server.js` sends the returned in-memory leads directly into traffic
  enrichment.
- `saveCompletedResults()` is the first durable lead write. It marks the run
  completed, deletes/recreates leads, and inserts traffic rows in one final
  transaction.
- A traffic or final-publication exception therefore leaves no run leads even
  though store and contact discovery already completed.
- `TrafficEnrichmentCache` and `DataForSeoRequestLedger` commit independently,
  so provider cost/cache evidence may survive while base leads do not.

Relevant source:

```text
email_scraper/src/pipeline.js
email_scraper/src/server.js
email_scraper/src/prisma-run-repository.js
email_scraper/src/api-serializer.js
email_scraper/src/enrichment/orchestrator.js
email_scraper/prisma/schema.prisma
```

### 2.2 Reproduced failure evidence

Two production-local runs completed discovery but failed before final lead
publication:

```text
run_UGuQQg624rh08UkLtZ0rrZGv
  77 lead records in memory, 22 qualified
  traffic publication validation failed
  0 durable Lead rows

run_Dt0pl4tzqptzQWzAAWOgH-r1
  71 lead records in memory, 40 qualified
  DataForSEO NZ work remained in_flight after a later exception
  0 durable Lead rows
```

This evidence proves the current final transaction boundary is too broad.

### 2.3 Existing dirty worktree that must be preserved

At plan creation, the backend contains uncommitted traffic corrections in:

```text
email_scraper/src/api-serializer.js
email_scraper/src/enrichment/crux/adapter.js
email_scraper/src/enrichment/crux/bigquery-contract.js
email_scraper/src/enrichment/orchestrator.js
email_scraper/test/api-serializer.test.js
email_scraper/test/crux-enrichment.test.js
email_scraper/test/server.test.js
email_scraper/test/traffic-orchestration.test.js
```

These changes belong to the current worktree. Do not reset, discard, overwrite,
or silently reimplement them. Inspect the diff before starting DP1 and build
the progressive-persistence refactor on top of it.

---

## 3. Explicit exclusions

This plan does not authorize:

- freshness TTL logic or automatic refresh selection;
- cron implementation;
- rewriting or backfilling historical runs;
- deleting existing traffic cache or ledger material;
- storing raw HTML or raw provider responses;
- changing DataForSEO or CrUX request/response contracts;
- new live paid provider calls during implementation or verification;
- automatically retrying ambiguous paid requests;
- changing authentication/ownership semantics;
- AWS Lambda, SQS, Step Functions, or separate worker deployment;
- changing query-generation behavior;
- changing lead-scoring weights or qualification rules;
- broad UI redesign; or
- unrelated cleanup/refactoring.

---

## 4. Safety invariants

| ID | Invariant | Owning window | Required proof |
| --- | --- | --- | --- |
| DP-I1 | Queries already persisted remain authoritative | DP2 | Existing query lifecycle tests unchanged |
| DP-I2 | Every merged store is durable before contact discovery | DP2 | Failure injection between store commit and lead dispatch |
| DP-I3 | One logical shop has one global `Shop` row | DP1, DP2 | Concurrent upsert and identity tests |
| DP-I4 | A completed reusable shop profile makes zero contact-discovery calls | DP3 | Two-run reuse test with call counter |
| DP-I5 | Each completed run-store produces one durable run lead | DP3 | Unique constraint and idempotent replay tests |
| DP-I6 | Lead rows are durable before any traffic call | DP3, DP4 | Provider spy plus database assertion |
| DP-I7 | Traffic failure never deletes, hides, or changes base leads | DP4 | Failure after every provider/durable step |
| DP-I8 | Existing traffic material causes zero duplicate provider calls | DP4 | Cache-hit matrix and call counters |
| DP-I9 | Concurrent runs cannot duplicate the same expensive shop work | DP1, DP3, DP4 | Real PostgreSQL competing-claim tests |
| DP-I10 | Ambiguous paid work is not automatically retried | DP4 | Existing ledger tests plus overlap tests |
| DP-I11 | Lease loss prevents stale worker publication | DP1–DP5 | Competing-worker integration tests |
| DP-I12 | Earlier checkpoints survive process death and restart | DP5 | Restart at every checkpoint |
| DP-I13 | Owner isolation remains run-based and unchanged | DP1, DP5 | Cross-owner API/repository tests |
| DP-I14 | No raw HTML/provider body/secrets enter durable JSON or logs | DP1–DP5 | Strict mappers, redaction tests, secret scan |
| DP-I15 | Historical data remains readable without backfill | DP1, DP5 | Forward migration replay and legacy serialization |

---

## 5. Lean data model

DP1 must implement an additive, forward-only migration. Exact naming may follow
project conventions, but behavior and uniqueness are locked below.

### 5.1 `Shop`

One global logical shop:

```text
id                    String primary key
stableKey             String unique
myshopifyDomain       String nullable
resolvedDomain        String nullable
canonicalUrl          String nullable
identityConfidence    Int nullable
identityEvidence      Json nullable
createdAt             DateTime
updatedAt             DateTime
```

Stable-key precedence:

1. verified normalized MyShopify domain when present;
2. otherwise the exact normalized stable hostname from identity evidence;
3. otherwise the normalized resolved domain.

The key must be lower-case ASCII, must not contain a scheme/path/port, and must
not be derived from unverified Google metadata alone. Existing identity
normalizers remain authoritative. If no stable key can be proven, persist a
failed occurrence diagnostic rather than creating a weak global shop.

V1 does not add a domain-alias history table. When a later observation proves
the same stable key, nullable current domain fields may be updated with stronger
verified evidence. Conflicting stable identities must fail closed and be
diagnosed; they must not be heuristically merged.

### 5.2 `RunStore`

One shop occurrence aggregate within one run:

```text
id                    String primary key
runId                 String foreign key -> Run
shopId                String foreign key -> Shop
state                 discovered | processing | completed | failed
candidatePayload      Json
safeErrorCode         String nullable
safeErrorMessage      String nullable
createdAt             DateTime
updatedAt             DateTime
```

Required uniqueness:

```text
unique(runId, shopId)
index(runId, state)
index(shopId)
```

`candidatePayload` is an internal normalized payload, never raw HTML. Add one
strict mapper/parser owned by the backend. It contains only the fields needed
to materialize a run lead:

```text
representative query/rank/result URL
query score and generation reason
original/normalized shop type and qualifier
category intents and category vocabulary
verified final/canonical/resolved/MyShopify identities
allowed hostnames
identity confidence/evidence
discovery occurrences and duplicate count
normalized store-fit inputs/assessments
```

Do not accept arbitrary objects directly into this JSON column.

### 5.3 `ShopLeadProfile`

One reusable completed contact/lead-discovery profile per shop:

```text
shopId                 String primary key -> Shop
state                  processing | completed | failed
profilePayload         Json nullable
processingRunId        String nullable
safeErrorCode          String nullable
safeErrorMessage       String nullable
createdAt              DateTime
updatedAt              DateTime
```

`profilePayload` uses a strict internal mapper and contains no query/run owner
data and no raw documents. It may contain:

```text
store name
email and source URL
phone and source URL
contact URL
validated social profiles
contactability tier
contact evidence
category assessment map keyed by exact normalized intent
Shopify/identity evidence needed for deterministic materialization
privacy-safe page diagnostics
```

No freshness or profile-version selection is performed in v1. A completed row
is reusable. A failed row is not reusable.

### 5.4 `ShopWork`

One generic resource-level claim table prevents duplicated work:

```text
id                    String primary key
shopId                String foreign key -> Shop
workType              lead_discovery | dataforseo | crux_rest | crux_bigquery
scopeKey              String
state                 pending | processing | completed | failed | ambiguous
processingRunId       String nullable
processingLeaseToken  String nullable
safeErrorCode         String nullable
safeErrorMessage      String nullable
startedAt             DateTime nullable
completedAt           DateTime nullable
createdAt             DateTime
updatedAt             DateTime
```

Required uniqueness:

```text
unique(shopId, workType, scopeKey)
index(state, processingRunId)
```

Scope examples:

```text
lead_discovery / current
dataforseo / worldwide
dataforseo / country:NZ:2554
crux_rest / current
crux_bigquery / month:202606
```

The current run lease is the work fence. No new independent time-based data
freshness system is added. Recovery may reclaim `processing` work only after
the owning run is terminal or its worker lease is expired. `completed` work is
never automatically reclaimed. `ambiguous` paid work is never automatically
reclaimed.

### 5.5 Existing `Lead`

Add:

```text
shopId                 String nullable foreign key -> Shop
shopLeadProfileId      String nullable
```

For newly processed runs, enforce application-level and database uniqueness:

```text
unique(runId, shopId)
```

Historical leads keep nullable shop references and remain readable. Do not
backfill them.

### 5.6 Existing traffic tables

Retain:

```text
TrafficEnrichmentCache
LeadTrafficEnrichment
DataForSeoRequestLedger
```

V1 cache reuse ignores `expiresAt` when deciding whether provider material is
already available. Keep the columns unchanged for future cron work. Existing
source, identity, scope, metric-set, and contract keys remain exact.

`ShopWork` adds per-shop reservation. It does not replace the paid DataForSEO
request ledger. DataForSEO still requires a durable batch ledger transition to
`in_flight` before network dispatch.

---

## 6. Durable lifecycle and transaction boundaries

### 6.1 Query lifecycle

Keep the current query planning, editing, confirmation, validation, and probe
result persistence unchanged.

Entry condition for store discovery:

```text
Run.phase = scraping
confirmed query revision validated
active run lease held
```

### 6.2 Store discovery checkpoint

Refactor the current first half of `runDiscoveryFromQueryPlans()` into a pure
store-discovery stage:

1. Load persisted confirmed query plans.
2. Consume their persisted probe results or perform the currently authorized
   search behavior.
3. Resolve each result using the existing identity resolver.
4. Collect privacy-safe occurrence diagnostics.
5. Merge resolved candidates deterministically.
6. Normalize each global shop identity.
7. Build strict `RunStore.candidatePayload` values.
8. In one lease-fenced transaction:
   - upsert global `Shop` rows;
   - upsert `(runId, shopId)` `RunStore` rows;
   - persist occurrence diagnostics accumulated so far;
   - set run stage `stores_persisted`; and
   - persist progress counts.
9. Return only after the transaction commits.

No `processStore()`/contact discovery may start before step 8 commits.

Idempotent replay must produce the same `Shop` and `RunStore` identities and
must not erase completed rows.

### 6.3 Lead/contact discovery checkpoint

Process persisted `RunStore` rows with bounded concurrency:

1. Claim one `RunStore` under the current run lease.
2. Read its `Shop` and strict candidate payload.
3. Check `ShopLeadProfile` before any contact/page network call.
4. If a completed reusable profile satisfies the current category-intent
   materialization needs:
   - make zero Browserless/page/contact/AI normalization calls;
   - materialize the run-specific lead deterministically; and
   - persist the `Lead` plus `RunStore.completed` atomically.
5. If no reusable completed profile exists:
   - atomically claim `ShopWork(lead_discovery,current)`;
   - only the claim winner runs the existing contact-discovery behavior;
   - refetch the verified final URL as needed because raw HTML is not durable;
   - build a strict reusable profile plus the run-specific lead;
   - in one transaction save the profile, mark work completed, save the lead,
     and mark `RunStore.completed`.
6. A non-winning concurrent run re-reads completed work/profile material. It
   must not make the expensive call.
7. A deterministic per-store failure persists:
   - `RunStore.failed`;
   - a run-specific failed Lead row where current semantics require one; and
   - a privacy-safe diagnostic.
8. Continue remaining stores.

Each lead is committed as its store finishes. Do not accumulate the full lead
array solely in memory.

After every `RunStore` is terminal, a lease-fenced barrier transaction:

- calculates the lead summary from PostgreSQL;
- sets `Run.resultsAvailable = true`;
- stores `Run.leadSummary`;
- sets stage `leads_persisted`; and
- preserves the run as active only for optional traffic work.

### 6.4 Traffic checkpoint

Traffic enrichment must read qualified leads from PostgreSQL, never from an
in-memory discovery return value.

For every enabled source/scope:

1. Resolve exact identities from persisted `Shop`/`Lead` rows.
2. Read existing cache material without an expiry filter in lean v1.
3. Attach reusable cache material to the run lead.
4. For missing identities, atomically claim the matching `ShopWork` rows.
5. Batch only identities claimed by this worker.
6. Dispatch using the existing strict provider adapter and caps.
7. Persist normalized cache, per-lead traffic rows, work-state transitions, and
   source summary in bounded source-specific transactions.
8. Do not delete or rewrite base Lead rows.

DataForSEO rules remain stricter:

- create/claim its paid request ledger before network I/O;
- on confirmed success, commit normalized cache plus work completion;
- after any exception following dispatch, preserve or transition paid outcome
  to ambiguous safely;
- never repeat an ambiguous paid fingerprint automatically; and
- provider/cache/ledger failure cannot change `resultsAvailable` or delete
  leads.

CrUX REST and BigQuery are independent components. One failing component does
not remove the other.

### 6.5 Finalization

After all enabled traffic source work is terminal:

- calculate the traffic summary from durable rows/work states;
- mark traffic `completed`, `partial`, or `failed` truthfully in the existing
  summary/stage contract;
- mark the core Run `completed` because base leads are already available;
- retain safe traffic diagnostics; and
- release the run lease.

Traffic failure after `leads_persisted` must never call the existing broad
`markFailed()` path that sets `resultsAvailable = false`.

---

## 7. Repository contract

Replace the broad end-of-run dependency on `saveCompletedResults()` with
focused lease-fenced operations. Exact names may follow source conventions,
but behavior is locked:

```text
saveDiscoveredStores(runId, lease, stores, diagnostics, status, now)
listRunStoresForProcessing(runId, lease, limit, now)
claimRunStore(runId, lease, runStoreId, now)
readReusableShopLeadProfile(runId, lease, shopId, now)
claimShopWork(runId, lease, shopId, workType, scopeKey, now)
saveDiscoveredLead(runId, lease, runStoreId, profile, lead, diagnostics, now)
saveReusedLead(runId, lease, runStoreId, lead, now)
saveFailedLead(runId, lease, runStoreId, lead, diagnostic, now)
completeLeadDiscovery(runId, lease, status, now)
listPersistedQualifiedLeads(runId, lease, now)
readReusableTrafficCache(runId, lease, keys, now)
saveTrafficSourceResults(runId, lease, sourceResult, workClaims, now)
completeTrafficEnrichment(runId, lease, summary, diagnostics, status, now)
```

Requirements:

- every mutation uses the active run lease fence;
- resource claims use compare-and-swap predicates and unique keys;
- a failed claim returns a typed non-owner result, not network permission;
- profile/lead/work multi-writes that define one transition are atomic;
- methods are idempotent for the exact same durable payload;
- conflicting replay fails rather than overwriting silently;
- owner IDs never come from worker/provider payloads;
- global cache/profile reads expose no other user's run identity; and
- no method deletes base leads as part of traffic publication.

Retain `saveCompletedResults()` only for explicit legacy/seed compatibility if
tests or tooling still need it. Production worker execution must stop calling
it once the progressive path is active.

---

## 8. Pipeline and worker refactor

### 8.1 Split functions

Refactor without changing provider or scoring algorithms:

```text
discoverStoresFromQueryPlans()
discoverLeadForRunStore()
materializeLeadFromProfile()
runTrafficForPersistedLeads()
```

Avoid a new generic framework. Keep the existing dependency-injection seams so
tests can count network calls and inject failures.

### 8.2 Stage names

Use explicit durable stage names:

```text
discovering_stores
stores_persisted
discovering_leads
leads_persisted
enriching_traffic
completed
```

Per-store/per-source truth lives in `RunStore`/`ShopWork`, not only in the run
stage string.

### 8.3 Progressive progress

Persist progress after bounded groups or terminal store transitions:

```text
storesDiscovered
storesPersisted
storesProcessed
storesQualified
storesRejected
storeProcessingFailures
trafficTargetsTotal
trafficTargetsProcessed
```

Do not update PostgreSQL on every small in-memory field mutation. Lead/profile
completion is already a natural durable write boundary.

---

## 9. Concurrency and recovery

### 9.1 Same shop in simultaneous runs

Required behavior:

```text
Run A and Run B discover the same stableKey
  -> one Shop row
  -> two RunStore rows
  -> one lead_discovery ShopWork winner
  -> one ShopLeadProfile
  -> two run-specific Lead rows
```

Tests must start claims concurrently against real PostgreSQL. Sequential mocks
are insufficient proof.

### 9.2 Traffic overlap

For identical shop/source/scope work:

```text
fresh/available cache exists -> zero calls
no cache, one claim winner    -> one call
processing by active run      -> no second call
completed work                -> reuse
failed work                   -> later claim may retry
ambiguous paid work           -> no automatic retry
```

DataForSEO may batch many won per-shop reservations into one exact provider
request. The request ledger and per-shop work rows must agree transactionally
on success.

### 9.3 Process restart

Recovery reads durable stage/resource state:

- `stores_persisted`: resume unprocessed `RunStore` rows;
- `discovering_leads`: keep completed leads and resume only pending/failed
  eligible stores;
- `leads_persisted`: skip all store/contact discovery and enter traffic;
- `enriching_traffic`: reuse completed cache/work and process only safe missing
  work;
- expired processing claim owned by a dead/expired run lease: reclaim safely;
- ambiguous paid claim: preserve and surface, never automatically dispatch.

Recovery must not delete durable rows to recreate a stage.

---

## 10. API and frontend compatibility

The minimal backend/API change is required; broad frontend work is not.

- Results authorization remains `Run.ownerId` based.
- Results endpoints return leads whenever `resultsAvailable = true`, even if
  the run is still enriching traffic.
- Run serialization exposes truthful current stage and existing progress.
- A lead without traffic material remains valid and displays normally.
- Traffic source rows appear as they are durably attached.
- Traffic attribution appears only for material actually returned, preserving
  the existing traffic contract.
- If the frontend currently blocks result pages solely because `Run.state` is
  not `completed`, make the smallest change to use `resultsAvailable` while
  showing the traffic-pending stage.

No new customer-facing cache freshness or refresh controls are included.

---

## 11. Migration and historical-data policy

- Create one new timestamped forward migration after
  `20260802120000_dataforseo_paid_safety`.
- Add tables/columns/indexes only; do not rewrite historical leads/runs.
- New `Lead.shopId` and profile reference fields are nullable for compatibility.
- Foreign keys use deliberate deletion behavior. Deleting a run may cascade its
  `RunStore`, run-specific leads, and per-run traffic rows; it must not delete a
  global `Shop`, reusable profile, or global traffic cache.
- Global shop deletion is outside this plan.
- Migration replay must work from every existing migration state used by the
  current integration suite.
- Prisma generation and validation are mandatory.
- Real migration tests use an isolated test database/schema, never the user's
  production schema.

---

## 12. Sequential execution windows

All windows may be completed sequentially within one 200K context session.
Do not parallelize source edits because they share schema, repository, worker,
and lifecycle invariants. Each window stops at its gate before the next begins.

### Window DP1 — Schema, strict internal mappers, and claims

**Status:** complete  
**Objective:** Establish additive durable identities and resource-level claim
primitives without changing worker execution.

#### Dependencies and required reading

- Read this entire plan and governing checklist rules.
- Inspect the current dirty diff and preserve it.
- Read current Prisma schema/migrations, repository lease helpers,
  `api-serializer.js`, identity normalizers, and relevant integration tests.

#### Ownership

```text
email_scraper/prisma/schema.prisma
email_scraper/prisma/migrations/<new progressive migration>/migration.sql
email_scraper/src/prisma-run-repository.js
email_scraper/src/api-serializer.js
email_scraper/src/<small internal shop-profile contract module if needed>
email_scraper/test/prisma-run-repository.test.js
email_scraper/test/api-serializer.test.js
email_scraper/test/<progressive migration integration>.test.js
```

Do not edit pipeline/server/provider/frontend behavior in DP1.

#### Ordered tasks

- [x] Add `Shop`, `RunStore`, `ShopLeadProfile`, `ShopWork`, enums, relations,
  nullable Lead references, uniqueness, and indexes.
- [x] Add strict stable-shop identity mapping.
- [x] Add strict candidate/profile persistence mappers that reject raw HTML,
  unknown secret-shaped envelopes, impossible states, and run-owned fields in
  global payloads.
- [x] Add lease-fenced shop upsert and resource claim methods.
- [x] Add claim-result types: won, completed/reusable, processing/not-owner,
  failed/retryable, and ambiguous/not-retryable.
- [x] Add recovery selection for claims whose owning run is terminal or lease
  expired.
- [x] Preserve existing lead/traffic persistence behavior unchanged.

#### Verification

- Migration is forward-only and preserves historical rows.
- Concurrent identical shop upserts create one Shop.
- Concurrent identical work claims produce one winner.
- Active-owner processing cannot be stolen.
- Terminal/expired owner work can be reclaimed except ambiguous paid work.
- Cross-run global reads expose no owner-specific metadata.
- Raw HTML/provider bodies/secrets are rejected.

#### Commands

```bash
npm run db:generate
npm run db:validate
node --test test/api-serializer.test.js test/prisma-run-repository.test.js
npm run test:integration
npm run check:secrets
git diff --check
```

#### DP1 acceptance and stop

Acceptance requires source plus isolated PostgreSQL evidence for uniqueness,
claim fencing, migration replay, and preservation. Record changed files,
commands, results, skipped checks, and residual risks. Do not start DP2 until
DP1 is proven.

### Window DP2 — Durable store discovery checkpoint

**Status:** complete  
**Depends on:** DP1  
**Objective:** Persist every merged store before any lead/contact discovery.

#### Ownership

```text
email_scraper/src/pipeline.js
email_scraper/src/server.js
email_scraper/src/status.js
email_scraper/src/prisma-run-repository.js       # DP2 methods only
email_scraper/test/pipeline.test.js
email_scraper/test/server.test.js
email_scraper/test/query-review-server.test.js
```

#### Ordered tasks

- [x] Extract `discoverStoresFromQueryPlans()` from the current combined flow.
- [x] Preserve query results, resolution diagnostics, merging order, identity
  rules, category intents, and progress semantics.
- [x] Build strict normalized store payloads without raw HTML.
- [x] Add one lease-fenced store checkpoint transaction.
- [x] Change the worker to commit `stores_persisted` before dispatching any
  store processing.
- [x] Make exact replay idempotent and conflicting replay fail closed.
- [x] Keep legacy CSV `run:once` behavior explicitly separated and unchanged.

#### Verification

- A spy proves zero page/contact/AI calls before store checkpoint commit.
- Failure immediately after store commit leaves all Shop/RunStore rows.
- Restart resumes from persisted stores without repeating Google search or
  domain resolution.
- Duplicate results and concurrent runs share one Shop but keep independent
  RunStore provenance.
- Query editing/confirmation tests remain unchanged.

#### Commands and acceptance

```bash
node --test test/pipeline.test.js test/server.test.js test/query-review-server.test.js
node --test test/prisma-run-repository.test.js
npm test
npm run check:secrets
git diff --check
```

Acceptance requires a durable failure-injection test at the exact boundary.
Stop before DP3.

### Window DP3 — Reusable profile and progressive lead persistence

**Status:** complete  
**Depends on:** DP1–DP2  
**Objective:** Reuse completed shop profiles and persist each run lead before
traffic is eligible to start.

#### Ownership

```text
email_scraper/src/pipeline.js
email_scraper/src/server.js
email_scraper/src/status.js
email_scraper/src/prisma-run-repository.js       # DP3 methods only
email_scraper/src/api-serializer.js              # lead/profile mapping only
email_scraper/test/pipeline.test.js
email_scraper/test/server.test.js
email_scraper/test/prisma-run-repository.test.js
email_scraper/test/<progressive integration>.test.js
```

Do not edit traffic provider adapters or traffic public serialization.

#### Ordered tasks

- [x] Extract `discoverLeadForRunStore()` and deterministic
  `materializeLeadFromProfile()`.
- [x] Read profile before any page/contact/AI network seam.
- [x] Implement exact reusable-profile acceptance and run-specific overlay.
- [x] Claim missing lead discovery at shop resource level.
- [x] Make only the winner perform contact discovery.
- [x] Atomically save profile/work/lead/RunStore transition.
- [x] Persist failed store records and diagnostics without stopping other
  stores.
- [x] Commit each lead progressively under bounded concurrency.
- [x] Add the lead-stage barrier that calculates summary from PostgreSQL and
  sets `resultsAvailable = true` plus `leads_persisted`.
- [x] Prohibit traffic dispatch before that barrier commits.

#### Verification

- First run performs contact discovery and persists profile/lead.
- Second run for the same shop makes zero page, Browserless, contact, and AI
  calls and creates its own run Lead.
- Two concurrent runs produce one contact-discovery call and two leads.
- Process death after N leads preserves those N leads and resumes only the
  remainder.
- A failed store does not roll back completed stores.
- Lead scoring/qualification fixtures remain unchanged for non-reuse paths.
- Base result API is authorized and available after the barrier.

#### Commands and acceptance

```bash
node --test test/pipeline.test.js test/server.test.js
node --test test/prisma-run-repository.test.js test/api-serializer.test.js
npm run test:integration
npm test
npm run check:secrets
git diff --check
```

Acceptance requires deterministic zero-call reuse proof plus real PostgreSQL
concurrency/restart proof. Stop before DP4.

### Window DP4 — Traffic from persisted leads and independent publication

**Status:** complete  
**Depends on:** DP1–DP3  
**Objective:** Reuse traffic by shop/source/scope, call only won missing work,
and make all traffic failure non-destructive to base results.

#### Ownership

```text
email_scraper/src/enrichment/orchestrator.js
email_scraper/src/server.js
email_scraper/src/prisma-run-repository.js       # DP4 methods only
email_scraper/src/api-serializer.js              # traffic persistence only
email_scraper/src/status.js
email_scraper/test/traffic-orchestration.test.js
email_scraper/test/server.test.js
email_scraper/test/prisma-run-repository.test.js
email_scraper/test/te3-traffic-enrichment.integration.test.js
```

Provider request/response contracts are read-only in DP4 unless a current
failing strict fixture proves a separately scoped parser defect. Do not make
live provider calls.

#### Ordered tasks

- [x] Load qualified leads/shops from PostgreSQL.
- [x] Add non-expiring v1 cache reads while retaining existing cache columns.
- [x] Attach reusable cache material first.
- [x] Reserve per-shop source/scope work atomically.
- [x] Batch only reservations won by the current worker.
- [x] Preserve DataForSEO ledger-before-network safety and cost caps.
- [x] Persist each source result without deleting base leads.
- [x] Persist safe partial/unavailable/ambiguous states truthfully.
- [x] Make every traffic/provider/persistence exception retain
  `resultsAvailable = true` and existing Lead rows.
- [x] Complete the run with completed/partial/failed traffic summary rather
  than failing the base run.
- [x] Remove production dependence on broad final `saveCompletedResults()`.

#### Verification

- All-cache run makes zero provider/token calls.
- Two overlapping runs make one provider call per missing shop/source/scope.
- DataForSEO batching contains only won targets.
- Failure before dispatch, during response, after paid success, during cache
  commit, during per-lead attachment, and during summary commit preserves all
  base leads.
- Ambiguous paid work is not retried.
- One source failure preserves other source material and attribution.
- Existing exact provider parser tests remain unchanged and pass.

#### Commands and acceptance

```bash
node --test test/traffic-orchestration.test.js test/server.test.js
node --test test/dataforseo-enrichment.test.js test/crux-enrichment.test.js
node --test test/prisma-run-repository.test.js test/api-serializer.test.js
npm run test:integration
npm test
npm run check:secrets
git diff --check
```

Acceptance requires failure injection after every durable traffic boundary and
proof that lead counts/content remain identical. Stop before DP5.

### Window DP5 — Recovery, API truth, compatibility, and full verification

**Status:** complete  
**Depends on:** DP1–DP4  
**Objective:** Close restart/API/legacy gaps and prove the complete lifecycle.

#### Ownership

```text
email_scraper/src/server.js
email_scraper/src/prisma-run-repository.js       # recovery/read methods only
email_scraper/src/api-serializer.js
email_scraper/src/status.js
email_scraper/src/seed-frontend.js               # compatibility only
email_scraper/test/server.test.js
email_scraper/test/query-review-server.test.js
email_scraper/test/run-once.test.js
email_scraper/test/*integration.test.js
frontend/                                        # minimal resultsAvailable/stage change only if required
```

#### Ordered tasks

- [x] Resume correctly from every durable stage.
- [x] Reclaim only work owned by terminal/expired runs.
- [x] Preserve ambiguous paid work.
- [x] Make result APIs rely on owner plus `resultsAvailable`, not only terminal
  completion.
- [x] Preserve historical/legacy results with nullable Shop references.
- [x] Keep `run:once` CSV behavior unchanged.
- [x] Make the smallest frontend status change needed to show durable leads
  while traffic is pending.
- [x] Update developer documentation only where commands/state behavior changed.
- [x] Run full deterministic and isolated-database verification.

#### End-to-end adversarial matrix

- crash before store commit;
- crash after store commit and before lead claim;
- crash during one of many lead profiles;
- restart after some leads complete;
- crash after lead barrier and before traffic;
- provider failure before/after dispatch;
- database failure after paid success;
- process death during traffic cache write;
- concurrent same-shop runs;
- duplicate/reverse-order completion attempts;
- lease loss at each publication boundary;
- cross-owner read attempts;
- historical run read;
- disabled-provider zero-call behavior; and
- secret/raw-payload rejection.

#### Commands and acceptance

```bash
npm run db:generate
npm run db:validate
npm test
npm run test:integration
npm run check:secrets
git diff --check
```

If the frontend is touched:

```bash
npm test
npm run build
```

Acceptance requires complete source tracing plus executed evidence for every
checkpoint, concurrency boundary, restart branch, and owner/API claim. Record
unavailable live checks as gaps. Do not substitute live production data for an
isolated test database.

### Window DP6 — Independent parent reliability review

**Status:** complete  
**Depends on:** DP1–DP5  
**Objective:** Independently verify the implemented lifecycle and open
append-only corrective windows for concrete gaps.

The reviewer must:

- inspect the complete diff and all migrations;
- trace query -> store -> profile -> lead -> traffic -> completion;
- verify every database boundary against the locked invariants;
- confirm current dirty traffic fixes were preserved;
- search for any production call to broad destructive final publication;
- search for check-then-act work without compare-and-swap fencing;
- inspect tests for mocks that bypass repository claims;
- rerun focused and full suites;
- run migration/concurrency tests against an isolated PostgreSQL schema;
- confirm no freshness/cron/backfill scope leaked in; and
- record every new finding with severity, reproduction, root cause, and owning
  corrective window.

DP6 makes no silent fixes. Corrective windows use IDs `DP-R1`, `DP-R2`, and so
on and are appended to this document.

---

## 13. Planning readiness gate

Before DP1 edits begin, the executing agent must answer yes with source
evidence:

- [x] This document and governing rules were read completely.
- [x] Current dirty changes were inspected and preserved.
- [x] The lean exclusions are understood: no freshness, cron, backfill, raw
  HTML, provider contract changes, or live calls.
- [x] Stable shop identity is derived only from verified current identity
  evidence.
- [x] Candidate/profile JSON has one strict internal mapper each.
- [x] Every durable step, idempotency key, claim, fence, failure, recovery, and
  terminal state is assigned.
- [x] Profile reuse makes zero expensive discovery calls.
- [x] Traffic reads persisted leads and never owns base-lead deletion.
- [x] Paid ambiguity remains non-retryable.
- [x] Historical rows remain valid without backfill.
- [x] An isolated test database/schema is available for destructive migration
  and concurrency proof, or its absence is recorded as a verification blocker.

If any answer is no, resolve it before implementation rather than guessing.

---

## 14. Definition of done

This plan is complete only when:

- DP1–DP5 are implemented with evidence;
- DP6 independently finds no unresolved invariant violation;
- migrations preserve all existing data;
- confirmed queries survive unchanged;
- stores are durable before lead discovery;
- leads are durable and visible before traffic;
- completed shop profiles are reused with zero contact-discovery calls;
- traffic cache hits produce zero duplicate provider calls;
- concurrent claims have one real PostgreSQL winner;
- traffic failure cannot delete/hide/change base leads;
- restart resumes only unfinished work;
- ambiguous paid requests are not automatically retried;
- owner isolation and historical compatibility hold;
- no raw HTML/provider response/secrets are persisted or logged;
- full backend tests pass;
- isolated migration/concurrency tests pass; and
- any frontend compatibility change builds and passes its tests.

---

## 15. Post-compaction continuation instructions

When the user asks to execute after compaction:

1. Read this file completely.
2. Read `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md` completely.
3. Inspect `git status`, the current dirty diff, schema, latest migrations, and
   current test baseline.
4. Do not restart or stop user servers unless explicitly authorized.
5. Do not make live provider calls.
6. Execute DP1 first and prove its acceptance before DP2.
7. Continue sequentially through DP5 only while each dependency is proven.
8. Perform DP6 independently after implementation.
9. Update this document's window statuses and append evidence; do not rewrite
   historical window IDs.
10. If a new contradiction changes shop identity, reuse semantics, paid-call
    safety, data preservation, or authorization, stop and return the decision
    to the user.

---

## 16. Execution evidence and corrective windows

### DP-R1 — Strict cross-record identity and privacy closure

**Status:** complete  
**Finding:** DP6 source tracing found that individually strict candidate and
profile payloads were not yet cross-checked against their referenced `Shop`,
and the reusable profile retained `additionalInformation`, which can contain
run-specific duplicate notes. The safe-JSON detector also needed to reject HTML
fragments, not only complete HTML documents.  
**Severity:** high for identity integrity; medium for privacy/provenance.  
**Violated invariants:** DP-I3, DP-I14.  
**Bounded correction:** require candidate/profile/lead stable identity to equal
the durable shop stable key at each repository transaction; remove run-specific
additional information from the global profile; reconstruct only privacy-safe
page diagnostics plus current-run duplicate notes; reject common HTML fragment
tags recursively. Add negative regression tests. No schema change is required.

### DP-R2 — Remove obsolete global worker serialization

**Status:** complete  
**Finding:** the historical partial unique index `Run_one_running_idx` permits
only one running run in the entire database, so DP-I9's real simultaneous-run
claim proof was structurally impossible even though `ShopWork` was implemented.
The single-process worker remains sequential independently of this index.  
**Severity:** high for the locked concurrency invariant.  
**Violated invariant:** DP-I9.  
**Bounded correction:** drop only the obsolete partial index in the new
forward migration, retain all run lease/CAS fences, and prove with two active
runs against isolated PostgreSQL that one resource claim wins. No rows are
rewritten, no worker-pool/AWS work is introduced, and owner isolation is
unchanged.

### DP-R3 — Preserve restart progress and avoid duplicate traffic diagnostics

**Status:** complete  
**Finding:** DP6 restart tracing found that a recovered run rebuilt its tracker
from zero instead of its durable `Run.progress`, so successful completion could
replace correct checkpoint counts with zeros. Successful progressive traffic
also republished source diagnostics at finalization after they had already been
committed by the source callback.  
**Severity:** medium for truthful API/UI state.  
**Violated invariants:** DP-I12 and API truthfulness.  
**Bounded correction:** seed the tracker from durable progress on resume, pass
that progress through the queue handoff, and make successful finalization avoid
duplicating already source-persisted diagnostics. Add deterministic worker
assertions.

### DP-R4 — Checkpoint acknowledgement ambiguity

**Status:** complete  
**Finding:** DP6 failure-boundary tracing found that a database commit followed
by a lost acknowledgement could enter the per-store failure handler, and a
lost lead-barrier acknowledgement could reach the broad pre-results failure
path. The durable rows survived, but their run could be misclassified.  
**Severity:** high for DP-I5, DP-I7, and DP-I12.  
**Bounded correction:** make completed run-store lead publication an exact
idempotent replay, retry store/lead/barrier checkpoint acknowledgements once,
and make the failed-lead fallback preserve an already-completed run-store.
Provider calls are never retried by this mechanism.

### DP-R5 — Isolated-schema migration test qualification

**Status:** complete  
**Finding:** DP6 execution against the direct Neon test endpoint found that
several pre-existing migration integration fixtures used unqualified raw SQL
for historical `Run`/`Lead`/ledger rows. Migrations were correctly deployed to
the generated isolated schema, but those raw statements could resolve against
`public`, producing false missing-column failures before the application code
was exercised.  
**Severity:** medium for verification reliability; no production runtime
impact.  
**Affected evidence:** DP-I15 migration replay and the existing TE-3/TE-R2,
G-R4, and G-R6 migration checks.  
**Bounded correction:** schema-qualify only raw fixture table references and
raw count queries with the already generated safe test-schema identifier.
Keep Prisma model operations, migrations, provider mocks, and production code
unchanged. Rerun each database integration file in isolation against the direct
test endpoint.

### DP-R6 — Attach concurrent traffic winner material

**Status:** complete  
**Finding:** DP6 source tracing found that a run losing a per-shop traffic
claim correctly avoided a duplicate provider call, but immediately published
`unavailable`/`ambiguous` instead of waiting for the active winner and attaching
the winner's durable cache row. This protected cost while unnecessarily
degrading the concurrent run's result.  
**Severity:** high for cross-run reuse quality; paid-call safety already held.  
**Affected invariants:** DP-I8 and the DP4 overlapping-run acceptance case.  
**Bounded correction:** for the `processing` claim outcome only, perform a
bounded lease-aware wait/re-claim loop; when it becomes `completed`, reread the
exact source/scope cache and attach it. If work becomes reclaimable, only the
new compare-and-swap winner may call the provider. Preserve `ambiguous` as
non-retryable and publish a truthful unavailable state on bounded timeout. Add
deterministic tests proving one provider call and reusable material for both
runs.

### Completion evidence — August 3, 2026

**Implemented scope:** DP1–DP5 and corrective windows DP-R1–DP-R6 are complete.
DP6 traced the complete query -> store -> profile -> run lead -> traffic ->
completion path after the corrections. Existing unrelated dirty changes and
the previously implemented CrUX contract fixes were preserved.

**Durable behavior proven:**

- stores commit before contact discovery;
- each run lead commits before traffic dispatch;
- completed global lead profiles materialize run-owned leads without repeating
  contact/page/AI discovery;
- one compare-and-swap winner performs each same-shop lead or traffic work item;
- a concurrent traffic loser attaches the winner's exact durable cache result;
- paid ambiguity remains non-retryable;
- source traffic commits independently and later failure leaves base leads and
  `resultsAvailable` intact;
- recovery resumes progressive stages and preserves durable progress; and
- raw HTML, secret-shaped payloads, cross-shop identity mismatches, and
  run-owned global-profile fields fail closed.

**Executed verification:**

```text
npm run db:generate                         PASS
npm run db:validate                         PASS
npm run check:secrets                       PASS
git diff --check                            PASS
npm test (backend, socket-enabled)          236 tests; 230 pass; 0 fail; 6 expected DB skips
isolated direct-PostgreSQL integration      5 files; 6 tests; 6 pass; 0 fail
frontend npm test                           5 pass; 0 fail
frontend npm run build                      PASS (compile and TypeScript)
```

The direct PostgreSQL matrix covered progressive checkpoint deduplication,
resource-claim concurrency, repository atomicity, G-R4 historical migration,
G-R6 worker leases, TE-3 traffic/ledger behavior, and TE-R2 ledger preservation.
It used generated isolated schemas and mocked provider seams.

**Operational boundary:** no live Google, Browserless, OpenAI, DataForSEO, CrUX,
or BigQuery request was made; no user server was stopped or restarted; and the
new migration was not deployed to the user's configured application database.
Deployment therefore requires the normal migration command before starting the
updated server.

**Residual scope:** freshness selection, cron refresh, historical backfill,
AWS queue/worker decomposition, and broader frontend redesign remain excluded
exactly as planned. The Next production build logs Neon Auth dynamic-rendering
notices for cookie-using routes, but completes successfully and marks those
routes dynamic; this is not a build or persistence blocker.
