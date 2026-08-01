import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { serializeLead } from "../src/api-serializer.js";
import { createPrismaClient } from "../src/prisma-client.js";
import { PrismaRunRepository } from "../src/prisma-run-repository.js";

const enabled =
  process.env.ALLOW_DATABASE_TESTS === "true" &&
  Boolean(process.env.TEST_DATABASE_URL);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function scopedDatabaseUrl(connectionString, schema) {
  const url = new URL(connectionString);
  url.searchParams.set("schema", schema);
  return url.toString();
}

function deploy(databaseUrl, configPath) {
  const result = spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", "--config", configPath],
    {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: "" },
      encoding: "utf8"
    }
  );
  assert.equal(
    result.status,
    0,
    `migration deploy failed: ${result.stderr || result.stdout}`
  );
}

async function baselineMigrationConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "email-scraper-gr4-"));
  const migrationRoot = path.join(directory, "migrations");
  await fs.mkdir(migrationRoot);
  await fs.copyFile(
    path.join(projectRoot, "prisma", "schema.prisma"),
    path.join(directory, "schema.prisma")
  );
  await fs.copyFile(
    path.join(projectRoot, "prisma", "migrations", "migration_lock.toml"),
    path.join(migrationRoot, "migration_lock.toml")
  );
  for (const name of [
    "20260731000000_init",
    "20260731150000_auth_run_ownership",
    "20260731230000_g3_pipeline_quality"
  ]) {
    await fs.cp(
      path.join(projectRoot, "prisma", "migrations", name),
      path.join(migrationRoot, name),
      { recursive: true }
    );
  }
  const configPath = path.join(directory, "prisma.config.ts");
  await fs.writeFile(
    configPath,
    `import { defineConfig } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, "node_modules", "prisma", "config.js")).href)};\nexport default defineConfig({ schema: ${JSON.stringify(path.join(directory, "schema.prisma"))}, migrations: { path: ${JSON.stringify(migrationRoot)} }, datasource: { url: process.env.DATABASE_URL } });\n`,
    "utf8"
  );
  return { directory, configPath };
}

function failureClient(prisma, stage) {
  return {
    $transaction: (callback) => prisma.$transaction(async (transaction) => {
      const wrap = (modelName, methodName) => async (...arguments_) => {
        const result = await transaction[modelName][methodName](...arguments_);
        if (`${modelName}.${methodName}` === stage) {
          throw new Error(`injected failure after ${stage}`);
        }
        return result;
      };
      return callback({
        run: {
          updateMany: wrap("run", "updateMany"),
          findUnique: (...arguments_) => transaction.run.findUnique(...arguments_)
        },
        lead: {
          deleteMany: wrap("lead", "deleteMany"),
          createMany: wrap("lead", "createMany")
        },
        queryAudit: {
          deleteMany: wrap("queryAudit", "deleteMany"),
          createMany: wrap("queryAudit", "createMany")
        },
        runDiagnostic: {
          deleteMany: wrap("runDiagnostic", "deleteMany"),
          createMany: wrap("runDiagnostic", "createMany")
        }
      });
    })
  };
}

test(
  "G-R4 upgrades and replays safely with preservation, float, rollback, and terminal proof",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const schema = `gr4_${Date.now()}_${process.pid}`;
    const base = createPrismaClient(process.env.TEST_DATABASE_URL);
    const scopedUrl = scopedDatabaseUrl(process.env.TEST_DATABASE_URL, schema);
    const baseline = await baselineMigrationConfig();
    let prisma;
    try {
      await base.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      deploy(scopedUrl, baseline.configPath);
      prisma = createPrismaClient(scopedUrl);

      await prisma.$executeRawUnsafe(`
        INSERT INTO "Run" ("id", "ownerId", "state", "stage", "normalizedShopTypes", "progress", "resultsAvailable", "pipelineVersion", "scoringVersion")
        VALUES
          ('legacy_gr4_fixture', 'legacy_owner', 'completed', 'completed', '[]'::jsonb, '{}'::jsonb, true, NULL, NULL),
          ('pre_gr4_fixture', 'v2_owner', 'completed', 'completed', '[{"shopType":"eyewear"}]'::jsonb, '{}'::jsonb, true, 2, 2)
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "Lead" ("id", "runId", "shopType", "queryScore", "status", "pipelineVersion", "scoringVersion")
        VALUES
          ('legacy_gr4_lead', 'legacy_gr4_fixture', 'clothing', 82, 'qualified', NULL, NULL),
          ('pre_gr4_lead', 'pre_gr4_fixture', 'eyewear', NULL, 'rejected', 2, NULL)
      `);
      const before = await prisma.$queryRawUnsafe(`
        SELECT (SELECT COUNT(*)::int FROM "Run") AS runs,
               (SELECT COUNT(*)::int FROM "Lead") AS leads
      `);
      await prisma.$disconnect();
      prisma = undefined;

      deploy(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      deploy(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prisma = createPrismaClient(scopedUrl);

      const migratedColumns = await base.$queryRawUnsafe(`
        SELECT "table_name"::text AS table_name, "column_name"::text AS column_name
        FROM information_schema.columns
        WHERE "table_schema" = '${schema}'
          AND (("table_name" = 'Lead' AND "column_name" IN ('originalShopType', 'queryScore'))
            OR ("table_name" = 'Run' AND "column_name" = 'resultFingerprint'))
        ORDER BY "table_name", "column_name"
      `);
      assert.deepEqual(migratedColumns, [
        { table_name: "Lead", column_name: "originalShopType" },
        { table_name: "Lead", column_name: "queryScore" },
        { table_name: "Run", column_name: "resultFingerprint" }
      ]);

      const after = await prisma.$queryRawUnsafe(`
        SELECT (SELECT COUNT(*)::int FROM "Run") AS runs,
               (SELECT COUNT(*)::int FROM "Lead") AS leads
      `);
      assert.deepEqual(after, before);
      const preserved = await prisma.lead.findUnique({
        where: { id: "legacy_gr4_lead" },
        select: {
          id: true,
          queryScore: true,
          originalShopType: true,
          pipelineVersion: true,
          scoringVersion: true,
          leadScore: true,
          status: true
        }
      });
      assert.equal(preserved.queryScore, 82);
      assert.equal(preserved.originalShopType, null);
      assert.equal(serializeLead(preserved).score_semantics, "legacy_v1");
      const preservedV2 = await prisma.lead.findUnique({
        where: { id: "pre_gr4_lead" },
        select: {
          id: true,
          queryScore: true,
          originalShopType: true,
          pipelineVersion: true,
          scoringVersion: true,
          leadScore: true,
          status: true
        }
      });
      assert.equal(serializeLead(preservedV2).score_semantics, "not_scored_v2");

      const repository = new PrismaRunRepository(prisma);
      const floatRun = await repository.createRun("float_owner", [{
        originalShopType: "Eyewear Brand",
        shopType: "eyewear",
        businessQualifier: "brand"
      }]);
      await repository.claimNextQueuedRun();
      const scores = [82.29, 82.0, 0, 100];
      await repository.saveCompletedResults(floatRun.id, {
        leads: scores.map((queryScore, index) => ({
          original_shop_type: "Eyewear Brand",
          shop_type: "eyewear",
          resolved_domain: `float-${index}.example`,
          query_score: queryScore,
          pipeline_version: 2,
          scoring_version: 2,
          lead_score: 80,
          status: "qualified"
        })),
        summary: { total: 4, qualified: 4, rejected: 0, failed: 0 }
      });
      const floats = await prisma.lead.findMany({
        where: { runId: floatRun.id },
        orderBy: { resolvedDomain: "asc" }
      });
      assert.deepEqual(floats.map(({ queryScore }) => queryScore), scores);
      assert.ok(floats.every(({ originalShopType }) => originalShopType === "Eyewear Brand"));

      const rollbackRun = await repository.createRun("rollback_owner", [{
        originalShopType: "Clothing",
        shopType: "clothing"
      }]);
      await repository.claimNextQueuedRun();
      await prisma.lead.create({ data: {
        id: "rollback_sentinel_lead",
        runId: rollbackRun.id,
        status: "rejected"
      } });
      await prisma.queryAudit.create({ data: {
        id: "rollback_sentinel_audit",
        runId: rollbackRun.id,
        sequence: 0,
        status: "sentinel",
        details: {}
      } });
      await prisma.runDiagnostic.create({ data: {
        id: "rollback_sentinel_diag",
        runId: rollbackRun.id,
        sequence: 0,
        scope: "run",
        code: "sentinel",
        details: {}
      } });
      const replacement = {
        leads: [{ resolved_domain: "replacement.example", status: "qualified" }],
        queryAudits: [{ query: "replacement", status: "selected" }],
        diagnostics: [{ scope: "run", code: "replacement", details: {} }],
        summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
      };
      for (const stage of [
        "run.updateMany",
        "lead.deleteMany",
        "lead.createMany",
        "queryAudit.createMany",
        "runDiagnostic.createMany"
      ]) {
        const failing = new PrismaRunRepository(failureClient(prisma, stage));
        await assert.rejects(
          failing.saveCompletedResults(rollbackRun.id, replacement),
          new RegExp(`injected failure after ${stage.replace(".", "\\.")}`, "u")
        );
        assert.equal((await prisma.run.findUnique({ where: { id: rollbackRun.id } })).state, "running");
        assert.equal(await prisma.lead.count({ where: { id: "rollback_sentinel_lead" } }), 1);
        assert.equal(await prisma.queryAudit.count({ where: { id: "rollback_sentinel_audit" } }), 1);
        assert.equal(await prisma.runDiagnostic.count({ where: { id: "rollback_sentinel_diag" } }), 1);
      }

      await repository.saveCompletedResults(rollbackRun.id, replacement);
      await repository.saveCompletedResults(rollbackRun.id, replacement);
      await assert.rejects(
        repository.saveCompletedResults(rollbackRun.id, {
          ...replacement,
          summary: { total: 1, qualified: 0, rejected: 1, failed: 0 }
        }),
        /different terminal result/u
      );
      assert.equal((await repository.getResultsPage(rollbackRun.id, "foreign_owner", {
        page: 1, pageSize: 20, status: null, search: null, sortBy: null, sortDirection: "desc"
      })).totalItems, 0);

      console.log(JSON.stringify({
        event: "gr4_database_evidence",
        before: before[0],
        after: after[0],
        fractionalScore: floats[0].queryScore,
        migrationReplay: "passed",
        rollbackStages: 5
      }));
    } finally {
      if (prisma) await prisma.$disconnect().catch(() => {});
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await base.$disconnect().catch(() => {});
      await fs.rm(baseline.directory, { recursive: true, force: true });
    }
  }
);
