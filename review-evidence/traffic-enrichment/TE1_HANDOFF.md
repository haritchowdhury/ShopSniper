# TE1 Handoff — DataForSEO Strict Adapter

**Window:** TE1  
**Status:** implementation complete; ready for parent review  
**Completed:** 2026-08-02  
**Production enablement:** not claimed; both enrichment flags remain false

## Outcome

Implemented the isolated, fixture-backed DataForSEO bulk traffic request,
client, response contract, and normalized adapter. It is not connected to the
pipeline or persistence. No live provider call was made.

The paid HTTP call explicitly uses zero retries and zero redirects. A transient
or network failure after dispatch is returned as the privacy-safe typed state
`provider_request_ambiguous` so later ledger/orchestration work cannot silently
repeat the paid call.

## Changed files

- `src/enrichment/errors.js`
- `src/enrichment/dataforseo/request.js`
- `src/enrichment/dataforseo/contract.js`
- `src/enrichment/dataforseo/client.js`
- `src/enrichment/dataforseo/adapter.js`
- `test/dataforseo-enrichment.test.js`
- `src/config.js` — DataForSEO settings and enabled-provider assertion only
- `test/config.test.js` — matching DataForSEO tests only
- `review-evidence/traffic-enrichment/TE1_HANDOFF.md`

No Prisma, pipeline, API serializer, CSV, frontend, package, fixture, or CrUX
file was changed.

## Locked implementation contracts

- Request fingerprint: lowercase SHA-256 of canonical UTF-8 JSON containing
  `contractVersion`, pinned endpoint, and the normalized task. It excludes
  credentials and timestamps.
- Adapter output: request fingerprint, normalized scope, ordered per-target
  available/unavailable records, and request-scoped provider-reported cost.
- Typed safe error codes: `configuration_error`, `invalid_request`,
  `provider_request_ambiguous`, `provider_http_error`, `provider_rejected`, and
  `provider_contract_mismatch`.
- Missing requested target: `{ state: "unavailable", reason:
  "provider_omitted_target" }`; no metric value is synthesized.
- Observed response version remains pinned to `0.1.20260731` so provider drift
  fails closed until evidence and fixtures are deliberately updated.

## Test coverage added

- worldwide and NZ fixture normalization;
- target-key association despite provider order;
- complete provider zero preservation;
- missing target versus malformed/null metrics;
- root/task/result cardinality and scope reconciliation;
- wrong scalar types, negative/fractional counts, negative ETV;
- duplicate, unexpected, and malformed provider targets;
- invalid JSON, fallback-root rejection, version and cost drift;
- exact endpoint, item types, nine country codes, worldwide omission behavior;
- hostname canonicalization and rejection of URL components, `www`, Unicode,
  punycode, IPs, invalid labels, duplicates, empty and over-1,000 batches;
- stable fingerprinting and scope separation;
- HTTP Basic request construction with zero retries/redirects;
- enabled-only credentials and disabled startup;
- error/log assertions excluding credentials, auth, provider bodies, and domain
  material;
- additive ignored fields proving they cannot change normalized output.

## Commands and outcomes

From `email_scraper/`:

```text
node --test test/dataforseo-enrichment.test.js test/config.test.js
PASS — 2 test files, 0 failures

npm run check:secrets
PASS — no credential-shaped assignments found

npm test
PASS with localhost binding permission — 155 tests, 152 passed, 0 failed,
3 skipped
```

The first sandboxed full-suite run could not bind `127.0.0.1` and therefore
reported the server test files as failed. Re-running the same suite with local
test-server permission passed. This was an execution-environment restriction,
not a product assertion failure.

The three full-suite skips were the repository's existing database-dependent
integration checks:

- G-R4 migration replay/preservation proof;
- G-R6 real PostgreSQL lease fencing;
- Prisma repository persistence on an explicit test database.

They are unrelated to TE1, which owns no schema or persistence behavior.

## Skipped checks and residual risks

- No live DataForSEO call was run, as prohibited by TE1.
- No database integration was required or changed.
- The observed provider response version and country location codes are pinned
  evidence and will require deliberate fixture/contract maintenance if the
  provider changes them.
- Written DataForSEO permission for customer-facing display/export remains a
  production gate.
- Paid-request durable ledger, cache, restart recovery, and orchestration are
  later windows; this adapter intentionally does not implement them.

## Stop confirmation

TE2 was not started. No CrUX source, configuration, dependency, or test was
implemented.
