import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository, awsProviderConfigSnapshot,
  trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { parseTrafficRunConfig } from "../src/aws-pipeline/contracts/traffic-config.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { processTrafficBatch, trafficInputFingerprint } from "../src/aws-pipeline/services/traffic-worker.js";
import { leadRecordToCreate } from "../src/api-serializer.js";
import { runStoreId } from "../src/shop-persistence-contract.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/aws-pipeline/v1/${name}`, import.meta.url)));

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
      const traffic = trafficEnrichmentConfigSnapshot({ dataForSeoEnrichmentEnabled: true,
        cruxEnrichmentEnabled: true });
      const provider = awsProviderConfigSnapshot({ browserlessUrl: "https://fixture.example",
        googleSearchEngineId: "fixture", googleResultsPerQuery: 10, requestTimeoutMs: 10000,
        maxPagesPerStore: 5, pageFetchConcurrency: 2, maxQueries: 20, generatedQueryCount: 10,
        queryProbeFreshnessMs: 60000, queryProbeConcurrency: 1, minQueryResults: 1,
        minQueryUniqueHosts: 1, minQueryRelevantResults: 1, minQueryRelevanceRatio: 0.1,
        minQueryBaseScore: 1, browserlessEnabled: false, enableAiNormalization: false,
        dataForSeoEnrichmentEnabled: true, cruxEnrichmentEnabled: true,
        cruxBigQueryProjectId: "fixture-project" });
      await prisma.run.create({ data: { id: runId, state: "running", phase: "scraping",
        stage: "aws_traffic_crux", normalizedShopTypes: [], progress: {}, executionBackend: "aws",
        pipelineGeneration: 1, trafficEnrichmentConfig: traffic, awsProviderConfig: provider } });
      await prisma.shop.create({ data: { id: shopId, stableKey: "domain:fixture.example",
        canonicalUrl: "https://fixture.example", resolvedDomain: "fixture.example" } });
      const leadFixture = (await load("lead-results.valid.json")).success.lead;
      const lead = await prisma.lead.create({ data: { ...leadRecordToCreate(runId,
        "lead_g11_fixture_0001", leadFixture), shopId } });
      const domainManifest = await load("domain-manifest.valid.json");
      const workPlan = await load("domain-work-plan.valid.json");
      domainManifest.runId = runId; workPlan.runId = runId;
      workPlan.domainManifestKey = `runs/${runId}/domains-manifest.json`;
      domainManifest.domains[0].runStoreId = runStoreId(runId, shopId);
      workPlan.domains[0].runStoreId = domainManifest.domains[0].runStoreId;
      workPlan.domains[0].candidateKey = `runs/${runId}/domains/${shopId}/candidate.json`;
      workPlan.domains[0].candidateFingerprint = fingerprintJson({ contractVersion: "domain-candidate-v1",
        runId, generation: 1, shopId, runStoreId: domainManifest.domains[0].runStoreId,
        identity: domainManifest.domains[0].identity,
        candidatePayload: domainManifest.domains[0].candidatePayload });
      workPlan.awsProviderConfig = provider;
      const dataForSeoBase = workPlan.domains[0].sourceKeys.dataForSeo[0];
      workPlan.domains[0].sourceKeys.dataForSeo = traffic.dataForSeo.scopes.map((scope) => ({ ...dataForSeoBase,
        scopeKey: scope === "worldwide" ? scope : `country:${scope.countryIsoCode}:${scope.locationCode}` }));
      const manifest = { contractVersion: "domain-stage-manifest-v1", domainManifest, workPlan };
      const manifestFingerprint = fingerprintJson(manifest);
      const fingerprintLead = { ...leadRecordToCreate(runId, lead.id, leadFixture), id: lead.id,
        shop_id: shopId, resolved_domain: leadFixture.resolved_domain, final_url: leadFixture.final_url,
        status: leadFixture.status, identity_evidence: leadFixture.identity_evidence };
      const inputFingerprint = trafficInputFingerprint(runId, 1, manifestFingerprint,
        workPlan.domains[0], fingerprintLead);
      const registered = await coordinator.registerStage({ runId, stage: "traffic_crux", generation: 1,
        manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint,
        manifestProducedAt: new Date(workPlan.evaluatedAt), tasks: [{ itemKey: shopId, inputFingerprint }] }, now);
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

      const artifacts = new Map(); let paidCalls = 0; let crashAfterBatch = true;
      const runtime = { config: { awsPipelineFinalAggregationQueueUrl: "final" }, repository,
        coordinator, secrets: { dataForSeoLogin: "fixture", dataForSeoPassword: "fixture",
          cruxApiKey: "fixture", cruxBigQueryProjectId: "fixture-project",
          googleApplicationCredentials: "fixture" }, artifactStore: {
          async getValidated() { return { value: manifest, contentFingerprint: manifestFingerprint }; },
          async getOptionalValidated({ key }) { return artifacts.has(key) ? { outcome: "found", value: artifacts.get(key),
            contentFingerprint: fingerprintJson(artifacts.get(key)) } : { outcome: "missing" }; },
          async putImmutable({ key, value }) { if (!artifacts.has(key)) artifacts.set(key, value);
            else assert.deepEqual(artifacts.get(key), value);
            const contentFingerprint = fingerprintJson(value);
            if (crashAfterBatch && value.contractVersion === "provider-batch-result-v1" &&
                value.source === "dataforseo") { crashAfterBatch = false; throw new Error("batch-before-ledger"); }
            return { contentFingerprint }; }
        }, dispatcher: { async sendOne() { return { sentItemIds: ["check"], failedItemIds: [] }; } } };
      const dependencies = { createLeaseMonitorFn: () => ({ assertActive() {}, async renewNow() {}, async stop() {} }),
        fetchDataForSeoTrafficFn: async ({ targets, scope }) => { paidCalls += 1; return {
          records: targets.map((target) => ({ state: "available", value: { contractVersion: "dataforseo-traffic-v1",
            target, scope: scope === "worldwide" ? scope : { countryIsoCode: scope.countryIsoCode,
              locationCode: traffic.dataForSeo.scopes.find((entry) => entry.countryIsoCode === scope.countryIsoCode).locationCode },
            languageScope: "all_available", metrics: { organic: { etv: 10, count: 1 },
              paid: { etv: 0, count: 0 }, featuredSnippet: { etv: 0, count: 0 }, localPack: { etv: 0, count: 0 } },
            fetchedAt: workPlan.evaluatedAt } })), cost: { providerReported: 0.01 } }; },
        fetchCruxOriginMetricsFn: async ({ origin }) => ({ contractVersion: "crux-origin-metrics-v1", origin,
          coverage: "available", metrics: { largestContentfulPaintP75Ms: 1000 },
          collectionPeriod: { firstDate: "2026-07-01", lastDate: "2026-07-28" }, fetchedAt: workPlan.evaluatedAt }),
        fetchCruxLatestDatasetMonthFn: async () => "202607",
        dryRunCruxPopularityFn: async () => ({ datasetMonth: "202607", bytesProcessed: 100 }),
        fetchCruxPopularityForMonthFn: async ({ origins, datasetMonth, dryRun }) => ({ datasetMonth,
          records: origins.map((origin) => ({ contractVersion: "crux-popularity-v1", origin,
            coverage: "available", datasetMonth, popularityRank: 1000,
            deviceFractions: { phone: 0.7, desktop: 0.29, tablet: 0.01 }, fetchedAt: workPlan.evaluatedAt })),
          dryRunBytesProcessed: dryRun.bytesProcessed, bytesProcessed: 100, bytesBilled: 100, cacheHit: false }) };
      const record = { recordId: "traffic-integration", message: { version: 1, type: "traffic.domain", runId,
        stage: "traffic_crux", generation: 1, itemId: shopId, manifestKey: `runs/${runId}/domains-manifest.json`,
        manifestFingerprint, manifestProducedAt: workPlan.evaluatedAt, attempt: 1 } };
      const result = await processTrafficBatch([record], runtime, dependencies);
      assert.deepEqual(result.results, [{ recordId: "traffic-integration", terminal: false, outcome: "retryable" }]);
      assert.equal(paidCalls, 1);
      await prisma.run.update({ where: { id: runId }, data: { leaseExpiresAt: new Date(0) } });
      const restarted = await processTrafficBatch([record], runtime, dependencies);
      assert.deepEqual(restarted.results, [{ recordId: "traffic-integration", terminal: true, outcome: "recorded" }]);
      assert.equal(paidCalls, 10);
      const ledgers = await prisma.dataForSeoRequestLedger.findMany({ where: { runId } });
      assert.equal(ledgers.length, 10);
      assert.ok(ledgers.every(({ state }) => state === "succeeded"));
      const source = [...artifacts.values()].find((value) => value.contractVersion === "provider-source-result-v1" &&
        value.source === "dataforseo");
      const ledgerByRequest = new Map(ledgers.map((entry) => [entry.requestFingerprint, entry]));
      assert.ok(source.requestEvidence.every((evidence) => evidence.batchArtifactFingerprint ===
        ledgerByRequest.get(evidence.requestFingerprint)?.resultFingerprint));
      assert.equal((await prisma.pipelineTask.findUnique({ where: { id: registered.tasks[0].id } })).state, "succeeded");
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });
