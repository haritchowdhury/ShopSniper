-- TE-R2 adds durable conservative exposure and the immutable ambiguity deadline.
ALTER TABLE "DataForSeoRequestLedger"
ADD COLUMN "reservationCostUsd" DECIMAL(18,8),
ADD COLUMN "ambiguousAfter" TIMESTAMP(3);

DROP INDEX "DataForSeoRequestLedger_state_claimedAt_idx";
CREATE INDEX "DataForSeoRequestLedger_state_ambiguousAfter_idx"
ON "DataForSeoRequestLedger"("state", "ambiguousAfter");
