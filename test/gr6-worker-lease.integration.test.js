import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrismaClient } from "../src/prisma-client.js";
import { PrismaRunRepository } from "../src/prisma-run-repository.js";

const enabled =
  process.env.ALLOW_DATABASE_TESTS === "true" &&
  Boolean(process.env.TEST_DATABASE_URL);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function scopedDatabaseUrl(connectionString, schema) {
  const url = new URL(connectionString);
  url.searchParams.set("schema", schema);
  return url.toString();
}

function deploy(databaseUrl, configPath) {
  const result = spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", "--config", configPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DIRECT_URL: "",
        PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1"
      },
      encoding: "utf8"
    }
  );
  assert.equal(
    result.status,
    0,
    `migration deploy failed: ${result.stderr || result.stdout}`
  );
}

async function gr4BaselineConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "email-scraper-gr6-"));
  const migrationRoot = path.join(directory, "migrations");
  await fs.mkdir(migrationRoot);
  await fs.copyFile(
    path.join(projectRoot, "prisma", "schema.prisma"),
    path.join(directory, "schema.prisma")
  );
  await fs.copyFile(
    path.join(projectRoot, "prisma", "migrations", "migration_lock.toml"),
    path.join(migrationRoot, "migration_lock.toml")
  );
  for (const name of [
    "20260731000000_init",
    "20260731150000_auth_run_ownership",
    "20260731230000_g3_pipeline_quality",
    "20260801000000_gr4_durable_v2"
  ]) {
    await fs.cp(
      path.join(projectRoot, "prisma", "migrations", name),
      path.join(migrationRoot, name),
      { recursive: true }
    );
  }
  const configPath = path.join(directory, "prisma.config.ts");
  await fs.writeFile(
    configPath,
    `import { defineConfig } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, "node_modules", "prisma", "config.js")).href)};\nexport default defineConfig({ schema: ${JSON.stringify(path.join(directory, "schema.prisma"))}, migrations: { path: ${JSON.stringify(migrationRoot)} }, datasource: { url: process.env.DATABASE_URL } });\n`,
    "utf8"
  );
  return { directory, configPath };
}

function payload(domain = "lease-fixture.example") {
  return {
    leads: [{
      resolved_domain: domain,
      status: "qualified",
      pipeline_version: 2,
      scoring_version: 2,
      lead_score: 80,
      score_breakdown: {
        version: 2,
        components: {
          identity: 14,
          shopifyValidation: 20,
          categoryFit: 24,
          contactEvidence: 22
        },
        total: 80,
        semantics: "deterministic_evidence_rank_not_probability"
      }
    }],
    queryAudits: [{ query: domain, status: "selected" }],
    diagnostics: [{ scope: "run", code: "lease_fixture", details: {} }],
    summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
  };
}

test(
  "G-R6 migration and real PostgreSQL leases fence concurrent workers",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const schema = `gr6_${Date.now()}_${process.pid}`;
    const base = createPrismaClient(process.env.TEST_DATABASE_URL);
    const scopedUrl = scopedDatabaseUrl(process.env.TEST_DATABASE_URL, schema);
    const baseline = await gr4BaselineConfig();
    let prismaA;
    let prismaB;
    try {
      await base.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      deploy(scopedUrl, baseline.configPath);
      const preMigration = createPrismaClient(scopedUrl);
      await preMigration.$executeRawUnsafe(`
        INSERT INTO "${schema}"."Run" ("id", "ownerId", "state", "stage", "normalizedShopTypes", "progress", "resultsAvailable")
        VALUES
          ('gr6_queued', 'owner', 'queued', 'queued', '[]'::jsonb, '{}'::jsonb, false),
          ('gr6_legacy_running', 'owner', 'running', 'extracting_leads', '[]'::jsonb, '{}'::jsonb, false),
          ('gr6_completed', 'owner', 'completed', 'completed', '[]'::jsonb, '{}'::jsonb, true),
          ('gr6_failed', 'owner', 'failed', 'failed', '[]'::jsonb, '{}'::jsonb, false)
      `);
      await preMigration.$disconnect();

      deploy(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      deploy(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prismaA = createPrismaClient(scopedUrl);
      prismaB = createPrismaClient(scopedUrl);
      const repositoryA = new PrismaRunRepository(prismaA);
      const repositoryB = new PrismaRunRepository(prismaB);

      const preserved = await prismaA.run.findMany({
        where: { id: { startsWith: "gr6_" } },
        orderBy: { id: "asc" }
      });
      assert.equal(preserved.length, 4);
      assert.deepEqual(
        preserved.map(({ state }) => state).sort(),
        ["completed", "failed", "queued", "running"]
      );
      assert.ok(preserved.every(({ leaseToken }) => leaseToken === null));
      assert.ok(preserved.every(({ leaseAttempt }) => leaseAttempt === 0));

      const start = new Date("2026-08-01T10:00:00.000Z");
      assert.equal((await repositoryA.recoverExpiredRuns(start)).count, 1);
      assert.equal((await repositoryB.recoverExpiredRuns(start)).count, 0);
      assert.equal((await prismaA.run.findUnique({ where: { id: "gr6_legacy_running" } })).safeErrorCode, "RUN_LEASE_EXPIRED");

      const claims = await Promise.all([
        repositoryA.claimNextQueuedRun("worker_a", start, 60_000),
        repositoryB.claimNextQueuedRun("worker_b", start, 60_000)
      ]);
      const winner = claims.find(Boolean);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(winner.run.id, "gr6_queued");
      assert.equal(winner.run.leaseAttempt, 1);

      const healthySweep = await repositoryB.recoverExpiredRuns(
        new Date(start.getTime() + 30_000)
      );
      assert.equal(healthySweep.count, 0);
      await assert.rejects(
        repositoryB.updateProgress(
          winner.run.id,
          { owner: "worker_b", token: "lease_forged" },
          { stage: "extracting_leads" },
          new Date(start.getTime() + 30_000)
        ),
        /no longer owns/u
      );

      const heartbeatAt = new Date(start.getTime() + 40_000);
      await repositoryA.heartbeatRun(
        winner.run.id,
        winner.lease,
        heartbeatAt,
        60_000
      );
      const renewed = await prismaA.run.findUnique({ where: { id: winner.run.id } });
      assert.equal(renewed.lastHeartbeatAt.toISOString(), heartbeatAt.toISOString());
      assert.equal(
        renewed.leaseExpiresAt.toISOString(),
        new Date(heartbeatAt.getTime() + 60_000).toISOString()
      );

      const expiry = new Date(heartbeatAt.getTime() + 60_000);
      const race = await Promise.allSettled([
        repositoryA.heartbeatRun(winner.run.id, winner.lease, expiry, 60_000),
        repositoryB.recoverExpiredRuns(expiry)
      ]);
      assert.equal(race[0].status, "rejected");
      assert.equal(race[1].status, "fulfilled");
      assert.equal(race[1].value.count, 1);
      assert.equal((await repositoryA.recoverExpiredRuns(expiry)).count, 0);
      await assert.rejects(
        repositoryA.saveCompletedResults(
          winner.run.id,
          winner.lease,
          payload("stale.example"),
          null,
          expiry
        ),
        /different terminal result/u
      );
      assert.equal(await prismaA.lead.count({ where: { runId: winner.run.id } }), 0);

      const completionRun = await repositoryA.createRun("completion_owner", [
        { originalShopType: "Eyewear", shopType: "eyewear" }
      ]);
      const completionClaim = await repositoryA.claimNextQueuedRun(
        "worker_completion",
        new Date(start.getTime() + 120_000),
        60_000
      );
      const completionPayload = payload("completed.example");
      const completionTime = new Date(start.getTime() + 130_000);
      await repositoryA.saveCompletedResults(
        completionRun.id,
        completionClaim.lease,
        completionPayload,
        null,
        completionTime
      );
      await repositoryB.saveCompletedResults(
        completionRun.id,
        completionClaim.lease,
        completionPayload,
        null,
        new Date(start.getTime() + 500_000)
      );
      await assert.rejects(
        repositoryB.saveCompletedResults(
          completionRun.id,
          { owner: "worker_other", token: "lease_other" },
          completionPayload,
          null,
          completionTime
        ),
        /different terminal result/u
      );
      assert.equal(await prismaA.lead.count({ where: { runId: completionRun.id } }), 1);

      const failureRun = await repositoryA.createRun("failure_owner", [
        { originalShopType: "Coffee", shopType: "coffee" }
      ]);
      const failureStart = new Date(start.getTime() + 520_000);
      const failureClaim = await repositoryA.claimNextQueuedRun(
        "worker_failure",
        failureStart,
        60_000
      );
      await assert.rejects(
        repositoryB.markFailed(
          failureRun.id,
          { owner: "worker_other", token: "lease_other" },
          {},
          null,
          failureStart
        ),
        /no longer owns/u
      );
      await repositoryA.markFailed(
        failureRun.id,
        failureClaim.lease,
        { code: "RUN_FAILED", message: "Safe fixture failure." },
        null,
        failureStart
      );
      assert.equal((await prismaA.run.findUnique({ where: { id: failureRun.id } })).state, "failed");

      const expiryRun = await repositoryA.createRun("expiry_owner", [
        { originalShopType: "Clothing", shopType: "clothing" }
      ]);
      const expiryStart = new Date(start.getTime() + 600_000);
      const expiryClaim = await repositoryA.claimNextQueuedRun(
        "worker_expiry",
        expiryStart,
        60_000
      );
      const boundary = new Date(expiryStart.getTime() + 60_000);
      const completionRace = await Promise.allSettled([
        repositoryA.saveCompletedResults(
          expiryRun.id,
          expiryClaim.lease,
          payload("boundary.example"),
          null,
          boundary
        ),
        repositoryB.recoverExpiredRuns(boundary)
      ]);
      assert.equal(completionRace[0].status, "rejected");
      assert.equal(completionRace[1].status, "fulfilled");
      assert.equal(completionRace[1].value.count, 1);
      assert.equal(await prismaA.lead.count({ where: { runId: expiryRun.id } }), 0);

      console.log(JSON.stringify({
        event: "gr6_database_evidence",
        preservedRows: preserved.length,
        concurrentClaimWinners: 1,
        expiredTransitions: 2,
        staleTokenRejected: true,
        completionBoundaryFenced: true,
        migrationReplay: "passed"
      }));
    } finally {
      if (prismaA) await prismaA.$disconnect().catch(() => {});
      if (prismaB) await prismaB.$disconnect().catch(() => {});
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await base.$disconnect().catch(() => {});
      await fs.rm(baseline.directory, { recursive: true, force: true });
    }
  }
);
