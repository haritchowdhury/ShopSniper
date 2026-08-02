# TE-R4 Handoff — Foreground CSV Boundary and Documentation Truthfulness

**Window:** TE-R4  
**Status:** implementation and verification complete; ready for TE-R5 parent review  
**Completed:** 2026-08-02  
**Production enablement:** not claimed; both enrichment flags remain disabled by default

## Outcome

The legacy `npm run run:once` command now fails safely when either traffic
provider flag is enabled. The rejection occurs before the foreground pipeline
or output writer can run, so provider credentials, cache, paid-ledger, and
network behavior remain unreachable from this command. The error directs the
operator to disable both flags and use the durable server workflow for enriched
results.

With both flags disabled, the existing foreground pipeline and CSV writer
behavior remains unchanged. The backend CSV formatter continues to flatten
already-serialized public traffic material independently of `run:once`, and
strict validation still prevents malformed material or misleading attribution
from reaching an output file.

## Changed files

- `src/run-once.js`
  - Added the two-flag foreground boundary before pipeline execution.
  - Kept rejection in the existing failed-status and safe logging path.
- `test/run-once.test.js`
  - Preserved the off/off success case.
  - Added DataForSEO-only, CrUX-only, and both-enabled rejection cases.
  - Proved zero pipeline, writer, credential-provider, cache, paid-ledger, and
    network sentinel interaction for every enabled combination.
- `test/csv.test.js`
  - Added proof that invalid public traffic material preserves an existing CSV
    exactly and creates no temporary output artifact.
- `README.md`
  - Distinguished durable server enrichment, frontend CSV download, backend
    formatter capability, and legacy off/off-only `run:once` output.
- `review-evidence/traffic-enrichment/TE-R4_HANDOFF.md`
  - This handoff.

`src/output.js` required no change because its TE-R3 validation boundary already
rejects malformed public traffic before header selection or filesystem writes.

No provider adapter, provider client, request/response contract, cache, paid
ledger, repository, database schema, migration, server endpoint, frontend,
deployment mechanism, or feature-flag default was changed.

## Locked four-combination behavior

| DataForSEO | CrUX | Foreground result | Pipeline | Writer | Provider/credential/cache/ledger/network sentinels |
| --- | --- | --- | ---: | ---: | ---: |
| false | false | completes with legacy leads | 1 | 1 | not introduced |
| true | false | safe actionable rejection | 0 | 0 | 0 |
| false | true | safe actionable rejection | 0 | 0 | 0 |
| true | true | safe actionable rejection | 0 | 0 | 0 |

The rejection message names both required `false` settings and the durable
server workflow. It contains no credentials, domains, provider bodies, costs,
or customer data.

## CSV preservation evidence

- Valid normalized public traffic material retains the TE-R3 flattened metrics,
  source gating, and formula-protected attribution behavior.
- Invalid cross-field public material still rejects before attribution.
- When the destination already exists, invalid traffic material leaves its
  bytes unchanged and leaves no temporary file in the destination directory.
- Off/off records continue using the unchanged legacy header set.

## Verification

From `email_scraper/`:

```text
node --test test/run-once.test.js test/csv.test.js test/config.test.js
PASS — all three focused test files passed

npm test
PASS — 223 tests; 218 passed, 0 failed, 5 database-gated skips

npm run check:secrets
PASS — no credential-shaped assignments found

git diff --check
PASS
```

The first sandboxed `npm test` attempt passed 21 of 23 test files but the two
HTTP server test files could not bind temporary `127.0.0.1` listeners (`EPERM`).
Running the same full command with localhost binding permission passed. This was
an execution-environment restriction, not a product test failure.

The five remaining skips are the existing tests that require an explicitly
enabled isolated PostgreSQL database. TE-R4 contains no database behavior or
migration, so no database test was enabled for this window.

## Residual risks and production gates

- Written DataForSEO customer display/export permission remains required.
- Approved short-lived AWS-to-Google credentials remain required.
- Final legal review of CrUX CC BY attribution wording remains required.
- Current provider price, quota, location, and BigQuery byte-cap review remains
  required.
- The parent repository tracking/rename finding `TE8-F7` remains a TE-R5 release
  gate and was not modified.
- No live provider, production database, deployment, or customer-data operation
  was performed.

## Stop confirmation

TE-R5 was not started. `ENABLE_DATAFORSEO_ENRICHMENT` and
`ENABLE_CRUX_ENRICHMENT` remain `false` by default.
