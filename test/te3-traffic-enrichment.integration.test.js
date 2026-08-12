import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrismaClient } from "../src/prisma-client.js";
import {
  PrismaRunRepository,
  stableLeadId
} from "../src/prisma-run-repository.js";
import { recoverInterruptedWork } from "../src/server.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled =
  process.env.ALLOW_DATABASE_TESTS === "true" &&
  Boolean(process.env.TEST_DATABASE_URL);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function migrationConfigBefore({ includeTe3 = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "email-scraper-te3-"));
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
  const names = [
    "20260731000000_init",
    "20260731150000_auth_run_ownership",
    "20260731230000_g3_pipeline_quality",
    "20260801000000_gr4_durable_v2",
    "20260801090000_gr6_worker_leases",
    "20260801150000_query_review_workflow"
  ];
  if (includeTe3) names.push("20260802090000_traffic_enrichment_v1");
  for (const name of names) {
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

function qualifiedLead(domain) {
  return {
    resolved_domain: domain,
    identity_evidence: { stableHostname: domain },
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
  };
}

function dataForSeoValue(domain, etv = 10) {
  return {
    contractVersion: "dataforseo-traffic-v1",
    target: domain,
    scope: "worldwide",
    languageScope: "all_available",
    metrics: {
      organic: { etv, count: etv ? 1 : 0 },
      paid: { etv: 0, count: 0 },
      featuredSnippet: { etv: 0, count: 0 },
      localPack: { etv: 0, count: 0 }
    },
    fetchedAt: "2026-08-02T00:00:00.000Z"
  };
}

function failureClient(prisma, failureStage) {
  return {
    $transaction: (callback) => prisma.$transaction(async (transaction) => {
      const wrap = (model, method) => async (...arguments_) => {
        const result = await transaction[model][method](...arguments_);
        if (`${model}.${method}` === failureStage) {
          throw new Error(`injected failure after ${failureStage}`);
        }
        return result;
      };
      return callback({
        run: {
          updateMany: wrap("run", "updateMany"),
          findUnique: (...arguments_) => transaction.run.findUnique(...arguments_)
        },
        lead: {
          deleteMany: wrap("lead", "deleteMany"),
          createMany: wrap("lead", "createMany")
        },
        leadTrafficEnrichment: {
          deleteMany: wrap("leadTrafficEnrichment", "deleteMany"),
          createMany: wrap("leadTrafficEnrichment", "createMany")
        },
        queryAudit: {
          deleteMany: wrap("queryAudit", "deleteMany"),
          createMany: wrap("queryAudit", "createMany")
        },
        runDiagnostic: {
          deleteMany: wrap("runDiagnostic", "deleteMany"),
          createMany: wrap("runDiagnostic", "createMany")
        }
      });
    })
  };
}

test(
  "TE-3 migration, paid ledger, cache, fencing, tenancy, recovery, and publication hold on PostgreSQL",
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const schema = `te3_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
      const baseline = await migrationConfigBefore();
    let prismaA;
    let prismaB;
    try {
      deployPrismaMigrations(scopedUrl, baseline.configPath);
      const preMigration = createPrismaClient(scopedUrl);
      await preMigration.$executeRawUnsafe(`
        INSERT INTO "${schema}"."Run" ("id", "ownerId", "state", "phase", "stage", "normalizedShopTypes", "progress", "resultsAvailable")
        VALUES ('te3_historical_run', 'historical_owner', 'completed', 'finished', 'completed', '[]'::jsonb, '{}'::jsonb, true)
      `);
      await preMigration.$executeRawUnsafe(`
        INSERT INTO "${schema}"."Lead" ("id", "runId", "resolvedDomain", "status")
        VALUES ('te3_historical_lead', 'te3_historical_run', 'historical.example', 'qualified')
      `);
      await preMigration.$disconnect();

      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prismaA = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prismaA, schema);
      prismaB = createPrismaClient(scopedUrl);
      const config = {
        dataForSeoEnrichmentEnabled: true,
        dataForSeoCacheFreshnessMs: 2592000000,
        dataForSeoMaxCostPerRunUsd: 2,
        trafficNoCoverageCacheFreshnessMs: 86400000,
        trafficPaidRequestStaleMs: 900000,
        cruxEnrichmentEnabled: false
      };
      const repositoryA = new PrismaRunRepository(prismaA, config);
      const repositoryB = new PrismaRunRepository(prismaB, config);

      const historical = await prismaA.run.findUnique({
        where: { id: "te3_historical_run" },
        include: { leads: { include: { trafficEnrichments: true } } }
      });
      assert.equal(historical.trafficEnrichmentConfig, null);
      assert.equal(historical.trafficEnrichmentSummary, null);
      assert.equal(historical.leads.length, 1);
      assert.deepEqual(historical.leads[0].trafficEnrichments, []);

      const start = new Date("2026-08-02T01:00:00.000Z");
      const run = await repositoryA.createRun("owner_a", [{ shopType: "clothing" }]);
      const claim = await repositoryA.claimNextQueuedRun("worker_a", start, 60000);
      assert.equal(claim.run.id, run.id);
      const fingerprint = "a".repeat(64);
      await repositoryA.planDataForSeoRequest(run.id, claim.lease, {
        requestFingerprint: fingerprint,
        targetCount: 1,
        scopeKey: "worldwide"
      }, start);
      const competingClaims = await Promise.all([
        repositoryA.claimDataForSeoRequest(run.id, claim.lease, fingerprint, start),
        repositoryB.claimDataForSeoRequest(run.id, claim.lease, fingerprint, start)
      ]);
      assert.equal(competingClaims.filter(({ networkAllowed }) => networkAllowed).length, 1);
      const inFlight = await prismaA.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint: fingerprint }
      });
      assert.equal(inFlight.state, "in_flight");
      assert.equal(inFlight.attempt, 1);

      const domain = "te3.example";
      const value = dataForSeoValue(domain);
      await repositoryA.markDataForSeoRequestSucceeded(
        run.id,
        claim.lease,
        fingerprint,
        {
          providerCostUsd: 0.012,
          cacheRows: [{
            source: "dataforseo",
            identity: domain,
            scopeKey: "worldwide",
            metricSetKey: "featured_snippet,local_pack,organic,paid",
            contractVersion: "dataforseo-traffic-v1",
            state: "available",
            normalizedPayload: value,
            fetchedAt: value.fetchedAt,
            expiresAt: "2026-09-01T00:00:00.000Z"
          }]
        },
        start
      );
      assert.equal(await prismaA.trafficEnrichmentCache.count(), 1);
      const afterSuccessCrash = new Date(start.getTime() + 60001);
      assert.equal((await repositoryB.recoverExpiredRuns(afterSuccessCrash)).count, 1);
      assert.equal((await prismaA.run.findUnique({ where: { id: run.id } })).state, "failed");
      assert.equal((await prismaA.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint: fingerprint }
      })).state, "succeeded");
      assert.equal(await prismaA.lead.count({ where: { runId: run.id } }), 0);

      const publicationRun = await repositoryA.createRun("owner_a", [{ shopType: "clothing" }]);
      const publicationStart = new Date(start.getTime() + 120000);
      const publicationClaim = await repositoryA.claimNextQueuedRun(
        "worker_publication", publicationStart, 60000
      );
      const recoveredSuccess = await repositoryA.planDataForSeoRequest(
        publicationRun.id,
        publicationClaim.lease,
        { requestFingerprint: fingerprint, targetCount: 1, scopeKey: "worldwide" },
        publicationStart
      );
      assert.equal(recoveredSuccess.outcome, "succeeded");
      const lead = qualifiedLead(domain);
      const leadId = stableLeadId(publicationRun.id, lead, 0);
      const payload = {
        leads: [lead],
        trafficEnrichments: [{
          leadId,
          source: "dataforseo",
          state: "partial",
          contractVersion: "dataforseo-traffic-v1",
          normalizedPayload: { records: [value] },
          fetchedAt: value.fetchedAt
        }],
        trafficEnrichmentSummary: { dataforseo: { partial: 1, costUsd: 0.012 } },
        summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
      };
      await repositoryA.saveCompletedResults(
        publicationRun.id, publicationClaim.lease, payload, null, publicationStart
      );
      await repositoryB.saveCompletedResults(
        publicationRun.id, publicationClaim.lease, payload, null, publicationStart
      );
      await assert.rejects(
        repositoryB.saveCompletedResults(publicationRun.id, publicationClaim.lease, {
          ...payload,
          trafficEnrichmentSummary: { dataforseo: { partial: 0, costUsd: 0.012 } }
        }, null, publicationStart),
        /different terminal result/u
      );
      const publishedTraffic = await repositoryA.getTrafficEnrichmentsForRun(
        publicationRun.id, "owner_a"
      );
      assert.equal(publishedTraffic.length, 1);
      assert.equal(publishedTraffic[0].state, "partial");
      assert.equal((await repositoryB.getTrafficEnrichmentsForRun(
        publicationRun.id, "owner_b"
      )).length, 0);

      const staleRun = await repositoryA.createRun("owner_c", [{ shopType: "coffee" }]);
      const staleStart = new Date(start.getTime() + 240000);
      const staleClaim = await repositoryA.claimNextQueuedRun("worker_stale", staleStart, 60000);
      assert.equal(staleClaim.run.id, staleRun.id);
      const staleFingerprint = "b".repeat(64);
      await repositoryA.planDataForSeoRequest(staleRun.id, staleClaim.lease, {
        requestFingerprint: staleFingerprint, targetCount: 1, scopeKey: "worldwide"
      }, staleStart);
      await repositoryA.claimDataForSeoRequest(
        staleRun.id, staleClaim.lease, staleFingerprint, staleStart
      );
      const recoveryTime = new Date(staleStart.getTime() + 960000);
      await recoverInterruptedWork(repositoryB, recoveryTime, () => {});
      assert.equal((await prismaA.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint: staleFingerprint }
      })).state, "ambiguous");

      const activeRun = await repositoryA.createRun(
        "owner_active_paid", [{ shopType: "active-paid" }]
      );
      const activeStart = new Date(recoveryTime.getTime() + 60000);
      const activeClaim = await repositoryA.claimNextQueuedRun(
        "worker_active_paid", activeStart, 60000
      );
      const activeFingerprint = "f".repeat(64);
      await repositoryA.planDataForSeoRequest(activeRun.id, activeClaim.lease, {
        requestFingerprint: activeFingerprint,
        targetCount: 1,
        scopeKey: "worldwide"
      }, activeStart);
      await repositoryA.claimDataForSeoRequest(
        activeRun.id, activeClaim.lease, activeFingerprint, activeStart
      );
      const activeRecoveryTime = new Date(activeStart.getTime() + 30000);
      await recoverInterruptedWork(repositoryB, activeRecoveryTime, () => {});
      assert.equal((await prismaA.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint: activeFingerprint }
      })).state, "in_flight");
      await repositoryA.markDataForSeoRequestFailed(
        activeRun.id,
        activeClaim.lease,
        activeFingerprint,
        { code: "DATAFORSEO_NOT_DISPATCHED" },
        activeRecoveryTime
      );
      await repositoryA.markFailed(
        activeRun.id,
        activeClaim.lease,
        { code: "ACTIVE_RECOVERY_PROVEN", message: "Active paid work remained unchanged." },
        null,
        activeRecoveryTime
      );

      const ambiguousRun = await repositoryA.createRun("owner_d", [{ shopType: "bags" }]);
      const ambiguousStart = new Date(recoveryTime.getTime() + 120000);
      const ambiguousClaim = await repositoryA.claimNextQueuedRun(
        "worker_ambiguous", ambiguousStart, 60000
      );
      const ambiguousReuse = await repositoryA.planDataForSeoRequest(
        ambiguousRun.id,
        ambiguousClaim.lease,
        { requestFingerprint: staleFingerprint, targetCount: 1, scopeKey: "worldwide" },
        ambiguousStart
      );
      assert.equal(ambiguousReuse.outcome, "ambiguous");
      assert.equal((await repositoryA.claimDataForSeoRequest(
        ambiguousRun.id, ambiguousClaim.lease, staleFingerprint, ambiguousStart
      )).networkAllowed, false);
      await repositoryA.markFailed(
        ambiguousRun.id,
        ambiguousClaim.lease,
        { code: "AMBIGUOUS_REUSE_BLOCKED", message: "Ambiguous reuse was blocked safely." },
        null,
        ambiguousStart
      );

      const plannedCrashRun = await repositoryA.createRun("owner_e", [{ shopType: "hats" }]);
      const plannedStart = new Date(ambiguousStart.getTime() + 120000);
      const plannedClaim = await repositoryA.claimNextQueuedRun(
        "worker_planned_crash", plannedStart, 60000
      );
      const plannedFingerprint = "c".repeat(64);
      await repositoryA.planDataForSeoRequest(plannedCrashRun.id, plannedClaim.lease, {
        requestFingerprint: plannedFingerprint, targetCount: 1, scopeKey: "worldwide"
      }, plannedStart);
      await repositoryB.recoverExpiredRuns(new Date(plannedStart.getTime() + 60001));
      const plannedRecoveryRun = await repositoryA.createRun("owner_f", [{ shopType: "gifts" }]);
      const plannedRecoveryStart = new Date(plannedStart.getTime() + 120000);
      const plannedRecoveryClaim = await repositoryA.claimNextQueuedRun(
        "worker_planned_recovery", plannedRecoveryStart, 60000
      );
      assert.equal((await repositoryA.planDataForSeoRequest(
        plannedRecoveryRun.id,
        plannedRecoveryClaim.lease,
        { requestFingerprint: plannedFingerprint, targetCount: 1, scopeKey: "worldwide" },
        plannedRecoveryStart
      )).outcome, "planned");
      assert.equal((await repositoryA.claimDataForSeoRequest(
        plannedRecoveryRun.id,
        plannedRecoveryClaim.lease,
        plannedFingerprint,
        plannedRecoveryStart
      )).networkAllowed, true);
      await repositoryA.markDataForSeoRequestFailed(
        plannedRecoveryRun.id,
        plannedRecoveryClaim.lease,
        plannedFingerprint,
        { code: "DATAFORSEO_NOT_DISPATCHED" },
        plannedRecoveryStart
      );
      await repositoryA.markFailed(
        plannedRecoveryRun.id,
        plannedRecoveryClaim.lease,
        { code: "PLANNED_RECOVERY_COMPLETE", message: "Planned recovery proof completed." },
        null,
        plannedRecoveryStart
      );

      const te4PrimitiveRun = await repositoryA.createRun("owner_te4", [{ shopType: "optics" }]);
      const te4PrimitiveStart = new Date(plannedRecoveryStart.getTime() + 120000);
      const te4PrimitiveClaim = await repositoryA.claimNextQueuedRun(
        "worker_te4_primitives", te4PrimitiveStart, 60000
      );
      const cruxOrigin = "https://te4-cache.example";
      await repositoryA.saveCruxTrafficCache(
        te4PrimitiveRun.id,
        te4PrimitiveClaim.lease,
        [{
          source: "crux_bigquery",
          identity: cruxOrigin,
          scopeKey: "month:202606",
          metricSetKey: "desktop_density,phone_density,popularity_rank,tablet_density",
          contractVersion: "crux-popularity-v1",
          state: "no_coverage",
          fetchedAt: te4PrimitiveStart,
          expiresAt: new Date(te4PrimitiveStart.getTime() + 86400000)
        }],
        te4PrimitiveStart
      );
      assert.equal((await repositoryA.readFreshLatestCruxBigQueryCache(
        te4PrimitiveRun.id,
        te4PrimitiveClaim.lease,
        [cruxOrigin],
        te4PrimitiveStart
      )).length, 1);

      const immediateAmbiguousFingerprint = "d".repeat(64);
      await repositoryA.planDataForSeoRequest(te4PrimitiveRun.id, te4PrimitiveClaim.lease, {
        requestFingerprint: immediateAmbiguousFingerprint,
        targetCount: 1,
        scopeKey: "worldwide"
      }, te4PrimitiveStart);
      await repositoryA.claimDataForSeoRequest(
        te4PrimitiveRun.id,
        te4PrimitiveClaim.lease,
        immediateAmbiguousFingerprint,
        te4PrimitiveStart
      );
      await repositoryA.markDataForSeoRequestAmbiguous(
        te4PrimitiveRun.id,
        te4PrimitiveClaim.lease,
        immediateAmbiguousFingerprint,
        te4PrimitiveStart
      );
      assert.equal((await prismaA.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint: immediateAmbiguousFingerprint }
      })).state, "ambiguous");

      const costFingerprint = "e".repeat(64);
      const costDomain = "te4-cost.example";
      const costValue = dataForSeoValue(costDomain);
      await repositoryA.planDataForSeoRequest(te4PrimitiveRun.id, te4PrimitiveClaim.lease, {
        requestFingerprint: costFingerprint,
        targetCount: 1,
        scopeKey: "worldwide"
      }, te4PrimitiveStart);
      await repositoryA.claimDataForSeoRequest(
        te4PrimitiveRun.id, te4PrimitiveClaim.lease, costFingerprint, te4PrimitiveStart
      );
      await repositoryA.markDataForSeoRequestSucceeded(
        te4PrimitiveRun.id,
        te4PrimitiveClaim.lease,
        costFingerprint,
        {
          providerCostUsd: 0.02,
          cacheRows: [{
            source: "dataforseo",
            identity: costDomain,
            scopeKey: "worldwide",
            metricSetKey: "featured_snippet,local_pack,organic,paid",
            contractVersion: "dataforseo-traffic-v1",
            state: "available",
            normalizedPayload: costValue,
            fetchedAt: costValue.fetchedAt,
            expiresAt: "2026-09-01T00:00:00.000Z"
          }]
        },
        te4PrimitiveStart
      );
      assert.equal(await repositoryA.getDataForSeoRunCostUsd(
        te4PrimitiveRun.id, te4PrimitiveClaim.lease, te4PrimitiveStart
      ), 0.02);

      await repositoryA.markFailed(
        te4PrimitiveRun.id,
        te4PrimitiveClaim.lease,
        { code: "TE4_PRIMITIVES_PROVEN", message: "TE4 primitives were proven." },
        null,
        te4PrimitiveStart
      );

      const cappedRepositoryA = new PrismaRunRepository(prismaA, {
        ...config,
        dataForSeoMaxCostPerRunUsd: 0.05
      });
      const cappedRepositoryB = new PrismaRunRepository(prismaB, {
        ...config,
        dataForSeoMaxCostPerRunUsd: 999
      });
      const cappedRun = await cappedRepositoryA.createRun(
        "owner_paid_cap", [{ shopType: "paid-cap" }]
      );
      const cappedStart = new Date(te4PrimitiveStart.getTime() + 120000);
      const cappedClaim = await cappedRepositoryA.claimNextQueuedRun(
        "worker_paid_cap", cappedStart, 60000
      );
      const cappedFingerprints = ["6", "7", "8"].map((value) => value.repeat(64));
      for (const [index, requestFingerprint] of cappedFingerprints.entries()) {
        await cappedRepositoryA.planDataForSeoRequest(
          cappedRun.id,
          cappedClaim.lease,
          { requestFingerprint, targetCount: 1, scopeKey: index === 0 ? "worldwide" : `country:US:${2840 + index}` },
          cappedStart
        );
      }
      const cappedClaims = await Promise.all(cappedFingerprints.map(
        (requestFingerprint, index) => (index % 2 ? cappedRepositoryB : cappedRepositoryA)
          .claimDataForSeoRequest(
            cappedRun.id, cappedClaim.lease, requestFingerprint, cappedStart
          )
      ));
      assert.equal(cappedClaims.filter(({ networkAllowed }) => networkAllowed).length, 2);
      assert.equal(cappedClaims.filter(({ outcome }) => outcome === "budget_exceeded").length, 1);
      assert.equal(
        await cappedRepositoryA.getDataForSeoRunExposureUsd(
          cappedRun.id, cappedClaim.lease, cappedStart
        ),
        0.048
      );
      for (const result of cappedClaims.filter(({ networkAllowed }) => networkAllowed)) {
        await cappedRepositoryA.markDataForSeoRequestAmbiguous(
          cappedRun.id,
          cappedClaim.lease,
          result.ledger.requestFingerprint,
          cappedStart
        );
      }
      assert.equal(
        await cappedRepositoryB.getDataForSeoRunExposureUsd(
          cappedRun.id, cappedClaim.lease, cappedStart
        ),
        0.048
      );
      await cappedRepositoryA.markFailed(
        cappedRun.id,
        cappedClaim.lease,
        { code: "PAID_CAP_PROVEN", message: "Atomic paid exposure cap was proven." },
        null,
        cappedStart
      );

      const actualCostRun = await cappedRepositoryA.createRun(
        "owner_actual_cost", [{ shopType: "actual-cost" }]
      );
      const actualCostStart = new Date(cappedStart.getTime() + 120000);
      const actualCostClaim = await cappedRepositoryA.claimNextQueuedRun(
        "worker_actual_cost", actualCostStart, 60000
      );
      const actualCostFingerprint = "0".repeat(64);
      await cappedRepositoryA.planDataForSeoRequest(
        actualCostRun.id,
        actualCostClaim.lease,
        { requestFingerprint: actualCostFingerprint, targetCount: 1, scopeKey: "worldwide" },
        actualCostStart
      );
      assert.equal((await cappedRepositoryA.claimDataForSeoRequest(
        actualCostRun.id, actualCostClaim.lease, actualCostFingerprint, actualCostStart
      )).networkAllowed, true);
      const actualCostDomain = "actual-cost.example";
      const actualCostValue = dataForSeoValue(actualCostDomain);
      await cappedRepositoryA.markDataForSeoRequestSucceeded(
        actualCostRun.id,
        actualCostClaim.lease,
        actualCostFingerprint,
        {
          providerCostUsd: 0.04,
          cacheRows: [{
            source: "dataforseo",
            identity: actualCostDomain,
            scopeKey: "worldwide",
            metricSetKey: "featured_snippet,local_pack,organic,paid",
            contractVersion: "dataforseo-traffic-v1",
            state: "available",
            normalizedPayload: actualCostValue,
            fetchedAt: actualCostValue.fetchedAt,
            expiresAt: "2026-09-01T00:00:00.000Z"
          }]
        },
        actualCostStart
      );
      const afterActualFingerprint = "1".repeat(64);
      await cappedRepositoryA.planDataForSeoRequest(
        actualCostRun.id,
        actualCostClaim.lease,
        { requestFingerprint: afterActualFingerprint, targetCount: 1, scopeKey: "country:US:2840" },
        actualCostStart
      );
      const afterActualClaim = await cappedRepositoryA.claimDataForSeoRequest(
        actualCostRun.id, actualCostClaim.lease, afterActualFingerprint, actualCostStart
      );
      assert.equal(afterActualClaim.networkAllowed, false);
      assert.equal(afterActualClaim.outcome, "budget_exceeded");
      assert.equal(await cappedRepositoryA.getDataForSeoRunExposureUsd(
        actualCostRun.id, actualCostClaim.lease, actualCostStart
      ), 0.04);
      const succeededActual = await prismaA.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint: actualCostFingerprint }
      });
      assert.equal(Number(succeededActual.providerCostUsd), 0.04);
      assert.equal(succeededActual.reservationCostUsd, null);
      await cappedRepositoryA.markFailed(
        actualCostRun.id,
        actualCostClaim.lease,
        { code: "ACTUAL_COST_PROVEN", message: "Actual paid cost replaced reservation." },
        null,
        actualCostStart
      );

      const legacyRun = await repositoryA.createRun(
        "owner_legacy_paid", [{ shopType: "legacy-paid" }]
      );
      const legacyStart = new Date(cappedStart.getTime() + 120000);
      const legacyClaim = await repositoryA.claimNextQueuedRun(
        "worker_legacy_paid", legacyStart, 60000
      );
      const legacyFingerprint = "9".repeat(64);
      await prismaA.dataForSeoRequestLedger.create({
        data: {
          requestFingerprint: legacyFingerprint,
          runId: legacyRun.id,
          targetCount: 1,
          scopeKey: "worldwide",
          state: "in_flight",
          attempt: 1,
          leaseOwner: legacyClaim.lease.owner,
          leaseToken: legacyClaim.lease.token,
          claimedAt: legacyStart,
          reservationCostUsd: null,
          ambiguousAfter: null
        }
      });
      const legacyRecovery = new Date(legacyStart.getTime() + 60001);
      await repositoryA.recoverExpiredRuns(legacyRecovery);
      assert.equal(
        (await repositoryA.markStaleDataForSeoRequestsAmbiguous(legacyRecovery)).count,
        1
      );
      const recoveredLegacy = await prismaA.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint: legacyFingerprint }
      });
      assert.equal(recoveredLegacy.state, "ambiguous");
      assert.equal(recoveredLegacy.reservationCostUsd, null);

      const rollbackRun = await repositoryA.createRun("rollback_owner", [{ shopType: "shoes" }]);
      const rollbackStart = new Date(plannedRecoveryStart.getTime() + 120000);
      const rollbackClaim = await repositoryA.claimNextQueuedRun(
        "worker_rollback", rollbackStart, 60000
      );
      await prismaA.lead.create({
        data: { id: "te3_rollback_sentinel", runId: rollbackRun.id, status: "rejected" }
      });
      await prismaA.leadTrafficEnrichment.create({
        data: {
          id: "te3_rollback_enrichment_sentinel",
          runId: rollbackRun.id,
          leadId: "te3_rollback_sentinel",
          source: "crux_rest",
          state: "unavailable",
          contractVersion: "crux-origin-metrics-v1"
        }
      });
      await prismaA.queryAudit.create({
        data: {
          id: "te3_rollback_audit_sentinel",
          runId: rollbackRun.id,
          sequence: 0,
          status: "sentinel",
          details: {}
        }
      });
      await prismaA.runDiagnostic.create({
        data: {
          id: "te3_rollback_diagnostic_sentinel",
          runId: rollbackRun.id,
          sequence: 0,
          scope: "run",
          code: "sentinel",
          details: {}
        }
      });
      const rollbackLead = qualifiedLead("rollback.example");
      const rollbackLeadId = stableLeadId(rollbackRun.id, rollbackLead, 0);
      const rollbackPayload = {
          leads: [rollbackLead],
          trafficEnrichments: [{
            leadId: rollbackLeadId,
            source: "dataforseo",
            state: "partial",
            contractVersion: "dataforseo-traffic-v1",
            normalizedPayload: { records: [dataForSeoValue("rollback.example")] },
            fetchedAt: value.fetchedAt
          }],
          queryAudits: [{ query: "replacement", status: "selected" }],
          diagnostics: [{ scope: "run", code: "replacement", details: {} }],
          summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
      };
      const rollbackStages = [
        "run.updateMany",
        "leadTrafficEnrichment.deleteMany",
        "lead.deleteMany",
        "queryAudit.deleteMany",
        "runDiagnostic.deleteMany",
        "lead.createMany",
        "leadTrafficEnrichment.createMany",
        "queryAudit.createMany",
        "runDiagnostic.createMany"
      ];
      for (const stage of rollbackStages) {
        const failingRepository = new PrismaRunRepository(
          failureClient(prismaA, stage),
          config
        );
        await assert.rejects(
          failingRepository.saveCompletedResults(
            rollbackRun.id, rollbackClaim.lease, rollbackPayload, null, rollbackStart
          ),
          /injected failure/u
        );
        assert.equal((await prismaA.run.findUnique({ where: { id: rollbackRun.id } })).state, "running");
        assert.equal(await prismaA.lead.count({ where: { id: "te3_rollback_sentinel" } }), 1);
        assert.equal(await prismaA.leadTrafficEnrichment.count({
          where: { id: "te3_rollback_enrichment_sentinel" }
        }), 1);
        assert.equal(await prismaA.queryAudit.count({ where: { id: "te3_rollback_audit_sentinel" } }), 1);
        assert.equal(await prismaA.runDiagnostic.count({
          where: { id: "te3_rollback_diagnostic_sentinel" }
        }), 1);
      }

      await assert.rejects(
        prismaA.leadTrafficEnrichment.create({
          data: {
            id: "te3_cross_run_invalid",
            runId: rollbackRun.id,
            leadId,
            source: "crux_rest",
            state: "unavailable",
            contractVersion: "crux-origin-metrics-v1"
          }
        }),
        /foreign key constraint|Foreign key constraint/iu
      );

      console.log(JSON.stringify({
        event: "te3_database_evidence",
        historicalRowsPreserved: 2,
        migrationReplay: "passed",
        paidClaimWinners: 1,
        cacheAndLedgerAtomic: true,
        plannedBeforeCallRecovered: true,
        successBeforePublicationRecovered: true,
        ambiguousPaidRetryBlocked: true,
        immediateAmbiguousTransition: true,
        cruxCacheFence: true,
        durableCostRecovery: true,
        atomicPaidExposureCap: true,
        actualCostReplacesReservation: true,
        durableAmbiguityDeadline: true,
        legacyNullDeadlineRecovered: true,
        tenantIsolation: true,
        terminalReplay: true,
        rollbackStages: rollbackStages.length,
        crossRunReferenceRejected: true
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

test(
  "TE-R2 migration preserves an existing paid ledger row and adds nullable safety fields",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const schema = `ter2_migration_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    const baseline = await migrationConfigBefore({ includeTe3: true });
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl, baseline.configPath);
      const before = createPrismaClient(scopedUrl);
      await before.$executeRawUnsafe(`
        INSERT INTO "${schema}"."Run" ("id", "ownerId", "state", "phase", "stage", "normalizedShopTypes", "progress", "resultsAvailable", "trafficEnrichmentConfig")
        VALUES ('ter2_historical_run', 'historical_owner', 'failed', 'finished', 'failed', '[]'::jsonb, '{}'::jsonb, false,
          '{"version":"traffic-enrichment-run-v1","dataForSeo":{"maxCostPerRunUsd":2,"estimatedCostPerTaskUsd":0.024,"paidRequestStaleMs":900000}}'::jsonb)
      `);
      await before.$executeRawUnsafe(`
        INSERT INTO "${schema}"."DataForSeoRequestLedger" (
          "requestFingerprint", "runId", "targetCount", "scopeKey", "state", "attempt",
          "plannedAt", "claimedAt", "createdAt", "updatedAt"
        ) VALUES (
          '${"a".repeat(64)}', 'ter2_historical_run', 1, 'worldwide', 'in_flight', 1,
          '2026-08-02T00:00:00Z', '2026-08-02T00:00:01Z', '2026-08-02T00:00:00Z', '2026-08-02T00:00:01Z'
        )
      `);
      await before.$disconnect();

      deployPrismaMigrations(scopedUrl, path.join(projectRoot, "prisma.config.ts"));
      prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const row = await prisma.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint: "a".repeat(64) }
      });
      assert.equal(row.runId, "ter2_historical_run");
      assert.equal(row.state, "in_flight");
      assert.equal(row.attempt, 1);
      assert.equal(row.reservationCostUsd, null);
      assert.equal(row.ambiguousAfter, null);
    } finally {
      if (prisma) await prisma.$disconnect().catch(() => {});
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await base.$disconnect().catch(() => {});
      await fs.rm(baseline.directory, { recursive: true, force: true });
    }
  }
);
