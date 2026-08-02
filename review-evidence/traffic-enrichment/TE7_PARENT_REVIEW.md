# TE7 parent reliability review

**Window:** TE7  
**Review completed:** 2026-08-02  
**Disposition:** one corrective window required; overall traffic enrichment
implementation is not yet complete  
**Corrective window:** TE-R1  
**Production enablement:** blocked; both enrichment flags remain false

## Outcome

The strict provider contracts, forward-only migration, tenant boundary,
lease-fenced publication, zero-call disabled behavior, public API, backend CSV,
frontend boundary/UI, and frontend CSV passed independent source review and
deterministic verification.

One production-path recovery gap prevents final acceptance. The repository can
promote stale DataForSEO `in_flight` rows to `ambiguous`, but neither server
startup nor periodic recovery invokes that primitive. This remains financially
fail-safe because an existing `in_flight` fingerprint receives no new network
permission, but the ledger state can remain non-terminal indefinitely.

## Review boundary and manifest

The working tree stores `email_scraper/` and `frontend/` as untracked trees and
shows the former nested `Email Scrapper/` tree as deleted. Ordinary `git diff`
therefore cannot represent the implementation. The review used each handoff as
a navigation manifest, then inspected the current files directly and treated
all traffic-owned files as new review material.

Reviewed source and contracts:

- `TRAFFIC_ENRICHMENT_PROVIDER_DISCOVERY.md` and the complete implementation
  checklist;
- TE1 through TE6 handoffs and TE6 browser evidence;
- all DataForSEO and CrUX fixture READMEs, fixtures, and sanitized discovery
  captures;
- all files under `src/enrichment/dataforseo/` and `src/enrichment/crux/`;
- `src/enrichment/errors.js`, `src/enrichment/orchestrator.js`, `src/config.js`,
  `src/http-client.js`, `src/logger.js`, `src/prisma-run-repository.js`,
  `src/api-serializer.js`, `src/output.js`, `src/server.js`, and their focused
  tests;
- the complete Prisma schema and every migration in chronological order;
- frontend traffic types, manual validation, CSV export, traffic components,
  narrow integration points, styles, tests, README, and browser evidence.

The configured `DATABASE_URL` and `TEST_DATABASE_URL` were both present and
distinct. Integration tests used only `TEST_DATABASE_URL`, created uniquely
named temporary schemas, and dropped only those schemas. No customer data was
read or changed.

## Contract and static review

The provider adapters use one pinned request and response shape per source.
Review found no fallback root selection, alias probing, coercive Zod parsing,
alternate CrUX origin request, unbounded concurrency, unbounded retry, or
silently ignored BigQuery pagination. DataForSEO dispatch has zero retry and
zero redirect. CrUX REST retry is bounded to two retries for the approved
transient classes. BigQuery request retry is bounded to one within the same
configured byte cap.

Raw provider bodies remain inside clients/parsers. Normalized persistence uses
strict source/version schemas. Public serialization omits cache, ledger, cost,
provider IDs, raw bodies, and internal error details. Static searches found no
traffic `TODO`, `FIXME`, `REMOVE`, `PARKED`, or `UNDECLARED` path.

Both `.env` and `.env.example` explicitly set:

```text
ENABLE_DATAFORSEO_ENRICHMENT=false
ENABLE_CRUX_ENRICHMENT=false
```

## Lifecycle and matrix review

The reviewed lifecycle is:

```text
server-owned run snapshot
  -> qualified/deduplicated hostnames and exact HTTPS origins
  -> source-specific fresh cache reads
  -> DataForSEO plan and committed in_flight claim
  -> bounded provider work and typed reconciliation
  -> normalized cache/ledger transitions
  -> lease-fenced atomic lead/enrichment publication
  -> owner-scoped API
  -> backend CSV and frontend parser/UI/CSV
```

Focused tests reproduced off/off, each single source, both sources, all-cache
hits, country-level partial failure, one-provider failure, no coverage,
contract mismatch, cost/byte caps, measured zero, and malformed stored data.
Off/off uses a throwing repository proxy and proves no provider, cache, ledger,
credential, token, persistence, or source-telemetry interaction.

Database tests independently proved migration replay, historical-row
preservation, one paid claim winner, atomic cache/ledger success, planned and
succeeded crash recovery, ambiguous retry blocking, immediate ambiguity after
a returned ambiguous call, lease fencing, tenant isolation, idempotent terminal
replay, nine final-write rollback points, and cross-run reference rejection.

## Public truthfulness and attribution

DataForSEO material is consistently labelled `Estimated Google search traffic`
and the UI explicitly says it is not total website visits. CrUX popularity is
labelled as a coarse navigation popularity rank; device values are observed
form-factor fractions, not geography; the UI states that CrUX does not provide
visit totals.

API and both CSV paths use the same worldwide and nine-market ordering.
Disabled source members and columns are absent. Provider zero remains zero;
missing/no-coverage material remains absent. Attribution is derived from
serialized metric material, with CrUX source, CC BY URL, and transformation
notice required together. Frontend validation independently checks source and
attribution parity.

TE6 browser evidence covers an owner-scoped synthetic run at 1440x900 and
390x844. It records safe external links, all semantic CrUX abbreviations, two
source panels, state-only rendering without synthesized zero, contained table
overflow, and no external calls.

## Verification results

Backend:

```text
npm run db:generate
PASS - Prisma Client 6.19.3 generated

npm run db:validate
PASS - schema valid

TE focused test entrypoints
PASS - provider, config, orchestration, pipeline, serializer, CSV
PASS - server test: 9 passed after localhost bind permission

npm test
PASS - 206 tests; 202 passed, 0 failed, 4 database-gated skips

ALLOW_DATABASE_TESTS=true npm run test:integration
PASS - 4 passed, 0 failed, 0 skipped on isolated PostgreSQL

npm run check:secrets
PASS
```

Frontend:

```text
npm test
PASS - 5 test entrypoints, 0 failed

npm run lint
PASS

npx tsc --noEmit
PASS

npm run build
PASS - Next.js 16.2.12 production build
```

The first sandboxed server test and frontend build attempts hit local binding
restrictions. Permitted reruns passed. The build emitted the pre-existing Neon
Auth dynamic-cookie diagnostics for `/`, `/_not-found`, `/sign-in`, and
`/sign-up`; the build completed successfully.

`git diff --check` passed, but it does not inspect untracked files. A direct
source-tree whitespace scan found only intentional Markdown hard-break spaces
in handoffs and unrelated existing documentation.

## Finding TE7-F1

**Severity:** high reliability, fail-safe financial behavior  
**Invariant:** paid ambiguity and restart behavior must be exercised by the
production recovery path  
**Affected source:** `src/server.js` and
`src/prisma-run-repository.js::markStaleDataForSeoRequestsAmbiguous`

Reproduction:

```text
Repository search:
  markStaleDataForSeoRequestsAmbiguous is referenced only by repository tests;
  no production caller exists.

Independent createLeadServer recovery-timer probe:
  {"calls":["runs.recover"],"staleLedgerRecoveryInvoked":false}
```

Root cause: TE3 supplied the recovery primitive and direct database proof, but
TE4 did not wire it into startup or periodic worker recovery. A process death
after `in_flight` causes the run to expire/fail while the ledger row can remain
`in_flight`. A later identical fingerprint is blocked and makes no provider
call, so no automatic duplicate charge occurs; however, durable state is not
promoted to the truthful terminal `ambiguous` state.

Corrective ownership, regression requirements, dependencies, and stop
condition are defined in checklist window TE-R1. TE7 must rerun the focused
server/repository/integration proofs after TE-R1.

## Unavailable evidence and production blockers

No live DataForSEO, CrUX REST, CrUX BigQuery, production deployment, production
database, or customer-data check was rerun. Fixtures and controlled local tests
do not substitute for those claims.

Production enablement remains blocked on:

- written DataForSEO permission for customer-facing display/export;
- approved short-lived AWS-to-Google credentials;
- final legal review of CrUX CC BY attribution wording;
- current provider price, quota, location, and BigQuery byte-cap review.

## Disposition

TE7 review work is complete, but the traffic-enrichment plan is not complete.
TE-R1 must be implemented, accepted with database-backed evidence, and returned
to TE7 for a focused rerun before the completion gate can pass. Both enrichment
flags remain disabled by default.
