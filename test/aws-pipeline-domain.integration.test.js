import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository, trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { parseRunStoreCandidate, runStoreId, shopIdForStableKey,
  stableShopIdentity } from "../src/shop-persistence-contract.js";
import candidateFixture from "./fixtures/aws-pipeline/v1/per-query-discovery.valid.json" with { type: "json" };
import providerFixture from "./fixtures/aws-pipeline/v1/aws-provider-config.valid.json" with { type: "json" };
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const fp = (value) => value.repeat(64);

function domainFor(runId) {
  const candidatePayload = parseRunStoreCandidate(candidateFixture.stores[0].candidatePayload);
  const identity = stableShopIdentity(candidatePayload);
  const shopId = shopIdForStableKey(identity.stableKey);
  return { shopId, runStoreId: runStoreId(runId, shopId), identity, candidatePayload };
}

async function createClaimedDiscovery(prisma, coordinator, runId, now) {
  await prisma.run.create({ data: {
    id: runId, ownerId: "g8_owner", state: "running", phase: "scraping", stage: "aws_discovery",
    normalizedShopTypes: [], progress: {}, executionBackend: "aws", pipelineGeneration: 1,
    trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({}), awsProviderConfig: providerFixture,
    resultsAvailable: false
  } });
  await prisma.queryAudit.create({ data: {
    id: `audit_${runId}`, runId, sequence: 0, query: "pre-review fixture", status: "selected",
    details: { preserved: true }
  } });
  const registered = await coordinator.registerStage({ runId, stage: "discovery", generation: 1,
    manifestS3Key: `runs/${runId}/queries/manifest.json`, manifestFingerprint: fp("a"),
    manifestProducedAt: now, tasks: [] }, now);
  const token = randomUUID();
  const claim = await coordinator.claimAggregator({ runId, stage: "discovery", generation: 1,
    owner: "g8-domain", token, leaseDurationMs: 120000 }, new Date(now.getTime() + 1));
  assert.equal(claim.outcome, "owned");
  return { stageId: registered.stage.id, token };
}

test("G8 atomically checkpoints domains, preserves audits, fences visibility, and rolls back conflicts",
  { skip: !enabled, timeout: 120_000 }, async () => {
    const schema = `g8_domain_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl);
      prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const coordinator = new PipelineCoordinatorRepository(prisma);
      const repository = new PrismaRunRepository(prisma);
      const now = new Date("2026-08-12T10:00:00.000Z");

      const successRun = "run_g8_domain_success_0001";
      const successClaim = await createClaimedDiscovery(prisma, coordinator, successRun, now);
      const successDomain = domainFor(successRun);
      const manifestFingerprint = fp("b");
      const result = await repository.publishAwsDomainCheckpoint({ runId: successRun, generation: 1,
        stageId: successClaim.stageId, aggregationToken: successClaim.token,
        domainStageManifestKey: `runs/${successRun}/domains-manifest.json`,
        domainStageManifestFingerprint: manifestFingerprint, manifestProducedAt: now,
        domains: [successDomain], diagnostics: [{ scope: "query", code: "g8_fixture", details: { safe: true } }],
        leadTasks: [{ itemKey: successDomain.shopId, inputFingerprint: fp("c") }],
        status: { stage: "aws_lead", storesPersisted: 1 }
      }, new Date(now.getTime() + 2));
      assert.equal(result.stage.state, "completed");
      assert.equal(result.leadStage.expectedCount, 1);
      assert.deepEqual(result.dispatchItems, [{ itemKey: successDomain.shopId, inputFingerprint: fp("c") }]);
      assert.equal(await prisma.shop.count({ where: { id: successDomain.shopId } }), 1);
      assert.equal(await prisma.runStore.count({ where: { id: successDomain.runStoreId } }), 1);
      assert.equal(await prisma.runDiagnostic.count({ where: { runId: successRun } }), 1);
      assert.deepEqual((await prisma.queryAudit.findUnique({ where: {
        runId_sequence: { runId: successRun, sequence: 0 }
      } })).details, { preserved: true });
      const successStored = await prisma.run.findUnique({ where: { id: successRun } });
      assert.equal(successStored.stage, "aws_lead");
      assert.equal(successStored.resultsAvailable, false);

      const rollbackRun = "run_g8_domain_rollback_001";
      const rollbackClaim = await createClaimedDiscovery(prisma, coordinator, rollbackRun, now);
      const rollbackDomain = domainFor(rollbackRun);
      await prisma.runDiagnostic.create({ data: { id: `existing_${rollbackRun}`, runId: rollbackRun,
        sequence: 100000, scope: "query", code: "different", details: { preserved: true } } });
      await assert.rejects(repository.publishAwsDomainCheckpoint({ runId: rollbackRun, generation: 1,
        stageId: rollbackClaim.stageId, aggregationToken: rollbackClaim.token,
        domainStageManifestKey: `runs/${rollbackRun}/domains-manifest.json`,
        domainStageManifestFingerprint: fp("d"), manifestProducedAt: now,
        domains: [rollbackDomain], diagnostics: [{ scope: "query", code: "conflict", details: {} }],
        leadTasks: [{ itemKey: rollbackDomain.shopId, inputFingerprint: fp("e") }], status: { stage: "aws_lead" }
      }, new Date(now.getTime() + 2)), (error) => error.code === "PIPELINE_INPUT_CONFLICT");
      assert.equal(await prisma.runStore.count({ where: { id: rollbackDomain.runStoreId } }), 0);
      assert.equal(await prisma.pipelineStage.count({ where: { runId: rollbackRun, stage: "lead" } }), 0);
      const rollbackStage = await prisma.pipelineStage.findUnique({ where: { id: rollbackClaim.stageId } });
      assert.equal(rollbackStage.state, "aggregating");
      const rollbackStored = await prisma.run.findUnique({ where: { id: rollbackRun } });
      assert.equal(rollbackStored.stage, "aws_discovery");
      assert.equal(rollbackStored.resultsAvailable, false);
      assert.deepEqual((await prisma.queryAudit.findUnique({ where: {
        runId_sequence: { runId: rollbackRun, sequence: 0 }
      } })).details, { preserved: true });
      assert.equal(fingerprintJson(rollbackDomain.candidatePayload).length, 64);
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
