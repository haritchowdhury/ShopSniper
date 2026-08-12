import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { PipelineCoordinatorRepository, assertCompleteAggregatorInTransaction,
  completeAggregatorInTransaction, registerStageInTransaction
} from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";

const migrationUrl = new URL("../prisma/migrations/20260811120000_aws_pipeline_coordinator/migration.sql", import.meta.url);
const remainderMigrationUrl = new URL("../prisma/migrations/20260812120000_aws_pipeline_remainder_foundations/migration.sql", import.meta.url);
const schemaUrl = new URL("../prisma/schema.prisma", import.meta.url);

test("G5 migration is additive and contains the exact coordinator constraints", async () => {
  const sql = await fs.readFile(migrationUrl, "utf8");
  for (const enumName of ["RunExecutionBackend", "PipelineStageName", "PipelineStageState", "PipelineTaskState"])
    assert.match(sql, new RegExp(`CREATE TYPE "${enumName}" AS ENUM`, "u"));
  assert.match(sql, /ADD COLUMN "executionBackend" "RunExecutionBackend" NOT NULL DEFAULT 'local'/u);
  assert.match(sql, /ADD COLUMN "pipelineGeneration" INTEGER NOT NULL DEFAULT 1/u);
  assert.match(sql, /ALTER TABLE "DataForSeoRequestLedger"[\s\S]*ADD COLUMN "resultFingerprint" TEXT/u);
  assert.match(sql, /CREATE TABLE "PipelineStage"/u);
  assert.match(sql, /CREATE TABLE "PipelineTask"/u);
  assert.match(sql, /"terminalCount" = "succeededCount" \+ "skippedCount" \+ "failedCount" \+ "cancelledCount"/u);
  assert.match(sql, /"terminalCount" <= "expectedCount"/u);
  assert.doesNotMatch(sql, /^\s*(?:DELETE|TRUNCATE|DROP TABLE|DROP TYPE)\b/imu);
});

test("G-R3 schema and migration add only the reconstructable coordinator foundations", async () => {
  const [schema, sql] = await Promise.all([
    fs.readFile(schemaUrl, "utf8"), fs.readFile(remainderMigrationUrl, "utf8")
  ]);
  assert.match(schema, /awsProviderConfig\s+Json\?/u);
  assert.match(schema, /manifestProducedAt\s+DateTime/u);
  assert.match(schema, /processingPipelineTaskId\s+String\?/u);
  assert.match(schema, /@@index\(\[processingPipelineTaskId\]\)/u);
  assert.match(sql, /ADD COLUMN "awsProviderConfig" JSONB/u);
  assert.match(sql, /ADD COLUMN "manifestProducedAt" TIMESTAMP\(3\)/u);
  assert.ok(sql.indexOf('ADD COLUMN "manifestProducedAt"') < sql.indexOf('SET "manifestProducedAt" = "createdAt"'));
  assert.ok(sql.indexOf('SET "manifestProducedAt" = "createdAt"') < sql.indexOf('ALTER COLUMN "manifestProducedAt" SET NOT NULL'));
  assert.match(sql, /ADD COLUMN "processingPipelineTaskId" TEXT/u);
  assert.match(sql, /CREATE INDEX "ShopWork_processingPipelineTaskId_idx"/u);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX "ShopWork_processingPipelineTaskId/u);
  assert.doesNotMatch(sql, /^\s*(?:DELETE|TRUNCATE|DROP|ALTER TYPE)\b/imu);
});

test("coordinator exports every locked method and rejects non-exact lease bounds before I/O", async () => {
  const prisma = { $transaction: async () => assert.fail("transaction must not start") };
  const repository = new PipelineCoordinatorRepository(prisma);
  for (const name of ["registerStage", "recordDispatch", "claimTask", "renewTask", "recordTerminal",
    "claimAggregator", "renewAggregator", "getCompleteStage", "completeAggregator", "listRecoverable",
    "cancelRunGeneration"]) assert.equal(typeof repository[name], "function", name);
  for (const primitive of [registerStageInTransaction, assertCompleteAggregatorInTransaction,
    completeAggregatorInTransaction]) assert.equal(typeof primitive, "function");

  await assert.rejects(repository.registerStage({ manifestS3Key: "key", manifestFingerprint: "a".repeat(64),
    tasks: [], manifestProducedAt: "2026-08-12T00:00:00.000Z" }, new Date()),
  (error) => error.code === "PIPELINE_INPUT_CONFLICT");

  await assert.rejects(repository.claimTask({ leaseDurationMs: 59_999 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  await assert.rejects(repository.renewTask({ leaseDurationMs: 60_001 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  await assert.rejects(repository.claimAggregator({ leaseDurationMs: 119_999 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  await assert.rejects(repository.renewAggregator({ leaseDurationMs: 120_001 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  await assert.rejects(repository.listRecoverable({ olderThan: new Date(), limit: 101 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
});
