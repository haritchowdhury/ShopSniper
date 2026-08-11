import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrismaClient } from "../src/prisma-client.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fp = (character) => character.repeat(64);

function scopedDatabaseUrl(connectionString, schema) {
  const url = new URL(connectionString);
  url.searchParams.set("schema", schema);
  return url.toString();
}

function deploy(databaseUrl, configPath) {
  const result = spawnSync("npx", ["prisma", "migrate", "deploy", "--config", configPath], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: "", PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1" },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `migration deploy failed: ${result.stderr || result.stdout}`);
}

async function preG5MigrationConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "email-scraper-g5-"));
  const migrationRoot = path.join(directory, "migrations");
  await fs.mkdir(migrationRoot);
  await fs.copyFile(path.join(projectRoot, "prisma", "schema.prisma"), path.join(directory, "schema.prisma"));
  await fs.copyFile(path.join(projectRoot, "prisma", "migrations", "migration_lock.toml"), path.join(migrationRoot, "migration_lock.toml"));
  const names = await fs.readdir(path.join(projectRoot, "prisma", "migrations"));
  for (const name of names.filter((name) => /^\d/u.test(name) && name !== "20260811120000_aws_pipeline_coordinator").sort()) {
    await fs.cp(path.join(projectRoot, "prisma", "migrations", name), path.join(migrationRoot, name), { recursive: true });
  }
  const configPath = path.join(directory, "prisma.config.ts");
  await fs.writeFile(configPath,
    `import { defineConfig } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, "node_modules", "prisma", "config.js")).href)};\nexport default defineConfig({ schema: ${JSON.stringify(path.join(directory, "schema.prisma"))}, migrations: { path: ${JSON.stringify(migrationRoot)} }, datasource: { url: process.env.DATABASE_URL } });\n`,
    "utf8");
  return { directory, configPath };
}

async function createAwsRun(prisma, id) {
  return prisma.run.create({ data: {
    id, ownerId: "g5_owner", state: "running", phase: "scraping", stage: "aws_discovery",
    normalizedShopTypes: [], progress: {}, executionBackend: "aws", pipelineGeneration: 1
  } });
}

function registration(runId, stage, tasks) {
  return { runId, stage, generation: 1, manifestS3Key: `runs/${runId}/${stage}-manifest.json`,
    manifestFingerprint: fp("a"), tasks };
}

test("G5 migration replays and preserves pre-migration rows",
  { skip: !enabled, timeout: 120_000 }, async () => {
    const schema = `g5_migration_${Date.now()}_${process.pid}`;
    const base = createPrismaClient(process.env.TEST_DATABASE_URL);
    const scopedUrl = scopedDatabaseUrl(process.env.TEST_DATABASE_URL, schema);
    const baseline = await preG5MigrationConfig();
    let prisma;
    try {
      await base.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      deploy(scopedUrl, baseline.configPath);
      prisma = createPrismaClient(scopedUrl);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "${schema}"."Run" ("id", "ownerId", "state", "stage", "normalizedShopTypes", "progress", "resultsAvailable")
        VALUES ('run_legacy_g5_fixture_0001', 'legacy_owner', 'completed', 'completed', '[]'::jsonb, '{}'::jsonb, true)
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "${schema}"."DataForSeoRequestLedger"
          ("requestFingerprint", "runId", "targetCount", "scopeKey", "state", "updatedAt")
        VALUES ('${fp("f")}', 'run_legacy_g5_fixture_0001', 3, 'worldwide', 'succeeded', CURRENT_TIMESTAMP)
      `);
      await prisma.$disconnect();
      prisma = undefined;
      deploy(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      deploy(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prisma = createPrismaClient(scopedUrl);
      const legacy = await prisma.run.findUnique({ where: { id: "run_legacy_g5_fixture_0001" } });
      assert.equal(legacy.executionBackend, "local");
      assert.equal(legacy.pipelineGeneration, 1);
      const ledger = await prisma.dataForSeoRequestLedger.findUnique({ where: { requestFingerprint: fp("f") } });
      assert.equal(ledger.targetCount, 3);
      assert.equal(ledger.resultFingerprint, null);
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
      await fs.rm(baseline.directory, { recursive: true, force: true });
    }
  });

test("G5 coordinator CAS protocol holds under real PostgreSQL concurrency",
  { skip: !enabled, timeout: 180_000 }, async () => {
    const schema = `g5_${Date.now()}_${process.pid}`;
    const base = createPrismaClient(process.env.TEST_DATABASE_URL);
    const scopedUrl = scopedDatabaseUrl(process.env.TEST_DATABASE_URL, schema);
    let prismaA;
    let prismaB;
    try {
      await base.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      deploy(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prismaA = createPrismaClient(scopedUrl);
      prismaB = createPrismaClient(scopedUrl);
      const repositoryA = new PipelineCoordinatorRepository(prismaA);
      const repositoryB = new PipelineCoordinatorRepository(prismaB);

      const now = new Date();
      const run1 = "run_g5_concurrency_000001";
      await createAwsRun(prismaA, run1);
      const registeredInput = registration(run1, "discovery", [
        { itemKey: "query_a", inputFingerprint: fp("1") },
        { itemKey: "query_b", inputFingerprint: fp("2") }
      ]);
      const registrations = await Promise.all([
        repositoryA.registerStage(registeredInput, now), repositoryB.registerStage(registeredInput, now)
      ]);
      assert.deepEqual(registrations.map(({ outcome }) => outcome).sort(), ["created", "replayed"]);
      await assert.rejects(repositoryA.registerStage({ ...registeredInput, manifestFingerprint: fp("b") }, now),
        (error) => error.code === "PIPELINE_INPUT_CONFLICT");
      await assert.rejects(repositoryA.registerStage({ ...registeredInput, tasks: [registeredInput.tasks[0]] }, now),
        (error) => error.code === "PIPELINE_INPUT_CONFLICT");
      const stageId = registrations[0].stage.id;
      assert.deepEqual(registrations[0].tasks.map(({ itemKey }) => itemKey), ["query_a", "query_b"]);
      assert.equal((await repositoryA.recordDispatch({ stageId, itemKeys: ["query_a", "query_b"] }, now)).count, 2);

      const claimA = await repositoryA.claimTask({ runId: run1, stage: "discovery", generation: 1,
        itemKey: "query_a", inputFingerprint: fp("1"), owner: "worker_a", token: "00000000-0000-4000-8000-000000000001",
        leaseDurationMs: 60000 }, now);
      const claimB = await repositoryB.claimTask({ runId: run1, stage: "discovery", generation: 1,
        itemKey: "query_b", inputFingerprint: fp("2"), owner: "worker_b", token: "00000000-0000-4000-8000-000000000002",
        leaseDurationMs: 60000 }, now);
      assert.equal(claimA.outcome, "owned");
      assert.equal(claimB.outcome, "owned");
      const renewedTask = await repositoryA.renewTask({ taskId: claimA.task.id, token: claimA.task.leaseToken,
        leaseDurationMs: 60000 }, new Date(now.getTime() + 1000));
      assert.equal(renewedTask.expiresAt.getTime(), now.getTime() + 61_000);

      const terminalA = { taskId: claimA.task.id, token: claimA.task.leaseToken, inputFingerprint: fp("1"),
        state: "succeeded", artifactS3Key: "runs/a.json", artifactFingerprint: fp("3") };
      const terminalB = { taskId: claimB.task.id, token: claimB.task.leaseToken, inputFingerprint: fp("2"),
        state: "failed", artifactS3Key: "runs/b.json", artifactFingerprint: fp("4"),
        safeErrorCode: "PIPELINE_PROVIDER_UNAVAILABLE", safeErrorMessage: "PIPELINE_PROVIDER_UNAVAILABLE" };
      await repositoryB.recordTerminal(terminalB, new Date(now.getTime() + 2000));
      const duplicateTerminal = await Promise.all([
        repositoryA.recordTerminal(terminalA, new Date(now.getTime() + 3000)),
        repositoryB.recordTerminal(terminalA, new Date(now.getTime() + 3000))
      ]);
      assert.deepEqual(duplicateTerminal.map(({ outcome }) => outcome).sort(), ["recorded", "replayed"]);
      const ready = await prismaA.pipelineStage.findUnique({ where: { id: stageId } });
      assert.deepEqual({ state: ready.state, terminal: ready.terminalCount, succeeded: ready.succeededCount, failed: ready.failedCount },
        { state: "ready", terminal: 2, succeeded: 1, failed: 1 });

      const aggregators = await Promise.all([
        repositoryA.claimAggregator({ runId: run1, stage: "discovery", generation: 1, owner: "aggregator_a",
          token: "10000000-0000-4000-8000-000000000001", leaseDurationMs: 120000 }, new Date(now.getTime() + 4000)),
        repositoryB.claimAggregator({ runId: run1, stage: "discovery", generation: 1, owner: "aggregator_b",
          token: "10000000-0000-4000-8000-000000000002", leaseDurationMs: 120000 }, new Date(now.getTime() + 4000))
      ]);
      assert.equal(aggregators.filter(({ outcome }) => outcome === "owned").length, 1);
      assert.equal(aggregators.filter(({ outcome }) => outcome === "busy").length, 1);
      const winner = aggregators.find(({ outcome }) => outcome === "owned");
      const loserToken = aggregators.find(({ outcome }) => outcome === "busy") === aggregators[0]
        ? "10000000-0000-4000-8000-000000000001" : "10000000-0000-4000-8000-000000000002";
      await assert.rejects(repositoryA.completeAggregator({ stageId, token: loserToken, state: "completed" },
        new Date(now.getTime() + 5000)), (error) => error.code === "PIPELINE_LEASE_LOST");
      const complete = await repositoryA.getCompleteStage({ runId: run1, stage: "discovery", generation: 1,
        token: winner.stage.aggregationLeaseToken });
      assert.deepEqual(complete.tasks.map(({ itemKey }) => itemKey), ["query_a", "query_b"]);
      await repositoryA.renewAggregator({ stageId, token: winner.stage.aggregationLeaseToken, leaseDurationMs: 120000 },
        new Date(now.getTime() + 5000));
      await repositoryA.completeAggregator({ stageId, token: winner.stage.aggregationLeaseToken, state: "completed" },
        new Date(now.getTime() + 6000));

      const zeroRun = "run_g5_zero_count_000001";
      await createAwsRun(prismaA, zeroRun);
      const zero = await repositoryA.registerStage(registration(zeroRun, "lead", []), now);
      assert.equal(zero.stage.state, "ready");
      const zeroStale = await repositoryA.claimAggregator({ runId: zeroRun, stage: "lead", generation: 1,
        owner: "zero_aggregator", token: "20000000-0000-4000-8000-000000000001", leaseDurationMs: 120000 }, now);
      assert.equal(zeroStale.outcome, "owned");
      const zeroReclaimed = await repositoryB.claimAggregator({ runId: zeroRun, stage: "lead", generation: 1,
        owner: "zero_reclaimer", token: "20000000-0000-4000-8000-000000000002", leaseDurationMs: 120000 },
        new Date(now.getTime() + 120001));
      assert.equal(zeroReclaimed.outcome, "owned");
      await assert.rejects(repositoryA.completeAggregator({ stageId: zero.stage.id,
        token: zeroStale.stage.aggregationLeaseToken, state: "completed" }, new Date(now.getTime() + 120002)),
      (error) => error.code === "PIPELINE_LEASE_LOST");
      await repositoryB.completeAggregator({ stageId: zero.stage.id,
        token: zeroReclaimed.stage.aggregationLeaseToken, state: "completed" }, new Date(now.getTime() + 120002));

    } finally {
      await prismaA?.$disconnect();
      await prismaB?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });

test("G5 expired leases, cancellation, and recovery remain fenced and bounded",
  { skip: !enabled, timeout: 180_000 }, async () => {
    const schema = `g5_recovery_${Date.now()}_${process.pid}`;
    const base = createPrismaClient(process.env.TEST_DATABASE_URL);
    const scopedUrl = scopedDatabaseUrl(process.env.TEST_DATABASE_URL, schema);
    let prismaA;
    let prismaB;
    try {
      await base.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      deploy(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prismaA = createPrismaClient(scopedUrl);
      prismaB = createPrismaClient(scopedUrl);
      const repositoryA = new PipelineCoordinatorRepository(prismaA);
      const repositoryB = new PipelineCoordinatorRepository(prismaB);
      const now = new Date();

      const expiredRun = "run_g5_expired_claim_0001";
      await createAwsRun(prismaA, expiredRun);
      await repositoryA.registerStage(registration(expiredRun, "lead", [{ itemKey: "shop_a", inputFingerprint: fp("5") }]), now);
      const stale = await repositoryA.claimTask({ runId: expiredRun, stage: "lead", generation: 1, itemKey: "shop_a",
        inputFingerprint: fp("5"), owner: "stale", token: "30000000-0000-4000-8000-000000000001",
        leaseDurationMs: 60000 }, now);
      const reclaimedAt = new Date(now.getTime() + 60001);
      const reclaimed = await repositoryB.claimTask({ runId: expiredRun, stage: "lead", generation: 1, itemKey: "shop_a",
        inputFingerprint: fp("5"), owner: "fresh", token: "30000000-0000-4000-8000-000000000002",
        leaseDurationMs: 60000 }, reclaimedAt);
      assert.equal(reclaimed.outcome, "owned");
      await assert.rejects(repositoryA.recordTerminal({ taskId: stale.task.id, token: stale.task.leaseToken,
        inputFingerprint: fp("5"), state: "succeeded", artifactS3Key: "runs/stale.json", artifactFingerprint: fp("6") },
        new Date(reclaimedAt.getTime() + 1)), (error) => error.code === "PIPELINE_LEASE_LOST");
      await repositoryB.recordTerminal({ taskId: reclaimed.task.id, token: reclaimed.task.leaseToken,
        inputFingerprint: fp("5"), state: "succeeded", artifactS3Key: "runs/fresh.json", artifactFingerprint: fp("7") },
        new Date(reclaimedAt.getTime() + 2));

      const cancelRun = "run_g5_cancellation_00001";
      await createAwsRun(prismaA, cancelRun);
      const cancelStage = await repositoryA.registerStage(registration(cancelRun, "traffic_crux", [
        { itemKey: "shop_a", inputFingerprint: fp("8") }, { itemKey: "shop_b", inputFingerprint: fp("9") }
      ]), now);
      const cancelClaim = await repositoryA.claimTask({ runId: cancelRun, stage: "traffic_crux", generation: 1,
        itemKey: "shop_a", inputFingerprint: fp("8"), owner: "cancelled_worker",
        token: "40000000-0000-4000-8000-000000000001", leaseDurationMs: 60000 }, now);
      const cancelled = await repositoryB.cancelRunGeneration({ runId: cancelRun, generation: 1 }, new Date(now.getTime() + 1));
      assert.equal(cancelled.stages[0].state, "cancelled");
      assert.equal(cancelled.stages[0].cancelledCount, 2);
      assert.ok(cancelled.tasks.every(({ state }) => state === "cancelled"));
      assert.equal((await repositoryA.claimTask({ runId: cancelRun, stage: "traffic_crux", generation: 1,
        itemKey: "shop_b", inputFingerprint: fp("9"), owner: "late", token: "40000000-0000-4000-8000-000000000002",
        leaseDurationMs: 60000 }, new Date(now.getTime() + 2))).outcome, "cancelled");
      await assert.rejects(repositoryA.recordTerminal({ taskId: cancelClaim.task.id, token: cancelClaim.task.leaseToken,
        inputFingerprint: fp("8"), state: "succeeded", artifactS3Key: "runs/late.json", artifactFingerprint: fp("a") },
        new Date(now.getTime() + 2)), (error) => error.code === "PIPELINE_CANCELLED");

      const publicationRun = "run_g5_cancel_publish_0001";
      await createAwsRun(prismaA, publicationRun);
      const publicationStage = await repositoryA.registerStage(registration(publicationRun, "lead", []), now);
      const publicationClaim = await repositoryA.claimAggregator({ runId: publicationRun, stage: "lead", generation: 1,
        owner: "publication_owner", token: "50000000-0000-4000-8000-000000000001", leaseDurationMs: 120000 }, now);
      await repositoryB.cancelRunGeneration({ runId: publicationRun, generation: 1 }, new Date(now.getTime() + 1));
      await assert.rejects(repositoryA.completeAggregator({ stageId: publicationStage.stage.id,
        token: publicationClaim.stage.aggregationLeaseToken, state: "completed" }, new Date(now.getTime() + 2)),
      (error) => error.code === "PIPELINE_CANCELLED");

      const recoveryRun = "run_g5_recovery_bound_0001";
      await createAwsRun(prismaA, recoveryRun);
      const recoveryTasks = Array.from({ length: 105 }, (_, index) => ({
        itemKey: `item_${String(index).padStart(3, "0")}`, inputFingerprint: fp((index % 10).toString())
      }));
      const recoveryStage = await repositoryA.registerStage(registration(recoveryRun, "discovery", recoveryTasks), now);
      const recovery = await repositoryA.listRecoverable({ olderThan: new Date(now.getTime() + 300000), limit: 100 },
        new Date(now.getTime() + 300001));
      assert.equal(recovery.tasks.length + recovery.stages.length, 100);
      assert.ok(recovery.tasks.every(({ stageId: id }) => id === recoveryStage.stage.id));
      assert.equal(await prismaA.pipelineTask.count({ where: { stageId: recoveryStage.stage.id } }), 105);
      assert.equal(cancelStage.tasks.length, 2);
    } finally {
      await prismaA?.$disconnect();
      await prismaB?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
