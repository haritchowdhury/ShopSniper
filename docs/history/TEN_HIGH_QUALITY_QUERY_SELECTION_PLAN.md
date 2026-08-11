# Ten High-Quality Queries per Category: Implementation Plan

## Implementation Status

Implemented on 2026-08-02.

- Query planning now returns exactly the configured target per category or a
  structured shortfall; partial selections are never published for review.
- Google probing uses the versioned `google-probe-v2` contract with result,
  unique-host, relevant-result, relevance-ratio, and intrinsic-score gates.
- Candidate acquisition uses adaptive batches, reason-targeted repair prompts,
  four bounded repair rounds, two-round no-progress stopping, and an 80 unique
  provider-call ceiling per category.
- Selection limits any one model-labelled product family to 30% of the target.
- Planning shortfalls persist audits and terminal safe error details in the same
  lease-fenced transaction that releases the worker lease.
- Editable and confirmed lists require exactly `GENERATED_QUERY_COUNT` rows per
  category, and edited rows must pass the same v2 probe contract.
- The frontend already renders the backend's safe terminal message and offers a
  **New run** action, so no frontend code change was required.
- Automated verification passes: 142 backend tests (139 passed, 3 integration
  tests skipped because they require an explicit test database) and all 5
  frontend test files.

The paid five-category controlled live probe remains an operational acceptance
run rather than an automated test; run it deliberately when live API spend is
desired. Browserless remains disabled locally and is unrelated to query planning.

## Objective

For every category in a run, produce exactly the configured target of high-quality
queries (`GENERATED_QUERY_COUNT=10` by default), or end query planning with an
explicit, auditable failure. The system must never lower its quality rules or send a
partial list to query review merely to appear successful.

This plan applies equally to every category. Clothing, baby food, and kitchen
utensils are examples for product copy only and must have no privileged runtime
mapping or fallback behaviour.

## Current Baseline

- The planner asks for 10 selected queries.
- It generates 25 initial candidates and allows two repair rounds.
- A Google probe currently accepts a candidate with at least five usable results,
  four unique Shopify hosts, and two relevant results.
- If fewer than 10 candidates survive, the planner records a warning but still
  persists the partial list and moves the run to query review.
- Query review currently requires only one query per category.
- Static category validation and the three-category canned fallback have now been
  removed. All categories use researched vocabulary through the same validation
  path.

## Non-Negotiable Behaviour

1. Ten is a hard completion requirement per category, not a display preference.
2. Only candidates that pass the versioned quality contract count toward ten.
3. Repair rounds may broaden wording, but may not weaken the quality contract.
4. Work is bounded by an explicit candidate/probe budget.
5. Exhausting the budget with fewer than ten produces a safe, visible planning
   failure with persisted audits; it does not produce a seven-query success.
6. Confirmed user-edited lists must still contain exactly ten valid queries per
   category and pass the same Google probe contract.

## Quality Contract

A selected query must satisfy all of the following:

- It follows the exact `site:myshopify.com/products <product phrase>` syntax.
- It is a concrete product phrase validated against the category's dynamically
  researched product vocabulary.
- It is not an exact or near duplicate of another candidate in that category.
- Google returned at least `MIN_QUERY_RESULTS` usable results.
- Results cover at least `MIN_QUERY_UNIQUE_HOSTS` distinct Shopify hosts.
- At least `MIN_QUERY_RELEVANT_RESULTS` results are relevant.
- At least 50% of usable results are relevant.
- Its intrinsic probe score is at least 60 before selection-diversity adjustments.
- Provider responses passed the pinned Google payload parser.

Recommended initial defaults:

```env
GENERATED_QUERY_COUNT=10
QUERY_CANDIDATE_COUNT=30
QUERY_REPAIR_ROUNDS=4
MAX_QUERY_PROBES_PER_CATEGORY=80
MIN_QUERY_RESULTS=5
MIN_QUERY_UNIQUE_HOSTS=4
MIN_QUERY_RELEVANT_RESULTS=3
MIN_QUERY_RELEVANCE_RATIO=0.50
MIN_QUERY_BASE_SCORE=60
```

The relevance ratio and minimum score must be included in the probe fingerprint.
Bump the probe contract from `google-probe-v1` to `google-probe-v2` so old cached
probes cannot silently satisfy the new rules.

## Adaptive Candidate Acquisition

Replace the fixed “initial pass plus two repairs” outcome with a bounded adaptive
loop:

1. Research the category once and generate an initial pool of 30 diverse candidates.
2. Validate and probe every new candidate, using the existing in-run cache to avoid
   duplicate Google calls.
3. Rank all passing probes and count how many can form a diverse selected set.
4. If fewer than ten pass, group failures by reason and request a targeted repair
   batch:
   - `insufficient_results`: use a more common catalogue synonym or remove a narrow
     modifier.
   - `insufficient_unique_hosts`: broaden the product phrase or choose another
     researched product family.
   - `irrelevant_probe_results`: move closer to concrete researched product-title
     vocabulary.
   - `duplicate_candidate` or `near_duplicate_candidate`: use a different product
     family or shopper use case.
   - `low_query_quality`: replace the candidate instead of weakening thresholds.
5. Request approximately twice the remaining shortfall, with a minimum batch of
   eight and a maximum of twenty.
6. Repeat until ten pass, four repair rounds complete, or 80 unique Google probes
   have been consumed.
7. Stop early if two consecutive rounds produce no new valid candidate, preventing
   wasteful loops.

The selector should retain its host and phrase diversity scoring. Ten variants of
one product family must not be treated as a healthy plan merely because each query
passes independently.

## Failure and Persistence Semantics

Have the planner return a structured result rather than treating a short list as a
warning:

```json
{
  "complete": false,
  "selected": [],
  "shortfalls": [
    {
      "categoryIndex": 0,
      "target": 10,
      "selected": 7,
      "generated": 65,
      "probed": 42,
      "rejectionCounts": {
        "insufficient_unique_hosts": 12,
        "irrelevant_probe_results": 8
      },
      "budgetExhausted": true
    }
  ]
}
```

Add a repository transaction that, under the active lease:

- Persists the query audit rows.
- Marks the run as `failed`/`finished`.
- Stores a safe code such as `INSUFFICIENT_HIGH_QUALITY_QUERIES`.
- Stores a concise safe message such as “7 of 10 required queries passed for
  clothing.”
- Releases the worker lease atomically.

This can use the existing schema and relations; no database migration should be
necessary. Do not move an incomplete plan to `awaiting_query_confirmation`.

## Query Review Enforcement

Update editable-list validation and confirmation so each category must contain
exactly `GENERATED_QUERY_COUNT` rows. Every edited or added query must pass the same
`google-probe-v2` contract. A fresh matching probe may still be reused; stale or
fingerprint-mismatched probes must be repeated.

If any confirmed query fails, return the run to query review with row-level reasons.
Do not start store discovery until all ten queries for every category are valid.

## Implementation Areas

1. `src/config.js` and `.env.example`
   - Add the probe budget, relevance-ratio, and score settings with bounded parsers.
2. `src/query-prober.js`
   - Enforce relevance ratio and minimum intrinsic score.
   - Emit stable rejection codes and complete audit metrics.
3. `src/query-planner.js`
   - Implement the adaptive repair loop and per-category hard target.
   - Return structured completion/shortfall information.
4. `src/category-researcher.js`
   - Make repair prompts reason-specific while using only the original research
     evidence.
5. `src/query-ranker.js`
   - Preserve diversity and add a testable limit against excessive product-family
     concentration.
6. `src/query-review.js`
   - Version the probe contract and include all thresholds in its fingerprint.
   - Enforce exactly ten rows per category at save and confirmation boundaries.
7. `src/server.js` and `src/prisma-run-repository.js`
   - Persist incomplete-plan audits and the safe terminal failure atomically.
8. API serializer/frontend handoff
   - Display the safe shortfall message and offer a new-run retry; never label a
     partial plan ready for confirmation.

## Verification

### Unit tests

- Familiar and previously unseen categories use the identical validation path.
- Singular/plural wording does not create false `out_of_category` failures.
- Relevance ratio and minimum score reject otherwise borderline probes.
- Repair batch size follows the remaining shortfall and never exceeds limits.
- Duplicate candidates and cached probes do not consume the unique-probe budget.
- Selection stops immediately when the tenth passing query is obtained.
- Budget exhaustion cannot return `complete: true`.
- Multi-category runs require ten passing queries independently for each category.

### Persistence and API tests

- A 10/10 plan transitions atomically to query review.
- A 9/10 plan stores audits and transitions atomically to failed.
- A lease loss prevents either transition.
- Query review rejects 9 or 11 rows when the configured target is ten.
- Editing one query invalidates only its stale fingerprint and reuses the other fresh
  probes.
- Store discovery never starts with fewer than ten valid rows per category.

### Controlled live probe

Run five categories: clothing, eyewear, and three categories not present in examples
or fixtures. Record candidate count, probe count, repair rounds, rejection reasons,
selected scores, distinct hosts, relevant-result ratios, Google calls, and elapsed
time. The live acceptance gate is:

- Exactly ten selected queries per category.
- Every selected query passes the same documented contract.
- No category-specific code or canned catalogue is invoked.
- No category exceeds 80 unique Google probes.

If a category cannot satisfy the gate, confirm that it fails explicitly with its
audits intact rather than lowering thresholds.

## Cost and Operational Bound

At the 80-probe ceiling, Google Custom Search costs at most approximately $0.40 per
category after the free daily quota. OpenAI repair calls remain bounded to four.
Browserless is unrelated to query planning and remains disabled during the current
test period.

Log per-category `candidates_generated`, `candidates_probed`, `cache_hits`,
`repair_rounds`, `accepted_count`, rejection counts, and final shortfall. These
metrics should be observed for several runs before changing quality thresholds or
the 80-probe ceiling.

## Definition of Done

- No runtime category receives special validation or fallback treatment.
- Successful query planning always produces exactly ten passing queries per category.
- The planner never fills the list with rejected or threshold-relaxed candidates.
- Bounded exhaustion produces an explicit, safe, auditable failure.
- Query review and confirmation cannot reduce a category below ten valid queries.
- The full automated suite and the five-category controlled probe pass.
