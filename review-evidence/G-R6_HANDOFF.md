# G-R6 handoff — Multi-instance worker fencing and operational hygiene

Status: **COMPLETE**

Date: 2026-08-01

## Outcome

G-R6 restores corrective invariants C10-C11. A database run is now mutable only
by the worker holding its opaque, unexpired owner/token lease. Progress,
heartbeat, worker failure, and atomic terminal publication all use the same
fence. Another process startup preserves healthy work, while expired and legacy
unleased running rows transition to a safe failed state exactly once.

The current service remains a long-running Node worker with the existing global
one-running-run database policy. This window did not implement an AWS queue
split, claim that Lambda can exceed its execution limit, or increase worker
throughput.

## Lease and recovery contract

The forward-only migration is:

```text
20260801090000_gr6_worker_leases
```

It adds nullable `leaseOwner`, `leaseToken`, `leaseAcquiredAt`,
`leaseExpiresAt`, and `lastHeartbeatAt` fields plus compatibility-safe
`leaseAttempt=0`. It adds token uniqueness and state/expiry lookup indexes. The
migration contains no historical update, deletion, table drop, or state rewrite.

Claims generate a cryptographically random token and conditionally transition
one queued row to running. The repository requires run ID, owner, token,
`state=running`, and `leaseExpiresAt > now` for every worker mutation. Attempts
increment on claim. Lease fields remain internal and are not added to the public
API serializers.

The server uses one opaque worker identity per process, a 90-second lease,
20-second heartbeat, and 15-second expired-run recovery sweep. These are active
code constants rather than advertised configuration knobs. A renewal or fenced
progress failure marks the local execution lease-lost; it stops all subsequent
progress/failure/completion publication and emits only `RUN_LEASE_LOST` with the
run ID. Recovery also requests another queue drain so a process death is handled
without requiring a later process restart.

Expired interrupted work is marked failed with `RUN_LEASE_EXPIRED` exactly once.
There is no automatic retry/requeue. A legacy running row with null lease fields
is deliberately treated as unowned/expired. Queued, completed, failed, and
healthy unexpired rows are not changed.

G-R4 terminal atomicity remains intact. Completion first applies the active lease
fence in the same transaction as child replacement and publication. An identical
payload replay from the same terminal token is idempotent even after lease expiry;
a different, forged, stale, or expired token cannot rewrite the run or children.

## Disposable PostgreSQL evidence

Only the previously designated disposable `TEST_DATABASE_URL` was used. The
integration tests created uniquely named schemas, deployed through the G-R4
baseline, inserted synthetic queued/running/completed/failed rows, applied G-R6,
replayed migration deployment, and dropped the schemas. No URL or database value
was printed or stored.

The real concurrent suite proved:

- four pre-G-R6 rows and all states survived migration unchanged;
- legacy lease fields remained null and attempts received the safe zero default;
- two independent Prisma clients claiming simultaneously produced one winner;
- a healthy unexpired lease survived another client's recovery scan;
- a valid heartbeat persisted its timestamp and extended expiry;
- a forged owner/token could not update progress or mark failure;
- heartbeat and recovery racing at the exact expiry boundary produced one failed
  recovery and no renewal/resurrection;
- expired recovery transitioned once and its replay affected zero rows;
- stale completion after recovery inserted no leads;
- active-token failure succeeded while a foreign token failed;
- successful completion, same-token replay, and different-token rejection obeyed
  the terminal fence; and
- completion racing recovery at exact expiry failed closed with no partial child
  publication.

Sanitized evidence emitted by the test:

```text
preservedRows=4
concurrentClaimWinners=1
expiredTransitions=2
staleTokenRejected=true
completionBoundaryFenced=true
migrationReplay=passed
```

The first combined database attempt passed G-R4 and G-R6 but the final existing
repository test encountered Prisma's advisory-lock timeout. Its isolated rerun
passed. Because every integration test uses a distinct temporary schema, the
migration helpers now disable Prisma's process-global advisory lock for these
tests only. The final combined integration run then passed all three suites with
no skips.

## Configuration and repository hygiene

`QUALIFICATION_THRESHOLD` and `MIN_RELEVANCE_SCORE` were removed from runtime
configuration, `.env.example`, and obsolete test fixtures. A config regression
proves setting those environment variables does not expose either property.

The two local n8n exports remain present on disk and their contents were not
modified. They were removed from the Git index and exact root ignore rules were
added. `git check-ignore` proves `My workflow 3.json` is ignored; ordinary source,
fixtures, `.env.example`, migrations, and handoffs remain visible.

`npm run check:secrets` performs a bounded repository scan using these pattern
classes:

- private-key headers;
- known provider-token prefixes;
- credential-bearing database URLs; and
- credential-shaped key/token/password/authorization assignments.

The scan excludes `.git`, dependencies, the local `.env`, and the two explicitly
ignored workflow exports. Findings contain only pattern class, path, and line;
matched values are never returned. Controlled tests prove positive detection,
redacted result shape, and placeholder acceptance. The final repository scan
passed with zero findings.

Credential references requiring user-controlled rotation/revocation remain:

- OpenAI — `My workflow 3.json`;
- Google Sheets OAuth — `My workflow 3.json`; and
- Google Sheets OAuth — `My workflow 4.json`.

No credential identifier or value is recorded here. Rotation/revocation was not
performed and remains a deployment blocker until the user confirms it externally.

## Changed files

Runtime, schema, migration, and fixtures:

- `prisma/schema.prisma`
- `prisma/migrations/20260801090000_gr6_worker_leases/migration.sql`
- `src/api-errors.js`
- `src/config.js`
- `src/prisma-run-repository.js`
- `src/seed-frontend.js`
- `src/server.js`
- `.env.example`
- `package.json`

Operational documentation and hygiene:

- `.gitignore`
- `README.md`
- `AWS_ASYNC_DEPLOYMENT_DIRECTION.md`
- `scripts/check-secrets.js`
- `My workflow 3.json` (removed from Git tracking; retained unchanged locally)
- `My workflow 4.json` (removed from Git tracking; retained unchanged locally)

Tests:

- `test/config.test.js`
- `test/gr4-migration.integration.test.js`
- `test/gr6-worker-lease.integration.test.js`
- `test/pipeline.test.js`
- `test/prisma-run-repository.integration.test.js`
- `test/prisma-run-repository.test.js`
- `test/secret-scan.test.js`
- `test/server.test.js`
- `test/validation-and-security.test.js`

Tracking:

- `review-evidence/G-R6_HANDOFF.md`
- `../PIPELINE_QUALITY_REMEDIATION_EXECUTION_CHECKLIST.md` (G-R6 status/evidence only)

## Verification

Executed from `/home/harit/Email Scrapper/email_scraper`:

```text
npx prisma format
PASS

npx prisma validate
PASS — schema is valid

ALLOW_DATABASE_TESTS=true npm run test:integration
PASS — 3 passed, 0 failed, 0 skipped
G-R4 preservation/rollback evidence passed.
G-R6 concurrency/migration/expiry/terminal evidence passed.
Repository atomic persistence evidence passed.

node --test test/prisma-run-repository.test.js test/server.test.js test/config.test.js test/secret-scan.test.js
PASS — 24 passed, 0 failed, 0 skipped

npm test
PASS — 110 tests: 107 passed, 0 failed, 3 database-gated skips

npm run check:secrets
PASS — zero redacted findings

git check-ignore -v "My workflow 3.json"
PASS — exact `.gitignore` rule reported

git diff --check
PASS

git status --short
EXECUTED — only the bounded G-R6 files listed above differ from the G-R5 commit.
```

The ordinary suite's three skips are exactly the database integration files run
separately with zero skips. Backend server tests required permission to bind
temporary localhost ports. No user server was started, stopped, or replaced.

## Residual risks and stop confirmation

- No live/production migration was run. Deployment must apply the forward
  migration through the normal controlled migration process.
- Credential rotation/revocation is unverified and remains a deployment blocker.
- The redacted scan is a high-confidence repository guard, not a substitute for
  provider-side secret scanning or credential rotation.
- Lease timing uses application clocks; production instances must maintain normal
  clock synchronization.
- The existing partial unique index deliberately limits the database to one
  running run globally.

No live Google, OpenAI, Browserless, storefront, production database, deployment,
seed, workflow-content, authentication, or credential operation was performed.
The parent re-review was not started.
