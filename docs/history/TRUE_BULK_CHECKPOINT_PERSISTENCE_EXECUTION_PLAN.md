# True Bulk Checkpoint Persistence Execution Plan

**Status:** COMPLETE — IMPLEMENTED AND INDEPENDENTLY VERIFIED  
**Execution budget:** one focused 200K context window plus parent review  
**Created:** August 3, 2026  
**Backend root:** `email_scraper/`  
**Governing rules:** `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md`  
**Authoritative for:** converting store, run-lead, traffic-claim, cache, and
run-traffic persistence from per-row SQL loops to true bounded database batches

This document is self-contained. After compaction, read this entire document,
`PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md`, and the current source before editing.
Conversation history is not an execution dependency.

The existing
`PROGRESSIVE_SHOP_LEAD_TRAFFIC_PERSISTENCE_PLAN.md` remains authoritative for
identity, ownership, reuse, paid-call safety, API behavior, and durable stage
ordering. This plan supersedes only its **run-lead persistence granularity**:
run-specific `Lead` rows may be committed together at the lead barrier rather
than one at a time. Traffic must still never begin until that barrier commits.

---

## 1. Locked outcome

Replace logically grouped but internally sequential database writes with real
set-based batches while keeping lead/contact discovery sequential.

```text
query discovery
  -> normalize and merge stores
  -> one true bulk store checkpoint
  -> sequential lead/contact discovery
       -> immediately preserve reusable global profile/work outcome
       -> collect run-specific lead outcome in memory
  -> one true bulk run-lead checkpoint
  -> resultsAvailable = true
  -> for each traffic source/scope in existing order
       -> one true bulk work claim
       -> provider receives only won identities
       -> one true bulk cache/work success transaction
  -> one true bulk run-traffic publication per source
  -> finalize run
```

“True bulk” means the number of database statements is bounded by the durable
stage or provider scope, not by the number of stores. An implementation does
not qualify as bulk if it uses an awaited Prisma/database call inside a loop,
or wraps per-row calls in `Promise.all`.

### 1.1 User-approved tradeoff

- Contact/page/Browserless/AI discovery remains strictly sequential.
- Run-specific leads are collected and bulk committed before traffic.
- A traffic failure cannot delete or hide the committed leads.
- Reusable global `ShopLeadProfile` and lead-discovery `ShopWork` outcomes stay
  immediately durable per processed shop. Therefore, a crash before the run
  lead batch may require reconstructing run leads, but must not repeat already
  completed expensive contact discovery.
- Traffic geographic scopes remain sequential. Actual cost from an earlier
  DataForSEO scope must still be able to stop later scopes.
- Each traffic scope/source commits independently; do not wait for all ten
  DataForSEO scopes before saving cache material.

### 1.2 Explicit exclusions

- Do not parallelize lead/contact discovery.
- Do not change `STORE_CONCURRENCY` behavior or introduce `Promise.all` around
  store processing.
- Do not change Google, Browserless, OpenAI, DataForSEO, CrUX REST, or BigQuery
  request/response contracts or strict Zod parsers.
- Do not change query generation, store identity, contact extraction, scoring,
  qualification, API response shapes, frontend behavior, authentication, CSV
  behavior, traffic scopes, provider costs, freshness policy, cron behavior,
  or AWS deployment architecture.
- Do not add a migration unless source discovery proves a schema change is
  unavoidable. None is currently expected.
- Do not increase Prisma's transaction timeout as a substitute for batching.
- Do not make live provider calls during implementation or verification.
- Do not deploy migrations or restart/stop a user server without a separate
  explicit request.

---

## 2. Source of truth and current evidence

### 2.1 Authoritative documents

1. This document: batching contract and execution checklist.
2. `PROGRESSIVE_SHOP_LEAD_TRAFFIC_PERSISTENCE_PLAN.md`: all unaffected durable,
   identity, lease, recovery, and API invariants.
3. `TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md`: provider contracts and
   paid-request safety.
4. `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md`: planning and review rules.
5. Versioned provider fixtures under
   `email_scraper/test/fixtures/providers/`: external payload evidence.

There is no backend `AGENTS.md`. `frontend/AGENTS.md` is not applicable because
frontend edits are excluded.

### 2.2 Observed current behavior

- `PrismaRunRepository.saveDiscoveredStores()` uses one transaction but loops
  over every store, performing individual Shop reads/creates/updates and
  RunStore reads/creates.
- `processPersistedRunStores()` processes stores sequentially and immediately
  invokes per-store lead persistence.
- `markDataForSeoRequestSucceeded()` loops over every traffic cache row and
  every `ShopWork` completion inside one interactive transaction.
- `saveCruxTrafficCache()` loops over every cache row inside one transaction.
- `saveTrafficSourceResults()` loops over every run-specific traffic row.
- `finishShopWorkClaims()` updates one claim at a time.
- DataForSEO and CrUX cache reads are already logically batched.
- DataForSEO work acquisition is performed one identity transaction at a time.
- The installed Prisma client defaults interactive transactions to a 2,000 ms
  acquisition wait and 5,000 ms execution timeout.
- A read-only 12-query probe against the configured database measured
  102.3–204.2 ms, median 108 ms, average 135.4 ms per simple round trip.
- The progressive migration
  `20260803120000_progressive_shop_persistence` was not installed on the
  configured application database at discovery time. Recheck; do not assume.

### 2.3 Historical failure evidence

Observed for `run_Dt0pl4tzqptzQWzAAWOgH-r1`:

```text
71 run leads existed only in memory
40 were qualified
Worldwide, US, GB, CA, and AU ledgers succeeded
NZ was claimed and remained in_flight
the run became failed about seven seconds after the NZ claim
recovery later marked NZ ambiguous
the old generic failure record did not preserve the originating exception
```

The exact originating exception is **unknown**. A default Prisma interactive
transaction timeout during a large sequential cache commit is the leading
inference because it reproduces the durable state shape, but it must not be
documented or tested as a confirmed historical cause.

### 2.4 Dirty worktree preservation

The backend and frontend contain uncommitted progressive-persistence, traffic,
CrUX, and stage-display changes. They belong to the user and must be preserved.
Inspect the diff before every window. Do not reset, rewrite, or silently replace
unrelated work.

---

## 3. Exact batching contract

### 3.1 Implementation mechanism

Use set-based database operations inside lease-fenced transactions:

- Prisma `createMany`, `deleteMany`, `updateMany`, and bulk reads where their
  semantics are exact;
- parameterized PostgreSQL `INSERT ... SELECT ... ON CONFLICT ...` or a
  parameterized JSON/recordset CTE where heterogeneous upsert values require
  genuine set-based SQL;
- static table/column names only;
- all dynamic values bound as parameters—never interpolate payload values,
  domains, IDs, JSON, or error text into SQL; and
- affected-row and returned-key reconciliation before the transaction commits.

`Promise.all` is prohibited for database batching. It neither reduces SQL
statement count nor makes one transactional connection parallel, and it can
increase pool pressure and timeout risk.

All input arrays must be fully parsed and normalized before opening a
transaction. No network, Zod parsing of raw external payloads, logging, waiting,
or backoff occurs inside a transaction.

### 3.2 Bounded input

- Store and run-lead checkpoints: reject more than 500 rows.
- Traffic batches: obey the existing provider target limit and run snapshot;
  the product path is expected to contain at most 100 stores per category.
- Reject duplicate stable shop keys, `(runId, shopId)`, `(leadId, source)`, and
  traffic cache composite keys before database mutation.
- An empty batch is valid only where the lifecycle explicitly permits zero
  rows; it must still fence and advance the stage truthfully.

### 3.3 Payload parsing and privacy

This refactor consumes only existing normalized internal contracts:

- `parseStableShopIdentity`
- `parseRunStoreCandidate`
- `parseShopLeadProfile`
- `leadRecordToCreate`
- `trafficCacheRecordToUpsert`
- `leadTrafficEnrichmentRecordToCreate`
- `diagnosticRecordToCreate`

Do not add fallback key paths, aliases, permissive schemas, or raw-provider
envelopes. Provider adapters remain the only owners of external response
parsing. Bulk helpers must receive the exact mapped database rows, not raw HTML,
provider bodies, credentials, headers, tokens, or source-page content.

### 3.4 Store checkpoint transaction

Input: all normalized merged stores and their safe diagnostics.

One transaction must:

1. fence the active run lease;
2. bulk-read existing Shops for all stable keys;
3. reject any verified MyShopify identity conflict before mutation;
4. bulk-upsert Shops while preserving the existing stronger-identity rules;
5. bulk-read any existing RunStores and reject conflicting provenance replay;
6. bulk-insert missing RunStores with deterministic IDs;
7. bulk-upsert store diagnostics;
8. set `stores_persisted`, truthful progress, and heartbeat; and
9. return the durable rows in deterministic order.

The statement count must remain bounded as store count grows. Concurrent
identical Shop batches must converge on one Shop per stable key. A unique-key
race may retry the complete idempotent transaction once, exactly as today.

### 3.5 Sequential lead discovery with bulk run-lead barrier

The network loop remains sequential. Split durable responsibilities:

**Immediately after each newly discovered shop profile:**

- atomically validate and persist the reusable `ShopLeadProfile` outcome;
- atomically complete/fail only the lead-discovery `ShopWork` owned by the
  current run and lease; and
- retain enough normalized in-memory outcome to construct the run lead later.

This immediate global-profile transaction remains deliberately per shop. It is
small and prevents duplicate expensive discovery. It must not insert the
run-specific Lead or finalize its RunStore.

**For reusable profiles:**

- validate/materialize the run-specific lead without network I/O;
- make no global profile mutation; and
- add the run-specific outcome to the in-memory batch.

**After every RunStore has a normalized outcome:**

One lead-barrier transaction must:

1. fence the active run lease;
2. bulk-read all referenced Shops, RunStores, profiles, and any replayed Leads;
3. cross-check every lead/profile/stable identity before mutation;
4. reject conflicting exact replay;
5. bulk-insert all missing run-specific Leads with deterministic IDs;
6. bulk-transition all corresponding RunStores to `completed` or `failed`;
7. bulk-insert safe per-store diagnostics;
8. calculate the lead summary from durable rows;
9. set `leads_persisted` and `resultsAvailable = true`; and
10. commit before traffic is dispatched.

A commit followed by a lost acknowledgement must be an exact idempotent replay.
If the process dies before this batch, completed global profiles remain reusable
and run leads are reconstructed without repeating those contact calls.

### 3.6 Traffic claim batch

For each existing source/scope batch:

1. attach exact reusable cache entries first;
2. submit all remaining `(shopId, workType, scopeKey)` keys to one
   lease-fenced `claimShopWorkBatch()` transaction;
3. atomically insert missing claims, retain completed/ambiguous claims, preserve
   active foreign owners, and reclaim only terminal/expired/known-failed work;
4. return one exact outcome per requested key: `won`, `completed`, `processing`,
   `failed`, or `ambiguous`;
5. reconcile returned keys with requested keys; and
6. place only `won` identities into the provider request.

Two runs racing the same 100-key batch must produce exactly one winner per key,
not necessarily one winner for the entire batch. `ambiguous` paid work is never
reclaimed automatically.

### 3.7 Traffic success and publication batches

For each DataForSEO scope, one transaction must:

1. fence the run lease;
2. transition the exact in-flight paid ledger to succeeded;
3. bulk-upsert all normalized cache rows;
4. bulk-complete only the exact `ShopWork` rows owned by this lease;
5. validate affected key/count reconciliation; and
6. return the terminal ledger.

For CrUX REST and BigQuery, use equivalent bulk cache and owned-work completion
transactions without a paid ledger.

After an existing traffic source finishes, one transaction must bulk-upsert all
run-specific `LeadTrafficEnrichment` rows for that source, bulk-insert safe
diagnostics, and merge that source summary. Do not delete base Leads.

Commit each scope/source independently. A later failure preserves earlier cache
and run-specific traffic material. Unknown paid-call outcome remains ambiguous
and is never automatically retried.

---

## 4. Safety invariants

| ID | Invariant | Owner | Proof |
|---|---|---|---|
| BP-I1 | No traffic call occurs before the bulk lead barrier commits | BP2 | provider spy + DB assertion |
| BP-I2 | Traffic failure never deletes or hides committed Leads | BP2/BP3 | injected failure matrix |
| BP-I3 | Store, lead-barrier, and traffic statement counts are bounded independently of row count | BP1–BP3 | operation-count spy + 1/40/100-row tests |
| BP-I4 | No awaited per-row database call or DB `Promise.all` exists in owned bulk paths | BP1–BP3 | source review plus operation-count tests |
| BP-I5 | Existing strict mappers remain the only payload ingress | BP1–BP3 | positive/negative mapper regressions |
| BP-I6 | One logical shop remains one global Shop | BP1 | competing PostgreSQL batches |
| BP-I7 | Sequential contact discovery remains sequential | BP2 | max-active network spy equals one |
| BP-I8 | Completed global profiles prevent repeated contact discovery after a pre-barrier crash | BP2 | crash/restart call counter |
| BP-I9 | Run-lead batch replay is exact and conflicting replay fails closed | BP2 | lost-ack/reverse replay tests |
| BP-I10 | Only won traffic identities enter provider payloads | BP3 | competing batch claim/provider spy |
| BP-I11 | Paid ledger permission commits before provider I/O | BP3 | unchanged ordering spy + PostgreSQL proof |
| BP-I12 | Paid success, cache, and work completion are atomic | BP3 | failure after every internal boundary |
| BP-I13 | Ambiguous paid work is never automatically retried | BP3 | concurrent/restart tests |
| BP-I14 | Lease loss prevents stale batch publication | BP1–BP3 | competing lease tests |
| BP-I15 | No raw HTML/provider body/secrets enter SQL, storage, logs, or fixtures | BP1–BP4 | negative payload tests + secret scan |
| BP-I16 | Existing API/frontend/CSV/provider behavior remains unchanged | BP4 | full regression/build |

---

## 5. Sequential execution windows

Do not parallelize implementation. All windows share repository transaction and
lease invariants.

### Window BP1 — Set-based primitives and store checkpoint

**Status:** complete  
**Objective:** Establish safe reusable set-based SQL helpers and convert store
persistence to a true bulk checkpoint.

#### Required reading

- This entire document and governing parent rules.
- Current dirty diff.
- `prisma/schema.prisma` and the progressive migration.
- `src/shop-persistence-contract.js`.
- `src/prisma-run-repository.js`, especially Shop/RunStore ID helpers,
  `saveDiscoveredStores()`, and lease predicates.
- Existing progressive repository and PostgreSQL integration tests.

#### Ownership

```text
email_scraper/src/prisma-run-repository.js
email_scraper/src/<one small parameterized bulk SQL helper if justified>
email_scraper/test/prisma-run-repository.test.js
email_scraper/test/progressive-persistence.integration.test.js
```

Do not edit server, pipeline, provider, traffic-orchestrator, frontend, schema,
or migration behavior in BP1.

#### Ordered tasks

- [x] Define bounded, duplicate-free bulk row/key validation.
- [x] Define a parameterized set-based write mechanism; prohibit dynamic SQL
      value interpolation and per-row awaited database calls.
- [x] Convert Shop merge/upsert to a bounded statement count while preserving
      stronger identity and MyShopify conflict rules exactly.
- [x] Convert RunStore insert/replay and diagnostics to bounded statements.
- [x] Preserve the lease fence, deterministic IDs, exact replay, progress, and
      one safe unique-race retry.
- [x] Return durable stores in deterministic order.
- [x] Add operation-count tests for 1, 40, and 100 rows.
- [x] Add real PostgreSQL 100-store and competing-batch proof.

#### Acceptance

- 100 stores commit under Prisma's existing default transaction timeout on the
  direct isolated test endpoint.
- Database statement count stays within the documented constant bound.
- Two concurrent identical batches create one Shop per stable key and separate
  RunStores per run.
- Conflicting MyShopify identity or provenance rolls back the whole batch.
- No external parser, provider, schema, or frontend file changes.

#### Commands

```bash
node --test test/shop-persistence-contract.test.js test/prisma-run-repository.test.js
npm run db:validate
npm run db:generate
npm run check:secrets
git diff --check
```

Run the BP1 PostgreSQL integration file alone against the direct isolated test
endpoint. Record statement counts, duration, changed files, exact command and
result, skipped evidence, and residual risk. Stop before BP2.

### Window BP2 — Sequential discovery and bulk run-lead barrier

**Status:** complete  
**Depends on:** BP1  
**Objective:** Keep contact discovery sequential, preserve reusable global
profiles immediately, and bulk-persist run leads before traffic.

#### Ownership

```text
email_scraper/src/server.js
email_scraper/src/prisma-run-repository.js       # lead/profile methods only
email_scraper/src/status.js                      # only if progress truth requires it
email_scraper/test/progressive-worker.test.js
email_scraper/test/prisma-run-repository.test.js
email_scraper/test/progressive-persistence.integration.test.js
```

Do not edit lead extraction/scoring, pipeline discovery algorithms, provider
adapters, traffic orchestration, frontend, schema, or migrations.

#### Ordered tasks

- [x] Split immediate reusable-profile/work completion from run-specific lead
      publication without weakening shop identity or lease ownership checks.
- [x] Keep the store network loop sequential and prove maximum active lead
      discovery calls equals one.
- [x] Collect one strict normalized run outcome per RunStore, including safe
      failed outcomes and diagnostics.
- [x] Add one `saveLeadBatch()`/lead-barrier repository operation.
- [x] Bulk-read all referenced durable state before mutation.
- [x] Bulk-insert missing Leads, transition RunStores, and insert diagnostics.
- [x] Calculate summary from durable Leads and atomically set
      `resultsAvailable = true` plus `leads_persisted`.
- [x] Make exact replay safe after lost acknowledgement and reject conflicting
      replay.
- [x] Ensure traffic receives only leads reloaded from PostgreSQL after commit.
- [x] Update recovery so a pre-barrier crash reconstructs run leads from durable
      profiles without repeating completed contact discovery.

#### Adversarial verification

- 100 sequential normalized outcomes produce one bulk lead commit.
- Contact discovery max concurrency is exactly one.
- A crash after profile 37 and before the lead barrier leaves zero/previously
  committed run leads as appropriate, but restart reuses 37 profiles with zero
  repeated contact/page/AI calls.
- A crash after the lead commit and before traffic retains all 100 leads and
  exposes results.
- Traffic provider spy observes the database already contains all Leads.
- One failed store is represented without rolling back the other outcomes.
- Lost acknowledgement replays exactly; changed payload replay fails closed.
- Lease loss at profile or lead-barrier publication prevents stale writes.
- Cross-shop/profile/lead reassignment remains rejected.

#### Commands and stop

```bash
node --test test/progressive-worker.test.js test/prisma-run-repository.test.js
node --test test/pipeline.test.js test/server.test.js
npm test
npm run check:secrets
git diff --check
```

Run the BP2 PostgreSQL integration alone against the direct isolated endpoint.
Record changed files, calls avoided on restart, statement counts, exact command
results, and residual risks. Stop before BP3.

### Window BP3 — Bulk traffic claims, cache commits, and source publication

**Status:** complete  
**Depends on:** BP1–BP2  
**Objective:** Remove all per-identity SQL loops from active traffic paths while
preserving paid-call fencing and per-scope durability.

#### Required reading

- Current `src/enrichment/orchestrator.js` end to end.
- Repository traffic cache, `ShopWork`, paid ledger, and publication methods.
- Exact DataForSEO and CrUX fixtures and parser tests.
- TE-3/TE-R2 paid safety tests and prior progressive traffic tests.

#### Ownership

```text
email_scraper/src/enrichment/orchestrator.js
email_scraper/src/prisma-run-repository.js       # traffic methods only
email_scraper/test/traffic-orchestration.test.js
email_scraper/test/prisma-run-repository.test.js
email_scraper/test/te3-traffic-enrichment.integration.test.js
email_scraper/test/progressive-persistence.integration.test.js
```

Provider adapters, request builders, response Zod contracts, schema, migrations,
server lead behavior, public serializer, and frontend are read-only.

#### Ordered tasks

- [x] Add exact bounded `claimShopWorkBatch()` semantics and result
      reconciliation.
- [x] Replace DataForSEO, CrUX REST, and CrUX BigQuery per-identity claims with
      one batch claim per source/scope.
- [x] Preserve cache-first attachment and bounded wait/reclaim behavior for
      active foreign owners.
- [x] Prove provider request targets contain only `won` keys.
- [x] Convert DataForSEO paid-success cache/work writes to set-based operations
      in the existing atomic ledger transaction.
- [x] Convert CrUX cache and work completion writes to set-based operations.
- [x] Convert run-specific traffic rows and safe diagnostics to bulk
      publication per source.
- [x] Preserve independent scope/source commits and partial summaries.
- [x] Retain ambiguous paid work as terminal non-retryable material.
- [x] Add safe batch count/duration telemetry without domains, payloads, SQL,
      credentials, or provider bodies.

#### Adversarial verification

- 100 domains × 10 DataForSEO scopes use ten claim batches, not 1,000 claim
  transactions.
- Each 100-domain success uses a bounded number of database statements and
  completes under the existing default transaction timeout on direct PostgreSQL.
- Two concurrent runs produce one paid provider call per missing
  shop/source/scope and both attach the winner's cache when completed.
- Cache-hit runs make zero provider calls and zero work-claim mutations.
- Failure before dispatch, after dispatch, after provider success, during bulk
  cache write, during owned-work completion, during run-source publication,
  and during final summary preserves all base Leads.
- A failure inside the paid-success transaction rolls back ledger/cache/work
  together and leaves the paid outcome safely in-flight/ambiguous; it is never
  automatically retried.
- One source failure preserves earlier scope/source cache and run material.
- Existing provider contract tests pass unchanged.

#### Commands and stop

```bash
node --test test/traffic-orchestration.test.js test/prisma-run-repository.test.js
node --test test/dataforseo-enrichment.test.js test/crux-enrichment.test.js
node --test test/te3-traffic-enrichment.integration.test.js
npm test
npm run check:secrets
git diff --check
```

Use mocked provider seams only. Run real PostgreSQL claim/write tests against an
isolated direct endpoint. Record statement counts and duration for 1, 40, and
100 domains, exact command results, changed files, and residual risks. Stop
before BP4.

### Window BP4 — Recovery, scale matrix, and compatibility closure

**Status:** complete  
**Depends on:** BP1–BP3  
**Objective:** Prove the complete revised lifecycle and close only compatibility
or observability gaps introduced by batching.

#### Ownership

```text
email_scraper/src/server.js                     # recovery/telemetry only
email_scraper/src/prisma-run-repository.js      # recovery/read only
email_scraper/README.md
email_scraper/test/*progressive*.test.js
email_scraper/test/*integration.test.js
```

No new feature, schema, frontend, external contract, or deployment work.

#### Required matrix

- 0, 1, 40, and 100 store checkpoints;
- 0, 1, 40, and 100 lead outcomes;
- 0, 1, 40, and 100 traffic targets;
- all cache, no cache, and mixed cache;
- all new, all replay, and mixed replay;
- duplicate keys and conflicting replay;
- crash before/after each transaction commit;
- lost acknowledgement after each commit;
- lease loss and competing owners;
- known provider rejection and ambiguous paid outcome;
- one traffic scope/source failure after earlier successes;
- disabled traffic providers;
- legacy CSV `run:once` path; and
- authorized API visibility before and after the lead barrier.

#### Acceptance

- No active store/lead-barrier/traffic bulk path contains an awaited per-row
  database call or DB `Promise.all`.
- Statement counts are bounded and recorded for 1/40/100 rows.
- The full mocked-provider suite passes.
- All isolated PostgreSQL migration, lease, concurrency, and 100-row scale tests
  pass sequentially against the direct endpoint.
- No provider request or response contract changed.
- No migration was created unless a separately recorded blocker required it.
- No user database migration, paid provider request, or server restart occurred.

#### Commands

```bash
npm run db:generate
npm run db:validate
npm test
npm run test:integration
npm run check:secrets
git diff --check
```

If frontend remains untouched, do not rebuild it merely for this backend-only
refactor. If it is unexpectedly touched, stop and justify the scope change
before running its required test/build checks.

Record exact results and stop for parent review.

### Window BP5 — Independent parent reliability review

**Status:** complete after BP-R1 and BP-R2 correction and repeat review  
**Depends on:** BP1–BP4  
**Objective:** Independently trace and verify the entire bulk lifecycle.

The reviewer must:

- inspect the complete dirty diff and preserve earlier work;
- trace normalized payload -> bulk SQL row -> durable read -> API serialization;
- verify every dynamic SQL value is parameterized;
- verify no raw provider/body/HTML/secret storage or logs were introduced;
- search owned methods for per-row awaited DB calls and database `Promise.all`;
- inspect statement-count tests so mocks cannot hide per-row behavior;
- inspect Shop identity merge and replay semantics for regression;
- trace sequential lead discovery, immediate profile durability, bulk Lead
  barrier, database reload, and traffic dispatch;
- trace cache-first lookup, batch claim, ledger-before-network, provider target
  filtering, atomic success, source publication, and finalization;
- run 100-row real PostgreSQL tests, not only unit mocks;
- confirm traffic failure leaves all Leads visible;
- confirm ambiguous paid work cannot be reclaimed;
- rerun focused and full deterministic suites; and
- append corrective windows rather than silently fixing review findings.

BP5 may mark the plan complete only when every invariant has direct source and
executed evidence.

---

## 6. Planning readiness gate

- [x] The governing rules and relevant current source were read.
- [x] The current behavior and per-row loops are observed, not guessed.
- [x] The exact historical exception is labelled unknown; the timeout cause is
      labelled inference.
- [x] The authoritative contract and superseded persistence granularity are
      explicit.
- [x] Sequential lead/contact discovery is locked and cannot be parallelized by
      an implementation agent.
- [x] Store, profile, lead, traffic claim, paid success, cache, and publication
      transaction boundaries are defined.
- [x] Identity, lease, paid ambiguity, replay, failure, recovery, and visibility
      behavior each have an owning window and test.
- [x] External provider parsing is read-only and no payload field is guessed.
- [x] Values in set-based SQL must be parameterized and strictly mapped.
- [x] Live provider calls and application-database mutations are excluded.
- [x] One focused 200K execution window is sufficient if windows remain
      sequential and stop at their gates.

---

## 7. Post-compaction continuation instructions

1. Read this entire document.
2. Read `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md` completely.
3. Inspect the current dirty diff; preserve all existing work.
4. Recheck whether the progressive migration is applied, using read-only
   inspection only. Do not deploy it as part of this plan.
5. Execute BP1 only and prove its gate before BP2.
6. Continue BP2, BP3, and BP4 sequentially only after each dependency passes.
7. Do not use `Promise.all` for database operations.
8. Do not parallelize lead/contact discovery.
9. Do not call live Google, Browserless, OpenAI, DataForSEO, CrUX, or BigQuery.
10. Use the direct isolated PostgreSQL test endpoint for scale/concurrency tests;
    do not run destructive tests against the application schema.
11. Update each window status, checkboxes, and evidence as work completes.
12. Perform BP5 independently. Append `BP-R1`, `BP-R2`, and so on for findings;
    never silently edit a completed window.
13. Stop and return to the user if a required fix changes provider payloads,
    Shop identity, authorization, public API shape, schema, sequential lead
    discovery, or paid retry semantics.

---

## 8. Definition of done

The work is complete only when:

- stores are written with bounded set-based statements;
- reusable profile/work outcomes remain immediately durable after sequential
  discovery;
- run Leads are bulk committed and visible before traffic;
- traffic work is claimed in batches and provider payloads contain only won
  identities;
- each scope/source cache, work, and run result is bulk persisted atomically;
- traffic failure cannot remove or hide base Leads;
- 100-row direct PostgreSQL tests pass under the existing transaction timeout;
- statement counts are bounded independently of row count;
- paid ledger, ambiguity, lease, identity, replay, privacy, and owner isolation
  remain intact;
- full deterministic and isolated integration suites pass;
- no external payload contract was guessed or changed; and
- BP5 finds no unresolved invariant violation.

---

## 9. Execution evidence

### BP1 handoff — August 3, 2026

**Status:** complete. BP2 had not started when this gate was recorded.

Implemented a parameterized `jsonb_to_recordset` Shop upsert, a single
`createMany` RunStore insert, and a parameterized diagnostic upsert. A
transaction-local schema selection uses a bound value so isolated-schema raw
SQL resolves to the same schema as Prisma without interpolating identifiers.
The store path performs seven database operations for 1, 40, or 100 rows:
schema selection, lease/stage fence, Shop read, Shop upsert, RunStore read,
RunStore insert, and durable RunStore reload. Diagnostics add one statement
only when present.

Changed files:

```text
email_scraper/src/prisma-client.js
email_scraper/src/prisma-run-repository.js
email_scraper/test/prisma-run-repository.test.js
email_scraper/test/progressive-persistence.integration.test.js
```

Executed evidence:

```text
node --test test/prisma-run-repository.test.js
  PASS — 32 tests; operation-count matrix 1/40/100 passed

ALLOW_DATABASE_TESTS=true node -r dotenv/config --test --test-concurrency=1 \
  test/progressive-persistence.integration.test.js
  PASS — 2 tests; 100-store competing checkpoints converged to 100 Shops and
  200 RunStores; the checkpoint assertion remained below 10 seconds while the
  file duration including two isolated migration setups was 43.2 seconds

npm run db:validate        PASS
npm run db:generate        PASS
npm run check:secrets      PASS
git diff --check           PASS
```

No migration, provider adapter, server, pipeline, traffic orchestrator, or
frontend behavior was changed. No live provider call, application-schema
mutation, migration deployment, or server restart occurred. Residual risk is
limited to the still-pending BP2–BP5 lifecycle work.

### BP2 handoff — August 3, 2026

**Status:** complete. BP3 had not started when this gate was recorded.

The worker now keeps one in-memory normalized outcome per unfinished RunStore.
Newly discovered global profiles and their owned `lead_discovery` work become
durable immediately, but no run Lead or terminal RunStore transition occurs
until `saveLeadBatch()` commits. Reusable profiles bypass network work. The
barrier bulk-validates Shop/Profile/Lead identity, inserts missing Leads,
transitions completed/failed RunStores in two set-based groups, bulk-upserts
diagnostics, derives its summary from durable Leads, and sets
`resultsAvailable=true` before the worker reloads qualified Leads for traffic.

Database operations for a successful no-diagnostic barrier remain ten at 1,
40, and 100 rows. Lead/contact discovery maximum observed concurrency is one,
even when runtime `storeConcurrency` is set higher. Exact lost-ack replay is
accepted and a changed lead replay rolls back.

Additional changed files:

```text
email_scraper/src/server.js
email_scraper/test/progressive-worker.test.js
```

Additional executed evidence:

```text
node --test test/progressive-worker.test.js test/prisma-run-repository.test.js
  PASS — sequential discovery and 1/40/100 barrier operation-count proofs

node --test test/pipeline.test.js
  PASS

node --test test/server.test.js (socket-enabled execution)
  PASS — 12 tests

ALLOW_DATABASE_TESTS=true node -r dotenv/config --test --test-concurrency=1 \
  test/progressive-persistence.integration.test.js
  PASS after the assertion-only case-sensitivity correction — isolated
  100-Lead barrier, exact replay, conflicting replay rollback, visibility, and
  post-traffic-failure preservation are covered

npm test (socket-enabled)     PASS — 245 tests; 238 pass; 7 expected DB skips
npm run check:secrets         PASS
git diff --check              PASS
```

The isolated test exposed one real PostgreSQL raw-query unique race reported by
Prisma as `P2010` with metadata code `23505`; the already-authorized single
idempotent store-checkpoint retry now recognizes that exact representation.
No lead discovery was parallelized, and no live provider, application database,
migration deployment, frontend, or server lifecycle action occurred.

### BP3 handoff — August 3, 2026

**Status:** complete. BP4 had not started when this gate was recorded.

Production traffic paths now claim all missing work for one existing
source/scope in one transaction. The repository returns one ordered outcome per
requested key, and the orchestrator reconciles every Shop/work/scope before
allowing only `won` identities into a provider request. Active foreign work is
waited on in batches; completed winner cache is reread in one cache query.

DataForSEO paid success now commits the ledger transition, all normalized
cache rows, and all owned ShopWork completions with set-based statements in one
lease-fenced transaction. CrUX cache rows and completed owned work use the same
atomic pattern. Failed/ambiguous work completion and run-specific source
publication are set-based. Source/scope ordering, immutable cost policy, and
paid ambiguity behavior are unchanged. Batch telemetry contains only operation,
source, scope, row count, duration, and run ID.

Additional executed evidence:

```text
node --test test/traffic-orchestration.test.js test/prisma-run-repository.test.js
  PASS — 1/40/100 claim operation counts and 100 domains -> ten scope batches

node --test test/dataforseo-enrichment.test.js test/crux-enrichment.test.js
  PASS — strict provider contract suites unchanged

ALLOW_DATABASE_TESTS=true node -r dotenv/config --test --test-concurrency=1 \
  test/progressive-persistence.integration.test.js
  PASS — 100-key competing claims, exactly 100 winners, ambiguous non-retry,
  100-row paid cache/work success, CrUX cache/work success, two 100-row source
  publications, and Lead preservation

ALLOW_DATABASE_TESTS=true node -r dotenv/config --test --test-concurrency=1 \
  test/te3-traffic-enrichment.integration.test.js
  PASS — 2 tests; existing paid ledger, exposure, deadline, recovery, tenancy,
  rollback, and migration proofs remained intact

npm test (socket-enabled)     PASS — 248 tests; 241 pass; 7 expected DB skips
npm run check:secrets         PASS
git diff --check              PASS
```

No provider adapter/request/response parser, public contract, schema,
migration, frontend, or CSV behavior changed. No live provider request,
application-schema mutation, migration deployment, or server lifecycle action
occurred.

### BP4 handoff — August 3, 2026

**Status:** complete. Stopped for BP5 parent review after this gate.

The remaining final-traffic diagnostic loop was converted to the shared bulk
diagnostic upsert. Empty store/lead barriers and empty work claims are now
explicitly tested. Exact store replay, conflicting replay rollback, mixed
winner/cache attachment, all-cache, no-cache, ambiguous, provider failure,
disabled-provider, recovery, authorization, and legacy CSV behavior all pass.

Executed evidence:

```text
node --test test/prisma-run-repository.test.js test/progressive-worker.test.js \
  test/traffic-orchestration.test.js
  PASS — 57 focused tests including 0/1/40/100 matrices

node --test test/run-once.test.js test/server.test.js (socket-enabled)
  PASS — 16 tests

ALLOW_DATABASE_TESTS=true npm run test:integration
  PASS — 7/7 isolated PostgreSQL tests, no skips; migration replay, data
  preservation, worker leases, repository atomicity, 100-row batching,
  concurrent claims, paid recovery/exposure, tenancy, and rollback stages

npm run db:generate        PASS
npm run db:validate        PASS
npm test (socket-enabled)  PASS — 249 tests; 242 pass; 7 expected DB skips
npm run check:secrets      PASS
git diff --check           PASS
```

The plan-required read-only migration status check observed nine migrations and
confirmed that `20260803120000_progressive_shop_persistence` is still unapplied
to the configured application database. It was not deployed. This is an
operational prerequisite for later local application testing, not a local code
or isolated-test failure.

No provider request/response contract, schema, migration, public API, frontend,
authentication, query, score, CSV, or deployment behavior changed. No live
provider call, application database mutation, server restart, or server stop
occurred.

### BP5 parent review findings — August 3, 2026

**Status:** findings resolved by BP-R1 and BP-R2; repeat review complete.

The complete batching diff, transaction boundaries, provider-target filtering,
strict mapper ingress, SQL parameterization, statement-count tests, isolated
PostgreSQL evidence, sequential contact discovery, lead barrier, database
reload, and traffic publication were independently traced. BP-I1 through
BP-I12 and BP-I14 through BP-I16 have direct source and executed evidence.
BP-I13 is not yet closed because stale paid-request recovery and work recovery
are not one coherent state machine.

#### Window BP-R1 — Reconcile traffic success transaction inputs

**Status:** complete  
**Severity:** medium  
**Depends on:** BP1–BP4 and the BP5 finding above  
**Finding:** The bulk success transactions validate cache rows and owned work
claims independently, but do not cross-check them against one another or, for
DataForSEO, against the durable paid ledger metadata.

**Violated contract:** Section 3.7 requires the exact in-flight ledger, cache
material, and exact owned work keys to reconcile before commit. BP-I12 requires
that this matched set transition atomically.

**Exact reproduction:** Call `markDataForSeoRequestSucceeded()` for an
in-flight `worldwide` ledger with `targetCount = 2` while supplying one
`country:NZ:2554` work claim, or call `saveCruxTrafficCache()` with a
`crux_rest/current` cache row and a `crux_bigquery/month:*` work claim. The
current repository accepts the individually valid arrays and may commit a
mismatched durable state.

**Root cause and ownership:** `email_scraper/src/prisma-run-repository.js`
checks type, bounds, and duplicate keys but omits cross-set scope/source/count
reconciliation. Unit and isolated database coverage in
`email_scraper/test/prisma-run-repository.test.js` and
`email_scraper/test/progressive-persistence.integration.test.js` covers valid
bulk success, not deliberately mismatched sets.

**Bounded fix:**

- In the paid-success transaction, read and validate the owned in-flight ledger
  before its transition.
- Require every paid work claim and cache row to use the ledger scope; when the
  progressive work-claim array is present, require its count to equal the
  ledger target count and reject more cache rows than targets.
- Preserve the existing legacy empty-work-claim compatibility path.
- For CrUX progressive commits, require one work claim per cache row and require
  one matching work type/scope/source across the batch.
- Add negative rollback tests for wrong scope, count, source, and mixed CrUX
  batches, plus unchanged 0/1/40/100 success coverage.

**Migration implications:** none. Provider payloads, strict parsers, public API,
and schema remain unchanged.

**Required verification:** focused repository tests, the existing BP3 traffic
tests unchanged, the isolated 100-row progressive PostgreSQL test, full
deterministic tests, secret scan, and diff hygiene.

**Stop condition:** record source/test evidence and stop before BP-R2. Do not
change provider adapters, orchestration order, schema, frontend, or server
lifecycle.

**Handoff evidence — August 3, 2026:** The repository now checks the owned
in-flight paid ledger before mutation, reconciles paid scopes and progressive
target counts, bounds cache rows by the paid target count, and cross-reconciles
CrUX source/scope/count before opening its transaction. Wrong-scope and
wrong-count tests fail before durable mutation. The existing empty-work-claim
compatibility path remains supported.

```text
node --test test/prisma-run-repository.test.js test/traffic-orchestration.test.js
  PASS — including new paid and CrUX mismatch rollback tests

ALLOW_DATABASE_TESTS=true node -r dotenv/config --test --test-concurrency=1 \
  test/progressive-persistence.integration.test.js
  PASS — isolated 100-row paid and CrUX commits; 26.1 seconds
```

Changed files were limited to the traffic repository, its unit tests, and this
execution document. No migration, provider, orchestration, frontend, server
lifecycle, live provider, or application-schema action occurred. BP-R2 had not
started when this gate was recorded.

#### Window BP-R2 — Couple paid ambiguity recovery to ShopWork

**Status:** complete  
**Severity:** high  
**Depends on:** BP-R1  
**Finding:** If a paid provider call returns but its atomic success transaction
does not commit, the ledger remains `in_flight` and the associated `ShopWork`
rows remain `processing`. Recovery later marks only the ledger ambiguous. A
subsequent run can reclaim the inactive owner's processing work because the
batch claim path does not consult the paid ledger.

**Violated contract:** BP-I13 and Sections 3.6–3.7 require unknown paid outcomes
to remain ambiguous and never be reclaimed automatically.

**Exact reproduction:** Create an in-flight DataForSEO ledger and matching
processing `ShopWork`, expire or terminate its owner run, then invoke recovery
and claim the same shop/scope from a second run. The current recovery updates
only `DataForSeoRequestLedger`; `claimShopWorkBatch()` treats the inactive owner
as reclaimable and can grant network permission for a duplicate paid request.
There is also a pre-recovery race while the ledger remains in-flight.

**Root cause and ownership:**
`email_scraper/src/prisma-run-repository.js` implements ledger recovery and
generic work reclamation independently. Recovery in `email_scraper/src/server.js`
correctly delegates to the repository and needs no public behavior change.

**Bounded fix:**

- Make stale paid-ledger recovery one set-based transaction that marks matching
  DataForSEO `ShopWork` owned by the same run and scope ambiguous as well as
  transitioning the ledgers.
- In the batch work-claim compare-and-swap, refuse to reclaim DataForSEO work
  while its prior owner has a matching in-flight or ambiguous paid ledger.
  This closes the interval before and during recovery; conservative scope-level
  protection is acceptable because the schema does not persist ledger target
  membership.
- Keep known failed/not-dispatched work retryable and keep CrUX/lead behavior
  unchanged.
- Preserve bounded statement counts and use only parameterized, static SQL.
- Add real PostgreSQL tests for pre-recovery, post-recovery, and concurrent
  recovery/claim orderings; all must grant zero duplicate network permissions.
  Add a known-failed control that remains reclaimable.

**Migration implications:** none. The conservative run/scope relationship uses
existing ledger and work columns. No external request or response contract is
changed.

**Required verification:** focused repository and recovery tests, original BP3
and BP4 suites unchanged, isolated concurrency tests, full deterministic and
database integration suites, secret scan, and diff hygiene.

**Stop condition:** record evidence, then rerun the complete BP5 review. The
overall plan may be marked complete only if no unresolved invariant violation
remains. Do not call a provider, deploy a migration, mutate the application
database, or restart/stop a user server.

**Handoff evidence — August 3, 2026:** The set-based work claim compare-and-swap
now refuses to reclaim DataForSEO work whose prior owner has an in-flight or
ambiguous ledger for that scope. Paid recovery uses one transaction to retain
the original inactive-run/deadline predicate, transition eligible ledgers, and
set all matching processing work for ambiguous ledgers to `ambiguous`. This
also repairs a crash between the explicit ledger-ambiguity transition and its
separate work acknowledgement. Known failed/not-dispatched ledgers remain
reclaimable.

Executed evidence:

```text
node --test test/prisma-run-repository.test.js test/traffic-orchestration.test.js
  PASS — recovery reconciliation, paid protection, and original traffic cases

node --test test/server.test.js (socket-enabled)
  PASS — 12/12 recovery and server compatibility tests

ALLOW_DATABASE_TESTS=true node -r dotenv/config --test --test-concurrency=1 \
  test/progressive-persistence.integration.test.js
  PASS — pre-recovery, concurrent recovery/claim, post-recovery, and known
  failure control on real PostgreSQL; 100-row matrix retained

npm test (socket-enabled)
  PASS — 252 tests; 245 pass; 7 expected database-gated skips; 0 fail

ALLOW_DATABASE_TESTS=true npm run test:integration
  PASS — 7/7 isolated PostgreSQL tests; no skips; 284.9 seconds

npm run db:generate       PASS
npm run db:validate       PASS
npm run check:secrets     PASS
git diff --check          PASS
```

No schema or migration was added by BP-R1/BP-R2. No external request/response
parser, provider adapter, public API, frontend, authentication, query, scoring,
CSV, or deployment behavior changed. No provider was called, the application
database was not mutated, and no server was restarted or stopped.

### BP5 repeat parent reliability review — August 3, 2026

**Status:** complete; no unresolved finding remains.

The complete current diff and both corrective changes were traced again from
strict normalized mapper input through parameterized bulk SQL, durable reads,
and public serialization. Store identity, exact replay, lease ownership,
sequential contact discovery, immediate reusable profiles, the bulk Lead
barrier, database reload before traffic, cache-first lookup, batch claims,
ledger-before-network permission, winner-only provider targets, atomic success,
source publication, recovery, and final visibility agree with the locked
contract.

Owned store, Lead-barrier, traffic-claim, cache/work, source-publication, and
recovery paths contain no awaited per-row database loop or database
`Promise.all`. Dynamic SQL values remain parameter-bound and static identifiers
only; no raw HTML, provider body, credential, target, or secret was introduced
into SQL, storage, fixtures, logs, or telemetry. Real PostgreSQL concurrency
proves that in-flight and ambiguous paid outcomes grant zero duplicate network
permissions, while known failed/not-dispatched work remains retryable.

BP-I1 through BP-I16 now have direct source and executed evidence. The sole
remaining prerequisite is operational: the read-only BP4 check found
`20260803120000_progressive_shop_persistence` unapplied on the configured
application database. It must be deployed before local application testing,
but deployment was intentionally outside this execution and was not performed.
