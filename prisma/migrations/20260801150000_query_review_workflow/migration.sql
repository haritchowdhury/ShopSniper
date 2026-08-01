-- Add the durable query-review lifecycle without removing historical data.
ALTER TYPE "RunState" ADD VALUE IF NOT EXISTS 'awaiting_query_confirmation';

CREATE TYPE "RunPhase" AS ENUM ('query_planning', 'query_review', 'scraping', 'finished');
CREATE TYPE "RunQuerySource" AS ENUM ('generated', 'user_added', 'user_edited');
CREATE TYPE "RunQueryValidationState" AS ENUM ('pending', 'valid', 'invalid');

ALTER TABLE "Run"
ADD COLUMN "phase" "RunPhase" NOT NULL DEFAULT 'query_planning',
ADD COLUMN "queryRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "confirmedQueryRevision" INTEGER,
ADD COLUMN "queryPlanReadyAt" TIMESTAMP(3),
ADD COLUMN "queriesConfirmedAt" TIMESTAMP(3);

-- Existing queued/running records predate review and must retain their one-shot semantics.
UPDATE "Run"
SET "phase" = CASE
  WHEN "state" IN ('completed', 'failed', 'cancelled') THEN 'finished'::"RunPhase"
  ELSE 'scraping'::"RunPhase"
END;

CREATE TABLE "RunQuery" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "categoryIndex" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "query" TEXT NOT NULL,
  "source" "RunQuerySource" NOT NULL,
  "validationState" "RunQueryValidationState" NOT NULL DEFAULT 'pending',
  "rejectionReason" TEXT,
  "queryScore" DOUBLE PRECISION,
  "generationReason" TEXT,
  "sourceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "categoryVocabulary" JSONB,
  "probeSummary" JSONB,
  "probeResults" JSONB,
  "probeContractVersion" TEXT,
  "probeFingerprint" TEXT,
  "probedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RunQuery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RunQuery_runId_sequence_key" ON "RunQuery"("runId", "sequence");
CREATE INDEX "RunQuery_runId_categoryIndex_sequence_idx" ON "RunQuery"("runId", "categoryIndex", "sequence");
CREATE INDEX "RunQuery_runId_validationState_idx" ON "RunQuery"("runId", "validationState");

ALTER TABLE "RunQuery"
ADD CONSTRAINT "RunQuery_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
