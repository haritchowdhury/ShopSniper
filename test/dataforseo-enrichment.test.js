import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { HttpError } from "../src/http-client.js";
import { log } from "../src/logger.js";
import { normalizeDataForSeoResponse, fetchDataForSeoTraffic } from "../src/enrichment/dataforseo/adapter.js";
import { parseDataForSeoResponse } from "../src/enrichment/dataforseo/contract.js";
import { EnrichmentError } from "../src/enrichment/errors.js";
import {
  DATAFORSEO_BULK_TRAFFIC_ENDPOINT,
  DATAFORSEO_COUNTRY_LOCATION_CODES,
  DATAFORSEO_ITEM_TYPES,
  buildDataForSeoRequest
} from "../src/enrichment/dataforseo/request.js";

const FIXTURE_DIRECTORY = new URL("./fixtures/providers/dataforseo/", import.meta.url);
const TARGETS = ["shopify.com", "allbirds.com", "twolines.co.nz"];
const FETCHED_AT = "2026-08-02T10:00:00.000Z";

function fixture(name) {
  return JSON.parse(fs.readFileSync(new URL(name, FIXTURE_DIRECTORY), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function descriptor(scope = "worldwide") {
  return buildDataForSeoRequest({ targets: TARGETS, scope });
}

function assertCode(code) {
  return (error) => {
    assert.ok(error instanceof EnrichmentError);
    assert.equal(error.code, code);
    return true;
  };
}

test("request construction pins endpoint, scopes, item types, order, and fingerprint", () => {
  const worldwide = descriptor();
  assert.equal(worldwide.endpoint, DATAFORSEO_BULK_TRAFFIC_ENDPOINT);
  assert.deepEqual(worldwide.targets, ["allbirds.com", "shopify.com", "twolines.co.nz"]);
  assert.deepEqual(worldwide.body, [{
    targets: ["allbirds.com", "shopify.com", "twolines.co.nz"],
    item_types: [...DATAFORSEO_ITEM_TYPES]
  }]);
  assert.equal("location_code" in worldwide.task, false);
  assert.equal("language_code" in worldwide.task, false);
  assert.match(worldwide.requestFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(
    descriptor().requestFingerprint,
    buildDataForSeoRequest({ targets: [...TARGETS].reverse() }).requestFingerprint
  );

  assert.deepEqual(DATAFORSEO_COUNTRY_LOCATION_CODES, {
    US: 2840, GB: 2826, CA: 2124, AU: 2036, NZ: 2554,
    DE: 2276, FR: 2250, IN: 2356, AE: 2784
  });
  const country = descriptor({ countryIsoCode: "nz" });
  assert.deepEqual(country.scope, { countryIsoCode: "NZ", locationCode: 2554 });
  assert.equal(country.task.location_code, 2554);
  assert.equal("language_code" in country.task, false);
  assert.notEqual(country.requestFingerprint, worldwide.requestFingerprint);
});

test("request validation rejects noncanonical, ambiguous, duplicate, and oversized targets", () => {
  for (const target of [
    "https://shopify.com", "shopify.com/path", "user@shopify.com",
    "shopify.com:443", "www.shopify.com", "shöpify.com", "xn--shpify-5wa.com",
    "127.0.0.1", "localhost", "bad_label.example", "-bad.example", "bad-.example",
    " shopify.com"
  ]) {
    assert.throws(
      () => buildDataForSeoRequest({ targets: [target] }),
      assertCode("invalid_request"),
      target
    );
  }
  assert.throws(() => buildDataForSeoRequest({ targets: [] }), assertCode("invalid_request"));
  assert.throws(
    () => buildDataForSeoRequest({ targets: ["SHOPIFY.COM", "shopify.com"] }),
    assertCode("invalid_request")
  );
  assert.throws(
    () => buildDataForSeoRequest({
      targets: Array.from({ length: 1001 }, (_, index) => `store-${index}.example`)
    }),
    assertCode("invalid_request")
  );
  assert.throws(
    () => buildDataForSeoRequest({ targets: ["shopify.com"], scope: { countryIsoCode: "JP" } }),
    assertCode("invalid_request")
  );
});

test("worldwide fixture normalizes exact metrics and preserves provider zero", () => {
  const output = normalizeDataForSeoResponse({
    descriptor: descriptor(),
    body: fixture("bulk-traffic-v1-worldwide-success.json")
  }, { now: () => new Date(FETCHED_AT) });

  assert.equal(output.requestFingerprint, descriptor().requestFingerprint);
  assert.deepEqual(output.cost, { providerReported: 0.01236 });
  assert.equal(output.records.length, 3);
  const allbirds = output.records[0].value;
  assert.deepEqual(allbirds, {
    contractVersion: "dataforseo-traffic-v1",
    target: "allbirds.com",
    scope: "worldwide",
    languageScope: "all_available",
    metrics: {
      organic: { etv: 372641.606290061, count: 8491 },
      paid: { etv: 0, count: 0 },
      featuredSnippet: { etv: 0, count: 0 },
      localPack: { etv: 85.1200008392334, count: 5 }
    },
    fetchedAt: FETCHED_AT
  });
  assert.deepEqual(output.records[2].value.metrics, {
    organic: { etv: 0, count: 0 },
    paid: { etv: 0, count: 0 },
    featuredSnippet: { etv: 0, count: 0 },
    localPack: { etv: 0, count: 0 }
  });
  assert.equal(JSON.stringify(output).includes("redacted-task-id"), false);
});

test("country fixture matches NZ items by target rather than response index", () => {
  const requestDescriptor = descriptor({ countryIsoCode: "NZ" });
  const output = normalizeDataForSeoResponse({
    descriptor: requestDescriptor,
    body: fixture("bulk-traffic-v1-country-success.json")
  }, { now: () => FETCHED_AT });
  assert.deepEqual(output.records.map((record) => record.value.target), [
    "allbirds.com", "shopify.com", "twolines.co.nz"
  ]);
  assert.equal(output.records[0].value.metrics.organic.etv, 1519.4978944659233);
  assert.equal(output.records[1].value.metrics.organic.etv, 29392.437606230378);
  assert.deepEqual(output.records[0].value.scope, {
    countryIsoCode: "NZ",
    locationCode: 2554
  });
});

test("an omitted target is typed unavailable and is never synthesized as zero", () => {
  const output = normalizeDataForSeoResponse({
    descriptor: descriptor(),
    body: fixture("bulk-traffic-v1-domain-omitted.json")
  }, { now: () => FETCHED_AT });
  assert.deepEqual(output.records[2], {
    state: "unavailable",
    target: "twolines.co.nz",
    reason: "provider_omitted_target"
  });
  assert.equal("value" in output.records[2], false);
});

test("task rejection, missing result, and null metrics have distinct safe typed errors", () => {
  assert.throws(() => parseDataForSeoResponse(
    fixture("bulk-traffic-v1-task-error.json"), descriptor()
  ), (error) => {
    assertCode("provider_rejected")(error);
    assert.equal(error.paidOutcome, "zero_cost_proven");
    return true;
  });
  for (const name of ["bulk-traffic-v1-malformed.json", "bulk-traffic-v1-null-metrics.json"]) {
    assert.throws(
      () => parseDataForSeoResponse(fixture(name), descriptor()),
      assertCode("provider_contract_mismatch")
    );
  }

  for (const mutate of [
    (value) => { value.cost = 0.01; value.tasks[0].cost = 0.01; },
    (value) => { value.tasks[0].status_code = 40502; },
    (value) => { value.tasks[0].result_count = 1; }
  ]) {
    const value = fixture("bulk-traffic-v1-task-error.json");
    mutate(value);
    assert.throws(
      () => parseDataForSeoResponse(value, descriptor()),
      assertCode("provider_contract_mismatch")
    );
  }
});

test("strict response reconciliation rejects wrong scalars, negatives, duplicates, and drift", () => {
  const base = fixture("bulk-traffic-v1-worldwide-success.json");
  const mutations = [
    (value) => { value.tasks[0].result[0].items[0].metrics.organic.etv = "1"; },
    (value) => { value.tasks[0].result[0].items[0].metrics.organic.etv = -1; },
    (value) => { value.tasks[0].result[0].items[0].metrics.organic.count = -1; },
    (value) => { value.tasks[0].result[0].items[0].metrics.organic.count = 1.5; },
    (value) => { value.tasks[0].result[0].items.push(clone(value.tasks[0].result[0].items[0])); value.tasks[0].result[0].items_count += 1; },
    (value) => { value.tasks[0].result[0].items[0].target = "unexpected.example"; },
    (value) => { value.tasks[0].result[0].items_count = 99; },
    (value) => { value.tasks[0].result[0].total_count = 99; },
    (value) => { value.tasks_count = 2; },
    (value) => { value.tasks[0].result_count = 2; },
    (value) => { value.tasks[0].data.targets[0] = "other.example"; },
    (value) => { value.tasks[0].data.item_types.reverse(); },
    (value) => { value.tasks[0].data.location_code = 2840; },
    (value) => { value.tasks[0].result[0].location_code = 2840; },
    (value) => { value.tasks[0].result[0].language_code = "en"; },
    (value) => { value.version = "0.1.future"; },
    (value) => { value.tasks[0].cost = 2; }
  ];
  for (const mutate of mutations) {
    const value = clone(base);
    mutate(value);
    assert.throws(
      () => parseDataForSeoResponse(value, descriptor()),
      assertCode("provider_contract_mismatch")
    );
  }
  assert.throws(
    () => parseDataForSeoResponse("not-json", descriptor()),
    assertCode("provider_contract_mismatch")
  );
  assert.throws(
    () => parseDataForSeoResponse({ data: base }, descriptor()),
    assertCode("provider_contract_mismatch")
  );
});

test("date-stamped DataForSEO patch versions do not change the consumed contract", () => {
  const value = fixture("bulk-traffic-v1-worldwide-success.json");
  value.version = "0.1.20260807";
  assert.equal(parseDataForSeoResponse(value, descriptor()).itemsByTarget.size, 3);
  value.version = "0.2.20260807";
  assert.throws(() => parseDataForSeoResponse(value, descriptor()),
    assertCode("provider_contract_mismatch"));
});

test("catalogued additive fields are ignored and cannot affect normalized output", () => {
  const baseline = fixture("bulk-traffic-v1-worldwide-success.json");
  const additive = clone(baseline);
  additive.ignored_root = { alternate_result: [{ target: "attacker.example" }] };
  additive.tasks[0].ignored_task = "ignored";
  additive.tasks[0].result[0].items[0].ignored_item = 123;
  const first = normalizeDataForSeoResponse(
    { descriptor: descriptor(), body: baseline },
    { now: () => FETCHED_AT }
  );
  const second = normalizeDataForSeoResponse(
    { descriptor: descriptor(), body: additive },
    { now: () => FETCHED_AT }
  );
  assert.deepEqual(second, first);
});

test("client sends one paid task with no retries and returns no raw material", async () => {
  const responseFixture = fixture("bulk-traffic-v1-worldwide-success.json");
  let observed;
  const output = await fetchDataForSeoTraffic({
    targets: TARGETS,
    config: {
      dataForSeoLogin: "fixture-login",
      dataForSeoPassword: "fixture-password",
      requestTimeoutMs: 1234
    }
  }, {
    now: () => FETCHED_AT,
    request: async (url, options) => {
      observed = { url, options };
      return { status: 200, body: JSON.stringify(responseFixture) };
    }
  });
  assert.equal(observed.url, DATAFORSEO_BULK_TRAFFIC_ENDPOINT);
  assert.equal(observed.options.method, "POST");
  assert.equal(observed.options.retries, 0);
  assert.equal(observed.options.maxRedirects, 0);
  assert.equal(observed.options.validatePublic, true);
  assert.equal(observed.options.timeoutMs, 1234);
  assert.deepEqual(JSON.parse(observed.options.body), [descriptor().task]);
  assert.match(observed.options.headers.authorization, /^Basic /u);
  assert.equal(JSON.stringify(output).includes("authorization"), false);
  assert.equal(JSON.stringify(output).includes("tasks"), false);
});

test("transport and logging errors do not expose credentials, targets, auth, or raw bodies", async () => {
  const secrets = [
    "fixture-login", "fixture-password", "shopify.com", "allbirds.com",
    "Basic Zml4dHVyZS1sb2dpbjpmaXh0dXJlLXBhc3N3b3Jk", "raw-provider-secret"
  ];
  let thrown;
  try {
    await fetchDataForSeoTraffic({
      targets: TARGETS,
      config: {
        dataForSeoLogin: secrets[0],
        dataForSeoPassword: secrets[1],
        requestTimeoutMs: 1000
      }
    }, {
      request: async () => {
        throw new HttpError("HTTP 503 raw-provider-secret shopify.com", {
          status: 503,
          body: "raw-provider-secret allbirds.com"
        });
      }
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof EnrichmentError);
  assert.equal(thrown.code, "provider_request_ambiguous");
  assert.equal(thrown.paidOutcome, "possibly_charged");

  let written = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { written += chunk; return true; };
  try {
    log("dataforseo_failure", { error: thrown });
  } finally {
    process.stdout.write = originalWrite;
  }
  const material = `${JSON.stringify(thrown)} ${written}`;
  for (const secret of secrets) assert.equal(material.includes(secret), false);
});

test("missing credentials fail before network I/O", async () => {
  let calls = 0;
  await assert.rejects(
    fetchDataForSeoTraffic({
      targets: ["shopify.com"],
      config: { dataForSeoLogin: "", dataForSeoPassword: "", requestTimeoutMs: 1000 }
    }, { request: async () => { calls += 1; } }),
    (error) => {
      assertCode("configuration_error")(error);
      assert.equal(error.paidOutcome, "not_dispatched");
      return true;
    }
  );
  assert.equal(calls, 0);
});
