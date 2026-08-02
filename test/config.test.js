import assert from "node:assert/strict";
import test from "node:test";
import { assertDataForSeoConfig, loadConfig } from "../src/config.js";

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
