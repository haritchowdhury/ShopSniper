# G-R4 handoff — Durable v2 semantics, admission, and migration proof

Status: **COMPLETE**

Date: 2026-08-01

## Outcome

G-R4 restores corrective invariants C7-C8. Fractional query scores and exact
primary intent are now durable, all new v2 lead outcomes have truthful scoring
semantics, direct and intent-claim entry share one capacity reservation, and
terminal publication is state-conditional and idempotent only for an identical
durable payload.

The forward migration is:

```text
20260801000000_gr4_durable_v2
```

It changes `Lead.queryScore` from PostgreSQL `INTEGER` to `DOUBLE PRECISION`, adds
nullable `Lead.originalShopType`, and adds nullable `Run.resultFingerprint`. It
contains no data update, deletion, table drop, or historical classification.

## Contracts established

### Durable and API semantics

- Prisma `Lead.queryScore` is `Float?`; PostgreSQL uses `DOUBLE PRECISION` and
  preserves existing integer values through an explicit cast.
- `Lead.originalShopType` is nullable for historical compatibility and maps to
  `original_shop_type` in repository records, JSON responses, and the final
  append-only lead CSV column.
- New qualified, rejected, and failed lead records carry pipeline/scoring version
  2. Mandatory-gate failures retain null `leadScore` and `scoreBreakdown`.
- A genuinely unversioned historical lead serializes as `legacy_v1`; a v2 lead
  with no score serializes as `not_scored_v2`; a scored v2 lead serializes as
  `evidence_rank_v2`.
- G-R3 occurrence, fit, matched-category, and query-audit JSON provenance remains
  unchanged and round-trips through the repository contract.

### Admission

- One serialized admission operation protects both `POST /api/runs` and
  `POST /api/run-intents/:id/claim` within a server instance.
- Capacity is reserved before asynchronous persistence and released when creation
  fails or an existing intent claim is replayed.
- A claim without capacity may replay its already-created run but cannot create a
  new queued run. Simultaneous direct/claim and claim/claim tests prove the shared
  limit and one-create behavior.
- Cross-instance admission and worker lease fencing remain assigned to G-R6.

### Terminal publication

- `saveCompletedResults` first conditionally transitions a queued/running run in
  the same transaction that replaces children and publishes the summary.
- The transaction stores a canonical SHA-256 payload fingerprint. An identical
  replay returns the published run without rewriting children; a different replay
  raises a terminal conflict.
- Failed terminal writes roll back the conditional state transition and every
  child mutation. `markFailed` is also conditional on a non-terminal state and
  records run-level v2 versions.

## Disposable-database evidence

Only the user-designated `TEST_DATABASE_URL` was used. Tests created uniquely
named temporary schemas, applied the three pre-G-R4 migrations, inserted synthetic
legacy and pre-correction fixtures, applied G-R4, replayed migration deployment,
and dropped the temporary schemas during cleanup. No connection string or user
data was logged or stored.

Sanitized preservation evidence:

| Measure | Before G-R4 | After G-R4 |
| --- | ---: | ---: |
| Runs | 2 | 2 |
| Leads | 2 | 2 |

The fixtures preserved IDs, owners, legacy/unversioned nulls, a pre-correction v2
null score, and the historical integer query score `82`. Fresh values `82.29`,
`82.0`, `0`, and `100` round-tripped through Prisma; JSON serialization preserved
their numeric meaning. `originalShopType` round-tripped as a typed field.

Rollback was injected after each of these real transaction stages:

- conditional run update;
- lead deletion;
- lead insertion;
- query-audit insertion;
- diagnostic insertion.

Each failure preserved the running state and all sentinel child rows. A final
publication succeeded, an identical replay was idempotent, a differing replay was
rejected, and a foreign-owner result query returned no rows.

## Changed files

Runtime and schema:

- `prisma/schema.prisma`
- `prisma/migrations/20260801000000_gr4_durable_v2/migration.sql`
- `src/api-errors.js`
- `src/api-serializer.js`
- `src/output.js`
- `src/pipeline.js`
- `src/prisma-client.js`
- `src/prisma-run-repository.js`
- `src/server.js`
- `package.json`

Tests:

- `test/api-serializer.test.js`
- `test/csv.test.js`
- `test/gr4-migration.integration.test.js`
- `test/pipeline.test.js`
- `test/prisma-run-repository.integration.test.js`
- `test/prisma-run-repository.test.js`
- `test/server.test.js`

Tracking:

- `review-evidence/G-R4_HANDOFF.md`
- `../PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` (G-R4 status/evidence only)

No frontend, provider, storefront-fit, score-weight, worker-lease, deployment, or
production/live database behavior was changed.

## Verification

Executed from `/home/harit/Email Scrapper/email_scraper`:

```text
npx prisma format
PASS (exit 0)

npx prisma validate
PASS — schema is valid (exit 0)

ALLOW_DATABASE_TESTS=true npm run test:integration
2 tests: 2 passed, 0 failed, 0 skipped (exit 0)
Database evidence: runs 2 -> 2; leads 2 -> 2; 82.29 preserved;
migration replay passed; 5 rollback stages passed.

node --test test/pipeline.test.js test/api-serializer.test.js test/prisma-run-repository.test.js test/server.test.js
31 tests: 31 passed, 0 failed, 0 skipped (exit 0)

npm test
102 tests: 100 passed, 0 failed, 2 database-gated tests skipped (exit 0)

git diff --check
PASS (exit 0)

git status --short
Executed; only the bounded G-R4 files listed above were added or modified by this window.
```

The two database files skipped by the ordinary full suite are the same two files
executed separately by `npm run test:integration`; that required run had zero
skips. The initial public-schema migration preflight found an unmanaged disposable
schema without Prisma migration history, so final proof used isolated schemas and
did not rewrite or reset that public schema.

No live Google, OpenAI, Browserless, storefront, production database, frontend,
deployment, or credential operation was performed.

## Residual risks and deferred work

- Admission is process-local by G-R4 scope. G-R6 owns cross-instance atomic claim,
  worker leases, recovery, and lease-fenced terminal publication.
- G-R5 owns complete frontend display/export consumption of the stable G-R4 API.
- Historical rows remain unchanged; no score backfill or reclassification was
  performed.
- The user-designated disposable database's pre-existing public schema has tables
  but no recognized Prisma migration history. G-R4 verification is independent of
  that environmental condition because every proof schema was created from the
  checked-in baseline migrations.

## Stop confirmation

G-R5-G-R6 were not started. No live migration, destructive reset, production
database operation, provider call, frontend change, deployment, credential
change, or running user server action was performed.
