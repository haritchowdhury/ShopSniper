# TE3 Handoff — Forward-Only Storage, Cache, Ledger, and Repository

**Window:** TE3  
**Status:** implementation and verification complete; ready for parent review  
**Completed:** 2026-08-02  
**Production enablement:** not claimed; both enrichment flags remain false

## Outcome

Implemented the forward-only traffic-enrichment persistence boundary and
lease-fenced repository lifecycle without invoking a provider. Runs now retain
an immutable server-owned enrichment policy snapshot. Normalized cache facts,
per-lead published enrichment, and DataForSEO paid-request state are stored in
separate durable models.

The paid-request ledger commits `in_flight` before returning network
permission. Succeeded requests and normalized cache rows commit atomically.
Stale in-flight paid work becomes `ambiguous` and cannot be automatically
claimed again. A crash while still `planned` remains safe to reassign, and a
crash after success but before publication reuses the durable success/cache.

## Changed files

- `prisma/schema.prisma`
- `prisma/migrations/20260802090000_traffic_enrichment_v1/migration.sql`
- `src/prisma-run-repository.js`
- `src/api-serializer.js` — persistence mapping only; public serialization is unchanged
- `src/config.js` — bounded traffic persistence settings only
- `.env.example` — matching disabled/safe defaults
- `test/prisma-run-repository.test.js`
- `test/te3-traffic-enrichment.integration.test.js`
- `test/gr4-migration.integration.test.js` — final-transaction test harness supports the new child model
- `test/api-serializer.test.js`
- `test/config.test.js`
- `../TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md` — TE3 ownership, status, and checks only
- `review-evidence/traffic-enrichment/TE3_HANDOFF.md`

No provider adapter, pipeline, worker orchestration, public API shape, CSV,
frontend, Prisma dependency, or provider fixture was changed.

## Locked storage and policy contracts

- DataForSEO success/zero freshness: 2,592,000,000 ms (30 days).
- Explicit no-coverage freshness: 86,400,000 ms (24 hours).
- Default DataForSEO per-run cost cap: USD 2.00.
- Paid in-flight stale threshold: 900,000 ms (15 minutes).
- CrUX REST freshness remains 86,400,000 ms.
- CrUX BigQuery maximum bytes billed remains 10,000,000,000.
- DataForSEO request fingerprints are globally unique.
- Cache states: `available`, `no_coverage`.
- Published states: `available`, `partial`, `no_coverage`, `unavailable`,
  `ambiguous`, `contract_mismatch`.
- Ledger states: `planned`, `in_flight`, `succeeded`, `failed`, `ambiguous`.
- Sources remain separate internally: `dataforseo`, `crux_rest`,
  `crux_bigquery`.

The run snapshot pins both flags, worldwide plus nine DataForSEO country
scopes, normalized and response contract versions, metric sets, target/origin
limits, freshness, concurrency, cost cap, BigQuery location, and byte cap. It
contains no credential, API key, password, billing project, target, or origin.

## Schema and repository behavior

- Historical `Run` rows keep nullable enrichment config and summary.
- Historical `Lead` rows require no enrichment row or rewrite.
- Cache uniqueness covers source, normalized identity, canonical scope key,
  metric-set key, and contract version.
- Per-lead enrichment is unique on `(leadId, source)`.
- A composite foreign key proves that `leadId` belongs to the stored `runId`.
- DataForSEO cost uses `DECIMAL(18,8)` rather than floating storage.
- Cache lookup, paid planning/claiming, success, and known failure require the
  active run lease fence.
- Stale recovery selects only old in-flight ledger rows whose run is no longer
  actively leased.
- Known failures store only fixed allowlisted safe messages.
- Cache and published payloads are strictly source/version validated; raw or
  additive envelopes are rejected.
- Stable lead ID derivation is exported and used by both lead and enrichment
  persistence.
- Final fingerprints include normalized enrichment and the run enrichment
  summary, with timestamps canonicalized as ISO strings.
- Leads, enrichment, audits, diagnostics, and terminal run state publish in one
  transaction.
- Public serializers do not expose cache rows, ledger state, cache ownership,
  cache timing, cost, or enrichment yet.

## PostgreSQL runtime evidence

The integration suite used the configured `TEST_DATABASE_URL`. Every test
created a unique temporary schema, deployed migrations, and dropped only that
schema afterward.

TE3 evidence:

```text
historicalRowsPreserved: 2
migrationReplay: passed
paidClaimWinners: 1
cacheAndLedgerAtomic: true
plannedBeforeCallRecovered: true
successBeforePublicationRecovered: true
ambiguousPaidRetryBlocked: true
tenantIsolation: true
terminalReplay: true
rollbackStages: 9
crossRunReferenceRejected: true
```

The nine injected final-write failures cover the run publication gate,
enrichment deletion, lead deletion, audit deletion, diagnostic deletion, lead
creation, enrichment creation, audit creation, and diagnostic creation. Every
failure preserved the running state and all sentinel child rows.

## Commands and outcomes

From `email_scraper/`:

```text
npm run db:generate
PASS — Prisma Client 6.19.3 generated

npm run db:validate
PASS — schema valid

node --test test/config.test.js test/api-serializer.test.js test/prisma-run-repository.test.js test/te3-traffic-enrichment.integration.test.js
PASS — focused source tests; integration file skipped without its explicit database gate

ALLOW_DATABASE_TESTS=true node -r dotenv/config test/te3-traffic-enrichment.integration.test.js
PASS — 1 passed, 0 failed, 0 skipped on isolated PostgreSQL

ALLOW_DATABASE_TESTS=true npm run test:integration
PASS — 4 passed, 0 failed, 0 skipped on isolated PostgreSQL

npm test
PASS — 187 tests, 183 passed, 0 failed, 4 integration-gated skips

npm run check:secrets
PASS — no credential-shaped assignments found

git diff --check
PASS
```

The ordinary sandboxed full suite could not bind local HTTP test servers. The
same final-source suite passed with local bind permission. The four skips in
ordinary `npm test` are the explicitly gated PostgreSQL tests; all four passed
separately with the database gate enabled.

## Residual risks and deferred work

- The USD 2.00 default is a conservative v1 policy choice and remains subject
  to the production price/quota review already required by the master checklist.
- DataForSEO budget calculation/enforcement across batches belongs to TE4; TE3
  stores the immutable cap and exact paid costs.
- CrUX collection-period/month-aware orchestration and cache expiry selection
  belong to TE4; TE3 supplies strict canonical storage primitives.
- Public materialization, attribution, API serialization, CSV, and frontend
  rendering remain TE5/TE6 work.
- No live DataForSEO, CrUX REST, or BigQuery request was made.

## Stop confirmation

TE4 was not started. Both `ENABLE_DATAFORSEO_ENRICHMENT` and
`ENABLE_CRUX_ENRICHMENT` remain false by default.
