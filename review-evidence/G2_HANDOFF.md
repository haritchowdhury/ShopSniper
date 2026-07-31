# G2 handoff — Category intent, query quality, rendering, and store fit

Status: **COMPLETE**

Date: 2026-07-31

## Outcome

G2 now preserves category/store-type intent through discovery, parses active
Google Custom Search and OpenAI Responses payloads through versioned strict
adapters, ranks probes without unsupported metadata bonuses, renders initial
storefront evidence only when deterministic HTML is insufficient or suspicious,
and produces fetched-only store-fit evidence before contact qualification.

Controlled before/after reproduction:

| Defect | Before G2 | After G2 |
| --- | --- | --- |
| `Eyewear Brand` | `{ shopType: "eyewear" }` | `{ originalShopType: "Eyewear Brand", shopType: "eyewear", businessQualifier: "brand" }` |
| Google title/snippet with unrelated HTML | relevance `100` | `storeFit.state=mismatch`, score `0`, `wrong_category` |
| One query term across probe results | relevant probe | zero relevant results; `irrelevant_probe_results` |
| JavaScript-only initial storefront | no initial rendering | Browserless invoked after semantic shell assessment |
| Misleading product URL before contact evidence | consumed page budget | excluded unless category-relevant; homepage/contact remain ahead of product evidence |

## Frozen G2 contracts

Normalized category:

```text
{
  originalShopType: string,
  shopType: string,
  businessQualifier: "brand" | "retailer" | "unspecified"
}
```

- Safe whitespace normalization preserves `originalShopType`.
- Trailing `brand`/`brands` and `retailer`/`retailers` are separated before core
  category aliasing.
- Category input deduplication uses `(shopType, businessQualifier)`.
- Query uniqueness is scoped to category intent; the shared probe cache still
  prevents repeated Google calls for identical qualifier-variant queries.

Normalized store fit:

```text
{
  state: "specialist" | "category_seller" | "mismatch" | "unknown",
  score: number,
  matchedTerms: string[],
  sourceUrls: string[],
  evidence: Array<{
    sourceUrl: string,
    pageType: string,
    matchedTerms: string[],
    signals: string[],
    strength: number,
    textLength: number
  }>,
  reason: string
}
```

The score is deterministic evidence strength, not a probability. Only fetched
page bodies contribute. Google title/snippet never enter store-fit text.

Acceptance matrix:

| Business qualifier | Accepted store fit |
| --- | --- |
| `brand` | `specialist` |
| `retailer` | `specialist`, `category_seller` |
| `unspecified` | `specialist`, `category_seller` |

Storefront validation also distinguishes `inactive_store`,
`storefront_blocked`, `not_shopify`, `wrong_category`, `wrong_store_type`, and
`insufficient_store_evidence`. A blocked representative page is not rejected
until the bounded homepage/evidence attempt is complete.

Provider contracts:

- `google-custom-search-v1`
- `openai-responses-query-planning-v1`

Both use Zod-backed exact consumed paths and typed, privacy-safe contract errors.
Documented additive outer metadata is ignored. OpenAI refusal and incomplete
status are explicit failures. A query-generation adapter failure may enter the
existing explicit deterministic fallback with a planning warning; it never
guesses a provider envelope. Google drift becomes `probe_failed`, not empty
success.

Probe ranking uses distinct usable hosts, meaningful phrase/multi-term coverage,
and structurally validated product intent. Candidate confidence and research
source URLs remain audit provenance only because they are not independently
calibrated or linked to probe coverage. Estimated result counts and unused
pagination availability receive no score.

Fetch/page budget contract:

- Ordinary HTML returns directly only after semantic assessment.
- Missing storefront evidence, insufficient text, JS/consent shells, challenges,
  or ordinary errors trigger the configured Browserless path when available.
- Password pages remain separately identifiable as inactive.
- Rendered content never widens G1 `allowedHostnames` or identity trust.
- Ranked page order is homepage, explicit contact, support/help,
  organization/about, relevant collection/product, then policy.
- Normalized original/final duplicates consume one slot.
- Per-store page fetching uses `PAGE_FETCH_CONCURRENCY` (default `2`), preserves
  ranked output order, validates redirect hosts, and isolates partial failures.

## Changed files

Runtime and configuration:

- `.env.example`
- `README.md`
- `src/category-input.js`
- `src/category-researcher.js`
- `src/config.js`
- `src/domain-resolver.js`
- `src/openai-responses.js`
- `src/page-fetcher.js`
- `src/pipeline.js`
- `src/query-audit.js`
- `src/query-planner.js`
- `src/query-prober.js`
- `src/search.js`
- `src/sitemap.js`
- `src/storefront-validator.js`

Tests and sanitized provider fixtures:

- `test/category-and-query-planning.test.js`
- `test/domain-and-sitemap.test.js`
- `test/page-fetcher.test.js`
- `test/pipeline.test.js`
- `test/server.test.js`
- `test/validation-and-security.test.js`
- `test/fixtures/providers/openai/README.md`
- `test/fixtures/providers/openai/responses-query-planning-v1-*.json`
- `test/fixtures/providers/google/README.md`
- `test/fixtures/providers/google/custom-search-v1-*.json`

Tracking:

- `review-evidence/G2_HANDOFF.md`
- `../PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` (G2 status/evidence only)

## Verification

Executed from `/home/harit/Email Scrapper/email_scraper`:

```text
node --test test/category-and-query-planning.test.js
PASS (exit 0)

node --test test/page-fetcher.test.js test/domain-and-sitemap.test.js
PASS (exit 0)

node --test test/validation-and-security.test.js
PASS (exit 0)

node --test test/pipeline.test.js
PASS (exit 0)

npm test
69 tests: 68 passed, 0 failed, 1 skipped
```

The skipped test is the pre-existing Prisma integration test requiring an
explicit disposable `TEST_DATABASE_URL`. No live or production database was
used. The full suite required permission only to bind temporary loopback ports
for existing server tests.

Hygiene:

```text
git diff --check
PASS

changed-file trailing-whitespace scan
PASS

git status --short
Reviewed; existing user-owned deleted/untracked project layout was preserved.
```

No live Google, OpenAI, Browserless, storefront, or database call was made.

## Residual risks and deferred work

- Store-fit strength is deterministic and explainable, not statistically
  calibrated. A labeled live probe remains required after G1-G4 before claiming
  precision.
- Specialist classification deliberately requires high-level identity/breadth
  evidence. Sparse or blocked specialist sites become `unknown` rather than
  silently qualifying.
- Browserless fixtures validate invocation, token fallback, failure isolation,
  and response classification without a live provider call.
- G2 exposes store-fit and category contracts for G3; persistence, merged
  discovery provenance, mandatory final qualification, score v2, diagnostics,
  migration, and API serialization remain G3 work.

## Stop confirmation

G3 and G4 were not started. No Prisma schema/migration, score-v2 weights,
diagnostic persistence, ownership behavior, or frontend file was changed.
