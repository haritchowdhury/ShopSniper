import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUTPUT_PATH = "/tmp/email-scraper-traffic-discovery.json";
const DATAFORSEO_ENDPOINT =
  "https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_traffic_estimation/live";
const DATAFORSEO_SANDBOX_ENDPOINT =
  "https://sandbox.dataforseo.com/v3/dataforseo_labs/google/bulk_traffic_estimation/live";
const DATAFORSEO_LOCATIONS_ENDPOINT =
  "https://api.dataforseo.com/v3/dataforseo_labs/locations_and_languages";
const CRUX_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const BIGQUERY_API = "https://bigquery.googleapis.com/bigquery/v2";
const PUBLIC_DOMAINS = ["shopify.com", "allbirds.com", "twolines.co.nz"];
const CRUX_METRICS = [
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
  "first_contentful_paint",
  "experimental_time_to_first_byte",
  "form_factors"
];
const MAX_BIGQUERY_BYTES = 10_000_000_000;

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function requireValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${new URL(url).origin}: HTTP ${response.status}`);
  }
  return { httpStatus: response.status, body };
}

function sanitizeDataForSeo(payload) {
  const clone = structuredClone(payload);
  for (const task of clone.body?.tasks ?? []) {
    if (Object.hasOwn(task, "id")) task.id = "<redacted-task-id>";
  }
  return clone;
}

function sanitizeBigQuery(payload) {
  const clone = structuredClone(payload);
  if (clone.body?.jobReference?.jobId) {
    clone.body.jobReference.jobId = "<redacted-job-id>";
  }
  if (clone.body?.jobReference?.projectId) {
    clone.body.jobReference.projectId = "<billing-project>";
  }
  if (clone.body?.queryId) clone.body.queryId = "<redacted-query-id>";
  return clone;
}

function basicAuthorization(login, password) {
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

function bigQueryAuthorization() {
  const gcloud = path.join(
    process.env.HOME || "/home/harit",
    ".local/google-cloud-sdk/bin/gcloud"
  );
  const token = execFileSync(
    gcloud,
    ["auth", "application-default", "print-access-token"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
  if (!token) throw new Error("Application Default Credentials returned no access token");
  return `Bearer ${token}`;
}

function dataForSeoBody({ locationCode } = {}) {
  const task = {
    targets: PUBLIC_DOMAINS,
    item_types: ["organic", "paid", "featured_snippet", "local_pack"]
  };
  if (locationCode != null) task.location_code = locationCode;
  return [task];
}

function bigQueryParameters(origins, month) {
  return [
    {
      name: "origins",
      parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
      parameterValue: {
        arrayValues: origins.map((value) => ({ value }))
      }
    },
    {
      name: "month",
      parameterType: { type: "INT64" },
      parameterValue: { value: month }
    }
  ];
}

async function main() {
  loadDotEnv(path.resolve(".env"));
  if (!process.argv.includes("--confirm-3-paid-calls")) {
    throw new Error(
      "Refusing the live probe without --confirm-3-paid-calls; it makes three paid DataForSEO calls"
    );
  }
  if (
    process.env.ENABLE_DATAFORSEO_ENRICHMENT !== "false" ||
    process.env.ENABLE_CRUX_ENRICHMENT !== "false"
  ) {
    throw new Error("Both production enrichment flags must remain explicitly false during discovery");
  }
  const login = requireValue("DATAFORSEO_LOGIN");
  const password = requireValue("DATAFORSEO_PASSWORD");
  const cruxApiKey = requireValue("CRUX_API_KEY");
  const billingProject = requireValue("CRUX_BIGQUERY_PROJECT_ID");
  const bigQueryLocation = process.env.CRUX_BIGQUERY_LOCATION || "US";
  const dataForSeoHeaders = {
    Authorization: basicAuthorization(login, password),
    "Content-Type": "application/json"
  };
  const bigQueryHeaders = {
    Authorization: bigQueryAuthorization(),
    "Content-Type": "application/json"
  };

  const evidence = {
    metadata: {
      captured_at: new Date().toISOString(),
      probe_version: "traffic-discovery-v1",
      feature_flags_unchanged: true,
      public_domains: PUBLIC_DOMAINS,
      dataforseo_live_call_limit: 3,
      bigquery_execution_cap_bytes: MAX_BIGQUERY_BYTES
    },
    dataforseo: {},
    crux_api: {},
    crux_bigquery: {}
  };

  const locations = sanitizeDataForSeo(
    await requestJson(DATAFORSEO_LOCATIONS_ENDPOINT, {
      headers: { Authorization: dataForSeoHeaders.Authorization }
    })
  );
  const locationRows = locations.body?.tasks?.[0]?.result;
  if (!Array.isArray(locationRows)) {
    throw new Error("DataForSEO locations response did not contain tasks[0].result[]");
  }
  const selectedLocations = locationRows.filter(({ country_iso_code: code }) =>
    ["US", "NZ"].includes(code)
  );
  if (selectedLocations.length !== 2) {
    throw new Error("DataForSEO locations response did not resolve both US and NZ");
  }
  const locationByIso = Object.fromEntries(
    selectedLocations.map((row) => [row.country_iso_code, row.location_code])
  );
  evidence.dataforseo.locations = {
    request: { method: "GET", endpoint: DATAFORSEO_LOCATIONS_ENDPOINT },
    response: {
      httpStatus: locations.httpStatus,
      body: {
        version: locations.body.version,
        status_code: locations.body.status_code,
        status_message: locations.body.status_message,
        cost: locations.body.cost,
        tasks_count: locations.body.tasks_count,
        tasks_error: locations.body.tasks_error,
        tasks: [
          {
            ...locations.body.tasks[0],
            result_count: selectedLocations.length,
            result: selectedLocations
          }
        ]
      }
    },
    note: "Result was reduced to the two consumed country records; values were not altered."
  };

  const sandboxBody = dataForSeoBody({ locationCode: locationByIso.US });
  evidence.dataforseo.sandbox_success = {
    request: {
      method: "POST",
      endpoint: DATAFORSEO_SANDBOX_ENDPOINT,
      body: sandboxBody
    },
    response: sanitizeDataForSeo(
      await requestJson(DATAFORSEO_SANDBOX_ENDPOINT, {
        method: "POST",
        headers: dataForSeoHeaders,
        body: JSON.stringify(sandboxBody)
      })
    )
  };

  const invalidSandboxBody = [{ targets: [] }];
  evidence.dataforseo.sandbox_task_error = {
    request: {
      method: "POST",
      endpoint: DATAFORSEO_SANDBOX_ENDPOINT,
      body: invalidSandboxBody
    },
    response: sanitizeDataForSeo(
      await requestJson(DATAFORSEO_SANDBOX_ENDPOINT, {
        method: "POST",
        headers: dataForSeoHeaders,
        body: JSON.stringify(invalidSandboxBody)
      })
    )
  };

  const liveScopes = [
    ["worldwide", undefined],
    ["united_states", locationByIso.US],
    ["new_zealand", locationByIso.NZ]
  ];
  evidence.dataforseo.live = {};
  for (const [scope, locationCode] of liveScopes) {
    const body = dataForSeoBody({ locationCode });
    evidence.dataforseo.live[scope] = {
      request: { method: "POST", endpoint: DATAFORSEO_ENDPOINT, body },
      response: sanitizeDataForSeo(
        await requestJson(DATAFORSEO_ENDPOINT, {
          method: "POST",
          headers: dataForSeoHeaders,
          body: JSON.stringify(body)
        })
      )
    };
  }

  const cruxCases = [
    [
      "aggregate_success",
      { origin: "https://www.google.com", metrics: CRUX_METRICS }
    ],
    [
      "phone_metric_subset",
      {
        origin: "https://www.google.com",
        formFactor: "PHONE",
        metrics: ["largest_contentful_paint"]
      }
    ],
    [
      "shopify_without_www",
      { origin: "https://shopify.com", metrics: CRUX_METRICS }
    ],
    [
      "shopify_with_www",
      { origin: "https://www.shopify.com", metrics: CRUX_METRICS }
    ],
    [
      "http_normalization",
      { origin: "http://google.com", metrics: ["largest_contentful_paint"] }
    ],
    [
      "no_coverage",
      {
        origin: "https://no-crux-coverage-probe.invalid",
        metrics: ["largest_contentful_paint"]
      }
    ]
  ];
  for (const [name, body] of cruxCases) {
    evidence.crux_api[name] = {
      request: { method: "POST", endpoint: CRUX_ENDPOINT, body },
      response: await requestJson(`${CRUX_ENDPOINT}?key=${encodeURIComponent(cruxApiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
    };
  }

  const tableMetadata = await requestJson(
    `${BIGQUERY_API}/projects/chrome-ux-report/datasets/materialized/tables/metrics_summary`,
    { headers: { Authorization: bigQueryHeaders.Authorization } }
  );
  evidence.crux_bigquery.table_metadata = {
    request: {
      method: "GET",
      endpoint:
        `${BIGQUERY_API}/projects/chrome-ux-report/datasets/materialized/` +
        "tables/metrics_summary"
    },
    response: sanitizeBigQuery(tableMetadata)
  };

  const tables = await requestJson(
    `${BIGQUERY_API}/projects/chrome-ux-report/datasets/all/tables?maxResults=1000`,
    { headers: { Authorization: bigQueryHeaders.Authorization } }
  );
  const monthlyTableIds = (tables.body?.tables ?? [])
    .map((table) => table.tableReference?.tableId)
    .filter((tableId) => /^20\d{4}$/.test(tableId))
    .sort();
  const latestMonth = monthlyTableIds.at(-1);
  if (!latestMonth) throw new Error("No monthly CrUX table ID was found");
  evidence.crux_bigquery.latest_month_lookup = {
    request: {
      method: "GET",
      endpoint: `${BIGQUERY_API}/projects/chrome-ux-report/datasets/all/tables`,
      query: { maxResults: 1000 }
    },
    response: {
      httpStatus: tables.httpStatus,
      body: { latest_month: latestMonth, matched_table_count: monthlyTableIds.length }
    },
    note: "Only the derived latest YYYYMM and count are retained; no table names are consumed at runtime."
  };

  const requiredColumns = [
    "yyyymm",
    "origin",
    "rank",
    "phoneDensity",
    "desktopDensity",
    "tabletDensity"
  ];
  const observedColumns = new Set(
    (tableMetadata.body?.schema?.fields ?? []).map(({ name }) => name)
  );
  for (const column of requiredColumns) {
    if (!observedColumns.has(column)) {
      throw new Error(`CrUX metrics_summary metadata is missing ${column}`);
    }
  }

  const sql = `SELECT
  origin,
  CAST(yyyymm AS STRING) AS dataset_month,
  rank AS popularity_rank,
  phoneDensity AS phone_density,
  desktopDensity AS desktop_density,
  tabletDensity AS tablet_density
FROM \`chrome-ux-report.materialized.metrics_summary\`
WHERE yyyymm = @month
  AND origin IN UNNEST(@origins)
ORDER BY origin`;
  const origins = [
    "https://www.google.com",
    "https://shopify.com",
    "https://www.shopify.com"
  ];
  const queryParameters = bigQueryParameters(origins, latestMonth);
  const queryBase = {
    query: sql,
    useLegacySql: false,
    parameterMode: "NAMED",
    queryParameters,
    location: bigQueryLocation
  };
  const jobsQueryEndpoint = `${BIGQUERY_API}/projects/${encodeURIComponent(billingProject)}/queries`;
  const dryRun = await requestJson(jobsQueryEndpoint, {
    method: "POST",
    headers: bigQueryHeaders,
    body: JSON.stringify({ ...queryBase, dryRun: true })
  });
  evidence.crux_bigquery.dry_run = {
    request: {
      method: "POST",
      endpoint: `${BIGQUERY_API}/projects/<billing-project>/queries`,
      body: { ...queryBase, dryRun: true }
    },
    response: sanitizeBigQuery(dryRun)
  };

  const estimatedBytes = Number(dryRun.body?.totalBytesProcessed);
  if (
    dryRun.httpStatus === 200 &&
    Number.isFinite(estimatedBytes) &&
    estimatedBytes <= MAX_BIGQUERY_BYTES
  ) {
    const liveQueryBody = {
      ...queryBase,
      maximumBytesBilled: String(MAX_BIGQUERY_BYTES),
      useQueryCache: false,
      timeoutMs: 60_000
    };
    evidence.crux_bigquery.query_success = {
      request: {
        method: "POST",
        endpoint: `${BIGQUERY_API}/projects/<billing-project>/queries`,
        body: liveQueryBody
      },
      response: sanitizeBigQuery(
        await requestJson(jobsQueryEndpoint, {
          method: "POST",
          headers: bigQueryHeaders,
          body: JSON.stringify(liveQueryBody)
        })
      )
    };
  } else {
    evidence.crux_bigquery.query_skipped = {
      reason: "Dry-run bytes were unavailable, invalid, or above the explicit cap.",
      estimated_bytes: dryRun.body?.totalBytesProcessed ?? null
    };
  }

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600
  });

  const liveCost = Object.values(evidence.dataforseo.live).reduce(
    (sum, item) => sum + Number(item.response.body?.cost ?? 0),
    0
  );
  console.log(
    JSON.stringify({
      output_path: OUTPUT_PATH,
      dataforseo_live_calls: liveScopes.length,
      dataforseo_reported_cost_usd: liveCost,
      crux_api_calls: cruxCases.length,
      crux_latest_month: latestMonth,
      bigquery_dry_run_bytes: dryRun.body?.totalBytesProcessed ?? null,
      bigquery_live_query_executed: Boolean(evidence.crux_bigquery.query_success)
    })
  );
}

await main();
