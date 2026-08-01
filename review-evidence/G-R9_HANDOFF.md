# G-R9 handoff — Lossless exact category-intent provenance

Status: **COMPLETE**

Date: 2026-08-01

## Outcome

The exact F4 reproduction now retains both `Eyewear Brand` and `Eyewear Brands`
as independent intents even though both normalize to `eyewear` plus `brand`.
They may share one candidate-independent provider response and one resolved store,
but their vocabulary, query reason, sources, score, validation decision,
occurrence, matched-category entry, and API JSON remain separate.

## Changed files

Runtime:

- `src/category-input.js`
- `src/discovery-aggregation.js`
- `src/pipeline.js`

Tests:

- `test/category-and-query-planning.test.js`
- `test/pipeline.test.js`

No provider call contract, query weights, store-fit policy, schema, migration,
frontend, deployment, credential action, or running server was changed.

## Contract established

- The canonical intent key contains the whitespace/Unicode-normalized exact
  `originalShopType`, normalized `shopType`, and `businessQualifier`.
- Input deduplication removes only duplicates of that complete exact key.
  Singular/plural or other exact-input differences remain distinct even when
  the derived category and qualifier are identical.
- Aggregation uses the same exported key and comparator. It never chooses a
  lexicographic original input or unions vocabulary across distinct exact keys.
- Repeated occurrences of the same exact key may merge their vocabulary while
  occurrence history remains complete.
- Provider query pages remain candidate-independent and reusable; intent
  metadata never enters the provider cache.
- Every exact intent is independently validated with G-R8's store-fit state.
- Primary display selection and serialized intent arrays are deterministic and
  independent of candidate/occurrence order.

## Deterministic coverage

- `normalizeShopTypes(["Eyewear Brand", "Eyewear Brands"])` returns two intents;
  an exact duplicate of the singular input collapses once.
- The planner performs one controlled provider request for the same normalized
  query while producing two exact plans with separate vocabulary, reasons, and
  research sources.
- One resolved store produces two occurrences, two fit decisions, and two
  matched-category entries when both pass.
- Each occurrence retains its own query score, source URLs, generation reason,
  vocabulary, qualifier, and exact input.
- Reversing plan order produces identical occurrences, fit evidence, matched
  categories, and primary display input.
- `leadRecordToCreate` plus `serializeLead` preserves all three JSON collections
  without collapse.
- Existing matching/mismatching-intent and duplicate-store tests remain green.

## Verification

Executed from `email_scraper`:

```text
node --test test/category-and-query-planning.test.js test/pipeline.test.js
PASS (exit 0)

npm test
120 tests: 117 passed, 0 failed, 3 database-gated skipped (exit 0)
The suite used temporary loopback permission for the server test.

npx prisma validate
PASS (exit 0)

git diff --check
PASS (exit 0)
```

No live provider/storefront, primary/production database, migration, deployment,
credential change, or server stop/restart occurred.

## Residual risk

Exact intent identity deliberately preserves case after whitespace/Unicode
normalization because `originalShopType` is user provenance, not a reconstructed
display label. Product category matching still uses normalized `shopType` and
the per-intent vocabulary.

## Stop boundary

G-R10 was not started until G-R9's focused and full checks passed.
