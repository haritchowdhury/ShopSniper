-- Add ownership without exposing legacy rows. Existing runs remain ownerless.
ALTER TABLE "Run" ADD COLUMN "ownerId" TEXT;

CREATE TABLE "RunIntent" (
    "id" TEXT NOT NULL,
    "normalizedShopTypes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedByUserId" TEXT,
    "claimedRunId" TEXT,

    CONSTRAINT "RunIntent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Run_ownerId_createdAt_idx" ON "Run"("ownerId", "createdAt");
CREATE UNIQUE INDEX "RunIntent_claimedRunId_key" ON "RunIntent"("claimedRunId");
CREATE INDEX "RunIntent_expiresAt_idx" ON "RunIntent"("expiresAt");

-- Queued rows may accumulate. PostgreSQL still arbitrates the single worker slot.
DROP INDEX "Run_one_active_idx";
CREATE UNIQUE INDEX "Run_one_running_idx"
ON "Run" ((true))
WHERE "state" = 'running';
