-- Additive Neon coordination state for the Lambda/SQS/S3 pipeline.
CREATE TYPE "RunExecutionBackend" AS ENUM ('local', 'aws');
CREATE TYPE "PipelineStageName" AS ENUM ('discovery', 'lead', 'traffic_crux');
CREATE TYPE "PipelineStageState" AS ENUM ('collecting', 'ready', 'aggregating', 'completed', 'failed', 'cancelled');
CREATE TYPE "PipelineTaskState" AS ENUM ('pending', 'processing', 'succeeded', 'skipped', 'failed', 'cancelled');

ALTER TABLE "Run"
ADD COLUMN "executionBackend" "RunExecutionBackend" NOT NULL DEFAULT 'local',
ADD COLUMN "pipelineGeneration" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "DataForSeoRequestLedger"
ADD COLUMN "resultFingerprint" TEXT;

CREATE TABLE "PipelineStage" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "stage" "PipelineStageName" NOT NULL,
  "generation" INTEGER NOT NULL,
  "manifestS3Key" TEXT NOT NULL,
  "manifestFingerprint" TEXT NOT NULL,
  "expectedCount" INTEGER NOT NULL,
  "terminalCount" INTEGER NOT NULL DEFAULT 0,
  "succeededCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "cancelledCount" INTEGER NOT NULL DEFAULT 0,
  "state" "PipelineStageState" NOT NULL DEFAULT 'collecting',
  "version" INTEGER NOT NULL DEFAULT 1,
  "aggregationOwner" TEXT,
  "aggregationLeaseToken" TEXT,
  "aggregationLeaseAcquiredAt" TIMESTAMP(3),
  "aggregationLeaseExpiresAt" TIMESTAMP(3),
  "aggregationAttempt" INTEGER NOT NULL DEFAULT 0,
  "safeErrorCode" TEXT,
  "safeErrorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PipelineStage_counts_nonnegative_check" CHECK (
    "expectedCount" >= 0 AND "terminalCount" >= 0 AND
    "succeededCount" >= 0 AND "skippedCount" >= 0 AND
    "failedCount" >= 0 AND "cancelledCount" >= 0
  ),
  CONSTRAINT "PipelineStage_terminal_sum_check" CHECK (
    "terminalCount" = "succeededCount" + "skippedCount" + "failedCount" + "cancelledCount"
  ),
  CONSTRAINT "PipelineStage_terminal_expected_check" CHECK ("terminalCount" <= "expectedCount")
);

CREATE TABLE "PipelineTask" (
  "id" TEXT NOT NULL,
  "stageId" TEXT NOT NULL,
  "itemKey" TEXT NOT NULL,
  "inputFingerprint" TEXT NOT NULL,
  "state" "PipelineTaskState" NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "dispatchCount" INTEGER NOT NULL DEFAULT 0,
  "lastDispatchedAt" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseAcquiredAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "leaseAttempt" INTEGER NOT NULL DEFAULT 0,
  "artifactS3Key" TEXT,
  "artifactFingerprint" TEXT,
  "terminalAt" TIMESTAMP(3),
  "safeErrorCode" TEXT,
  "safeErrorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PipelineTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PipelineStage_runId_stage_generation_key" ON "PipelineStage"("runId", "stage", "generation");
CREATE UNIQUE INDEX "PipelineStage_aggregationLeaseToken_key" ON "PipelineStage"("aggregationLeaseToken");
CREATE INDEX "PipelineStage_runId_generation_idx" ON "PipelineStage"("runId", "generation");
CREATE INDEX "PipelineStage_state_aggregationLeaseExpiresAt_idx" ON "PipelineStage"("state", "aggregationLeaseExpiresAt");
CREATE UNIQUE INDEX "PipelineTask_stageId_itemKey_key" ON "PipelineTask"("stageId", "itemKey");
CREATE UNIQUE INDEX "PipelineTask_leaseToken_key" ON "PipelineTask"("leaseToken");
CREATE INDEX "PipelineTask_stageId_state_idx" ON "PipelineTask"("stageId", "state");
CREATE INDEX "PipelineTask_state_leaseExpiresAt_idx" ON "PipelineTask"("state", "leaseExpiresAt");
CREATE INDEX "PipelineTask_stageId_lastDispatchedAt_idx" ON "PipelineTask"("stageId", "lastDispatchedAt");

ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PipelineTask" ADD CONSTRAINT "PipelineTask_stageId_fkey"
FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
