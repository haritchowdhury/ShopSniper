# G-R1 handoff — Contact evidence proves a reachable outreach channel

Status: **COMPLETE**

Date: 2026-08-01

## Outcome

G-R1 restores corrective invariants C1-C2. A route-shaped URL no longer creates
contact-page evidence by itself. Contact pages now pass one normalized decision
covering route acceptance, verified host association, HTTP/page usability,
positive contact signals, a validation reason, and the source URL.

The exact review reproductions now behave as follows:

| Reproduction | Result after G-R1 |
| --- | --- |
| `Not found` at `/pages/contact-us` | no contact evidence; pipeline rejects with no score |
| `Contact support with order number 1234 5678` | no phone evidence |
| syntactically valid theme/vendor social profile | no social evidence |
| same-store form without email or phone | indirect contact; pipeline qualifies |

## Changed files

Runtime:

- `src/contact-evidence.js`
- `src/contact-extractor.js`
- `src/pipeline.js`

Tests:

- `test/extraction-and-scoring.test.js`
- `test/page-fetcher.test.js`
- `test/pipeline.test.js`

Tracking:

- `review-evidence/G-R1_HANDOFF.md`
- `../PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` (G-R1 status/evidence only)

No Prisma schema, migration, API, frontend, score weights, storefront-fit logic,
provider contract, configuration, or later corrective window was changed.

## Contracts established

- `assessContactPage` returns an immutable normalized decision with `accepted`,
  `routeAccepted`, `routeReason`, `sameStore`, `httpUsable`, `pageUsable`,
  `positiveSignals`, `validationReason`, and `sourceUrl`.
- Contact-page evidence requires an accepted contact route, a verified store host,
  a usable successful page, and at least one substantive signal: a usable contact
  form, validated direct method, ContactPage structured data, or contact heading
  plus non-trivial body content.
- Blank, whitespace-only, tiny non-substantive, generic error/soft-404, challenge,
  and unsuccessful responses cannot contribute contact methods or profiles.
- `tel:` and typed Organization/ContactPoint phones remain strong. Visible-text
  candidates reject order, invoice, tracking, model, SKU, VAT, year/range,
  quantity, and related identifier context before generic `contact`/`support`
  context is considered. A nearer explicit phone label remains a positive signal.
- Social profiles require Organization `sameAs`, a store-owned header/navigation/
  footer location, or an About/Contact evidence page. Theme/designer/developer/
  vendor credit contexts and unassociated body links are rejected. Retained social
  evidence records its association reason.
- Legacy scalar compatibility pages can retain validated emails but cannot
  manufacture phone, contact-page, or social evidence.
- The pipeline supplies requested/final URL, verified allowed hosts, status, and
  fetch assessment to extraction. AI normalization and final contactability/score
  inputs continue to select only entries from the normalized evidence sets.

## Fixture provenance and adversarial coverage

All fixtures use controlled fictional hosts and contact values. No live storefront
or provider response was captured.

- Unit decision matrix: blank, whitespace, `Not found`, title-level 404,
  challenge, HTTP 503, same-store form, and cross-host form.
- Unusable template contact fixture proves a soft-404 email is not retained.
- Phone table covers the exact order-number reproduction plus SKU, tracking, VAT,
  and model identifiers. Existing and new positives cover `tel:`, structured
  Organization data, punctuation, country code, and extension-adjacent text.
- Social fixture covers Organization `sameAs`, store header ownership, an
  unassociated body profile, and a theme/vendor footer profile.
- Render fallback fixture proves an unusable ordinary page invokes the existing
  bounded Browserless path and a rendered form must pass the same decision.
- Full-pipeline fixture proves `Not found` is rejected with empty `lead_score` and
  null breakdown, while a same-store form qualifies only as indirect contact.
- Existing research-only pipeline coverage proves social-only evidence does not
  qualify or score.

## Verification

Executed from `/home/harit/Email Scrapper/email_scraper`:

```text
node --test test/extraction-and-scoring.test.js test/page-fetcher.test.js test/pipeline.test.js
PASS (exit 0)

npm test
84 tests: 83 passed, 0 failed, 1 skipped (exit 0, before a test database was supplied)

ALLOW_DATABASE_TESTS=true node --env-file=.env --test test/prisma-run-repository.integration.test.js
1 test: 1 passed, 0 failed, 0 skipped (exit 0)

ALLOW_DATABASE_TESTS=true node --env-file=.env --test
84 tests: 84 passed, 0 failed, 0 skipped (exit 0)

npx prisma validate
PASS — schema is valid (exit 0)

git diff --check
PASS (exit 0)
```

After the user supplied an explicit disposable `TEST_DATABASE_URL`, the first
integration attempt safely confirmed that the database was empty. The repository's
three existing forward-only migrations were then applied to that test URL only.
The focused database test and the complete suite passed with database testing
enabled; fixture `Run` rows were removed by the test's `finally` cleanup. G-R1
introduced no migration and no configured primary/live database was used.

No live OpenAI, Google, Browserless, storefront, primary database, or frontend
call was made. Only the explicitly supplied disposable test database was used.

## Residual risks and deferred work

- The current Browserless adapter still substitutes the requested URL for the
  rendered response's observed final URL. G-R2 owns the pinned Browserless final-
  URL contract; until then, the normalized same-store decision can validate only
  the final URL supplied by that adapter.
- Social ownership is deterministic provenance association, not external account
  ownership verification. Profiles must originate from Organization `sameAs` or
  designated store-owned page regions and retain the association reason.
- Phone extraction deliberately performs no country inference or deliverability
  verification.
- Durable/API null-score semantics remain owned by G-R4. G-R1 preserves the
  pipeline's current empty scalar plus null score-breakdown compatibility shape.

## Stop confirmation

G-R2-G-R6 were not started. No live migration, provider call, deployment,
credential change, or running user server action was performed.
