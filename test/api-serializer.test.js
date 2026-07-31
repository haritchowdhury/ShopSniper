import assert from "node:assert/strict";
import test from "node:test";
import {
  leadRecordToCreate,
  serializeLead,
  serializeRun
} from "../src/api-serializer.js";
import { log } from "../src/logger.js";

test("lead serialization preserves snake_case types and normalizes blanks", () => {
  const stored = leadRecordToCreate("run_abcdefghijklmnop", "lead_fixture", {
    shop_type: "eyewear",
    query_score: "91",
    google_rank: "",
    social_profiles: ["https://instagram.com/example", 42],
    status: "qualified",
    email: " "
  });
  const serialized = serializeLead(stored);

  assert.equal(serialized.shop_type, "eyewear");
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
