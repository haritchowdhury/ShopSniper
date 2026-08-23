import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { PrismaRunRepository } from "../src/prisma-run-repository.js";
import { createInitialStatus } from "../src/status.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled =
  process.env.ALLOW_DATABASE_TESTS === "true" &&
  Boolean(process.env.TEST_DATABASE_URL);

function qualifiedLead() {
  return {
    shop_type: "clothing",
    store_name: "Integration Fixture",
    pipeline_version: 2,
    scoring_version: 2,
    lead_score: 88,
    score_breakdown: {
      version: 2,
      components: {
        identity: 16,
        shopifyValidation: 20,
        categoryFit: 30,
        contactEvidence: 22
      },
      total: 88,
      semantics: "deterministic_evidence_rank_not_probability"
    },
    status: "qualified",
    social_profiles: []
  };
}

test(
  "Prisma repository persists runs atomically on an explicit test database",
  { skip: !enabled },
  async () => {
    const schema = `repository_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    deployPrismaMigrations(scopedUrl);
    const prisma = createPrismaClient(scopedUrl);
    await assertMigrationStayedInSchema(prisma, schema);
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
          leads: [qualifiedLead()],
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
          leads: [qualifiedLead()],
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

function validationRows(count = 100) {
  return Array.from({ length: count }, (_, index) => ({
    id: `bulk_validation_query_${String(index).padStart(3, "0")}`,
    query: `validated query ${index}`,
    validationState: "valid",
    rejectionReason: null,
    ...(index === 0 ? {} : { probeSummary: { accepted: true, index } }),
    probeResults: [{ link: `https://fixture-${index}.example/products/result` }],
    probeContractVersion: "google-probe-v1",
    probeFingerprint: `fingerprint-${index}`,
    probedAt: new Date(Date.UTC(2026, 7, 22, 12, 0, index))
  }));
}

function acceptsBulkValidationSource(source) {
  const start = source.indexOf("  async saveQueryValidation(");
  const end = source.indexOf("\n  async returnRunToQueryReview(", start);
  const method = source.slice(start, end);
  return start >= 0 && end > start &&
    method.includes("jsonb_to_recordset") &&
    method.includes('UPDATE "RunQuery" AS query') &&
    method.includes("updatedIds.size !== normalized.length") &&
    method.includes("normalized.some(({ id }) => !updatedIds.has(id))") &&
    method.includes("{ maxWait: 5_000, timeout: 30_000 }") &&
    !method.includes("for (const row of rows)") &&
    !method.includes("transaction.runQuery.updateMany");
}

function replaceOnceInBulkValidationMethod(source, literal, replacement) {
  const start = source.indexOf("  async saveQueryValidation(");
  const end = source.indexOf("\n  async returnRunToQueryReview(", start);
  const method = source.slice(start, end);
  assert.ok(start >= 0 && end > start, "saveQueryValidation method boundaries must exist");
  assert.equal(method.split(literal).length - 1, 1,
    "saveQueryValidation must contain the mutation target exactly once");
  return source.slice(0, start) + method.replace(literal, replacement) + source.slice(end);
}

test("query validation bulk path has one scale transaction and rejects sequential/default-timeout controls", async () => {
  const source = readFileSync(new URL("../src/prisma-run-repository.js", import.meta.url), "utf8");
  assert.equal(acceptsBulkValidationSource(source), true);
  assert.equal(acceptsBulkValidationSource(source.replace(
    "updatedIds.size !== normalized.length",
    "false"
  )), false);
  assert.equal(acceptsBulkValidationSource(replaceOnceInBulkValidationMethod(source,
    "{ maxWait: 5_000, timeout: 30_000 }",
    "{}"
  )), false);

  let transactionOptions;
  const rawStatements = [];
  const fakeTransaction = {
    run: { updateMany: async () => ({ count: 1 }) },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join("?");
      rawStatements.push(sql);
      if (!sql.includes('UPDATE "RunQuery"')) return [];
      const payload = JSON.parse(values.find((value) =>
        typeof value === "string" && value.startsWith("[")));
      return payload.map(({ id }) => ({ id }));
    }
  };
  const repository = new PrismaRunRepository({
    $transaction: async (work, options) => {
      transactionOptions = options;
      return work(fakeTransaction);
    }
  });
  await repository.saveQueryValidation(
    "bulk_validation_run",
    { owner: "worker", token: "lease", expiresAt: new Date("2026-08-22T13:00:00.000Z") },
    validationRows(),
    new Date("2026-08-22T12:00:00.000Z")
  );
  assert.deepEqual(transactionOptions, { maxWait: 5_000, timeout: 30_000 });
  assert.equal(rawStatements.filter((sql) => sql.includes('UPDATE "RunQuery"')).length, 1);
});

test(
  "query validation persists 100 rows atomically with exact reconciliation and lease fencing",
  { skip: !enabled },
  async () => {
    const schema = `query_validation_${Date.now()}_${process.pid}`;
    const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
    deployPrismaMigrations(scopedUrl);
    const prisma = createPrismaClient(scopedUrl);
    await assertMigrationStayedInSchema(prisma, schema);
    const repository = new PrismaRunRepository(prisma);
    let run;

    try {
      run = await repository.createRun("bulk_validation_owner", [
        { originalShopType: "fixture", shopType: "fixture" }
      ]);
      const inputs = validationRows();
      await prisma.runQuery.createMany({
        data: inputs.map((row, sequence) => ({
          id: row.id,
          runId: run.id,
          categoryIndex: 0,
          sequence,
          query: `pending query ${sequence}`,
          source: "generated",
          validationState: "pending",
          probeSummary: sequence === 0 ? { retained: true } : null
        }))
      });
      const now = new Date();
      const claimed = await repository.claimNextQueuedRun("bulk_validation_worker", now);
      assert.equal(claimed.run.id, run.id);

      await repository.saveQueryValidation(
        run.id,
        claimed.lease,
        inputs,
        new Date(now.getTime() + 1)
      );
      const stored = await prisma.runQuery.findMany({
        where: { runId: run.id },
        orderBy: { sequence: "asc" }
      });
      assert.equal(stored.length, 100);
      assert.equal(stored.every((row) => row.validationState === "valid"), true);
      assert.deepEqual(stored[0].probeSummary, { retained: true });
      assert.deepEqual(stored[1].probeSummary, { accepted: true, index: 1 });
      assert.equal(stored[99].query, "validated query 99");
      assert.equal(stored[99].probeFingerprint, "fingerprint-99");

      await prisma.run.update({ where: { id: run.id }, data: { stage: "discovering_leads" } });
      const beforeMismatch = await prisma.runQuery.findMany({
        where: { runId: run.id }, orderBy: { sequence: "asc" }
      });
      const mismatched = inputs.map((row) => ({ ...row, query: `must roll back ${row.id}` }));
      mismatched[99] = { ...mismatched[99], id: "missing_query_id" };
      await assert.rejects(
        repository.saveQueryValidation(
          run.id,
          claimed.lease,
          mismatched,
          new Date(now.getTime() + 2)
        ),
        (error) => error?.code === "PIPELINE_INPUT_CONFLICT"
      );
      assert.deepEqual(await prisma.runQuery.findMany({
        where: { runId: run.id }, orderBy: { sequence: "asc" }
      }), beforeMismatch);
      assert.equal((await prisma.run.findUnique({ where: { id: run.id } })).stage, "discovering_leads");

      await assert.rejects(
        repository.saveQueryValidation(
          run.id,
          { ...claimed.lease, token: "stale_token" },
          inputs.map((row) => ({ ...row, query: "must not persist" })),
          new Date(now.getTime() + 3)
        ),
        (error) => error?.name === "RunLeaseLostError"
      );
      assert.deepEqual(await prisma.runQuery.findMany({
        where: { runId: run.id }, orderBy: { sequence: "asc" }
      }), beforeMismatch);
    } finally {
      if (run) await prisma.run.deleteMany({ where: { id: run.id } });
      await prisma.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const residual = await admin.$queryRawUnsafe(
        "SELECT schema_name::text FROM information_schema.schemata WHERE schema_name = $1",
        schema
      );
      assert.equal(residual.length, 0, "query-validation disposable schema must be absent");
      await admin.$disconnect();
    }
  }
);
