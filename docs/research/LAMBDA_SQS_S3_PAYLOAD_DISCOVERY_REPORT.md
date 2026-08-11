# Lambda–SQS–S3 Payload Discovery Report

Status: complete; final checklist assigns three mandatory readiness gates

Probe contract: `payload-discovery-v1`

Completed: 2026-08-11

Safety rule: retained evidence contains no credentials, raw storefront HTML,
provider response bodies, customer contact data, production run identifiers, or
unrestricted domain lists.

This is the evidence record for PD-00 through PD-14 in
`PRELIMINARY_LAMBDA_SQS_S3_MIGRATION_PLAN.md`. **Observed** means measured from
the repository, isolated test database, configured AWS learning resources, or a
bounded provider call. **Inferred** means a design conclusion directly supported
by those measurements. The active root-level architecture documents remain the
authority for the target design.

## Outcome

The payload and service-boundary discovery is complete enough to produce the
file-level parent-agent implementation checklist. The target remains:

- SQS carries small, versioned references; S3 carries immutable artifacts.
- Neon is the coordinator and publication database.
- discovery is per query, then deduplicated into stable domain work;
- lead enrichment uses one bounded Browserless `/function` session per domain;
- one traffic worker coordinates batched DataForSEO, per-origin CrUX REST, and
  one batched CrUX BigQuery query; REST and BigQuery remain independent results;
- aggregators acquire fenced ownership from Neon and never infer completion from
  queue emptiness or S3 event counts.

Three implementation blockers were found. They are not reasons to repeat
discovery; the final checklist assigns them to coherent readiness Windows
G1–G3:

1. The progressive reuse path currently reads DataForSEO and CrUX cache rows
   without filtering `expiresAt`, allowing stale rows to be reused indefinitely.
2. `grantRunShopsToOwner()` executes unqualified raw SQL inside a progressive
   checkpoint transaction that has not selected the isolated schema; the guarded
   integration test fails with PostgreSQL `42P01` for `UserShop`.
3. No per-handler Lambda bundles exist yet. The unbundled production dependency
   inventory is 235,841,289 bytes, close to Lambda's 250 MB unzipped package plus
   layers ceiling, so deployment shape cannot be accepted until actual
   tree-shaken handler ZIPs are measured. G3 establishes the package mechanism;
   each handler window remeasures its completed handler before G14 may size or
   deploy it.

## Probe status

| Probe | Status | Result |
|---|---|---|
| PD-00 source baseline | Passed | All three repository commits, runtime, schema, documents, tests, and owner relocation state recorded. |
| PD-01 AWS learning topology | Passed | Bucket, queues, DLQ retry, Lambda, event mapping, IAM, logs, and lifecycle observed. |
| PD-02 confirmed-query contract | Passed | Versioned sanitized fixture and latest persisted shape captured. |
| PD-03 query discovery output | Passed | All terminal outcomes and deterministic order independence captured. |
| PD-04 identity/provenance | Passed | Stable identity, deduplication, occurrence provenance, and fingerprints proved. |
| PD-05 reuse/work planning | Passed with blocker | Fixed-time set-based matrix captured; current missing-expiry drift isolated. |
| PD-06 lead boundary | Passed | Strict success/failure/reuse artifacts and negative privacy/size cases captured. |
| PD-07 Browserless | Passed | `/function` selected and live positive/redirect-negative contracts observed at concurrency one. |
| PD-08 traffic/CrUX | Passed | Latest run proves DataForSEO, CrUX REST, and CrUX BigQuery coexist for all eligible leads. |
| PD-09 provider budget | Passed | Batching, cost, calls, query bytes, and amplification gate measured. |
| PD-10 SQS/S3 boundaries | Passed | Encoded sizes plus live conditional S3 and SQS→Lambda→S3 reference path proved. |
| PD-11 Neon/coordinator | Passed with blocker | Existing transaction defect reproduced; proposed fencing/counter semantics proved in a disposable schema. |
| PD-12 recovery lifecycle | Passed | Durable retry/fence ownership recorded for every required boundary. |
| PD-13 runtime/package/connectivity | Passed with blocker | Local inventory/imports and credential-free AWS egress proved; exact bundles remain a G1 gate. |
| PD-14 consolidation | Passed | Fixtures parse, secrets are excluded, contradictions reconciled, implementation ownership fixed. |

## PD-00 — Repository and runtime baseline

The workspace contains three repositories; a root commit alone does not identify
the application code.

| Repository | Commit at probe start | Baseline state |
|---|---|---|
| coordination root | `6d25c715575c844cf1a9361aa49fb4e0a205715d` | Owner-controlled relocation: old nested tree deleted, active root docs and nested repos untracked. The probe did not stage or repair it. |
| backend `email_scraper/` | `f4b23cebac1966e443c50340c1f89ffa44bfb6c5` | Clean before probe outputs. |
| frontend `frontend/` | `ce513a7ab41dab8d0171a0dd2589cf7a0b83afde` | Clean; no frontend code changed. |

Observed runtime: Node `v24.14.1`, npm `11.11.0`, Prisma CLI/client `6.19.3`,
Linux x64, Prisma engine `debian-openssl-3.0.x`. The schema already owns runs,
queries, shops, run-store snapshots, lead profiles, work leases, traffic caches,
request ledgers, diagnostics, user grants, and published results. It does not yet
own generic target stage/task counters, artifact fingerprints, or aggregator
leases; those remain an additive migration.

The deterministic baseline completed 272 tests: 265 passed, zero failed, and
seven guarded integration tests were skipped by the default command. Two initial
sandbox failures were solely `listen EPERM` on localhost; the identical suite
outside that restriction passed. `npm run check:secrets` passed.

## PD-01 — Configured AWS learning topology

Read-only inspection used profile `storesignal-dev` in `ap-south-2`.

### S3

- Bucket `signalshop-buk` has all Block Public Access switches enabled,
  `BucketOwnerEnforced`, versioning, AES-256 server-side encryption, bucket keys,
  and an explicit SSE-C denial.
- Lifecycle rule `delete-learning-artifacts` is enabled for `learning/`, but its
  only action aborts incomplete multipart uploads after seven days. Completed
  objects do **not** expire.
- The learning worker can write only `learning/*`.

### SQS and Lambda

- Source queue: standard, SQS-managed SSE, 360-second visibility, four-day
  retention, 1,048,576-byte maximum message, and redrive after five receives.
- DLQ: standard, SQS-managed SSE, 360-second visibility and 14-day retention.
- CloudWatch logs prove the same invalid JSON message failed five Lambda
  invocations at 360-second intervals, left the source queue, and entered the
  DLQ. The learning retry test therefore passed.
- Learning Lambda: x86-64, 256 MiB, 60-second timeout, 512 MiB `/tmp`, ZIP
  package, batch size one, `ReportBatchItemFailures`, event-source maximum
  concurrency two. Its `nodejs26.x` preview warning is learning-only; the target
  production runtime remains Node 24.
- One successful original invocation measured 487.03 ms execution, 892 ms
  billed, 404.17 ms initialization, and 112 MiB maximum memory.
- The AWS-managed learning SQS policy uses resource `*`; production execution
  roles must scope SQS actions to their assigned queues.

Sanitized topology: `test/fixtures/aws-pipeline/v1/aws-learning-readonly-observation.json`.

## PD-02 to PD-06 — Payload, identity, reuse, and lead contracts

### Confirmed query and discovery artifacts

The versioned confirmed-query fixture preserves run/generation identity,
confirmed revision, categories, ordered queries, stable query IDs, validation,
intent and provenance without retaining raw production query text. The latest
persisted run had ten queries; its confirmed-query JSON was valid and revision
one matched the confirmed revision.

Per-query discovery explicitly represents success, empty success, partial
occurrence failure, complete query failure, resolution failure, and rejected
assessment. A query that returns no stores still writes a terminal artifact.
Every result retains the query ID/revision and only bounded diagnostics.

### Deterministic domain identity

Two query artifacts containing the same canonical domain merge into one domain
with two query occurrences and `duplicateCount: 1`. Reversing input artifact
order produces byte-identical canonical output and the same fingerprint. The
target reuses `parseShopIdentity()`, `Shop.stableKey`, and
`shopIdForStableKey()`; it does not create an AWS-only identity system.

### Fixed-time reuse observation

At `2026-08-11T09:52:32.910Z`, for the latest run with traffic and CrUX data:

| Decision | Count out of 52 eligible domains |
|---|---:|
| lead reusable | 52 |
| DataForSEO reusable and fresh | 52 |
| CrUX REST reusable and fresh | 0 |
| CrUX BigQuery reusable for latest month `202607` | 0 |
| needs lead | 0 |
| needs traffic/DataForSEO | 0 |
| needs CrUX REST | 52 |
| needs CrUX BigQuery | 52 |

This used one set-based profile query for 52 rows and one set-based cache query
for 623 relevant rows. Workers may still read Neon to fence ownership and obtain
persisted input, but they must not recompute a different business reuse plan.

The observation exposed the first blocker: the progressive orchestrator prefers
`readReusableTrafficCache()` and `readReusableLatestCruxBigQueryCache()`, which
do not filter `expiresAt`; older fallback methods do. Git history places the
drift in progressive-bulk commit
`de04287b944fb657687366d152d9a96a0edc2482`. The target plan now explicitly
requires identity, contract, scope, metric **and freshness** checks.

### Lead terminal contract

The lead artifact has explicit success, rejection, failure, and reuse outcomes;
maps domain-global profile fields separately from run/query provenance; and
retains the existing bounded maximum of five ranked pages. Strict negative
cases reject raw HTML, provider bodies, credentials, mismatched stable identity,
unknown fields, unbounded diagnostic arrays, and invalid timing.

Primary fixtures:

- `confirmed-query-manifest.valid.json`
- `per-query-discovery.valid.json`
- `per-query-discovery-terminal-cases.json`
- `domain-manifest.valid.json`
- `reuse-matrix.json`
- `domain-work-plan.valid.json`
- `lead-results.valid.json`
- `negative-contract-observations.json`

## PD-07 — Browserless contract and units

Official Browserless contracts supported selecting `/function`: one REST request
owns one automatically closed browser session, can visit the bounded ranked URLs
sequentially, and returns strict privacy-safe JSON without packaging Puppeteer.
The account ceiling remains two concurrent sessions; migration reserves that
capacity through Lambda/event-source concurrency. Total provider session time is
fixed at 45 seconds and cannot be raised above the account's one-minute maximum.

### Positive live probe

One active `/function` session received four same-host public page candidates,
rendered the first two, stopped when evidence was sufficient, and marked the
remaining two skipped. Browser work was 838 ms; outer request duration was
6,790.8 ms. It consumed one observed unit. After all three probe sessions and
asynchronous usage settlement, the account moved from the known 290-unit
baseline to 293; the read-only usage lookup opened no session. No page body,
cookie, screenshot, or token was retained.

### Redirect-negative live probe

One active session rejected a cross-host redirect as
`redirect_host_not_allowed`, then rendered the allowed same-host page. Browser
work was 279 ms and outer duration 4,608 ms. An earlier public test endpoint
returned HTTP 503 and revealed that the prototype had treated a non-2xx page as
success; strict 2xx enforcement was added before the retained negative fixture.

Strict local parsing accepts both retained observations and rejects unknown
fields, a raw body, a non-2xx rendered outcome, a full final URL, more than five
pages, and duration beyond 45 seconds. No load was generated to force 429s or
concurrency saturation.

Evidence:

- `browserless-live-observation.json`
- `browserless-live-negative-observation.json`
- `browserless-function-contract-fixtures.json`
- `browserless-usage-followup.json`

## PD-08 and PD-09 — Traffic, both CrUX sources, and amplification

The latest persisted run containing traffic had 61 run stores/leads, 52
qualified and nine rejected. For all 52 qualified leads it contained exactly one
DataForSEO, one CrUX REST, and one CrUX BigQuery publication: 156 rows total.
States were 121 available, 34 no-coverage, and one contract mismatch. This proves
both CrUX products are wired today and must remain independently represented in
one logical combined worker/artifact:

- CrUX REST supplies current origin Core Web Vitals and form-factor metrics.
- CrUX BigQuery supplies dataset-month popularity rank and device fractions.

Failure or no coverage from one cannot erase the other.

### Controlled provider measurements

| Provider | Bounded observation |
|---|---|
| DataForSEO | Three approved public-domain calls, exactly three tasks, $0.01236 each and $0.03708 total. |
| CrUX REST | Six calls: five coverage/normalization cases returned records and one deterministic no-coverage case returned 404. |
| CrUX BigQuery | Latest month `202607`; dry run 85,152,488 bytes; live query 85,152,488 processed, 85,983,232 billed, three rows, under a 10 GB maximum-bytes-billed guard. |

The observed 52-domain production-shaped baseline used ten DataForSEO tasks at
$0.01824 each ($0.1824 total), 52 CrUX REST origin calls, one BigQuery table-list
call, and one BigQuery query. Decomposing DataForSEO into 52×10 individual tasks
would produce 520 tasks; bulk grouping reduces task count exactly 98.08%. At the
three-target task price observed in the probe that would directionally cost
$6.4272 instead of $0.1824 (97.16% lower), though provider task price varies with
target count. The exact cutover gate is call amplification, not that directional
price estimate.

Evidence: `combined-traffic-crux-result.valid.json` and
`provider-live-observation.json`.

## PD-10 — Encoded boundaries and controlled AWS write

All sizes below are UTF-8 bytes from the actual JSON encoder.

| Artifact/envelope | Bytes |
|---|---:|
| confirmed-query manifest | 1,785 |
| per-query discovery | 3,373 |
| domain manifest | 4,268 |
| domain work plan | 2,902 |
| lead result fixture set | 9,001 |
| combined traffic/CrUX result | 764 |
| 1,000-occurrence boundary candidate | 722,790 |
| 1,000 domain-work references | 267,013 |
| SQS reference envelopes | 169–340 |

The traffic envelope is one `traffic.domain` message with one `itemId`. Lambda
event-source batching groups these logical per-domain records at consumption
time; the message contract does not contain an `itemIds` batch. This reconciles
the retained fixture with the locked task/message granularity.

The configured SQS message ceiling is 1,048,576 bytes. Even though the two
synthetic S3 artifacts fit under that ceiling, business payloads remain in S3;
only the small reference envelopes enter SQS. Production validation must impose
its own lower rejection/alert thresholds before AWS rejects an object or
message.

With approval, the probe created
`learning/payload-probe/pd10-20260811/query-manifest.json` using
`If-None-Match: *`. The 389-byte AES-256/versioned object read back byte-identical;
an identical second create returned the expected `PreconditionFailed`. One
389-byte synthetic SQS reference traversed the learning Lambda and produced its
normal 526-byte S3 wrapper with the embedded payload byte-equivalent after JSON
normalization. Both evidence objects remain for inspection. No infrastructure,
Lambda code, secret, DLQ message, or production database was changed by PD-10.

Evidence: `payload-size-observation.json`, `sqs-envelopes.valid.json`,
`aws-learning-synthetic-message.json`, and
`aws-learning-mutation-observation.json`.

## PD-11 — Neon transactions and coordinator proof

`TEST_DATABASE_URL` is configured and distinct from production. The guarded
integration suite created an isolated schema: six tests passed and one failed in
236 seconds. The failure is the second blocker: progressive checkpointing calls
`grantRunShopsToOwner()` before selecting the repository schema on its
transaction, so its unqualified raw `UserShop` SQL resolves outside the isolated
schema and fails with PostgreSQL `42P01`. The bulk writer already selects the
schema; the progressive path must do the same and gain a regression test.

A separate disposable coordinator prototype—never the production database—then
proved:

- first terminal recording increments counters exactly once;
- identical replay is idempotent and does not increment;
- a conflicting fingerprint is rejected;
- reversed sibling completion is accepted;
- two expected tasks reach two terminal, one success, one failure, state ready;
- only one aggregator compare-and-swap owner wins;
- a stale token cannot finalize while the owner token can;
- a zero-task stage advances explicitly and can acquire an aggregator owner.

The disposable schema was dropped. These behaviors define the additive
coordinator migration, uniqueness/index requirements, first-terminal counter
transaction, leases, stale-owner fences, zero-count transition, and artifact
fingerprint reconciliation.

Evidence: `neon-readonly-observation.json` and
`neon-coordinator-prototype-observation.json`.

## PD-12 — Durable failure and recovery ownership

`durable-failure-recovery-matrix.json` assigns durable state, retry action,
deduplication key, fence, external-repeat ambiguity, user-visible state, alarm,
and implementation owner for every requested boundary: before/after external
work; before/during/after S3 write; precondition conflict; before/after first
Neon terminal commit; aggregator-check dispatch; SQS acknowledgement; duplicate,
delayed and reversed delivery; timeout/process death; worker and aggregator lease
expiry; partial SQS failure; zero/all-reused stages; cancellation; DLQ recovery;
and publication before/after `resultsAvailable`.

The fixed invariants are:

- S3 writes are immutable and fingerprinted.
- Neon first-terminal transitions are idempotent transactions.
- task and aggregation writers are fenced by generation plus lease token.
- `ReportBatchItemFailures` reports only records not durably terminal.
- provider success lost before durable recording is retried as ambiguous, never
  fabricated as success; the external call may repeat.
- cancellation blocks new claims and late publication.
- final results become available only in the fenced publication transaction.
- no transition depends on queue emptiness, S3 event counts, or process memory.

## PD-13 — Lambda package and connectivity

### Local Node 24 inventory

- application/prisma/lock files: 639,559 bytes;
- installed production dependency files: 235,201,730 bytes across 64 installed
  production package directories;
- combined uncompressed inventory: 235,841,289 bytes;
- cold imports: pipeline 112.5 ms/69.4 MB RSS, traffic orchestrator
  214.1 ms/85.2 MB RSS, Prisma repository 163.4 ms/74.9 MB RSS.

This is deliberately not called a deployment package: it includes an unbundled
dependency tree and has no handlers. AWS permits 50 MB direct ZIP upload and 250
MB unzipped across package plus layers. Window G1 must create each handler bundle,
measure ZIP and unzipped sizes, verify Prisma engine inclusion, and set alarms
well below the quota. Node 24 is supported by the direct runtime dependency
engines in use.

### Controlled AWS connectivity probe

After advance notice, the original 598-byte learning Lambda ZIP was downloaded
to a mode-600 temporary file and its AWS SHA-256 recorded. One temporary,
credential-free direct handler invocation established outbound DNS/TLS/HTTP:

| Endpoint class | HTTP response | Duration |
|---|---:|---:|
| Neon | 400 | 675 ms |
| Browserless | 401 | 938 ms |
| DataForSEO | 401 | 710 ms |
| CrUX REST | 404 | 190 ms |
| BigQuery | 404 | 290 ms |

These authentication/missing-route responses prove reachability only; no secret
was installed and no database/provider operation ran. Immediately afterward the
original ZIP was restored. AWS reports the function active, update successful,
598 bytes, original handler/runtime, and the deployed hash matches the verified
backup byte-for-byte. No temporary probe code remains in AWS.

Exact production cold/warm performance, authenticated Neon access, Google
credential material loading, memory, timeout and layers remain normal handler
implementation acceptance—not facts to guess during discovery.

Evidence: `lambda-runtime-local-observation.json` and
`lambda-aws-runtime-observation.json`.

## PD-14 — Planning readiness and implementation gates

The final file-level checklist assigns the following without changing the agreed
architecture:
without changing the agreed architecture:

1. Correct cache freshness in the present progressive path and test stale,
   fresh no-coverage, current contract, and latest BigQuery month cases.
2. Select the configured Neon schema before every raw-SQL publication/grant
   transaction and make the guarded integration suite fully green.
3. Build and measure separate Node 24 handlers before selecting ZIP/layer shape,
   memory and timeouts.
4. Implement the observed versioned parsers and immutable S3/reference-SQS
   boundaries, not looser inferred provider payloads.
5. Preserve DataForSEO batching; bound CrUX REST concurrency; retain one batched
   BigQuery query and both independent CrUX outputs.
6. Reserve Browserless capacity at a total ceiling of two, use one sequential
   `/function` session per domain, stop early, and enforce 45 seconds.
7. Apply the proved Neon first-terminal counters, leases, fingerprints,
   cancellation and aggregation fences before any production event source is
   enabled.

No AWS production resources, production database migrations, or deployment
secrets were created by discovery.

## Persistent evidence index

All sanitized fixtures are under `test/fixtures/aws-pipeline/v1/`. The replay and
live-observation harness is `scripts/lambda-payload-discovery-probe.js`. Raw
provider bodies, temporary AWS ZIPs, endpoint hosts, credentials, and production
identifiers are deliberately not part of repository evidence.

## Controlled-operation ledger

| Operation | Effect |
|---|---|
| Browserless live probes | Three sessions total including one public endpoint 503; bounded at active concurrency one. |
| DataForSEO | Three explicitly approved paid calls; $0.03708 provider-reported total. |
| CrUX REST | Six public API calls. |
| CrUX BigQuery | One dry run and one executed three-origin query under a 10 GB cap. |
| Neon | Production read-only observation; writes only in disposable test schemas, all dropped. |
| AWS PD-10 | One conditional learning S3 object and one learning SQS message; evidence objects retained. |
| AWS PD-13 | One temporary direct learning Lambda invocation; original code restored byte-for-byte. |
