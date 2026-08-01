# G-R3 handoff — Candidate-specific category and query provenance

Status: **COMPLETE**

Date: 2026-08-01

## Outcome

G-R3 restores corrective invariants C5-C6. The exact normalized category intent
now survives planning, provider-result reuse, search occurrences, identity
resolution, aggregation, validation, and in-memory result construction. Query
reuse caches only candidate-independent normalized provider data or errors, and
every candidate is summarized and audited independently. `matched_categories`
now contains only intents accepted by G-R2's shared store-fit predicate.

The exact corrective reproductions now behave as follows:

| Reproduction | Result after G-R3 |
| --- | --- |
| `  eYeWeAr   BrAnD  ` through resolver and result | exact normalized `eYeWeAr BrAnD` retained |
| Brand and retailer candidates with identical query text | one provider call; separate reasons, sources, vocabulary, qualifiers, scores, and audits |
| Cached provider failure for two qualifier variants | one failed provider call; two candidate-specific failure probes and audits |
| Store discovered by one matching and one mismatching intent | two discovery attempts; one truthful matched category |
| Store with no accepted intent | complete discovery attempts; empty matched-category list |
| Reversed occurrence order | identical occurrences, matches, fit evidence, and primary intent |

## Contracts established

### Category intent

The canonical in-memory category intent is:

```text
{
  originalShopType: string,
  shopType: string,
  businessQualifier: "brand" | "retailer" | "unspecified"
}
```

`originalShopType` is never reconstructed from `shopType`. A normalized intent is
attached to selected plans and search candidates, retained as flattened fields
for compatibility, passed unchanged to the resolver and validator, and recorded
with discovery occurrences and result records.

### Query cache boundary

- Cache keys combine normalized query text with the provider contract version.
- Cached values contain only the normalized provider page or normalized provider
  failure; they never contain a candidate, probe summary, rank, or audit.
- Every candidate, including a cache hit, runs through `summarizeProbe` with its
  own metadata.
- An in-flight candidate-independent cache entry coalesces concurrent identical
  queries, so they still issue only one provider call.
- Candidate generation reason, research source URLs, category vocabulary,
  qualifier, and audit remain candidate-specific.
- Provider failures are reused as provider outcomes without reusing the first
  candidate object.

### Matches and attempts

- G-R2's acceptance matrix is exported as `storeFitAcceptsIntent` and is used by
  storefront validation and matched-category construction without changing its
  rules.
- Brand accepts only `specialist`; retailer and unspecified accept `specialist`
  or `category_seller`.
- `discovery_occurrences` retains every attempt and its exact intent/query
  provenance.
- `store_fit_evidence` retains every per-intent decision and its explicit
  `accepted` value.
- `matched_categories` contains accepted intents only. It is empty when none are
  accepted and on failures before final intent validation.
- Primary display intent selection prefers accepted matches, then uses the
  existing validation/rejection/evidence ordering and a complete lexical intent
  key as a deterministic fallback.

## Changed files

Runtime:

- `src/category-input.js`
- `src/query-cache.js`
- `src/query-prober.js`
- `src/query-planner.js`
- `src/query-audit.js`
- `src/discovery-aggregation.js`
- `src/storefront-validator.js` (export/reuse of the existing G-R2 predicate only)
- `src/pipeline.js`

Tests:

- `test/category-and-query-planning.test.js`
- `test/pipeline.test.js`

Tracking:

- `review-evidence/G-R3_HANDOFF.md`
- `../PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` (G-R3 status/evidence only)

No Prisma schema, migration, API serializer, frontend, Google pagination,
provider scoring rule, storefront evidence rule, or score weight was changed.

## Durable/API field inventory for G-R4

| G-R3 value | Current durability | G-R4 action |
| --- | --- | --- |
| Primary `original_shop_type` result scalar | Present in-memory but dropped by the current lead mapper; no `Lead` column or API field | Add a nullable compatibility-safe `Lead.originalShopType`, mapper/serializer field, and append-only CSV field |
| Exact intent on each discovery attempt | Preserved in existing `Lead.discoveryOccurrences` JSON | Validate durable/API round trip; no new column required |
| Query reason, sources, vocabulary, score, rank, and URLs per attempt | Preserved in existing `Lead.discoveryOccurrences` JSON | Validate durable/API round trip; no new column required |
| Accepted intent list | Preserved in existing `Lead.matchedCategories` JSON | Validate truthful durable/API round trip; no new column required |
| Per-intent fit decision and `accepted` flag | Preserved in existing `Lead.storeFitEvidence` JSON | Validate durable/API round trip; no new column required |
| Query-audit exact input and category vocabulary | Current mapper places `original_shop_type` and `category_vocabulary` in `QueryAudit.details`; source URLs already use `details` | Validate repository/API round trip; a dedicated column is not required by G-R3 |
| Run input intent objects | Existing `Run.normalizedShopTypes` JSON | Preserve without rewrite |

The query-audit CSV appends `original_shop_type` and `category_vocabulary`; all
pre-existing header positions remain unchanged. The backend lead CSV does not yet
append `original_shop_type`, because durable/API/CSV compatibility is owned by
G-R4 and later safe presentation by G-R5.

## Verification

Executed from `/home/harit/Email Scrapper/email_scraper`:

```text
node --test test/category-and-query-planning.test.js test/pipeline.test.js
PASS (exit 0)

npm test
97 tests: 96 passed, 0 failed, 1 skipped (exit 0)

npx prisma validate
PASS — schema is valid (exit 0)

git diff --check
PASS (exit 0)

git status --short
Executed; only the ten G-R3 runtime/test files were modified before this handoff.
```

The first sandboxed full-suite attempt could not bind the server-test loopback
socket (`listen EPERM 127.0.0.1`). It was rerun with explicit loopback permission
and passed. The skipped test is the existing disposable-database integration
gate; G-R3 owns no database behavior or migration.

No live Google, OpenAI, Browserless, storefront, database, frontend, deployment,
or credential action was performed.

## Residual risks and deferred work

- The exact primary input is intentionally not durable until G-R4 adds and proves
  its compatibility-safe persistence/API contract.
- Existing fractional `queryScore` versus Prisma `Int` behavior remains G-R4's
  owned correction; G-R3 preserves candidate-specific runtime values unchanged.
- G-R3 does not claim statistical query or store-fit calibration.
- Provider contract changes require a new cache contract version; no fallback
  envelope probing was introduced.

## Stop confirmation

G-R4-G-R6 were not started. No migration, production database operation, live
provider call, frontend change, deployment, credential change, or running user
server action was performed.
