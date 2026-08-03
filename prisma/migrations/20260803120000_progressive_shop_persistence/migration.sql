-- DP1 adds global shop identity, run-store checkpoints, reusable lead profiles,
-- and resource-level work claims. Existing rows are not rewritten or backfilled.
-- Resource-level claims supersede the historical database-wide worker slot.
DROP INDEX "Run_one_running_idx";

CREATE TYPE "RunStoreState" AS ENUM ('discovered', 'processing', 'completed', 'failed');
CREATE TYPE "ShopLeadProfileState" AS ENUM ('processing', 'completed', 'failed');
CREATE TYPE "ShopWorkType" AS ENUM ('lead_discovery', 'dataforseo', 'crux_rest', 'crux_bigquery');
CREATE TYPE "ShopWorkState" AS ENUM ('pending', 'processing', 'completed', 'failed', 'ambiguous');

ALTER TABLE "Lead"
ADD COLUMN "shopId" TEXT,
ADD COLUMN "shopLeadProfileId" TEXT;

CREATE TABLE "Shop" (
  "id" TEXT NOT NULL,
  "stableKey" TEXT NOT NULL,
  "myshopifyDomain" TEXT,
  "resolvedDomain" TEXT,
  "canonicalUrl" TEXT,
  "identityConfidence" INTEGER,
  "identityEvidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunStore" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "state" "RunStoreState" NOT NULL DEFAULT 'discovered',
  "candidatePayload" JSONB NOT NULL,
  "safeErrorCode" TEXT,
  "safeErrorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RunStore_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopLeadProfile" (
  "shopId" TEXT NOT NULL,
  "state" "ShopLeadProfileState" NOT NULL,
  "profilePayload" JSONB,
  "processingRunId" TEXT,
  "safeErrorCode" TEXT,
  "safeErrorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopLeadProfile_pkey" PRIMARY KEY ("shopId")
);

CREATE TABLE "ShopWork" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "workType" "ShopWorkType" NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "state" "ShopWorkState" NOT NULL DEFAULT 'pending',
  "processingRunId" TEXT,
  "processingLeaseToken" TEXT,
  "safeErrorCode" TEXT,
  "safeErrorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopWork_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Shop_stableKey_key" ON "Shop"("stableKey");
CREATE UNIQUE INDEX "RunStore_runId_shopId_key" ON "RunStore"("runId", "shopId");
CREATE INDEX "RunStore_runId_state_idx" ON "RunStore"("runId", "state");
CREATE INDEX "RunStore_shopId_idx" ON "RunStore"("shopId");
CREATE INDEX "ShopLeadProfile_state_processingRunId_idx" ON "ShopLeadProfile"("state", "processingRunId");
CREATE UNIQUE INDEX "ShopWork_shopId_workType_scopeKey_key" ON "ShopWork"("shopId", "workType", "scopeKey");
CREATE INDEX "ShopWork_state_processingRunId_idx" ON "ShopWork"("state", "processingRunId");
CREATE UNIQUE INDEX "Lead_runId_shopId_key" ON "Lead"("runId", "shopId");

ALTER TABLE "RunStore" ADD CONSTRAINT "RunStore_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunStore" ADD CONSTRAINT "RunStore_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopLeadProfile" ADD CONSTRAINT "ShopLeadProfile_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopLeadProfile" ADD CONSTRAINT "ShopLeadProfile_processingRunId_fkey"
FOREIGN KEY ("processingRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShopWork" ADD CONSTRAINT "ShopWork_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopWork" ADD CONSTRAINT "ShopWork_processingRunId_fkey"
FOREIGN KEY ("processingRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_shopLeadProfileId_fkey"
FOREIGN KEY ("shopLeadProfileId") REFERENCES "ShopLeadProfile"("shopId") ON DELETE SET NULL ON UPDATE CASCADE;
