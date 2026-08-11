# Traffic Enrichment Provider Discovery

**Status:** AUTHORITATIVE DISCOVERY RECORD  
**Captured:** August 1, 2026  
**Implementation status:** Not started  
**Governing rules:** `PARENT_AGENT_CHECKLIST_INSTRUCTIONS.md`

## 1. Source-of-truth order

Use these documents in this order:

1. this discovery record for observed provider and repository facts;
2. `TRAFFIC_ENRICHMENT_IMPLEMENTATION_CHECKLIST.md` for execution;
3. sanitized fixtures under `email_scraper/test/fixtures/providers/`;
4. sanitized captures under
   `email_scraper/review-evidence/traffic-enrichment/`;
5. official provider documentation linked below.

`TRAFFIC_ENRICHMENT_DISCOVERY_AND_DRAFT_PLAN.md` is superseded supporting
research. `email_scraper/TRAFFIC_ENRICHMENT_SERVICE_COMPARISON.md` remains a
service comparison, not an implementation contract.

## 2. Locked product outcome

Enrich qualified, deduplicated Shopify leads from two independent optional
sources:

- DataForSEO Labs bulk traffic estimation;
- Google CrUX REST API plus the public CrUX BigQuery dataset.

The independent run-snapshotted flags remain:

```env
ENABLE_DATAFORSEO_ENRICHMENT=false
ENABLE_CRUX_ENRICHMENT=false
```

For a disabled source there must be no external request, provider data in the
run result, CSV column/value, UI section, or provider attribution. When both
are disabled, the public lead shape must remain backward compatible and omit
the traffic section entirely.

An enabled optional provider may fail without rejecting or corrupting a core
lead. Missing provider data is unavailable, never numeric zero. Attribution is
generated from provider-derived material actually published, not from flags.

DataForSEO output must be labelled **estimated Google search traffic**, not
total website visits. CrUX popularity is a coarse navigation rank and must not
be labelled as visits. CrUX device fractions describe the form-factor mix in
CrUX observations, not geographic traffic share.

## 3. Probe boundary and cost

The controlled probe used only public domains and did not alter either feature
flag.

### DataForSEO

- Domains: `shopify.com`, `allbirds.com`, `twolines.co.nz`.
- Scopes: worldwide, United States, New Zealand.
- Calls: three production bulk calls, one free sandbox success, one free
  sandbox validation error, and free location metadata calls.
- Provider-reported production cost: **$0.03708 total**, exactly `$0.01236`
  per three-domain task.
- Observed API version: `0.1.20260731`.

### CrUX REST

- Six primary requests covered aggregate success, a one-metric phone request,
  `shopify.com`/`www.shopify.com`, an HTTP origin, and a no-coverage origin.
- Six additional public origins were checked for partial metric coverage. Five
  returned all six requested metrics and one returned 404; no naturally partial
  live record was found.
- CrUX API calls were free.

### CrUX BigQuery

- Metadata and table-list requests were read-only and free.
- The latest observed monthly table was `202606`.
- Initial six-column query: 83,105,084 processed bytes.
- Final single-JSON-row query: 111,193,442 processed bytes and 112,197,632
  billed bytes.
- The final query was capped at 10,000,000,000 bytes before execution.
- Public dataset access was verified through local Google Application Default
  Credentials; no service-account key was created.

No API key, password, OAuth token, authorization header, customer domain, or
contact data is stored in evidence or fixtures.

## 4. Repository integration map

### Observed backend lifecycle

1. `email_scraper/src/server.js` owns the durable worker lease and calls the
   discovery pipeline.
2. `email_scraper/src/pipeline.js` resolves and merges store candidates, then
   processes stores with bounded concurrency.
3. The pipeline returns all lead rows only after core qualification finishes.
4. `PrismaRunRepository.saveCompletedResults()` publishes the completed run,
   lead rows, audits, and diagnostics in one database transaction guarded by
   the active lease.
5. `api-serializer.js` maps stored lead fields to the HTTP contract.
6. `output.js` owns the legacy backend CSV path.
7. The frontend validates every API field in `frontend/lib/api-validation.ts`,
   models it in `frontend/lib/api-types.ts`, displays it in run components, and
   creates client CSV exports in `frontend/lib/csv-export.ts`.

### Integration decision

Traffic calls belong after core store processing and canonical deduplication,
but before terminal publication. The worker heartbeat and lease must remain
active during enrichment. Enrichment state and accepted normalized data must be
published atomically with the lead results.

DataForSEO paid calls need a durable request ledger before the network call.
The current all-at-end persistence pattern is insufficient: a process crash
after a paid response but before `saveCompletedResults()` could charge the same
batch again after recovery.

## 5. DataForSEO request contract

Pinned endpoint:

```text
POST https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_traffic_estimation/live
```

One HTTP request contains exactly one task:

```json
[
  {
    "targets": ["shopify.com", "allbirds.com", "twolines.co.nz"],
    "item_types": [
      "organic",
      "paid",
      "featured_snippet",
      "local_pack"
    ]
  }
]
```

Country tasks add exactly one `location_code`. Worldwide sends neither a
location nor language field. All tasks omit language; live responses echoed
`language_code: null` and returned data, proving the all-available-language
contract for the tested scopes.

Observed country codes from the free provider metadata endpoint:

| Market | ISO | Code |
| --- | --- | ---: |
| United States | US | 2840 |
| United Kingdom | GB | 2826 |
| Canada | CA | 2124 |
| Australia | AU | 2036 |
| New Zealand | NZ | 2554 |
| Germany | DE | 2276 |
| France | FR | 2250 |
| India | IN | 2356 |
| United Arab Emirates | AE | 2784 |

Production uses worldwide plus these nine country tasks. Location metadata is
versioned evidence, not a guessed constant; implementation may pin the above
map and expose a maintenance check against the free endpoint.

Targets must be lower-case canonical ASCII hostnames without scheme, path,
port, credentials, or leading `www.`. They are deduplicated and sorted before
batching, with at most 1,000 targets. The application will not rely on provider
duplicate or target-normalization behavior.

## 6. DataForSEO response findings

The exact response catalogue is in the DataForSEO fixture README. Material
findings are:

- HTTP 200 alone does not mean task success.
- Root `status_code` and `tasks[0].status_code` must both be `20000`.
- One successful task produced exactly one result object.
- Worldwide had `location_code: null`; country results echoed the numeric code.
- Omitted language produced `language_code: null` in every tested live result.
- All three requested domains were returned, including an all-zero item.
- Each item contained all four metric objects with numeric `etv` and integer
  `count`.
- NZ result order differed from request order. Target association must be by
  exact `target`, never index.
- Root and task `cost` were equal in these one-task calls and must be recorded
  at request scope, not divided speculatively across leads.
- Sandbox invalid input returned HTTP 200 and root success, with task error
  `40501` / `Invalid Field: 'targets'.`

Observed all-zero metric objects are accepted as provider-reported zeros. A
missing target, missing metric object, null object, wrong type, duplicate item,
unexpected target, or inconsistent count must never be converted to zero.

## 7. CrUX REST request and response contract

Pinned endpoint:

```text
POST https://chromeuxreport.googleapis.com/v1/records:queryRecord
```

The production aggregate request contains the exact validated HTTPS origin and
the explicit six-metric list captured by the probe. No form factor is supplied,
so results aggregate all devices and include `form_factors` when available.

The response consumes only:

- exact echoed `record.key.origin`;
- the named metric-specific `percentiles.p75` values;
- `form_factors.fractions.desktop`, `.phone`, and `.tablet`;
- collection-period first and last calendar dates.

CLS bounds and p75 are decimal strings. LCP, INP, FCP, and TTFB values are
numbers in milliseconds. The v1 product does not consume histograms.

The official schema says a record may contain one or more metrics, and the
official usage guide explicitly handles missing named metrics. Each requested
metric is therefore independently optional, but a present metric must parse its
one exact schema. At least one requested metric must be present for an available
record.

HTTP 404 with exact `code: 404`, `status: "NOT_FOUND"`, and the documented
message means no CrUX coverage. Other non-2xx responses are provider failures;
their bodies are not logged or guessed.

`https://shopify.com` and `https://www.shopify.com` both had coverage and
returned distinct keys and values. CrUX performs no usable origin canonicalization
for this workflow. Query the one exact HTTPS origin established during
storefront validation. Do not sequentially try scheme or `www` alternatives.

## 8. CrUX BigQuery contract

The free latest-month lookup is:

```text
GET /bigquery/v2/projects/chrome-ux-report/datasets/all/tables?maxResults=1000
```

Only `TABLE` entries under the exact public project/dataset whose table ID
matches six-digit `20YYYY` participate. The greatest ID is the selected month.
A `nextPageToken` is a controlled contract failure in v1 rather than evidence
for an incomplete latest month.

The production query uses named parameters, `useLegacySql: false`, a deployment
byte cap, and this exact result shape:

```sql
SELECT
  TO_JSON_STRING(STRUCT(
    origin AS origin,
    CAST(yyyymm AS STRING) AS dataset_month,
    rank AS popularity_rank,
    phoneDensity AS phone_density,
    desktopDensity AS desktop_density,
    tabletDensity AS tablet_density
  )) AS payload
FROM `chrome-ux-report.materialized.metrics_summary`
WHERE yyyymm = @month
  AND origin IN UNNEST(@origins)
ORDER BY origin
```

The live REST envelope returned one nullable `STRING` schema field named
`payload`; each row was `rows[].f[0].v`, containing JSON with numeric rank and
fractions. Production first verifies this outer schema, then JSON-decodes the
one value and strictly parses the aliased object with Zod. It does not positionally
decode six independent provider cells.

Four origins were requested and three rows returned. The deliberately uncovered
origin was absent, proving that requested-origin reconciliation is required.
Missing rows mean no BigQuery coverage, not rank zero. Both `shopify.com` origin
variants had different ranks and device fractions.

The query must be dry-run before its shape is approved. At runtime it uses a
fixed `maximumBytesBilled`, preserves BigQuery query caching, and batches all run
origins in one parameter array where limits allow. Popularity rank is a coarse
bucket threshold, not a visit count.

## 9. Normalized internal contracts

Provider bodies stay inside their adapters. The proposed contracts are locked
at these semantic shapes; exact Zod code belongs to Window TE1.

### `DataForSeoTrafficV1`

```text
contractVersion: "dataforseo-traffic-v1"
target: canonical hostname
scope: worldwide | { countryIsoCode, locationCode }
languageScope: "all_available"
metrics:
  organic: { etv, count }
  paid: { etv, count }
  featuredSnippet: { etv, count }
  localPack: { etv, count }
fetchedAt: ISO timestamp
```

`estimatedSearchTraffic` is a report-layer derivation of organic ETV plus paid
ETV. Featured-snippet and local-pack ETV are not added because overlap has not
been disproved.

### `CruxOriginMetricsV1`

```text
contractVersion: "crux-origin-metrics-v1"
origin: exact validated HTTPS origin
coverage: available | unavailable
metrics: fixed optional LCP/INP/CLS/FCP/TTFB p75 members
formFactors: fixed optional desktop/phone/tablet fractions
collectionPeriod: firstDate, lastDate
fetchedAt: ISO timestamp
```

### `CruxPopularityV1`

```text
contractVersion: "crux-popularity-v1"
origin: exact validated HTTPS origin
coverage: available | unavailable
datasetMonth: YYYYMM
popularityRank: positive integer
deviceFractions: phone, desktop, tablet
fetchedAt: ISO timestamp
```

Density sums are expected to be approximately one, allowing documented rounding
tolerance rather than exact floating-point equality.

## 10. Persistence and recovery decision

Add three concepts rather than widening the lead table with unstable columns:

1. an immutable run configuration snapshot containing both flags, scopes,
   contract versions, freshness policy, and cost/byte caps;
2. a provider cache keyed by provider, normalized origin/target, scope,
   contract version, and metric set;
3. per-lead published enrichment containing only normalized accepted data and
   source state.

DataForSEO also requires a durable paid-request ledger keyed by the canonical
request fingerprint. Before a paid call the row moves from `planned` to
`in_flight`. A successful parsed response and cache writes are committed before
publication. On restart, `succeeded` is reused; stale `in_flight` becomes
`ambiguous` and is **not automatically retried**. This bounds duplicate-charge
risk. Provider task reconciliation is deferred because its contract was not
probed.

CrUX REST may retry bounded transient network/5xx failures because calls are
free and idempotent. BigQuery may retry once within the same byte cap. Neither
source may retry schema drift or 4xx contract errors.

Recommended freshness:

- DataForSEO success and explicit zero: 30 days;
- CrUX REST: through the observed collection period, with at most one refresh
  per origin per UTC day;
- CrUX BigQuery popularity: immutable for a dataset month and refreshed only
  when a newer month is listed;
- provider/network errors: not cached as data;
- explicit no coverage: separate short-lived state, never zero.

## 11. Public API, CSV, and attribution contract

Add an optional `traffic_enrichment` object to a lead. Omit it when both sources
were disabled for that run. Within it, omit a disabled provider entirely.
Enabled providers may expose an explicit `available`, `partial`, `no_coverage`,
or `unavailable` state, but only accepted metric fields may appear.

CSV uses stable provider-prefixed columns. A disabled provider's columns are
omitted from a dynamically generated export rather than emitted blank. Legacy
backend CSV behavior must be tested separately from the frontend download.

`traffic_sources` and `traffic_attributions` are derived from material actually
included. CrUX attribution must accompany every API view/export that includes
CrUX metrics. DataForSEO attribution/branding and redistribution behavior must
follow written permission before customer release.

## 12. Security, tenancy, and telemetry

- Existing run ownership remains the only authority for accessing lead
  enrichment.
- The client cannot submit flags, provider scopes, costs, origins, or cache
  identity.
- Cache rows are server-derived public-domain facts and never expose which
  other tenant populated them.
- API keys, passwords, OAuth tokens, request authorization, raw bodies, and
  customer lead lists are forbidden in logs and fixtures.
- Telemetry may include provider, contract version, safe outcome code, target
  count, scope, latency, cache hit, actual DataForSEO task cost, BigQuery dry-run
  bytes, billed bytes, and retry/ambiguous state.
- Logs must not include full provider error bodies or credentials.

## 13. Evidence classification

### Observed

- Exact request and response paths in the committed captures and fixtures.
- DataForSEO cost, status layering, null language metadata, explicit zero
  objects, result ordering, and all nine country codes.
- CrUX metric-specific scalar types, form-factor shape, collection dates, 404
  envelope, and exact-origin behavior.
- BigQuery table schema, partitioning by `date`, clustering by `yyyymm, origin`,
  table-list envelope, latest month, JSON-row envelope, missing-row behavior,
  and byte counts.
- Current backend transaction, lease, auth, serializer, and frontend validation
  integration points.

### Inferred but not implementation contracts

- Exact future DataForSEO and BigQuery prices.
- Provider behavior for duplicate or malformed production targets.
- Provider behavior after an ambiguous timeout.
- Whether all future covered CrUX origins return all six requested metrics.

Implementation avoids depending on these inferences.

### External prerequisites / remaining unknowns

- Written DataForSEO permission for the intended customer-facing SaaS display
  and exports remains required before enabling that flag in production.
- AWS-to-Google authentication must be configured for deployment. Prefer
  Workload Identity Federation; do not add a long-lived Google JSON key.
- Final legal attribution wording should be reviewed before commercial launch.
- Prices, quotas, location availability, and BigQuery byte behavior must be
  rechecked before production rollout.

None of these unknowns blocks local adapter, persistence, API, UI, or test
implementation while flags remain false. They do block the corresponding live
production enablement claim.

## 14. Official references

- [DataForSEO bulk traffic endpoint](https://docs.dataforseo.com/v3/dataforseo_labs-google-bulk_traffic_estimation-live/)
- [DataForSEO locations and languages](https://docs.dataforseo.com/v3/dataforseo_labs_locations_and_languages/)
- [DataForSEO sandbox](https://docs.dataforseo.com/v3/appendix/sandbox/)
- [DataForSEO Labs pricing](https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api)
- [DataForSEO terms](https://dataforseo.com/terms-of-service)
- [CrUX REST API](https://developer.chrome.com/docs/crux/api)
- [CrUX REST usage and error guide](https://developer.chrome.com/docs/crux/guides/crux-api)
- [CrUX BigQuery](https://developer.chrome.com/docs/crux/bigquery/)
- [BigQuery query REST method](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query)
- [BigQuery cost controls](https://docs.cloud.google.com/bigquery/docs/best-practices-costs)
- [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)
