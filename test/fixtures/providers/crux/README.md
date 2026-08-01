# CrUX fixture contracts

Contracts:

- `crux-query-record-v1`
- `crux-bigquery-json-row-v1`

## CrUX REST API

Endpoint: `POST /v1/records:queryRecord`. The API key is supplied only in the
URL query string by the client and is never retained in fixtures, logs, or
errors. The request uses exactly one `origin` and an explicit metric list.

For an aggregate success, the parser consumes `record.key.origin`, the six
catalogued optional keys under `record.metrics`, and
`record.collectionPeriod.{firstDate,lastDate}.{year,month,day}`. The five
performance metrics consume `percentiles.p75`; LCP, INP, FCP, and TTFB use
numeric p75 values, while CLS uses the provider's documented decimal-string
representation. `form_factors` consumes
`fractions.{desktop,phone,tablet}`. Histogram bins are intentionally ignored in
v1. Unknown additive fields and unrequested metric keys are ignored only after
the required envelope and named metric shapes parse.

The official CrUX contract allows a record to contain one or more metrics, and
Google's guide demonstrates checking for a missing named metric. Therefore the
six named metric members are optional independently, but any member that is
present must match its exact metric-specific schema. Missing metrics normalize
to unavailable, never zero. A record with none of the requested metrics is a
contract mismatch.

`query-record-v1-success.json`, `query-record-v1-metric-subset.json`, and
`query-record-v1-not-found.json` are observed responses captured on 2026-08-01
from public origins. HTTP 404 is accepted as no coverage only for the exact
`error.{code:404,status:"NOT_FOUND",message}` envelope. Other non-2xx responses
become typed provider failures without consuming or logging their bodies.
`query-record-v1-malformed.json` is a synthetic negative mutation that changes
the LCP p75 from number to string.

The probe proved that `https://shopify.com` and
`https://www.shopify.com` are distinct covered origins. The client must query
the one exact HTTPS origin established by storefront validation and must not
try alternate scheme or `www` variants.

## CrUX BigQuery REST API

The latest completed month is discovered with one free
`GET /bigquery/v2/projects/chrome-ux-report/datasets/all/tables?maxResults=1000`
request. Its parser consumes `kind: "bigquery#tableList"`, `totalItems`, and
each `tables[].{kind,tableReference,type}`. Only `TABLE` entries whose exact
`tableReference` points to project `chrome-ux-report`, dataset `all`, and a
six-digit `20YYYY` table ID participate. A `nextPageToken` is not silently
ignored: if one appears, the v1 client fails safely because the retained page
would not prove the latest table. `bigquery-table-list-v1-success.json` is a
three-entry synthetic reduction of the 105-entry observed response; retained
objects and field values were not altered.

The query targets `chrome-ux-report.materialized.metrics_summary`, filters an
explicit latest `yyyymm` and a parameterized origin array, and returns one
aliased `TO_JSON_STRING(STRUCT(...)) AS payload` field. The HTTP parser requires
the exact schema `payload: STRING`, `jobComplete: true`, decimal-string
`totalRows`, and rows shaped as `rows[].f[0].v`. Each `v` is then JSON-decoded
and passed to a strict Zod contract containing exactly:

- `origin` string;
- `dataset_month` six-digit string;
- `popularity_rank` integer;
- `phone_density`, `desktop_density`, and `tablet_density` finite numbers.

This avoids positional decoding of six separate BigQuery fields. Requested
origins omitted from rows normalize to no coverage, not zero. Null payloads,
invalid JSON, duplicate origins, unexpected payload fields, or malformed
numbers are contract mismatches.

`bigquery-json-row-v1-success.json` is the sanitized observed REST response from
a 2026-08-01 controlled query. Its dry run processed 111,193,442 bytes and its
live query billed 112,197,632 bytes. The no-rows and malformed fixtures are
synthetic negative/edge mutations of that response. BigQuery job and query IDs
and the billing project were replaced.

No fixture contains an API key, OAuth token, customer origin, credential, or
raw unsanitized provider response. Full sanitized provenance is under
`review-evidence/traffic-enrichment/`.
