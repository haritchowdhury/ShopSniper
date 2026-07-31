# G3 handoff — Aggregation, qualification, score v2, persistence, and diagnostics

Status: **COMPLETE**

Date: 2026-07-31

## Outcome

G3 now merges verified discovery aliases without losing category/query provenance,
selects representative and category outcomes deterministically, qualifies only from
G1/G2 evidence, calculates explainable score v2 only for qualified stores, and
atomically publishes leads, query audits, diagnostics, versions, and summary data.

Controlled regressions prove:

- reversed custom/MyShopify occurrences produce one store with identical complete
  provenance;
- a stronger later occurrence wins without trusting first discovery order;
- structural, research-only, and no-contact outcomes have a null lead score;
- scalar-only contact URLs cannot qualify without G1 contact-page evidence;
- query/search-result/resolution failures are diagnostics, never unnamed leads;
- a child-write failure occurs before `resultsAvailable=true`, and completion uses
  deterministic child IDs inside one transaction.

## Frozen G3 contracts

Contactability is `direct`, `indirect`, `research_only`, or `none`. Only direct
(validated email/phone) and indirect (validated contact page) stores qualify.
Mandatory store gates are evaluated before contactability. Rejection precedence is
inactive, blocked, not Shopify, wrong category, wrong store type, insufficient store
evidence, then insufficient contact evidence. Processing exceptions remain failed
store rows only after a stable store identity exists.

Score v2 is a deterministic evidence rank, not a probability:

```text
identity confidence       20
Shopify validation        25
fetched category fit      30
validated email           12
validated phone            8
validated contact page     5
social profile             0
```

Rejected and failed rows have `lead_score=null`, `scoring_version=null`, and no
score breakdown. Qualified rows persist the exact components, total, version 2,
and `deterministic_evidence_rank_not_probability` semantics.

The lead collection contains resolved store outcomes only. Query audits and run
diagnostics are separate durable collections. `summary.total` counts lead rows and
equals qualified + rejected + failed. Progress separately exposes
`queryFailures`, `occurrenceFailures`, and `storeProcessingFailures`.

## Durable schema and migration

Migration:

- `prisma/migrations/20260731230000_g3_pipeline_quality/migration.sql`

It adds nullable run/lead version and evidence fields plus `QueryAudit` and
`RunDiagnostic` tables. It contains no update, delete, destructive backfill, or
historical reclassification. Legacy rows remain nullable and serialize with
`score_semantics: "legacy_v1"`.

Synthetic v2 lead fields include:

```json
{
  "business_qualifier": "brand",
  "pipeline_version": 2,
  "scoring_version": 2,
  "store_fit_state": "specialist",
  "contactability_tier": "direct",
  "identity_confidence": 70,
  "score_breakdown": {
    "version": 2,
    "components": {
      "identity": 14,
      "shopifyValidation": 25,
      "categoryFit": 30,
      "contactEvidence": 12
    },
    "total": 81
  }
}
```

Completion deletes/recreates the run's child result sets and updates the run inside
one Prisma transaction. Lead IDs hash the run plus stable verified hostname;
audit/diagnostic IDs and sequences are deterministic. A retry replaces the same
logical result set without duplicate publication.

## API and CSV

Existing endpoints and lead fields remain compatible. New owner-scoped endpoints:

- `GET /api/runs/{runId}/query-audits?page=1&pageSize=20`
- `GET /api/runs/{runId}/diagnostics?page=1&pageSize=20`

Both perform the established run-owner check at HTTP and repository layers and
return the same not-found behavior for foreign runs.

The existing 25 CSV columns retain their names and positions. G3 fields are
appended beginning with `business_qualifier` and ending with
`matched_categories`; JSON evidence is serialized into individual appended cells.

## Changed files

Runtime and documentation:

- `README.md`
- `src/discovery-aggregation.js`
- `src/pipeline.js`
- `src/lead-scorer.js`
- `src/api-serializer.js`
- `src/prisma-run-repository.js`
- `src/server.js`
- `src/status.js`
- `src/output.js`

Schema:

- `prisma/schema.prisma`
- `prisma/migrations/20260731230000_g3_pipeline_quality/migration.sql`

Tests:

- `test/pipeline.test.js`
- `test/extraction-and-scoring.test.js`
- `test/prisma-run-repository.test.js`
- `test/prisma-run-repository.integration.test.js`
- `test/api-serializer.test.js`
- `test/server.test.js`
- `test/csv.test.js`

Tracking:

- `review-evidence/G3_HANDOFF.md`
- `../PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` (G3 status/evidence only)

## Verification

Executed from `/home/harit/Email Scrapper/email_scraper`:

```text
npx prisma validate
PASS

npm run db:generate
PASS

node --test test/pipeline.test.js test/extraction-and-scoring.test.js
PASS

node --test test/prisma-run-repository.test.js test/api-serializer.test.js
PASS

node --test test/server.test.js
PASS

npm test
79 tests: 78 passed, 0 failed, 1 skipped

git diff --check
PASS

changed-file trailing-whitespace scan
PASS
```

The skipped integration test requires `ALLOW_DATABASE_TESTS=true` and an explicit
disposable `TEST_DATABASE_URL`. Neither `TEST_DATABASE_URL` nor `DATABASE_URL` was
present. Migration deployment/replay and transaction rollback against PostgreSQL
therefore remain an explicit verification blocker; no configured or production
database was assumed or contacted. The migration was statically verified as
additive and Prisma schema validation/client generation passed.

No live Google, OpenAI, Browserless, storefront, or database call was made.

## Residual risks and stop confirmation

- Score v2 is deterministic and explainable but not statistically calibrated.
- PostgreSQL migration replay/data-preservation acceptance remains conditional on
  an explicitly designated disposable database.
- G4 frontend types, presentation, proxy routes, and CSV download behavior were
  not changed.

G4 was not started.
