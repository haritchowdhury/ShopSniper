import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { HttpError } from "../src/http-client.js";
import { EnrichmentError } from "../src/enrichment/errors.js";
import {
  fetchCruxOriginMetrics,
  fetchCruxPopularity,
  normalizeCruxOriginMetricsResponse
} from "../src/enrichment/crux/adapter.js";
import {
  parseCruxApiResponse,
  parseCruxNotFound
} from "../src/enrichment/crux/api-contract.js";
import {
  CRUX_API_ENDPOINT,
  CRUX_METRICS,
  buildCruxApiRequest,
  normalizeCruxOrigin
} from "../src/enrichment/crux/api-request.js";
import {
  parseCruxBigQueryDryRun,
  parseCruxBigQueryResponse,
  parseCruxTableList
} from "../src/enrichment/crux/bigquery-contract.js";
import {
  CRUX_BIGQUERY_ORIGIN_LIMIT,
  CRUX_BIGQUERY_SQL,
  buildCruxBigQueryDryRunRequest,
  buildCruxBigQueryLiveRequest
} from "../src/enrichment/crux/bigquery-request.js";

const FIXTURES = new URL("./fixtures/providers/crux/", import.meta.url);
const ORIGIN = "https://www.google.com";
const NOW = () => new Date("2026-08-02T00:00:00.000Z");

function fixture(name) {
  return JSON.parse(fs.readFileSync(new URL(name, FIXTURES), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function config(overrides = {}) {
  return {
    cruxEnrichmentEnabled: true,
    cruxApiKey: "fixture-api-key",
    cruxBigQueryProjectId: "fixture-project",
    cruxBigQueryLocation: "US",
    cruxBigQueryMaxBytesBilled: 10000000000,
    requestTimeoutMs: 20000,
    ...overrides
  };
}

function assertContractMismatch(callback) {
  assert.throws(callback, (error) =>
    error instanceof EnrichmentError && error.code === "provider_contract_mismatch"
  );
}

test("REST request pins one exact origin and six explicit metrics", () => {
  const descriptor = buildCruxApiRequest(ORIGIN);
  assert.equal(descriptor.endpoint, CRUX_API_ENDPOINT);
  assert.deepEqual(descriptor.body, { origin: ORIGIN, metrics: CRUX_METRICS });
  assert.equal(JSON.stringify(descriptor).includes("fixture-api-key"), false);
});

test("REST origins reject alternate or ambiguous URL forms", () => {
  assert.equal(normalizeCruxOrigin(ORIGIN), ORIGIN);
  for (const value of [
    "http://www.google.com",
    `${ORIGIN}/`,
    `${ORIGIN}/path`,
    `${ORIGIN}?query=1`,
    "https://user:pass@www.google.com",
    "https://WWW.google.com",
    "https://xn--bcher-kva.example"
  ]) assert.throws(() => normalizeCruxOrigin(value), EnrichmentError);
});

test("REST aggregate fixture normalizes exact metric-specific values", () => {
  const descriptor = buildCruxApiRequest(ORIGIN);
  const result = normalizeCruxOriginMetricsResponse({
    descriptor,
    body: fixture("query-record-v1-success.json")
  }, { now: NOW });
  assert.deepEqual(result, {
    contractVersion: "crux-origin-metrics-v1",
    origin: ORIGIN,
    coverage: "available",
    metrics: {
      largestContentfulPaintP75Ms: 1129,
      interactionToNextPaintP75Ms: 171,
      cumulativeLayoutShiftP75: "0.00",
      firstContentfulPaintP75Ms: 568,
      timeToFirstByteP75Ms: 234
    },
    formFactors: { desktop: 0.2617, phone: 0.7254, tablet: 0.0129 },
    collectionPeriod: { firstDate: "2026-07-03", lastDate: "2026-07-30" },
    fetchedAt: "2026-08-02T00:00:00.000Z"
  });
});

test("REST subset omits only unavailable named metrics", () => {
  const parsed = parseCruxApiResponse(
    fixture("query-record-v1-metric-subset.json"),
    buildCruxApiRequest(ORIGIN)
  );
  assert.deepEqual(parsed.metrics, { largestContentfulPaintP75Ms: 1123 });
  assert.equal("formFactors" in parsed, false);
});

test("only the exact captured 404 is no coverage", () => {
  assert.deepEqual(parseCruxNotFound(fixture("query-record-v1-not-found.json")), {
    coverage: "unavailable",
    reason: "not_found"
  });
  const altered = fixture("query-record-v1-not-found.json");
  altered.error.message = "different";
  assertContractMismatch(() => parseCruxNotFound(altered));
});

test("REST client sends key only at dispatch and never retries an origin variant", async () => {
  const calls = [];
  const result = await fetchCruxOriginMetrics({ origin: ORIGIN, config: config() }, {
    now: NOW,
    request: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, body: JSON.stringify(fixture("query-record-v1-success.json")) };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("key"), "fixture-api-key");
  assert.equal(calls[0].options.retries, 0);
  assert.equal(calls[0].options.maxRedirects, 0);
  assert.equal(result.coverage, "available");
});

test("REST retries bounded network/5xx failures but not rate limits", async () => {
  let transientCalls = 0;
  const recovered = await fetchCruxOriginMetrics({ origin: ORIGIN, config: config() }, {
    now: NOW,
    delay: async () => {},
    request: async () => {
      transientCalls += 1;
      if (transientCalls < 3) throw new HttpError("HTTP 503", { status: 503 });
      return { status: 200, body: JSON.stringify(fixture("query-record-v1-success.json")) };
    }
  });
  assert.equal(recovered.coverage, "available");
  assert.equal(transientCalls, 3);

  let rateLimitCalls = 0;
  await assert.rejects(
    fetchCruxOriginMetrics({ origin: ORIGIN, config: config() }, {
      now: NOW,
      delay: async () => {},
      request: async () => {
        rateLimitCalls += 1;
        throw new HttpError("HTTP 429", { status: 429 });
      }
    }),
    (error) => error instanceof EnrichmentError && error.code === "provider_http_error"
  );
  assert.equal(rateLimitCalls, 1);
});

test("REST exact 404 through client normalizes unavailable", async () => {
  const result = await fetchCruxOriginMetrics({ origin: ORIGIN, config: config() }, {
    now: NOW,
    request: async () => {
      throw new HttpError("HTTP 404", {
        status: 404,
        body: JSON.stringify(fixture("query-record-v1-not-found.json"))
      });
    }
  });
  assert.equal(result.coverage, "unavailable");
});

test("REST rejects wrong scalars, empty metrics, bad dates, fractions, and echo drift", () => {
  const descriptor = buildCruxApiRequest(ORIGIN);
  assertContractMismatch(() => parseCruxApiResponse(
    fixture("query-record-v1-malformed.json"), descriptor
  ));
  for (const mutate of [
    (value) => { value.record.metrics = {}; },
    (value) => { value.record.key.origin = "https://shopify.com"; },
    (value) => { value.record.collectionPeriod.firstDate.day = 32; },
    (value) => { value.record.collectionPeriod.firstDate = { year: 2026, month: 7, day: 31 }; },
    (value) => { value.record.metrics.form_factors.fractions.desktop = 0.9; },
    (value) => { value.record.metrics.cumulative_layout_shift.percentiles.p75 = -1; }
  ]) {
    const value = fixture("query-record-v1-success.json");
    mutate(value);
    assertContractMismatch(() => parseCruxApiResponse(value, descriptor));
  }
});

test("table-list parser selects 202606 and rejects pagination or wrong identity", () => {
  assert.equal(parseCruxTableList(fixture("bigquery-table-list-v1-success.json")), "202606");
  const paged = fixture("bigquery-table-list-v1-success.json");
  paged.nextPageToken = "next";
  assertContractMismatch(() => parseCruxTableList(paged));
  const wrong = fixture("bigquery-table-list-v1-success.json");
  for (const table of wrong.tables) table.tableReference.projectId = "other";
  assertContractMismatch(() => parseCruxTableList(wrong));
});

test("BigQuery builders pin SQL, named parameters, dry/live separation, and cache", () => {
  const common = {
    origins: ["https://www.shopify.com", "https://shopify.com"],
    month: "202606",
    projectId: "fixture-project",
    location: "US"
  };
  const dry = buildCruxBigQueryDryRunRequest(common);
  const live = buildCruxBigQueryLiveRequest({ ...common, maximumBytesBilled: 10000000000 });
  assert.equal(dry.body.query, CRUX_BIGQUERY_SQL);
  assert.equal(dry.body.dryRun, true);
  assert.equal("maximumBytesBilled" in dry.body, false);
  assert.equal(live.body.useLegacySql, false);
  assert.equal(live.body.parameterMode, "NAMED");
  assert.equal(live.body.maximumBytesBilled, "10000000000");
  assert.equal(live.body.useQueryCache, true);
  assert.deepEqual(live.origins, ["https://shopify.com", "https://www.shopify.com"]);
});

test("BigQuery request rejects duplicates, invalid month, and too many origins", () => {
  const base = { month: "202606", projectId: "fixture-project", location: "US" };
  assert.throws(() => buildCruxBigQueryDryRunRequest({
    ...base, origins: [ORIGIN, ORIGIN]
  }), EnrichmentError);
  assert.throws(() => buildCruxBigQueryDryRunRequest({
    ...base, month: "202613", origins: [ORIGIN]
  }), EnrichmentError);
  const tooMany = Array.from(
    { length: CRUX_BIGQUERY_ORIGIN_LIMIT + 1 },
    (_, index) => `https://host-${index}.example`
  );
  assert.throws(() => buildCruxBigQueryDryRunRequest({
    ...base, origins: tooMany
  }), EnrichmentError);
});

test("BigQuery JSON-row fixture parses exact aliased payloads", () => {
  const descriptor = buildCruxBigQueryLiveRequest({
    origins: ["https://shopify.com", ORIGIN, "https://www.shopify.com"],
    month: "202606",
    projectId: "fixture-project",
    location: "US",
    maximumBytesBilled: 10000000000
  });
  const parsed = parseCruxBigQueryResponse(
    fixture("bigquery-json-row-v1-success.json"), descriptor
  );
  assert.equal(parsed.rowsByOrigin.get("https://www.shopify.com").popularity_rank, 5000);
  assert.equal(parsed.bytesBilled, 112197632);
  assert.deepEqual(parsed.contractMismatchOrigins, []);
});

test("BigQuery isolates zero-density rows without discarding valid origins", () => {
  const descriptor = buildCruxBigQueryLiveRequest({
    origins: ["https://shopify.com", ORIGIN, "https://www.shopify.com"],
    month: "202606",
    projectId: "fixture-project",
    location: "US",
    maximumBytesBilled: 10000000000
  });
  const response = fixture("bigquery-json-row-v1-success.json");
  const anomalous = JSON.parse(response.rows[0].f[0].v);
  anomalous.phone_density = 0;
  anomalous.desktop_density = 0;
  anomalous.tablet_density = 0;
  response.rows[0].f[0].v = JSON.stringify(anomalous);

  const parsed = parseCruxBigQueryResponse(response, descriptor);
  assert.equal(parsed.rowsByOrigin.has(anomalous.origin), false);
  assert.equal(parsed.rowsByOrigin.size, 2);
  assert.deepEqual(parsed.contractMismatchOrigins, [anomalous.origin]);
});

test("BigQuery no rows remains valid no coverage", () => {
  const descriptor = buildCruxBigQueryLiveRequest({
    origins: [ORIGIN], month: "202606", projectId: "fixture-project",
    location: "US", maximumBytesBilled: 10000000000
  });
  const parsed = parseCruxBigQueryResponse(
    fixture("bigquery-json-row-v1-no-rows.json"), descriptor
  );
  assert.equal(parsed.rowsByOrigin.size, 0);
});

test("BigQuery rejects malformed f/v, JSON, schema, duplicate, unexpected, and incomplete data", () => {
  const descriptor = buildCruxBigQueryLiveRequest({
    origins: ["https://shopify.com", ORIGIN, "https://www.shopify.com"],
    month: "202606", projectId: "fixture-project", location: "US",
    maximumBytesBilled: 10000000000
  });
  assertContractMismatch(() => parseCruxBigQueryResponse(
    fixture("bigquery-json-row-v1-malformed.json"), descriptor
  ));
  for (const mutate of [
    (value) => { value.rows[0].f[0].v = "not-json"; },
    (value) => { value.schema.fields[0].name = "result"; },
    (value) => { value.rows[1].f[0].v = value.rows[0].f[0].v; },
    (value) => {
      const payload = JSON.parse(value.rows[0].f[0].v);
      payload.origin = "https://unexpected.example";
      value.rows[0].f[0].v = JSON.stringify(payload);
    },
    (value) => { value.jobComplete = false; },
    (value) => { value.pageToken = "next"; },
    (value) => {
      const payload = JSON.parse(value.rows[0].f[0].v);
      payload.extra = true;
      value.rows[0].f[0].v = JSON.stringify(payload);
    },
    (value) => {
      const payload = JSON.parse(value.rows[0].f[0].v);
      payload.phone_density = 2;
      value.rows[0].f[0].v = JSON.stringify(payload);
    }
  ]) {
    const value = fixture("bigquery-json-row-v1-success.json");
    mutate(value);
    assertContractMismatch(() => parseCruxBigQueryResponse(value, descriptor));
  }
});

test("dry-run parser requires completion, exact schema, and safe byte integer", () => {
  const value = fixture("bigquery-json-row-v1-success.json");
  assert.deepEqual(parseCruxBigQueryDryRun(value), { bytesProcessed: 111193442 });
  value.jobComplete = false;
  assertContractMismatch(() => parseCruxBigQueryDryRun(value));
});

test("popularity adapter reconciles a missing requested row as no coverage", async () => {
  const requested = [
    ORIGIN,
    "https://shopify.com",
    "https://www.shopify.com",
    "https://no-crux-coverage-probe.invalid"
  ];
  const responses = [
    fixture("bigquery-table-list-v1-success.json"),
    fixture("bigquery-json-row-v1-success.json"),
    fixture("bigquery-json-row-v1-success.json")
  ];
  const result = await fetchCruxPopularity({ origins: requested, config: config() }, {
    now: NOW,
    tokenProvider: async () => "fixture-oauth-token",
    request: async () => ({ status: 200, body: JSON.stringify(responses.shift()) })
  });
  assert.equal(result.datasetMonth, "202606");
  assert.equal(result.records.length, 4);
  assert.equal(
    result.records.find((record) => record.origin.includes("no-crux")).coverage,
    "unavailable"
  );
  assert.equal(result.records.find((record) => record.origin === ORIGIN).popularityRank, 1000);
});

test("popularity adapter exposes a zero-density origin as a row-level contract mismatch", async () => {
  const live = fixture("bigquery-json-row-v1-success.json");
  const anomalous = JSON.parse(live.rows[0].f[0].v);
  anomalous.phone_density = 0;
  anomalous.desktop_density = 0;
  anomalous.tablet_density = 0;
  live.rows[0].f[0].v = JSON.stringify(anomalous);
  const responses = [
    fixture("bigquery-table-list-v1-success.json"),
    fixture("bigquery-json-row-v1-success.json"),
    live
  ];
  const result = await fetchCruxPopularity({
    origins: ["https://shopify.com", ORIGIN, "https://www.shopify.com"],
    config: config()
  }, {
    now: NOW,
    tokenProvider: async () => "fixture-oauth-token",
    request: async () => ({ status: 200, body: JSON.stringify(responses.shift()) })
  });

  const record = result.records.find(({ origin }) => origin === anomalous.origin);
  assert.equal(record.coverage, "unavailable");
  assert.equal(record.reason, "contract_mismatch");
  assert.equal(result.records.filter(({ coverage }) => coverage === "available").length, 2);
});

test("dry-run over cap prevents the live query", async () => {
  const calls = [];
  const responses = [
    fixture("bigquery-table-list-v1-success.json"),
    fixture("bigquery-json-row-v1-success.json")
  ];
  await assert.rejects(
    fetchCruxPopularity({ origins: [ORIGIN], config: config({
      cruxBigQueryMaxBytesBilled: 100
    }) }, {
      tokenProvider: async () => "fixture-oauth-token",
      request: async (url, options) => {
        calls.push({ url, options });
        return { status: 200, body: JSON.stringify(responses.shift()) };
      }
    }),
    (error) => error instanceof EnrichmentError && error.code === "provider_rejected"
  );
  assert.equal(calls.length, 2);
});

test("clients emit privacy-safe failures without secrets, origins, SQL, or bodies", async () => {
  const secret = "fixture-super-secret-key";
  let error;
  try {
    await fetchCruxOriginMetrics({ origin: ORIGIN, config: config({ cruxApiKey: secret }) }, {
      request: async () => { throw new TypeError(`failure ${secret} ${ORIGIN}`); }
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof EnrichmentError);
  const serialized = JSON.stringify(error) + error.message;
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(ORIGIN), false);
  assert.equal(serialized.includes("SELECT"), false);
});
