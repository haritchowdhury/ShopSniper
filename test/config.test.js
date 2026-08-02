import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCruxConfig,
  assertDataForSeoConfig,
  loadConfig
} from "../src/config.js";

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("runtime config does not expose removed qualification thresholds", () => {
  const previousQualification = process.env.QUALIFICATION_THRESHOLD;
  const previousRelevance = process.env.MIN_RELEVANCE_SCORE;
  process.env.QUALIFICATION_THRESHOLD = "99";
  process.env.MIN_RELEVANCE_SCORE = "99";
  try {
    const config = loadConfig({ cwd: "/tmp/email-scraper-config-fixture" });
    assert.equal("qualificationThreshold" in config, false);
    assert.equal("minRelevanceScore" in config, false);
  } finally {
    if (previousQualification == null) delete process.env.QUALIFICATION_THRESHOLD;
    else process.env.QUALIFICATION_THRESHOLD = previousQualification;
    if (previousRelevance == null) delete process.env.MIN_RELEVANCE_SCORE;
    else process.env.MIN_RELEVANCE_SCORE = previousRelevance;
  }
});

test("DataForSEO enrichment is disabled by default and does not require credentials", () => {
  withEnvironment({
    ENABLE_DATAFORSEO_ENRICHMENT: null,
    DATAFORSEO_LOGIN: null,
    DATAFORSEO_PASSWORD: null
  }, () => {
    const config = loadConfig({ cwd: "/tmp/email-scraper-config-fixture" });
    assert.equal(config.dataForSeoEnrichmentEnabled, false);
    assert.equal(config.dataForSeoLogin, "");
    assert.equal(config.dataForSeoPassword, "");
    assert.doesNotThrow(() => assertDataForSeoConfig(config));
  });
});

test("DataForSEO uses strict booleans and enabled-only credential validation", () => {
  withEnvironment({
    ENABLE_DATAFORSEO_ENRICHMENT: "yes",
    DATAFORSEO_LOGIN: null,
    DATAFORSEO_PASSWORD: null
  }, () => {
    assert.throws(
      () => loadConfig({ cwd: "/tmp/email-scraper-config-fixture" }),
      /ENABLE_DATAFORSEO_ENRICHMENT must be true or false/u
    );
  });

  withEnvironment({
    ENABLE_DATAFORSEO_ENRICHMENT: "true",
    DATAFORSEO_LOGIN: "fixture-login",
    DATAFORSEO_PASSWORD: null
  }, () => {
    const config = loadConfig({ cwd: "/tmp/email-scraper-config-fixture" });
    assert.throws(
      () => assertDataForSeoConfig(config),
      /DATAFORSEO_PASSWORD/u
    );
  });

  withEnvironment({
    ENABLE_DATAFORSEO_ENRICHMENT: "TRUE",
    DATAFORSEO_LOGIN: "fixture-login",
    DATAFORSEO_PASSWORD: "fixture-password"
  }, () => {
    const config = loadConfig({ cwd: "/tmp/email-scraper-config-fixture" });
    assert.equal(config.dataForSeoEnrichmentEnabled, true);
    assert.doesNotThrow(() => assertDataForSeoConfig(config));
  });
});

test("CrUX enrichment is disabled by default with bounded safe defaults", () => {
  withEnvironment({
    ENABLE_CRUX_ENRICHMENT: null,
    CRUX_API_KEY: null,
    CRUX_BIGQUERY_PROJECT_ID: null,
    CRUX_BIGQUERY_LOCATION: null,
    CRUX_REST_CONCURRENCY: null,
    CRUX_REST_CACHE_FRESHNESS_MS: null,
    CRUX_BIGQUERY_MAX_BYTES_BILLED: null
  }, () => {
    const config = loadConfig({ cwd: "/tmp/email-scraper-config-fixture" });
    assert.equal(config.cruxEnrichmentEnabled, false);
    assert.equal(config.cruxApiKey, "");
    assert.equal(config.cruxBigQueryProjectId, "");
    assert.equal(config.cruxBigQueryLocation, "US");
    assert.equal(config.cruxRestConcurrency, 2);
    assert.equal(config.cruxRestCacheFreshnessMs, 86400000);
    assert.equal(config.cruxBigQueryMaxBytesBilled, 10000000000);
    assert.doesNotThrow(() => assertCruxConfig(config));
  });
});

test("CrUX uses strict flags and validates enabled-only settings", () => {
  withEnvironment({ ENABLE_CRUX_ENRICHMENT: "yes" }, () => {
    assert.throws(
      () => loadConfig({ cwd: "/tmp/email-scraper-config-fixture" }),
      /ENABLE_CRUX_ENRICHMENT must be true or false/u
    );
  });
  withEnvironment({
    ENABLE_CRUX_ENRICHMENT: "true",
    CRUX_API_KEY: "fixture-key",
    CRUX_BIGQUERY_PROJECT_ID: null
  }, () => {
    const config = loadConfig({ cwd: "/tmp/email-scraper-config-fixture" });
    assert.throws(() => assertCruxConfig(config), /CRUX_BIGQUERY_PROJECT_ID/u);
  });
  withEnvironment({
    ENABLE_CRUX_ENRICHMENT: "TRUE",
    CRUX_API_KEY: "fixture-key",
    CRUX_BIGQUERY_PROJECT_ID: "fixture-project",
    CRUX_BIGQUERY_LOCATION: "US"
  }, () => {
    const config = loadConfig({ cwd: "/tmp/email-scraper-config-fixture" });
    assert.doesNotThrow(() => assertCruxConfig(config));
  });
});

test("CrUX numeric safety settings reject out-of-range values", () => {
  withEnvironment({ CRUX_REST_CONCURRENCY: "11" }, () => {
    assert.throws(() => loadConfig({ cwd: "/tmp/email-scraper-config-fixture" }));
  });
  withEnvironment({ CRUX_BIGQUERY_MAX_BYTES_BILLED: "0" }, () => {
    assert.throws(() => loadConfig({ cwd: "/tmp/email-scraper-config-fixture" }));
  });
});
