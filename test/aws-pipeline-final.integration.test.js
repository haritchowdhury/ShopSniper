import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { pipelineStageId, pipelineTaskId } from "../src/aws-pipeline/core/keys.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { leadRecordToCreate } from "../src/api-serializer.js";
import { shopWorkId } from "../src/shop-persistence-contract.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository, awsProviderConfigSnapshot,
  trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/aws-pipeline/v1/${name}`, import.meta.url)));

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
      assert.deepEqual(read.leads, []);
      const published = await repository.publishAwsFinalResults({ runId, generation: 1,
        stageId: registered.stage.id, aggregationToken: token, cacheRows: [], leadTrafficRows: [],
        leadProfileOutcomes: [], workOutcomes: [], dataForSeoLedgerEvidence: [], diagnostics: [],
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

test("G-R8 nonempty final transaction locks paid evidence and rolls back every named failpoint",
  { skip: !enabled, timeout: 180000 }, async () => {
    const schema = `gr8_final_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl); prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const repository = new PrismaRunRepository(prisma); const coordinator = new PipelineCoordinatorRepository(prisma);
      const now = new Date("2026-08-13T00:00:00.000Z"); const runId = "run_gr8_final_fixture_0001";
      const shopId = "shop_13iOzZDK7joaSKKTmscbk00V"; const ownerId = "user_owner_fixture";
      const leadResultFixture = (await load("lead-results.valid.json")).success;
      const leadFixture = leadResultFixture.lead;
      const profile = leadResultFixture.profile; const profileFingerprint = fingerprintJson(profile);
      const trafficConfig = trafficEnrichmentConfigSnapshot({});
      const requestFingerprint = "1".repeat(64); const batchFingerprint = "2".repeat(64);
      await prisma.run.create({ data: { id: runId, ownerId, state: "running", phase: "scraping",
        stage: "aws_traffic_crux", normalizedShopTypes: [], progress: {}, executionBackend: "aws",
        pipelineGeneration: 1, trafficEnrichmentConfig: trafficConfig,
        awsProviderConfig: {}, resultsAvailable: false } });
      await prisma.shop.create({ data: { id: shopId, stableKey: "fixture.myshopify.com",
        canonicalUrl: "https://fixture.example", resolvedDomain: "fixture.example" } });
      await prisma.shopLeadProfile.create({ data: { shopId, state: "completed", profilePayload: profile } });
      const lead = await prisma.lead.create({ data: { ...leadRecordToCreate(runId,
        "lead_gr8_fixture_0001", leadFixture), shopId } });
      await prisma.pipelineStage.create({ data: { id: pipelineStageId(runId, "lead", 1), runId,
        stage: "lead", generation: 1, manifestS3Key: `runs/${runId}/domains-manifest.json`,
        manifestFingerprint: "a".repeat(64), manifestProducedAt: now, expectedCount: 0,
        state: "completed", completedAt: now } });
      const registered = await coordinator.registerStage({ runId, stage: "traffic_crux", generation: 1,
        manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint: "a".repeat(64),
        manifestProducedAt: now, tasks: [{ itemKey: shopId, inputFingerprint: "b".repeat(64) }] }, now);
      const taskToken = randomUUID(); const taskClaim = await coordinator.claimTask({ runId, stage: "traffic_crux",
        generation: 1, itemKey: shopId, inputFingerprint: "b".repeat(64), owner: "fixture", token: taskToken,
        leaseDurationMs: 60000 }, now);
      await coordinator.recordTerminal({ taskId: taskClaim.task.id, token: taskToken,
        inputFingerprint: "b".repeat(64), state: "succeeded", artifactS3Key: "runs/final.json",
        artifactFingerprint: "c".repeat(64) }, now);
      await prisma.dataForSeoRequestLedger.create({ data: { requestFingerprint, runId, targetCount: 1,
        scopeKey: "worldwide", state: "succeeded", resultFingerprint: batchFingerprint,
        providerCostUsd: 0.01, completedAt: now } });
      const token = randomUUID(); assert.equal((await coordinator.claimAggregator({ runId, stage: "traffic_crux",
        generation: 1, owner: "gr8", token, leaseDurationMs: 120000 }, new Date(now.getTime() + 1))).outcome, "owned");
      await prisma.pipelineStage.update({ where: { id: registered.stage.id }, data: {
        aggregationLeaseExpiresAt: new Date(Date.now() + 120000)
      } });
      await prisma.shopWork.create({ data: {
        id: shopWorkId(shopId, "crux_bigquery", "month:202607"), shopId,
        workType: "crux_bigquery", scopeKey: "month:202607", state: "processing",
        processingRunId: runId, processingPipelineTaskId: taskClaim.task.id, startedAt: now
      } });
      const resolvedTerminalWork = await repository.readAwsTerminalCruxBigQueryWork({
        runId, generation: 1, aggregationToken: token,
        candidates: [{ shopId, pipelineTaskId: taskClaim.task.id, state: "contract_mismatch" }]
      });
      assert.deepEqual(resolvedTerminalWork, [{ shopId, pipelineTaskId: taskClaim.task.id,
        state: "contract_mismatch", scopeKey: "month:202607" }]);
      const input = { runId, generation: 1, stageId: registered.stage.id, aggregationToken: token,
        cacheRows: [0, 1].map(() => ({ source: "crux_rest", identity: "https://fixture.example",
          scopeKey: "current", metricSetKey: trafficConfig.crux.rest.metricSetKey,
          contractVersion: trafficConfig.crux.rest.contractVersion, state: "no_coverage",
          fetchedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86400000).toISOString() })),
        leadTrafficRows: ["dataforseo", "crux_rest", "crux_bigquery"].map((source) => ({
          leadId: lead.id, source, state: "unavailable", contractVersion: source === "dataforseo"
            ? "dataforseo-traffic-v1" : source === "crux_rest" ? "crux-origin-metrics-v1" : "crux-popularity-v1" })),
        leadProfileOutcomes: [{ shopId, state: "existing", profileFingerprint }],
        workOutcomes: resolvedTerminalWork.map((outcome) => ({ ...outcome, workType: "crux_bigquery" })),
        dataForSeoLedgerEvidence: [{ requestFingerprint, scopeKey: "worldwide", targetCount: 1,
          state: "succeeded", resultFingerprint: batchFingerprint }], diagnostics: [],
        trafficSummary: { version: "traffic-enrichment-summary-v1" }, status: {} };
      const steps = ["cache_written", "traffic_written", "work_settled", "profiles_settled",
        "diagnostics_written", "scores_finalized", "grants_written", "stage_completed", "before_run_visibility"];
      for (const failpoint of steps) {
        await assert.rejects(repository.publishAwsFinalResults(input, new Date(now.getTime() + 2), {
          afterStep(step) { if (step === failpoint) throw new Error(`fail:${step}`); } }));
        assert.equal((await prisma.run.findUnique({ where: { id: runId } })).resultsAvailable, false);
        assert.equal(await prisma.leadTrafficEnrichment.count({ where: { runId } }), 0);
        assert.equal(await prisma.userShop.count({ where: { userId: ownerId } }), 0);
        assert.equal((await prisma.shopWork.findUnique({ where: {
          id: shopWorkId(shopId, "crux_bigquery", "month:202607") } })).state, "processing");
        assert.equal((await prisma.pipelineStage.findUnique({ where: { id: registered.stage.id } })).state, "aggregating");
      }
      const competingRunId = "run_gr8_competing_publication_1";
      await prisma.run.create({ data: { id: competingRunId, state: "running", phase: "scraping",
        stage: "aws_traffic_crux", normalizedShopTypes: [], progress: {}, executionBackend: "aws",
        pipelineGeneration: 1, resultsAvailable: false } });
      await prisma.shopWork.update({ where: {
        id: shopWorkId(shopId, "crux_bigquery", "month:202607") }, data: {
        processingRunId: competingRunId,
        processingPipelineTaskId: "pipeline_task_competing_publication_owner"
      } });
      const published = await repository.publishAwsFinalResults(input, new Date(now.getTime() + 3));
      assert.equal(published.run.resultsAvailable, true); assert.equal(published.stage.state, "completed");
      assert.equal(await prisma.leadTrafficEnrichment.count({ where: { runId } }), 3);
      assert.equal(await prisma.trafficEnrichmentCache.count(), 1);
      assert.equal(await prisma.userShop.count({ where: { userId: ownerId, shopId } }), 1);
      const sharedWork = await prisma.shopWork.findUnique({ where: {
        id: shopWorkId(shopId, "crux_bigquery", "month:202607") } });
      assert.equal(sharedWork.state, "processing");
      assert.equal(sharedWork.processingRunId, competingRunId);
      assert.equal((await prisma.dataForSeoRequestLedger.findUnique({ where: { requestFingerprint } })).resultFingerprint,
        batchFingerprint);
    } finally { await prisma?.$disconnect(); await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect(); }
  });

test("G-R20 publishes 1,000 domains and 12,000 work outcomes within the locked transaction timeout",
  { skip: !enabled, timeout: 180000 }, async () => {
    const schema = `gr20_final_scale_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl); prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const repository = new PrismaRunRepository(prisma);
      const now = new Date("2026-08-14T01:00:00.000Z");
      const runId = "run_gr20_final_scale_00001";
      const stageId = pipelineStageId(runId, "traffic_crux", 1); const aggregationToken = randomUUID();
      const leadFixture = (await load("lead-results.valid.json")).success.lead;
      const shops = Array.from({ length: 1000 }, (_, index) => ({
        id: `shop_gr20_final_${String(index).padStart(4, "0")}`,
        stableKey: `domain:gr20-final-${index}.example`, canonicalUrl: `https://gr20-final-${index}.example`,
        resolvedDomain: `gr20-final-${index}.example`
      }));
      const tasks = shops.map((shop) => ({ id: pipelineTaskId(stageId, shop.id), stageId, itemKey: shop.id,
        inputFingerprint: fingerprintJson({ shopId: shop.id }), state: "succeeded", terminalAt: now,
        artifactS3Key: `runs/${runId}/domains/${shop.id}/traffic-crux.json`,
        artifactFingerprint: fingerprintJson({ artifact: shop.id }) }));
      await prisma.run.create({ data: { id: runId, state: "running", phase: "scraping",
        stage: "aws_traffic_crux", normalizedShopTypes: [], progress: {}, executionBackend: "aws",
        pipelineGeneration: 1, trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({
          dataForSeoEnrichmentEnabled: true }),
        awsProviderConfig: {}, resultsAvailable: false } });
      await prisma.pipelineStage.create({ data: { id: stageId, runId, stage: "traffic_crux", generation: 1,
        manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint: "a".repeat(64),
        manifestProducedAt: now, expectedCount: 1000, terminalCount: 1000, succeededCount: 1000,
        state: "aggregating", aggregationOwner: "gr20", aggregationLeaseToken: aggregationToken,
        aggregationLeaseAcquiredAt: now, aggregationLeaseExpiresAt: new Date(now.getTime() + 120000) } });
      await prisma.shop.createMany({ data: shops });
      await prisma.pipelineTask.createMany({ data: tasks });
      await prisma.lead.createMany({ data: shops.map((shop, index) => ({ ...leadRecordToCreate(runId,
        `lead_gr20_final_${String(index).padStart(4, "0")}`, { ...leadFixture,
          resolved_domain: shop.resolvedDomain, final_url: shop.canonicalUrl, canonical_url: shop.canonicalUrl }),
      shopId: shop.id })) });
      const scopes = ["worldwide", ...Array.from({ length: 9 }, (_, index) => `country:G${index}:${1000 + index}`)];
      const workKeys = [
        ...scopes.map((scopeKey) => ({ workType: "dataforseo", scopeKey })),
        { workType: "crux_rest", scopeKey: "current" },
        { workType: "crux_bigquery", scopeKey: "202607" }
      ];
      const outcomeStates = ["available", "no_coverage", "ambiguous", "failed"];
      const trafficWork = shops.flatMap((shop, shopIndex) => workKeys.map((key, workIndex) => {
        const outcomeState = workIndex === 11 ? "reused" : outcomeStates[workIndex % 4];
        const targetState = ["available", "no_coverage", "reused"].includes(outcomeState) ? "completed"
          : outcomeState === "ambiguous" ? "ambiguous" : "failed";
        return { id: shopWorkId(shop.id, key.workType, key.scopeKey), shopId: shop.id, ...key,
          state: workIndex === 0 ? "processing" : targetState,
          ...(workIndex === 0 ? { processingRunId: runId, processingPipelineTaskId: tasks[shopIndex].id,
            startedAt: now, safeErrorCode: "STALE_SAFE_ERROR", safeErrorMessage: "STALE_SAFE_ERROR" } : {}) };
      }));
      const profileWork = shops.map((shop, index) => ({ id: shopWorkId(shop.id, "lead_discovery", "current"),
        shopId: shop.id, workType: "lead_discovery", scopeKey: "current", state: "processing",
        processingRunId: runId, processingPipelineTaskId: tasks[index].id, startedAt: now }));
      await prisma.shopWork.createMany({ data: [...trafficWork, ...profileWork] });
      const workOutcomes = shops.flatMap((shop, shopIndex) => workKeys.map((key, workIndex) => ({
        shopId: shop.id, ...key, pipelineTaskId: tasks[shopIndex].id,
        state: workIndex === 11 ? "reused" : outcomeStates[workIndex % 4]
      })));
      const input = { runId, generation: 1, stageId, aggregationToken, cacheRows: [], leadTrafficRows: [],
        leadProfileOutcomes: shops.map((shop, index) => ({ shopId: shop.id, state: "failed",
          sourceTaskId: tasks[index].id })), workOutcomes, dataForSeoLedgerEvidence: [],
        diagnostics: [], trafficSummary: { version: "traffic-enrichment-summary-v1" }, status: {} };
      let visibleBeforeFinalWrite = null; const started = Date.now(); const timings = [];
      let published;
      try {
        published = await repository.publishAwsFinalResults(input, now, { async afterStep(step) {
          timings.push([step, Date.now() - started]);
          if (step === "before_run_visibility") {
            const [observed] = await base.$queryRawUnsafe(
              `SELECT "resultsAvailable" FROM "${schema}"."Run" WHERE "id" = $1`, runId);
            visibleBeforeFinalWrite = observed.resultsAvailable;
          }
        } });
      } catch (error) {
        throw new Error(`maximum publication failed at ${JSON.stringify(timings)}`, { cause: error });
      }
      assert.ok(Date.now() - started < 15000);
      assert.equal(visibleBeforeFinalWrite, false);
      assert.equal(published.run.resultsAvailable, true); assert.equal(published.run.state, "completed");
      assert.equal(published.stage.state, "completed"); assert.match(published.resultFingerprint, /^[a-f0-9]{64}$/u);
      assert.equal(await prisma.shopWork.count({ where: { shopId: { in: shops.map(({ id }) => id) },
        workType: { in: ["dataforseo", "crux_rest", "crux_bigquery"] } } }), 12000);
      assert.equal(await prisma.shopWork.count({ where: { workType: "lead_discovery", state: "failed" } }), 1000);
      assert.equal(await prisma.shopWork.count({ where: { state: "completed", workType: { in:
        ["dataforseo", "crux_rest", "crux_bigquery"] } } }), 7000);
      assert.equal(await prisma.shopWork.count({ where: { state: "ambiguous" } }), 3000);
      assert.equal(await prisma.shopWork.count({ where: { state: "failed", workType: { in:
        ["dataforseo", "crux_rest", "crux_bigquery"] } } }), 2000);
      assert.equal(await prisma.shopLeadProfile.count(), 0);
      assert.equal(await prisma.lead.count({ where: { runId, shopLeadProfileId: null, scoringVersion: 3 } }), 1000);
      assert.equal(await prisma.userShop.count(), 0);
      assert.equal(await prisma.userShopDiscovery.count(), 0);
      assert.equal((await prisma.pipelineStage.findUnique({ where: { id: stageId } })).state, "completed");
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
