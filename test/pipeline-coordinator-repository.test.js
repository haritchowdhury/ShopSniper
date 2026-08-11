import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";

const migrationUrl = new URL("../prisma/migrations/20260811120000_aws_pipeline_coordinator/migration.sql", import.meta.url);

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

test("coordinator exports every locked method and rejects non-exact lease bounds before I/O", async () => {
  const prisma = { $transaction: async () => assert.fail("transaction must not start") };
  const repository = new PipelineCoordinatorRepository(prisma);
  for (const name of ["registerStage", "recordDispatch", "claimTask", "renewTask", "recordTerminal",
    "claimAggregator", "renewAggregator", "getCompleteStage", "completeAggregator", "listRecoverable",
    "cancelRunGeneration"]) assert.equal(typeof repository[name], "function", name);

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
