import assert from "node:assert/strict";
import test from "node:test";
import { PrismaRunRepository } from "../src/prisma-run-repository.js";

function fakePrisma() {
  let findArguments;
  const prisma = {
    lead: {
      count: async () => 0,
      findMany: async (arguments_) => {
        findArguments = arguments_;
        return [];
      }
    },
    $transaction: async (operations) => Promise.all(operations)
  };
  return { prisma, arguments: () => findArguments };
}

for (const [sortBy, modelField] of [
  ["lead_score", "leadScore"],
  ["store_name", "storeName"],
  ["shop_type", "shopType"],
  ["google_rank", "googleRank"]
]) {
  test(`repository maps the ${sortBy} sort to a fixed Prisma field`, async () => {
    const fake = fakePrisma();
    const repository = new PrismaRunRepository(fake.prisma);
    await repository.getResultsPage("run_abcdefghijklmnop", "user_alice", {
      page: 2,
      pageSize: 25,
      status: "qualified",
      search: "fashion",
      sortBy,
      sortDirection: "asc"
    });

    const query = fake.arguments();
    assert.equal(query.where.runId, "run_abcdefghijklmnop");
    assert.equal(query.where.run.ownerId, "user_alice");
    assert.equal(query.where.status, "qualified");
    assert.equal(query.where.OR.length, 5);
    assert.deepEqual(query.orderBy[0], {
      [modelField]: { sort: "asc", nulls: "last" }
    });
    assert.deepEqual(query.orderBy[1], { id: "asc" });
    assert.equal(query.skip, 25);
    assert.equal(query.take, 25);
  });
}

test("repository default ordering is deterministic with null scores last", async () => {
  const fake = fakePrisma();
  const repository = new PrismaRunRepository(fake.prisma);
  await repository.getResultsPage("run_abcdefghijklmnop", "user_alice", {
    page: 1,
    pageSize: 100,
    status: null,
    search: null,
    sortBy: null,
    sortDirection: "desc"
  });
  assert.deepEqual(fake.arguments().orderBy, [
    { leadScore: { sort: "desc", nulls: "last" } },
    { storeName: { sort: "asc", nulls: "last" } },
    { id: "asc" }
  ]);
});

test("restart recovery fails only running work and preserves queued runs", async () => {
  let updateArguments;
  const repository = new PrismaRunRepository({
    run: {
      updateMany: async (arguments_) => {
        updateArguments = arguments_;
        return { count: 1 };
      }
    }
  });

  await repository.recoverInterruptedRuns();
  assert.deepEqual(updateArguments.where, { state: "running" });
  assert.equal(updateArguments.data.state, "failed");
  assert.equal(updateArguments.data.safeErrorCode, "RUN_INTERRUPTED");
});
