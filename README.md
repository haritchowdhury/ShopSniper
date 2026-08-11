# Email Scraper backend — development record

Last reconciled with the source: **11 August 2026**

This is the backend's maintained development record and current-state guide. It
replaces the scattered implementation summaries that are now retained under
`docs/` as historical evidence. When this document, an old plan, and the source
disagree, the source and migrations are authoritative.

The current AWS migration documents are deliberately maintained at the repository
root and were reconciled separately from this current-code record:

- [`../AWS_ASYNC_DEPLOYMENT_DIRECTION.md`](../AWS_ASYNC_DEPLOYMENT_DIRECTION.md)
- [`../PRELIMINARY_LAMBDA_SQS_S3_MIGRATION_PLAN.md`](../PRELIMINARY_LAMBDA_SQS_S3_MIGRATION_PLAN.md)
- [`../TARGET_LAMBDA_SQS_S3_EXECUTION_FLOW.md`](../TARGET_LAMBDA_SQS_S3_EXECUTION_FLOW.md)
- [`../AWS_BEGINNER_SETUP_GUIDE.md`](../AWS_BEGINNER_SETUP_GUIDE.md)
- [`../PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md`](../PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md)

## Current state

The backend is a Node.js 20+ ESM service that discovers Shopify stores, extracts
and validates outreach evidence, enriches qualified leads, persists durable run
state in PostgreSQL through Prisma, and serves a private JSON API to the Next.js
backend-for-frontend (BFF).

| Area | Implemented state |
|---|---|
| Runtime | Node.js HTTP server; no Express or framework dependency |
| Database | PostgreSQL/Neon through Prisma 6.19.3 and the Neon serverless adapter |
| Input | JSON category submissions for the HTTP flow; CSV remains supported by `run:once` |
| Query planning | OpenAI Responses API research/generation, deterministic validation, Google Custom Search probes, exactly 10 accepted queries per category by default |
| Human review | Durable editable query revisions; scraping starts only after confirmation |
| Discovery | Google results, Shopify identity resolution, bounded page/sitemap discovery, Browserless fallback when enabled |
| Evidence | Store-associated email, phone, contact-page, social, category-fit, identity, and discovery provenance |
| Persistence | Runs, queries, shops, reusable profiles, run leads, user-shop grants, diagnostics, and traffic material |
| Worker | In-process queue drain with durable database leases, heartbeats, recovery, and stale-worker fencing |
| Traffic | Optional DataForSEO and CrUX REST/BigQuery adapters; both disabled by default |
| Scoring | Pipeline v2 with lead scoring v3 for newly finalized progressive runs; missing worldwide DataForSEO traffic produces an explicit unscored v3 state |
| Ownership | Every user-facing read is owner-scoped; the BFF supplies trusted user identity behind a shared bearer token |
| Master leads | User-scoped, globally deduplicated current shop/profile/traffic view plus immutable historical run results |

## Repository map

```text
email_scraper/
├── prisma/
│   ├── schema.prisma             PostgreSQL model
│   └── migrations/               ten forward migrations through user master leads
├── scripts/
│   ├── check-secrets.js          repository-wide redacted credential scan
│   └── traffic-discovery-probe.js
├── src/
│   ├── server.js                 private API, admission, queue drain, leases, recovery
│   ├── pipeline.js               planning, validation, store and lead discovery
│   ├── prisma-run-repository.js  durable lifecycle and query operations
│   ├── api-serializer.js         public JSON contracts and traffic aggregation
│   ├── lead-scorer.js            v2 compatibility and v3 scoring mathematics
│   ├── lead-state.js             cross-field score-state invariants
│   ├── *-adapter.js              strict external-provider boundaries
│   └── run-once.js               legacy foreground CSV workflow
├── test/                         offline and guarded PostgreSQL integration tests
├── review-evidence/              implementation-window handoffs and reviews
└── docs/                         consolidated historical/reference material
```

## Development history

### 30 July — Node pipeline and dynamic query generation

- Replaced the original workflow concept with a modular Node.js pipeline.
- Added category normalization, AI-assisted category research, candidate query
  generation, deterministic validation, Google CSE probing, ranking, repair, and
  query-audit CSV output.
- Added Shopify domain resolution, storefront validation, bounded page discovery,
  contact extraction, AI normalization, lead scoring, and CSV output.
- Preserved `run:once` as the explicit foreground/CSV command.

### 31 July — durable API, ownership, and pipeline-quality v2

- Added Prisma and the initial Neon-backed run/result schema.
- Added asynchronous run creation, polling, paginated results, sorting, filtering,
  durable fixture seeding, and safe error envelopes.
- Added anonymous run intents, authenticated ownership, owned run history, and a
  serial queue that accepts multiple queued runs.
- Implemented pipeline v2 evidence: stronger store identity, candidate-specific
  category intent, qualification, score v2, query audits, and diagnostics.
- Added owner-scoped result, audit, and diagnostic access.

### 1 August — corrective reliability and query review

- Hardened contact-route validation, storefront truth, Browserless attribution,
  bounded streamed response handling, category provenance, and safe presentation
  contracts.
- Made terminal persistence idempotent and lease-fenced; added multi-instance
  worker leases, heartbeat renewal, and expired-work recovery.
- Split the HTTP lifecycle into query planning, durable query review, validation,
  and scraping. Revision conflicts fail safely and the exact confirmed query set
  is consumed.
- Kept the one-shot CSV path operational and separate from the HTTP review flow.
- Closed the later G-R7 through G-R11 quality sequence: store-associated contact
  evidence, broad-store-resistant specialist classification, exact category-intent
  provenance, one backend/frontend score-state contract, and repository-wide
  redacted secret/workflow scanning.

### 2 August — strict query quality and optional traffic enrichment

- Enforced exactly `GENERATED_QUERY_COUNT` accepted queries per category or a
  durable, auditable shortfall; partial plans never reach review.
- Added `google-probe-v2`, adaptive repair rounds, provider-call ceilings, and
  product-family diversity.
- Added strict normalized DataForSEO traffic and CrUX REST/BigQuery adapters,
  caches, cost reservations, paid-request ledgers, recovery, public serialization,
  and CSV attribution.
- Kept both traffic providers disabled by default and production enablement gated
  by credentials, permission, quota, cost, and attribution checks.

### 3 August — progressive and true-bulk persistence

- Added global `Shop`, reusable `ShopLeadProfile`, `RunStore`, and `ShopWork`
  records so completed work can be reused safely across runs.
- Established durable checkpoints: stores before contact discovery, run leads
  before traffic, and traffic source publication before final completion.
- Converted store, run-lead, traffic-claim, cache/work-success, and source
  publication writes to bounded set-based database operations.
- Preserved sequential lead/contact discovery while batching the durable lead
  barrier.
- Added cache-first concurrency, winner-only provider calls, paid ambiguity
  protection, and resumable progressive stages.

### 4 August — user master leads and score v3

- Added `UserShop` and `UserShopDiscovery`, granting a user access only when one
  of their owned runs discovers the shop.
- Added current user master-lead list and traffic-overview endpoints while
  preserving immutable historical `Lead` snapshots.
- Added discovery-query filtering shared by results, traffic overviews, pagination,
  counts, and exports.
- Added lead scoring v3 with a locked 55-point core/contact allocation, 40-point
  measured-traffic component, and 5-point CrUX bonus.
- Made scoring publication atomic with traffic finalization. Qualified leads that
  lack valid measured worldwide DataForSEO traffic remain qualified but publish
  no v3 number.

### 11 August — repository state

- The latest backend commit adds only supplied image assets; it does not change
  backend behavior.
- All ten migrations are present and the configured application database reports
  the schema up to date.

## Current request lifecycle

```text
category submission
  -> authenticated run, or one-hour anonymous intent
  -> durable queued run
  -> leased query-planning worker
  -> OpenAI generation + deterministic validation + Google probes
  -> exactly configured query count, or terminal safe shortfall
  -> durable awaiting_query_confirmation revision
  -> user edits/replaces the complete revision
  -> confirmation and revalidation
  -> bulk store checkpoint
  -> sequential reusable-profile/contact discovery
  -> bulk run-lead checkpoint; base results become available
  -> optional cache-first DataForSEO and CrUX work
  -> atomic score-v3 and traffic finalization
  -> completed owned run + current user master grants
```

Important boundaries:

- Store scraping does not begin before query confirmation.
- A planning shortfall never publishes a partial editable query set.
- A successfully committed store or lead checkpoint survives later failure.
- `resultsAvailable` can be true while optional traffic ends in a safe failed or
  unavailable state.
- A stale worker cannot heartbeat, publish, or overwrite a newer lease owner.
- Historical run leads are snapshots. `/api/leads` uses current reusable profile
  and current shop traffic material.
- One process drains runs serially. Multiple processes are coordinated by database
  claim/lease fencing; the current runtime is not yet decomposed into cloud workers.

## Private API contract

Every backend route requires `Authorization: Bearer <BACKEND_API_TOKEN>`. Owned
routes also require the trusted `X-User-Id` injected by the server-side BFF. The
browser must never call this service directly or supply its own user identity.

| Method | Route | Current behavior |
|---|---|---|
| `GET` | `/api/health` | Database-backed health check |
| `POST` | `/api/run-intents` | Validate categories and create an unowned one-hour intent |
| `POST` | `/api/run-intents/{intentId}/claim` | Atomically claim/replay an intent for the authenticated user |
| `POST` | `/api/runs` | Create an owned queued run and return `202` |
| `GET` | `/api/runs` | Paginated owned run history |
| `GET` | `/api/runs/{runId}` | Owned status, phase, stage, progress, and safe errors |
| `GET` | `/api/runs/{runId}/queries` | Current durable editable query revision |
| `PUT` | `/api/runs/{runId}/queries` | Replace the complete revision using optimistic revision control |
| `POST` | `/api/runs/{runId}/start` | Confirm a revision and queue validated scraping |
| `GET` | `/api/runs/{runId}/results` | Owner-scoped status/search/query filtered, sorted, paginated results |
| `GET` | `/api/runs/{runId}/traffic-overview` | Aggregated run traffic without exposing unrelated lead rows |
| `GET` | `/api/runs/{runId}/query-audits` | Paginated durable query evidence after results are available |
| `GET` | `/api/runs/{runId}/diagnostics` | Paginated safe run diagnostics after results are available |
| `GET` | `/api/leads` | Current, deduplicated, user-owned master lead page |
| `GET` | `/api/leads/traffic-overview` | Current aggregate traffic for the user's accessible shops |

The detailed historical JSON contract is retained at
[`docs/reference/BACKEND_FRONTEND_JSON_HANDOFF_SPEC.md`](./docs/reference/BACKEND_FRONTEND_JSON_HANDOFF_SPEC.md),
but this table and the current serializers/routes take precedence where that old
specification describes an earlier state.

## Persistence model

The ten forward migrations lead to these active groups:

- **Run lifecycle:** `Run`, `RunQuery`, `RunIntent`, `QueryAudit`, and
  `RunDiagnostic`.
- **Historical results:** `Lead`, including run-specific evidence, versions,
  qualification, score state, discovery occurrences, and traffic snapshots.
- **Reusable shop state:** `Shop`, `RunStore`, `ShopLeadProfile`, and `ShopWork`.
- **Current user access:** `UserShop` and `UserShopDiscovery`. `UserShop` is the
  authorization join; discovery membership is idempotent on `(userShopId, runId)`.
- **Traffic:** `TrafficEnrichmentCache`, `LeadTrafficEnrichment`, and
  `DataForSeoRequestLedger`.

`Shop.stableKey` is the global deduplication boundary. A global shop/profile does
not by itself grant visibility: all master reads begin from the authenticated
user's `UserShop` rows.

## Query, evidence, and scoring contracts

### Query planning

- Default target: 10 accepted queries per category.
- Default candidate count: 30; maximum four repair rounds and 80 unique Google
  probes per category.
- The v2 gate requires minimum result count, unique hosts, relevant results,
  relevance ratio, and intrinsic score.
- Provider probe data may be shared for identical normalized query text, but each
  exact category/qualifier intent retains its own validation and provenance.

### Evidence and qualification

- Contact evidence must be associated with the verified store and an accepted
  source context. Arbitrary page text, order/SKU numbers, share links, and
  vendor/theme identities are rejected.
- Store fit distinguishes mismatch, category seller, and specialist. Brand intent
  requires specialist-quality evidence; broad marketplaces are not promoted by
  incidental category phrases.
- Identity retains observed, resolved, canonical, and MyShopify provenance without
  allowing cross-domain canonicals to widen the fetch boundary.
- Rejected and failed outcomes remain durable diagnostic rows and are never given
  a current v2/v3 score.

### Lead score v3

| Component | Maximum |
|---|---:|
| Identity confidence | 11 |
| Shopify validation | 14 |
| Category fit | 16 |
| Contact evidence | 14 |
| Measured worldwide traffic | 40 |
| CrUX LCP/INP/CLS bonus | 5 |

The traffic transform is `round(8 * log10(traffic + 1))`, capped at 40 and
explicitly capped at 40 from 100,000 upward. CrUX is bonus-only. The score is a
deterministic evidence rank, not a probability.

Supported public score states are:

- historical unversioned `legacy_v1`;
- scored or `not_scored_v2` for pipeline/scoring pair `2/2`;
- `traffic_evidence_rank_v3`, `insufficient_traffic_v3`, or `not_scored_v3` for
  pair `2/3`.

Backend persistence, serializers, shared fixtures, and frontend parsing enforce
the same cross-field state machine.

## Configuration and local operation

```bash
cd email_scraper
npm install
cp .env.example .env
npm run db:generate
npm run db:migrate:deploy
npm start
```

Required to start a real run:

- `DATABASE_URL`
- `BACKEND_API_TOKEN` in production
- `GOOGLE_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID`
- `OPENAI_API_KEY`

Optional Browserless, DataForSEO, and CrUX settings are documented in
`.env.example`. DataForSEO and CrUX are independently snapshotted per run and
disabled by default. Do not enable paid/customer-visible traffic until the
external permission, pricing, quota, attribution, and credential prerequisites
in the retained traffic documents have been completed.

Useful commands:

```bash
npm test
npm run test:integration
npm run db:validate
npm run check:secrets
npm run run:once
```

`npm run test:integration` runs its database cases only when both
`ALLOW_DATABASE_TESTS=true` and `TEST_DATABASE_URL` are present. It creates and
drops isolated schemas; it must never target an irreplaceable database.

## Verification snapshot — 11 August 2026

Verified against the current source:

- `npm test`: **272 tests; 265 pass, 0 fail, 7 guarded database skips**.
- Frontend-independent backend HTTP tests pass when localhost binding is allowed.
- Guarded PostgreSQL integration matrix: **6 of 7 pass**. Migration replay,
  rollback, lease concurrency/fencing, atomic repository persistence, 100-store
  bulk convergence, traffic ledger/cache recovery, and tenant isolation passed.
- `npm run db:validate`: pass.
- `npm run check:secrets`: pass.
- `npx prisma migrate status`: all **10 migrations applied** on the configured
  application database.
- No live Google, Browserless, OpenAI, DataForSEO, or CrUX request was made during
  this documentation verification.

### Blocking defect

The guarded test
`progressive checkpoints deduplicate shops and claims while preserving leads after traffic failure`
fails when it reaches the user-master grant added after the original progressive
persistence work. `grantRunShopsToOwner()` issues raw SQL against unqualified
`"Run"`, `"UserShop"`, and `"UserShopDiscovery"` names without first applying
the repository's selected schema. Prisma model operations correctly use the
isolated schema, but this raw query falls back to `public` and reports
`relation "Run" does not exist`.

The configured application database currently uses `public`, so this does not
prove a live failure there. It is still a release blocker for schema-independent
persistence and for a completely green database integration matrix. Fix it using
the same validated schema-selection boundary already used by the bulk raw-SQL
helpers, then rerun the entire seven-test integration command.

## Quality-plan reconciliation

[`docs/history/FINAL_PIPELINE_QUALITY_GAPS_REMEDIATION_PLAN.md`](./docs/history/FINAL_PIPELINE_QUALITY_GAPS_REMEDIATION_PLAN.md)
still says G-R7 through G-R11 are ready/blocked because its execution ledger was
never updated. That header is stale:

- backend handoffs `review-evidence/G-R7_HANDOFF.md` through
  `review-evidence/G-R9_HANDOFF.md` are complete;
- frontend `review-evidence/G-R10_HANDOFF.md` is complete across both projects;
- backend `review-evidence/G-R11_HANDOFF.md` is complete, with provider rotation
  explicitly left external; and
- the current source and regression suite contain the corresponding contracts.

No independent final parent-acceptance handoff was found for the combined
G-R7–G-R11 sequence. Preserve that distinction: implementation is present and
tested, while the old plan's final administrative acceptance was not recorded.

Credential rotation/revocation for values that existed in the local n8n exports
also remains externally unverified. The exports are ignored/deleted and the scan
is clean, but source hygiene cannot prove provider-side rotation.

## Documentation archive

The old files are retained rather than discarded:

- [`docs/history/`](./docs/history/) — completed or superseded implementation
  plans for the Node pipeline, API handoff, authentication, query review, query
  quality, scoring v3, traffic enrichment, progressive persistence, and true bulk
  persistence, including the stale-header final quality plan.
- [`docs/reference/`](./docs/reference/) — the detailed backend/frontend JSON
  handoff, quick start, and execution-checklist authoring rules.
- [`docs/research/`](./docs/research/) — original Shopify discovery research,
  clothing query research, pipeline audit, provider comparison, and traffic
  contract discovery.
- [`review-evidence/`](./review-evidence/) — per-window handoffs and independent
  review evidence.
Historical documents retain their original status and wording for traceability;
they are evidence, not a second current source of truth.
