# TE-R1 Handoff — Production Stale Paid-Request Recovery

**Window:** TE-R1
**Status:** implementation and verification complete; ready for TE-R3
**Completed:** 2026-08-02
**Production enablement:** not claimed; both enrichment flags remain false

## Outcome

Server startup and periodic recovery now use one shared production seam. Each
recovery cycle first expires abandoned runs and then, when the repository
supports traffic recovery, promotes eligible DataForSEO `in_flight` ledger rows
to terminal `ambiguous` through TE-R2's durable `ambiguousAfter` predicate.

The two operations are failure-isolated. A failure in run recovery does not
prevent paid-ledger recovery, a paid-ledger failure does not undo run recovery,
and the periodic worker continues queue draining. Recovery logs contain only
fixed failure codes or aggregate counts.

## Changed files

- `src/server.js`
- `test/server.test.js`
- `test/te3-traffic-enrichment.integration.test.js`
- `review-evidence/traffic-enrichment/TE-R1_HANDOFF.md`
- `../TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md` (status/evidence only)

No repository claim semantics, migrations, provider contracts, retry policy,
public API, CSV, frontend, configuration flag, or deployment file changed.

## Locked behavior proved

- Startup and periodic recovery call the same combined recovery operation.
- Expired-run recovery runs before paid-ledger recovery with the same timestamp.
- Repositories without the optional traffic recovery method remain compatible.
- Either repository operation can fail without preventing the other operation.
- Periodic recovery continues queue draining after handled failures.
- Success logs contain aggregate counts only; failure logs contain fixed codes
  and exclude underlying error text and paid-request material.
- A committed stale `in_flight` row with an expired run becomes `ambiguous`
  through the production recovery seam.
- A later identical fingerprint receives no network permission.
- Active paid work before both lease and durable ambiguity deadlines remains
  `in_flight` and unchanged.
- No recovery code reads or recalculates the interrupted attempt's deadline from
  the recovering process's current configuration.

## PostgreSQL evidence

The configured `TEST_DATABASE_URL` was used only through uniquely named schemas
that the integration tests dropped afterward. No production database or
customer data was read or modified.

```text
combinedProductionRecoverySeam: passed
staleCommittedAttemptState: ambiguous
ambiguousPaidRetryBlocked: true
activeNonStaleAttemptState: in_flight
migrationReplay: passed
historicalRowsPreserved: 2
TE-R2 historical ledger preservation: passed
```

## Commands and outcomes

From `email_scraper/`:

```text
node --test test/server.test.js test/prisma-run-repository.test.js
PASS — 37 passed, 0 failed

ALLOW_DATABASE_TESTS=true node -r dotenv/config --test test/te3-traffic-enrichment.integration.test.js
PASS — 2 passed, 0 failed on isolated PostgreSQL

npm test
PASS — 215 tests; 210 passed, 0 failed, 5 explicitly database-gated skips

npm run check:secrets
PASS — no credential-shaped assignments found

git diff --check
PASS
```

The first ordinary focused server run could not bind local HTTP ports in the
sandbox; the approved rerun passed. The first ordinary database attempt was
blocked by sandbox networking. An approved attempt encountered a transient
Prisma `_prisma_migrations` lookup failure, and the next serialized run exposed
one duplicate test fingerprint in the new active control. After assigning a
unique deterministic fingerprint, the conclusive serialized integration run
passed both tests.

## Residual risks and gates

- Written DataForSEO display/export permission, approved short-lived Google
  credentials, final CrUX attribution review, and current provider price/quota/
  byte-cap review remain production gates.
- No live DataForSEO, CrUX, production database, deployment, or customer-data
  operation was performed.
- TE-R3, TE-R4, and TE-R5 remain pending in the corrective sequence.

## Stop confirmation

TE-R3 was not started. Both `ENABLE_DATAFORSEO_ENRICHMENT` and
`ENABLE_CRUX_ENRICHMENT` remain false.
