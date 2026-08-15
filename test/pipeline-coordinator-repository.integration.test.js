import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrismaClient } from "../src/prisma-client.js";
import { PipelineCoordinatorRepository, assertCompleteAggregatorInTransaction,
  completeAggregatorInTransaction, registerStageInTransaction
} from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository } from "../src/prisma-run-repository.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fp = (character) => character.repeat(64);

async function preG5MigrationConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "email-scraper-g5-"));
  const migrationRoot = path.join(directory, "migrations");
  await fs.mkdir(migrationRoot);
  await fs.copyFile(path.join(projectRoot, "prisma", "schema.prisma"), path.join(directory, "schema.prisma"));
  await fs.copyFile(path.join(projectRoot, "prisma", "migrations", "migration_lock.toml"), path.join(migrationRoot, "migration_lock.toml"));
  const names = await fs.readdir(path.join(projectRoot, "prisma", "migrations"));
  for (const name of names.filter((name) => /^\d/u.test(name) && name < "20260811120000_aws_pipeline_coordinator").sort()) {
    await fs.cp(path.join(projectRoot, "prisma", "migrations", name), path.join(migrationRoot, name), { recursive: true });
  }
  const configPath = path.join(directory, "prisma.config.ts");
  await fs.writeFile(configPath,
    `import { defineConfig } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, "node_modules", "prisma", "config.js")).href)};\nexport default defineConfig({ schema: ${JSON.stringify(path.join(directory, "schema.prisma"))}, migrations: { path: ${JSON.stringify(migrationRoot)} }, datasource: { url: process.env.DATABASE_URL } });\n`,
    "utf8");
  return { directory, configPath };
}

async function preGR3MigrationConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "email-scraper-gr3-"));
  const migrationRoot = path.join(directory, "migrations");
  await fs.mkdir(migrationRoot);
  await fs.copyFile(path.join(projectRoot, "prisma", "schema.prisma"), path.join(directory, "schema.prisma"));
  await fs.copyFile(path.join(projectRoot, "prisma", "migrations", "migration_lock.toml"), path.join(migrationRoot, "migration_lock.toml"));
  const names = await fs.readdir(path.join(projectRoot, "prisma", "migrations"));
  for (const name of names.filter((name) => /^\d/u.test(name) && name < "20260812120000_aws_pipeline_remainder_foundations").sort()) {
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

function registration(runId, stage, tasks, manifestProducedAt = new Date("2026-08-12T00:00:00.000Z")) {
  return { runId, stage, generation: 1, manifestS3Key: `runs/${runId}/${stage}-manifest.json`,
    manifestFingerprint: fp("a"), manifestProducedAt, tasks };
}

test("coordinator registration is independent of PostgreSQL collation for live-shaped query IDs",
  { skip: !enabled, timeout: 120_000 }, async () => {
    const schema = `gr12_collation_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const repository = new PipelineCoordinatorRepository(prisma);
      const runId = "run_collation_pg_fixture_0001";
      await createAwsRun(prisma, runId);
      const tasks = [
        { itemKey: "query_X04IrwiXT8TzOQrm4c_VkAqW", inputFingerprint: fp("1") },
        { itemKey: "query_VFdPdpTksce4k3JPej0IsyEj", inputFingerprint: fp("2") },
        { itemKey: "query_6fAP2PXjJw2RL6NqZ2r1Xrbt", inputFingerprint: fp("3") },
        { itemKey: "query_ljlNnVtzPY5YqXYJnz_zQ10R", inputFingerprint: fp("4") },
        { itemKey: "query_2t4juXx08haUSfn59L37S92T", inputFingerprint: fp("5") },
        { itemKey: "query_Hjqpn1ewPs_cbpvA65hWBmwf", inputFingerprint: fp("6") }
      ];
      const input = registration(runId, "discovery", tasks);
      const created = await repository.registerStage(input, new Date());
      const replayed = await repository.registerStage(input, new Date());
      assert.equal(created.outcome, "created");
      assert.equal(replayed.outcome, "replayed");
      assert.deepEqual(new Map(created.tasks.map((task) => [task.itemKey, task.inputFingerprint])),
        new Map(tasks.map((task) => [task.itemKey, task.inputFingerprint])));
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });

test("G-R29 traffic and final leases are atomically mutually exclusive",
  { skip: !enabled, timeout: 120_000 }, async () => {
    const schema = `gr29_lease_exclusion_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prismaA;
    let prismaB;
    try {
      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prismaA = createPrismaClient(scopedUrl);
      prismaB = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prismaA, schema);
      const trafficA = new PrismaRunRepository(prismaA);
      const trafficB = new PrismaRunRepository(prismaB);
      const coordinatorA = new PipelineCoordinatorRepository(prismaA);
      const coordinatorB = new PipelineCoordinatorRepository(prismaB);
      const now = new Date("2026-08-15T12:00:00.000Z");
      const registerTraffic = async (runId) => {
        await createAwsRun(prismaA, runId);
        return coordinatorA.registerStage(registration(runId, "traffic_crux", []), now);
      };

      const finalFirstRun = "run_gr29_final_first_0001";
      await registerTraffic(finalFirstRun);
      const finalFirst = await coordinatorA.claimAggregator({ runId: finalFirstRun,
        stage: "traffic_crux", generation: 1, owner: "final_first", token: randomUUID(),
        leaseDurationMs: 120000 }, now);
      assert.equal(finalFirst.outcome, "owned");
      assert.equal((await trafficB.claimAwsRunLease({ runId: finalFirstRun, generation: 1,
        owner: "traffic_late", token: randomUUID(), leaseDurationMs: 60000 }, now)).outcome, "busy");

      const trafficFirstRun = "run_gr29_traffic_first_0001";
      await registerTraffic(trafficFirstRun);
      const trafficToken = randomUUID();
      assert.equal((await trafficA.claimAwsRunLease({ runId: trafficFirstRun, generation: 1,
        owner: "traffic_first", token: trafficToken, leaseDurationMs: 60000 }, now)).outcome, "owned");
      assert.equal((await coordinatorB.claimAggregator({ runId: trafficFirstRun,
        stage: "traffic_crux", generation: 1, owner: "final_late", token: randomUUID(),
        leaseDurationMs: 120000 }, now)).outcome, "busy");
      await trafficA.releaseAwsRunLease({ runId: trafficFirstRun, generation: 1,
        token: trafficToken }, new Date(now.getTime() + 1));
      assert.equal((await coordinatorB.claimAggregator({ runId: trafficFirstRun,
        stage: "traffic_crux", generation: 1, owner: "final_after_release", token: randomUUID(),
        leaseDurationMs: 120000 }, new Date(now.getTime() + 2))).outcome, "owned");

      const simultaneousRun = "run_gr29_simultaneous_0001";
      const simultaneousStage = await registerTraffic(simultaneousRun);
      const simultaneousTrafficToken = randomUUID();
      const [trafficClaim, finalClaim] = await Promise.all([
        trafficB.claimAwsRunLease({ runId: simultaneousRun, generation: 1,
          owner: "traffic_simultaneous", token: simultaneousTrafficToken, leaseDurationMs: 60000 }, now),
        coordinatorA.claimAggregator({ runId: simultaneousRun, stage: "traffic_crux", generation: 1,
          owner: "final_simultaneous", token: randomUUID(), leaseDurationMs: 120000 }, now)
      ]);
      assert.deepEqual([trafficClaim.outcome, finalClaim.outcome].sort(), ["busy", "owned"]);
      const [durableRun, durableStage] = await Promise.all([
        prismaA.run.findUnique({ where: { id: simultaneousRun } }),
        prismaA.pipelineStage.findUnique({ where: { id: simultaneousStage.stage.id } })
      ]);
      const trafficOwns = durableRun.leaseExpiresAt instanceof Date && durableRun.leaseExpiresAt > now;
      const finalOwns = durableStage.state === "aggregating" &&
        durableStage.aggregationLeaseExpiresAt instanceof Date && durableStage.aggregationLeaseExpiresAt > now;
      assert.notEqual(trafficOwns, finalOwns);
    } finally {
      await prismaA?.$disconnect();
      await prismaB?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });

test("G5 migration replays and preserves pre-migration rows",
  { skip: !enabled, timeout: 120_000 }, async () => {
    const schema = `g5_migration_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    const baseline = await preG5MigrationConfig();
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl, baseline.configPath);
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
      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
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

test("G-R3 migration backfills stage timestamps and preserves nullable provider configuration",
  { skip: !enabled, timeout: 180_000 }, async () => {
    const schema = `gr3_migration_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    const baseline = await preGR3MigrationConfig();
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl, baseline.configPath);
      const createdAt = new Date("2026-08-11T12:34:56.789Z");
      prisma = createPrismaClient(scopedUrl);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "${schema}"."Run"
          ("id","ownerId","state","phase","stage","normalizedShopTypes","progress","resultsAvailable",
           "executionBackend","pipelineGeneration","queryRevision")
        VALUES ('run_gr3_legacy_stage_0001','g5_owner','running','scraping','aws_discovery','[]'::jsonb,'{}'::jsonb,
          false,'aws',1,0)
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "${schema}"."PipelineStage"
          ("id","runId","stage","generation","manifestS3Key","manifestFingerprint","expectedCount","createdAt","updatedAt")
        VALUES ('stage_gr3_legacy_0001','run_gr3_legacy_stage_0001','discovery',1,'runs/legacy.json','${fp("a")}',0,
          '${createdAt.toISOString()}'::timestamptz,'${createdAt.toISOString()}'::timestamptz)
      `);
      await prisma.$disconnect();
      prisma = undefined;
      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const [run, stage, indexRows] = await Promise.all([
        prisma.run.findUnique({ where: { id: "run_gr3_legacy_stage_0001" } }),
        prisma.pipelineStage.findUnique({ where: { id: "stage_gr3_legacy_0001" } }),
        prisma.$queryRaw`SELECT indexdef FROM pg_indexes WHERE schemaname = ${schema} AND indexname = 'ShopWork_processingPipelineTaskId_idx'`
      ]);
      assert.equal(run.awsProviderConfig, null);
      assert.equal(stage.manifestProducedAt.toISOString(), createdAt.toISOString());
      assert.equal(indexRows.length, 1);
      assert.doesNotMatch(indexRows[0].indexdef, /UNIQUE/u);
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
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prismaA;
    let prismaB;
    try {
      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prismaA = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prismaA, schema);
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
      await assert.rejects(repositoryA.registerStage({ ...registeredInput,
        manifestProducedAt: new Date(registeredInput.manifestProducedAt.getTime() + 1) }, now),
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

      const rollbackRun = "run_gr3_outer_rollback_0001";
      await createAwsRun(prismaA, rollbackRun);
      const rollbackRegistration = registration(rollbackRun, "lead", []);
      await assert.rejects(prismaA.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT set_config('search_path', ${schema}, true)`;
        await registerStageInTransaction(transaction, rollbackRegistration, now);
        throw new Error("INJECT_AFTER_REGISTRATION");
      }), /INJECT_AFTER_REGISTRATION/u);
      assert.equal(await prismaA.pipelineStage.count({ where: { runId: rollbackRun } }), 0);

      const composable = await repositoryA.registerStage(rollbackRegistration, now);
      const composableClaim = await repositoryA.claimAggregator({ runId: rollbackRun, stage: "lead", generation: 1,
        owner: "outer_transaction", token: "21000000-0000-4000-8000-000000000001", leaseDurationMs: 120000 }, now);
      await assert.rejects(prismaA.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT set_config('search_path', ${schema}, true)`;
        const asserted = await assertCompleteAggregatorInTransaction(transaction, {
          runId: rollbackRun, stage: "lead", generation: 1, token: composableClaim.stage.aggregationLeaseToken
        }, new Date(now.getTime() + 1));
        assert.equal(asserted.run.id, rollbackRun);
        await completeAggregatorInTransaction(transaction, { stageId: composable.stage.id,
          token: composableClaim.stage.aggregationLeaseToken, state: "completed" }, new Date(now.getTime() + 2));
        throw new Error("INJECT_AFTER_COMPLETION");
      }), /INJECT_AFTER_COMPLETION/u);
      assert.equal((await prismaA.pipelineStage.findUnique({ where: { id: composable.stage.id } })).state, "aggregating");

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
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prismaA;
    let prismaB;
    try {
      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prismaA = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prismaA, schema);
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

      const trafficRun = "run_gr3_traffic_lease_0001";
      await createAwsRun(prismaA, trafficRun);
      const trafficStage = await repositoryA.registerStage(registration(trafficRun, "traffic_crux", []), now);
      await prismaA.run.update({ where: { id: trafficRun }, data: {
        leaseToken: "60000000-0000-4000-8000-000000000001", leaseExpiresAt: new Date(now.getTime() + 60_000)
      } });
      const blockedTraffic = await repositoryA.claimAggregator({ runId: trafficRun, stage: "traffic_crux", generation: 1,
        owner: "blocked", token: "60000000-0000-4000-8000-000000000002", leaseDurationMs: 120000 }, now);
      assert.equal(blockedTraffic.outcome, "busy");
      assert.equal((await prismaA.pipelineStage.findUnique({ where: { id: trafficStage.stage.id } })).state, "ready");
      const trafficClaim = await repositoryA.claimAggregator({ runId: trafficRun, stage: "traffic_crux", generation: 1,
        owner: "allowed", token: "60000000-0000-4000-8000-000000000003", leaseDurationMs: 120000 },
      new Date(now.getTime() + 60_001));
      assert.equal(trafficClaim.outcome, "owned");
      await prismaA.run.update({ where: { id: trafficRun }, data: { leaseExpiresAt: new Date(now.getTime() + 90_000) } });
      await assert.rejects(prismaA.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT set_config('search_path', ${schema}, true)`;
        await assertCompleteAggregatorInTransaction(transaction, { runId: trafficRun, stage: "traffic_crux",
          generation: 1, token: trafficClaim.stage.aggregationLeaseToken }, new Date(now.getTime() + 70_000));
      }), (error) => error.code === "PIPELINE_NOT_READY");
      await prismaA.run.update({ where: { id: trafficRun }, data: { leaseExpiresAt: null, leaseToken: null } });
      const permittedTraffic = await prismaA.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT set_config('search_path', ${schema}, true)`;
        return assertCompleteAggregatorInTransaction(transaction, { runId: trafficRun, stage: "traffic_crux",
          generation: 1, token: trafficClaim.stage.aggregationLeaseToken }, new Date(now.getTime() + 70_001));
      });
      assert.equal(permittedTraffic.stage.id, trafficStage.stage.id);

      const sharedShop = await prismaA.shop.create({ data: { id: "shop_gr3_shared_task_0001", stableKey: "domain:gr3.example" } });
      const sharedTaskId = cancelStage.tasks[0].id;
      await prismaA.shopWork.createMany({ data: [
        { id: "work_gr3_shared_task_0001", shopId: sharedShop.id, workType: "dataforseo", scopeKey: "one",
          processingPipelineTaskId: sharedTaskId },
        { id: "work_gr3_shared_task_0002", shopId: sharedShop.id, workType: "dataforseo", scopeKey: "two",
          processingPipelineTaskId: sharedTaskId }
      ] });
      assert.equal(await prismaA.shopWork.count({ where: { processingPipelineTaskId: sharedTaskId } }), 2);

      const recoveryRun = "run_g5_recovery_bound_0001";
      await createAwsRun(prismaA, recoveryRun);
      const recoveryTasks = Array.from({ length: 105 }, (_, index) => ({
        itemKey: `item_${String(index).padStart(3, "0")}`, inputFingerprint: fp((index % 10).toString())
      }));
      const recoveryStage = await repositoryA.registerStage(registration(recoveryRun, "discovery", recoveryTasks), now);
      const recovery = await repositoryA.listRecoverable({ olderThan: new Date(now.getTime() + 300000), limit: 100 },
        new Date(now.getTime() + 300001));
      assert.equal(recovery.tasks.length + recovery.stages.length, 100);
      assert.ok(recovery.tasks.every(({ task, stage }) => task.stageId === recoveryStage.stage.id &&
        stage.id === recoveryStage.stage.id && stage.manifestProducedAt.getTime() ===
        recoveryStage.stage.manifestProducedAt.getTime()));
      assert.equal(await prismaA.pipelineTask.count({ where: { stageId: recoveryStage.stage.id } }), 105);
      assert.equal(cancelStage.tasks.length, 2);
    } finally {
      await prismaA?.$disconnect();
      await prismaB?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
