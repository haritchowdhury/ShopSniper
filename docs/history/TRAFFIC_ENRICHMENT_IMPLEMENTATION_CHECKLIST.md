# Traffic Enrichment Implementation Checklist

**Status:** LOCAL IMPLEMENTATION COMPLETE AND TEST-READY — ALL WINDOWS CLOSED  
**Production enablement:** BLOCKED on external prerequisites in Section 3  
**Outer-repository release:** BLOCKED on retained finding `TE8-F7`; nested
backend and frontend repositories remain the verified implementation roots  
**Authoritative discovery:** `TRAFFIC_ENRICHMENT_PROVIDER_DISCOVERY.md`  
**Governing rules:** `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md`

This checklist replaces the provisional windows in
`TRAFFIC_ENRICHMENT_DISCOVERY_AND_DRAFT_PLAN.md`. Window IDs `TE1` through `TE7`
are stable and must not be reused. Execute one window at a time because later
windows consume earlier contracts, migrations, and lifecycle behavior.

TE1 through TE6 are implemented. TE7 found one recovery defect, and the
independent post-TE7 review found additional paid-call, validation, foreground
CSV, and release-readiness defects. Preserve the original window history. The
completed corrective sequence is:

```text
TE-R2 paid-call safety and durable accounting
  -> TE-R1 production recovery wiring
  -> TE-R3 normalized/public/frontend semantic integrity
  -> TE-R4 foreground CSV truthfulness
  -> TE-R5 independent parent reliability review
  -> TE-R6 restore PostgreSQL semantic publication coverage
  -> post-TE-R6 parent completion review (complete)
```

Do not execute TE-R1 before TE-R2: recovery must consume the durable deadline
and exposure contract established by TE-R2. No corrective window authorizes
enabling either provider or making an unapproved live provider call.

## 1. Locked outcome and exclusions

Add optional DataForSEO and CrUX enrichment to qualified, deduplicated leads.
Flags are independent and immutable for a run. Disabled sources make zero calls
and leave no public fields, CSV fields, or attribution. Optional-provider
failure never changes core qualification or contact data.

Included:

- strict Zod provider contracts backed by captured fixtures;
- DataForSEO worldwide plus nine country scopes;
- CrUX current origin performance and monthly popularity/device fractions;
- durable cache, paid-request ledger, restart behavior, cost/byte caps;
- owned backend API, both CSV paths, frontend display, and attribution;
- migrations, regression tests, and parent review.

Excluded:

- exact visit totals;
- DataForSEO raw response resale;
- traffic-source geographic shares from CrUX;
- Similarweb, Semrush, Ahrefs, or other providers;
- guessing between `www`, apex, HTTP, or HTTPS origins;
- automatic retry of ambiguous paid DataForSEO calls;
- historical backfill of old leads;
- provider task-history reconciliation until separately probed.

Historical leads remain valid and have no traffic section. No destructive
backfill or rewrite is authorized.

## 2. Invariants and owners

| Invariant | Owner | Required proof |
| --- | --- | --- |
| Exact evidence-backed parsing; no fallback aliases | TE1, TE2 | Positive and adversarial fixture tests |
| Flags snapshotted once per run | TE3 | Migration and repository tests |
| Disabled source makes zero calls and leaks no cache/data | TE4 | Four-combination orchestration tests |
| Provider error/no coverage/zero remain distinct | TE1, TE2, TE4 | Contract and lifecycle tests |
| Paid calls are ledgered before network I/O | TE3, TE4 | Failure-point and restart tests |
| Lease loss prevents stale publication | TE3, TE4 | Integration tests with competing leases |
| Core leads survive optional-source failure | TE4 | Provider-failure pipeline tests |
| Public API/CSV fields and attribution match included material | TE5 | Serializer and export matrix tests |
| Existing owner isolation protects enrichment | TE3, TE5 | Cross-tenant repository/API tests |
| Frontend validates and truthfully renders all states | TE6 | Parser, component, and CSV tests |
| No secret/raw-payload leakage | TE1–TE7 | Secret scan, log/error tests, final review |

## 3. Prerequisites

Available locally:

- funded and authenticated DataForSEO account;
- valid CrUX API key;
- Google project `voice-assistant-471909` with BigQuery billing/API access;
- local Application Default Credentials;
- captured sanitized fixtures and current location codes;
- both feature flags explicitly `false`.

Production prerequisites that must remain gates, not silently assumed:

- written DataForSEO permission for customer-facing display/export;
- AWS Workload Identity Federation or another approved short-lived Google
  credential mechanism;
- final CrUX CC BY attribution wording/legal review;
- current price, quota, and byte-cap review.

Do not put ADC files or a Google service-account JSON key in the repository or
Lambda environment.

## 4. Window TE1 — DataForSEO strict adapter

**Status:** complete  
**Objective:** Implement one exact DataForSEO request/response contract and
normalized adapter without connecting it to the pipeline.

### Dependencies and reading

- Read the complete authoritative discovery record.
- Read `test/fixtures/providers/dataforseo/README.md` and every fixture.
- Inspect current `src/config.js`, `src/http-client.js`, logger conventions,
  and existing provider contract tests.
- Confirm both feature flags remain false.

### Ownership and non-goals

Own:

```text
email_scraper/src/enrichment/errors.js
email_scraper/src/enrichment/dataforseo/request.js
email_scraper/src/enrichment/dataforseo/contract.js
email_scraper/src/enrichment/dataforseo/client.js
email_scraper/src/enrichment/dataforseo/adapter.js
email_scraper/test/dataforseo-enrichment.test.js
email_scraper/src/config.js                 # DataForSEO config only
email_scraper/test/config.test.js           # matching tests only
```

Do not edit Prisma, pipeline orchestration, API serialization, CSV, or frontend.
Do not run additional live paid calls.

### Ordered tasks

- [x] Add strict boolean config for `ENABLE_DATAFORSEO_ENRICHMENT`, default
  false. Require login/password only through a dedicated enabled-provider
  assertion, never on ordinary startup while disabled.
- [x] Pin the endpoint, item types, 1,000-target limit, all nine observed
  country codes, and worldwide scope in one request module.
- [x] Normalize and validate hostnames before request construction; reject
  schemes, paths, credentials, ports, leading `www.`, Unicode ambiguity,
  duplicates after normalization, and over-limit batches.
- [x] Sort targets and create a canonical request fingerprint.
- [x] Build exactly one JSON-array task per HTTP call. Worldwide omits location
  and language; country calls use only `location_code`; all calls omit language.
- [x] Implement Zod schemas for the exact root, task, result, item, and four
  metric shapes. Do not use aliases, unions without fixtures, coercion, unsafe
  casts, optional consumed envelopes, or fallback root selection.
- [x] Check HTTP, root status, task status, cardinalities, echoed request data,
  result scope, item count, unique target set, finite non-negative ETV, and
  non-negative integer counts.
- [x] Match items by target key. Preserve complete provider zero objects.
  Missing targets return typed per-target unavailable state; null/malformed
  metrics are typed contract mismatch, never zero.
- [x] Return only `DataForSeoTrafficV1` plus batch cost metadata. Raw response,
  task ID, auth, and full provider errors cannot escape the adapter.
- [x] Ignore only fields catalogued in the fixture README; additive unknowns
  cannot affect output.

### Adversarial verification

- [x] Worldwide and country fixtures normalize exactly.
- [x] NZ ordering proves association by target, not index.
- [x] Explicit all-zero record remains valid zero.
- [x] Root success plus task failure is rejected.
- [x] Missing result, null metric, wrong scalar type, negative values,
  duplicate/unexpected target, inconsistent counts, and over-1,000 request fail
  with privacy-safe typed errors.
- [x] Missing target is unavailable and never a synthesized record.
- [x] Error/log assertions contain no domain list, credentials, auth, or raw
  provider body.

### Required commands and acceptance

```bash
node --test test/dataforseo-enrichment.test.js test/config.test.js
npm run check:secrets
```

Acceptance requires source plus tests proving exact fixture paths and absence of
fallback parsing. No live-provider success claim is needed in this window.

### Handoff and stop

Create `email_scraper/review-evidence/traffic-enrichment/TE1_HANDOFF.md` with
changed files, tests/commands/outcomes, skipped checks, residual risks, and
confirmation that TE2 was not started. Then stop.

## 5. Window TE2 — CrUX REST and BigQuery strict adapters

**Status:** complete  
**Depends on:** TE1 shared error conventions  
**Objective:** Implement exact CrUX clients and normalized contracts without
pipeline or persistence integration.

### Required reading and ownership

Read the discovery CrUX sections, every CrUX fixture, current HTTP client, and
Google authentication requirements.

Own:

```text
email_scraper/src/enrichment/crux/api-request.js
email_scraper/src/enrichment/crux/api-contract.js
email_scraper/src/enrichment/crux/api-client.js
email_scraper/src/enrichment/crux/bigquery-request.js
email_scraper/src/enrichment/crux/bigquery-contract.js
email_scraper/src/enrichment/crux/bigquery-client.js
email_scraper/src/enrichment/crux/adapter.js
email_scraper/test/crux-enrichment.test.js
email_scraper/src/config.js                 # CrUX settings only
email_scraper/test/config.test.js           # matching tests only
email_scraper/package.json
email_scraper/package-lock.json
```

If a Google auth dependency is required, use the official maintained package,
pin it, and inject a token provider so deterministic tests need no ADC. Do not
add a service-account file. Do not touch Prisma, orchestration, API, or frontend.

### Ordered tasks

- [x] Add `ENABLE_CRUX_ENRICHMENT`, API key, project, location, REST concurrency,
  cache freshness, and BigQuery byte-cap config. Validate credentials only when
  CrUX is enabled.
- [x] Build one REST request for the exact validated HTTPS origin and six
  explicit metrics. Never retry an alternate origin.
- [x] Implement strict metric-specific Zod schemas: CLS decimal strings;
  LCP/INP/FCP/TTFB finite non-negative numbers; fixed form-factor fractions;
  required collection dates; named metrics optional independently.
- [x] Accept exact 404 NOT_FOUND as no coverage. Treat all other non-2xx,
  malformed success, echo mismatch, empty requested metric set, and impossible
  dates/fractions as typed failures.
- [x] Implement the exact BigQuery table-list parser. Reject pagination in v1;
  select greatest valid monthly table ID only from the exact public project,
  dataset, and table type.
- [x] Build the exact parameterized JSON-row SQL from discovery. Make dry-run
  and live request builders distinct; live requires `maximumBytesBilled`,
  `useLegacySql:false`, named parameters, bounded origins, and query caching.
- [x] Parse the exact one-field BigQuery REST schema and `rows[].f[0].v`; JSON
  decode once and strictly Zod-parse the aliased payload. Reject null, invalid
  JSON, extra/missing payload members, duplicate origins, unexpected origins,
  invalid month/rank/fractions, incomplete jobs, and response pagination not
  handled by v1.
- [x] Reconcile missing requested BigQuery rows as no coverage, never rank zero.
- [x] Return only `CruxOriginMetricsV1` and `CruxPopularityV1`.
- [x] Ensure errors/logs redact API keys, OAuth, project credentials, SQL
  parameter values/customer origins, and provider bodies.

### Adversarial verification

- [x] REST aggregate, subset, and 404 fixtures pass expected branches.
- [x] Missing one named metric normalizes only that metric unavailable.
- [x] Wrong metric-specific scalar types and malformed collection dates fail.
- [x] Exact-origin echo mismatch fails without a second request.
- [x] BigQuery table list selects `202606` from the fixture.
- [x] JSON-row fixture decodes exactly; missing requested row is no coverage.
- [x] Malformed `f/v`, invalid payload JSON, schema mismatch, duplicate origin,
  query incomplete, too-many origins, and dry-run-over-cap prevent live query.
- [x] A mocked live request is never made when dry-run bytes exceed the cap.

### Commands, acceptance, handoff

```bash
node --test test/crux-enrichment.test.js test/config.test.js
npm run check:secrets
```

Acceptance requires deterministic evidence that every consumed path comes from
fixtures and no fallback alias/origin logic exists. Record
`review-evidence/traffic-enrichment/TE2_HANDOFF.md`, confirm TE3 was not started,
and stop.

## 6. Window TE3 — Forward-only schema, cache, ledger, and repository

**Status:** complete  
**Depends on:** TE1, TE2  
**Objective:** Add durable, tenant-safe storage and paid-call/restart primitives
without invoking providers.

### Ownership

```text
email_scraper/prisma/schema.prisma
email_scraper/prisma/migrations/<new_traffic_enrichment_v1>/migration.sql
email_scraper/src/prisma-run-repository.js
email_scraper/src/api-serializer.js          # persistence mapping only
email_scraper/src/config.js                  # bounded snapshot settings only
email_scraper/.env.example                   # matching safe defaults only
email_scraper/test/prisma-run-repository.test.js
email_scraper/test/prisma-run-repository.integration.test.js
email_scraper/test/<new migration integration test>.js
email_scraper/test/config.test.js             # matching settings only
email_scraper/test/api-serializer.test.js     # persistence mapping only
```

Do not implement provider calls, orchestration, public serialization, CSV, or
frontend. Preserve all current data with a forward-only migration.

### Required schema behavior

- [x] Add nullable `Run.trafficEnrichmentConfig` and
  `Run.trafficEnrichmentSummary` JSON fields; historical rows remain valid.
- [x] Add a source enum with separate `dataforseo`, `crux_rest`, and
  `crux_bigquery` values.
- [x] Add a global normalized cache keyed by source, exact normalized identity,
  scope, metric set, and contract version. Store normalized payload only, never
  raw response.
- [x] Add per-lead published enrichment with run ID, lead ID, source, state,
  contract version, normalized payload, fetch/coverage timestamps, and unique
  `(leadId, source)` identity.
- [x] Add a DataForSEO request ledger with canonical fingerprint, target count,
  scope, state (`planned`, `in_flight`, `succeeded`, `failed`, `ambiguous`),
  attempt, safe error, cost, timestamps, and ownership/fence data.
- [x] Index expiry, source/identity/scope, run/source, and ledger state needed by
  worker recovery. Do not store credentials, raw bodies, or attributions.

### Repository lifecycle

- [x] Snapshot both flags, exact scopes, contracts, freshness, and caps in
  `runCreateData`; caller/client values cannot override them.
- [x] Add lease-guarded methods to read fresh cache, plan/claim a paid request,
  mark success with normalized cache rows, mark known failure, and mark stale
  in-flight work ambiguous.
- [x] Claiming a paid call must commit `in_flight` before returning permission to
  perform network I/O.
- [x] Recovery reuses `succeeded`; it never auto-retries `ambiguous` or stale
  `in_flight` paid work.
- [x] Extend final result publication to insert per-lead enrichment atomically
  with leads under the existing lease/fingerprint transaction.
- [x] Extend the result fingerprint to include normalized enrichment and run
  enrichment summary.
- [x] Make stable lead ID derivation shared/testable so enrichment references
  cannot drift from lead IDs.
- [x] Keep cache facts tenant-neutral and never expose cache population owner or
  timing through APIs.

### Adversarial verification

- [x] Migration replay succeeds and preserves historical runs/leads.
- [x] Old rows serialize without enrichment.
- [x] Cross-owner run/result queries cannot access enrichment.
- [x] Competing leases cannot both claim/publish the same request.
- [x] Lease loss between ledger transitions prevents stale mutation.
- [x] Crash states before call, during in-flight, after success, and before final
  publication recover as specified.
- [x] Repeated identical final publication is idempotent; changed enrichment
  conflicts.
- [x] Failure after each final write rolls the whole publication back.
- [x] No raw body/secret-shaped value is accepted into normalized columns.

### Commands, acceptance, handoff

```bash
npm run db:generate
npm run db:validate
node --test test/prisma-run-repository.test.js test/<new migration integration test>.js
npm run test:integration
npm run check:secrets
```

Integration checks require an isolated test database and must not alter user
data. Acceptance requires runtime transaction/fence evidence, not source-text
assertions. Record `review-evidence/traffic-enrichment/TE3_HANDOFF.md`, confirm
TE4 was not started, and stop.

## 7. Window TE4 — Enrichment orchestration, budgets, and recovery

**Status:** complete  
**Depends on:** TE1–TE3  
**Objective:** Connect optional providers after qualified-lead deduplication
while preserving lease, core results, budgets, and restart rules.

### Ownership

```text
email_scraper/src/enrichment/orchestrator.js
email_scraper/src/enrichment/crux/adapter.js      # staged BigQuery orchestration seam
email_scraper/src/enrichment/crux/api-client.js   # bounded safe retry policy
email_scraper/src/pipeline.js
email_scraper/src/server.js
email_scraper/src/status.js
email_scraper/src/logger.js                  # safe events only
email_scraper/src/prisma-run-repository.js    # lease-fenced TE4 lifecycle primitives
email_scraper/test/traffic-orchestration.test.js
email_scraper/test/pipeline.test.js
email_scraper/test/server.test.js
email_scraper/test/gr6-worker-lease.integration.test.js
email_scraper/test/te3-traffic-enrichment.integration.test.js
```

Do not change public API/CSV/frontend contracts in this window.

### Ordered tasks

- [x] Enter an `enriching_traffic` worker stage only after core store records are
  complete. Select only qualified records with one exact validated HTTPS origin
  and canonical DataForSEO hostname, then deduplicate.
- [x] Read only the immutable run snapshot. Never read live environment flags
  midway through a run.
- [x] When a source is disabled, do not instantiate its credential/token
  provider, read its cache, create ledger rows, call it, persist source data, or
  emit source telemetry.
- [x] Remove fresh cache hits independently by source/scope before calls.
- [x] DataForSEO: deterministically batch at 1,000, execute worldwide plus nine
  country tasks with bounded concurrency, enforce the per-run estimated/actual
  cost ceiling, ledger every call before I/O, and never auto-retry ambiguous
  paid calls.
- [x] CrUX REST: bounded concurrency below documented quota, short bounded retry
  only for safe transient network/5xx failures, cache by collection period.
- [x] CrUX BigQuery: list latest month, make one dry run, stop if over cap, then
  one parameterized batch query with cache enabled and the same byte cap.
- [x] Reconcile each provider by exact identity. Preserve available, partial,
  no-coverage, unavailable, ambiguous, and contract-mismatch states without
  fabricating values.
- [x] Provider failure adds privacy-safe diagnostics and summary counts but does
  not change lead status, score, contactability, or evidence.
- [x] Keep heartbeat active throughout calls and durable writes. Lease loss
  stops further calls and prevents final publication.
- [x] Publish accepted normalized enrichment with the core result in the TE3
  transaction. Attribution is not generated here.

### Required matrix and failure tests

- [x] Off/off: zero provider/cache/ledger calls; legacy result object unchanged.
- [x] On/off: only DataForSEO paths; no CrUX artifacts.
- [x] Off/on: only CrUX paths; no DataForSEO artifacts.
- [x] On/on: both independent; one provider failing preserves the other.
- [x] All-cache-hit run makes zero external calls.
- [x] 100 domains create at most one task per scope and stay within the expected
  10-task/$0.24 model at the probed price; actual cost is authoritative.
- [x] One country task failure yields partial DataForSEO, not whole-run failure.
- [x] CrUX REST 404 and BigQuery missing row are no coverage.
- [x] Contract drift, over-budget dry run, rate limit, timeout, and malformed
  response are controlled source failures.
- [x] Crash/restart at every ledger transition never automatically repeats an
  ambiguous paid request.
- [x] Two workers/runs contending for relevant cache/ledger state do not bypass
  lease fences or publish another tenant's data.

### Commands, acceptance, handoff

```bash
node --test test/traffic-orchestration.test.js test/pipeline.test.js test/server.test.js
npm run test:integration
npm run check:secrets
```

Acceptance requires spy-based zero-call proof and database-backed restart/fence
proof. Record `review-evidence/traffic-enrichment/TE4_HANDOFF.md`, confirm TE5
was not started, and stop.

## 8. Window TE5 — Backend API, CSV, and attribution

**Status:** complete  
**Depends on:** TE1–TE4  
**Objective:** Publish a truthful optional contract without breaking historical
or disabled runs.

### Ownership

```text
email_scraper/src/api-serializer.js
email_scraper/src/output.js
email_scraper/src/server.js                 # result response only
email_scraper/test/api-serializer.test.js
email_scraper/test/csv.test.js
email_scraper/test/server.test.js
email_scraper/README.md
email_scraper/.env.example
```

### Contract tasks

- [x] Define a versioned optional public `traffic_enrichment` object. Omit it
  completely for off/off and historical runs.
- [x] Group `crux_rest` and `crux_bigquery` under one public CrUX source while
  retaining independent coverage states internally.
- [x] Omit disabled source members. Expose only normalized accepted metrics and
  explicit enabled-source state; never expose cache, ledger, cost, provider IDs,
  raw body, or safe-error internals as lead data.
- [x] Derive worldwide search total as organic ETV plus paid ETV. Label every
  DataForSEO value as estimated Google search traffic.
- [x] Report country values for the nine exact markets. Never convert them into
  total-traffic geographic shares unless the label explicitly says share of the
  tracked Google-search scopes and the math is tested.
- [x] Describe CrUX popularity as coarse rank/band and device mix as observed
  CrUX form factors; never visits or geography.
- [x] Generate source list and attribution only from metric material actually
  serialized. No metric material means no attribution merely because enabled.
- [x] Include CrUX source/license/transformation link wherever CrUX material is
  returned/exported. Keep DataForSEO customer output disabled operationally
  until permission is recorded.
- [x] Make both backend CSV and result API reflect the four flag combinations.
  Provider-prefixed CSV columns are absent when their source was disabled, not
  blank placeholders. Formula-injection protection remains intact.
- [x] Document flags, credential prerequisites, byte/cost caps, labels, cache,
  and production enablement blockers.

### Verification

- [x] API snapshots for off/off, each single source, both, partial, no coverage,
  malformed stored enrichment, and historical rows.
- [x] Attribution exactness for every matrix case.
- [x] CSV headers and values for the same matrix; no `[object Object]`, raw JSON
  accident, formula injection, or disabled-source column.
- [x] Cross-tenant API access remains 404/not found.
- [x] Existing API clients/tests pass unchanged for off/off.

```bash
node --test test/api-serializer.test.js test/csv.test.js test/server.test.js
npm test
npm run check:secrets
```

Record `review-evidence/traffic-enrichment/TE5_HANDOFF.md`, confirm TE6 was not
started, and stop.

## 9. Window TE6 — Frontend validation, expanded display, and export

**Status:** complete  
**Depends on:** TE5  
**Objective:** Validate and show all available traffic data on owned run pages
with matching conditional export behavior.

### Mandatory frontend reading

Before editing, read `frontend/AGENTS.md` and the relevant guides under the
installed `frontend/node_modules/next/dist/docs/` because this repository's
Next.js version has breaking changes. Inspect existing test/build conventions
and current expanded lead UI before choosing components.

### Ownership

```text
frontend/lib/api-types.ts
frontend/lib/api-validation.ts
frontend/lib/csv-export.ts
frontend/components/<traffic display components>
frontend/components/run-workspace.tsx          # narrow integration only
frontend/app/globals.css                       # traffic display/responsive styles only
frontend/<matching tests>
frontend/README or handoff documentation
```

Do not change authentication, ownership, backend schemas, provider calls, or
unrelated visual design.

### Exact frontend behavior

- [x] Add strict manual validation consistent with the existing frontend
  boundary. Unknown additive traffic fields may be ignored; missing/malformed
  consumed traffic fields fail the page safely rather than becoming zero.
- [x] Preserve compatibility when `traffic_enrichment` is absent.
- [x] In the collapsed row, show at most a compact traffic signal when accepted
  material exists; do not crowd out lead score/status/contact details.
- [x] In the expanded row, show every available DataForSEO worldwide metric,
  tracked market breakdown, ranking footprints/SERP features, fetched date,
  and precise “estimated Google search traffic” label.
- [x] Show every available CrUX p75 metric, Core Web Vitals assessment derived
  from documented thresholds, collection period, popularity band/rank, and
  device fractions. Clearly state that CrUX does not provide visit totals.
- [x] Show partial/no-coverage/unavailable states without zeros or alarming
  whole-lead errors.
- [x] Render attribution only for source material present. Links open safely and
  do not imply provider endorsement.
- [x] Make client CSV use the run's enabled/included source contract. Disabled
  source columns and attribution are absent. Preserve pagination collection,
  ordering, UTF-8 BOM, escaping, and formula protection.
- [x] Keep layouts accessible and useful at narrow widths; add semantic labels
  for abbreviated metrics.

### Verification

- [x] Parser tests cover absence, both sources, partial metrics, no coverage,
  malformed nested members, wrong CLS type, and unknown additive fields.
- [x] Component tests cover collapsed/expanded render for all four flag/source
  combinations and historical leads.
- [x] CSV tests assert exact conditional headers, values, labels, attribution,
  escaping, and no disabled-source leakage.
- [x] Run the repository's documented unit, lint, type, and production build
  commands.
- [x] Perform a browser check on an owned run fixture at desktop and narrow
  viewport; record screenshots or precise evidence paths.

Acceptance requires truthful visible state, strict boundary parsing, and export
parity. Record `frontend/review-evidence/TE6_HANDOFF.md`, confirm TE7 was not
started, and stop.

## 10. Window TE7 — Parent reliability review

**Status:** review complete with one finding; corrective window TE-R1 complete  
**Depends on:** TE1–TE6 complete with handoffs  
**Objective:** Independently verify the entire lifecycle and open append-only
corrective windows for concrete findings.

### Review procedure

- [x] Inspect the complete backend/frontend diff, every migration, schema,
  provider parser, fixture provenance, and handoff. Do not rely on summaries.
- [x] Search for fallback envelopes/aliases, `any`/unsafe casts, coercion,
  alternate origin requests, raw-body logging, credential leakage, disabled
  provider reads, and unbounded concurrency/retry/pagination.
- [x] Trace run creation through snapshot, qualification, cache, paid ledger,
  calls, partial failures, lease loss, final transaction, API, UI, and both CSV
  exports.
- [x] Re-run all TE focused tests, integration tests, full backend tests, full
  frontend validation/build, Prisma validation/generation, and secret scan.
- [x] Reproduce off/off and all mixed-source cases independently.
- [x] Reproduce process death at paid-call boundaries and competing lease
  publication using database-backed tests.
- [x] Verify historical data/migration preservation without destructive commands.
- [x] Confirm actual customer-facing labels never claim total traffic, CrUX
  visits, or unmeasured country share.
- [x] Confirm attribution matches included material exactly.
- [x] Record live checks that were not rerun as unavailable evidence; fixtures
  cannot substitute for a production deployment claim.

If findings exist, add unique corrective windows `TE-R1`, `TE-R2`, and so on.
Each must state severity, violated invariant, reproduction, root cause, bounded
ownership, regression test, dependencies, and stop condition. Do not silently
rewrite completed window history.

### Completion gate

The plan is complete only when:

- all original and corrective windows have evidence-backed acceptance;
- no provider contract is guessed and no fallback probing remains;
- feature flags are false by default and disabled-source zero-call behavior is
  proven;
- paid ambiguity/restart and lease fencing are proven;
- migrations preserve old data;
- API, UI, CSV, and attribution agree;
- no unresolved finding violates a locked invariant;
- production enablement claims remain blocked until Section 3 prerequisites are
  actually satisfied.

Record the final review under
`email_scraper/review-evidence/traffic-enrichment/TE7_PARENT_REVIEW.md`.

## 10A. Window TE-R1 — Wire stale paid-request recovery

**Status:** complete  
**Severity:** high reliability; current behavior remains fail-safe against a
duplicate paid call but leaves interrupted ledger work non-terminal  
**Depends on:** TE7 finding `TE7-F1` and completed TE-R2  
**Violated invariant:** paid ambiguity/restart behavior must be proven through
the production recovery path, not only through a repository method invoked
directly by tests.

### Reproduction

- `PrismaRunRepository.markStaleDataForSeoRequestsAmbiguous()` exists and its
  isolated PostgreSQL test passes.
- The production startup and periodic recovery paths in `src/server.js` invoke
  only `recoverExpiredRuns()`.
- An independent `createLeadServer()` recovery-timer probe recorded
  `{"calls":["runs.recover"],"staleLedgerRecoveryInvoked":false}`.
- Therefore a process death after the committed `in_flight` transition can
  leave the paid ledger row in `in_flight` indefinitely. Later identical
  fingerprints remain blocked, so the defect does not authorize or cause an
  automatic duplicate paid call.

### Root cause and bounded ownership

The TE3 recovery primitive was not connected when TE4 added worker recovery.
The primitive also computes staleness from the repository process's current
configuration rather than the interrupted run's immutable policy. TE-R2 owns
the durable per-attempt ambiguity deadline; TE-R1 must consume that deadline
rather than reintroducing current-environment policy.
Own only:

```text
email_scraper/src/server.js
email_scraper/test/server.test.js
email_scraper/test/te3-traffic-enrichment.integration.test.js  # combined recovery proof only
email_scraper/review-evidence/traffic-enrichment/TE-R1_HANDOFF.md
TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md                 # status/evidence only
```

Do not change provider contracts, ledger claim semantics, retry policy,
migrations, public API, CSV, frontend, flags, or production enablement.

### Required implementation and regression proof

- [x] Add one shared recovery operation used by startup and the periodic timer.
- [x] Recover expired runs before promoting stale `in_flight` paid rows so the
  ledger predicate observes an inactive/expired run.
- [x] Select stale paid work from the durable TE-R2 ambiguity deadline. Do not
  calculate an interrupted run's deadline from the recovering process's current
  `TRAFFIC_PAID_REQUEST_STALE_MS` value.
- [x] Invoke `markStaleDataForSeoRequestsAmbiguous()` only when the repository
  supports traffic recovery, preserving test/legacy repository compatibility.
- [x] Log only safe aggregate counts; never log fingerprints, targets, domains,
  credentials, raw bodies, or ledger ownership tokens.
- [x] A server-level test must prove startup/periodic recovery invokes both
  operations in the required order and handles either failure safely.
- [x] A database-backed test must start from a committed `in_flight` ledger and
  expired lease, execute the same combined recovery seam used by the server,
  observe terminal `ambiguous`, and prove a later identical request receives
  no network permission.
- [x] Prove active, non-stale paid work is unchanged.

```bash
node --test test/server.test.js test/prisma-run-repository.test.js
ALLOW_DATABASE_TESTS=true node -r dotenv/config --test test/te3-traffic-enrichment.integration.test.js
npm test
npm run check:secrets
```

**Completion evidence (2026-08-02):** focused server/repository tests passed
37/37; the isolated PostgreSQL integration passed 2/2; the full backend suite
passed 210 with 5 database-gated skips; secret scan and `git diff --check`
passed. See
`email_scraper/review-evidence/traffic-enrichment/TE-R1_HANDOFF.md`.

Acceptance requires runtime production-path wiring plus isolated PostgreSQL
evidence. Record `TE-R1_HANDOFF.md`, then return to TE7 for the focused rerun
and final completion decision. Stop without starting any production enablement.

## 10B. Independent post-TE7 review addendum

**Reviewed:** 2026-08-02  
**Disposition:** TE7's completion disposition remains false; TE-R1 plus new
corrective windows TE-R2 through TE-R5 are required.  
**Evidence boundary:** current source, deterministic probes, complete backend
and frontend tests, isolated PostgreSQL integration tests, Prisma validation,
frontend production build, and secret scan. No live provider or production
database call was made.

### Reliably retained behavior

- Exact fixture-backed provider envelopes and Zod parsing remain in place; no
  fallback root/alias or alternate CrUX origin probing was found.
- Both source flags remain false by default, and off/off makes zero
  provider/cache/ledger/source-telemetry calls.
- The forward-only migration, historical-row preservation, cache and ledger
  lease fences, tenant isolation, and atomic final publication passed isolated
  PostgreSQL tests.
- Normal valid flows retain truthful DataForSEO/CrUX labels, source-gated API
  fields, frontend display, client CSV, and material-derived attribution.

### New findings

#### TE8-F1 — ambiguous paid calls bypass the run cost ceiling

**Severity:** critical financial reliability  
**Reproduction:** with a `$0.05` run cap and `$0.024` estimated task cost, a
controlled orchestrator probe returning an ambiguous result for every call
made all ten DataForSEO scope calls. The summary reported zero actual cost and
`budgetStopped:false`.  
**Root cause:** `src/enrichment/orchestrator.js` checks confirmed cost plus one
estimate before a call, but it never retains the estimate for an `in_flight` or
`ambiguous` paid attempt. Only a successfully parsed response increments cost.
**Owner:** TE-R2.

#### TE8-F2 — post-dispatch contract drift can be paid twice

**Severity:** high financial reliability  
**Reproduction:** DataForSEO `provider_contract_mismatch` is sent through
`markDataForSeoRequestFailed()`. `planDataForSeoRequest()` permits every
`failed` fingerprint to be assigned to a later run. A malformed/truncated HTTP
200 response or response-size failure can occur after the provider accepted
and charged the request, so the later retry can duplicate a charge.  
**Root cause:** the paid ledger conflates proven zero-cost/pre-dispatch failures
with post-dispatch outcomes whose charge cannot be proved.  
**Owner:** TE-R2.

#### TE8-F3 — recovery uses current configuration, not immutable attempt policy

**Severity:** medium recovery correctness  
**Reproduction:** `trafficEnrichmentConfigSnapshot()` stores
`paidRequestStaleMs`, but `markStaleDataForSeoRequestsAmbiguous()` subtracts the
repository instance's current configuration from the recovery clock. A restart
with changed environment values can promote the old attempt earlier or later
than its run contract.  
**Owner:** TE-R2 establishes a durable deadline; TE-R1 wires it.

#### TE8-F4 — normalized storage accepts semantically impossible material

**Severity:** medium data integrity  
**Reproduction:** direct deterministic calls to the current persistence mapper
accepted duplicate DataForSEO scopes, a noncanonical target, CrUX origin
`http://fixture.example/path`, dataset month `202613`, and device fractions
summing to three. An unsupported `ZZ` DataForSEO market then serialized an
attribution and source name while serializing no traffic metric.  
**Root cause:** storage Zod schemas validate scalar shape but do not enforce the
provider adapter's cross-field identity, scope, month, fraction-sum, uniqueness,
or same-origin invariants. Public material detection counts parsed-but-dropped
country records.  
**Owner:** TE-R3.

#### TE8-F5 — the foreground backend CSV command silently omits enrichment

**Severity:** medium contract truthfulness  
**Reproduction:** `runOnce()` passes `runPipeline()` leads directly to
`writeOutput()`. With both traffic flags true, a controlled run wrote one core
lead with no `traffic_enrichment` field and made no enrichment call. The CSV
formatter supports already-public traffic objects, but the supported foreground
command never creates them.  
**Root cause:** TE5 tested the formatter using synthetic public enrichment but
did not connect or explicitly exclude the legacy command. Safe paid enrichment
cannot be added to that command without its durable ledger/recovery boundary.
**Owner:** TE-R4.

#### TE8-F6 — date-only CrUX collection dates are timezone-shifted in the UI

**Severity:** low display truthfulness  
**Reproduction:** `new Date("YYYY-MM-DD")` represents UTC midnight, then
`Intl.DateTimeFormat` renders in the browser timezone. Users west of UTC can see
the previous calendar date.  
**Owner:** TE-R3.

#### TE8-F7 — current implementation trees are not tracked

**Severity:** release blocker  
**Reproduction:** `git status --short` reports `email_scraper/`, `frontend/`,
the authoritative traffic documents, and shared contracts as untracked while
the former `Email Scrapper/` tree appears deleted. Ordinary `git diff` therefore
cannot represent or deploy the implementation reliably.  
**Owner:** parent prerequisite before TE-R2 and final gate in TE-R5. Fresh
implementation agents must not perform a repository-wide add, commit, rename,
or deletion unless the parent/user explicitly assigns it.

## 10C. Window TE-R2 — Paid-call safety, budget exposure, and durable deadline

**Status:** complete  
**Severity:** critical financial reliability  
**Depends on:** TE1–TE7 source and evidence; findings `TE8-F1`, `TE8-F2`, and
`TE8-F3`  
**Objective:** Ensure every possibly charged DataForSEO attempt consumes durable
budget exposure and can never become automatically retryable merely because its
response could not be accepted.

### Preconditions and required reading

- Read the complete authoritative discovery record, TE1/TE3/TE4 handoffs, TE7
  review, this addendum, and every DataForSEO fixture/fixture README.
- Inspect the current migration chain, schema, repository paid state machine,
  DataForSEO client/adapter, orchestrator, and focused/integration tests.
- Confirm both provider flags remain false.
- Confirm the current renamed implementation has a parent-approved tracked
  baseline or record `TE8-F7` as an exact blocker and stop before editing.
- No live/paid provider request is authorized in this window.

### Ownership and non-goals

Own only:

```text
email_scraper/prisma/schema.prisma
email_scraper/prisma/migrations/<new_forward_only_paid_safety_migration>/migration.sql
email_scraper/src/enrichment/errors.js
email_scraper/src/enrichment/dataforseo/client.js
email_scraper/src/enrichment/dataforseo/contract.js
email_scraper/src/enrichment/orchestrator.js
email_scraper/src/prisma-run-repository.js
email_scraper/test/dataforseo-enrichment.test.js
email_scraper/test/traffic-orchestration.test.js
email_scraper/test/prisma-run-repository.test.js
email_scraper/test/te3-traffic-enrichment.integration.test.js
email_scraper/test/gr4-migration.integration.test.js
email_scraper/review-evidence/traffic-enrichment/TE-R2_HANDOFF.md
```

Do not change API/UI/CSV contracts, CrUX behavior, authentication, provider
flags, country scopes, pricing claims, or production enablement. Do not edit the
existing traffic migration; add one forward-only migration.

### Locked paid-attempt contract

- [x] Give every network-authorized attempt a durable conservative reservation
  committed no later than the `in_flight` transition and a durable
  `ambiguousAfter` deadline derived from that run's immutable policy.
- [x] Define run exposure as confirmed provider cost for succeeded attempts plus
  conservative reservation for every `in_flight` or `ambiguous` attempt owned
  by the run. A succeeded attempt replaces, rather than adds to, its reservation.
- [x] Before every claim, atomically prove that existing exposure plus the new
  reservation does not exceed the immutable run cap. A check performed only in
  JavaScript before a separate claim is insufficient.
- [x] If actual returned cost exceeds its estimate, record the actual cost and
  prohibit later calls once the cap is met/exceeded. Never falsify or clamp the
  provider-reported value.
- [x] Treat network/timeout/abort, HTTP response truncation or size-limit, invalid
  JSON, response-contract mismatch, and any other post-dispatch outcome whose
  zero cost is not proven as terminal `ambiguous` paid work.
- [x] A strictly parsed captured provider rejection may become retryable
  `failed` only when the accepted response contract proves request cost is zero.
  Configuration/request-builder errors known to occur before dispatch may be
  non-paid failures. Do not infer zero cost from HTTP status alone.
- [x] A later run must never receive network permission for an `ambiguous`
  fingerprint. Preserve the current explicit succeeded-cache refresh contract.
- [x] Keep logs/errors free of credentials, fingerprints, targets, domains, raw
  bodies, authorization, and customer lead lists.

### Migration and preservation requirements

- [x] Add only nullable/default-safe fields required for reservation and durable
  deadline semantics; preserve all historical runs, leads, cache, and ledger
  rows.
- [x] Define conservative behavior for legacy `in_flight` rows lacking a new
  deadline: they must remain financially fail-safe and become recoverable
  without becoming retryable.
- [x] Index the actual recovery/budget predicates and prove migration replay.
- [x] Keep decimal money storage; do not use binary floating-point columns.

### Adversarial verification

- [x] Reproduce the `$0.05`/`$0.024` all-ambiguous probe: at most two calls may
  receive network permission, remaining scopes are unavailable/budget-stopped,
  and durable exposure is at least `$0.048`.
- [x] Repeat with contract mismatch, response-size failure, timeout, invalid
  JSON, and lease loss after claim. None may reopen the fingerprint.
- [x] Prove exact zero-cost captured rejection is retryable only under the
  locked rule and does not consume paid exposure.
- [x] Prove two workers cannot both reserve/claim past the same run cap.
- [x] Prove success atomically replaces reservation with actual cost and cache;
  failure after every durable step preserves a truthful recoverable state.
- [x] Prove old migrations replay and historical rows remain unchanged.

### Commands and acceptance

```bash
npm run db:generate
npm run db:validate
node --test test/dataforseo-enrichment.test.js test/traffic-orchestration.test.js test/prisma-run-repository.test.js
ALLOW_DATABASE_TESTS=true node -r dotenv/config --test test/te3-traffic-enrichment.integration.test.js
ALLOW_DATABASE_TESTS=true npm run test:integration
npm test
npm run check:secrets
```

Acceptance requires runtime database evidence for atomic exposure/claim,
competing workers, crash boundaries, migration preservation, and terminal
non-retry of every possibly charged outcome. Source inspection or a memory-only
repository is not sufficient. Record exact commands, outcomes, evidence,
changed files, residual risks, and confirmation that TE-R1 was not started in
`TE-R2_HANDOFF.md`; then stop.

## 10D. Window TE-R3 — Normalized semantic integrity and truthful rendering

**Status:** complete  
**Severity:** medium data integrity plus low display correctness  
**Depends on:** completed TE-R2 and TE-R1  
**Objective:** Make persistence, public serialization, frontend validation,
attribution, both CSV projections, and date rendering agree on one strict
semantic contract.

### Required reading and ownership

Read the discovery normalized/public contracts, TE3/TE5/TE6 handoffs, current
provider normalizers, persistence mappers, serializers, CSV paths, and frontend
traffic tests. Before frontend edits, read `frontend/AGENTS.md` completely and
the relevant installed Next.js guides it requires.

Own only:

```text
email_scraper/src/api-serializer.js
email_scraper/src/output.js                         # parity/validation only
email_scraper/test/api-serializer.test.js
email_scraper/test/csv.test.js
email_scraper/test/prisma-run-repository.test.js    # mapper boundary only
frontend/lib/api-types.ts                           # only if contract needs tightening
frontend/lib/api-validation.ts
frontend/lib/csv-export.ts                          # parity only
frontend/components/traffic-enrichment.tsx
frontend/test/api-validation.test.ts
frontend/test/csv-export.test.ts
frontend/test/lead-details-component.test.ts
frontend/review-evidence/TE-R3_HANDOFF.md
```

Do not alter provider request/response contracts, database schema, orchestration,
auth, ownership, visual design outside traffic, flags, or production gates.

### Locked semantic invariants

- [x] Reuse or exactly mirror the provider canonicalizers at the normalized
  boundary: DataForSEO targets are canonical ASCII hostnames without `www`;
  CrUX origins are exact canonical HTTPS origins with no path, credentials,
  query, fragment, Unicode ambiguity, or alternate-origin fallback.
- [x] DataForSEO country scope must be one of the nine exact ISO/location-code
  pairs. Published records must use one target, contain no duplicate scope, and
  contain at most the worldwide scope plus those nine markets.
- [x] CrUX dataset month must be a real `YYYYMM`; collection dates must be real
  and ordered; device/form-factor fractions must each be in `[0,1]` and sum to
  one within the captured `0.01` tolerance.
- [x] Available CrUX REST material must contain at least one accepted metric or
  a complete form-factor object. Combined REST and popularity material for a
  lead must refer to the same exact origin.
- [x] Stored state, payload presence, contract version, fetched/coverage times,
  identity, and scope must agree. Malformed stored material fails closed to
  public unavailable/no material without exposing raw content or breaking core
  lead fields.
- [x] Material detection must inspect metrics actually serialized. Unsupported,
  duplicate, or dropped records must never create `traffic_sources` or
  attribution.
- [x] Frontend validation independently enforces the public cross-field contract
  and continues ignoring documented unknown additive fields.
- [x] Render `YYYY-MM-DD` collection dates as calendar dates without browser
  timezone shifting. Timestamp display may remain locale-aware.
- [x] Backend and client CSV remain column/value/attribution equivalent for
  valid, zero, partial, no-coverage, unavailable, and malformed cases.

### Adversarial verification

- [x] Convert every `TE8-F4` reproduction into a failing-before/fixed-after
  regression: duplicate scopes, different targets, `ZZ`/wrong location pair,
  invalid month, HTTP/path CrUX origin, different component origins, empty
  available material, invalid fraction sum, and reversed dates.
- [x] Prove unsupported/dropped material yields no source attribution and no
  provider CSV columns caused solely by that material.
- [x] Prove numeric provider zero remains visible and missing remains absent.
- [x] Run the date-only renderer under at least one timezone west of UTC and one
  east of UTC and prove the same calendar date is shown.
- [x] Preserve historical/off-off behavior and the four source combinations.

### Commands and acceptance

```bash
cd email_scraper
node --test test/api-serializer.test.js test/csv.test.js test/prisma-run-repository.test.js test/server.test.js
npm test
npm run check:secrets

cd ../frontend
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Acceptance requires backend persistence/public regressions plus independent
frontend/parser/CSV/date evidence. Record exact commands, outcomes, changed
files, browser evidence if visible output changed, residual risks, and
confirmation that TE-R4 was not started in `frontend/review-evidence/TE-R3_HANDOFF.md`;
then stop.

**Completion evidence (2026-08-02):** backend full suite passed 214 with 5
database-gated skips; frontend passed 34/34 tests plus lint, TypeScript, and the
Next.js production build; secret scan, `git diff --check`, and east/west
headless-Chrome date checks passed. Backend commit `b250dab`; frontend commit
`c825c04`. See `frontend/review-evidence/TE-R3_HANDOFF.md`.

## 10E. Window TE-R4 — Foreground CSV boundary and documentation truthfulness

**Status:** complete  
**Severity:** medium contract truthfulness  
**Depends on:** completed TE-R3  
**Objective:** Prevent the supported foreground CSV command from silently
claiming traffic-enabled behavior without the durable paid-call safety boundary.

### Locked v1 decision

Traffic enrichment remains a durable asynchronous-server capability. The legacy
`npm run run:once` command is not authorized to invoke DataForSEO, CrUX, cache,
or paid-ledger methods. If either traffic flag is enabled, `runOnce()` must fail
before starting the pipeline or writing output with a safe actionable message
directing the operator to the durable server flow. With both flags false, its
existing CSV behavior remains unchanged.

The backend CSV formatter may continue to project already-serialized public
traffic leads for deterministic export/testing, but documentation must not imply
that `run:once` itself produces traffic enrichment. Adding standalone paid
provider calls or an in-memory ledger is prohibited.

### Ownership

```text
email_scraper/src/run-once.js
email_scraper/src/output.js                    # only if boundary validation is needed
email_scraper/test/run-once.test.js
email_scraper/test/csv.test.js
email_scraper/README.md
email_scraper/review-evidence/traffic-enrichment/TE-R4_HANDOFF.md
```

Do not add a new API endpoint, provider call, database workflow, migration,
frontend change, or deployment mechanism.

### Required implementation and tests

- [x] Reject each single-source-on and both-sources-on foreground combination
  before pipeline, output writer, credential provider, or network interaction.
- [x] Preserve off/off foreground behavior and existing CSV atomic-write and
  formula-protection behavior.
- [x] Keep `output.js` traffic projection tests using strictly accepted public
  material; malformed material must not produce misleading attribution.
- [x] Update README/configuration language to distinguish durable server result
  enrichment, client CSV download, backend formatter capability, and legacy
  off/off `run:once` output.

```bash
node --test test/run-once.test.js test/csv.test.js test/config.test.js
npm test
npm run check:secrets
```

Acceptance requires spy-based proof of zero pipeline/writer/provider interaction
for all traffic-enabled foreground cases and unchanged off/off output. Record
the handoff and confirm TE-R5 was not started; then stop.

## 10F. Window TE-R5 — Corrective parent reliability review

**Status:** review complete — TE-R6 corrective verification required  
**Severity:** completion gate  
**Depends on:** TE-R2, TE-R1, TE-R3, and TE-R4 complete with handoffs  
**Objective:** Independently prove that all original and corrective invariants
hold in the actual production seams and decide whether local implementation is
complete.

### Parent-only review procedure

- [x] Inspect current source and the complete tracked diff; do not rely on
  handoff summaries. If the renamed implementation/documents/contracts remain
  untracked or the old tree's deletion is unresolved, retain `TE8-F7` as a
  release blocker. Do not commit or stage repository-wide changes without the
  user's authority.
- [x] Trace the paid lifecycle from immutable run snapshot through atomic
  reservation/claim, every dispatch outcome, actual-cost replacement, cap
  exhaustion, stale deadline, startup/periodic recovery, cache success, lease
  loss, final publication, and cross-run fingerprint reuse.
- [x] Reproduce the original `$0.05` all-ambiguous ten-scope failure unchanged
  and prove the corrected bound. Reproduce contract drift, invalid JSON,
  response-size failure, timeout, and process death; none may permit an unsafe
  retry or understate durable exposure.
- [x] Execute the shared production recovery seam against isolated PostgreSQL;
  prove expired-before-ledger ordering, deadline correctness across changed
  process configuration, active-work preservation, and terminal ambiguity.
- [x] Re-run every semantic corruption from TE8-F4 through persistence, API,
  backend CSV, frontend parser, UI, and client CSV. Confirm fail-closed behavior
  and exact attribution.
- [x] Reproduce all four foreground flag combinations and verify the locked
  TE-R4 boundary.
- [x] Recheck fallback probing, raw-body/secret leakage, owner isolation,
  disabled-source zero-call behavior, migration replay/data preservation,
  bounded concurrency/retry/pagination, truthful labels, and timezone-stable
  dates.
- [x] Review tests for mock shortcuts. Database/concurrency claims require
  isolated PostgreSQL evidence; UI claims require component/browser evidence;
  external production claims remain limited to what was actually run.

### Required verification

```bash
cd email_scraper
npm run db:generate
npm run db:validate
npm test
ALLOW_DATABASE_TESTS=true npm run test:integration
npm run check:secrets

cd ../frontend
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Also run focused tests from every corrective handoff unchanged. Record skipped
checks and exact reasons. No live provider request is part of deterministic
acceptance; if a live check is later authorized, record cost, public-only
targets, sanitized evidence, and its limited claim separately.

### Completion gate and handoff

The parent may mark local implementation complete only when:

- paid exposure cannot exceed the configured authorization through ambiguous or
  malformed-response branches;
- no possibly charged fingerprint becomes automatically retryable;
- production startup and periodic recovery consume durable attempt deadlines;
- normalized/public/frontend/CSV semantics and attribution agree;
- foreground CSV behavior is explicit and fail-safe;
- original migrations replay and historical data are preserved;
- both flags remain false by default;
- no unresolved code finding violates an invariant; and
- repository tracking state is safe for the intended deployment mechanism.

Create
`email_scraper/review-evidence/traffic-enrichment/TE-R5_PARENT_REVIEW.md`.
If a concrete finding remains, open the next append-only window `TE-R6`; do not
silently fix it during review. Production enablement remains separately blocked
on Section 3 prerequisites.

## 10G. Window TE-R6 — Restore PostgreSQL semantic publication coverage

**Status:** complete  
**Severity:** completion-gate verification defect  
**Depends on:** TE-R5 parent review finding `TE-R5-F1`  
**Objective:** Bring the existing TE3 PostgreSQL publication fixture into the
locked TE-R3 semantic contract and restore complete isolated-database evidence
without weakening production validation.

### Finding TE-R5-F1

The unchanged focused and full isolated PostgreSQL runs fail at
`test/te3-traffic-enrichment.integration.test.js:286`. The fixture publishes
one worldwide DataForSEO record while declaring the lead-level source state
`available`. TE-R3 correctly requires `available` to contain all ten configured
scopes; one accepted scope is `partial`. Production code therefore fails closed
with `Published DataForSEO state does not match its scopes` before the test can
exercise final publication, replay, tenancy, later paid-cap, recovery, and
rollback assertions.

This is a stale integration fixture and verification gap, not evidence that
production accepted corrupt material. TE-R5 must not change it during review.

### Ownership and non-goals

Own only:

```text
email_scraper/test/te3-traffic-enrichment.integration.test.js
email_scraper/review-evidence/traffic-enrichment/TE-R6_HANDOFF.md
TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md  # status/evidence only
```

Do not weaken `src/api-serializer.js`, change provider or persistence contracts,
alter migrations, enable providers, make live calls, or resolve parent
repository tracking finding `TE8-F7`.

### Required correction and verification

- [x] Represent the recovered worldwide-only publication as DataForSEO
  `partial`, including a truthful matching summary, or construct all ten exact
  configured scope records if the fixture intends to claim `available`.
- [x] Assert the committed publication state and owner isolation after the
  corrected write; preserve the idempotent replay assertion.
- [x] Run the complete TE3 integration entrypoint so every assertion after the
  former failure executes, including atomic paid exposure, actual-cost
  replacement, durable deadline recovery, legacy recovery, rollback stages,
  migration replay, and historical preservation.
- [x] Run the full isolated integration suite and all backend regressions.
- [x] Confirm both flags remain false and secret/diff hygiene passes.

```bash
cd email_scraper
ALLOW_DATABASE_TESTS=true node -r dotenv/config --test test/te3-traffic-enrichment.integration.test.js
ALLOW_DATABASE_TESTS=true npm run test:integration
npm test
npm run check:secrets
git diff --check
```

Acceptance requires both TE3 PostgreSQL tests and all five integration
entrypoints to pass with no database-gated skip in the explicit integration
run. Record `TE-R6_HANDOFF.md`, then return to an independent parent review for
the completion decision. `TE8-F7` and Section 3 production prerequisites remain
separate gates.

**Completion evidence (2026-08-02):** both stale worldwide-only publication
fixtures now use the truthful `partial` state; the committed state and owner
isolation are asserted. The focused TE3 PostgreSQL entrypoint passed 2/2 and
the complete isolated integration corpus passed 5/5 with no skip. The full
backend suite passed 218/218 runnable tests with five database-gated copies
intentionally skipped because the explicit database run had already passed.
Prisma generation/validation, secret scanning, disabled-by-default flag tests,
and diff hygiene passed. See
`email_scraper/review-evidence/traffic-enrichment/TE-R6_HANDOFF.md` and
`email_scraper/review-evidence/traffic-enrichment/TE-R6_PARENT_COMPLETION_REVIEW.md`.

## 10H. Post-TE-R6 parent completion review

**Status:** complete for local implementation and user testing  
**Production enablement:** not granted  

The parent review re-inspected the TE-R6-only diff, reran its focused database
entrypoint, the complete isolated PostgreSQL corpus, all backend regressions,
Prisma validation, secret scanning, and diff hygiene. No production validator,
provider contract, migration, flag, or runtime path changed. All original and
corrective implementation gaps are closed for local testing.

Finding `TE8-F7` remains an outer-repository release decision, not a runtime
traffic-enrichment defect: the nested backend/frontend repositories are clean
and independently tracked, while the outer repository still represents the
rename as deleted old content plus untracked replacement roots. Section 3 legal,
credential, attribution, price, quota, and byte-cap prerequisites also remain
mandatory before production enablement. No live provider or production database
operation was performed during closure.

## 11. Planning readiness result

Corrective implementation readiness: **YES, subject to the tracked-baseline
precondition in TE-R2**.

- One authoritative discovery record exists.
- Parser-sensitive request/response paths have official and captured evidence.
- Normalized contracts and extension policy are defined.
- Transaction, cache, paid ambiguity, budget exposure, lease, restart, and
  partial-failure corrections are assigned.
- Ownership and dependencies are sequential and explicit.
- Every invariant maps to deterministic tests and final review.
- External production prerequisites are separated from local acceptance.

No implementation window is authorized to expand scope or make a new provider
contract based on intuition. If a captured fixture contradicts live behavior,
stop that window and return the contract decision to the parent. Fresh agents
must execute exactly one assigned corrective window, update only that window's
evidence/status, and stop without beginning the next window or claiming final
verification.
