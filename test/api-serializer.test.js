import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  leadTrafficEnrichmentRecordToCreate,
  leadRecordToCreate,
  serializeLead,
  serializeRun,
  serializeTrafficEnrichment,
  serializeTrafficOverview,
  trafficCacheRecordToUpsert
} from "../src/api-serializer.js";
import {
  assertPublicLeadScoreState,
  LeadStateInvariantError
} from "../src/lead-state.js";
import { log } from "../src/logger.js";

test("lead serialization preserves snake_case types and normalizes blanks", () => {
  const stored = leadRecordToCreate("run_abcdefghijklmnop", "lead_fixture", {
    original_shop_type: "Independent Eyewear",
    shop_type: "eyewear",
    query_score: "91",
    google_rank: "",
    social_profiles: ["https://instagram.com/example", 42],
    status: "qualified",
    pipeline_version: 2,
    scoring_version: 2,
    lead_score: 80,
    score_breakdown: {
      version: 2,
      components: {
        identity: 14,
        shopifyValidation: 20,
        categoryFit: 24,
        contactEvidence: 22
      },
      total: 80,
      semantics: "deterministic_evidence_rank_not_probability"
    },
    email: " "
  });
  const serialized = serializeLead(stored);

  assert.equal(serialized.shop_type, "eyewear");
  assert.equal(serialized.original_shop_type, "Independent Eyewear");
  assert.equal(serialized.query_score, 91);
  assert.equal(serialized.google_rank, null);
  assert.equal(serialized.email, null);
  assert.deepEqual(serialized.social_profiles, [
    "https://instagram.com/example"
  ]);
  assert.equal(serialized.status, "qualified");
});

test("run serialization fills the complete progress contract", () => {
  const serialized = serializeRun({
    id: "run_abcdefghijklmnop",
    state: "completed",
    stage: "completed",
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
    startedAt: null,
    completedAt: new Date("2026-07-31T01:00:00.000Z"),
    normalizedShopTypes: [{
      originalShopType: "Independent Eyewear",
      shopType: "eyewear",
      businessQualifier: "unspecified"
    }],
    progress: { queriesTotal: 4 },
    resultsAvailable: true,
    safeErrorCode: null,
    safeErrorMessage: null
  });

  assert.equal(serialized.progress.queriesTotal, 4);
  assert.equal(serialized.progress.storesQualified, 0);
  assert.equal("blankQueriesSkipped" in serialized.progress, false);
  assert.equal(serialized.resultsAvailable, true);
  assert.equal(serialized.error, null);
  assert.equal(serialized.pipelineVersion, null);
  assert.deepEqual(serialized.categories, [{
    originalShopType: "Independent Eyewear",
    shopType: "eyewear",
    businessQualifier: "unspecified"
  }]);
});

test("traffic persistence accepts normalized contracts and rejects raw or secret-shaped envelopes", () => {
  const value = {
    contractVersion: "dataforseo-traffic-v1",
    target: "fixture.example",
    scope: "worldwide",
    languageScope: "all_available",
    metrics: {
      organic: { etv: 1, count: 1 },
      paid: { etv: 0, count: 0 },
      featuredSnippet: { etv: 0, count: 0 },
      localPack: { etv: 0, count: 0 }
    },
    fetchedAt: "2026-08-01T00:00:00.000Z"
  };
  const cache = trafficCacheRecordToUpsert("cache_fixture", {
    source: "dataforseo",
    identity: "fixture.example",
    scopeKey: "worldwide",
    metricSetKey: "featured_snippet,local_pack,organic,paid",
    contractVersion: "dataforseo-traffic-v1",
    state: "available",
    normalizedPayload: value,
    fetchedAt: value.fetchedAt,
    expiresAt: "2026-08-31T00:00:00.000Z"
  });
  assert.equal(cache.normalizedPayload.metrics.organic.etv, 1);
  assert.throws(() => trafficCacheRecordToUpsert("cache_raw", {
    ...cache,
    fetchedAt: value.fetchedAt,
    expiresAt: "2026-08-31T00:00:00.000Z",
    normalizedPayload: { ...value, rawBody: { authorization: "fixture" } }
  }), /normalized contract/u);
  assert.throws(() => trafficCacheRecordToUpsert("cache_error", {
    ...cache,
    state: "no_coverage",
    normalizedPayload: value,
    fetchedAt: value.fetchedAt,
    expiresAt: "2026-08-02T00:00:00.000Z"
  }), /cannot contain a payload/u);
  assert.throws(() => trafficCacheRecordToUpsert("cache_identity", {
    ...cache,
    identity: "www.fixture.example",
    normalizedPayload: { ...value, target: "www.fixture.example" },
    fetchedAt: value.fetchedAt,
    expiresAt: "2026-08-31T00:00:00.000Z"
  }), /normalized contract/u);
  assert.throws(() => trafficCacheRecordToUpsert("cache_scope", {
    ...cache,
    scopeKey: "country:IN:2840",
    normalizedPayload: {
      ...value,
      scope: { countryIsoCode: "IN", locationCode: 2840 }
    },
    fetchedAt: value.fetchedAt,
    expiresAt: "2026-08-31T00:00:00.000Z"
  }), /normalized contract/u);

  const published = leadTrafficEnrichmentRecordToCreate(
    "traffic_fixture",
    "run_fixture",
    "lead_fixture",
    {
      source: "dataforseo",
      state: "partial",
      contractVersion: "dataforseo-traffic-v1",
      normalizedPayload: { records: [value] },
      fetchedAt: value.fetchedAt
    }
  );
  assert.equal(published.normalizedPayload.records.length, 1);
  assert.throws(() => leadTrafficEnrichmentRecordToCreate(
    "traffic_bad", "run_fixture", "lead_fixture",
    { ...published, contractVersion: "wrong-version" }
  ), /source contract|does not match/u);
});

test("traffic persistence accepts non-material CrUX states without payload timing", () => {
  for (const record of [
    {
      source: "crux_rest",
      state: "no_coverage",
      contractVersion: "crux-origin-metrics-v1"
    },
    {
      source: "crux_bigquery",
      state: "contract_mismatch",
      contractVersion: "crux-popularity-v1"
    }
  ]) {
    const stored = leadTrafficEnrichmentRecordToCreate(
      `traffic_${record.source}`,
      "run_fixture",
      "lead_fixture",
      record
    );
    assert.equal(stored.state, record.state);
    assert.equal(stored.normalizedPayload, undefined);
    assert.equal(stored.fetchedAt, null);
  }
});

test("normalized traffic storage rejects impossible cross-field material", () => {
  const metric = { etv: 1, count: 1 };
  const data = {
    contractVersion: "dataforseo-traffic-v1",
    target: "fixture.example",
    scope: "worldwide",
    languageScope: "all_available",
    metrics: {
      organic: metric,
      paid: metric,
      featuredSnippet: metric,
      localPack: metric
    },
    fetchedAt: "2026-08-01T00:00:00.000Z"
  };
  const publishedData = (records) => leadTrafficEnrichmentRecordToCreate(
    "traffic_data", "run_fixture", "lead_fixture", {
      source: "dataforseo",
      state: "partial",
      contractVersion: "dataforseo-traffic-v1",
      normalizedPayload: { records },
      fetchedAt: data.fetchedAt
    }
  );
  for (const records of [
    [{ ...data, target: "www.fixture.example" }],
    [data, { ...data }],
    [data, { ...data, target: "other.example", scope: { countryIsoCode: "IN", locationCode: 2356 } }],
    [{ ...data, scope: { countryIsoCode: "ZZ", locationCode: 9999 } }],
    [{ ...data, scope: { countryIsoCode: "IN", locationCode: 2840 } }]
  ]) {
    assert.throws(() => publishedData(records), /normalized contract/u);
  }

  const rest = {
    contractVersion: "crux-origin-metrics-v1",
    origin: "https://fixture.example",
    coverage: "available",
    metrics: { largestContentfulPaintP75Ms: 2400 },
    formFactors: { desktop: 0.4, phone: 0.6, tablet: 0 },
    collectionPeriod: { firstDate: "2026-07-01", lastDate: "2026-07-28" },
    fetchedAt: "2026-08-01T00:00:00.000Z"
  };
  const publishedRest = (normalizedPayload) => leadTrafficEnrichmentRecordToCreate(
    "traffic_rest", "run_fixture", "lead_fixture", {
      source: "crux_rest",
      state: "available",
      contractVersion: "crux-origin-metrics-v1",
      normalizedPayload,
      fetchedAt: rest.fetchedAt,
      coverageStartedAt: rest.collectionPeriod.firstDate,
      coverageEndedAt: rest.collectionPeriod.lastDate
    }
  );
  for (const payload of [
    { ...rest, origin: "http://fixture.example/path" },
    { ...rest, metrics: {}, formFactors: undefined },
    { ...rest, formFactors: { desktop: 1, phone: 1, tablet: 1 } },
    { ...rest, collectionPeriod: { firstDate: "2026-07-28", lastDate: "2026-07-01" } }
  ]) {
    assert.throws(() => publishedRest(payload), /normalized contract/u);
  }
  assert.throws(() => publishedRest({ ...rest, fetchedAt: "2026-08-02T00:00:00.000Z" }),
    /fetch time/u);

  const popularity = {
    contractVersion: "crux-popularity-v1",
    origin: "https://fixture.example",
    coverage: "available",
    datasetMonth: "202606",
    popularityRank: 100000,
    deviceFractions: { phone: 0.7, desktop: 0.3, tablet: 0 },
    fetchedAt: "2026-08-01T00:00:00.000Z"
  };
  for (const payload of [
    { ...popularity, datasetMonth: "202613" },
    { ...popularity, origin: "https://fixture.example/path" },
    { ...popularity, deviceFractions: { phone: 1, desktop: 1, tablet: 1 } }
  ]) {
    assert.throws(() => leadTrafficEnrichmentRecordToCreate(
      "traffic_popularity", "run_fixture", "lead_fixture", {
        source: "crux_bigquery",
        state: "available",
        contractVersion: "crux-popularity-v1",
        normalizedPayload: payload,
        fetchedAt: popularity.fetchedAt
      }
    ), /normalized contract/u);
  }
});

const trafficSnapshot = (dataForSeo, crux) => ({
  dataForSeo: { enabled: dataForSeo },
  crux: { enabled: crux }
});

function dataForSeoPublished(scope = "worldwide") {
  return {
    source: "dataforseo",
    state: "partial",
    contractVersion: "dataforseo-traffic-v1",
    fetchedAt: new Date("2026-08-01T00:00:00.000Z"),
    normalizedPayload: {
      records: [{
        contractVersion: "dataforseo-traffic-v1",
        target: "fixture.example",
        scope,
        languageScope: "all_available",
        metrics: {
          organic: { etv: 10.5, count: 7 },
          paid: { etv: 1.5, count: 2 },
          featuredSnippet: { etv: 3, count: 1 },
          localPack: { etv: 4, count: 1 }
        },
        fetchedAt: "2026-08-01T00:00:00.000Z"
      }]
    }
  };
}

function cruxRestPublished() {
  return {
    source: "crux_rest",
    state: "available",
    contractVersion: "crux-origin-metrics-v1",
    fetchedAt: new Date("2026-08-01T00:00:00.000Z"),
    coverageStartedAt: new Date("2026-07-01T00:00:00.000Z"),
    coverageEndedAt: new Date("2026-07-28T00:00:00.000Z"),
    normalizedPayload: {
      contractVersion: "crux-origin-metrics-v1",
      origin: "https://fixture.example",
      coverage: "available",
      metrics: {
        largestContentfulPaintP75Ms: 2400,
        cumulativeLayoutShiftP75: "0.12"
      },
      formFactors: { desktop: 0.4, phone: 0.6, tablet: 0 },
      collectionPeriod: { firstDate: "2026-07-01", lastDate: "2026-07-28" },
      fetchedAt: "2026-08-01T00:00:00.000Z"
    }
  };
}

function cruxPopularityPublished(origin = "https://fixture.example") {
  return {
    source: "crux_bigquery",
    state: "available",
    contractVersion: "crux-popularity-v1",
    fetchedAt: new Date("2026-08-01T00:00:00.000Z"),
    normalizedPayload: {
      contractVersion: "crux-popularity-v1",
      origin,
      coverage: "available",
      datasetMonth: "202606",
      popularityRank: 100000,
      deviceFractions: { phone: 0.7, desktop: 0.3, tablet: 0 },
      fetchedAt: "2026-08-01T00:00:00.000Z"
    }
  };
}

test("public traffic serialization preserves the legacy shape when disabled or historical", () => {
  assert.equal(serializeTrafficEnrichment([dataForSeoPublished()], undefined), undefined);
  assert.equal(serializeTrafficEnrichment([], trafficSnapshot(false, false)), undefined);
  const lead = serializeLead({ id: "legacy", status: "rejected" }, {
    trafficEnrichmentConfig: trafficSnapshot(false, false),
    trafficEnrichments: [dataForSeoPublished()]
  });
  assert.equal("traffic_enrichment" in lead, false);
});

test("public traffic serialization derives labelled DataForSEO metrics without overlap", () => {
  const worldwide = dataForSeoPublished();
  const country = dataForSeoPublished({ countryIsoCode: "IN", locationCode: 2356 });
  worldwide.state = "partial";
  worldwide.normalizedPayload.records.push(country.normalizedPayload.records[0]);
  const serialized = serializeTrafficEnrichment([worldwide], trafficSnapshot(true, false));
  assert.equal(serialized.version, "traffic-enrichment-public-v1");
  assert.equal(serialized.dataforseo.state, "partial");
  assert.equal(serialized.dataforseo.worldwide.estimated_google_search_traffic, 12);
  assert.equal(serialized.dataforseo.worldwide.featured_snippet_estimated_traffic, 3);
  assert.deepEqual(serialized.dataforseo.markets.map(({ country_code }) => country_code), ["IN"]);
  assert.deepEqual(serialized.traffic_sources, ["dataforseo"]);
  assert.equal(serialized.traffic_attributions[0].source, "dataforseo");
  assert.equal(JSON.stringify(serialized).includes("providerCost"), false);
});

test("traffic overview aggregates validated DataForSEO material without exposing lead rows", () => {
  const india = dataForSeoPublished({ countryIsoCode: "IN", locationCode: 2356 });
  const first = dataForSeoPublished();
  first.normalizedPayload.records.push(india.normalizedPayload.records[0]);
  const malformed = {
    source: "dataforseo",
    state: "available",
    contractVersion: "dataforseo-traffic-v1",
    normalizedPayload: { rawBody: ["must-not-leak"] }
  };
  const overview = serializeTrafficOverview(
    "run_abcdefghijklmnop",
    [
      { id: "lead_one", trafficEnrichments: [first] },
      { id: "lead_two", trafficEnrichments: [dataForSeoPublished()] },
      { id: "lead_bad", trafficEnrichments: [malformed] }
    ],
    trafficSnapshot(true, false),
    "fixture"
  );

  assert.equal(overview.version, "traffic-overview-v1");
  assert.deepEqual(overview.scope, {
    search: "fixture",
    matchedLeads: 3,
    leadsWithTraffic: 2
  });
  assert.equal(overview.worldwide.estimated_google_search_traffic, 24);
  assert.equal(overview.markets[0].country_code, "IN");
  assert.equal(overview.markets[0].estimated_google_search_traffic, 12);
  assert.equal(JSON.stringify(overview).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(overview).includes("lead_one"), false);
});

test("public CrUX serialization groups components and attributes only material", () => {
  const rest = cruxRestPublished();
  const noPopularity = {
    source: "crux_bigquery",
    state: "no_coverage",
    contractVersion: "crux-popularity-v1",
    normalizedPayload: null
  };
  const serialized = serializeTrafficEnrichment([rest, noPopularity], trafficSnapshot(false, true));
  assert.equal(serialized.crux.state, "partial");
  assert.equal(serialized.crux.origin_metrics.metrics.largest_contentful_paint_p75_ms, 2400);
  assert.equal(serialized.crux.popularity.state, "no_coverage");
  assert.deepEqual(serialized.traffic_sources, ["crux"]);
  assert.match(serialized.traffic_attributions[0].license_url, /creativecommons/u);
  assert.match(serialized.traffic_attributions[0].transformation, /selected and renamed/u);

  const noMaterial = serializeTrafficEnrichment([
    { source: "crux_rest", state: "no_coverage", normalizedPayload: null },
    noPopularity
  ], trafficSnapshot(false, true));
  assert.equal(noMaterial.crux.state, "no_coverage");
  assert.equal("traffic_sources" in noMaterial, false);
  assert.equal("traffic_attributions" in noMaterial, false);

  const both = serializeTrafficEnrichment([
    dataForSeoPublished(),
    rest,
    noPopularity
  ], trafficSnapshot(true, true));
  assert.deepEqual(both.traffic_sources, ["dataforseo", "crux"]);
  assert.deepEqual(
    both.traffic_attributions.map(({ source }) => source),
    ["dataforseo", "crux"]
  );
});

test("public traffic material and attribution fail closed on semantic conflicts", () => {
  const unsupported = dataForSeoPublished({ countryIsoCode: "ZZ", locationCode: 9999 });
  const data = serializeTrafficEnrichment([unsupported], trafficSnapshot(true, false));
  assert.deepEqual(data.dataforseo, { state: "unavailable" });
  assert.equal("traffic_sources" in data, false);
  assert.equal("traffic_attributions" in data, false);

  const crux = serializeTrafficEnrichment([
    cruxRestPublished(),
    cruxPopularityPublished("https://other.example")
  ], trafficSnapshot(false, true));
  assert.equal(crux.crux.state, "unavailable");
  assert.deepEqual(crux.crux.origin_metrics, { state: "unavailable" });
  assert.deepEqual(crux.crux.popularity, { state: "unavailable" });
  assert.equal("traffic_sources" in crux, false);
  assert.equal("traffic_attributions" in crux, false);

  const missingStoredTime = cruxPopularityPublished();
  missingStoredTime.fetchedAt = null;
  const missingTime = serializeTrafficEnrichment(
    [missingStoredTime],
    trafficSnapshot(false, true)
  );
  assert.deepEqual(missingTime.crux.popularity, { state: "unavailable" });
  assert.equal("traffic_sources" in missingTime, false);
});

test("malformed stored traffic fails closed without exposing payload or internal failure states", () => {
  const serialized = serializeTrafficEnrichment([{
    source: "dataforseo",
    state: "available",
    normalizedPayload: { rawBody: ["forbidden"] },
    providerCostUsd: 99
  }], trafficSnapshot(true, false));
  assert.deepEqual(serialized.dataforseo, { state: "unavailable" });
  assert.equal("traffic_sources" in serialized, false);
  assert.equal(JSON.stringify(serialized).includes("forbidden"), false);
  assert.equal(JSON.stringify(serialized).includes("providerCostUsd"), false);
});

test("v2 lead evidence round-trips while unversioned rows remain explicitly legacy", () => {
  const v2 = leadRecordToCreate("run_abcdefghijklmnop", "lead_v2", {
    shop_type: "eyewear",
    business_qualifier: "brand",
    pipeline_version: 2,
    scoring_version: 2,
    lead_score: 80,
    identity_confidence: 70,
    score_breakdown: {
      version: 2,
      components: {
        identity: 14,
        shopifyValidation: 20,
        categoryFit: 24,
        contactEvidence: 22
      },
      total: 80,
      semantics: "deterministic_evidence_rank_not_probability"
    },
    discovery_occurrences: [{ query: "frames", rank: 1 }],
    status: "qualified"
  });
  const serialized = serializeLead(v2);
  assert.equal(serialized.business_qualifier, "brand");
  assert.equal(serialized.scoring_version, 2);
  assert.equal(serialized.score_semantics, "evidence_rank_v2");
  assert.equal(serialized.score_breakdown.total, 80);
  assert.equal(serializeLead({ id: "legacy", status: "rejected" }).score_semantics, "legacy_v1");

  const rejected = leadRecordToCreate("run_abcdefghijklmnop", "lead_rejected", {
    original_shop_type: "Eyewear Brand",
    pipeline_version: 2,
    scoring_version: 2,
    lead_score: "",
    score_breakdown: null,
    status: "rejected"
  });
  assert.equal(serializeLead(rejected).score_semantics, "not_scored_v2");
  assert.equal(serializeLead(rejected).lead_score, null);
  assert.equal(serializeLead(rejected).score_breakdown, null);

  const failed = leadRecordToCreate("run_abcdefghijklmnop", "lead_failed", {
    pipeline_version: 2,
    scoring_version: 2,
    status: "failed"
  });
  assert.equal(serializeLead(failed).score_semantics, "not_scored_v2");
});

test("shared lead score-state fixtures agree with persistence and serialization", () => {
  const fixtures = JSON.parse(fs.readFileSync(
    new URL("../../contracts/lead-score-state-v2.fixtures.json", import.meta.url),
    "utf8"
  ));
  for (const fixture of fixtures.valid) {
    assert.doesNotThrow(
      () => assertPublicLeadScoreState(fixture.lead),
      fixture.name
    );
    const stored = fixture.lead.pipeline_version == null
      ? {
          id: `lead_${fixture.name}`,
          status: fixture.lead.status,
          pipelineVersion: null,
          scoringVersion: null,
          leadScore: fixture.lead.lead_score,
          scoreBreakdown: fixture.lead.score_breakdown
        }
      : leadRecordToCreate(
          "run_abcdefghijklmnop",
          `lead_${fixture.name}`,
          fixture.lead
        );
    assert.equal(serializeLead(stored).score_semantics, fixture.lead.score_semantics);
  }
  for (const fixture of fixtures.invalid) {
    assert.throws(
      () => assertPublicLeadScoreState(fixture.lead),
      LeadStateInvariantError,
      fixture.name
    );
  }
  assert.throws(() => assertPublicLeadScoreState({
    ...fixtures.valid[0].lead,
    lead_score: Number.POSITIVE_INFINITY
  }), LeadStateInvariantError);
  assert.throws(
    () => leadRecordToCreate("run_abcdefghijklmnop", "lead_new_legacy", {
      status: "rejected"
    }),
    (error) => error instanceof LeadStateInvariantError &&
      error.code === "new_persistence_requires_v2"
  );
});

test("structured logging redacts PostgreSQL credentials", () => {
  let written = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    written += chunk;
    return true;
  };
  try {
    log("database_error", {
      error: new Error(
        "Could not connect to postgresql://user:password@host.example/neondb"
      )
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.doesNotMatch(written, /user:password/u);
  assert.match(written, /credentials-redacted/u);
});
