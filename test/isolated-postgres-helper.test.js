import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeDisposableSchema,
  resolveDirectTestDatabaseUrl,
  scopedTestDatabaseUrl
} from "./helpers/isolated-postgres.js";

const testUrl = "postgresql://test:secret@ep-test-pooler.example.neon.tech/neondb?sslmode=require";
const productionUrl = "postgresql://prod:secret@ep-prod-pooler.example.neon.tech/neondb?sslmode=require";

test("isolated PostgreSQL helper derives a direct Neon URL and scopes it", () => {
  const direct = new URL(resolveDirectTestDatabaseUrl({
    testDatabaseUrl: testUrl,
    productionDatabaseUrl: productionUrl
  }));
  assert.equal(direct.hostname, "ep-test.example.neon.tech");
  assert.equal(direct.searchParams.get("schema"), null);
  const scoped = new URL(scopedTestDatabaseUrl("g9_fixture_1", {
    testDatabaseUrl: testUrl,
    productionDatabaseUrl: productionUrl
  }));
  assert.equal(scoped.hostname, "ep-test.example.neon.tech");
  assert.equal(scoped.searchParams.get("schema"), "g9_fixture_1");
  assert.equal(scoped.searchParams.get("options"), "-c search_path=g9_fixture_1");
});

test("isolated PostgreSQL helper rejects production, pooled direct, and unsafe schemas", () => {
  assert.throws(() => resolveDirectTestDatabaseUrl({
    testDatabaseUrl: testUrl,
    productionDatabaseUrl: testUrl
  }), /distinct/u);
  assert.throws(() => resolveDirectTestDatabaseUrl({
    testDatabaseUrl: testUrl,
    testDirectDatabaseUrl: testUrl,
    productionDatabaseUrl: productionUrl
  }), /TEST_DIRECT_DATABASE_URL/u);
  assert.throws(() => assertSafeDisposableSchema("public"), /never target public/u);
  assert.throws(() => assertSafeDisposableSchema("bad-name"), /unsafe/u);
});
