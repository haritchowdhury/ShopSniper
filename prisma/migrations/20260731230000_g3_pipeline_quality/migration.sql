-- G3 adds versioned evidence and separate operational records without rewriting legacy rows.
ALTER TABLE "Run"
ADD COLUMN "pipelineVersion" INTEGER,
ADD COLUMN "scoringVersion" INTEGER;

ALTER TABLE "Lead"
ADD COLUMN "businessQualifier" TEXT,
ADD COLUMN "pipelineVersion" INTEGER,
ADD COLUMN "scoringVersion" INTEGER,
ADD COLUMN "storeFitState" TEXT,
ADD COLUMN "storeFitEvidence" JSONB,
ADD COLUMN "contactabilityTier" TEXT,
ADD COLUMN "contactEvidence" JSONB,
ADD COLUMN "identityConfidence" INTEGER,
ADD COLUMN "identityEvidence" JSONB,
ADD COLUMN "scoreBreakdown" JSONB,
ADD COLUMN "discoveryOccurrences" JSONB,
ADD COLUMN "matchedCategories" JSONB;

CREATE TABLE "QueryAudit" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "shopType" TEXT,
    "businessQualifier" TEXT,
    "query" TEXT,
    "status" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "details" JSONB NOT NULL,
    CONSTRAINT "QueryAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunDiagnostic" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "shopType" TEXT,
    "businessQualifier" TEXT,
    "query" TEXT,
    "resultUrl" TEXT,
    "details" JSONB NOT NULL,
    CONSTRAINT "RunDiagnostic_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QueryAudit_runId_sequence_key" ON "QueryAudit"("runId", "sequence");
CREATE INDEX "QueryAudit_runId_status_idx" ON "QueryAudit"("runId", "status");
CREATE UNIQUE INDEX "RunDiagnostic_runId_sequence_key" ON "RunDiagnostic"("runId", "sequence");
CREATE INDEX "RunDiagnostic_runId_scope_code_idx" ON "RunDiagnostic"("runId", "scope", "code");

ALTER TABLE "QueryAudit" ADD CONSTRAINT "QueryAudit_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunDiagnostic" ADD CONSTRAINT "RunDiagnostic_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
