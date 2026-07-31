# G1 handoff — Trusted contact and store identity evidence

Status: **COMPLETE**

Date: 2026-07-31

## Outcome

G1 now exposes reusable, source-proven evidence for email, phone, contact pages,
social profiles, organization names, and store identity while retaining the
legacy scalar fields consumed by the current pipeline.

Controlled before/after reproduction:

| Defect | Before G1 | After G1 |
| --- | --- | --- |
| `/products/customer-support-widget` | `contactUrl` populated | rejected as `excluded_store_route` |
| Product text `SKU 12345678` | phone `12345678` | no phone evidence |
| Facebook sharer URL | stored as social profile | rejected as non-profile path |
| JSON-LD `Product.name` | stored as store name | excluded from organization evidence |
| Cross-domain canonical on MyShopify page | resolved host, allowed fetch host, confidence 100 | evidence-only, absent from fetch scope, confidence 70 |

The final combined reproduction returned empty contact, phone, social, and store
name fields; resolved/stable identity remained the observed MyShopify hostname;
and the unrelated canonical was marked untrusted.

## Changed files

Runtime:

- `package.json`
- `package-lock.json`
- `src/contact-evidence.js`
- `src/contact-extractor.js`
- `src/ai-normalizer.js`
- `src/domain-resolver.js`
- `src/sitemap.js`

Tests and controlled provider fixtures:

- `test/extraction-and-scoring.test.js`
- `test/domain-and-sitemap.test.js`
- `test/pipeline.test.js`
- `test/fixtures/providers/openai/README.md`
- `test/fixtures/providers/openai/chat-completions-normalization-v1-success.json`
- `test/fixtures/providers/openai/chat-completions-normalization-v1-refusal.json`
- `test/fixtures/providers/openai/chat-completions-normalization-v1-incomplete.json`
- `test/fixtures/providers/openai/chat-completions-normalization-v1-missing-content.json`
- `test/fixtures/providers/openai/chat-completions-normalization-v1-missing-choices.json`
- `test/fixtures/providers/openai/chat-completions-normalization-v1-additive-inner.json`
- `test/fixtures/providers/openai/chat-completions-normalization-v1-malformed.json`

Tracking:

- `review-evidence/G1_HANDOFF.md`
- `../PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` (G1 status/evidence only)

## Contracts established

- Normalized evidence objects contain `kind`, `value`, `sourceUrl`, `method`,
  `confidence`, and `validationReason`.
- A single route classifier distinguishes contact, organization-evidence,
  other, and rejected routes. Deterministic extraction, sitemap discovery, and
  AI-normalized contact URLs consume it.
- Product, collection, blog, search, account, cart, CDN, and asset paths are
  rejected before route keywords are evaluated.
- Structured `telephone` and `tel:` evidence are strong. Visible phone text
  requires an explicit phone label or a formatted number on a verified contact
  route; SKU/order context is rejected.
- Email evidence is normalized, syntactically validated, and screened for
  placeholder/reserved domains and non-contact mailboxes.
- Social URLs use platform-specific profile paths and reject share, intent,
  login, content, root, and Shopify/vendor profiles.
- Organization names come from typed Organization/LocalBusiness/OnlineStore/
  WebSite JSON-LD, site metadata, or homepage-only title fallback. Product names
  never enter organization evidence.
- Only original/final fetched hosts enter `allowedHostnames`. Cross-domain
  canonicals remain recorded but untrusted. Observed MyShopify hosts become the
  stable identity when available.
- AI normalization uses the versioned
  `openai-chat-completions-shopify-lead-v1` Zod adapter. Consumed fields have one
  exact path; refusals, incomplete output, malformed JSON, missing fields, and
  inner schema drift raise privacy-safe typed errors.
- Additive outer provider metadata is documented and ignored. Additive inner
  lead fields are rejected. AI-selected values are revalidated against the
  deterministic evidence sets.

Zod `4.4.3` is pinned as an exact runtime dependency.

## Verification

Executed from `/home/harit/Email Scrapper/email_scraper`:

```text
node --test test/extraction-and-scoring.test.js
PASS (exit 0)

node --test test/domain-and-sitemap.test.js test/validation-and-security.test.js
PASS (exit 0)

npm test
57 tests: 56 passed, 0 failed, 1 skipped
```

The skipped test is the pre-existing Prisma integration test that requires an
explicit disposable `TEST_DATABASE_URL`. No live or production database was
used. The full suite required permission only to bind temporary loopback ports
for the existing server tests.

Final hygiene checks:

```text
git diff --check
PASS

git status --short
Reviewed; only the files listed above are G1 changes. Existing user-owned dirty
worktree entries were preserved.
```

No live OpenAI, Google, Browserless, storefront, or database call was made.

## Residual risks and deferred work

- Local phone candidates are retained only with source/context proof; no default
  country is guessed. Full region-aware parsing would require an explicit page
  country contract and is not inferred in G1.
- Cross-domain canonicals are deliberately evidence-only. Independently fetching
  and proving reciprocal ownership is not added by this window.
- AI verification is fixture-backed because live provider probes are outside the
  authorized acceptance boundary.
- Final qualification, score v2, persistence, category fit, rendering fallback,
  page-budget ranking, and frontend presentation remain owned by G2-G4.

## Stop confirmation

G2, G3, and G4 were not started. No score weights, final qualification rules,
persistence schema, category/query behavior, Browserless behavior, or frontend
code was changed.
