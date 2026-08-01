# DataForSEO bulk traffic fixture contract

Contract: `dataforseo-bulk-traffic-v1`

Endpoint: `POST /v3/dataforseo_labs/google/bulk_traffic_estimation/live`.
The request is a JSON array containing exactly one task. The client sends a
deduplicated `targets` array, the four exact `item_types` (`organic`, `paid`,
`featured_snippet`, and `local_pack`), and either no location field for
worldwide/all-location data or one documented `location_code`. The client does
not send a language field, which the provider documents as all available
languages and the live probe echoed as `language_code: null`.

The provider response parser consumes these exact paths:

- root `version`, `status_code`, `status_message`, `cost`, `tasks_count`,
  `tasks_error`, and `tasks`;
- `tasks[0].status_code`, `status_message`, `cost`, `result_count`, `data`, and
  `result`;
- the echoed `data.targets`, `data.item_types`, and optional
  `data.location_code`;
- `result[0].se_type`, `location_code`, `language_code`, `total_count`,
  `items_count`, and `items`;
- every item's `se_type`, `target`, and the exact metric paths
  `metrics.{organic,paid,featured_snippet,local_pack}.{etv,count}`.

Task IDs, execution times, and path metadata are intentionally ignored.
Unknown additive fields are ignored after the required contract parses; they
must never influence normalization until catalogued and tested. Response items
are matched by exact normalized target, never array position. The NZ live
response proved that provider item order can differ from request order.

`bulk-traffic-v1-worldwide-success.json` and
`bulk-traffic-v1-country-success.json` are sanitized live responses captured on
2026-08-01 using three public domains. Task IDs were replaced. The provider
charged `$0.01236` for each response. The worldwide fixture contains one
provider-reported record whose four metric pairs are explicitly zero; zero is
accepted only when all required metric objects are present and numeric.

`bulk-traffic-v1-task-error.json` is an observed free sandbox response to an
empty `targets` array. It proves that HTTP 200 and root status 20000 can contain
a task-level error (`40501`), so both status layers must be checked.

The omitted-domain, null-metrics, and malformed fixtures are synthetic negative
mutations of the sanitized worldwide live capture. They are not claims about
provider no-data behavior. They prove respectively that a missing requested
target becomes unavailable rather than zero, a null metric object is rejected,
and a missing result envelope produces `provider_contract_mismatch`.

No fixture contains credentials, authorization headers, customer domains,
email addresses, or raw unsanitized provider material. Full sanitized probe
provenance is in
`review-evidence/traffic-enrichment/PROVIDER_DISCOVERY_CAPTURE_2026-08-01.json`.
