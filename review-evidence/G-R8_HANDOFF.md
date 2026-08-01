# G-R8 handoff — Broad-store-resistant specialist classification

Status: **COMPLETE**

Date: 2026-08-01

## Outcome

The exact F1 broad Organization reproduction now returns `category_seller`.
Brand intent rejects it as `wrong_store_type`; retailer/unspecified intent can
still accept truthful category-seller evidence.

An incidental title, heading, Organization name/description, navigation entry,
collection link, or promotional mention cannot independently promote a broad
multi-department store to `specialist`.

## Changed files

Runtime:

- `src/storefront-validator.js`

Tests:

- `test/validation-and-security.test.js`
- `test/pipeline.test.js`

No contact rule, category vocabulary generation, page budget, score weight,
schema, migration, persistence, API, frontend, provider, or running server was
changed.

## Contract established

- Typed `category`/`knowsAbout` fields are separated from weak site-identity
  fields such as title, heading, Organization name, description, and slogan.
- Structured claim evidence retains its field and JSON-LD path. Claims nested
  under Product/Brand/manufacturer/vendor/seller/provider contexts are blocked.
- `specialist` requires one of:
  - an explicit typed category claim with no contradictory store breadth;
  - category site identity corroborated by navigation/collection/product-depth
    assortment evidence, with no breadth; or
  - two independent assortment signal kinds, with no breadth.
- Three or more general-department terms on a high-level page are contradictory
  breadth. This evidence blocks weak or corroborated claims from overriding the
  broad-store classification.
- Decisions retain per-page claim kinds, source/path, negative terms,
  assortment kinds, the breadth block, and the controlling reason.
- `unknown`, `mismatch`, `category_seller`, and `specialist` remain distinct.

## Deterministic coverage

- Exact broad Organization description containing eyewear plus toys,
  electronics, furniture, groceries, and garden products.
- Broad fixtures with the category only in title, H1, Organization description,
  navigation, collection link, or promotional copy.
- Positive typed OnlineStore category evidence.
- Positive site identity plus collection/navigation corroboration.
- Brand rejection and retailer acceptance for the same broad seller.
- Evidence-page reverse-order stability.
- Full-pipeline proof that the exact broad Organization fixture produces a
  rejected `wrong_store_type` row and records the breadth block.
- Existing activity, rejection precedence, Browserless, and G-R7 contact tests.

## Verification

Executed from `email_scraper`:

```text
node --test test/validation-and-security.test.js test/pipeline.test.js
PASS (exit 0)

npm test
117 tests: 114 passed, 0 failed, 3 database-gated skipped (exit 0)
The suite used temporary loopback permission for the server test.

npx prisma validate
PASS (exit 0)

git diff --check
PASS (exit 0)
```

No live storefront/provider, primary/production database, migration, deployment,
credential action, or server stop/restart occurred.

## Residual risk

This is deterministic controlled-fixture classification, not live precision/
recall calibration. Any future labeled-store calibration remains separately
authorized work and must preserve the breadth precedence invariant.

## Stop boundary

G-R9 was not started until G-R8's focused and full checks passed.
