import assert from "node:assert/strict";
import test from "node:test";
import { ActiveRunError } from "../src/api-errors.js";
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
    const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);
    const repository = new PrismaRunRepository(prisma);
    const createdIds = [];

    try {
      await repository.recoverInterruptedRuns();
      const first = await repository.createRun([
        { originalShopType: "clothing", shopType: "clothing" }
      ]);
      createdIds.push(first.id);
      await assert.rejects(
        repository.createRun([
          { originalShopType: "eyewear", shopType: "eyewear" }
        ]),
        ActiveRunError
      );

      const status = {
        ...createInitialStatus(),
        stage: "writing_results",
        queriesTotal: 1,
        queriesProcessed: 1,
        outputRows: 1
      };
      await repository.markRunning(first.id);
      await repository.updateProgress(first.id, status);
      await repository.saveCompletedResults(
        first.id,
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
          summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
        },
        status
      );

      const stored = await repository.getRun(first.id);
      assert.equal(stored.state, "completed");
      assert.equal(stored.resultsAvailable, true);

      await repository.saveCompletedResults(
        first.id,
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
          summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
        },
        status
      );
      const page = await repository.getResultsPage(first.id, {
        page: 1,
        pageSize: 100,
        status: "qualified",
        search: "fixture",
        sortBy: "lead_score",
        sortDirection: "desc"
      });
      assert.equal(page.totalItems, 1);
      assert.equal(page.items[0].storeName, "Integration Fixture");
    } finally {
      if (createdIds.length) {
        await prisma.run.deleteMany({ where: { id: { in: createdIds } } });
      }
      await prisma.$disconnect();
    }
  }
);
