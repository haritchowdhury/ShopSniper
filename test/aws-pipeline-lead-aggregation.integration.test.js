import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { PrismaRunRepository } from "../src/prisma-run-repository.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/aws-pipeline/v1/${name}`, import.meta.url)));

test("G10 atomically materializes a private reused Lead and a zero traffic stage without owner grants",
  { skip: !enabled, timeout: 120000 }, async () => {
    const schema = `g10_lead_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prisma;
    let step = "migration";
    try {
      deployPrismaMigrations(scopedUrl); prisma = createPrismaClient(scopedUrl);
      step = "migration verification";
      await assertMigrationStayedInSchema(prisma, schema);
      const coordinator = new PipelineCoordinatorRepository(prisma);
      const repository = new PrismaRunRepository(prisma);
      const manifest = await load("domain-manifest.valid.json");
      const fixture = await load("lead-results.valid.json");
      const domain = manifest.domains[0];
      const now = new Date("2026-08-12T12:00:00.000Z");
      step = "fixture writes";
      await prisma.run.create({ data: { id: manifest.runId, ownerId: "g10_owner", state: "running",
        phase: "scraping", stage: "aws_lead", normalizedShopTypes: [], progress: {}, executionBackend: "aws",
        pipelineGeneration: 1, resultsAvailable: false } });
      await prisma.shop.create({ data: { id: domain.shopId, ...domain.identity,
        createdAt: new Date(now.getTime() - 1000), updatedAt: new Date(now.getTime() - 1000) } });
      await prisma.runStore.create({ data: { id: domain.runStoreId, runId: manifest.runId,
        shopId: domain.shopId, state: "processing", candidatePayload: domain.candidatePayload } });
      await prisma.shopLeadProfile.create({ data: { shopId: domain.shopId, state: "completed",
        profilePayload: fixture.success.profile, updatedAt: new Date(now.getTime() - 500) } });
      const manifestFingerprint = "a".repeat(64);
      const lead = await coordinator.registerStage({ runId: manifest.runId, stage: "lead", generation: 1,
        manifestS3Key: `runs/${manifest.runId}/domains-manifest.json`, manifestFingerprint,
        manifestProducedAt: now, tasks: [] }, now);
      const token = randomUUID();
      assert.equal((await coordinator.claimAggregator({ runId: manifest.runId, stage: "lead", generation: 1,
        owner: "g10", token, leaseDurationMs: 120000 }, new Date(now.getTime() + 1))).outcome, "owned");
      const profileFingerprint = fingerprintJson(fixture.success.profile);
      step = "reusable profile read";
      const selected = await repository.readAwsReusableProfiles({ runId: manifest.runId, generation: 1,
        stageId: lead.stage.id, aggregationToken: token, evaluatedAt: now,
        selections: [{ shopId: domain.shopId, profileShopId: domain.shopId, profileFingerprint,
          stableIdentity: domain.identity.stableKey }] });
      assert.equal(selected.profiles.length, 1);
      step = "lead checkpoint publication";
      const published = await repository.publishAwsLeadCheckpoint({ runId: manifest.runId, generation: 1,
        stageId: lead.stage.id, aggregationToken: token, outcomes: [{ shopId: domain.shopId,
          runStoreId: domain.runStoreId, state: "completed", lead: fixture.success.lead,
          profileReusable: true, profile: fixture.success.profile }], trafficDomains: [],
        domainStageManifestKey: `runs/${manifest.runId}/domains-manifest.json`,
        domainStageManifestFingerprint: manifestFingerprint, manifestProducedAt: now },
      new Date(now.getTime() + 2));
      assert.equal(published.summary.qualified, 1);
      assert.equal(published.dispatchItems.length, 0);
      step = "post-commit assertions";
      const [run, storedLead, runStore, userShops, discoveries, profiles] = await Promise.all([
        prisma.run.findUnique({ where: { id: manifest.runId } }),
        prisma.lead.findUnique({ where: { runId_shopId: { runId: manifest.runId, shopId: domain.shopId } } }),
        prisma.runStore.findUnique({ where: { id: domain.runStoreId } }), prisma.userShop.count(),
        prisma.userShopDiscovery.count(), prisma.shopLeadProfile.count()
      ]);
      assert.equal(run.resultsAvailable, false);
      assert.equal(run.stage, "aws_traffic_crux");
      assert.equal(storedLead.shopLeadProfileId, domain.shopId);
      assert.equal(runStore.state, "completed");
      assert.equal(userShops, 0); assert.equal(discoveries, 0); assert.equal(profiles, 1);
      assert.equal((await prisma.pipelineStage.findUnique({ where: { id: lead.stage.id } })).state, "completed");
      assert.equal((await prisma.pipelineStage.findFirst({ where: { runId: manifest.runId,
        stage: "traffic_crux" } })).expectedCount, 0);
    } catch (error) {
      throw new Error(`G10 integration failed during ${step}: ${error?.message || error?.type || "unknown"}`, { cause: error });
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
