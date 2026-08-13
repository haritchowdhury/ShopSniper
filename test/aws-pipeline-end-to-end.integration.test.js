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
  { skip: !enabled, timeout: 420000 }, async (context) => {
    const matrix = JSON.parse(await readFile(new URL("./fixtures/aws-pipeline/v1/durable-failure-recovery-matrix.json",
      import.meta.url), "utf8"));
    assert.equal(matrix.contractVersion, "durable-failure-recovery-matrix-v1");
    const names = matrix.boundaries.map(({ boundary }) => boundary);
    assert.deepEqual(names, boundaries); assert.equal(new Set(names).size, 16);
    const schema = `gr9_matrix_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema); let prisma;
    try {
      deployPrismaMigrations(scopedUrl); prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const providerConfig = awsProviderConfigSnapshot({ browserlessUrl: "https://fixture.example",
        googleSearchEngineId: "fixture", googleResultsPerQuery: 10, requestTimeoutMs: 10000,
        maxPagesPerStore: 5, pageFetchConcurrency: 2, maxQueries: 20, generatedQueryCount: 10,
        queryProbeFreshnessMs: 60000, queryProbeConcurrency: 1, minQueryResults: 1,
        minQueryUniqueHosts: 1, minQueryRelevantResults: 1, minQueryRelevanceRatio: 0.1,
        minQueryBaseScore: 1, browserlessEnabled: false, enableAiNormalization: false });
      for (const row of matrix.boundaries) await context.test(row.boundary, async () => {
        const scenario = { boundary: row.boundary, providerConfig };
        const harness = await createAwsPipelineE2eHarness({ prisma, scenario,
          now: new Date("2026-08-13T00:00:00.000Z") });
        if (row.boundary === "cancellation_at_any_stage") {
          const cancelled = await harness.cancel(); assert.equal(cancelled.run.state, "cancelled");
          assert.equal((await harness.restart()).constructor, Object);
        } else {
          const restarted = await harness.restart(); const settled = await restarted.runUntilSettled();
          assert.equal(settled.run.state, "completed"); assert.equal(settled.run.resultsAvailable, true);
          assert.ok(Object.values(settled.providerCalls).every((count) => count === 0));
        }
      });
    } finally { await prisma?.$disconnect(); await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect(); }
  });
