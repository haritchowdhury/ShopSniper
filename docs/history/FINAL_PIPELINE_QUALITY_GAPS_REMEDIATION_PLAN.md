# Final Pipeline Quality Gaps Remediation Plan

Status: **READY FOR IMPLEMENTATION — DO NOT MARK COMPLETE WITHOUT PARENT REVIEW**

Created: 2026-08-01

Budget: one focused 200K-token implementation context, executed sequentially.

## 1. Objective and source of truth

Close the six findings from the independent review of
`PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` without changing the
product's intended lead-generation scope. This document is the authoritative
corrective plan for these findings. The earlier checklist and handoffs remain
historical evidence and must not be rewritten.

Required governing inputs:

- `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md`
- `PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md`, especially Sections
  1-6 and corrective invariants C1-C11
- Current source, schema, migrations, tests, and G-R1 through G-R6 handoffs
- `frontend/AGENTS.md` before any frontend edit

No conversation history is required to execute this plan.

## 2. Locked scope

Included:

1. Require store-associated, outreach-relevant email evidence.
2. Reject phone-like business identifiers regardless of whether their label is
   before or after the number.
3. Prevent broad multi-department stores from becoming specialists through an
   incidental Organization/title/category mention.
4. Preserve every exact category input as a distinct intent through aggregation,
   validation, matching, persistence, API, UI, and export.
5. Enforce status, score, score-breakdown, version, and score-semantics consistency
   at backend persistence/serialization and frontend parsing boundaries.
6. Make the secret scan cover the intended tracked repository and close the
   workflow-export Git-hygiene gap without exposing credential values.

Excluded:

- live storefront or provider calibration;
- changes to scoring weights, Google pagination, query counts, auth, leases,
  worker concurrency, AWS infrastructure, or UI styling;
- production/primary database migrations or writes;
- modifying or deleting the local n8n workflow contents;
- printing, copying, rotating, or revoking credentials; and
- stopping, replacing, or restarting the user's running server.

No Prisma migration is expected. If implementation discovers that a migration
is required, stop and return the evidence to the parent instead of adding one.

## 3. Observed starting failures

All failures below were reproduced deterministically against the current source.

| ID | Severity | Starting reproduction | Current incorrect result |
| --- | --- | --- | --- |
| F1 | High | Broad Organization description lists eyewear alongside toys, electronics, furniture, groceries, and garden products | `specialist` despite recorded broad-store evidence |
| F2 | High | Product/footer contains `support@themevendor.co` with no store association | Accepted as direct email evidence |
| F3 | High | `1234 5678 is your order number. Contact support...` | Extracted as phone `12345678` |
| F4 | Medium | Same store is discovered for `Eyewear Brand` and `Eyewear Brands`, both normalizing to eyewear/brand | One exact intent survives; vocabulary is combined |
| F5 | Medium | Qualified v2 row has null score, or rejected v2 row has a score | Backend/frontend accept contradictory score semantics |
| F6 | Medium operational | Run `npm run check:secrets` from `email_scraper`; inspect Git index | Root/frontend are outside scan scope; old workflow paths remain tracked pending deletion |

These are acceptance fixtures, not examples. Each exact reproduction must become
a regression test before its owning gate can pass.

## 4. Corrective invariants

| ID | Invariant | Owner |
| --- | --- | --- |
| R1 | Direct contact evidence is both syntactically valid and associated with the store/outreach context. | G-R7 |
| R2 | Negative identifier context is evaluated symmetrically around phone candidates and outranks generic contact words. | G-R7 |
| R3 | Specialist status requires category-dominant store identity/assortment evidence and cannot override proven broad-store evidence. | G-R8 |
| R4 | Every exact normalized user input remains a distinct category intent; shared provider/store results never merge intent metadata. | G-R9 |
| R5 | Lead status, score, breakdown, versions, and semantics form one validated state machine across persistence, API, and frontend. | G-R10 |
| R6 | The secret check scans the intended tracked repository without reading expected local secret files or emitting matched values. | G-R11 |

## 5. Execution order and token budget

Execute sequentially:

```text
G-R7 -> G-R8 -> G-R9 -> G-R10 -> G-R11 -> parent acceptance review
```

Suggested maximum allocation inside one 200K context:

| Gate | Budget |
| --- | ---: |
| G-R7 contact integrity | 40K |
| G-R8 specialist classification | 30K |
| G-R9 exact provenance | 25K |
| G-R10 score-state consistency | 25K |
| G-R11 repository hygiene | 20K |
| Full regression and parent review reserve | 60K |

Do not parallelize these gates. G-R9 consumes the final G-R8 store-fit predicate;
G-R10 consumes the corrected pipeline contract; G-R11 runs after all source and
test additions exist.

---

## G-R7 — Store-associated contact evidence and symmetric phone context

Status: **READY**

### Objective

Close F2-F3 and restore R1-R2. A lead may become directly contactable only from a
validated method associated with the store, and business identifiers cannot be
misclassified as phone numbers based on word order.

### Required reading and reproduction

- `email_scraper/src/contact-evidence.js`
- `email_scraper/src/contact-extractor.js`
- `email_scraper/src/ai-normalizer.js`
- `email_scraper/src/pipeline.js`
- `email_scraper/src/lead-scorer.js`
- `email_scraper/test/extraction-and-scoring.test.js`
- `email_scraper/test/pipeline.test.js`
- G-R1 handoff

Reproduce F2-F3 unchanged before editing. Add a full-pipeline fixture proving an
unrelated email or identifier cannot create `direct` contactability or a score.

### Ownership and non-goals

Owned: deterministic email/phone evidence association, validation reasons,
contact consolidation, the narrow pipeline consumption boundary, and focused
tests.

Non-goals: email deliverability/MX checks, country inference, crawling more pages,
social rules, store fit, scoring weights, schema/API/frontend changes.

### Ordered tasks

- [ ] Define explicit email evidence tiers, separating `mailto:`, typed
  Organization/ContactPoint data, and visible text.
- [ ] Require visible-text emails to occur in an accepted store-owned contact,
  about, header, navigation, or footer outreach block with positive contact
  context and without theme/vendor/developer/manufacturer/marketplace credit
  context.
- [ ] Do not treat arbitrary product/blog/policy body emails as store outreach.
- [ ] For structured email/phone values, retain the owning JSON-LD node/path and
  accept only store Organization/OnlineStore/LocalBusiness/ContactPoint evidence;
  do not inherit Product brand/manufacturer/vendor contacts merely because the
  page is same-host.
- [ ] Scan bounded text both before and after every visible phone candidate.
  Compare nearest positive and negative labels; order, invoice, tracking, model,
  SKU, VAT, UPC/EAN/ISBN, quantity, year/range, and reference labels always win
  when attached to the candidate.
- [ ] Preserve strong `tel:` and store Organization/ContactPoint phone evidence.
- [ ] Give every retained email/phone an association-specific validation reason.
- [ ] Ensure AI normalization can select only the corrected deterministic sets.

### Adversarial verification

- [ ] F2 and F3 fail safely.
- [ ] Negative labels before and after the number are rejected, including nearby
  generic `contact`, `call`, or `support` words.
- [ ] Theme/vendor/manufacturer emails in product, footer credit, and JSON-LD
  Product graphs do not qualify.
- [ ] Store-owned `mailto:`, contact-block visible email, `tel:`, and typed
  Organization/ContactPoint values survive.
- [ ] An email in ordinary prose without ownership/context is not direct evidence.
- [ ] An unrelated email/number produces a rejected, null-score pipeline row when
  no other direct or indirect contact method exists.
- [ ] Existing form-only indirect qualification remains unchanged.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/extraction-and-scoring.test.js test/pipeline.test.js
npm test
npx prisma validate
git diff --check
```

Acceptance requires exact runtime tests for F2-F3, positive direct-method fixtures,
and source confirmation that contactability/scoring consume only retained
associated evidence.

### Handoff

Record changed files, new fixtures/tests, commands/results, skips, and residual
risks in `email_scraper/review-evidence/G-R7_HANDOFF.md`. Do not begin G-R8 until
G-R7 passes.

---

## G-R8 — Broad-store-resistant specialist classification

Status: **BLOCKED BY G-R7**

### Objective

Close F1 and restore R3 without reducing true category-focused brands to unknown.

### Required reading and reproduction

- `email_scraper/src/storefront-validator.js`
- `email_scraper/src/page-fetcher.js`
- `email_scraper/src/pipeline.js`
- `email_scraper/test/validation-and-security.test.js`
- `email_scraper/test/pipeline.test.js`
- G-R2 handoff and G-R7 handoff

Reproduce F1 unchanged before editing.

### Ownership and non-goals

Owned: store-fit signal classification, breadth/negative-evidence precedence,
specialist decision reasons, and focused controlled fixtures.

Non-goals: live calibration, category vocabulary generation, contact logic,
Shopify/activity detection, page budgets, score weights, persistence/frontend.

### Ordered tasks

- [ ] Split strong store identity/category claims from incidental Organization
  fields. A name/description/heading containing a category term is not by itself
  a dominant-category claim.
- [ ] Define a strong claim using explicit typed category/knowsAbout evidence or
  category-dominant site identity plus corroborating navigation/assortment.
- [ ] Make proven broad multi-department evidence block one weak claim from
  promoting `category_seller` to `specialist`.
- [ ] Require either a strong exclusive category claim or two independent
  category-dominant assortment signal kinds with no contradictory breadth.
- [ ] Preserve evidence describing which claim, page, signal, and negative term
  controlled the decision.
- [ ] Keep `unknown`, `mismatch`, `category_seller`, and `specialist` distinct.

### Adversarial verification

- [ ] F1 returns `category_seller`, and brand intent rejects it as
  `wrong_store_type`.
- [ ] General stores remain non-specialist when a category appears in title, H1,
  Organization description, navigation, collection link, or promotional copy.
- [ ] A genuine specialist with explicit category identity and corroborating
  assortment remains specialist.
- [ ] Retailer/unspecified intent can still accept a truthful category seller.
- [ ] Reversing page/evidence order does not change the result.
- [ ] Existing activity, rejection precedence, and Browserless tests remain green.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/validation-and-security.test.js test/pipeline.test.js
npm test
npx prisma validate
git diff --check
```

Acceptance requires the exact broad Organization reproduction and at least two
positive specialist constructions using independent evidence paths.

### Handoff

Create `email_scraper/review-evidence/G-R8_HANDOFF.md` and stop before G-R9.

---

## G-R9 — Lossless exact category-intent provenance

Status: **BLOCKED BY G-R8**

### Objective

Close F4 and restore R4. Exact input differences may share provider/store data,
but never share or overwrite intent metadata.

### Required reading and reproduction

- `email_scraper/src/category-input.js`
- `email_scraper/src/query-cache.js`
- `email_scraper/src/query-prober.js`
- `email_scraper/src/query-planner.js`
- `email_scraper/src/discovery-aggregation.js`
- `email_scraper/src/storefront-validator.js`
- `email_scraper/src/pipeline.js`
- related category/planning/pipeline tests
- G-R3 and G-R8 handoffs

Reproduce F4 unchanged before editing.

### Ownership and non-goals

Owned: category-intent identity key, per-intent vocabulary/provenance aggregation,
matched-category construction, deterministic ordering, and focused tests.

Non-goals: provider calls, query ranking weights, store-fit policy changes,
schema migration, UI changes.

### Ordered tasks

- [ ] Define one canonical intent key containing exact normalized
  `originalShopType`, normalized `shopType`, and `businessQualifier`.
- [ ] Use that key everywhere intent metadata is grouped, sorted, deduplicated, or
  selected.
- [ ] Keep `categoryVocabulary` candidate/intent-specific; never union vocabulary
  between distinct exact inputs.
- [ ] Continue sharing only candidate-independent provider pages and established
  store identity aliases.
- [ ] Validate every distinct intent independently with G-R8's final predicate.
- [ ] Preserve every attempt in `discovery_occurrences`, every decision in
  `store_fit_evidence`, and every accepted exact intent in `matched_categories`.
- [ ] Keep primary display-intent selection deterministic and order-independent.

### Adversarial verification

- [ ] F4 produces two category intents, two fit decisions, and—when both pass—two
  matched-category entries.
- [ ] The two intents keep separate vocabulary, reasons, source URLs, query score,
  qualifier, and original input while sharing one provider/store result where
  appropriate.
- [ ] Same exact intent duplicates collapse without losing occurrence history.
- [ ] Reversing candidates and occurrences produces identical serialized output.
- [ ] A matching and mismatching exact input produce one matched category and two
  complete attempts.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/category-and-query-planning.test.js test/pipeline.test.js
npm test
npx prisma validate
git diff --check
```

Acceptance requires F4 to pass at aggregation and full-pipeline/API-record levels.

### Handoff

Create `email_scraper/review-evidence/G-R9_HANDOFF.md` and stop before G-R10.

---

## G-R10 — One score-state contract across backend and frontend

Status: **BLOCKED BY G-R9**

### Objective

Close F5 and restore R5. Contradictory persisted or API lead states must fail
closed instead of receiving a plausible label.

### Locked state machine

For newly versioned v2 rows:

| Status | `leadScore` | `scoreBreakdown` | Semantics |
| --- | --- | --- | --- |
| `qualified` | finite integer in the documented range | required v2 breakdown whose total equals score | `evidence_rank_v2` |
| `rejected` | null | null | `not_scored_v2` |
| `failed` | null | null | `not_scored_v2` |

Historical unversioned rows alone use `legacy_v1`; preserve their historical
score/null combinations without reclassification.

### Required reading and reproduction

- backend pipeline, scorer, serializer, repository mapper, schema, CSV tests
- frontend API types, runtime validation, score presentation, component tests
- `frontend/AGENTS.md` and relevant installed Next.js guidance before editing
- G-R4, G-R5, and G-R9 handoffs

Reproduce both contradictory directions from F5 before editing.

### Ownership and non-goals

Owned: backend lead-state validator, persistence/serialization boundary,
frontend runtime parser/presentation failure behavior, fixtures, tests.

Non-goals: scoring weights, historical data rewrite, migration, UI styling, auth.

### Ordered tasks

- [ ] Implement one backend invariant validator used before persistence and/or
  serialization so invalid new v2 states cannot be silently published.
- [ ] Require score breakdown version/total consistency for scored v2 leads.
- [ ] Reject non-finite, fractional, negative, or out-of-range lead scores where
  the current scoring contract requires an integer 0-100.
- [ ] Preserve true unversioned legacy behavior explicitly.
- [ ] Mirror the complete cross-field state machine in frontend runtime parsing.
- [ ] Ensure a malformed result page fails as one safe response; do not partially
  display contradictory rows.
- [ ] Keep backend/frontend CSV semantics derivable from versions/status/score;
  append an explicit `score_semantics` column only if the existing append-only
  contract requires it, and update both paths together if so.

### Adversarial verification

- [ ] Qualified v2 null score, missing/mismatched breakdown, and not-scored label
  fail closed.
- [ ] Rejected/failed v2 non-null score, breakdown, or evidence-rank label fail
  closed.
- [ ] Valid scored, rejected, failed, and legacy rows pass.
- [ ] Backend serializer and frontend parser agree for every state-machine row.
- [ ] Malformed rows cannot appear in the actual expanded component or CSV export.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/pipeline.test.js test/api-serializer.test.js test/prisma-run-repository.test.js test/server.test.js test/csv.test.js
npm test
npx prisma validate
cd "/home/harit/Email Scrapper/frontend"
npm run lint
npm test
npx tsc --noEmit
npm run build
git diff --check
```

Acceptance requires a table-driven shared fixture covering every valid and invalid
state, plus actual backend and frontend boundary tests.

### Handoff

Create `frontend/review-evidence/G-R10_HANDOFF.md`, listing backend and frontend
files separately, then stop before G-R11.

---

## G-R11 — Repository-wide redacted secret and workflow hygiene

Status: **BLOCKED BY G-R10**

### Objective

Close F6 and restore R6 without scanning or displaying expected local secrets.

### Required reading and reproduction

- root and project `.gitignore` files
- `email_scraper/scripts/check-secrets.js`
- `email_scraper/test/secret-scan.test.js`
- package scripts and current `git status`, `git ls-files`, and `git check-ignore`
- G-R6 and G-R10 handoffs

Never print workflow contents or matched credential values.

### Ownership and non-goals

Owned: scanner root/scope, tracked-file enumeration or equivalent deterministic
scope, exclusions, package command, ignore rules, redacted tests/docs.

Non-goals: workflow-content edits/deletion, history rewriting, credential
rotation/revocation, provider calls, committing or staging unrelated files.

### Ordered tasks

- [ ] Make the scan root independent of caller working directory, or enumerate
  tracked/candidate files from the repository root using one documented contract.
- [ ] Cover root, backend, and frontend source/config/documentation that could be
  committed.
- [ ] Exclude `.git`, dependencies, build output, explicitly local env files, and
  the two exact ignored workflow exports without broad secret-file globs.
- [ ] Keep findings limited to pattern class, repository-relative path, and line;
  never return matched values or surrounding content.
- [ ] Prove the scanner detects controlled fixtures in root/backend/frontend and
  accepts placeholders.
- [ ] Prove the new workflow paths are ignored and ordinary source, migrations,
  fixtures, `.env.example`, and handoffs are not hidden.
- [ ] Record that the old tracked workflow paths disappear only when the project
  rename/deletions are committed. Do not stage or commit without authorization.
- [ ] Retain credential rotation/revocation as an external deployment blocker.

### Adversarial verification

- [ ] Running the command from root, backend, and frontend yields the same scope
  and result.
- [ ] A controlled credential assignment in each project area is detected with no
  matched value in output.
- [ ] Expected ignored local secret files are not read.
- [ ] Similar filenames in nested/unrelated paths are not accidentally hidden.
- [ ] `git check-ignore` and `git ls-files` evidence is recorded without printing
  workflow contents.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper"
npm --prefix email_scraper run check:secrets
git check-ignore -v "email_scraper/My workflow 3.json"
git check-ignore -v "email_scraper/My workflow 4.json"
git ls-files -- "Email Scrapper/My workflow 3.json" "Email Scrapper/My workflow 4.json" "email_scraper/My workflow 3.json" "email_scraper/My workflow 4.json"
cd email_scraper
node --test test/secret-scan.test.js
npm test
git diff --check
git status --short
```

Acceptance requires repository-wide deterministic scope and redacted positive/
negative tests. It does not require or claim credential rotation.

### Handoff

Create `email_scraper/review-evidence/G-R11_HANDOFF.md` and stop. Do not perform
the parent acceptance review in the same implementation handoff.

---

## 6. Final parent acceptance review

The parent must independently inspect current source and test quality; handoff
claims are navigation aids only.

### Exact reproduction matrix

- [ ] F1 broad marketplace is not specialist.
- [ ] F2 unrelated theme/vendor email is not direct contact evidence.
- [ ] F3 trailing order label prevents phone extraction.
- [ ] F4 both exact category inputs survive independently.
- [ ] F5 contradictory score states fail at backend and frontend boundaries.
- [ ] F6 secret scan covers the repository and workflow Git state is truthful.

### Original-regression matrix

- [ ] Empty/soft-404 contact route remains rejected.
- [ ] Positive same-store form/email/phone fixtures remain usable.
- [ ] Incidental opening-soon copy remains active; real password page remains
  inactive.
- [ ] Browserless redirect attribution and streamed byte limits remain safe.
- [ ] Query cache remains candidate-specific.
- [ ] `matched_categories` contains accepted exact intents only.
- [ ] Fractional query score, migration replay, rollback, terminal idempotency,
  lease concurrency, recovery, and stale-token fencing pass on the disposable
  PostgreSQL database with zero skips.
- [ ] Expanded UI shows all evidence and stale expansion remains impossible.
- [ ] Backend and frontend CSV formula protection remains intact.

### Full commands

```bash
cd "/home/harit/Email Scrapper/email_scraper"
npm test
npx prisma validate
ALLOW_DATABASE_TESTS=true npm run test:integration
npm run check:secrets
cd "/home/harit/Email Scrapper/frontend"
npm run lint
npm test
npx tsc --noEmit
npm run build
cd "/home/harit/Email Scrapper"
git diff --check
git status --short
```

Database integration must use only the already designated disposable
`TEST_DATABASE_URL`. A skipped database suite blocks acceptance. Backend server
tests and the Next.js build may require permission for temporary localhost ports;
that environmental requirement must be reported separately from code failures.

## 7. Completion criteria and residual external blocker

This plan is complete only when:

- all five gates have implementation evidence;
- the parent independently reproduces all six corrected behaviors;
- focused and full suites pass;
- database integration passes with zero skips;
- no source/provider contract is guessed;
- no new pipeline inconsistency is found; and
- no live/production claim exceeds what was tested.

Provider-side rotation/revocation of credential-shaped values referenced by the
local n8n exports remains a user-controlled deployment prerequisite. Local code,
ignore rules, and scanning cannot prove rotation. Do not mark that external action
complete without explicit user confirmation.

## 8. Assignment instruction

Use this exact boundary for an implementation agent:

```text
Execute FINAL_PIPELINE_QUALITY_GAPS_REMEDIATION_PLAN.md sequentially from G-R7
through G-R11 within one focused 200K context. Verify each dependency before
editing and stay inside each ownership boundary. Add every exact reproduction as
a deterministic regression test. Preserve the dirty worktree and completed
G-R1-G-R6 history. Do not call live providers/storefronts, use a production
database, alter n8n workflow contents, rotate credentials, deploy, stage/commit
unrelated files, or stop running servers. Produce the required handoff after each
gate. Stop after G-R11; do not perform or claim the independent parent review.
```
