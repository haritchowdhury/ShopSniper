import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository } from "../src/prisma-run-repository.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const fp = (value) => value.repeat(64);

test("AWS lead work remains independent across runs while preserving cache reuse",
  { skip: !enabled, timeout: 120000 }, async () => {
    const schema = `g9_lead_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl); prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const coordinator = new PipelineCoordinatorRepository(prisma);
      const repository = new PrismaRunRepository(prisma);
      const runId = "run_g9_lead_owner_fixture_01";
      const shopId = "shop_g9leadownerfixture0001";
      await prisma.run.create({ data: { id: runId, ownerId: "g9_owner", state: "running",
        phase: "scraping", stage: "aws_lead", normalizedShopTypes: [], progress: {},
        executionBackend: "aws", pipelineGeneration: 1, resultsAvailable: false } });
      await prisma.shop.create({ data: { id: shopId, stableKey: "g9-owner.myshopify.com",
        myshopifyDomain: "g9-owner.myshopify.com", resolvedDomain: "g9-owner.example",
        canonicalUrl: "https://g9-owner.example/", identityConfidence: 100,
        identityEvidence: { stableHostname: "g9-owner.myshopify.com" } } });
      const now = new Date("2026-08-12T10:00:00.000Z");
      await coordinator.registerStage({ runId, stage: "lead", generation: 1,
        manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint: fp("a"),
        manifestProducedAt: now, tasks: [{ itemKey: shopId, inputFingerprint: fp("b") }] }, now);
      const token = randomUUID();
      const claimed = await coordinator.claimTask({ runId, stage: "lead", generation: 1,
        itemKey: shopId, inputFingerprint: fp("b"), owner: "g9-worker", token,
        leaseDurationMs: 60000 }, new Date(now.getTime() + 1));
      assert.equal(claimed.outcome, "owned");
      assert.deepEqual(await repository.claimAwsLeadWork({ runId, generation: 1,
        taskId: claimed.task.id, taskToken: token, shopId }, new Date(now.getTime() + 2)),
      { outcome: "owned" });
      const work = await prisma.shopWork.findUnique({ where: {
        shopId_workType_scopeKey: { shopId, workType: "lead_discovery", scopeKey: "current" } } });
      assert.equal(work.processingPipelineTaskId, claimed.task.id);
      assert.equal(work.processingLeaseToken, null);
      assert.equal(await prisma.shopLeadProfile.count({ where: { shopId } }), 0);
      assert.deepEqual(await repository.claimAwsLeadWork({ runId, generation: 1,
        taskId: claimed.task.id, taskToken: token, shopId }, new Date(now.getTime() + 3)),
      { outcome: "owned" });
      await assert.rejects(repository.claimAwsLeadWork({ runId, generation: 1,
        taskId: claimed.task.id, taskToken: randomUUID(), shopId }, new Date(now.getTime() + 4)),
      (error) => error.code === "PIPELINE_LEASE_LOST");

      const competingRunId = "run_g9_lead_competing_fixture";
      await prisma.run.create({ data: { id: competingRunId, ownerId: "g9_competitor", state: "running",
        phase: "scraping", stage: "aws_lead", normalizedShopTypes: [], progress: {},
        executionBackend: "aws", pipelineGeneration: 1, resultsAvailable: false } });
      await coordinator.registerStage({ runId: competingRunId, stage: "lead", generation: 1,
        manifestS3Key: `runs/${competingRunId}/domains-manifest.json`, manifestFingerprint: fp("c"),
        manifestProducedAt: now, tasks: [{ itemKey: shopId, inputFingerprint: fp("d") }] }, now);
      const competingToken = randomUUID();
      const competing = await coordinator.claimTask({ runId: competingRunId, stage: "lead", generation: 1,
        itemKey: shopId, inputFingerprint: fp("d"), owner: "g9-competing-worker", token: competingToken,
        leaseDurationMs: 60000 }, new Date(now.getTime() + 5));
      assert.equal(competing.outcome, "owned");
      assert.deepEqual(await repository.claimAwsLeadWork({ runId: competingRunId, generation: 1,
        taskId: competing.task.id, taskToken: competingToken, shopId }, new Date(now.getTime() + 6)),
      { outcome: "owned" });
      assert.equal((await prisma.shopWork.findUnique({ where: {
        shopId_workType_scopeKey: { shopId, workType: "lead_discovery", scopeKey: "current" }
      } })).processingPipelineTaskId, competing.task.id);
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
