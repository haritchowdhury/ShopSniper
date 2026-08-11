# Lead Scoring v3 Reliability Execution Plan

Status: executed on 2026-08-04 using the recommended strict missing-traffic policy.

Prepared: 2026-08-04

Workspace: `/home/harit/Email Scrapper`

Authoritative implementation roots:

- `email_scraper/`
- `frontend/`
- `contracts/`

Do not use or restore the deleted legacy `Email Scrapper/` subtree. The current
Git worktree represents a large repository re-layout: the authoritative roots
above are presently untracked relative to the old Git baseline. Preserve all
current user changes and do not treat the old tracked subtree as the source of
truth.

## 1. Objective

Introduce a versioned, deterministic lead score v3 in which:

- estimated Google search traffic contributes up to 40 points;
- CrUX Core Web Vitals contribute up to 5 bonus points;
- the existing identity, Shopify, category, and contact signals retain their
  current relative proportions within the remaining 55 points;
- qualification remains independent of traffic and remains unchanged;
- missing, malformed, failed, or ambiguous provider data is never silently
  interpreted as measured zero;
- final v3 scores are not publicly visible until they are durably finalized;
- v1 and v2 historical scores remain readable and are never rewritten.

Reliability, auditability, resumability, and truthful missing-data semantics take
priority over implementation speed.

## 2. Locked scoring mathematics

### 2.1 Component maxima

The old v2 weights are 20:25:30:25. Redistribute those proportions into 55
integer points as follows:

| Component | v2 maximum | v3 maximum |
| --- | ---: | ---: |
| Store identity | 20 | 11 |
| Shopify validation | 25 | 14 |
| Category fit | 30 | 16 |
| Contact evidence | 25 | 14 |
| Estimated Google search traffic | 0 | 40 |
| CrUX Core Web Vitals | 0 | 5 |
| Total | 100 | 100 |

Use these exact formulas:

```text
identity = round(clamp(identityConfidence, 0, 100) / 100 * 11)
shopifyValidation = round(clamp(shopifyConfidence, 0, 100) / 100 * 14)
categoryFit = round(clamp(relevanceScore, 0, 100) / 100 * 16)

contactEvidence =
    validated email present        ? 7 : 0
  + validated phone present        ? 4 : 0
  + validated contact page present ? 3 : 0
```

The 7:4:3 contact split is the integer-preserving redistribution of the existing
12:8:5 split. Social profiles continue to contribute zero points.

Every scalar input must be finite and within its documented range. Scoring must
fail closed rather than relying only on `Number(value) || 0` coercion.

### 2.2 Traffic metric and transformation

The traffic input is the worldwide DataForSEO metric already publicly labelled
`estimated_google_search_traffic`:

```text
organic.etv + paid.etv
```

Do not call this total website traffic. Featured-snippet and local-pack ETV must
not be added because overlap has not been disproved.

Use a fixed, versioned logarithmic transformation, not a per-run percentile:

```text
trafficPoints = min(40, round(8 * log10(traffic + 1)))
```

Required anchors:

| Measured estimated Google search traffic | Points, approximately |
| ---: | ---: |
| 0 | 0 |
| 10 | 8 |
| 100 | 16 |
| 1,000 | 24 |
| 10,000 | 32 |
| 100,000 or more | 40 |

Traffic must be a finite non-negative number. Cap the calculation safely before
any operation that could create a non-finite value. A provider-returned zero is
valid measured evidence. Provider omission or failure is not zero.

Do not use a percentile calculated from the current run. That would make the
same store's score change based on its batch peers and make cross-run scores
non-comparable. A fixed externally benchmarked percentile can be considered in
a future scoring version only.

### 2.3 CrUX performance bonus

Only CrUX REST Core Web Vitals affect the 5-point performance component. CrUX
BigQuery popularity, coverage existence, device fractions, FCP, and TTFB must
not earn scoring points.

Use the project's existing exact good boundaries:

- LCP good: `<= 2500 ms`
- INP good: `<= 200 ms`
- CLS good: `<= 0.1`

Use these component weights and ratings:

| Metric | Good | Needs improvement | Poor | Maximum |
| --- | ---: | ---: | ---: | ---: |
| LCP | 2 | 1 | 0 | 2 |
| INP | 2 | 1 | 0 | 2 |
| CLS | 1 | 0.5 | 0 | 1 |

Because the persisted lead score contract requires an integer, sum the metric
points and apply one documented final rounding operation to the CrUX component.
Do not round each fractional metric independently. Add explicit boundary tests.

Use the standard poor boundaries already represented by the frontend's Core Web
Vitals classifier. Reuse one shared backend definition or prove exact agreement
with frontend boundary fixtures; do not create divergent magic numbers.

Missing CrUX coverage or a missing individual metric earns no bonus for that
metric. It must be recorded as missing/no-coverage, not classified as poor.

### 2.4 Total and semantics

```text
total = identity
      + shopifyValidation
      + categoryFit
      + contactEvidence
      + traffic
      + crux
```

The exact component sum must equal the persisted integer total, and the total
must be in `[0, 100]`. The score remains a deterministic evidence rank, not a
probability or predicted conversion rate.

Proposed v3 breakdown shape:

```json
{
  "version": 3,
  "components": {
    "identity": 11,
    "shopifyValidation": 14,
    "categoryFit": 16,
    "contactEvidence": 14,
    "traffic": 24,
    "crux": 5
  },
  "total": 84,
  "semantics": "deterministic_traffic_evidence_rank_not_probability",
  "evidence": {
    "traffic": {
      "state": "measured",
      "metric": "estimated_google_search_traffic",
      "value": 1000,
      "transform": "log10_v1",
      "sourceContractVersion": "dataforseo-traffic-v1",
      "observedAt": "ISO-8601 timestamp"
    },
    "crux": {
      "state": "available|partial|no_coverage|unavailable|disabled",
      "lcpP75Ms": 2500,
      "inpP75Ms": 200,
      "clsP75": "0.1",
      "ratings": {
        "lcp": "good",
        "inp": "good",
        "cls": "good"
      },
      "sourceContractVersion": "crux-origin-metrics-v1",
      "observedAt": "ISO-8601 timestamp"
    }
  }
}
```

Omit unavailable raw metric members rather than inventing values. Keep evidence
strictly bounded and free of provider envelopes, secrets, or arbitrary errors.

## 3. Decision gate: unavailable DataForSEO

This decision was not confirmed before the plan was stored.

Recommended and reliability-first policy:

- A qualified lead receives a numeric v3 score only when it has a strictly
  validated worldwide DataForSEO record.
- If DataForSEO is disabled, the run remains scoring v2.
- If DataForSEO is enabled but the lead's worldwide record is unavailable,
  ambiguous, omitted, malformed, or contract-mismatched, the qualified lead has
  `leadScore=null`, `scoreBreakdown=null`, and an explicit v3 insufficient-traffic
  score semantic.
- Do not retain a v2 number beside v3 numbers in the same completed run because
  those values have different denominators and are not safely sortable.
- A valid DataForSEO record whose worldwide ETV sum is exactly zero is scored v3
  with zero traffic points.

Required confirmation before implementation: accept the recommendation above,
or explicitly choose to retain a clearly labelled v2 fallback for affected
leads. The latter is not recommended because mixed-version sorting is
misleading.

## 4. Current architecture findings

### 4.1 Current order

The current order is:

```text
discover and qualify lead
  -> calculate/persist v2 score
  -> mark base results available
  -> enrich DataForSEO
  -> enrich CrUX REST
  -> enrich CrUX BigQuery
  -> complete run
```

Important locations:

- v2 calculation: `email_scraper/src/lead-scorer.js`
- qualification and early scoring: `email_scraper/src/pipeline.js`
- worker orchestration: `email_scraper/src/server.js`
- enrichment orchestration: `email_scraper/src/enrichment/orchestrator.js`
- progressive traffic publication and completion:
  `email_scraper/src/prisma-run-repository.js`
- score-state invariants: `email_scraper/src/lead-state.js`
- public serialization: `email_scraper/src/api-serializer.js`
- shared v2 fixtures: `contracts/lead-score-state-v2.fixtures.json`
- frontend validation/presentation: `frontend/lib/api-validation.ts` and
  `frontend/lib/lead-presentation.ts`

### 4.2 Confirmed holes that v3 must close

1. Progressive `saveLeadBatch()` and `completeLeadDiscovery()` currently set
   `resultsAvailable=true` before traffic enrichment.
2. The current score invariant permits only unversioned legacy data or the exact
   `(pipelineVersion=2, scoringVersion=2)` pair.
3. Qualified v2 leads are required to have a numeric score, so v3 needs an
   explicit insufficient-traffic state if the recommended policy is accepted.
4. Progressive runs persist leads and traffic in stages, whereas legacy runs
   persist their final result atomically. Both paths must produce identical v3
   output for identical evidence.
5. The traffic failure path currently completes progressive runs with base
   results. It must never relabel v2 material as v3.
6. Resume begins from `leads_persisted` or `enriching_traffic`. Final scoring must
   be deterministic and safe when all, some, or none of the provider rows were
   already published.
7. DataForSEO `partial` can contain valid worldwide material plus missing country
   scopes. v3 eligibility depends on the valid worldwide record, not only the
   aggregate source state.
8. CrUX REST and BigQuery are separate rows. Only validated REST vital metrics
   affect scoring.
9. Public sorting defaults to `leadScore desc, nulls last`; v3 null semantics
   must remain truthful in this ordering.

## 5. Target lifecycle and publication rules

### 5.1 Qualification remains early

Do not change storefront validation, category/store-fit acceptance, or contact
qualification. Traffic must rank qualified leads; it must not rescue invalid,
inactive, mismatched, blocked, or unreachable leads.

Continue calculating v2 during discovery if useful for internal compatibility,
but treat it as provisional whenever the immutable run snapshot enables v3
traffic scoring.

### 5.2 Result visibility

For traffic-enabled runs that will attempt v3:

- persist leads durably after discovery;
- keep `resultsAvailable=false` during `leads_persisted` and
  `enriching_traffic`;
- publish results only after final score state and run completion commit
  together.

For traffic-disabled runs, preserve the current v2 publication behavior.

Do not expose provisional v2 as if it were the final score. If product
requirements later demand progressive visibility, add an explicit provisional
API state in a separate change rather than overloading final semantics.

### 5.3 Atomic finalization

Add a dedicated finalization operation, or extend
`completeTrafficEnrichment()`, so one lease-fenced database transaction:

1. validates that the run is active and owned by the current lease;
2. reads or accepts only strictly validated, run-owned traffic rows;
3. derives deterministic v3 finalizations for every lead;
4. updates qualified scored leads to numeric v3 values and exact breakdowns;
5. updates qualified insufficient-traffic leads to the explicit null v3 state;
6. updates rejected/failed leads to the correct unscored v3 state if the run is
   finalized as v3;
7. verifies the expected updated row count;
8. sets run `pipelineVersion=2`, `scoringVersion=3`;
9. sets `resultsAvailable=true`, terminal state/stage/timestamps, and releases
   the lease.

Any validation, score computation, row-count, or write failure must roll back
the entire finalization. Never publish a run whose run-level scoring version and
lead-level score states disagree.

### 5.4 Idempotency and resume

Finalization must be a pure replacement derived from persisted evidence. Never
increment an existing score or append component points.

On replay:

- identical evidence must produce byte-equivalent canonical score breakdowns;
- already-published source rows must be reused;
- partial source publication must resume the missing work;
- a second identical completion should be accepted only through the existing
  idempotency/fingerprint rules;
- conflicting traffic or score evidence must fail closed.

Traffic failure before successful finalization must preserve durable leads and
traffic rows. It must either publish truthful v2 fallback results or truthful v3
null states according to the confirmed Section 3 policy; it must never emit a
partial numeric v3 score.

## 6. Version and invariant contract

Extend `email_scraper/src/lead-state.js` without weakening v2:

- legacy: pipeline/scoring versions both absent, semantic `legacy_v1`;
- v2 qualified: exact integer score and exact four-component v2 breakdown;
- v2 rejected/failed: null score and breakdown;
- v3 qualified/scored: pipeline 2, scoring 3, exact integer score and exact
  six-component v3 breakdown;
- v3 qualified/insufficient traffic: pipeline 2, scoring 3, null score and
  breakdown, explicit semantic such as `insufficient_traffic_v3`;
- v3 rejected/failed: pipeline 2, scoring 3, null score and breakdown, semantic
  `not_scored_v3`.

Suggested scored semantic: `traffic_evidence_rank_v3`.

Validate all of the following:

- exact component keys, no missing/additive keys;
- safe integers for persisted component points and total;
- per-component maximums;
- exact component sum equals total;
- exact version and semantic strings;
- strict bounded evidence object;
- traffic transformation output recomputes from the persisted raw traffic value;
- CrUX points recompute from persisted metrics/ratings;
- impossible version/status/score combinations fail closed.

Create a new shared v3 fixture matrix rather than mutating v2 fixture meaning.

## 7. Implementation sequence

### Window A: pure scoring and invariants

1. Add v3 constants and pure calculation functions to the scorer or a dedicated
   `lead-scorer-v3.js`.
2. Keep `scoreLeadV2()` unchanged.
3. Add strict traffic-input parsing using accepted normalized/public provider
   contracts; do not parse raw provider bodies.
4. Add CrUX rating and point calculation with exact boundaries.
5. Add v3 breakdown validation and score-state semantics.
6. Add exhaustive unit tests before wiring persistence.

### Window B: deterministic finalization assembly

1. Build a pure function that groups enrichment records by `leadId`.
2. Reject duplicate lead/source identities.
3. Require lead ownership and recognized contracts.
4. Derive a finalization record for every lead, including explicit unscored
   states.
5. Prove order independence by shuffling lead and enrichment inputs in tests.

### Window C: progressive persistence

1. Prevent early result availability for v3-eligible traffic runs.
2. Add lease-fenced transactional v3 finalization.
3. Verify exact row counts and run/lead version agreement.
4. Preserve current v2 behavior when enrichment is disabled.
5. Preserve safe recovery when enrichment fails.

### Window D: legacy atomic persistence

1. Finalize the in-memory result after enrichment and before
   `saveCompletedResults()`.
2. Ensure the same pure scorer and finalization assembler are used by both
   persistence paths.
3. Include v3 scores and traffic rows in the existing canonical result
   fingerprint.

### Window E: public contracts and frontend

Before changing Next.js code, follow `frontend/AGENTS.md` and read relevant
installed Next 16 documentation if framework APIs must change. Plain library and
test changes do not require framework changes.

Update:

- backend API serialization and validation;
- shared v3 fixtures;
- frontend API types and validation;
- lead presentation labels and explanations;
- expanded score component display;
- CSV score/breakdown behavior and documentation;
- seed and test fixtures;
- any UI text that currently says all rejected/failed v2 outcomes are the only
  unscored case.

Keep v1/v2 labels explicitly non-comparable with v3.

### Window F: verification and evidence

Run focused tests after every window, followed by the complete backend and
frontend suites. Do not accept snapshot-only confidence for scoring logic.

## 8. Required test matrix

### Mathematics

- all confidence inputs at 0, boundary rounding points, and 100;
- contact combinations, including social-only zero points;
- traffic at 0, around 10/100/1,000/10,000/100,000, and above cap;
- finite fractional provider values;
- negative, NaN, Infinity, strings, and overflow rejection;
- exact total of all component maxima is 100;
- component sum always equals total.

### CrUX

- exact good and poor boundaries for LCP, INP, CLS;
- immediately above/below every boundary;
- all good, all needs-improvement, all poor;
- each partial metric subset;
- no coverage, unavailable, contract mismatch, missing row;
- FCP/TTFB/popularity/device fractions cannot affect points;
- input order cannot affect points.

### DataForSEO state semantics

- available worldwide positive traffic;
- available worldwide measured zero;
- partial source with valid worldwide record;
- partial source without worldwide record;
- provider omitted target;
- unavailable, ambiguous, contract mismatch;
- malformed payload or wrong target/domain;
- duplicate worldwide scopes;
- featured/local ETV cannot inflate the traffic input.

### Lead state

- qualified scored v3;
- qualified insufficient-traffic v3;
- rejected and failed v3;
- every invalid version/status/score/breakdown combination;
- v2 fixtures remain unchanged and valid;
- legacy rows remain readable.

### Pipeline and persistence

- qualification result is identical before and after v3;
- results stay unavailable during v3 enrichment;
- successful finalization atomically exposes v3;
- injected failure at every finalization write rolls back all score/version/publication changes;
- lease loss before or during finalization publishes nothing;
- exact updated row-count mismatch fails closed;
- resume from `leads_persisted`;
- resume after DataForSEO publication;
- resume after CrUX REST publication;
- replay after all sources but before finalization;
- identical replay is idempotent;
- conflicting replay fails;
- progressive and atomic paths produce identical canonical results;
- traffic-disabled runs remain v2.

### API, UI, and CSV

- API rejects malformed v3 score states;
- null v3 score is labelled as insufficient traffic, not zero;
- v3 component labels and values are exact;
- sorting places null scores last and does not silently compare v2/v3 as equal
  semantics;
- CSV preserves numeric zero and safely represents null;
- v1/v2/v3 presentation is explicit;
- traffic and CrUX attribution remains intact.

## 9. Baseline verification already completed

No scoring implementation edits were made before this plan was stored.

Backend baseline, run outside the filesystem/network sandbox because HTTP tests
must bind to `127.0.0.1`:

```text
tests: 256
passed: 249
failed: 0
skipped: 7
```

Frontend baseline:

```text
test files: 16
failed: 0
```

The initial sandboxed backend run reported failures only because localhost
listening was denied with `EPERM`. The approved unrestricted backend run was
clean.

## 10. Verification commands

Focused backend examples:

```bash
cd '/home/harit/Email Scrapper/email_scraper'
node --test test/extraction-and-scoring.test.js
node --test test/api-serializer.test.js
node --test test/pipeline.test.js
node --test test/prisma-run-repository.test.js
node --test test/progressive-worker.test.js
node --test test/traffic-orchestration.test.js
```

Complete backend suite (requires permission to bind localhost for server tests):

```bash
cd '/home/harit/Email Scrapper/email_scraper'
npm test
```

Frontend:

```bash
cd '/home/harit/Email Scrapper/frontend'
npm test
npm run lint
npm run build
```

Run Prisma validation/generation if schema or generated-client expectations are
changed. A database column migration is not expected because existing version,
score, and JSON breakdown columns can represent v3, but verify this assumption
before implementation. Do not create an empty or unnecessary migration.

## 11. Completion criteria

The work is complete only when:

- the Section 3 policy is explicitly resolved;
- v3 mathematics and missing-data behavior are versioned and deterministic;
- qualification output is proven unchanged;
- no provisional score is presented as final;
- final score/version/publication is atomic and lease-fenced;
- resume and replay tests prove idempotency;
- v1/v2 compatibility remains intact;
- backend, frontend, contract, CSV, and presentation layers agree;
- all focused tests and complete suites pass against the recorded baseline;
- final handoff names any skipped external-database tests and does not represent
  them as executed.

## 12. Execution record

The Section 3 recommendation was selected when execution was authorized:
DataForSEO-enabled runs produce numeric v3 scores only from a strictly validated
worldwide record; missing or invalid worldwide evidence produces the explicit
`insufficient_traffic_v3` null state. Traffic-disabled runs remain v2.

Implemented:

- strict v3 scoring mathematics and bounded evidence contracts;
- deterministic, order-independent lead/enrichment finalization;
- atomic progressive score replacement and publication under the active lease;
- atomic-path finalization through the same pure scorer;
- publication gating for active/resumed legacy checkpoints and run/lead version
  agreement checks;
- exclusion of unfinished-run leads from the master-leads score view;
- backend/frontend/shared-contract validation and v3 presentation;
- CSV `score_semantics` output so null, zero, and score versions remain distinct;
- failure-before-publication, missing-data, boundary, replay-order, and
  compatibility tests.

Final verification:

```text
Backend: 270 tests, 263 passed, 0 failed, 7 skipped external DB/integration tests
Frontend: 16 test files passed, 0 failed
Frontend production build: passed (Next.js 16.2.12)
Targeted lint for every changed frontend source/test file: passed
Prisma schema validation: passed; no migration required
Secret scan: passed
```

The repository-wide frontend lint command remains blocked by an unrelated
pre-existing `react-hooks/set-state-in-effect` error in
`frontend/components/leads/live-leads-workspace.tsx:32` and an unrelated hook
dependency warning in `frontend/components/traffic-globe.tsx:183`. Neither file
was changed for scoring v3.
