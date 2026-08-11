# Traffic Enrichment Discovery Requirements and Draft Plan

**Status:** SUPERSEDED / DO NOT EXECUTE  
**Purpose:** Preserve the current direction and discovery prerequisites so work
can resume later without relying on conversation history.  
**Last reviewed:** August 1, 2026  
**Governing planning rules:** `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md`

Discovery has now been completed. Use
`TRAFFIC_ENRICHMENT_PROVIDER_DISCOVERY.md` as the authoritative evidence record
and `TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md` as the active sequential
execution plan. The provisional contracts and window IDs below are retained
only as history.

This is intentionally a half-developed plan. It is not the authoritative
execution checklist, and no implementation window should be assigned from this
document. Provider contracts, lifecycle details, persistence design, and
failure semantics must be proven and locked first.

## 1. Current Product Direction

Add two independent, optional traffic-enrichment sources to the Shopify lead
generation pipeline:

1. DataForSEO Labs Bulk Traffic Estimation
2. Google Chrome UX Report (CrUX), using both the REST API and BigQuery where
   appropriate

Each source is controlled by its own boolean environment variable:

```env
ENABLE_DATAFORSEO_ENRICHMENT=false
ENABLE_CRUX_ENRICHMENT=false
```

There is no planned master switch. The required report behavior is:

| DataForSEO | CrUX | Required report behavior |
| --- | --- | --- |
| off | off | No traffic section, provider fields, or provider attribution |
| on | off | Accepted DataForSEO fields and DataForSEO attribution only |
| off | on | Accepted CrUX fields and CrUX attribution only |
| on | on | Both independently parsed sources and both attributions |

Attribution must be generated from provider data actually included in the
report, not merely from current process configuration. Disabled providers must
not be called, persisted into the run result, exported, displayed, or
attributed. Cached data from a disabled provider must not leak into a report.

Feature-flag values should be snapshotted for each run so a configuration
change during a long-running job cannot create a mixed-contract report.

## 2. Intended DataForSEO Scope

Use the versioned endpoint:

```text
POST /v3/dataforseo_labs/google/bulk_traffic_estimation/live
```

Enrich deduplicated, qualified canonical domains in batches of no more than
1,000 domains. Make one bulk task for worldwide estimates and one bulk task for
each tracked country:

1. Worldwide
2. United States
3. United Kingdom
4. Canada
5. Australia
6. New Zealand
7. Germany
8. France
9. India
10. United Arab Emirates

The current proposal is to omit `language_code` so each location uses all
available languages. This is documented provider behavior but must be confirmed
by the controlled discovery probe before it becomes a locked contract.

Request these item types in the same bulk task:

```json
[
  "organic",
  "paid",
  "featured_snippet",
  "local_pack"
]
```

The intended user-facing metrics are:

- worldwide estimated organic Google search traffic,
- worldwide estimated paid Google search traffic,
- worldwide estimated search traffic, derived as organic plus paid,
- country-level organic and paid search estimates,
- organic and paid search mix,
- organic and paid ranking footprint,
- featured-snippet visibility, and
- local-pack visibility.

Featured-snippet and local-pack values must not be added to the worldwide
organic-plus-paid total because overlap has not been ruled out. All traffic
values must be labelled as estimated Google search traffic, never total website
traffic.

### Provisional DataForSEO cost model

Pricing checked during research was approximately:

```text
$0.012 per task
$0.00012 per returned domain/item
```

For 100 new, unique domains across worldwide plus nine countries:

```text
10 × ($0.012 + 100 × $0.00012) = $0.24 maximum estimate
```

Pricing is not a permanent implementation constant. It must be checked before
purchase, and the actual `cost` returned by every accepted provider response
should be recorded in privacy-safe operational telemetry.

## 3. Intended CrUX Scope

CrUX remains part of the plan.

### REST API

Use the free CrUX REST API for current origin-level real-user metrics:

- Largest Contentful Paint (LCP),
- Interaction to Next Paint (INP),
- Cumulative Layout Shift (CLS),
- First Contentful Paint (FCP),
- Time to First Byte (TTFB),
- form-factor fractions where supported,
- collection-period dates, and
- explicit coverage/no-coverage state.

The REST API currently documents a free limit of 150 queries per minute per
Google Cloud project and no purchasable increased quota. Calls must use bounded
concurrency and cached results.

### BigQuery

Use the public CrUX BigQuery dataset for the fields that are not available from
the REST API, primarily:

- coarse popularity rank/band based on total navigations,
- current summary-table data,
- applicable country-level supporting observations, and
- efficient batch lookup of many origins.

The CrUX dataset is free; ordinary BigQuery query-processing charges can apply
beyond the Google Cloud free allowance. Queries must target the smallest
applicable current summary/materialized table, accept a parameterized origin
array, and be dry-run before the production query shape is approved.

CrUX does not provide total visit counts. Its popularity band must not be
displayed as monthly traffic, and missing CrUX coverage must not be interpreted
as zero traffic.

### CrUX commercial use

Google documents the CrUX datasets as licensed under Creative Commons
Attribution 4.0 International. Commercial use, redistribution, transformation,
and inclusion in a paid SaaS are permitted subject to the license requirements.

An attribution similar to the following is proposed:

> Performance and popularity data sourced from the Chrome UX Report by Google,
> licensed under CC BY 4.0. Values may be aggregated or transformed by Email
> Scraper.

Attribution must link to the source and license, identify transformations,
avoid implying Google endorsement, and remain present in exports containing
CrUX-derived data. Final wording should be reviewed before commercial release.

DataForSEO has separate terms. Customer-facing DataForSEO output should remain
disabled until written permission for the intended display/export use is
obtained. Raw DataForSEO response resale is not part of this plan.

## 4. Mandatory No-Fallback Parsing Contract

The requirements in `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md` apply in full.
All external provider data is unknown until accepted by a strict,
deterministic, versioned parser owned by the relevant provider adapter.

Forbidden patterns include:

```js
payload.data ?? payload.result ?? payload.response ?? payload
```

and:

```js
row.rank ?? row.popularity ?? row.popularity_rank
```

Every consumed value must have one documented, evidence-backed path. Multiple
shapes may be supported only as an explicit, documented, discriminated and
fixture-backed version union. Sequential guessing is prohibited.

Requirements for each provider contract:

- pin the endpoint/API/client version where possible,
- retain sanitized, provenance-labelled positive and negative fixtures,
- catalogue every consumed field,
- catalogue intentionally ignored available fields,
- keep raw provider shapes within the adapter,
- emit only normalized internal domain contracts,
- fail missing, moved, or malformed consumed fields with typed,
  privacy-safe contract-drift errors,
- define how unknown additive fields are rejected or intentionally ignored,
- prevent raw bodies, credentials, tokens, customer lead lists, and sensitive
  content from entering fixtures, logs, telemetry, or planning documents, and
- treat missing provider data as unknown/unavailable rather than numeric zero.

## 5. DataForSEO Contract Discovery

The discovery probe must prove the exact shape and semantics of the following
candidate path before it is used:

```text
response
└── tasks[]
    └── result[]
        └── items[]
            ├── target
            └── metrics
                ├── organic
                │   ├── etv
                │   └── count
                ├── paid
                │   ├── etv
                │   └── count
                ├── featured_snippet
                │   ├── etv
                │   └── count
                └── local_pack
                    ├── etv
                    └── count
```

The probe must determine and preserve evidence for:

- top-level success and failure status fields,
- task-level success and failure status fields,
- exact `result` cardinality,
- exact no-data representation,
- legitimately nullable metric objects,
- submitted targets omitted from returned items,
- worldwide location and language metadata,
- country-scoped location and language metadata,
- actual response and task cost fields,
- malformed and partial-task behavior,
- duplicate-domain behavior,
- target normalization behavior,
- all-language behavior when language is omitted, and
- the extension policy for additive fields.

No provider error, missing item, or null metric may be normalized into a
successful zero-valued traffic record unless the proven contract explicitly
distinguishes a true measured zero.

## 6. CrUX Contract Discovery

### REST contract

Prove the exact versioned response paths for:

```text
record
├── key
├── metrics
│   ├── largest_contentful_paint
│   ├── interaction_to_next_paint
│   ├── cumulative_layout_shift
│   ├── first_contentful_paint
│   ├── experimental_time_to_first_byte
│   └── form_factors
└── collectionPeriod
    ├── firstDate
    └── lastDate
```

The probe must establish:

- which requested metrics may legitimately be omitted,
- exact histogram, percentile, and fraction shapes,
- CLS string-versus-number representation,
- exact no-coverage/404 envelope,
- other provider error envelopes,
- canonical origin requirements, including scheme and `www`,
- form-factor request/response behavior,
- collection-period date requirements, and
- additive-field policy.

### BigQuery contract

Do not expose the upstream table or SDK row shape to the application. Prefer an
explicitly aliased query output such as:

```text
origin
dataset_month
popularity_rank
phone_density
desktop_density
tablet_density
```

The exact aliases and nullability remain provisional until the current table
schema and controlled query output are inspected. Parse the aliased row with a
strict versioned schema. A moved upstream column should fail the query or parser
rather than activate a fallback alias.

CrUX REST and CrUX BigQuery are separate proven contracts within one CrUX
module. Partial success behavior must be explicitly defined; the REST API must
not fabricate unavailable BigQuery popularity, and BigQuery must not fabricate
unavailable REST performance metrics.

## 7. Required Sanitized Fixtures

The expected fixture layout is provisional:

```text
email_scraper/test/fixtures/providers/dataforseo/
  README.md
  bulk-traffic-v1-success.json
  bulk-traffic-v1-null-metrics.json
  bulk-traffic-v1-domain-omitted.json
  bulk-traffic-v1-task-error.json
  bulk-traffic-v1-malformed.json

email_scraper/test/fixtures/providers/crux/
  README.md
  query-record-v1-success.json
  query-record-v1-partial-metrics.json
  query-record-v1-not-found.json
  query-record-v1-malformed.json
  bigquery-summary-row-v1-success.json
  bigquery-summary-row-v1-nullable.json
```

Each fixture README must record:

- provider and endpoint/query,
- contract version,
- evidence provenance,
- sanitization performed,
- fields consumed,
- fields intentionally ignored,
- additive-field policy, and
- capture date.

Fixtures must prove that missing, moved, wrong-type, malformed, and provider
error payloads cannot become accepted enrichment.

## 8. Discovery Prerequisites

Secrets must be placed in `email_scraper/.env` and never pasted into chat,
committed, logged, or added to fixtures.

### DataForSEO

```env
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=
```

The account needs trial or funded credit for a minimal controlled live probe.
The proposed live probe uses approximately three public domains across:

- Worldwide,
- United States, and
- New Zealand.

At the currently researched prices, the estimated maximum probe cost is:

```text
3 × ($0.012 + 3 × $0.00012) ≈ $0.0371
```

Use the DataForSEO sandbox first. Sandbox evidence alone is not sufficient to
close actual-cost, coverage, and no-data unknowns because it returns dummy data.

### CrUX REST

Enable the Chrome UX Report API in a Google Cloud project, create a dedicated
API key restricted to that API, and configure:

```env
CRUX_API_KEY=
```

Do not reuse an unrestricted Google Custom Search key. Probe public origins
with known coverage and expected no coverage; customer domains are unnecessary.

### CrUX BigQuery

Configure:

```env
CRUX_BIGQUERY_PROJECT_ID=
CRUX_BIGQUERY_LOCATION=US
```

The project must have billing attached. The local executing identity needs
permission to create BigQuery query jobs, normally `roles/bigquery.jobUser` on
the billing project. The public CrUX dataset requires no write permission.

Local discovery may use Google Application Default Credentials:

```bash
gcloud auth application-default login
```

Do not commit a service-account JSON key. For the later AWS deployment, prefer
workload identity federation over a long-lived Google service-account key.

Start with a BigQuery dry run to validate SQL and bytes processed without
executing a billed query.

## 9. Discovery Outputs Required Before Planning

Create a provider-contract discovery record that classifies every material
finding as:

- **observed** — proven by current source, schema, official documentation,
  sanitized fixture, dry run, or controlled runtime evidence;
- **inferred** — plausible but not allowed to become an implementation
  contract; or
- **unknown** — must be resolved, explicitly deferred, or recorded as a
  blocker.

The discovery record must include:

1. current backend and frontend integration map,
2. exact provider request contracts,
3. exact accepted response and error contracts,
4. fixture provenance and sanitization notes,
5. normalized internal contract proposals,
6. caching and freshness evidence,
7. lifecycle and partial-failure findings,
8. query-cost and provider-cost evidence,
9. attribution and redistribution requirements,
10. database/migration implications,
11. authorization and tenant-boundary implications,
12. telemetry and privacy requirements, and
13. unresolved blockers and user prerequisites.

Unknowns affecting parsing, durable data, authorization, ownership,
transactions, or destructive behavior block implementation planning.

## 10. Provisional Architecture

Provider-specific modules should remain independent:

```text
src/enrichment/dataforseo/
  client.js
  contract.js
  adapter.js

src/enrichment/crux/
  api-client.js
  api-contract.js
  bigquery-client.js
  bigquery-contract.js
  adapter.js
```

Exact paths are not locked. Each adapter should return only a normalized,
versioned internal contract, provisionally named:

```text
DataForSeoTrafficV1
CruxOriginMetricsV1
CruxPopularityV1
```

The orchestration layer should:

1. finish core store qualification,
2. collect qualified canonical domains,
3. deduplicate domains,
4. remove fresh cache hits for enabled providers,
5. batch DataForSEO domains by worldwide/country scope,
6. perform bounded CrUX REST lookups,
7. perform a parameterized CrUX BigQuery batch lookup,
8. normalize only parser-accepted results,
9. write enrichment under a defined transaction/recovery protocol,
10. publish provider-specific fields and attribution conditionally, and
11. preserve the core lead result when an optional provider is unavailable.

This lifecycle is provisional. Discovery must identify the correct transaction
boundary, cache ownership, run completion behavior, retry policy, lease/fence
interaction, and restart recovery before it can be divided into implementation
windows.

## 11. Provisional Cache and Cost Controls

The current direction is:

- cache DataForSEO data for approximately 30 days,
- cache explicit no-data results as a distinct state,
- cache CrUX data according to its collection period and update cadence,
- key cache entries by normalized identity, provider, contract version, scope,
  and metric set,
- reuse safe provider data across user runs without leaking tenant-owned data,
- never treat a cached provider failure as measured zero,
- avoid blind retries after ambiguous paid-request timeouts,
- persist actual DataForSEO charged cost when accepted safely,
- enforce a per-run enrichment budget,
- batch DataForSEO at up to 1,000 domains per task, and
- keep provider concurrency and retries bounded.

Cache retention, cross-tenant reuse, paid-call idempotency, timeout ambiguity,
and transactional publication are still unknowns that discovery must resolve.

## 12. Provisional Reporting Fields

Candidate DataForSEO fields:

```text
estimated_worldwide_search_traffic
estimated_worldwide_organic_traffic
estimated_worldwide_paid_traffic
organic_search_share
paid_search_share
organic_ranking_footprint
paid_ranking_footprint
featured_snippet_estimate
featured_snippet_count
local_pack_estimate
local_pack_count
search_traffic_by_market
dataforseo_observed_at
dataforseo_contract_version
```

Candidate CrUX fields:

```text
crux_data_available
crux_popularity_rank
crux_popularity_band
crux_phone_fraction
crux_desktop_fraction
crux_tablet_fraction
crux_lcp_p75_ms
crux_inp_p75_ms
crux_cls_p75
crux_fcp_p75_ms
crux_ttfb_p75_ms
crux_collection_start
crux_collection_end
crux_contract_version
```

Candidate provenance fields:

```text
traffic_sources
traffic_attributions
traffic_enrichment_state
traffic_enrichment_observed_at
```

These names, nullability rules, storage locations, and API/CSV exposure are not
locked. The final contract should avoid a wide, unstable lead table if a
versioned provider-enrichment relation or JSON contract is safer.

## 13. Safety Invariants To Carry Into The Final Checklist

- Provider flags are independent and snapshotted per run.
- A disabled provider causes zero external calls.
- Disabled or stale cached provider data cannot leak into a report.
- Only strictly parsed, versioned provider data influences behavior.
- Provider errors and no coverage are distinct from measured zero.
- DataForSEO values are never described as total website traffic.
- CrUX popularity is never described as visits.
- Optional-provider failure cannot corrupt or reject an otherwise valid lead.
- Raw payloads and credentials never leave provider adapters or enter logs.
- Attribution exactly matches provider material included in each report/export.
- Existing tenant ownership and authorization boundaries remain enforced.
- Enrichment publication cannot bypass the current worker lease/fence.
- Paid retries are bounded and duplicate-charge risk is observable.
- Migrations are forward-only and preserve existing runs and leads.
- Historical unenriched leads remain valid and truthful.

Each invariant must eventually have one owning implementation window,
deterministic tests, and an independent parent review.

## 14. Provisional Execution Windows

Do not execute these windows yet. IDs are placeholders and must be replaced by
stable, unused identifiers after repository history and existing checklist IDs
are reviewed.

1. **Provider discovery and contract fixtures**
   - Complete repository integration mapping.
   - Run controlled DataForSEO, CrUX REST, and CrUX BigQuery probes.
   - Create sanitized fixtures and discovery evidence.
   - Resolve parsing and no-data unknowns.

2. **Strict independent provider adapters**
   - Implement exact versioned request/response parsers.
   - Normalize provider contracts.
   - Add typed privacy-safe provider failures.
   - Prove negative parser behavior.

3. **Persistence, cache, orchestration, and recovery**
   - Add forward-only migrations.
   - Implement flag snapshots and cache semantics.
   - Insert enrichment after core qualification/deduplication.
   - Preserve lease fencing, idempotency, restart recovery, and atomic
     publication.

4. **Backend reporting and CSV contracts**
   - Serialize provider fields only when included.
   - Generate exact conditional attribution.
   - Prevent disabled/cached leakage.
   - Preserve historical API compatibility.

5. **Frontend display and export**
   - Add validated optional provider contracts.
   - Show compact traffic summary and complete expanded evidence.
   - Make CSV columns and attribution truthful for all four flag combinations.

6. **Independent parent reliability review**
   - Inspect the full diff and lifecycle.
   - Re-run focused and full verification.
   - Reproduce provider drift, partial failure, disabled-source leakage,
     concurrency, retry, restart, migration, authorization, and attribution
     cases.
   - Open append-only corrective windows for findings.

Window division and ownership must be revised after discovery. External
contract discovery and broad implementation must not be combined in one
implementation window.

## 15. Planning Readiness Gate

The authoritative execution checklist must not be created or assigned until:

- one contradiction-free product contract exists,
- repository integration points are directly inspected,
- DataForSEO request, response, cost, no-data, and error contracts are proven,
- CrUX REST response, omission, and error contracts are proven,
- CrUX BigQuery schema, aliased row contract, dry-run bytes, and nullability are
  proven,
- normalized domain contracts are locked,
- feature-flag and attribution semantics are locked,
- cache, retention, paid retry, transaction, lease, and restart behavior are
  defined,
- migration preservation is defined,
- every invariant has one proposed owner and deterministic acceptance evidence,
- live prerequisites are separated from local deterministic acceptance, and
- a fresh implementation agent can work without conversation history.

## 16. External References

- DataForSEO Bulk Traffic Estimation:
  https://docs.dataforseo.com/v3/dataforseo_labs-google-bulk_traffic_estimation-live/
- DataForSEO Labs pricing:
  https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api
- DataForSEO terms:
  https://dataforseo.com/terms-of-service
- CrUX API:
  https://developer.chrome.com/docs/crux/api
- CrUX History API:
  https://developer.chrome.com/docs/crux/history-api/
- CrUX BigQuery:
  https://developer.chrome.com/docs/crux/bigquery/
- CrUX methodology and dataset license:
  https://developer.chrome.com/docs/crux/methodology
- Creative Commons Attribution 4.0:
  https://creativecommons.org/licenses/by/4.0/

## 17. Related Repository Documents

- `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md` — authoritative checklist-authoring
  and independent-review rules.
- `email_scraper/TRAFFIC_ENRICHMENT_SERVICE_COMPARISON.md` — prior provider
  research and cost/utility comparison; supporting research, not an execution
  checklist.

When work resumes, begin with Section 8 prerequisites and Section 9 discovery
outputs. Do not begin implementation from the provisional windows alone.
