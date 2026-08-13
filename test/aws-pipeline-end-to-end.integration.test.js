import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { awsProviderConfigSnapshot, trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";
import { createAwsPipelineE2eHarness } from "./helpers/aws-pipeline-e2e-harness.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const boundaries = ["before_external_work", "external_success_response_lost", "before_s3_write",
  "during_s3_write_or_lost_write_response", "conditional_s3_conflict", "after_s3_before_first_neon_terminal",
  "after_first_neon_terminal_before_aggregation_check_send", "after_aggregation_check_send_before_sqs_ack",
  "duplicate_delayed_or_reversed_delivery", "lambda_timeout_or_process_death", "partial_sqs_batch_failure",
  "zero_expected_tasks_or_all_reused", "cancellation_at_any_stage", "dlq_arrival",
  "final_publication_before_results_available", "final_publication_after_results_available"];

test("G13 cancellation is atomic and fences every late coordinator token",
  { skip: !enabled, timeout: 120000 }, async () => {
    const schema = `g13_e2e_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema); let prisma;
    try {
      deployPrismaMigrations(scopedUrl); prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const coordinator = new PipelineCoordinatorRepository(prisma); const now = new Date();
      const runId = "run_g13_cancel_fixture_0001";
      const provider = awsProviderConfigSnapshot({ browserlessUrl: "https://fixture.example",
        googleSearchEngineId: "fixture", googleResultsPerQuery: 10, requestTimeoutMs: 10000,
        maxPagesPerStore: 5, pageFetchConcurrency: 2, maxQueries: 20, generatedQueryCount: 10,
        queryProbeFreshnessMs: 60000, queryProbeConcurrency: 1, minQueryResults: 1,
        minQueryUniqueHosts: 1, minQueryRelevantResults: 1, minQueryRelevanceRatio: 0.1,
        minQueryBaseScore: 1, browserlessEnabled: false, enableAiNormalization: false });
      await prisma.run.create({ data: { id: runId, state: "running", phase: "scraping", stage: "aws_lead",
        normalizedShopTypes: [], progress: {}, executionBackend: "aws", pipelineGeneration: 1,
        trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({}), awsProviderConfig: provider,
        leaseOwner: "old", leaseToken: randomUUID(), leaseAcquiredAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60000), resultsAvailable: false } });
      const registered = await coordinator.registerStage({ runId, stage: "lead", generation: 1,
        manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint: "a".repeat(64),
        manifestProducedAt: now, tasks: [{ itemKey: "shop_fixture_cancel_0001",
          inputFingerprint: "b".repeat(64) }] }, now);
      const result = await coordinator.cancelRunGeneration({ runId, generation: 1 }, new Date(now.getTime() + 1));
      assert.equal(result.run.state, "cancelled"); assert.equal(result.run.resultsAvailable, false);
      assert.equal(result.run.leaseToken, null); assert.equal(result.tasks[0].state, "cancelled");
      assert.equal(result.stages[0].state, "cancelled");
      assert.equal((await coordinator.claimTask({ runId, stage: "lead", generation: 1,
        itemKey: registered.tasks[0].itemKey, inputFingerprint: registered.tasks[0].inputFingerprint,
        owner: "late", token: randomUUID(), leaseDurationMs: 60000 }, new Date(now.getTime() + 2))).outcome,
      "cancelled");
      await assert.rejects(coordinator.cancelRunGeneration({ runId, generation: 2 },
        new Date(now.getTime() + 3)), (error) => error.code === "PIPELINE_INPUT_CONFLICT");
    } finally {
      await prisma?.$disconnect(); await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });

test("G-R9 imports and executes every durable failure boundary through restartable PostgreSQL harnesses",
  { skip: !enabled, timeout: 7200000 }, async (context) => {
    const matrix = JSON.parse(await readFile(new URL("./fixtures/aws-pipeline/v1/durable-failure-recovery-matrix.json",
      import.meta.url), "utf8"));
    assert.equal(matrix.contractVersion, "durable-failure-recovery-matrix-v1");
    const names = matrix.boundaries.map(({ boundary }) => boundary);
    assert.deepEqual(names, boundaries); assert.equal(new Set(names).size, 16);
    const providerConfig = awsProviderConfigSnapshot({ browserlessUrl: "https://fixture.example",
        googleSearchEngineId: "fixture", googleResultsPerQuery: 10, requestTimeoutMs: 10000,
        maxPagesPerStore: 5, pageFetchConcurrency: 2, maxQueries: 20, generatedQueryCount: 10,
        queryProbeFreshnessMs: 60000, queryProbeConcurrency: 1, minQueryResults: 1,
        minQueryUniqueHosts: 1, minQueryRelevantResults: 1, minQueryRelevanceRatio: 0.1,
        minQueryBaseScore: 1, browserlessEnabled: false, enableAiNormalization: false,
        dataForSeoEnrichmentEnabled: true, cruxEnrichmentEnabled: true,
        cruxBigQueryProjectId: "fixture-project" });
    for (const [rowIndex, row] of matrix.boundaries.entries()) await context.test(row.boundary, async () => {
      const schema = `gr9_${rowIndex}_${Date.now()}_${process.pid}`; let prisma; let base;
      try {
        const isolated = await createIsolatedTestSchema(schema); base = isolated.admin;
        deployPrismaMigrations(isolated.scopedUrl); prisma = createPrismaClient(isolated.scopedUrl);
        await assertMigrationStayedInSchema(prisma, schema);
        const initialNow = new Date();
        const fault = { injected: false, restarts: 0, boundary: row.boundary };
        const scenario = { boundary: row.boundary, providerConfig, fault,
          ...(row.boundary === "zero_expected_tasks_or_all_reused" ? { variant: "zero_query" } : {}) };
        const harness = await createAwsPipelineE2eHarness({ prisma, scenario,
          now: initialNow });
        if (row.boundary === "cancellation_at_any_stage") {
          const cancelled = await harness.cancel(); assert.equal(cancelled.run.state, "cancelled");
          assert.equal((await harness.restart()).constructor, Object);
          fault.injected = true;
        } else if (row.boundary === "conditional_s3_conflict") {
          const settled = await (await harness.restart()).runUntilSettled();
          assert.equal(fault.injected, true); assert.equal(settled.run.resultsAvailable, false);
        } else if (row.boundary === "external_success_response_lost") {
          const settled = await (await harness.restart()).runUntilSettled();
          assert.equal(fault.injected, true); assert.equal(settled.run.resultsAvailable, false);
          assert.equal(settled.providerCalls.dataforseo, 1);
        } else if (row.boundary === "dlq_arrival") {
          const settled = await (await harness.restart()).runUntilSettled();
          assert.equal(settled.run.resultsAvailable, false); assert.equal(fault.dlq.message.type, "traffic.domain");
          assert.equal(settled.providerCalls.dataforseo, 0);
        } else if (["before_s3_write", "during_s3_write_or_lost_write_response"].includes(row.boundary)) {
          const settled = await (await harness.restart()).runUntilSettled();
          assert.equal(settled.run.resultsAvailable, false);
          assert.equal(settled.providerCalls.dataforseo, 0);
          const domainManifest = [...settled.artifacts.keys()].find((key) => key.endsWith("/domains-manifest.json"));
          assert.equal(Boolean(domainManifest), row.boundary === "during_s3_write_or_lost_write_response");
        } else if (row.boundary === "partial_sqs_batch_failure") {
          const settled = await (await harness.restart()).runUntilSettled();
          const stage = await prisma.pipelineStage.findFirst({ where: {
            runId: settled.run.id, stage: "traffic_crux" } });
          assert.equal(stage.expectedCount, 2); assert.equal(stage.terminalCount, 2);
          assert.equal(settled.providerCalls.dataforseo, 1); assert.equal(settled.providerCalls.rest, 2);
          assert.equal(settled.providerCalls.bigQueryDry, 1); assert.equal(settled.providerCalls.bigQueryLive, 1);
        } else {
          const restarted = await harness.restart(); let settled = await restarted.runUntilSettled();
          if (!['completed', 'cancelled', 'failed'].includes(settled.run.state))
            settled = await (await restarted.restart()).runUntilSettled();
          assert.equal(settled.run.state, "completed"); assert.equal(settled.run.resultsAvailable, true);
          if (row.boundary === "zero_expected_tasks_or_all_reused")
            { assert.ok(Object.values(settled.providerCalls).every((count) => count === 0));
              const reusedFault = { injected: false, restarts: 0, boundary: row.boundary };
              const reused = await createAwsPipelineE2eHarness({ prisma, now: initialNow,
                scenario: { boundary: row.boundary, providerConfig, fault: reusedFault, variant: "all_reused" } });
              const reusedSettled = await (await reused.restart()).runUntilSettled();
              assert.equal(reusedSettled.run.state, "completed");
              assert.ok(Object.values(reusedSettled.providerCalls).every((count) => count === 0));
              assert.equal(reusedFault.injected, true); }
          else {
            assert.equal(settled.providerCalls.google, 0); assert.equal(settled.providerCalls.browserless, 0);
            assert.equal(settled.providerCalls.ai, 0); assert.equal(settled.providerCalls.dataforseo, 1);
            assert.equal(settled.providerCalls.rest,
              ["duplicate_delayed_or_reversed_delivery", "partial_sqs_batch_failure"].includes(row.boundary) ? 2 : 1);
            assert.ok(settled.providerCalls.bigQueryTable <= 2);
            assert.equal(settled.providerCalls.bigQueryDry, 1); assert.equal(settled.providerCalls.bigQueryLive, 1);
            if (!["duplicate_delayed_or_reversed_delivery", "after_aggregation_check_send_before_sqs_ack",
              "final_publication_after_results_available"].includes(row.boundary))
              assert.ok(fault.restarts >= 1, "failure must discard and restart runtime state");
          }
        }
        assert.equal(fault.injected, true, "named boundary must be injected");
      } finally {
        await prisma?.$disconnect();
        if (base) { await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await base.$disconnect(); }
      }
    });
  });
