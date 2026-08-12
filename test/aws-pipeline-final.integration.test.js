import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { pipelineStageId } from "../src/aws-pipeline/core/keys.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository, awsProviderConfigSnapshot,
  trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);

test("G12 atomically publishes a zero-task AWS run and terminal replay cannot republish",
  { skip: !enabled, timeout: 120000 }, async () => {
    const schema = `g12_final_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl); prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const repository = new PrismaRunRepository(prisma);
      const coordinator = new PipelineCoordinatorRepository(prisma);
      const now = new Date(); const runId = "run_g12_final_fixture_0001";
      const traffic = trafficEnrichmentConfigSnapshot({});
      const provider = awsProviderConfigSnapshot({ browserlessUrl: "https://fixture.example",
        googleSearchEngineId: "fixture", googleResultsPerQuery: 10, requestTimeoutMs: 10000,
        maxPagesPerStore: 5, pageFetchConcurrency: 2, maxQueries: 20, generatedQueryCount: 10,
        queryProbeFreshnessMs: 60000, queryProbeConcurrency: 1, minQueryResults: 1,
        minQueryUniqueHosts: 1, minQueryRelevantResults: 1, minQueryRelevanceRatio: 0.1,
        minQueryBaseScore: 1, browserlessEnabled: false, enableAiNormalization: false });
      await prisma.run.create({ data: { id: runId, state: "running", phase: "scraping",
        stage: "aws_traffic_crux", normalizedShopTypes: [], progress: {}, executionBackend: "aws",
        pipelineGeneration: 1, trafficEnrichmentConfig: traffic, awsProviderConfig: provider,
        resultsAvailable: false } });
      await prisma.pipelineStage.create({ data: { id: pipelineStageId(runId, "lead", 1), runId,
        stage: "lead", generation: 1, manifestS3Key: `runs/${runId}/domains-manifest.json`,
        manifestFingerprint: "a".repeat(64), manifestProducedAt: now, expectedCount: 0,
        state: "completed", completedAt: now } });
      const registered = await coordinator.registerStage({ runId, stage: "traffic_crux", generation: 1,
        manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint: "a".repeat(64),
        manifestProducedAt: now, tasks: [] }, now);
      const token = randomUUID();
      const claim = await coordinator.claimAggregator({ runId, stage: "traffic_crux", generation: 1,
        owner: "g12", token, leaseDurationMs: 120000 }, new Date(now.getTime() + 1));
      assert.equal(claim.outcome, "owned");
      const read = await repository.readAwsFinalReuseRows({ runId, generation: 1,
        stageId: registered.stage.id, aggregationToken: token, selections: [], evaluatedAt: now });
      assert.deepEqual(read.trafficRows, []); assert.deepEqual(read.leadTasks, []);
      const published = await repository.publishAwsFinalResults({ runId, generation: 1,
        stageId: registered.stage.id, aggregationToken: token, cacheRows: [], leadTrafficRows: [],
        leadProfileOutcomes: [], workOutcomes: [], diagnostics: [],
        trafficSummary: { version: "traffic-enrichment-summary-v1" }, status: {} }, new Date(now.getTime() + 2));
      assert.equal(published.run.resultsAvailable, true);
      assert.equal(published.run.state, "completed");
      assert.match(published.resultFingerprint, /^[a-f0-9]{64}$/u);
      const independentlyRecomputed = fingerprintJson({ contractVersion: "aws-final-publication-v1", runId,
        generation: 1, leads: [], trafficEnrichments: [], queryAudits: [], diagnostics: [],
        leadSummary: { total: 0, qualified: 0, rejected: 0, failed: 0 },
        trafficSummary: { version: "traffic-enrichment-summary-v1" }, pipelineVersion: 2, scoringVersion: 2 });
      assert.equal(published.resultFingerprint, independentlyRecomputed);
      assert.equal((await coordinator.claimAggregator({ runId, stage: "traffic_crux", generation: 1,
        owner: "replay", token: randomUUID(), leaseDurationMs: 120000 }, new Date(now.getTime() + 3))).outcome,
      "cancelled");
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
