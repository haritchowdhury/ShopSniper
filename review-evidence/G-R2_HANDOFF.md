# G-R2 handoff — Storefront truth, redirect attribution, and bounded fetching

Status: **COMPLETE**

Date: 2026-08-01

## Outcome

G-R2 restores corrective invariants C3-C4. Store specialization and activity are
now explicit page-evidence decisions, rendered content is attributable only
through the pinned Browserless final-URL contract, and HTTP response limits are
enforced while streaming bytes rather than after buffering the complete body.

The exact review reproductions now behave as follows:

| Reproduction | Result after G-R2 |
| --- | --- |
| General department homepage with `aviator glasses` and `reading glasses` | `category_seller`; brand intent rejects as `wrong_store_type` |
| Active storefront plus About text `second location opening soon` | remains active and valid |
| Browserless render redirected to an external host | rendered body discarded; it cannot contribute identity, fit, activity, or contact evidence |
| Chunked body exceeding `maxBytes` without `Content-Length` | reader stops at the first over-cap chunk, cancels, and throws a typed size-limit error |

## Changed files

Runtime:

- `src/browserless-adapter.js` (new)
- `src/http-client.js`
- `src/page-fetcher.js`
- `src/domain-resolver.js`
- `src/storefront-validator.js`
- `src/pipeline.js`

Tests and sanitized provider evidence:

- `test/http-client.test.js` (new)
- `test/page-fetcher.test.js`
- `test/domain-and-sitemap.test.js`
- `test/validation-and-security.test.js`
- `test/fixtures/providers/browserless/README.md` (new)
- `test/fixtures/providers/browserless/content-response-headers-v1-success.json` (new)
- `test/fixtures/providers/browserless/content-response-headers-v1-missing-final-url.json` (new)
- `test/fixtures/providers/browserless/content-response-headers-v1-malformed-code.json` (new)

Tracking:

- `review-evidence/G-R2_HANDOFF.md`
- `../PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` (G-R2 status/evidence only)

No Prisma schema, migration, database/API persistence type, frontend, score
weight, category/query propagation, crawl budget, provider credential, or later
corrective window was changed.

## Browserless contract and fixture provenance

Pinned contract: `browserless-content-response-headers-v1`.

Official Browserless documentation reviewed on 2026-08-01:

- `https://docs.browserless.io/rest-apis/content`
- `https://docs.browserless.io/rest-apis/request-configuration`
- `https://docs.browserless.io/open-api/chromium-content`

The configured `POST /content` endpoint returns rendered `text/html`.
Browserless documents `X-Response-URL` as the target page's final URL after
redirects and `X-Response-Code` as the target page's status code. The adapter
consumes only the HTML content type, those two headers, and the bounded body.
Additive response headers are ignored.

Fixtures are fictional and hand-maintained from that documentation. They contain
no token, provider payload capture, customer data, or collected storefront data.
Missing/malformed consumed fields throw `BrowserlessContractError` without
including response content. There is no fallback field or envelope probing.

Rendered evidence additionally requires:

- a successful target status;
- an absolute HTTP(S) `X-Response-URL`;
- the existing public-URL/SSRF check; and
- a hostname already verified from the requested URL, an ordinary redirect, or
  the candidate's established allowed-host set.

Thus Browserless cannot independently widen store identity. Invalid render
attribution falls back only to an already available ordinary response; otherwise
the fetch fails safely.

## Contracts established

### Bounded response bodies

- A declared `Content-Length` above the cap is rejected and the body is cancelled
  before an application read.
- Unknown/chunked bodies are consumed through the web-stream reader and raw bytes
  are counted, not JavaScript characters.
- The first chunk that would cross the cap is not retained; the reader is
  cancelled and `HttpResponseSizeLimitError` with code
  `HTTP_RESPONSE_SIZE_LIMIT` is thrown.
- Size-limit errors are non-retryable even when the HTTP status would otherwise
  be transient.
- Only a fully accepted bounded byte buffer is decoded. No partial oversized text
  is returned to page assessment or contact extraction.
- `requestText` exposes only explicitly allowlisted provider response headers.

### Store-fit evidence tiers

- `specialist` requires an Organization/site category claim, or at least two
  independent category-dominant assortment signal kinds without broad
  multi-department evidence.
- Independent assortment kinds are category navigation, collection assortment,
  and product depth across distinct product pages. Repeated phrases on one page
  do not become independent evidence.
- Isolated product/promotional/body terms produce at most `category_seller`.
- Sufficient fetched content with no category evidence produces `mismatch`;
  blocked or sparse evidence remains `unknown`.
- Decisions retain matched terms, source pages, page types, signal kinds,
  breadth/negative evidence, per-page evidence, and a named reason.
- Brand intent still requires `specialist`; retailer/unspecified intent accepts a
  specialist or category seller.

### Activity and rejection ordering

- Store inactivity requires structural page-level lock evidence: a password
  route, a password form action, or a password template plus password input, and
  absence of normal commerce content.
- Phrase-only `opening soon`, `password`, and `coming soon` matches do not prove a
  lock. Non-storefront evidence pages cannot mark the entire store inactive.
- Validator and pipeline intent selection share one precedence definition:
  inactive, not-Shopify, wrong category, wrong store type, blocked/insufficient
  store evidence, then missing contactability.
- Processing exceptions remain failed outcomes.

## Adversarial coverage

- Pinned Browserless success fixture plus missing final URL and malformed status
  fixtures.
- Same-host rendered content remains usable.
- External redirect, missing final URL, malformed response, and non-successful
  target status cannot contribute rendered evidence.
- Primary/fallback Browserless token behavior remains covered without exposing
  tokens in output.
- Known-length oversized bodies prove cancellation before an application read and
  no transient retry.
- Chunked bodies prove exact byte reads and cancellation at the first over-cap
  chunk; an unread later chunk remains unread.
- Exact-cap multibyte UTF-8 proves the limit counts bytes rather than characters.
- A general multi-department fixture with several eyewear phrases remains a
  category seller and is rejected for brand intent.
- Existing and new positive specialist fixtures remain valid.
- Incidental lock-related storefront and About copy remains active; a structural
  password template rejects.
- Multi-cause fixtures prove structural/fit reasons precede evidence
  insufficiency.
- Existing full-pipeline G-R1 contact qualification tests remain green.

## Verification

Executed from `/home/harit/Email Scrapper/email_scraper`:

```text
node --test test/http-client.test.js test/page-fetcher.test.js test/domain-and-sitemap.test.js test/validation-and-security.test.js test/pipeline.test.js
PASS (exit 0)

npm test
93 tests: 92 passed, 0 failed, 1 skipped (exit 0)

npx prisma validate
PASS — schema is valid (exit 0)

git diff --check
PASS (exit 0)

git status --short
Executed; the repository retains the pre-existing dirty rename/untracked state
described by the checklist.
```

The first sandboxed `npm test` attempt could not bind the server-test loopback
socket (`listen EPERM 127.0.0.1`). It was rerun with explicit loopback permission
and passed. The skipped test is the existing disposable-database integration
gate; G-R2 has no migration or database behavior.

No live Browserless, storefront, Google, OpenAI, database, frontend, deployment,
or credential action was performed.

## Residual risks and deferred work

- The Browserless adapter intentionally fails closed if the documented response
  headers drift or are unavailable. A future provider-contract change requires a
  new named contract and sanitized fixtures rather than fallback probing.
- Store-fit tiers are deterministic and satisfy the controlled adversarial
  contract, but precision/recall calibration still requires a separately
  authorized labeled live-store sample. No statistical calibration is claimed.
- Exact category/query provenance and truthful matched-category construction
  remain owned by G-R3, which must consume G-R2's final `storeFit.state` acceptance
  semantics.
- Durable/API null-score semantics remain owned by G-R4.

## Stop confirmation

G-R3-G-R6 were not started. No live migration, provider call, deployment,
credential change, or running user server action was performed.
