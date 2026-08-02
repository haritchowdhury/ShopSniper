-- TE-3 adds nullable run snapshots and isolated normalized enrichment storage.
CREATE TYPE "TrafficEnrichmentSource" AS ENUM ('dataforseo', 'crux_rest', 'crux_bigquery');
CREATE TYPE "TrafficEnrichmentCacheState" AS ENUM ('available', 'no_coverage');
CREATE TYPE "LeadTrafficEnrichmentState" AS ENUM ('available', 'partial', 'no_coverage', 'unavailable', 'ambiguous', 'contract_mismatch');
CREATE TYPE "DataForSeoRequestState" AS ENUM ('planned', 'in_flight', 'succeeded', 'failed', 'ambiguous');

ALTER TABLE "Run"
ADD COLUMN "trafficEnrichmentConfig" JSONB,
ADD COLUMN "trafficEnrichmentSummary" JSONB;

CREATE UNIQUE INDEX "Lead_id_runId_key" ON "Lead"("id", "runId");

CREATE TABLE "TrafficEnrichmentCache" (
  "id" TEXT NOT NULL,
  "source" "TrafficEnrichmentSource" NOT NULL,
  "identity" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "metricSetKey" TEXT NOT NULL,
  "contractVersion" TEXT NOT NULL,
  "state" "TrafficEnrichmentCacheState" NOT NULL,
  "normalizedPayload" JSONB,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  "coverageStartedAt" TIMESTAMP(3),
  "coverageEndedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrafficEnrichmentCache_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeadTrafficEnrichment" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "source" "TrafficEnrichmentSource" NOT NULL,
  "state" "LeadTrafficEnrichmentState" NOT NULL,
  "contractVersion" TEXT NOT NULL,
  "normalizedPayload" JSONB,
  "fetchedAt" TIMESTAMP(3),
  "coverageStartedAt" TIMESTAMP(3),
  "coverageEndedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadTrafficEnrichment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DataForSeoRequestLedger" (
  "requestFingerprint" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "targetCount" INTEGER NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "state" "DataForSeoRequestState" NOT NULL DEFAULT 'planned',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "safeErrorCode" TEXT,
  "safeErrorMessage" TEXT,
  "providerCostUsd" DECIMAL(18,8),
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseAttempt" INTEGER,
  "plannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DataForSeoRequestLedger_pkey" PRIMARY KEY ("requestFingerprint")
);

CREATE UNIQUE INDEX "TrafficEnrichmentCache_source_identity_scopeKey_metricSetKey_contractVersion_key"
ON "TrafficEnrichmentCache"("source", "identity", "scopeKey", "metricSetKey", "contractVersion");
CREATE INDEX "TrafficEnrichmentCache_expiresAt_idx" ON "TrafficEnrichmentCache"("expiresAt");
CREATE INDEX "TrafficEnrichmentCache_source_identity_scopeKey_idx" ON "TrafficEnrichmentCache"("source", "identity", "scopeKey");
CREATE UNIQUE INDEX "LeadTrafficEnrichment_leadId_source_key" ON "LeadTrafficEnrichment"("leadId", "source");
CREATE INDEX "LeadTrafficEnrichment_runId_source_idx" ON "LeadTrafficEnrichment"("runId", "source");
CREATE INDEX "DataForSeoRequestLedger_runId_state_idx" ON "DataForSeoRequestLedger"("runId", "state");
CREATE INDEX "DataForSeoRequestLedger_state_claimedAt_idx" ON "DataForSeoRequestLedger"("state", "claimedAt");

ALTER TABLE "LeadTrafficEnrichment"
ADD CONSTRAINT "LeadTrafficEnrichment_leadId_runId_fkey"
FOREIGN KEY ("leadId", "runId") REFERENCES "Lead"("id", "runId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DataForSeoRequestLedger"
ADD CONSTRAINT "DataForSeoRequestLedger_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
