-- G-R4 preserves historical values while making v2 result semantics durable.
ALTER TABLE "Run"
ADD COLUMN "resultFingerprint" TEXT;

ALTER TABLE "Lead"
ADD COLUMN "originalShopType" TEXT,
ALTER COLUMN "queryScore" TYPE DOUBLE PRECISION
USING "queryScore"::DOUBLE PRECISION;
