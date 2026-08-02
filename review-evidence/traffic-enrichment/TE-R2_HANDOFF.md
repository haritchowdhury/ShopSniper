# TE-R2 Handoff — Paid-Call Safety, Durable Exposure, and Attempt Deadline

**Window:** TE-R2  
**Status:** implementation and verification complete; ready for TE-R1  
**Completed:** 2026-08-02  
**Production enablement:** not claimed; both enrichment flags remain false

## Outcome

Every DataForSEO attempt that receives network permission now commits a
conservative decimal reservation and immutable `ambiguousAfter` deadline in the
same lease-fenced transaction that changes the ledger to `in_flight`. The claim
transaction serializes on the run row, reads the run's stored policy snapshot,
and refuses network permission when confirmed cost plus outstanding exposure
would exceed the immutable cap.

Succeeded attempts atomically replace their reservation with the exact provider
cost and normalized cache rows. In-flight and ambiguous attempts retain their
reservation. Transport errors, HTTP failures, response truncation/size limits,
invalid JSON, and response contract drift are possibly charged and become
terminal ambiguous ledger work. Only the exact captured task rejection with
root and task cost zero is retryable. Configuration failure is explicitly
classified as pre-dispatch.

Recovery now selects the durable attempt deadline rather than the recovering
process's current configuration. Legacy in-flight rows with no deadline are
recovered conservatively to terminal ambiguous after their run becomes inactive.

## Changed files

- `prisma/schema.prisma`
- `prisma/migrations/20260802120000_dataforseo_paid_safety/migration.sql`
- `src/enrichment/errors.js`
- `src/enrichment/dataforseo/client.js`
- `src/enrichment/dataforseo/contract.js`
- `src/enrichment/orchestrator.js`
- `src/prisma-run-repository.js`
- `test/dataforseo-enrichment.test.js`
- `test/traffic-orchestration.test.js`
- `test/prisma-run-repository.test.js`
- `test/te3-traffic-enrichment.integration.test.js`
- `review-evidence/traffic-enrichment/TE-R2_HANDOFF.md`

`test/gr4-migration.integration.test.js` required no change; its full migration
replay remained green. No API, CSV, frontend, CrUX, authentication, country
scope, flag, pricing, or deployment file changed.

## Locked behavior proved

- Run exposure is succeeded provider cost plus reservations for in-flight and
  ambiguous work.
- The authoritative budget decision and claim are one PostgreSQL transaction.
- The `$0.05` cap with `$0.024` reservations grants at most two claims and
  retains `$0.048` exposure after ambiguity.
- Two repository clients with different runtime caps still enforce the cap from
  the stored run snapshot.
- A provider cost above the estimate is stored unchanged, replaces the
  reservation, and blocks the next claim when insufficient cap remains.
- Contract mismatch, invalid JSON, timeout, response-size failure, and other
  post-dispatch uncertainty cannot reopen a fingerprint.
- The exact captured zero-cost rejection is the only provider rejection that
  becomes retryable failed work and consumes no exposure.
- Success plus cache writes remain atomic; expired lease mutation remains
  fenced; planned-before-call and success-before-publication recovery remain
  intact.
- Stale recovery uses `ambiguousAfter`. Legacy null-deadline in-flight rows fail
  closed and become ambiguous, never retryable.
- Logs and errors retain only fixed safe classifications.

## PostgreSQL evidence

The configured `TEST_DATABASE_URL` was used only through uniquely named schemas
that were dropped after each test. No production database or customer data was
read or modified.

```text
historicalRowsPreserved: 2
migrationReplay: passed
paidClaimWinners: 1
cacheAndLedgerAtomic: true
plannedBeforeCallRecovered: true
successBeforePublicationRecovered: true
ambiguousPaidRetryBlocked: true
atomicPaidExposureCap: true
actualCostReplacesReservation: true
durableAmbiguityDeadline: true
legacyNullDeadlineRecovered: true
tenantIsolation: true
terminalReplay: true
rollbackStages: 9
crossRunReferenceRejected: true
TE-R2 historical ledger preservation: passed
```

## Commands and outcomes

From `email_scraper/`:

```text
npm run db:generate
PASS — Prisma Client 6.19.3 generated

npm run db:validate
PASS — schema valid

node --test test/dataforseo-enrichment.test.js test/traffic-orchestration.test.js test/prisma-run-repository.test.js
PASS — all three focused entrypoints

ALLOW_DATABASE_TESTS=true node -r dotenv/config --test test/te3-traffic-enrichment.integration.test.js
PASS — 2 passed, 0 failed on isolated PostgreSQL

ALLOW_DATABASE_TESTS=true npm run test:integration
PASS — 5 passed, 0 failed on isolated PostgreSQL

npm test
PASS — 213 tests; 208 passed, 0 failed, 5 explicitly database-gated skips

npm run check:secrets
PASS — no credential-shaped assignments found

git diff --check
PASS
```

The first ordinary `npm test` attempt could not bind local HTTP servers. The
permitted rerun passed all tests. The first database attempt was blocked by
sandboxed network access; the approved isolated-test reruns passed.

## Residual risks and gates

- TE-R1 must wire deadline-based paid recovery into server startup and periodic
  recovery; TE-R2 intentionally changed only the repository primitive.
- Written DataForSEO display/export permission, approved short-lived Google
  credentials, final CrUX attribution review, and current provider price/quota/
  byte-cap review remain production gates.
- The `$0.024` reservation remains the immutable v1 conservative estimate and
  must be reviewed against current pricing before enablement.
- No live DataForSEO, CrUX, production database, deployment, or customer-data
  operation was performed.

## Stop confirmation

TE-R1 was not started. Both `ENABLE_DATAFORSEO_ENRICHMENT` and
`ENABLE_CRUX_ENRICHMENT` remain false.
