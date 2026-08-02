# TE2 Handoff — CrUX REST and BigQuery Strict Adapters

**Window:** TE2  
**Status:** implementation complete; ready for parent review  
**Completed:** 2026-08-02  
**Production enablement:** not claimed; both enrichment flags remain false

## Outcome

Implemented isolated, fixture-backed CrUX REST and BigQuery request builders,
clients, strict response contracts, and normalized adapters. They are not
connected to the pipeline or persistence. No live CrUX or BigQuery call was
made.

The REST client queries one exact validated HTTPS origin and never probes an
alternate origin. BigQuery selects the latest captured public monthly table,
performs a strict dry run, blocks a live request above the configured byte cap,
and then accepts only the pinned one-field JSON-row result contract.

## Changed files

- `src/enrichment/crux/api-request.js`
- `src/enrichment/crux/api-contract.js`
- `src/enrichment/crux/api-client.js`
- `src/enrichment/crux/bigquery-request.js`
- `src/enrichment/crux/bigquery-contract.js`
- `src/enrichment/crux/bigquery-client.js`
- `src/enrichment/crux/adapter.js`
- `test/crux-enrichment.test.js`
- `src/enrichment/errors.js` — additive shared CrUX error constructor only
- `src/config.js` — CrUX settings and enabled-provider assertion only
- `test/config.test.js` — matching CrUX configuration tests only
- `.env.example` — documented CrUX safety settings
- `package.json` and `package-lock.json` — exact-pinned `google-auth-library@11.0.0`
- `../TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md` — TE2 status and checks only
- `review-evidence/traffic-enrichment/TE2_HANDOFF.md`

No Prisma, migration, pipeline, API serializer, CSV, frontend, or TE3 file was
changed.

## Locked implementation contracts

- REST endpoint: `POST https://chromeuxreport.googleapis.com/v1/records:queryRecord`.
- REST request: one exact canonical HTTPS origin and the six captured named
  metrics; API key is added only at dispatch.
- Exact REST 404 envelope is no coverage; other HTTP errors are typed provider
  failures.
- Numeric performance p75 values remain finite and non-negative; CLS remains a
  non-negative decimal string.
- Named REST metrics are independently optional, but an available response must
  contain at least one requested metric.
- BigQuery table discovery uses the exact `chrome-ux-report/all` table list and
  rejects pagination.
- Latest captured month selection returns `202606` from the fixture.
- SQL, named parameters, GoogleSQL mode, query cache, origin limit, and live
  maximum-byte cap are pinned in `bigquery-request.js`.
- Maximum origins per BigQuery request: 1,000.
- Device-fraction sum tolerance: 0.01, covering captured provider rounding.
- Missing BigQuery rows normalize to unavailable coverage, never rank zero.
- Raw provider responses, API keys, OAuth tokens, SQL parameters, job IDs, and
  customer origins do not escape through errors or normalized outputs.

## Authentication

The BigQuery client uses exact-pinned `google-auth-library@11.0.0` with the
BigQuery OAuth scope and Application Default Credentials by default. The token
provider is injected in deterministic tests, so tests require no ADC and make
no Google call. No service-account or ADC file was added.

## Test coverage added

- REST aggregate, subset, exact 404, and malformed fixtures;
- exact endpoint, six-metric list, canonical origin validation, no origin retry;
- scalar-specific p75 parsing, missing metrics, dates, form-factor fractions,
  empty metrics, and echoed-origin drift;
- table-list identity, table type, latest month, and pagination rejection;
- exact SQL, named parameters, dry/live separation, query caching, and byte cap;
- BigQuery successful rows, no rows, malformed `f/v`, null/invalid JSON, exact
  one-field schema, incomplete jobs, pagination, duplicate/unexpected origins,
  extra payload members, invalid fractions, and bounded origins;
- missing-row reconciliation and live-call prevention after an over-cap dry run;
- configuration defaults, strict flags, enabled-only credential requirements,
  and numeric limits;
- privacy assertions excluding API keys, OAuth material, origins, SQL, and raw
  provider error content.

## Commands and outcomes

From `email_scraper/`:

```text
node --test test/dataforseo-enrichment.test.js test/config.test.js
PASS — TE1 dependency baseline

node --test test/crux-enrichment.test.js test/config.test.js
PASS — focused TE2/config tests, 0 failures

npm run check:secrets
PASS — no credential-shaped assignments found

npm test
PASS with localhost binding permission — 176 tests, 173 passed, 0 failed,
3 skipped

git diff --check
PASS
```

The first sandboxed full-suite run could not bind `127.0.0.1` and reported the
two server test files as failed. A direct diagnostic confirmed `listen EPERM`.
Re-running the same full suite with local test-server permission passed. This
matches the execution-environment restriction already recorded in TE1.

The three skips are the existing database-dependent integration checks:

- G-R4 migration replay/preservation proof;
- G-R6 real PostgreSQL lease fencing;
- Prisma repository persistence on an explicit test database.

They are unrelated to TE2, which owns no schema or persistence behavior.

## Skipped checks and residual risks

- No live CrUX REST or BigQuery request was made; all provider behavior is
  fixture-backed and client transport is mocked.
- Production AWS-to-Google authentication remains gated on Workload Identity
  Federation or another approved short-lived mechanism.
- The 10,000,000,000-byte default reflects the controlled discovery cap and
  must be reviewed against current price/quota policy before enablement.
- The 1,000-origin request bound and 0.01 fraction tolerance are explicit v1
  safety policy bounds, not inferred provider limits.
- Cache persistence, run snapshots, lifecycle orchestration, telemetry, and
  restart behavior belong to later windows.

## Stop confirmation

TE3 was not started. Both enrichment flags remain disabled by default.
