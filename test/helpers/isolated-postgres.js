import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../../src/prisma-client.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const SAFE_SCHEMA = /^[a-z][a-z0-9_]{0,62}$/u;

function withoutSchema(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete("schema");
  return url;
}

function databaseIdentity(connectionString) {
  const url = withoutSchema(connectionString);
  return `${url.protocol}//${url.hostname}:${url.port}/${url.pathname.replace(/^\//u, "")}`;
}

export function assertSafeDisposableSchema(schema) {
  assert.match(schema, SAFE_SCHEMA, "disposable PostgreSQL schema name is unsafe");
  assert.notEqual(schema, "public", "integration tests must never target public");
}

export function resolveDirectTestDatabaseUrl({
  testDatabaseUrl = process.env.TEST_DATABASE_URL,
  testDirectDatabaseUrl = process.env.TEST_DIRECT_DATABASE_URL,
  productionDatabaseUrl = process.env.DATABASE_URL
} = {}) {
  assert.ok(testDatabaseUrl, "TEST_DATABASE_URL is required");
  if (productionDatabaseUrl) {
    assert.notEqual(
      databaseIdentity(testDatabaseUrl),
      databaseIdentity(productionDatabaseUrl),
      "TEST_DATABASE_URL must identify a database distinct from DATABASE_URL"
    );
  }

  const direct = withoutSchema(testDirectDatabaseUrl || testDatabaseUrl);
  if (direct.hostname.includes("-pooler.")) {
    assert.ok(
      !testDirectDatabaseUrl && direct.hostname.endsWith(".neon.tech"),
      "Prisma Migrate requires TEST_DIRECT_DATABASE_URL when the test pooler is not Neon"
    );
    direct.hostname = direct.hostname.replace("-pooler.", ".");
  }
  assert.ok(
    !direct.hostname.includes("-pooler."),
    "Prisma Migrate must not use a pooled PostgreSQL endpoint"
  );
  return direct.toString();
}

export function scopedTestDatabaseUrl(schema, options) {
  assertSafeDisposableSchema(schema);
  const url = new URL(resolveDirectTestDatabaseUrl(options));
  url.searchParams.set("schema", schema);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

export async function createIsolatedTestSchema(schema, options) {
  assertSafeDisposableSchema(schema);
  const adminUrl = resolveDirectTestDatabaseUrl(options);
  const scopedUrl = scopedTestDatabaseUrl(schema, options);
  const admin = createPrismaClient(adminUrl);
  let probe;
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    probe = createPrismaClient(scopedUrl);
    const [row] = await probe.$queryRawUnsafe(
      "SELECT current_schema()::text AS schema"
    );
    assert.equal(
      row?.schema,
      schema,
      "schema-scoped direct connection did not select its disposable schema"
    );
    await probe.$disconnect();
    return { admin, scopedUrl };
  } catch (error) {
    await probe?.$disconnect().catch(() => {});
    await admin
      .$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => {});
    await admin.$disconnect().catch(() => {});
    throw error;
  }
}

export function deployPrismaMigrations(
  databaseUrl,
  configPath = "prisma.config.ts"
) {
  const parsed = new URL(databaseUrl);
  const schema = parsed.searchParams.get("schema");
  assertSafeDisposableSchema(schema);
  assert.ok(
    !parsed.hostname.includes("-pooler."),
    "Prisma Migrate must use the direct test endpoint"
  );
  const result = spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", "--config", configPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DIRECT_URL: databaseUrl,
        PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1"
      },
      encoding: "utf8"
    }
  );
  assert.equal(
    result.status,
    0,
    `migration deploy failed inside disposable schema: ${result.stderr || result.stdout}`
  );
}

export async function assertMigrationStayedInSchema(prisma, schema) {
  assertSafeDisposableSchema(schema);
  const [row] = await prisma.$queryRawUnsafe(`
    SELECT current_schema()::text AS schema,
           EXISTS (
             SELECT 1
             FROM pg_class AS class
             JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
             WHERE namespace.nspname = '${schema}'
               AND class.relname = '_prisma_migrations'
           ) AS migrations_present
  `);
  assert.equal(row?.schema, schema);
  assert.equal(row?.migrations_present, true);
}
