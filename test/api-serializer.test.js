import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  leadTrafficEnrichmentRecordToCreate,
  leadRecordToCreate,
  serializeLead,
  serializeRun,
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
  ), /does not match/u);
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
