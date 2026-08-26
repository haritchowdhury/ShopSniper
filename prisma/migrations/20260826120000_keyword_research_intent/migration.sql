-- CreateTable
CREATE TABLE "KeywordResearchIntent" (
    "id" TEXT NOT NULL,
    "seeds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimedByUserId" TEXT,
    "claimedResearchId" TEXT,

    CONSTRAINT "KeywordResearchIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KeywordResearchIntent_claimedResearchId_key" ON "KeywordResearchIntent"("claimedResearchId");

-- CreateIndex
CREATE INDEX "KeywordResearchIntent_expiresAt_idx" ON "KeywordResearchIntent"("expiresAt");

-- AddForeignKey
ALTER TABLE "KeywordResearchIntent" ADD CONSTRAINT "KeywordResearchIntent_claimedResearchId_fkey" FOREIGN KEY ("claimedResearchId") REFERENCES "KeywordResearch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
