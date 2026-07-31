-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('qualified', 'rejected', 'failed');

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "state" "RunState" NOT NULL,
    "stage" TEXT NOT NULL,
    "normalizedShopTypes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "progress" JSONB NOT NULL,
    "resultsAvailable" BOOLEAN NOT NULL DEFAULT false,
    "leadSummary" JSONB,
    "safeErrorCode" TEXT,
    "safeErrorMessage" TEXT,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "shopType" TEXT,
    "generatedQuery" TEXT,
    "queryScore" INTEGER,
    "queryGenerationReason" TEXT,
    "searchQuery" TEXT,
    "googleRank" INTEGER,
    "googleResultUrl" TEXT,
    "myshopifyDomain" TEXT,
    "finalUrl" TEXT,
    "canonicalUrl" TEXT,
    "resolvedDomain" TEXT,
    "storeName" TEXT,
    "email" TEXT,
    "emailSourceUrl" TEXT,
    "phone" TEXT,
    "phoneSourceUrl" TEXT,
    "contactUrl" TEXT,
    "socialProfiles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "additionalInformation" TEXT,
    "shopifyConfidence" INTEGER,
    "relevanceScore" INTEGER,
    "leadScore" INTEGER,
    "status" "LeadStatus" NOT NULL,
    "rejectionReason" TEXT,
    "error" TEXT,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Run_state_idx" ON "Run"("state");

-- CreateIndex
CREATE INDEX "Run_createdAt_idx" ON "Run"("createdAt");

-- PostgreSQL, not process memory, arbitrates the one-active-run rule.
CREATE UNIQUE INDEX "Run_one_active_idx"
ON "Run" ((true))
WHERE "state" IN ('queued', 'running');

-- CreateIndex
CREATE INDEX "Lead_runId_status_idx" ON "Lead"("runId", "status");

-- CreateIndex
CREATE INDEX "Lead_runId_leadScore_idx" ON "Lead"("runId", "leadScore");

-- CreateIndex
CREATE INDEX "Lead_runId_storeName_idx" ON "Lead"("runId", "storeName");

-- CreateIndex
CREATE INDEX "Lead_runId_shopType_idx" ON "Lead"("runId", "shopType");

-- CreateIndex
CREATE INDEX "Lead_runId_googleRank_idx" ON "Lead"("runId", "googleRank");

-- AddForeignKey
ALTER TABLE "Lead"
ADD CONSTRAINT "Lead_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "Run"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
