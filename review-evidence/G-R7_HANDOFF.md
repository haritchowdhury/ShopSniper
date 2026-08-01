# G-R7 handoff — Store-associated contact evidence and symmetric phone context

Status: **COMPLETE**

Date: 2026-08-01

## Outcome

The exact F2/F3 reproductions now fail safely. An unrelated product/theme email
does not enter deterministic contact evidence, and a business identifier is
rejected whether its label occurs before or after the candidate. With no other
direct or indirect method, the full pipeline emits a rejected row with no score.

Strong store-owned evidence remains usable: contact-page and owned-layout
`mailto:` links, contact-context visible emails, `tel:` links, and typed
Organization/OnlineStore/LocalBusiness/ContactPoint values.

## Changed files

Runtime:

- `src/contact-evidence.js`
- `src/contact-extractor.js`

Tests:

- `test/extraction-and-scoring.test.js`
- `test/pipeline.test.js`

No schema, migration, provider call, score weight, store-fit rule, API,
frontend, deployment, or running server was changed.

## Contract established

- Visible-text emails require a same-page store-owned contact/organization
  route or an owned header/navigation/footer/address/outreach block, plus the
  applicable outreach context.
- Theme, template, developer, vendor, manufacturer, marketplace, and third-party
  support contexts cannot become store outreach evidence.
- `mailto:` is treated as an explicit outreach action, but it still requires a
  store-owned evidence page, layout region, or marked outreach block.
- Structured email/phone evidence retains its JSON-LD path and is accepted only
  from typed store Organization, OnlineStore, LocalBusiness, or ContactPoint
  nodes. Product/brand/manufacturer/vendor/seller subgraphs are blocked.
- Every retained method records an association-specific validation reason.
- Visible phone candidates inspect bounded context on both sides. Attached
  order, invoice, tracking, model, SKU, VAT, UPC/EAN/ISBN, quantity, reference,
  product, and year labels outrank generic contact/support wording.
- AI normalization and pipeline qualification continue to consume only the
  retained deterministic evidence sets.

## Deterministic coverage

- Exact `support@themevendor.co` product-body reproduction.
- Exact `1234 5678 is your order number. Contact support...` reproduction.
- Identifier labels before and after candidates, including nearby generic
  contact language.
- Product manufacturer JSON-LD email/phone rejection.
- Theme/developer footer and ordinary prose email rejection.
- Positive contact-page `mailto:`, owned-header visible email, `tel:`, label-after
  phone, and typed Organization email/phone fixtures.
- Full-pipeline proof that unrelated direct candidates produce `rejected`,
  `contactability_tier=none`, blank scalar score, and null breakdown.

## Verification

Executed from `email_scraper`:

```text
node --test test/extraction-and-scoring.test.js test/pipeline.test.js
PASS (exit 0)

npm test
112 tests: 109 passed, 0 failed, 3 database-gated skipped (exit 0)
The suite required temporary loopback permission for `test/server.test.js`.

npx prisma validate
PASS (exit 0)

git diff --check
PASS (exit 0)
```

No live provider, storefront, primary/production database, migration, or
deployment was used. The user's running server was not stopped or restarted.

## Residual risk

Association is deterministic document provenance, not mailbox deliverability or
external ownership verification. Country inference and MX/deliverability checks
remain deliberately out of scope.

## Stop boundary

G-R8 was not started until the focused and full G-R7 checks passed.
