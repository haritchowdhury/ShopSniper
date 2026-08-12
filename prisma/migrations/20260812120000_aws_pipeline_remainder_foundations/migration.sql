-- Additive foundations required by the remaining AWS pipeline windows.
ALTER TABLE "Run"
ADD COLUMN "awsProviderConfig" JSONB;

ALTER TABLE "PipelineStage"
ADD COLUMN "manifestProducedAt" TIMESTAMP(3);

UPDATE "PipelineStage"
SET "manifestProducedAt" = "createdAt"
WHERE "manifestProducedAt" IS NULL;

ALTER TABLE "PipelineStage"
ALTER COLUMN "manifestProducedAt" SET NOT NULL;

ALTER TABLE "ShopWork"
ADD COLUMN "processingPipelineTaskId" TEXT;

CREATE INDEX "ShopWork_processingPipelineTaskId_idx"
ON "ShopWork"("processingPipelineTaskId");
