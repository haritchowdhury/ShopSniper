-- G-R6 adds worker lease fencing without rewriting historical run state.
ALTER TABLE "Run"
ADD COLUMN "leaseOwner" TEXT,
ADD COLUMN "leaseToken" TEXT,
ADD COLUMN "leaseAcquiredAt" TIMESTAMP(3),
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN "leaseAttempt" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Run_leaseToken_key" ON "Run"("leaseToken");
CREATE INDEX "Run_state_leaseExpiresAt_idx" ON "Run"("state", "leaseExpiresAt");
