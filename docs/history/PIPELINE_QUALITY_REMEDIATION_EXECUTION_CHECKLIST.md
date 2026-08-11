# Pipeline Quality Remediation Execution Checklist

Status: **READY FOR SEQUENTIAL IMPLEMENTATION**

Created: 2026-07-31

This is the authoritative product and technical contract for correcting the
lead-generation quality issues recorded in this repository. Fresh implementation
agents must be able to execute one assigned window from this document and the
current source without relying on conversation history.

No implementation is authorized by this checklist itself. Each implementation
agent must be explicitly assigned exactly one window.

## 1. Source of truth

Authoritative execution contract:

- `PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` — this document.

Supporting evidence, not an alternative contract:

- `email_scraper/PIPELINE_QUALITY_CODE_REVIEW.md` — observed defects,
  reproductions, latest-run examples, and initial recommendations.
- `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md` — checklist authoring and review
  framework.
- Current source and tests under `email_scraper/` and `frontend/`.
- `frontend/AGENTS.md` — mandatory frontend implementation guidance. Any agent
  editing the Next.js application must read the relevant installed documentation
  under `frontend/node_modules/next/dist/docs/` before editing.

Existing architecture and historical planning documents remain useful background,
but they are not execution contracts for this remediation. Where they conflict
with this checklist, this checklist controls.

## 2. Current-state evidence

### Observed

- The reviewed completed eyewear run had 78 rows: 62 qualified, 14 rejected,
  and 2 failed.
- `ENABLE_AI_NORMALIZATION=false` for that run.
- A product URL containing `support` qualified The Southernist as a contact-page-
  only lead.
- Product, collection, blog, and asset paths containing `contact`, `support`, or
  `help` can be classified as contact pages.
- An eight-digit product code can be extracted as a phone number.
- Google result title/snippet terms can produce storefront relevance `100` even
  when independently fetched HTML is unrelated.
- A cross-domain canonical can become the resolved store identity with confidence
  `100` without ownership verification.
- Generic social share links and Shopify-owned social accounts are stored as
  store profiles.
- Store names can come from `Product.name` rather than organization/site identity.
- `Eyewear Brand` currently normalizes to `eyewear`, losing the requested business
  qualifier.
- Store deduplication retains the first discovery occurrence and discards later
  category/query evidence.
- Initial storefront validation does not use the Browserless fallback.
- The compact frontend chooses email over phone; the expanded view omits phone,
  phone source, actual contact values, and social profiles.
- Backend verification completed with 44 passing tests and one explicitly skipped
  database integration test. Frontend verification completed with 2 passing tests.

### Inferred, requiring implementation-time evidence

- A material portion of high-scoring phone values sourced from product pages may
  be SKUs or unrelated numbers. Agents must use controlled fixtures to prove the
  new extraction behavior; inference alone must not blacklist real contacts.
- Specialist-brand classification will improve lead precision, but exact live
  precision cannot be claimed until a post-implementation labeled probe is
  reviewed.

### Unknown or deliberately deferred

- No production-quality labeled dataset currently defines a calibrated score
  threshold. Window G3 must make scoring explainable and versioned, but must not
  claim statistically calibrated precision.
- No automatic rewrite of historical runs is authorized. Existing run and lead
  records must be preserved and identified as legacy/unversioned where applicable.
- Applying a migration to the user's configured live Neon database is not
  authorized by this checklist. Agents may generate and validate forward-only
  migrations locally or against an explicitly designated test database.
- External live Google, OpenAI, Browserless, or storefront probes are not required
  for local acceptance and must not be run unless explicitly authorized. Controlled
  provider fixtures are required instead.
- Traffic enrichment remains parked and is outside this remediation.

## 3. Locked product contract

### 3.1 User-visible outcome

For a requested category such as `eyewear brand`, the system must return Shopify
stores that satisfy the requested store-type intent, have independently verified
category evidence, and expose a validated outreach method. The UI must truthfully
show every collected contact method and its source without presenting missing or
unverified data as available.

### 3.2 Included behavior

- Preserve broad category and business qualifier separately.
- Strictly parse active Google and OpenAI response contracts with versioned,
  sanitized fixtures.
- Resolve store identity without trusting unrelated canonical hosts.
- Use rendered fetching for initial storefront evidence when deterministic HTML is
  insufficient, blocked, or suspicious.
- Rank and bound page discovery so the best contact and store-fit evidence is
  examined.
- Extract and validate organization name, email, phone, contact page, and social
  profiles with source provenance and confidence.
- Calculate category fit from fetched evidence, not Google metadata.
- Merge duplicate discovery occurrences and preserve all category/query provenance.
- Persist query audits and operational diagnostics separately from store leads.
- Produce versioned, explainable lead scores only after mandatory validation gates.
- Preserve existing runs and support legacy rows without destructive backfill.
- Display all collected lead evidence in the expanded frontend view.

### 3.3 Explicit exclusions

- Traffic estimation or third-party traffic enrichment.
- Automatic production migration deployment.
- Destructive cleanup or reclassification of existing run history.
- New authentication providers or changes to current ownership semantics.
- Automatic email deliverability verification or outbound email sending.
- Unbounded Google pagination, crawling, retries, or concurrency.
- A claim that score v2 is statistically calibrated before labeled live review.

### 3.4 Category contract

Normalized category input must preserve at least:

```text
originalShopType  Original user text after safe whitespace normalization.
shopType          Core product category used for research and query generation.
businessQualifier `brand`, `retailer`, or `unspecified`.
```

Trailing `brand`/`brands` maps to `businessQualifier=brand`; it must not disappear.
Existing aliases may normalize the core category but cannot erase the qualifier.

Store fit must be one of:

```text
specialist        Store/organization is primarily associated with the category.
category_seller   Store sells the category but is not proven to specialize in it.
mismatch          Fetched evidence contradicts the requested category/store type.
unknown           Evidence is insufficient or blocked.
```

- `brand` input requires `specialist` to qualify.
- `retailer` accepts `specialist` or `category_seller`.
- `unspecified` accepts `specialist` or `category_seller`.
- `mismatch` is rejected as `wrong_category` or `wrong_store_type`.
- `unknown` cannot silently qualify; it is rejected with an evidence-insufficient
  reason unless the store-processing operation itself failed.

Store fit must be based on fetched homepage, organization/site metadata,
navigation/collection evidence, and available product assortment evidence. Google
title/snippet may be retained only as discovery provenance.

### 3.5 Contact evidence contract

Contact evidence methods:

```text
email             Syntactically valid, source-proven, non-placeholder email.
phone             Source-proven structured/tel/contextual phone candidate.
contact_page      Same-store, route-validated contact/support/help page or form.
social_profile    Valid store profile, excluding share/intent/vendor/platform URLs.
```

Contactability tier:

```text
direct            At least one validated email or phone.
indirect          No direct contact, but a validated contact page/form exists.
research_only     Only validated social or organizational evidence exists.
none              No validated outreach evidence exists.
```

Qualification rules:

- `qualified`: active Shopify store, accepted store fit, and contactability
  `direct` or `indirect`.
- `rejected`: inactive/not-Shopify/wrong-category/wrong-store-type/insufficient
  evidence, or contactability `research_only`/`none`.
- `failed`: an operation failed before a reliable store decision could be made.

Social profiles alone do not qualify a lead. A contact page must use an explicitly
accepted page/policy route. Product, collection, blog, search, cart, account, CDN,
asset, and arbitrary keyword-containing paths never count as contact pages.

### 3.6 Identity contract

- Prefer a verified MyShopify hostname as the stable deduplication identity when
  available.
- A redirect-observed custom domain may be associated with that identity.
- A cross-domain canonical is evidence only until independently fetched and
  verified as the same Shopify storefront.
- An unverified host must never enter the allowed fetch-host set or receive maximum
  identity confidence.
- Identity evidence and confidence must be persisted or included in the score
  breakdown.

### 3.7 Score contract

- Introduce `scoringVersion=2` for newly processed leads.
- Persist a score breakdown containing store identity, Shopify validation,
  category fit, and validated contact evidence components.
- Invalid/inactive/mismatched/insufficient store records receive `leadScore=null`.
- Only validated contact evidence contributes contact points.
- The UI must not describe the score as a probability.
- Historical rows without a version remain readable as legacy score v1 records.

### 3.8 Result and diagnostic contract

- The lead collection contains one row per resolved/merged store outcome.
- Query generation/probe failures, empty queries, invalid search URLs, and
  unresolved search occurrences are persisted as query audits or run diagnostics,
  not unnamed store leads.
- `summary.total` counts store lead rows only and remains equal to the sum of
  qualified, rejected, and failed store rows.
- Progress may separately count query/occurrence failures.
- HTTP runs persist query selection and rejection evidence needed to explain which
  queries were used.

### 3.9 Historical-data and migration policy

- Migrations are additive and forward-only.
- Existing `Run` and `Lead` rows are never deleted, rewritten, or silently
  reclassified.
- New fields are nullable or have compatibility-safe defaults.
- New runs carry a pipeline/scoring version; old rows render as legacy.
- CSV fields already present retain their names and ordering. New fields are
  appended so existing consumers do not shift columns.
- Migration replay and preservation must be tested against a disposable database
  fixture or explicitly designated test database.

### 3.10 Ownership and authorization

- Existing run ownership and Neon Auth boundaries remain unchanged.
- Browser clients never choose trusted backend user IDs or service tokens.
- New query-audit/diagnostic endpoints and records must enforce the same run-owner
  filter as lead results.
- Logs, fixtures, and handoff evidence must contain no API keys, database
  credentials, auth cookies, actual secrets, or raw provider payloads containing
  sensitive data.

## 4. End-to-end lifecycle

1. Authenticated or claimable run input enters category normalization.
2. Category text is strictly validated and normalized into core category plus
   business qualifier.
3. The query planner consumes a strict OpenAI response contract or an explicit
   deterministic fallback and produces validated candidate queries.
4. Google responses pass a strict versioned adapter. The probe scores query
   coverage and distinct store hosts without treating one generic term or unused
   pagination as sufficient evidence.
5. Selected result occurrences are retained as provenance. Asset/invalid results
   become diagnostics rather than leads.
6. Store identity is resolved from observed redirects and verified Shopify
   evidence. Unverified canonicals remain untrusted.
7. Occurrences sharing a stable identity are merged; all categories, queries,
   ranks, and URLs are retained.
8. A best representative page and homepage are fetched. Browserless is used only
   through the bounded fallback contract when ordinary evidence is insufficient or
   blocked.
9. Page discovery prioritizes homepage, explicit contact routes, organization/about
   evidence, and relevant collection/product evidence within fixed page and
   concurrency limits.
10. Store activity, Shopify status, and store/category fit are determined solely
    from fetched evidence.
11. Organization and contact evidence is extracted, normalized, validated, ranked,
    and linked to source pages.
12. Contactability tier and mandatory qualification gates are applied.
13. Score v2 is calculated only for a valid, category-matching store and records its
    component breakdown.
14. Store leads, query audits, diagnostics, run summary, and terminal run state are
    committed under one transaction or an explicitly tested recoverable protocol.
15. The owner-scoped API returns backward-compatible lead fields plus new evidence.
16. The frontend shows truthful compact state and every available field in the
    expanded view; CSV export includes the full dataset.

Failure between durable steps must either leave the run retryable/queued or mark it
failed without partially publishing `resultsAvailable=true`. Process restart and
retry must not duplicate store rows, audits, or diagnostics.

## 5. Cross-window safety invariants

| ID | Invariant | Owning window |
| --- | --- | --- |
| I1 | Product/collection/blog/asset URLs never become contact pages. | G1 |
| I2 | Unverified numbers and generic social links never qualify or score a lead. | G1 |
| I3 | Product names never override a proven organization/site name. | G1 |
| I4 | Unverified canonical hosts never become trusted identity or fetch scope. | G1 |
| I5 | Active external response shapes are strict, versioned, fixture-backed contracts. | G1, G2 |
| I6 | Google discovery metadata cannot validate storefront/category relevance. | G2 |
| I7 | Brand/retailer intent survives normalization and controls store-fit acceptance. | G2 |
| I8 | Initial validation renders only when bounded fallback criteria require it. | G2 |
| I9 | Page budgets prioritize the evidence needed for store fit and contactability. | G2 |
| I10 | Duplicate occurrences merge without losing categories, queries, ranks, or evidence. | G3 |
| I11 | Qualification and score v2 consume only validated G1/G2 evidence. | G3 |
| I12 | Operational diagnostics are not counted or rendered as unnamed leads. | G3 |
| I13 | New durable writes are atomic/idempotent and existing data is preserved. | G3 |
| I14 | API ownership isolation remains true for leads, audits, and diagnostics. | G3 |
| I15 | Expanded UI exposes all collected contact evidence and does not fake missing links. | G4 |
| I16 | Legacy rows remain readable and are clearly distinguished where scoring semantics differ. | G3, G4 |

## 6. Worktree preservation

The current repository is intentionally dirty because the old tracked
`Email Scrapper/` project appears deleted while `email_scraper/` and `frontend/`
are new/untracked paths, alongside existing root documentation changes.

Every agent must:

- treat all existing changes as user-owned;
- never reset, restore, clean, or delete the old/new paths;
- avoid broad formatting or generated-file churn;
- inspect `git status --short` before and after its window;
- report only files it intentionally changed; and
- stop if required work would overwrite an overlapping user change whose intent
  cannot be determined.

## 7. Execution sequence and budget

Four sequential implementation windows are required. Each is capped at one 100K
context window; expected actual use is lower. G2 consumes G1 contracts, G3 consumes
G1 and G2, and G4 consumes the persisted/API contract from G3. Do not parallelize
these implementation windows.

The later parent reliability review is not an implementation window. It must be
performed independently after G1-G4, and any gaps must be handled through append-
only corrective windows such as `G-R1`.

---

## Window G1 — Trusted contact and store identity evidence

Status: **COMPLETE — VERIFIED 2026-07-31**

Evidence: `email_scraper/review-evidence/G1_HANDOFF.md`

### Objective

Create strict, reusable evidence primitives so only validated contact methods,
organization names, social profiles, and store identities can reach later pipeline
stages.

### Dependencies and preconditions

- No prior implementation window.
- Read Sections 1-6 of this checklist completely.
- Read `email_scraper/PIPELINE_QUALITY_CODE_REVIEW.md`.
- Confirm the dirty-worktree preservation rules before editing.
- No live external calls or production migration.

### Required reading and starting evidence

- `email_scraper/src/contact-extractor.js`
- `email_scraper/src/ai-normalizer.js`
- `email_scraper/src/domain-resolver.js`
- `email_scraper/src/url-security.js`
- `email_scraper/src/html.js`
- `email_scraper/src/http-client.js`
- `email_scraper/src/lead-scorer.js` for consumption context only
- `email_scraper/test/extraction-and-scoring.test.js`
- `email_scraper/test/domain-and-sitemap.test.js`
- `email_scraper/test/validation-and-security.test.js`

Reproduce before editing:

- product slug containing `support` becomes `contactUrl`;
- eight-digit product code becomes a phone;
- generic share URLs become social profiles;
- cross-domain canonical becomes trusted resolved identity;
- `Product.name` can become store name.

### Ownership and non-goals

Owned areas:

- Contact/organization extraction and normalization modules.
- Contact-route and social-profile validators.
- Store identity/canonical trust logic.
- Strict AI-normalization response adapter and sanitized fixtures.
- Focused evidence and identity tests.
- `package.json`/lockfile only if a strict schema dependency is required.

May touch narrowly:

- `src/url-security.js` and `src/html.js` for shared primitives.
- Function signatures consumed later, provided compatibility adapters keep the
  current pipeline running until G3.

Non-goals:

- Do not change final pipeline status, persistence schema, query planning,
  storefront relevance, frontend, or score weights.
- Do not start G2 work.

### Contracts and ordered tasks

- [ ] Define normalized evidence objects with value, source URL, method, confidence,
  and validation reason.
- [ ] Implement one strict contact-route classifier. Explicitly distinguish
  qualifying contact pages from useful non-contact evidence pages.
- [ ] Reject product, collection, blog, search, account, cart, CDN, and asset paths
  before keyword evaluation.
- [ ] Validate AI-normalized contact URLs through the same classifier; remove the
  current any-examined-page allowance.
- [ ] Make phone extraction source-aware: structured `telephone` and `tel:` are
  strong; contextual free-text candidates require a verified contact context.
- [ ] Add non-placeholder email validation and evidence ranking without inventing
  values.
- [ ] Implement social-profile path validation and reject share/intent/vendor/root
  URLs.
- [ ] Extract organization/site names by structured-data type and prevent
  `Product.name` from becoming the store name.
- [ ] Prevent unverified cross-domain canonicals from becoming resolved identity,
  confidence, or allowed fetch hosts.
- [ ] Add a strict, versioned parser for the active AI normalization response shape
  with sanitized positive and negative fixtures. Keep raw provider shapes inside
  the adapter.
- [ ] Preserve compatibility for current callers until G3 integrates the new
  evidence model.

### Adversarial verification

- [ ] Product/collection/blog/CDN paths containing every contact keyword are
  rejected as contact routes.
- [ ] Valid localized `/pages/contact-us` and
  `/policies/contact-information` examples pass.
- [ ] Malformed, cross-host, credential-bearing, unsupported-scheme, and missing
  source URLs fail safely.
- [ ] Product/SKU/order numbers do not become phones; valid `tel:` and structured
  international/local examples remain available with method/confidence.
- [ ] Share links, Pinterest creation URLs, Shopify-owned accounts, platform roots,
  and login/intent URLs are rejected.
- [ ] Organization/WebSite names beat Product names independent of JSON-LD order.
- [ ] Same-host canonicals remain usable; unverified cross-host canonicals remain
  evidence-only.
- [ ] Missing/malformed/additive AI fields follow the documented parser extension
  policy and cannot silently change behavior.
- [ ] Logs and fixtures contain no secrets or real collected contact values.

### Required commands

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/extraction-and-scoring.test.js
node --test test/domain-and-sitemap.test.js test/validation-and-security.test.js
npm test
git diff --check
git status --short
```

The server test may need permission to bind temporary loopback ports. Do not stop
the user's running servers.

### Acceptance

- Controlled runtime tests prove all five starting reproductions no longer pass.
- Valid contact methods and same-store identity still pass positive fixtures.
- One validator owns contact-route acceptance for deterministic and AI paths.
- No unverified canonical host is returned in `allowedHostnames`.
- Existing pipeline tests remain compatible without weakening the new validators.
- No external provider field is consumed outside its strict adapter.

### Handoff and stop condition

Create `email_scraper/review-evidence/G1_HANDOFF.md` containing changed files,
tests added, exact commands/results, fixture locations, skipped checks/reasons,
residual risks, and confirmation that G2-G4 were not started. Update only G1's
status/evidence in this checklist, then stop.

---

## Window G2 — Category intent, query quality, rendering, and store fit

Status: **COMPLETE — VERIFIED 2026-07-31**

Evidence: `email_scraper/review-evidence/G2_HANDOFF.md`

### Objective

Make discovery and storefront validation independently prove category/store-type
fit, use strict provider contracts, and spend the bounded page/render budget on the
best evidence.

### Dependencies and preconditions

- G1 accepted with `email_scraper/review-evidence/G1_HANDOFF.md` present.
- Read G1's final public evidence contracts and do not redefine them.
- No live external calls or production migration.

### Required reading and starting evidence

- G1 handoff and changed evidence modules.
- `email_scraper/src/category-input.js`
- `email_scraper/src/category-researcher.js`
- `email_scraper/src/query-generator.js`
- `email_scraper/src/query-validator.js`
- `email_scraper/src/query-prober.js`
- `email_scraper/src/query-ranker.js`
- `email_scraper/src/query-planner.js`
- `email_scraper/src/search.js`
- `email_scraper/src/openai-responses.js`
- `email_scraper/src/domain-resolver.js`
- `email_scraper/src/storefront-validator.js`
- `email_scraper/src/page-fetcher.js`
- `email_scraper/src/sitemap.js`
- Related query, page-fetcher, sitemap, and validation tests.

Reproduce before editing:

- `Eyewear Brand` loses the brand qualifier;
- Google title/snippet alone makes unrelated HTML relevance 100;
- one query term can mark a probe result relevant;
- initial validation does not render an insufficient JavaScript storefront;
- a misleading candidate URL can consume page budget before contact evidence.

### Ownership and non-goals

Owned areas:

- Category normalization contract and query-planning inputs.
- Google and OpenAI query-planning adapters/fixtures.
- Query validation/probe/ranking logic.
- Initial fetching/render fallback behavior.
- Storefront Shopify/activity/category/store-fit validation.
- Evidence-page discovery, ranking, budgets, and bounded per-store fetch plan.
- Focused discovery/store-fit tests.

May touch narrowly:

- G1 evidence contracts only to consume them. Contract-changing gaps require a stop
  and parent decision, not an unrecorded rewrite.

Non-goals:

- Do not implement deduplication aggregation, persistence migrations, final score
  v2, API/frontend changes, or G3/G4 work.

### Contracts and ordered tasks

- [ ] Preserve `businessQualifier` during HTTP and CSV category normalization.
- [ ] Keep core `shopType` suitable for product-query research while passing the
  qualifier to later store-fit validation.
- [ ] Add strict, versioned Google Custom Search and OpenAI Responses parsers with
  sanitized positive/negative fixtures; eliminate permissive field fallback.
- [ ] Improve query probe relevance to require meaningful phrase/multi-term
  coverage and stop awarding a pagination bonus that is not consumed.
- [ ] Catalogue how candidate confidence and source URLs affect ranking; either
  validate and use them or intentionally ignore them without fixed unsupported
  bonuses.
- [ ] Ensure selected-result reuse still avoids duplicate Google calls.
- [ ] Remove Google title/snippet from storefront/category validation inputs.
- [ ] Produce a normalized store-fit result with state, score/evidence, matched
  terms, and source URLs.
- [ ] Enforce the category/business-qualifier matrix from Section 3.4.
- [ ] Route the initial representative page/homepage through the bounded
  ordinary-then-rendered fetch policy when evidence is insufficient, blocked, or
  suspicious.
- [ ] Distinguish inactive, insufficient evidence, challenge/block, not-Shopify,
  category mismatch, and fetch failure.
- [ ] Rank page candidates before truncation: homepage, explicit contact,
  support/help, organization/about, relevant collection/product, then policy.
- [ ] Ensure original/final duplicates do not consume multiple budget slots.
- [ ] Add bounded per-store evidence fetch concurrency while preserving output
  determinism and public-host validation.

### Adversarial verification

- [ ] Brand, retailer, unspecified, aliases, duplicates, malformed categories, and
  instruction-like input are covered.
- [ ] A general store with one matching product is `category_seller`, not
  `specialist`; it cannot satisfy a `brand` request.
- [ ] A specialist store can qualify from fetched homepage/collection evidence even
  if Google metadata is absent.
- [ ] Google metadata alone cannot move store fit or relevance.
- [ ] One generic term cannot make a 10-result probe relevant.
- [ ] Missing/malformed/contract-drift provider responses fail with typed,
  privacy-safe errors and do not trigger envelope guessing.
- [ ] Ordinary HTML success, JS shell, challenge page, password page, Browserless
  success/failure, redirect, timeout, and size limits are covered.
- [ ] Page ordering retains the explicit contact page under a full budget and never
  prioritizes product slugs merely containing contact keywords.
- [ ] Concurrency is bounded under success and partial failure; output ordering is
  deterministic.

### Required commands

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/category-and-query-planning.test.js
node --test test/page-fetcher.test.js test/domain-and-sitemap.test.js
node --test test/validation-and-security.test.js
npm test
git diff --check
git status --short
```

### Acceptance

- Controlled tests prove all five starting reproductions are fixed.
- Category normalization preserves the business qualifier end to end to the
  store-fit API.
- Store fit is based only on fetched, source-labelled evidence.
- Initial Browserless fallback is demonstrably invoked only under documented
  bounded conditions.
- Provider contract drift produces typed safe failure rather than empty/default
  success.
- Page selection and concurrency stay within configured caps.
- Existing selected-probe reuse and failure isolation continue working.

### Handoff and stop condition

Create `email_scraper/review-evidence/G2_HANDOFF.md` with the required handoff
evidence, including exact normalized category and store-fit contracts. Update only
G2's status/evidence in this checklist, confirm G3/G4 were not started, then stop.

---

## Window G3 — Aggregation, qualification, score v2, persistence, and diagnostics

Status: **COMPLETE — VERIFIED 2026-07-31**

Evidence: `email_scraper/review-evidence/G3_HANDOFF.md`

### Objective

Integrate G1/G2 evidence into one deterministic store lifecycle, merge duplicate
discoveries without provenance loss, apply truthful qualification/score v2, and
persist leads plus diagnostics atomically and compatibly.

### Dependencies and preconditions

- G1 and G2 accepted; both handoff files present.
- Evidence, category, store-fit, fetch, and provider contracts are frozen inputs.
- A disposable PostgreSQL/Neon test database is required only for migration and
  repository integration acceptance. If absent, create migration/source/tests but
  record database verification as an explicit blocker; do not use the configured
  live database by assumption.

### Required reading and starting evidence

- G1/G2 handoffs and all changed contracts.
- `email_scraper/src/pipeline.js`
- `email_scraper/src/lead-scorer.js`
- `email_scraper/src/api-serializer.js`
- `email_scraper/src/prisma-run-repository.js`
- `email_scraper/src/server.js`
- `email_scraper/src/status.js`
- `email_scraper/src/output.js`
- `email_scraper/prisma/schema.prisma`
- Existing migrations and repository/pipeline/server tests.
- Frontend API types only as a compatibility consumer; do not edit frontend.

Reproduce before editing:

- duplicate resolved stores retain only first category/query/rank;
- invalid stores retain misleading high lead scores;
- a contact URL alone qualifies without contact evidence type/confidence;
- query/resolution failures appear as unnamed lead rows;
- HTTP query-planning audits disappear after completion.

### Ownership and non-goals

Owned areas:

- Pipeline orchestration and occurrence aggregation.
- Lead qualification and scoring v2.
- Prisma schema and one reviewed forward-only migration.
- Repository transaction/idempotency behavior.
- API serialization/endpoints for lead evidence, query audits, and diagnostics.
- CSV append-only field extension.
- Pipeline, repository, serializer, server, migration, and recovery tests.

May touch narrowly:

- G1/G2 modules only to consume frozen contracts or correct an integration defect
  without redefining them.
- Backend documentation describing the finalized API/migration.

Non-goals:

- Do not edit frontend presentation.
- Do not deploy the migration to the user's configured live database.
- Do not calibrate v2 against live production leads or start G4.

### Durable model contract

The exact Prisma naming may follow repository conventions, but the model must
support:

- pipeline/scoring version on new runs/leads;
- business qualifier and normalized store-fit state/evidence;
- contactability tier;
- identity confidence/evidence;
- score breakdown JSON;
- merged discovery occurrences/provenance;
- persisted query audits;
- persisted run diagnostics separate from leads.

All new fields must be additive/compatible. One completion transaction must publish
the full result set and `resultsAvailable=true` together, or a tested retry protocol
must make partial writes invisible and idempotently replaceable.

### Contracts and ordered tasks

- [ ] Introduce a discovery-occurrence type and stable store identity key.
- [ ] Merge occurrences across queries and categories while preserving every query,
  rank, result URL, category, and duplicate count.
- [ ] Choose representative/homepage evidence deterministically after merging,
  rather than trusting the first occurrence.
- [ ] Integrate G1 validated contacts and G2 store fit into contactability tiers and
  mandatory qualification gates.
- [ ] Implement score v2 and persist an exact component breakdown; invalid or
  rejected mandatory-gate outcomes receive `leadScore=null`.
- [ ] Ensure rejected reason precedence is deterministic and documented.
- [ ] Remove query/occurrence failure rows from the lead collection.
- [ ] Persist query audits and run diagnostics with owner-scoped retrieval.
- [ ] Make summary totals count store lead rows only; keep progress failure counts
  semantically separate.
- [ ] Add pipeline/scoring version fields and compatibility serialization for
  historical rows.
- [ ] Append new CSV fields without shifting existing columns.
- [ ] Write one additive forward-only migration and validate replay/data
  preservation on a disposable database.
- [ ] Make completion retry/idempotency safe: no duplicate lead/audit/diagnostic
  rows and no partially published results.
- [ ] Preserve current run ownership, service-token boundary, queue serialization,
  progress tracking, restart behavior, and safe logging.
- [ ] Add API endpoints or response sections for query audits/diagnostics only when
  protected by the same owner check as results.

### Adversarial verification

- [ ] Same store across multiple categories, query order reversals, different ranks,
  custom/MyShopify appearances, and repeated occurrences produce one merged store
  with complete provenance.
- [ ] A weak first occurrence cannot override stronger later verified evidence.
- [ ] Direct, indirect, research-only, none, inactive, mismatch, insufficient,
  and processing-failed outcomes map to the locked status contract.
- [ ] Generic social, unverified phone, and invalid contact URLs contribute no
  points and cannot qualify.
- [ ] Structural rejects have null lead score; score breakdown exactly sums to the
  displayed v2 score for qualified leads.
- [ ] Search/probe/invalid-URL/resolution failures appear only in audits/diagnostics,
  never as unnamed leads.
- [ ] Save failure before, during, and after each durable write does not publish a
  partial completed result.
- [ ] Retrying completion does not duplicate records.
- [ ] Migration applies twice according to the repository migration mechanism,
  preserves old rows, and allows old rows to serialize.
- [ ] Cross-owner lead/audit/diagnostic reads return the established not-found
  behavior.
- [ ] Database/provider errors remain privacy-safe.

### Required commands

```bash
cd "/home/harit/Email Scrapper/email_scraper"
npx prisma validate
npm run db:generate
node --test test/pipeline.test.js test/extraction-and-scoring.test.js
node --test test/prisma-run-repository.test.js test/api-serializer.test.js
node --test test/server.test.js
ALLOW_DATABASE_TESTS=true TEST_DATABASE_URL="<explicit disposable database>" npm run test:integration
npm test
git diff --check
git status --short
```

The database command is conditional on an explicit disposable test URL. Never echo
the URL or store it in evidence. The server tests may require loopback permission;
do not kill the user's running servers.

### Acceptance

- Controlled tests prove all five starting reproductions are fixed.
- One merged store preserves complete discovery provenance under reversed input
  order.
- Qualification outcomes exactly follow Sections 3.4-3.7.
- Summary totals, progress counters, audits, and diagnostics have non-overlapping,
  documented meanings.
- Completion is atomic or invisibly/idempotently recoverable under injected failure.
- The migration is forward-only and old data remains readable without rewrite.
- Every new retrieval path is owner-scoped at the repository and HTTP layers.
- Backend full regression passes apart from explicitly evidenced unavailable live
  prerequisites.

### Handoff and stop condition

Create `email_scraper/review-evidence/G3_HANDOFF.md` containing changed files and
migration, API/schema examples with synthetic data, tests/commands/results,
database used only described as disposable (never its URL), skipped checks,
residual risks, and confirmation that G4 was not started. Update only G3's
status/evidence, then stop.

---

## Window G4 — Truthful frontend evidence and end-to-end compatibility

Status: **COMPLETE — VERIFIED 2026-07-31**

Evidence: `frontend/review-evidence/G4_HANDOFF.md`

### Objective

Present the complete G3 lead/evidence contract truthfully, keep legacy runs usable,
and prove frontend/backend compatibility without hiding contact methods or showing
inactive labels as links.

### Dependencies and preconditions

- G1-G3 accepted and all handoff files present.
- G3 API types/examples are frozen inputs.
- Before editing, read `frontend/AGENTS.md` and the relevant installed Next.js 16
  documentation under `frontend/node_modules/next/dist/docs/` completely.
- No production deployment and no changes to auth ownership behavior.

### Required reading and starting evidence

- G3 handoff, serializer/API tests, and synthetic response fixtures.
- `frontend/AGENTS.md` and relevant installed Next.js docs.
- `frontend/components/results-table.tsx`
- `frontend/components/run-workspace.tsx`
- `frontend/components/results-filters.tsx`
- `frontend/components/export-csv-button.tsx`
- `frontend/lib/api-types.ts`
- `frontend/lib/csv-export.ts`
- Frontend API proxy routes, styles, and tests.

Reproduce before editing:

- email hides an available phone in the compact row;
- expanded row omits phone, phone source, social profiles, and contact values;
- missing source URLs still render labels that resemble available links;
- rejected high v1 score can look stronger than qualification status;
- legacy and v2 score semantics are not distinguished.

### Ownership and non-goals

Owned areas:

- Frontend API types and BFF pass-through validation needed for G3 fields.
- Results table compact and expanded presentation.
- Score breakdown, contactability, store fit, provenance, diagnostics/audit display
  if included in the locked G3 API.
- CSV export append-only fields and frontend tests/styles.
- Frontend documentation for the new display contract.

May touch narrowly:

- Backend synthetic fixtures or API documentation only if required to keep one
  contract example synchronized. Do not redefine the backend contract.

Non-goals:

- No backend algorithm, schema, migration, authentication provider, or deployment
  changes.
- No visual redesign unrelated to truthful evidence presentation.

### Contracts and ordered tasks

- [ ] Update strict TypeScript API types for pipeline/scoring version, qualifier,
  store fit, contactability, score breakdown, provenance, audits, and diagnostics.
- [ ] Keep legacy nullable fields compatible and visibly label legacy score
  semantics where shown.
- [ ] Keep the compact table scannable while indicating every available contact
  channel, not only the first one.
- [ ] Show all available expanded fields: email, email source, phone, phone source,
  validated contact page, sanitized social profiles, identity domains/evidence,
  category/store fit, score breakdown/version, discovery provenance, and explicit
  outcome evidence.
- [ ] Omit unavailable fields or mark them clearly. Render external-link affordance
  only for a validated present URL.
- [ ] Show `direct`, `indirect`, `research_only`, and `none` truthfully without
  calling absent email/phone `No contact found` when an indirect method exists.
- [ ] Ensure structural rejects do not display misleading high lead-score styling.
- [ ] Add an owner-scoped diagnostics/query-audit view only if G3 exposes it; do not
  mix diagnostics into lead rows.
- [ ] Append all new exported fields while preserving existing CSV column order and
  formula-injection protection.
- [ ] Preserve pagination, filtering, sorting, complete-dataset export, auth flow,
  and run ownership.

### Adversarial verification

- [ ] Email-only, phone-only, both, contact-page-only, social-only, no-contact,
  rejected, failed, and legacy rows render accurately.
- [ ] Multiple social profiles are visible and safe; invalid/missing URLs are never
  clickable.
- [ ] Very long names, emails, phone displays, source URLs, provenance lists, and
  error text do not break layout or accessibility.
- [ ] Keyboard expansion, link labels, status semantics, and responsive layout are
  covered by component/browser evidence appropriate to the project.
- [ ] Pagination/filter changes cannot leave stale expanded evidence attached to a
  different row.
- [ ] CSV export retrieves every page, includes all rows once, preserves existing
  headers, appends new headers, and remains formula-safe.
- [ ] Unauthorized/expired sessions and foreign runs preserve current behavior.

### Required commands

```bash
cd "/home/harit/Email Scrapper/frontend"
npm run lint
npm test
npm run build
git diff --check
git status --short
```

Also run focused controlled browser/component verification if the repository has an
available harness. Do not terminate the user's running development servers.

### Acceptance

- Every collected contact field and source in a synthetic full-evidence lead is
  visible in the expanded view.
- Compact contact state reflects all available channels without hiding an available
  phone behind email.
- Missing values never appear as active links.
- v2 component scores and legacy score semantics are distinguishable and truthful.
- Diagnostics/audits, if exposed, remain separate from the lead table.
- Full CSV export contains complete paginated data with backward-compatible header
  ordering.
- Frontend lint, tests, and production build pass.

### Handoff and stop condition

Create `frontend/review-evidence/G4_HANDOFF.md` with changed files, relevant Next.js
documents read, tests/commands/results, screenshots or controlled render evidence,
skipped checks, residual risks, and confirmation that no parent review or later
window was started. Update only G4's status/evidence, then stop.

---

## 8. Standard assignment prompt

The parent should assign each fresh implementation agent with this exact boundary:

```text
Execute only Window <ID> from
/home/harit/Email Scrapper/PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md.
Verify its dependencies before editing. Read the required source and framework
documents completely. Stay inside its ownership boundary and preserve the dirty
worktree. Add and run the required adversarial tests. Update only this window and
its handoff evidence. Stop after handoff. Do not begin the next window, deploy a
production migration, stop running servers, or perform final verification.
```

Windows must be assigned sequentially: G1, then G2, then G3, then G4.

## 9. Planning readiness gate

- [x] One authoritative contract is identified.
- [x] A fresh agent can execute a window without conversation history.
- [x] Observed, inferred, and unknown evidence are distinguished.
- [x] User-visible status, category, contact, score, diagnostic, and history
  semantics are locked.
- [x] The end-to-end lifecycle and durable completion boundary are defined.
- [x] Cross-window invariants have named owners.
- [x] Dependencies, ownership, and non-goals are explicit.
- [x] Acceptance criteria require behavioral evidence, not only passing tests.
- [x] Provider failure, malformed input, partial failure, concurrency, restart,
  migration preservation, authorization, and misleading UI cases are assigned.
- [x] Live/user prerequisites are separated from deterministic local acceptance.
- [x] Production migration and destructive historical reclassification are
  explicitly excluded.

The checklist is ready to assign G1. Checked readiness items describe the plan,
not implementation completion.

## 10. Parent reliability review after G1-G4

When the user requests the review, the parent must independently:

1. Read all four handoffs as navigation aids, not proof.
2. Inspect the complete source, migration, API, frontend, and test diff.
3. Reproduce each original critical failure against the final implementation.
4. Trace category input through query planning, identity, merged evidence,
   qualification, atomic persistence, owner-scoped API, UI, and CSV.
5. Verify strict provider adapters have no fallback envelope/field probing.
6. Verify mocks do not bypass the claimed extraction, store-fit, merge,
   transaction, ownership, or frontend behavior.
7. Validate the migration and preserved historical rows on a safe database.
8. Rerun focused tests, backend full tests, frontend lint/tests/build, and applicable
   controlled browser evidence.
9. If explicitly authorized and credentials are available, run a new bounded
   eyewear-brand probe and manually label a representative sample. Report this as
   live evidence, not as a substitute for deterministic tests.
10. Record unavailable live checks as gaps.

The parent must not silently repair review findings. Open append-only corrective
windows `G-R1`, `G-R2`, and so on, each with reproduction, root cause, bounded
ownership, regression test, migration impact, and stop condition. Overall
completion is allowed only after implementation windows and necessary corrective
windows satisfy the locked invariants.

---

## 11. Parent reliability review findings and corrective execution plan

Status: **READY FOR SEQUENTIAL CORRECTIVE IMPLEMENTATION**

Created: 2026-08-01

The independent parent review did not accept the G1-G4 implementation as
reliable. The original locked product contract in Sections 1-6 remains
authoritative. Completed windows and their handoffs remain historical evidence;
they must not be rewritten. This section is the append-only plan for correcting
the review findings.

No source changes, live provider calls, production migration, credential
rotation, or deployment are authorized merely by this plan. Each corrective
window must be explicitly assigned and executed separately.

### 11.1 Review evidence classification

Observed with deterministic source/runtime evidence:

1. **Critical — empty contact route qualifies.** An ordinary same-host response
   containing only `<body>Not found</body>` at `/pages/contact-us` produced a
   `qualified` lead with `contactabilityTier=indirect`.
2. **Critical — rejected v2 rows serialize as legacy v1.** A pipeline-v2 rejected
   row with a null score/scoring version serialized with legacy-v1 score
   semantics.
3. **High — a general store passes the brand-specialist gate.** Two eyewear
   product phrases on a general-department homepage were sufficient to classify
   the store as a specialist eyewear brand.
4. **High — incidental `opening soon` text rejects an active store.** An active
   Shopify homepage plus an About page mentioning a second location opening soon
   was classified as inactive.
5. **High — order/SKU numbers can become phones.** `Contact support with order
   number 1234 5678` extracted `12345678` as a phone.
6. **High — fractional query scores conflict with the database type.** The query
   prober produced `82.29`, the mapper retained `82.29`, and Prisma declares
   `Lead.queryScore Int?`.
7. **High — intent claims bypass run admission rate limiting.** The direct run
   route checks the limiter; the account-claim route creates/queues a run without
   the same admission check.
8. **High — Browserless redirects are not attributable.** Rendered fetches replace
   the observed final URL with the requested URL, so externally redirected content
   can be attributed to the requested store.
9. **High — `maxBytes` does not bound response memory.** The HTTP client calls
   `response.text()` before slicing, allowing an unbounded chunked response to be
   buffered first.
10. **Medium — exact input category provenance is lost.** `Eyewear Brand` reached
    the resolver with `originalShopType=null` despite the planner initially
    producing the value.
11. **Medium — `matched_categories` is not truthful.** It contains every discovery
    intent, including intents whose store-fit validation did not match.
12. **Medium — query cache contaminates qualifier provenance.** Two candidates
    sharing query text reuse the first candidate object, reason, and source instead
    of sharing only the provider result.
13. **Medium — expanded UI omits collected evidence.** Store-fit terms and
    per-page evidence, contact kind/validation reason, query-generation reason and
    final URL, and identity display hostname are typed but not all rendered.
14. **High verification gap — real migration/transaction behavior is unproven.**
    The database integration suite was skipped because no disposable
    `TEST_DATABASE_URL` was available, and it does not yet prove upgrade replay,
    preservation, rollback, or fractional query-score persistence.
15. **High — startup recovery is unsafe across instances.** Every process startup
    marks all `running` rows failed, including work owned by another healthy
    instance.
16. **Low — documented threshold configuration is inert.**
    `QUALIFICATION_THRESHOLD` and `MIN_RELEVANCE_SCORE` are parsed and advertised
    but do not control pipeline behavior.
17. **High operational risk — credential-shaped n8n values can be committed.**
    `email_scraper/My workflow 3.json` contains credential-shaped data and the
    renamed project is currently easy to add broadly without an ignore rule.

Additional observed gaps included in the corrective scope:

- rejection precedence can report insufficient evidence before a more specific
  wrong-category/wrong-store-type result;
- social-profile shape validation does not prove that a profile belongs to the
  store;
- backend CSV serialization lacks the frontend export's spreadsheet-formula
  protection;
- a completed run can be rewritten because terminal persistence has no state or
  worker fence;
- the frontend boundary trusts cast API objects without runtime shape validation;
- frontend fixtures mix v2 runs with legacy-like lead semantics; and
- existing frontend tests exercise presentation helpers rather than the actual
  expanded evidence component and stale-row interaction.

Unknown and requiring implementation-time evidence:

- The exact pinned Browserless response contract for a trustworthy observed final
  URL. G-R2 must establish this from official provider documentation and sanitized
  fixtures before changing the adapter. If the configured endpoint cannot return
  a trustworthy final URL, Browserless content must not independently establish
  store identity, same-store contact evidence, or qualification.
- Migration behavior on PostgreSQL/Neon. G-R4 and G-R6 require an explicitly
  disposable test database. The configured live database is not a substitute and
  must not be used without separate user authorization.
- Rotation/revocation status of credential-shaped values. Code can prevent future
  inclusion, but credential rotation is a user-controlled prerequisite and must be
  reported honestly.

### 11.2 Corrective invariants and ownership

| ID | Corrective invariant | Owning window |
| --- | --- | --- |
| C1 | A contact route qualifies only when a usable same-store page contains validated outreach evidence. | G-R1 |
| C2 | Phone and social evidence is organization-associated and cannot be rescued by generic context words. | G-R1 |
| C3 | Store activity and brand-specialist fit require page-level evidence, not isolated phrase counts. | G-R2 |
| C4 | Rendered content has a trustworthy final URL and all response bodies are bounded while streaming. | G-R2 |
| C5 | Exact category and query provenance survives planning, caching, aggregation, validation, and scoring. | G-R3 |
| C6 | `matched_categories` contains only accepted store-fit intents; discovery-only intents remain separately available. | G-R3 |
| C7 | Every new pipeline-v2 outcome has truthful v2/not-scored semantics and durable numeric types match runtime values. | G-R4 |
| C8 | Run admission and terminal writes are atomic, state-aware, idempotent, and owner-safe. | G-R4 |
| C9 | The expanded UI and both CSV paths expose truthful, complete, safe evidence. | G-R5 |
| C10 | Only the current lease owner may progress/finalize work; startup touches only expired leases. | G-R6 |
| C11 | Configuration and repository contents do not advertise inert controls or make known secret-bearing artifacts easy to commit. | G-R6 |

### 11.3 Execution order and assignment boundary

Execute corrective windows sequentially:

```text
G-R1 -> G-R2 -> G-R3 -> G-R4 -> G-R5 -> G-R6 -> parent re-review
```

Each window is sized to fit within one 100K context window; most should use
substantially less. G-R3 consumes G-R2 validation semantics. G-R4 persists the corrected G-R3
contracts. G-R5 consumes the corrected API contract. G-R6 adds worker fencing
after the durable completion contract is stable. Do not parallelize these windows
because they overlap the pipeline, schema/API, or persistence boundaries.

Every assignment must use this boundary:

```text
Execute only Window <ID> from
/home/harit/Email Scrapper/PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md.
Verify its dependencies before editing. Read the required files completely.
Preserve the dirty worktree and do not rewrite completed G1-G4 history. Add and
run the required adversarial tests. Update only this corrective window and its
handoff evidence. Stop after handoff. Do not begin a later window, deploy a live
migration, call live providers, rotate credentials, or stop running servers.
```

---

## Window G-R1 — Contact evidence must prove a reachable outreach channel

Status: **COMPLETE — VERIFIED 2026-08-01**

Evidence: `email_scraper/review-evidence/G-R1_HANDOFF.md`

### Findings, objective, and violated contract

Owns findings 1 and 5 plus the social-association follow-up. It restores Sections
3.5 and 5 invariants I1-I2: path shape is necessary but not sufficient for a
contact page, and unverified numbers/profiles cannot qualify or score a lead.

### Dependencies and preconditions

- G1-G4 are complete; no corrective predecessor.
- No live storefront, OpenAI, Google, Browserless, or database call.
- Preserve public result fields until G-R4/G-R5 consume richer evidence.

### Required reading and exact starting reproductions

- `src/contact-evidence.js`, `src/contact-extractor.js`, `src/page-fetcher.js`,
  `src/html.js`, `src/ai-normalizer.js`, `src/pipeline.js`, and
  `src/lead-scorer.js`.
- `test/extraction-and-scoring.test.js`, `test/page-fetcher.test.js`, and
  `test/pipeline.test.js`.
- Reproduce a usable HTTP response at `/pages/contact-us` whose body is only
  `Not found`; it currently yields indirect qualification.
- Reproduce free text `Contact support with order number 1234 5678`; it currently
  yields phone `12345678`.
- Add a fixture where a theme/vendor social link has a syntactically valid profile
  path but is not associated with the store.

### Ownership and non-goals

Owned: contact extraction/consolidation primitives, page usability/contact-signal
assessment, social association, focused fixtures/tests, and the narrow pipeline
integration that consumes contact evidence.

Non-goals: storefront-fit classification, Browserless contract, scoring weights,
schema/API persistence, frontend, or unrelated extraction refactors.

### Bounded fix and ordered tasks

- [ ] Define one normalized contact-page decision containing route acceptance,
  same-store status, HTTP/page usability, positive page signals, validation reason,
  and source URL.
- [ ] Require all four gates for contact-page evidence: accepted contact route,
  verified same-store final URL, usable response, and at least one substantive
  signal such as a contact form, validated direct method, contact-page structured
  data, or a contact heading plus non-trivial contact body content.
- [ ] Treat blank, tiny, generic error, soft-404, challenge, and unavailable bodies
  as non-contact evidence even when their URL route is accepted.
- [ ] Keep strong phone sources (`tel:` and valid organization/contact structured
  data) distinct from free-text candidates. For free text, reject order, invoice,
  tracking, model, SKU, VAT, year/range, and quantity contexts before considering
  generic words such as `contact` or `support`.
- [ ] Require store association for social profiles: organization `sameAs` or a
  store-owned header/footer/about/contact block is acceptable; share/intent/theme/
  vendor/platform links are not. Preserve a reason for every retained profile.
- [ ] Ensure contactability and score consumers accept only the normalized
  validated evidence, never raw route candidates or unvalidated AI values.

### Adversarial verification

- [ ] Empty, whitespace, soft-404, challenge, and `Not found` contact routes do not
  qualify; a substantive same-store contact form without email still qualifies as
  indirect.
- [ ] A rejected ordinary contact response can use the existing bounded rendered
  fallback, but only a rendered page satisfying the same evidence gates qualifies.
- [ ] `tel:` and structured organization phones survive; labeled order/SKU/
  tracking/VAT/model numbers do not, including when `contact` or `support` is near.
- [ ] A real free-text phone inside a contact block survives boundary punctuation,
  country code, and extension normalization.
- [ ] Store-owned social profiles survive and vendor/share profiles are rejected;
  social-only evidence remains `research_only` and never qualifies.
- [ ] The full pipeline reproduction for the blank contact route ends rejected
  with null score, not merely with a lower confidence value.

### Migration implications

None. Evidence JSON may gain additive keys, but no Prisma migration is owned here.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/extraction-and-scoring.test.js test/page-fetcher.test.js test/pipeline.test.js
npm test
npx prisma validate
git diff --check
git status --short
```

Acceptance requires deterministic tests for both exact reproductions, a positive
form-only contact fixture, source-level confirmation that qualification consumes
the normalized decision, and an unchanged passing backend regression suite except
for any explicitly environmental database skip.

### Handoff and stop condition

Create `email_scraper/review-evidence/G-R1_HANDOFF.md` with changed files, fixture
provenance, commands/results, skipped checks, and residual risks. Update only this
window's status/evidence and stop.

---

## Window G-R2 — Storefront truth, redirect attribution, and bounded fetching

Status: **COMPLETE — VERIFIED 2026-08-01**

Evidence: `email_scraper/review-evidence/G-R2_HANDOFF.md`

### Findings, objective, and violated contract

Owns findings 3, 4, 8, and 9 plus rejection precedence. It restores Sections
3.4-3.6 and invariants I6-I9: specialist/activity decisions must be evidence-based,
rendered content must be attributable to a verified host, and response limits must
bound memory rather than only returned strings.

### Dependencies and preconditions

- G-R1 complete and its normalized page/contact evidence available.
- Before editing the Browserless adapter, record the configured endpoint's exact
  official, versioned final-URL response contract and create sanitized positive and
  malformed fixtures. No fallback envelope/field probing.
- If that contract cannot expose a trustworthy final URL, take the locked safe
  fallback: Browserless content may supplement already verified same-host evidence
  but may not independently establish identity, contactability, fit, or active
  status.
- No live provider calls.

### Required reading and exact starting reproductions

- `src/storefront-validator.js`, `src/page-fetcher.js`, `src/http-client.js`,
  `src/domain-resolver.js`, `src/pipeline.js`, `src/sitemap.js`, and
  `src/url-security.js`.
- `test/page-fetcher.test.js`, `test/domain-and-sitemap.test.js`,
  `test/validation-and-security.test.js`, and `test/pipeline.test.js`.
- Reproduce a general-department homepage with only `aviator glasses` and `reading
  glasses`; it currently passes an eyewear-brand specialist gate.
- Reproduce an active Shopify homepage plus About text `second location opening
  soon`; it currently becomes inactive.
- Reproduce a Browserless fixture redirected to an external host while the adapter
  reports the requested host.
- Reproduce a chunked body exceeding `maxBytes` without `Content-Length`; current
  code buffers the whole body before truncating.

### Ownership and non-goals

Owned: storefront activity/fit assessment, page fetch/Browserless adapter,
streaming response limit, same-store redirect enforcement, rejection ordering,
and focused tests/fixtures.

Non-goals: category/query propagation, database/API types, frontend, score weights,
or new crawling/pagination behavior.

### Bounded fix and ordered tasks

- [ ] Replace phrase-count specialist promotion with explicit evidence tiers.
  A brand specialist requires an organization/site category claim or category-
  dominant navigation/collection/product assortment evidence across independently
  useful page signals. Two isolated product phrases make at most `category_seller`.
- [ ] Record the terms, pages, signal kinds, and negative/breadth evidence that
  caused each store-fit state; do not hide the decision in a numeric total.
- [ ] Detect password/coming-soon state from page-level lock evidence such as a
  password template/form/action plus absence of normal commerce content. An
  incidental phrase on About/product/blog content cannot mark the store inactive.
- [ ] Parse Browserless output through the single proven contract, retain its
  observed final URL, and pass it through the same URL safety and allowed-host
  rules as ordinary redirects. Never synthesize the requested URL as observed.
- [ ] Stream response bodies incrementally. Reject oversized declared lengths
  before reading, abort/cancel after the byte cap, decode only retained bounded
  bytes, and return a typed size-limit outcome.
- [ ] Lock deterministic rejection precedence: inactive/not-Shopify first when
  proven, then wrong category/store type, then insufficient store evidence, then
  missing contactability. A processing exception remains `failed`, not rejected.

### Adversarial verification

- [ ] General marketplaces with two or several category phrases remain
  `category_seller`; brand input rejects them as `wrong_store_type`.
- [ ] A true category-focused brand with organization plus assortment evidence is
  specialist; missing/blocked evidence remains unknown, not specialist.
- [ ] Incidental `opening soon`, `password`, or `coming soon` copy on normal active
  pages does not reject; an actual password template does.
- [ ] Same-host Browserless render is usable; external redirect, missing final URL,
  malformed response, and untrusted host cannot contribute qualifying evidence.
- [ ] Oversized known-length and chunked/unknown-length responses stop at the cap,
  cancel the body, and never invoke HTML extraction with partial untrusted text.
- [ ] Multi-cause fixtures return the locked most-specific rejection reason.

### Migration implications

None. Store-fit/page evidence JSON changes are additive and are persisted later
through existing JSON fields.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/page-fetcher.test.js test/domain-and-sitemap.test.js test/validation-and-security.test.js test/pipeline.test.js
npm test
npx prisma validate
git diff --check
git status --short
```

Acceptance requires all exact reproductions to fail safely, a positive specialist
fixture to remain qualified, a bounded-stream test that counts bytes read/cancelled
rather than inspecting only the returned substring, and a provenance-labelled
Browserless fixture matching the one pinned contract.

### Handoff and stop condition

Create `email_scraper/review-evidence/G-R2_HANDOFF.md`, update only G-R2 status and
evidence, and stop. If the Browserless final-URL contract is unavailable, record
the safe fallback implementation and the unavailable capability explicitly.

---

## Window G-R3 — Category and query provenance must remain candidate-specific

Status: **COMPLETE — VERIFIED 2026-08-01**

Evidence: `email_scraper/review-evidence/G-R3_HANDOFF.md`

### Findings, objective, and violated contract

Owns findings 10-12. It restores Sections 3.4 and 3.8 plus invariants I7 and I10:
exact user input must survive the lifecycle, provider-call reuse must not reuse a
different candidate's metadata, and matched categories must actually have passed
store fit.

### Dependencies and preconditions

- G-R2 complete; use its final store-fit acceptance function as the sole match
  predicate.
- No migration in this window. G-R4 owns durable schema/API compatibility.
- No provider calls; use controlled normalized search fixtures.

### Required reading and exact starting reproductions

- `src/category-input.js`, `src/query-planner.js`, `src/query-cache.js`,
  `src/query-prober.js`, `src/query-ranker.js`, `src/discovery-aggregation.js`,
  `src/query-audit.js`, and `src/pipeline.js`.
- `test/category-and-query-planning.test.js` and `test/pipeline.test.js`.
- Reproduce `Eyewear Brand` reaching the resolver without `originalShopType`.
- Reproduce a store discovered by two intents where only one passes store fit but
  both appear in `matched_categories`.
- Reproduce two same-query candidates with different qualifiers/reasons/sources;
  the second currently receives the first candidate's provenance.

### Ownership and non-goals

Owned: in-memory category/query domain objects, query cache boundary, occurrence
aggregation, matched-category construction, query audit inputs, and focused tests.

Non-goals: Prisma migration, serializer/frontend fields, Google pagination,
provider scoring redesign, or storefront evidence rules.

### Bounded fix and ordered tasks

- [ ] Define one category-intent object with `originalShopType`, `shopType`, and
  `businessQualifier`; carry it without reconstruction through plans, candidates,
  probe results, occurrences, merged stores, resolver inputs, validations, audits,
  and result records.
- [ ] Make the query cache store only candidate-independent normalized provider
  search data/errors keyed by normalized query and provider contract version.
  Re-run candidate-specific summarization for every candidate after a cache hit.
- [ ] Preserve one external search call for identical query text while retaining
  each candidate's own generation reason, source, qualifier, vocabulary, and audit.
- [ ] Build `matched_categories` only from validations accepted under the G-R2 fit
  predicate. Retain all attempted discovery intents in discovery occurrences/
  audits under a clearly named field; do not relabel attempts as matches.
- [ ] Select the primary displayed intent deterministically from accepted matches,
  with an explicit fallback for rejected/unknown stores that does not falsify a
  match.

### Adversarial verification

- [ ] Mixed case and alias input preserves the exact whitespace-normalized
  `originalShopType` at every named boundary.
- [ ] Brand and retailer candidates sharing a query make one provider call but
  retain distinct candidate reasons, sources, vocabulary, qualifiers, and scores.
- [ ] A provider failure cached for a query yields separate candidate-specific
  audits without leaking the first candidate.
- [ ] One matching and one mismatching intent yields one matched category and two
  discovery attempts; zero accepted intents yields an empty match list.
- [ ] Merge order reversal produces identical category, occurrence, and primary-
  intent output.

### Migration implications

None in this window. The handoff must enumerate every newly required durable/API
field for G-R4, including whether existing JSON fields already preserve it.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/category-and-query-planning.test.js test/pipeline.test.js
npm test
npx prisma validate
git diff --check
git status --short
```

Acceptance requires boundary assertions from normalized input through resolver and
result, one-call/two-provenance cache evidence, truthful matched categories, and
order-independent merged output.

### Handoff and stop condition

Create `email_scraper/review-evidence/G-R3_HANDOFF.md`, including the durable field
inventory for G-R4. Update only G-R3 status/evidence and stop.

---

## Window G-R4 — Durable v2 semantics, admission, and migration proof

Status: **COMPLETE — VERIFIED 2026-08-01**

Evidence: `email_scraper/review-evidence/G-R4_HANDOFF.md`

### Findings, objective, and violated contract

Owns findings 2, 6, 7, and 14 plus terminal-result rewrite safety. It restores
Sections 3.7-3.10 and invariants I11-I14/I16: runtime numeric values must fit the
schema, every new v2 outcome must be truthfully versioned, both run-entry paths
must share admission control, and publication must be atomic and state-aware.

### Dependencies and preconditions

- G-R3 complete with its durable field inventory.
- A user-designated disposable PostgreSQL `TEST_DATABASE_URL`; never use the
  configured live Neon database. If unavailable, implementation may prepare code
  and migration but this window must remain blocked and unverified.
- Capture a baseline fixture containing legacy rows and current pre-correction
  rows before applying migrations.

### Required reading and exact starting reproductions

- `prisma/schema.prisma`, every migration under `prisma/migrations/`,
  `src/prisma-run-repository.js`, `src/api-serializer.js`, `src/query-audit.js`,
  `src/pipeline.js`, and the admission/claim paths in `src/server.js`.
- `test/prisma-run-repository.test.js`,
  `test/prisma-run-repository.integration.test.js`, `test/api-serializer.test.js`,
  `test/server.test.js`, and `test/pipeline.test.js`.
- Reproduce rejected pipeline-v2 serialization as `legacy_v1`.
- Reproduce query score `82.29` flowing toward `Lead.queryScore Int?`.
- With run limit one, submit/claim through both entry routes and show the claim
  path currently avoids the limiter. Include simultaneous requests.
- Call terminal save twice for one run and show the completed row set can be
  replaced.

### Ownership and non-goals

Owned: additive/forward migration, Prisma mappings, transaction/state checks,
backend serializer semantics, run admission shared by direct/claim routes, and
database/API tests.

Non-goals: worker leases/restart recovery (G-R6), frontend rendering (G-R5), live
migration, historical score backfill/reclassification, or score-weight changes.

### Bounded fix and ordered tasks

- [ ] Make `queryScore` a precision-preserving database type (Prisma `Float` and
  the matching PostgreSQL type) because query ranking intentionally emits
  fractional scores. Preserve existing integer values exactly during migration.
- [ ] Add nullable durable `originalShopType` fields where required by the G-R3
  inventory, including query audits if their current JSON does not give the API a
  stable typed field. Keep existing rows valid and untouched.
- [ ] Assign pipeline/scoring version 2 to every newly processed store outcome,
  including rejected and failed rows. Keep `leadScore=null` and
  `scoreBreakdown=null` when mandatory gates fail.
- [ ] Define serializer score semantics explicitly: legacy only when the persisted
  row/run truly predates v2; v2 rejected/failed rows are `not_scored_v2`, never
  legacy. Do not infer legacy solely from a null score.
- [ ] Centralize one admission operation used before both direct creation and
  intent claim. Reserve capacity before asynchronous persistence, release it for
  idempotent existing claims or failed creation, and prevent simultaneous requests
  from oversubscribing the configured limit.
- [ ] Make terminal publication conditional on the expected non-terminal state in
  the same transaction as child replacement/insertion and summary publication.
  A replay may return the already-published result only when the payload identity
  matches; it must never silently replace completed output.
- [ ] Expand disposable-database tests to apply migrations from the baseline,
  replay them, prove legacy/data preservation, store/retrieve a fractional query
  score, exercise rollback after each child-write stage, reject terminal rewrite,
  and enforce owner-scoped reads.

### Adversarial verification

- [ ] Qualified, rejected, and failed v2 rows serialize with correct score
  semantics; only a true historical unversioned row is legacy.
- [ ] `82.29`, integer-looking floats, zero, and boundary scores round-trip through
  Prisma and JSON without truncation or database failure.
- [ ] Direct create versus intent claim, claim versus claim, and idempotent replay
  all share the limit under simultaneous requests; rejected admission creates no
  queued work.
- [ ] Failure after lead deletion/insertion, audit insertion, diagnostic insertion,
  or run update rolls the entire publication back.
- [ ] A second differing completion cannot replace a completed run; foreign-owner
  reads remain indistinguishable from not found.
- [ ] Migration from the captured old schema preserves row counts, IDs, ownership,
  legacy values, and nullability; replay is safe.

### Migration implications

Forward-only migration required. No reset, shadow use of the live database,
destructive column rebuild without preservation proof, or historical rewrite is
allowed. Store sanitized schema/row-count evidence only; never store connection
strings or actual user data.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
npx prisma format
npx prisma validate
ALLOW_DATABASE_TESTS=true TEST_DATABASE_URL="<disposable-url>" npm run test:integration
node --test test/pipeline.test.js test/api-serializer.test.js test/prisma-run-repository.test.js test/server.test.js
npm test
git diff --check
git status --short
```

Acceptance requires executed disposable-database evidence for migration upgrade,
replay, rollback, preservation, and fractional persistence. A skipped integration
test is a blocker, not acceptance.

### Handoff and stop condition

Create `email_scraper/review-evidence/G-R4_HANDOFF.md` with migration name,
sanitized before/after counts, exact commands, and skipped evidence. Update only
G-R4 status/evidence and stop; do not apply the migration to live Neon.

---

## Window G-R5 — Complete and truthful presentation and export

Status: **COMPLETE — VERIFIED 2026-08-01**

Evidence: `frontend/review-evidence/G-R5_HANDOFF.md`

### Findings, objective, and violated contract

Owns finding 13 plus frontend runtime validation, fixture truthfulness, actual
component coverage, stale expansion, and backend/frontend CSV safety. It restores
Section 3.2 and invariant I15-I16: every available field is visible in expanded
results, absent data is not implied, v2 not-scored rows are not legacy, and exports
are safe.

### Dependencies and preconditions

- G-R4 complete and its serializer fixtures/API contract stable.
- Before any frontend edit, read `frontend/AGENTS.md` and the complete relevant
  installed Next.js 16.2.12 documents under `frontend/node_modules/next/dist/docs/`.
- Do not stop or replace the user's running development server.

### Required reading and exact starting reproductions

- Backend: `src/api-serializer.js`, `src/output.js`, and `src/csv.js`.
- Frontend: `lib/api-types.ts`, `lib/backend-proxy.ts`,
  `lib/lead-presentation.ts`, `lib/csv-export.ts`,
  `components/results-table.tsx`, and `components/export-csv-button.tsx`.
- Backend fixture generator: `email_scraper/src/seed-frontend.js`.
- All frontend tests and `frontend/review-evidence/G4_HANDOFF.md`.
- Render a full-evidence lead and record which typed fields are absent: store-fit
  matched terms and page signals/strength/text length; contact kind and validation
  reason; query-generation reason/final URL; identity display hostname.
- Render a rejected v2 fixture and reproduce legacy labeling.
- Expand a row, change page/filter/query data, and verify stale evidence cannot
  remain attached to another row.

### Ownership and non-goals

Owned: backend CSV escaping, API response runtime validation at the frontend
boundary, frontend types/presentation/components/export, truthful dev fixture, and
component tests.

Non-goals: backend qualification decisions, schema migration, auth redesign, UI
restyling, new tables/endpoints, or deployment.

### Bounded fix and ordered tasks

- [ ] Add a strict runtime validator for the backend run/results/audit/diagnostic
  response shapes consumed by the frontend. Reject malformed required fields with
  a safe UI error; allow documented additive fields without casting them into
  trusted data.
- [ ] Render every available contact method with kind, normalized value, source
  URL, confidence/strength, and validation reason. Keep email, phone, contact page,
  and all validated social profiles visible together.
- [ ] Render store-fit state, matched terms, page URL/type, signal type, strength,
  and text-length/usable evidence when present.
- [ ] Render exact category input, normalized category/qualifier, query-generation
  reason, search/result/requested/final URLs, rank, and discovery occurrence
  provenance without labeling discovery attempts as matched categories.
- [ ] Render identity display hostname plus stable/resolved/MyShopify/canonical
  evidence and confidence without implying unverified equivalence.
- [ ] Present `not_scored_v2`, scored v2, and legacy v1 distinctly. Null v2 score
  must say not scored, never legacy or zero.
- [ ] Key expanded state by stable lead identity and clear it on page, filter, run,
  or result-set changes.
- [ ] Apply spreadsheet-formula protection to backend CSV cells as well as frontend
  export while preserving header order and appending any new fields.
- [ ] Replace mixed-version seed fixtures with internally consistent scored-v2,
  not-scored-v2, and true legacy rows.
- [ ] Add component-level render evidence against the actual expanded evidence
  component, not presentation helpers alone. Prefer a small extracted pure details
  component renderable with the existing React toolchain over a broad new test
  dependency; add controlled browser evidence only if a harness already exists.

### Adversarial verification

- [ ] One synthetic full-evidence row visibly contains every API evidence field and
  all channels; URLs are links only when valid and present.
- [ ] Missing/null/empty optional fields do not create blank links or misleading
  labels.
- [ ] Rejected and failed v2 rows show not-scored-v2; historical unversioned rows
  alone show legacy.
- [ ] Page/filter/run changes cannot retain expansion for a no-longer-present row.
- [ ] CSV values starting with `=`, `+`, `-`, `@`, tab, or carriage return are
  neutralized in both backend and frontend exports; commas, quotes, arrays, Unicode,
  and line breaks round-trip.
- [ ] Malformed backend payloads fail closed with no partially trusted result row.
- [ ] Unauthorized/expired/foreign-run behavior remains unchanged.

### Migration implications

None. Consume the G-R4 API/schema contract without another database change.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
node --test test/csv.test.js test/api-serializer.test.js test/server.test.js
npm test
cd "/home/harit/Email Scrapper/frontend"
npm run lint
npm test
npx tsc --noEmit
npm run build
git diff --check
git status --short
```

Acceptance requires actual rendered-component evidence for a full-evidence lead,
stale-state regression evidence, complete paginated export with every row once,
safe CSV output in both implementations, and clean frontend lint/type/test/build.
Build-time external auth diagnostics must be reported separately from failures and
must not be hidden.

### Handoff and stop condition

Create `frontend/review-evidence/G-R5_HANDOFF.md` with Next documents read, changed
files, render/browser evidence, commands/results, and residual risks. Update only
G-R5 status/evidence and stop.

---

## Window G-R6 — Multi-instance worker fencing and operational hygiene

Status: **COMPLETE — VERIFIED 2026-08-01**

Evidence: `email_scraper/review-evidence/G-R6_HANDOFF.md`

### Findings, objective, and violated contract

Owns findings 15-17 and completes the deployment-safety boundary. It restores the
Section 4 lifecycle and invariants I13/C10-C11: another process cannot fail or
finalize work it does not own, expired work is handled deterministically, and
configuration/repository hygiene is truthful.

### Dependencies and preconditions

- G-R5 complete; a disposable PostgreSQL `TEST_DATABASE_URL` is mandatory.
- Confirm the current deployment remains a long-running Node worker. This window
  does not claim that a single AWS Lambda invocation can run longer than Lambda's
  platform execution limit and does not implement the parked AWS queue split.
- Do not rotate/revoke credentials or modify the user's n8n workflow contents
  without separate authorization. Never print secret values.

### Required reading and exact starting reproductions

- `src/server.js`, `src/prisma-run-repository.js`, `src/run-once.js`,
  `src/seed-frontend.js`, `src/config.js`, `.env.example`, `.gitignore`, Prisma
  schema/migrations, deployment docs, and repository/server/integration tests.
- Reproduce two repository/server instances sharing a database: instance B startup
  currently marks instance A's running row failed.
- Reproduce a stale worker attempting to complete after another worker owns or has
  expired the run.
- Prove `QUALIFICATION_THRESHOLD` and `MIN_RELEVANCE_SCORE` are parsed but unused.
- Run a redacted credential-shape scan that reports file/path/key names only, never
  values; confirm the n8n export is not currently ignored.

### Ownership and non-goals

Owned: run lease schema/migration, atomic claim/heartbeat/finalization fencing,
expired-run recovery, lifecycle tests, dead configuration/docs cleanup, ignore
rules, and a safe secret-scan check.

Non-goals: AWS infrastructure, SQS/Step Functions implementation, provider retry
redesign, live deployment/migration, credential rotation, deleting the n8n export,
or altering authentication.

### Bounded fix and ordered tasks

- [ ] Add nullable lease owner/token, lease expiry, heartbeat, and attempt metadata
  with a forward-only migration that preserves all current runs.
- [ ] Atomically claim exactly one queued/eligible run. Return a unique lease token
  and require that token plus non-expired ownership for progress, heartbeat,
  failure, and completion writes.
- [ ] Renew the lease during long processing at a bounded interval shorter than the
  expiry. On lease loss, stop publishing/progressing and surface a safe diagnostic;
  a stale worker must not overwrite a newer terminal or active state.
- [ ] Replace startup-wide `running -> failed` recovery with recovery of expired
  leases only. Lock the current policy: expired interrupted work is marked failed
  exactly once with a safe error unless a separately documented retry policy is
  implemented and tested.
- [ ] Make terminal G-R4 publication require the active lease fence in its same
  transaction. Replays by the same completed token are idempotent; different/stale
  tokens cannot rewrite results.
- [ ] Remove `QUALIFICATION_THRESHOLD` and `MIN_RELEVANCE_SCORE` from runtime config,
  `.env.example`, and active docs unless an existing locked decision truly consumes
  them. Do not wire inert knobs into qualification as an unreviewed product change.
- [ ] Add narrow ignore rules for local n8n exports/secret-bearing source artifacts
  without hiding ordinary source or evidence. Add a repository check that fails on
  credential-shaped assignments while redacting values.
- [ ] Record all credential identifiers requiring user rotation/revocation by
  provider and file location only. Rotation remains a user prerequisite; do not
  mark it complete without external evidence.

### Adversarial verification

- [ ] Two workers cannot claim the same run under simultaneous database operations.
- [ ] A healthy unexpired run survives another process startup and recovery scan.
- [ ] An expired run transitions once; reverse-order heartbeat/recovery and stale
  completion cannot resurrect or overwrite it.
- [ ] Heartbeat failure, process death, lease expiry during an external call, and
  completion racing expiry all obey the token fence and publish no partial results.
- [ ] Migration upgrade/replay preserves existing queued/running/completed/failed
  rows and makes legacy null lease fields safe.
- [ ] Config tests and docs expose no inert thresholds.
- [ ] `git check-ignore` proves the targeted secret-bearing workflow export is
  excluded, while source, `.env.example`, fixtures, and handoffs remain visible.
- [ ] Secret scans and logs contain identifiers/paths only and no credential values.

### Migration implications

Forward-only lease migration required and must be tested after G-R4 migrations on
the same disposable database baseline. No live migration or historical state
rewrite is authorized.

### Required commands and acceptance

```bash
cd "/home/harit/Email Scrapper/email_scraper"
npx prisma format
npx prisma validate
ALLOW_DATABASE_TESTS=true TEST_DATABASE_URL="<disposable-url>" npm run test:integration
node --test test/prisma-run-repository.test.js test/server.test.js
npm test
git check-ignore -v "My workflow 3.json"
git diff --check
git status --short
```

Also execute a bounded, redacted repository secret scan whose command and pattern
classes are recorded in the handoff without captured matches/values.

Acceptance requires real concurrent disposable-database proof for atomic claim,
heartbeat, expiry recovery, and stale-token rejection. Sequential mocks alone are
not proof. Known exposed credentials remain a clearly named deployment blocker
until the user confirms rotation.

### Handoff and stop condition

Create `email_scraper/review-evidence/G-R6_HANDOFF.md` with migration evidence,
concurrency results, config/docs changes, redacted hygiene results, skipped checks,
and remaining user actions. Update only G-R6 status/evidence and stop.

---

## 12. Corrective coverage matrix

| Review finding | Corrective window | Decisive evidence |
| --- | --- | --- |
| Empty contact route qualifies | G-R1 | Full pipeline soft-404 contact fixture rejects |
| Rejected v2 becomes legacy | G-R4, G-R5 | Persisted/API/UI not-scored-v2 fixture |
| General store passes brand gate | G-R2 | General store rejects; specialist fixture passes |
| Incidental opening-soon rejection | G-R2 | Active About-copy fixture remains active |
| Order/SKU phone | G-R1 | Negative context beats generic contact word |
| Fractional score versus Int | G-R4 | PostgreSQL round trip of `82.29` |
| Intent claim rate-limit bypass | G-R4 | Concurrent direct/claim admission test |
| Browserless redirect attribution | G-R2 | Strict final-URL fixture and external redirect rejection |
| Unbounded response buffering | G-R2 | Byte-read/cancel assertion at cap |
| Exact category input lost | G-R3, G-R4 | Boundary trace plus durable/API round trip |
| False matched categories | G-R3, G-R5 | Mixed-intent pipeline and truthful render |
| Query-cache provenance leak | G-R3 | One provider call, two intact candidate records |
| Expanded UI omissions | G-R5 | Actual full-evidence component render |
| Database proof missing | G-R4, G-R6 | Executed disposable PostgreSQL suites |
| Multi-instance startup failure | G-R6 | Two-worker lease/recovery test |
| Dead threshold config | G-R6 | Removal plus config/docs regression |
| Credential-bearing workflow inclusion | G-R6 + user action | Ignore/scan proof plus user rotation confirmation |
| Rejection precedence | G-R2 | Multi-cause reason table tests |
| Social ownership association | G-R1 | Store versus vendor profile fixtures |
| Backend CSV formula injection | G-R5 | Backend/frontend malicious-cell fixtures |
| Completed-run rewrite | G-R4, G-R6 | State guard then lease-token fence |
| Unsafe frontend casts | G-R5 | Malformed response fails closed |
| Mixed-version seed data | G-R5 | Consistent legacy/scored/unscored fixture render |
| Helper-only frontend tests | G-R5 | Actual details component and stale-state evidence |

## 13. Final parent re-review gate

After G-R1 through G-R6 are complete, the parent must independently rerun the
Section 10 review plus every reproduction in Section 11.1. Overall remediation
may be accepted only when:

- [ ] every coverage-matrix row has the named decisive evidence;
- [ ] backend and frontend full verification passes;
- [ ] G-R4 and G-R6 migrations upgrade/replay on a disposable PostgreSQL database
  with preserved baseline rows;
- [ ] concurrent worker tests prove claim, heartbeat, expiry, and finalization
  fencing rather than mocking away the database race;
- [ ] no v2 rejected/failed row renders as legacy or receives a score;
- [ ] no untrusted page, number, social profile, canonical, or rendered redirect can
  qualify or score a lead;
- [ ] every collected evidence field is visible and exportable truthfully;
- [ ] no inert configuration is advertised;
- [ ] deployment remains blocked on any credential rotation not confirmed by the
  user; and
- [ ] unavailable live/provider checks are reported as unavailable, not replaced
  by synthetic claims.

If a corrective implementation introduces another invariant failure, append a new
stable window identifier beginning with `G-R7`; do not reopen or rewrite a
completed window.

## 14. Corrective planning readiness gate

- [x] The original checklist remains the single authoritative contract.
- [x] Every primary and secondary review finding appears in the coverage matrix.
- [x] Every safety invariant has one owning implementation window, with later
  presentation or fencing work named separately where required.
- [x] Window dependencies are sequential and acyclic.
- [x] Exact deterministic reproductions are named before bounded fixes.
- [x] External Browserless behavior must be proven through one pinned contract or
  fail safely; fallback probing is prohibited.
- [x] Migration, preservation, transaction, and concurrency claims require a
  disposable PostgreSQL database and cannot pass while its suite is skipped.
- [x] Live provider calls, production migration, deployment, credential rotation,
  and destructive historical rewrites remain outside agent authority.
- [x] Frontend implementation is downstream of the corrected persisted/API
  contract and must follow the repository's Next.js instructions.
- [x] Each window has explicit ownership, non-goals, adversarial verification,
  acceptance, handoff, and stop conditions.
- [x] The final parent re-review can still fail the remediation even if every
  implementation window is marked complete.

The corrective plan is ready to assign G-R1. Checked items describe planning
readiness only; they do not assert that any correction has been implemented.
