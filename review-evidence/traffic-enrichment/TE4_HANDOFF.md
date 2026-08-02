# TE4 Handoff — Enrichment Orchestration, Budgets, and Recovery

**Window:** TE4  
**Status:** implementation and verification complete; ready for parent review  
**Completed:** 2026-08-02  
**Production enablement:** not claimed; both enrichment flags remain false by default

## Outcome

Implemented post-qualification traffic enrichment without changing core lead
qualification or the public result contract. The worker reads the immutable run
snapshot, enters `enriching_traffic` after core records exist, keeps its heartbeat
active, and publishes accepted normalized enrichment through the TE3 atomic final
transaction.

DataForSEO executes deterministic 1,000-target batches across worldwide plus nine
country scopes. Fresh cache is removed per scope, estimated budget is reserved
before each paid claim, actual provider cost is authoritative for subsequent
calls, and every network call is preceded by a committed `in_flight` ledger
transition. Ambiguous outcomes are persisted immediately and never automatically
retried.

CrUX REST uses bounded concurrency and retries only transient network/5xx
failures. CrUX BigQuery is staged into latest-month lookup, dry run, and live
query so fresh monthly cache can avoid token creation and all external calls.

## Changed files

- `src/enrichment/orchestrator.js`
- `src/enrichment/crux/adapter.js`
- `src/enrichment/crux/api-client.js`
- `src/prisma-run-repository.js`
- `src/server.js`
- `test/traffic-orchestration.test.js`
- `test/crux-enrichment.test.js`
- `test/prisma-run-repository.test.js`
- `test/server.test.js`
- `test/te3-traffic-enrichment.integration.test.js`
- `../../../TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md`
- `review-evidence/traffic-enrichment/TE4_HANDOFF.md`

No public API serializer, CSV output, frontend, attribution, Prisma schema, or
migration was changed. TE5 was not started.

## Locked orchestration behavior

- Off/off skips the orchestrator and preserves the legacy result object.
- Disabled sources perform no cache, ledger, provider, token-provider, persisted
  enrichment, or source-telemetry operation.
- DataForSEO hostnames are lower-case ASCII and remove one leading `www.` before
  strict provider validation.
- CrUX uses only the exact HTTPS origin from the validated final URL and never
  probes an alternate scheme, apex, or `www` origin.
- The conservative pre-call DataForSEO reservation is USD 0.024 per task; the
  provider-reported actual cost controls remaining budget after success.
- DataForSEO execution is sequential in v1, which is a bounded concurrency of one
  and keeps budget reservation deterministic.
- A recent succeeded fingerprint is reused. It can be planned again only after
  its snapshotted cache-freshness interval has expired.
- A known failed request may be planned by a later run. Ambiguous and active
  in-flight requests are never automatically repeated.
- CrUX REST retries at most twice after the first attempt, and only for network,
  timeout, or 500/502/503/504 failures. HTTP 429 and other 4xx failures are not
  retried.
- BigQuery all-cache-hit runs make no table-list, authentication, dry-run, or live
  request. A cache miss makes one latest-month lookup, one dry run, and one live
  query when within the 1,000-origin and byte caps.
- Available, partial, no-coverage, unavailable, ambiguous, and contract-mismatch
  remain separate. Only accepted normalized values enter published payloads.
- Provider diagnostics contain safe provider/state/count/scope metadata, never
  credentials, target lists, origins, SQL parameter values, or raw bodies.
- Provider failures do not mutate lead status, score, contactability, contact
  evidence, or identity evidence.

## PostgreSQL runtime evidence

The isolated PostgreSQL test creates a unique schema, deploys migrations, and
drops only that schema afterward. Final TE4-relevant evidence:

```text
paidClaimWinners: 1
cacheAndLedgerAtomic: true
plannedBeforeCallRecovered: true
successBeforePublicationRecovered: true
ambiguousPaidRetryBlocked: true
immediateAmbiguousTransition: true
cruxCacheFence: true
durableCostRecovery: true
tenantIsolation: true
terminalReplay: true
rollbackStages: 9
crossRunReferenceRejected: true
```

The existing global one-running-run database constraint serializes separate runs.
Two repository clients contending for the same run/request produced one paid
claim winner, and stale leases could neither mutate cache/ledger state nor publish.

## Commands and outcomes

From `email_scraper/`:

```text
npm run db:generate
PASS — Prisma Client 6.19.3 generated

npm run db:validate
PASS — schema valid

node --test test/traffic-orchestration.test.js test/pipeline.test.js test/server.test.js
PASS — focused orchestration, pipeline, server, snapshot, heartbeat, and publication tests

npm test
PASS — 199 tests, 195 passed, 0 failed, 4 explicitly database-gated skips

ALLOW_DATABASE_TESTS=true npm run test:integration
PASS — 4 passed, 0 failed, 0 skipped on isolated PostgreSQL

ALLOW_DATABASE_TESTS=true node -r dotenv/config --test test/te3-traffic-enrichment.integration.test.js
PASS — focused cache/ledger/recovery/fence integration proof

npm run check:secrets
PASS — no credential-shaped assignments found

git diff --check
PASS
```

The orchestration matrix additionally proves:

- 100 domains produce exactly ten DataForSEO tasks, one per scope, at the probed
  cost and remain below the USD 0.24 acceptance model;
- actual cost stops later tasks once the remaining reservation would exceed cap;
- one failed country scope produces partial DataForSEO;
- CrUX REST 404 and a missing BigQuery row remain no coverage;
- an all-cache CrUX run makes zero provider calls;
- one provider contract failure preserves accepted output from the other; and
- a repeated ambiguous paid request makes no second network call.

## Residual risks and deferred work

- The USD 0.024 estimate is a conservative local v1 reservation. Current price,
  quota, and byte-cap review remains mandatory before production enablement.
- Runs with more than the pinned 1,000 BigQuery origins receive a controlled
  source-unavailable result rather than silently issuing multiple queries; a
  multi-query BigQuery product contract is not authorized in v1.
- AWS short-lived Google credentials, written DataForSEO display/export
  permission, and final CrUX attribution wording remain production gates.
- Public API materialization, CSV, attribution, and frontend rendering remain
  TE5 and TE6 work.
- No live DataForSEO, CrUX REST, BigQuery, or other paid request was made.

## Stop confirmation

TE5 was not started. `ENABLE_DATAFORSEO_ENRICHMENT` and
`ENABLE_CRUX_ENRICHMENT` remain disabled by default.
