import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { awsProviderConfigSnapshot, trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);

test("G13 cancellation is atomic and fences every late coordinator token",
  { skip: !enabled, timeout: 120000 }, async () => {
    const schema = `g13_e2e_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema); let prisma;
    try {
      deployPrismaMigrations(scopedUrl); prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const coordinator = new PipelineCoordinatorRepository(prisma); const now = new Date();
      const runId = "run_g13_cancel_fixture_0001";
      const provider = awsProviderConfigSnapshot({ browserlessUrl: "https://fixture.example",
        googleSearchEngineId: "fixture", googleResultsPerQuery: 10, requestTimeoutMs: 10000,
        maxPagesPerStore: 5, pageFetchConcurrency: 2, maxQueries: 20, generatedQueryCount: 10,
        queryProbeFreshnessMs: 60000, queryProbeConcurrency: 1, minQueryResults: 1,
        minQueryUniqueHosts: 1, minQueryRelevantResults: 1, minQueryRelevanceRatio: 0.1,
        minQueryBaseScore: 1, browserlessEnabled: false, enableAiNormalization: false });
      await prisma.run.create({ data: { id: runId, state: "running", phase: "scraping", stage: "aws_lead",
        normalizedShopTypes: [], progress: {}, executionBackend: "aws", pipelineGeneration: 1,
        trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({}), awsProviderConfig: provider,
        leaseOwner: "old", leaseToken: randomUUID(), leaseAcquiredAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60000), resultsAvailable: false } });
      const registered = await coordinator.registerStage({ runId, stage: "lead", generation: 1,
        manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint: "a".repeat(64),
        manifestProducedAt: now, tasks: [{ itemKey: "shop_fixture_cancel_0001",
          inputFingerprint: "b".repeat(64) }] }, now);
      const result = await coordinator.cancelRunGeneration({ runId, generation: 1 }, new Date(now.getTime() + 1));
      assert.equal(result.run.state, "cancelled"); assert.equal(result.run.resultsAvailable, false);
      assert.equal(result.run.leaseToken, null); assert.equal(result.tasks[0].state, "cancelled");
      assert.equal(result.stages[0].state, "cancelled");
      assert.equal((await coordinator.claimTask({ runId, stage: "lead", generation: 1,
        itemKey: registered.tasks[0].itemKey, inputFingerprint: registered.tasks[0].inputFingerprint,
        owner: "late", token: randomUUID(), leaseDurationMs: 60000 }, new Date(now.getTime() + 2))).outcome,
      "cancelled");
      await assert.rejects(coordinator.cancelRunGeneration({ runId, generation: 2 },
        new Date(now.getTime() + 3)), (error) => error.code === "PIPELINE_INPUT_CONFLICT");
    } finally {
      await prisma?.$disconnect(); await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
