-- CreateEnum
CREATE TYPE "KeywordResearchState" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "KeywordResearchStageName" AS ENUM ('expansion', 'anchor_screen', 'market_overview');

-- CreateEnum
CREATE TYPE "KeywordResearchStageState" AS ENUM ('collecting', 'ready', 'aggregating', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "KeywordResearchTaskState" AS ENUM ('pending', 'processing', 'succeeded', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "RunQueryPlanSource" AS ENUM ('legacy', 'keyword_research');

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "keywordResearchId" TEXT,
ADD COLUMN     "keywordSelectionRevision" INTEGER,
ADD COLUMN     "keywordSelectionSnapshot" JSONB,
ADD COLUMN     "queryPlanSource" "RunQueryPlanSource" NOT NULL DEFAULT 'legacy';

-- AlterTable
ALTER TABLE "RunQuery" ADD COLUMN     "keywordResearchItemId" TEXT;

-- CreateTable
CREATE TABLE "KeywordResearch" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "state" "KeywordResearchState" NOT NULL DEFAULT 'queued',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "contractVersion" INTEGER NOT NULL DEFAULT 1,
    "configSnapshot" JSONB NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "seeds" JSONB NOT NULL,
    "markets" JSONB NOT NULL,
    "progress" JSONB NOT NULL,
    "result" JSONB,
    "resultFingerprint" TEXT,
    "selection" JSONB,
    "selectionRevision" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" TEXT,
    "safeErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordResearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordResearchStage" (
    "id" TEXT NOT NULL,
    "researchId" TEXT NOT NULL,
    "stage" "KeywordResearchStageName" NOT NULL,
    "generation" INTEGER NOT NULL,
    "manifestS3Key" TEXT,
    "manifestFingerprint" TEXT,
    "manifestProducedAt" TIMESTAMP(3),
    "expectedCount" INTEGER NOT NULL,
    "terminalCount" INTEGER NOT NULL DEFAULT 0,
    "succeededCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledCount" INTEGER NOT NULL DEFAULT 0,
    "state" "KeywordResearchStageState" NOT NULL DEFAULT 'collecting',
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

    CONSTRAINT "KeywordResearchStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordResearchTask" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "endpointKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "nextAttemptAt" TIMESTAMP(3),
    "state" "KeywordResearchTaskState" NOT NULL DEFAULT 'pending',
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

    CONSTRAINT "KeywordResearchTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordResearchCache" (
    "requestFingerprint" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "endpointKey" TEXT NOT NULL,
    "contractVersion" INTEGER NOT NULL DEFAULT 1,
    "normalizedResponse" JSONB NOT NULL,
    "resultFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordResearchCache_pkey" PRIMARY KEY ("requestFingerprint")
);

-- CreateTable
CREATE TABLE "KeywordResearchProviderAttempt" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "state" "DataForSeoRequestState" NOT NULL DEFAULT 'planned',
    "requestFingerprint" TEXT NOT NULL,
    "plannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "ambiguousAfter" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "reservationCostUsd" DECIMAL(18,8),
    "providerCostUsd" DECIMAL(18,8),
    "safeErrorCode" TEXT,
    "resultFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordResearchProviderAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeywordProviderThrottle" (
    "provider" TEXT NOT NULL,
    "nextAllowedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordProviderThrottle_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "KeywordResearchHandoff" (
    "id" TEXT NOT NULL,
    "researchId" TEXT NOT NULL,
    "selectionRevision" INTEGER NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "selectionFingerprint" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeywordResearchHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KeywordResearch_ownerId_createdAt_idx" ON "KeywordResearch"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "KeywordResearch_state_createdAt_idx" ON "KeywordResearch"("state", "createdAt");

-- CreateIndex
CREATE INDEX "KeywordResearchStage_researchId_generation_idx" ON "KeywordResearchStage"("researchId", "generation");

-- CreateIndex
CREATE INDEX "KeywordResearchStage_state_aggregationLeaseExpiresAt_idx" ON "KeywordResearchStage"("state", "aggregationLeaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordResearchStage_researchId_stage_generation_key" ON "KeywordResearchStage"("researchId", "stage", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordResearchTask_leaseToken_key" ON "KeywordResearchTask"("leaseToken");

-- CreateIndex
CREATE INDEX "KeywordResearchTask_stageId_state_idx" ON "KeywordResearchTask"("stageId", "state");

-- CreateIndex
CREATE INDEX "KeywordResearchTask_state_leaseExpiresAt_idx" ON "KeywordResearchTask"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "KeywordResearchTask_stageId_lastDispatchedAt_idx" ON "KeywordResearchTask"("stageId", "lastDispatchedAt");

-- CreateIndex
CREATE INDEX "KeywordResearchTask_state_nextAttemptAt_idx" ON "KeywordResearchTask"("state", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordResearchTask_stageId_itemKey_key" ON "KeywordResearchTask"("stageId", "itemKey");

-- CreateIndex
CREATE INDEX "KeywordResearchCache_cacheKey_idx" ON "KeywordResearchCache"("cacheKey");

-- CreateIndex
CREATE INDEX "KeywordResearchCache_expiresAt_idx" ON "KeywordResearchCache"("expiresAt");

-- CreateIndex
CREATE INDEX "KeywordResearchProviderAttempt_taskId_state_idx" ON "KeywordResearchProviderAttempt"("taskId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordResearchProviderAttempt_taskId_attemptNumber_key" ON "KeywordResearchProviderAttempt"("taskId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordResearchHandoff_runId_key" ON "KeywordResearchHandoff"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "KeywordResearchHandoff_researchId_clientRequestId_key" ON "KeywordResearchHandoff"("researchId", "clientRequestId");

-- CreateIndex
CREATE INDEX "Run_keywordResearchId_idx" ON "Run"("keywordResearchId");

-- CreateIndex
CREATE INDEX "RunQuery_keywordResearchItemId_idx" ON "RunQuery"("keywordResearchItemId");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_keywordResearchId_fkey" FOREIGN KEY ("keywordResearchId") REFERENCES "KeywordResearch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordResearchStage" ADD CONSTRAINT "KeywordResearchStage_researchId_fkey" FOREIGN KEY ("researchId") REFERENCES "KeywordResearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordResearchTask" ADD CONSTRAINT "KeywordResearchTask_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "KeywordResearchStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordResearchProviderAttempt" ADD CONSTRAINT "KeywordResearchProviderAttempt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "KeywordResearchTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordResearchHandoff" ADD CONSTRAINT "KeywordResearchHandoff_researchId_fkey" FOREIGN KEY ("researchId") REFERENCES "KeywordResearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeywordResearchHandoff" ADD CONSTRAINT "KeywordResearchHandoff_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

