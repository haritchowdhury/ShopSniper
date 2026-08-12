import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository, awsProviderConfigSnapshot,
  trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { parseTrafficRunConfig } from "../src/aws-pipeline/contracts/traffic-config.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);

test("G11 Run lease loads the complete task set and task-fences non-unique traffic work",
  { skip: !enabled, timeout: 120000 }, async () => {
    const schema = `g11_traffic_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl); prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const repository = new PrismaRunRepository(prisma);
      const coordinator = new PipelineCoordinatorRepository(prisma);
      const now = new Date("2026-08-12T12:00:00.000Z");
      const runId = "run_g11_traffic_fixture_0001";
      const shopId = "shop_13iOzZDK7joaSKKTmscbk00V";
      const traffic = trafficEnrichmentConfigSnapshot({});
      const provider = awsProviderConfigSnapshot({ browserlessUrl: "https://fixture.example",
        googleSearchEngineId: "fixture", googleResultsPerQuery: 10, requestTimeoutMs: 10000,
        maxPagesPerStore: 5, pageFetchConcurrency: 2, maxQueries: 20, generatedQueryCount: 10,
        queryProbeFreshnessMs: 60000, queryProbeConcurrency: 1, minQueryResults: 1,
        minQueryUniqueHosts: 1, minQueryRelevantResults: 1, minQueryRelevanceRatio: 0.1,
        minQueryBaseScore: 1, browserlessEnabled: false, enableAiNormalization: false });
      await prisma.run.create({ data: { id: runId, state: "running", phase: "scraping",
        stage: "aws_traffic_crux", normalizedShopTypes: [], progress: {}, executionBackend: "aws",
        pipelineGeneration: 1, trafficEnrichmentConfig: traffic, awsProviderConfig: provider } });
      await prisma.shop.create({ data: { id: shopId, stableKey: "domain:fixture.example",
        canonicalUrl: "https://fixture.example", resolvedDomain: "fixture.example" } });
      await prisma.lead.create({ data: { id: "lead_g11_fixture_0001", runId, shopId,
        status: "qualified", finalUrl: "https://fixture.example", canonicalUrl: "https://fixture.example",
        resolvedDomain: "fixture.example" } });
      const registered = await coordinator.registerStage({ runId, stage: "traffic_crux", generation: 1,
        manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint: "a".repeat(64),
        manifestProducedAt: now, tasks: [{ itemKey: shopId, inputFingerprint: "b".repeat(64) }] }, now);
      const token = randomUUID();
      const owned = await repository.claimAwsRunLease({ runId, generation: 1, owner: "g11",
        token, leaseDurationMs: 60000 }, now);
      assert.equal(owned.outcome, "owned");
      assert.equal((await repository.claimAwsRunLease({ runId, generation: 1, owner: "other",
        token: randomUUID(), leaseDurationMs: 60000 }, now)).outcome, "busy");
      const savedTraffic = (await prisma.run.findUnique({ where: { id: runId },
        select: { trafficEnrichmentConfig: true } })).trafficEnrichmentConfig;
      assert.deepEqual(savedTraffic, traffic);
      parseTrafficRunConfig(savedTraffic);
      const loaded = await repository.loadAwsTrafficStage({ runId, generation: 1,
        runLease: owned.lease }, new Date(now.getTime() + 1));
      assert.deepEqual(loaded.tasks.map(({ itemKey }) => itemKey), [shopId]);
      assert.equal(loaded.leads.length, 1);
      const selection = { source: "crux_rest", identity: "https://fixture.example",
        scopeKey: "current", metricSetKey: traffic.crux.rest.metricSetKey,
        contractVersion: traffic.crux.rest.contractVersion, reuse: null };
      const claims = [{ shopId, pipelineTaskId: registered.tasks[0].id, selection }];
      assert.equal((await repository.claimAwsTrafficWorkBatch({ runId, generation: 1,
        runLease: owned.lease, claims }, new Date(now.getTime() + 2)))[0].outcome, "owned");
      assert.equal((await repository.claimAwsTrafficWorkBatch({ runId, generation: 1,
        runLease: owned.lease, claims }, new Date(now.getTime() + 3)))[0].outcome, "owned");
      const work = await prisma.shopWork.findFirst({ where: { shopId, workType: "crux_rest" } });
      assert.equal(work.processingPipelineTaskId, registered.tasks[0].id);
      await repository.releaseAwsRunLease({ runId, generation: 1, token }, new Date(now.getTime() + 4));
      assert.equal((await prisma.run.findUnique({ where: { id: runId } })).leaseToken, null);
      assert.equal((await prisma.shopWork.findUnique({ where: { id: work.id } })).processingPipelineTaskId,
        registered.tasks[0].id);
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
