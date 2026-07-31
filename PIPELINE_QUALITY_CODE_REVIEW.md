# Pipeline Quality Code Review

Date: 2026-07-31

Scope: Query planning, Google discovery, store resolution, Shopify and category
validation, page discovery, contact extraction, lead scoring, deduplication,
persistence, and frontend result presentation.

This review was read-only. No application code or running server was changed.

## Executive summary

The pipeline is structurally sound and isolates individual search/store failures,
but several permissive classification rules can silently turn weak or unrelated
evidence into qualified leads. The highest-priority problems are deterministic;
they do not depend on AI normalization.

The latest completed eyewear run contained 78 output rows: 62 qualified, 14
rejected, and 2 failed. Review of that run confirmed product and collection URLs
being classified as contact pages, generic sharing links being stored as store
social profiles, product titles being used as store names, and stores with only a
single relevant product being treated as category-specific brands.

Important correction: `ENABLE_AI_NORMALIZATION` was `false` for the reviewed
run. The false contact page assigned to The Southernist came from the deterministic
URL-path classifier. The optional AI normalizer has an additional permissive URL
rule that must also be corrected before it is enabled.

## Critical findings

### P0. Product, collection, blog, and asset URLs can become contact pages

Affected code:

- `src/contact-extractor.js`, `extractContactEvidence()`
- `src/sitemap.js`, `CONTACT_PATH`
- `src/ai-normalizer.js`, `allowedContactUrls`
- `src/pipeline.js`, qualification gate

The deterministic contact classifier searches for words such as `contact`,
`support`, and `help` anywhere in a URL pathname. It does not first require the
URL to represent an appropriate page or policy route.

Confirmed examples from the latest run include:

- `/products/southern-fried-barn-design-support-local-farmer`
- `/products/new-1-set-unisex-contact-lens-case-box-...`
- `/collections/high-support-sports-bra`
- `/products/s1000r-cowl-support`
- `/collections/contact-lenses`
- `/cdn/shopifycloud/storefront/assets/themes_support/...js`

Because the final qualification rule accepts any populated `contactUrl`, these
URLs can qualify a lead with no email or phone.

The optional AI normalizer independently allows any examined page URL as a
possible contact URL. Enabling AI normalization would therefore not resolve the
problem.

Required changes:

1. Classify a URL by route type before checking keywords.
2. Permit explicit routes such as `/pages/contact`, `/pages/contact-us`,
   `/pages/support`, `/pages/help`, and `/policies/contact-information`.
3. Reject `/products`, `/collections`, `/blogs`, `/cdn`, and asset extensions as
   contact routes regardless of words inside their slugs.
4. Apply the same validator after deterministic extraction and AI normalization.
5. Add a separate evidence-page concept so an about/privacy page can be examined
   without automatically counting as a direct contact method.

### P0. Category intent such as "brand" is discarded

Affected code: `src/category-input.js`, `normalizeShopType()`.

Trailing `brand` or `brands` is removed during normalization. For example,
`Eyewear Brand` becomes `eyewear`.

The resulting workflow discovers any Shopify store selling a matching product,
not necessarily a brand or a store primarily associated with the category. This
explains results such as electronics, automotive, museum, cycling, and general
stores that happen to sell one eyewear-related item.

Required changes:

1. Preserve the original category intent as structured data, for example
   `{ category: "eyewear", businessType: "brand" }`.
2. Separate product relevance from store-level category fit.
3. Inspect homepage, collection, navigation, organization metadata, and product
   assortment before calling a store an eyewear brand.
4. Expose whether a result is a specialist brand, specialist retailer, or general
   seller.

### P0. Google result metadata can manufacture storefront relevance

Affected code: `src/storefront-validator.js`, `validateStorefront()`.

Relevance is calculated from the Google title and snippet combined with fetched
HTML. The title/snippet normally contains the query vocabulary precisely because
Google returned it for that query. This allows the discovery evidence to validate
itself.

A deterministic reproduction produced relevance `100/100` for unrelated
storefront HTML solely because the supplied Google title and snippet contained the
query terms.

Required changes:

1. Calculate storefront relevance only from independently fetched page content.
2. Score the product page and the broader store/category evidence separately.
3. Require meaningful term coverage instead of the current low threshold.
4. Store the matched terms and source pages so the relevance score is auditable.

### P0. Unstructured digit sequences can be treated as phone numbers

Affected code: `src/contact-extractor.js`, phone extraction and normalization.

The extractor scans visible page text for digit-like sequences. An eight-digit
product code was accepted as a phone number in a deterministic reproduction.
Product pages can therefore contribute SKUs, order references, promotion codes,
or other numeric content as contacts.

Required changes:

1. Prefer `tel:` links and structured `telephone` values.
2. Accept free-text phone candidates only with nearby contact labels or on a
   verified contact page.
3. Add country-aware plausibility checks while retaining the raw display value.
4. Record the extraction method and confidence.
5. Do not let an unverified number satisfy the qualification gate.

### P0. Social extraction includes sharing and platform-owned links

Affected code: `src/contact-extractor.js`, social-profile extraction.

Every URL on a supported social hostname is currently accepted. This includes
Facebook sharers, Twitter share links, Pinterest pin creation, and Shopify's own
social accounts. At least 28 rows in the reviewed run contained generic social
links of this kind.

Required changes:

1. Reject sharing, intent, pin-creation, login, and platform-root URLs.
2. Reject known platform/vendor accounts such as Shopify's accounts.
3. Normalize supported profile paths and discard non-profile URLs.
4. Optionally verify that the profile name or linked website matches the store.
5. Do not award social score points until the profile passes validation.

## High-impact findings

### P1. Initial storefront validation does not use Browserless

Affected code:

- `src/domain-resolver.js`
- `src/pipeline.js`
- `src/page-fetcher.js`

The original Google result is fetched with the ordinary HTTP client and then
immediately validated. Browserless is only used later for additional evidence
pages. A JavaScript storefront can therefore be rejected for insufficient content
without ever being rendered. Conversely, a large challenge or application shell
can be treated as usable HTML.

Required changes:

1. Route initial product/homepage fetching through the same ordinary-then-rendered
   fetch strategy.
2. Trigger rendering when extracted text, Shopify markers, or product evidence is
   insufficient—not merely when response bytes are low.
3. Detect challenge, bot-block, and consent pages separately from inactive stores.

### P1. Store names can be product names

Affected code: `src/contact-extractor.js`, `structuredContacts()`.

The JSON-LD traversal takes the first `name` it finds without checking whether the
object is a `Product`, `Organization`, or `WebSite`. Product result pages therefore
frequently save product titles as store names.

Confirmed examples include product-style names such as Cartier model names,
replacement lenses, prescription sunglasses, and pickleball glasses.

Required changes:

1. Prefer `Organization`, `LocalBusiness`, `OnlineStore`, and `WebSite` objects.
2. Use `og:site_name` and homepage metadata as fallbacks.
3. Never treat a `Product.name` as the store name.
4. Store product title separately if it is useful evidence.

### P1. Deduplication keeps the first occurrence instead of merging evidence

Affected code: `src/pipeline.js`, `resolvedStores` map.

The first candidate for a resolved domain is retained. Later occurrences only
increment `duplicateCount`. This loses:

- other matching categories;
- other queries and ranks;
- alternate product evidence;
- potentially better fetched HTML;
- the strongest query or Google rank.

For multi-category runs, the store is assigned only to whichever category found
it first. A weak first result can also cause rejection even when a later result
would validate correctly.

Required changes:

1. Accumulate all discovery occurrences under a stable store identity.
2. Select the best representative page after resolution and validation.
3. Preserve arrays of matched categories, queries, ranks, and result URLs.
4. Use merged evidence for relevance and contact discovery.

### P1. Cross-domain canonical URLs are trusted as store identity

Affected code: `src/domain-resolver.js`, canonical handling.

An arbitrary cross-domain canonical can become `resolvedDomain`, receive identity
confidence `100`, and be added to the allowed fetch-host set without proving that
it belongs to the same storefront. This was reproduced with a stubbed response.

Required changes:

1. Treat HTTP redirects as stronger identity evidence than canonical tags.
2. Accept cross-domain canonicals only after fetching and verifying reciprocal
   Shopify/store evidence.
3. Keep unverified canonicals as evidence, not as trusted identity or fetch scope.

### P1. Lead scores are not calibrated to lead quality

Affected code: `src/lead-scorer.js` and early rejection handling in
`src/pipeline.js`.

The score can be high due to Shopify, relevance, and domain-identity points even
when a store is later rejected. Invalid stores therefore retain visually strong
scores such as EyeMart's rejected score of 69.

The score is also inflated by the permissive phone, social, and contact URL
extractors. Many rows saturate near 94-100, reducing the score's ranking value.
Identity confidence is neither persisted nor shown, so users cannot reconstruct
the score.

Required changes:

1. Validate evidence before scoring it.
2. Separate store confidence, category fit, and contactability into visible
   subscores.
3. Set the lead score to null for structurally invalid/inactive stores, or present
   it explicitly as a pre-contact confidence score.
4. Persist the full score breakdown and scoring version.
5. Calibrate thresholds using reviewed labeled leads.

### P1. Query probe relevance is too permissive

Affected code: `src/query-prober.js`.

A Google result is marked relevant if any one query term occurs in its title,
snippet, or URL. Candidate confidence is unused. Every candidate with any attached
research source receives the full market-evidence score even if that source does
not support that particular product phrase.

Pagination availability earns a score bonus, although later pages are not fetched.
Only the first ten Google results per selected query enter the pipeline.

Required changes:

1. Require phrase or multi-term coverage and distinguish generic from distinctive
   query terms.
2. Use candidate confidence only if it is evidence-grounded and calibrated.
3. Link market evidence to individual claims/candidates instead of testing only
   whether a source array is non-empty.
4. Do not reward unused pagination, or implement bounded pagination when the
   additional coverage is valuable.

### P1. Page ordering can omit the best contact page

Affected code:

- `src/sitemap.js`, `discoverStorePages()`
- `src/pipeline.js`, per-store page loop

Result URLs are placed before discovered contact pages, and the combined list is
truncated to `MAX_PAGES_PER_STORE` (currently 5). About, legal, privacy, or
misclassified product URLs can consume the budget before a genuine contact page.
Pages are fetched sequentially within each store.

Required changes:

1. Rank explicit contact routes first, followed by support/help, about, and policy
   evidence.
2. Exclude duplicate original/final URLs without consuming the page budget.
3. Reserve at least one slot for the homepage and one for an explicit contact page.
4. Fetch selected evidence pages with bounded per-store concurrency.

## Medium-impact and observability findings

### P2. First-found contact values win without evidence ranking

`consolidateEvidence()` retains the first email, phone, store name, and contact URL
encountered. Product pages are generally processed before contact pages, so footer
or product-page values can beat higher-quality contact-page evidence.

Evidence should instead be ranked by source type, extraction method, repetition,
domain match, and context.

### P2. Query and operation failures are stored as lead rows

Search failures, empty searches, invalid result URLs, and resolution failures are
written into the same lead collection as actual stores. Consequently, the UI's
"All leads" count includes operational audit rows and can show unnamed stores.

Query/run audit records should be stored separately from store leads while
remaining accessible for diagnostics.

### P2. HTTP runs discard detailed query-planning audits

The query planner produces useful selected/rejected probe audits, but HTTP runs do
not persist or expose them. This makes it difficult to explain why a query was
chosen or repaired after the run completes.

Persist compact query-plan records with the run or expose them through a dedicated
diagnostic endpoint.

### P2. The current qualification model conflates contactability levels

A verified email, a plausible phone, and a help-page URL are all allowed to satisfy
the same qualified status. In the reviewed run, three qualified rows had neither
email nor phone; one of those was the false Southernist contact URL.

Recommended tiers:

- `qualified_direct`: verified email or phone;
- `qualified_indirect`: verified contact form/page but no direct contact;
- `research_only`: relevant store with social or organizational evidence;
- `rejected`: inactive, wrong category, or no usable outreach path.

## Frontend presentation findings

Affected code: `../frontend/components/results-table.tsx`.

The compact Contact column renders email if available; otherwise it renders phone;
otherwise it says `No contact found`. It cannot display both email and phone and
does not consider contact-page or social evidence in that message.

The expanded view currently shows the Google result, contact-page label, and email
source. It omits the actual email, phone, phone source, and all collected social
profiles. Missing URLs are still rendered as plain labels, which can look like
available sources.

Required frontend change:

Show all available information in the expanded view:

- email;
- email source URL;
- phone;
- phone source URL;
- verified contact page/form;
- every sanitized store social profile;
- resolved, canonical, and MyShopify domains where useful;
- category/store-fit evidence;
- lead-score breakdown;
- explicit rejection reason and supporting evidence;
- extraction method/confidence once available.

Absent fields should be clearly marked as unavailable or omitted. A label must not
look clickable unless a valid URL exists. The compact row may retain one primary
contact, but it should display a channel count or indicators for all available
contact methods.

The backend API, database, and CSV export already preserve email, phone, source
URLs, contact URL, and social profile fields. This is presentation loss, not data
loss.

## Test coverage gaps

The existing test suite emphasizes happy paths. Missing negative regression tests
include:

1. Product/collection/blog/asset URLs containing contact keywords.
2. Product codes and order numbers that resemble phones.
3. Social sharing URLs and vendor-owned profiles.
4. Product JSON-LD names versus organization names.
5. Relevance calculated without Google metadata leakage.
6. JavaScript storefront rendering before inactive-store rejection.
7. Unverified cross-domain canonicals.
8. Duplicate stores found through multiple categories and queries.
9. Contact-page priority when the page budget is exhausted.
10. Score behavior for inactive and no-contact stores.
11. Expanded frontend rendering of every contact field and source.

Verification performed during review:

- Backend: 44 tests passed, 0 failed, 1 database integration test intentionally
  skipped because it requires an explicit test database.
- Frontend: 2 tests passed, 0 failed.
- Deterministic reproductions confirmed false contact-path classification,
  product-code phone extraction, Google-metadata relevance leakage, and unverified
  canonical-domain trust.

## Recommended implementation order

### Phase 1: Stop false qualification

1. Introduce strict contact-route validation.
2. Introduce phone and social evidence validation.
3. Calculate relevance from fetched content only.
4. Preserve brand/specialist intent and add store-level category validation.
5. Reclassify existing qualification into direct, indirect, research-only, and
   rejected tiers.

### Phase 2: Improve evidence quality

1. Use the rendered-fetch fallback for initial storefront validation.
2. Extract organization/store names by structured-data type.
3. Rank evidence sources rather than taking the first value.
4. Merge duplicate discoveries and retain all provenance.
5. Verify cross-domain canonical identities.
6. Rework and version the score model.

### Phase 3: Improve usability and observability

1. Show all collected information in expanded frontend rows.
2. Show score components and qualification evidence.
3. Separate query/operation failures from lead rows.
4. Persist query-planning audits.
5. Add the negative regression suite before rerunning production-quality probes.

Existing stored leads should be considered provisional until Phase 1 is complete.
After those changes, rerun the eyewear category and manually label a sample to
calibrate precision before expanding to additional categories.
