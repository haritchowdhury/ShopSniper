import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

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
