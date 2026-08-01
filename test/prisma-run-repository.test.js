import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

test("completion writes leads, audits, diagnostics, and publication in one transaction", async () => {
  const calls = [];
  const model = (name) => ({
    deleteMany: async () => calls.push(`${name}.deleteMany`),
    createMany: async () => calls.push(`${name}.createMany`)
  });
  const transaction = {
    lead: model("lead"),
    queryAudit: model("queryAudit"),
    runDiagnostic: model("runDiagnostic"),
    run: {
      updateMany: async () => { calls.push("run.updateMany"); return { count: 1 }; },
      findUnique: async () => { calls.push("run.findUnique"); return { resultsAvailable: true, pipelineVersion: 2 }; }
    }
  };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback(transaction)
  });
  const result = await repository.saveCompletedResults("run_abcdefghijklmnop", {
    leads: [{ resolved_domain: "fixture.example", status: "qualified", lead_score: 80 }],
    queryAudits: [{ query: "fixture", status: "selected" }],
    diagnostics: [{ scope: "query", code: "fixture", details: {} }],
    summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
  });
  assert.deepEqual(calls, [
    "run.updateMany",
    "lead.deleteMany", "queryAudit.deleteMany", "runDiagnostic.deleteMany",
    "lead.createMany", "queryAudit.createMany", "runDiagnostic.createMany", "run.findUnique"
  ]);
  assert.equal(result.resultsAvailable, true);
  assert.equal(result.pipelineVersion, 2);
});

test("owner scope is applied to audit and diagnostic repository reads", async () => {
  const seen = [];
  const pageable = (name) => ({
    count: async ({ where }) => { seen.push([name, where]); return 0; },
    findMany: async () => []
  });
  const repository = new PrismaRunRepository({
    queryAudit: pageable("audit"),
    runDiagnostic: pageable("diagnostic"),
    $transaction: async (operations) => Promise.all(operations)
  });
  await repository.getQueryAuditsPage("run_abcdefghijklmnop", "user_alice", { page: 1, pageSize: 20 });
  await repository.getDiagnosticsPage("run_abcdefghijklmnop", "user_alice", { page: 1, pageSize: 20 });
  for (const [, where] of seen) assert.deepEqual(where.run, { ownerId: "user_alice" });
});

test("a child-write failure occurs after the conditional publication gate", async () => {
  let published = false;
  const noOp = { deleteMany: async () => {}, createMany: async () => {} };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      lead: noOp,
      queryAudit: noOp,
      runDiagnostic: {
        deleteMany: async () => {},
        createMany: async () => { throw new Error("injected durable write failure"); }
      },
      run: {
        updateMany: async () => { published = true; return { count: 1 }; },
        findUnique: async () => ({ state: "completed" })
      }
    })
  });
  await assert.rejects(repository.saveCompletedResults("run_abcdefghijklmnop", {
    leads: [{ resolved_domain: "fixture.example", status: "qualified" }],
    queryAudits: [{ query: "fixture", status: "selected" }],
    diagnostics: [{ scope: "query", code: "fixture", details: {} }],
    summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
  }), /injected durable write failure/u);
  assert.equal(published, true);
});

test("completion replay is idempotent only for the same durable payload", async () => {
  let fingerprint;
  const transaction = {
    lead: { deleteMany: async () => {}, createMany: async () => {} },
    queryAudit: { deleteMany: async () => {}, createMany: async () => {} },
    runDiagnostic: { deleteMany: async () => {}, createMany: async () => {} },
    run: {
      updateMany: async ({ data }) => {
        if (fingerprint) return { count: 0 };
        fingerprint = data.resultFingerprint;
        return { count: 1 };
      },
      findUnique: async () => ({ state: "completed", resultFingerprint: fingerprint })
    }
  };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback(transaction)
  });
  const payload = {
    leads: [{ resolved_domain: "fixture.example", status: "qualified" }],
    summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
  };
  await repository.saveCompletedResults("run_abcdefghijklmnop", payload);
  await repository.saveCompletedResults("run_abcdefghijklmnop", payload);
  await assert.rejects(
    repository.saveCompletedResults("run_abcdefghijklmnop", {
      ...payload,
      summary: { total: 1, qualified: 0, rejected: 1, failed: 0 }
    }),
    /different terminal result/u
  );
});

test("G3 migration is additive and contains no historical-row rewrite", async () => {
  const url = new URL(
    "../prisma/migrations/20260731230000_g3_pipeline_quality/migration.sql",
    import.meta.url
  );
  const sql = await fs.readFile(url, "utf8");
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|DROP TABLE)\b/imu);
  assert.match(sql, /ADD COLUMN "pipelineVersion" INTEGER/u);
  assert.match(sql, /CREATE TABLE "QueryAudit"/u);
  assert.match(sql, /CREATE TABLE "RunDiagnostic"/u);
});

test("G-R4 migration preserves rows while widening query scores and adding provenance", async () => {
  const url = new URL(
    "../prisma/migrations/20260801000000_gr4_durable_v2/migration.sql",
    import.meta.url
  );
  const sql = await fs.readFile(url, "utf8");
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|DROP TABLE)\b/imu);
  assert.match(sql, /"queryScore" TYPE DOUBLE PRECISION/u);
  assert.match(sql, /ADD COLUMN "originalShopType" TEXT/u);
  assert.match(sql, /ADD COLUMN "resultFingerprint" TEXT/u);
});
