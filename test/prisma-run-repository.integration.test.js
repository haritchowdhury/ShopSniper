import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../src/prisma-client.js";
import { PrismaRunRepository } from "../src/prisma-run-repository.js";
import { createInitialStatus } from "../src/status.js";

const enabled =
  process.env.ALLOW_DATABASE_TESTS === "true" &&
  Boolean(process.env.TEST_DATABASE_URL);

test(
  "Prisma repository persists runs atomically on an explicit test database",
  { skip: !enabled },
  async () => {
    const projectRoot = fileURLToPath(new URL("..", import.meta.url));
    const schema = `repository_${Date.now()}_${process.pid}`;
    const scopedUrl = new URL(process.env.TEST_DATABASE_URL);
    scopedUrl.searchParams.set("schema", schema);
    const base = createPrismaClient(process.env.TEST_DATABASE_URL);
    await base.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const migration = spawnSync(
      "npx",
      ["prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          DATABASE_URL: scopedUrl.toString(),
          DIRECT_URL: "",
          PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1"
        },
        encoding: "utf8"
      }
    );
    if (migration.status !== 0) {
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
    assert.equal(migration.status, 0, `test database migration failed: ${migration.stderr || migration.stdout}`);
    const prisma = createPrismaClient(scopedUrl.toString());
    const repository = new PrismaRunRepository(prisma);
    const createdIds = [];

    try {
      await repository.recoverExpiredRuns();
      const first = await repository.createRun("integration_user", [
        { originalShopType: "clothing", shopType: "clothing" }
      ]);
      createdIds.push(first.id);
      const second = await repository.createRun("integration_user", [
        { originalShopType: "eyewear", shopType: "eyewear" }
      ]);
      createdIds.push(second.id);

      const status = {
        ...createInitialStatus(),
        stage: "writing_results",
        queriesTotal: 1,
        queriesProcessed: 1,
        outputRows: 1
      };
      const claimed = await repository.claimNextQueuedRun("integration_worker");
      assert.equal(claimed.run.id, first.id);
      await repository.updateProgress(first.id, claimed.lease, status);
      await repository.saveCompletedResults(
        first.id,
        claimed.lease,
        {
          leads: [
            {
              shop_type: "clothing",
              store_name: "Integration Fixture",
              lead_score: 88,
              status: "qualified",
              social_profiles: []
            }
          ],
          queryAudits: [{ query: "fixture query", status: "selected" }],
          diagnostics: [{ scope: "query", code: "fixture_warning", details: {} }],
          summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
        },
        status
      );

      const stored = await repository.getRun(first.id, "integration_user");
      assert.equal(stored.state, "completed");
      assert.equal(stored.resultsAvailable, true);
      assert.equal(stored.pipelineVersion, 2);

      await repository.saveCompletedResults(
        first.id,
        claimed.lease,
        {
          leads: [
            {
              shop_type: "clothing",
              store_name: "Integration Fixture",
              lead_score: 88,
              status: "qualified",
              social_profiles: []
            }
          ],
          queryAudits: [{ query: "fixture query", status: "selected" }],
          diagnostics: [{ scope: "query", code: "fixture_warning", details: {} }],
          summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
        },
        status
      );
      const page = await repository.getResultsPage(first.id, "integration_user", {
        page: 1,
        pageSize: 100,
        status: "qualified",
        search: "fixture",
        sortBy: "lead_score",
        sortDirection: "desc"
      });
      assert.equal(page.totalItems, 1);
      assert.equal(page.items[0].storeName, "Integration Fixture");
      const audits = await repository.getQueryAuditsPage(first.id, "integration_user", {
        page: 1, pageSize: 20
      });
      const diagnostics = await repository.getDiagnosticsPage(first.id, "integration_user", {
        page: 1, pageSize: 20
      });
      assert.equal(audits.totalItems, 1);
      assert.equal(diagnostics.totalItems, 1);
    } finally {
      if (createdIds.length) {
        await prisma.run.deleteMany({ where: { id: { in: createdIds } } });
      }
      await prisma.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  }
);
