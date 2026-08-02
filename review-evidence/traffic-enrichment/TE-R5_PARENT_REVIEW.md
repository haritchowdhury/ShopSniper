# TE-R5 Parent Reliability Review

**Window:** TE-R5  
**Status:** review complete; local completion not granted; TE-R6 required  
**Reviewed:** 2026-08-02  
**Production enablement:** not claimed; both provider flags remain disabled by default

## Disposition

The corrective production behavior inspected in TE-R2 through TE-R4 is retained
and all deterministic non-database gates pass. Four of five isolated PostgreSQL
integration entrypoints pass. The principal TE3 integration entrypoint fails
because its pre-TE-R3 publication fixture declares semantically impossible
DataForSEO material. TE-R5 therefore cannot mark local implementation complete.

Finding `TE-R5-F1` is assigned to the append-only TE-R6 test-correction window.
The production semantic boundary is behaving safely and must not be weakened.
Parent repository finding `TE8-F7` also remains a release blocker pending an
explicit deployment/tracking decision.

## Reviewed baseline

- Backend repository: `9561a90` (`main`, equal to backend `origin/main`), clean
  before evidence creation.
- Frontend repository: `c825c04` (`main`, equal to frontend `origin/main`), clean.
- Outer repository: `6d25c71`, one commit ahead of outer `origin/main`, with the
  former `Email Scrapper/` tree deleted and replacement implementation,
  contracts, and authoritative traffic documents untracked.
- Corrective backend diff reviewed from `8dbfba1` through `9561a90`.
- Corrective frontend diff reviewed from `ad31dab` through `c825c04`.
- No live provider, production database, customer data, deployment, flag
  enablement, staging, or repository-wide tracking action was performed.

## Source and lifecycle review

The source trace confirmed:

- the immutable run snapshot owns paid cost cap, reservation estimate, cache
  policy, and ambiguity deadline duration;
- `claimDataForSeoRequest()` serializes on the run row and commits reservation,
  `in_flight`, lease identity, and `ambiguousAfter` before granting network
  permission;
- succeeded work replaces its reservation with actual provider cost and commits
  accepted cache rows in the same lease-fenced transaction;
- contract mismatch, invalid JSON, response-size failure, timeout, and other
  post-dispatch uncertainty become terminal ambiguous work;
- only the exact captured zero-cost rejection is retryable without exposure;
- startup and periodic recovery share `recoverInterruptedWork()`, expire runs
  first, and consume durable attempt deadlines;
- lease loss prevents stale cache mutation and terminal publication;
- normalized persistence, public serialization, backend CSV, frontend parsing,
  component rendering, and client CSV enforce matching semantic and attribution
  rules;
- legacy `run:once` rejects any enabled traffic source before pipeline or writer
  interaction; and
- both provider flags default to false.

## Focused deterministic verification

From `email_scraper/`:

```text
node --test test/dataforseo-enrichment.test.js test/traffic-orchestration.test.js test/prisma-run-repository.test.js
PASS — 3 test entrypoints

node --test test/server.test.js test/prisma-run-repository.test.js
PASS — 38 tests after allowing temporary localhost listeners

node --test test/api-serializer.test.js test/csv.test.js test/prisma-run-repository.test.js test/server.test.js
PASS — 61 tests after allowing temporary localhost listeners

node --test test/run-once.test.js test/csv.test.js test/config.test.js
PASS — 3 test entrypoints

npm run db:generate
PASS — Prisma Client 6.19.3 generated

npm run db:validate
PASS — schema valid
```

The paid ambiguity regression used the unchanged `$0.05` cap with `$0.024`
reservations. Only two calls received network permission, durable exposure was
`$0.048`, later scopes stopped, and replay made no additional call. Focused
tests also covered contract mismatch, invalid JSON, response-size failure,
timeout, exact zero-cost rejection, actual-cost replacement, owner isolation,
recovery ordering, foreground flag combinations, malformed semantic material,
CSV preservation, and lease-loss publication fencing.

## PostgreSQL verification and TE-R5-F1

The configured test database was used only through uniquely named schemas that
the tests drop. No production database or customer data was accessed.

```text
ALLOW_DATABASE_TESTS=true node -r dotenv/config --test test/te3-traffic-enrichment.integration.test.js
FAIL — 1 passed, 1 failed

ALLOW_DATABASE_TESTS=true npm run test:integration
FAIL — 4 passed, 1 failed
```

Passing integration entrypoints proved G-R4 migration preservation and rollback,
G-R6 concurrent lease fencing, ordinary repository atomicity, and TE-R2
historical-ledger preservation.

The failing TE3 entrypoint reaches `saveCompletedResults()` with one worldwide
DataForSEO record but source state `available`. Since `available` requires all
ten configured scopes, `leadTrafficEnrichmentRecordToCreate()` correctly rejects
the fixture with:

```text
Published DataForSEO state does not match its scopes
```

The fixture lines predate TE-R3 and were not updated when semantic validation
was tightened. Because the failure occurs at the first final-publication call,
later assertions in the same integration test do not execute. This leaves the
combined TE3 database evidence incomplete even though focused unit tests and
four other integration entrypoints pass.

## Backend and frontend regression gates

Backend:

```text
npm test
PASS — 223 tests; 218 passed, 0 failed, 5 database-gated skips

npm run check:secrets
PASS

git diff --check
PASS before review evidence creation
```

Frontend:

```text
npm test
PASS — 5 entrypoints

npm run lint
PASS

npx tsc --noEmit
PASS

npm run build
PASS — Next.js 16.2.12 production build

git diff --check
PASS
```

The build retained the known non-fatal Neon Auth dynamic-cookie diagnostics.
The first sandboxed build could not bind Turbopack's internal local port; the
permitted rerun passed.

Component tests execute the actual date formatter under
`America/Los_Angeles` and `Asia/Kolkata`. Separate headless Chrome DOM probes in
both timezones rendered:

```html
<output id="result">Jul 1, 2026</output>
```

## Release and production gates

`TE8-F7` remains unresolved in the outer repository. The backend and frontend
are independently tracked and clean, but the outer repository does not track
those replacement trees or their authoritative documents/contracts and still
records deletion of the former implementation tree. Release readiness requires
an explicit decision that the nested repositories are the intended deployment
roots or an authorized parent-repository tracking correction.

Production enablement remains separately blocked on written DataForSEO
display/export permission, approved short-lived Google credentials, final CrUX
CC BY wording/legal review, and current provider price, quota, location, and
BigQuery byte-cap review.

## Stop confirmation

TE-R6 was specified but not implemented. No production source, test fixture,
migration, provider configuration, or Git tracking state was changed during the
review other than this evidence and checklist status/window record.
