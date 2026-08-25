import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";
import { recoverCombinedWork } from "../src/aws-pipeline/handlers/recovery.js";

const W7_OWNER_REGISTRY = Object.freeze({"owner":"runtime_composition","requiredCases":["W7-RUNTIME-02"],"requiredControls":["W7-NC-03","W7-NC-04"]}); // W7-REGISTRY

const HELPER_ARGUMENT = "--w7-handler-capture";
const NOW = new Date("2026-08-24T00:00:00.000Z");
const LIMIT = 37;
const QUEUE_URL = "https://sqs.example/keyword-research";

function w7CaseRecord(id) {
  return `KI_W7_EXECUTION_RECORD_V1=${JSON.stringify({
    schema: "ki-w7-execution-record-v1",
    id,
    kind: "case",
    owner: W7_OWNER_REGISTRY.owner,
    executed: true,
    activated: true,
    oraclePassed: true,
    skipped: false
  })}`;
}

function w7ControlRecord(id) {
  return `KI_W7_EXECUTION_RECORD_V1=${JSON.stringify({
    schema: "ki-w7-execution-record-v1",
    id,
    kind: "control",
    owner: W7_OWNER_REGISTRY.owner,
    executed: true,
    activated: true,
    positivePassed: true,
    mutationFalsified: true,
    freshPositivePassed: true,
    skipped: false
  })}`;
}

function handlerEvent() {
  return {
    Records: [{
      messageId: "w7-runtime-message",
      body: JSON.stringify({
        contractVersion: 1,
        type: "keyword.initialize.v1",
        researchId: "kr_w7runtimecomposition01",
        generation: 1
      })
    }]
  };
}

async function runHandlerCaptureHelper() {
  const { PrismaKeywordResearchRepository } = await import("../src/keyword-intelligence/repository.js");
  const prismaMarker = Object.freeze({ marker: "w7-prisma-marker" });
  const baseRepository = Object.freeze({ marker: "w7-base-repository" });
  const injectedRepository = Object.freeze({ marker: "w7-injected-repository" });
  const s3Client = Object.freeze({ async send() { return {}; } });
  const dispatcher = Object.freeze({ marker: "w7-dispatcher" });
  const baseArtifactStore = Object.freeze({ marker: "w7-base-artifact-store" });
  const base = Object.freeze({
    config: Object.freeze({
      awsPipelineKeywordResearchActive: true,
      awsPipelineKeywordResearchQueueUrl: QUEUE_URL,
      awsPipelineBucket: "w7-keyword-bucket"
    }),
    prisma: prismaMarker,
    repository: baseRepository,
    dispatcher,
    s3Client,
    artifactStore: baseArtifactStore,
    secrets: Object.freeze({})
  });
  let createRuntimeCalls = 0;
  const captures = [];

  mock.module(new URL("../src/aws-pipeline/runtime.js", import.meta.url).href, {
    namedExports: {
      async createPipelineRuntime() {
        createRuntimeCalls += 1;
        return base;
      }
    }
  });
  mock.module(new URL("../src/aws-pipeline/keyword-intelligence/service.js", import.meta.url).href, {
    namedExports: {
      async processKeywordMessage(message, runtime) {
        captures.push({
          messageType: message.type,
          actualPrismaRepository: runtime.repository instanceof PrismaKeywordResearchRepository,
          samePrismaClient: runtime.repository?.client === prismaMarker,
          repositoryIsBase: runtime.repository === baseRepository,
          repositoryIsInjected: runtime.repository === injectedRepository,
          artifactMaxBytes: runtime.artifactStore?.maxBytes,
          artifactStoreReplaced: runtime.artifactStore !== baseArtifactStore,
          dispatcherPreserved: runtime.dispatcher === dispatcher
        });
        return { terminal: true };
      }
    }
  });

  const handlerUrl = new URL("../src/aws-pipeline/keyword-intelligence/handler.js", import.meta.url);
  handlerUrl.searchParams.set("w7-runtime-composition", "1");
  const { handler } = await import(handlerUrl.href);
  const uninjectedResult = await handler(handlerEvent());
  const lambdaContextResult = await handler(handlerEvent(), {
    awsRequestId: "w7-runtime-request",
    functionName: "storesignal-production-pipeline-keyword-worker",
    getRemainingTimeInMillis() {
      return 180_000;
    }
  });
  const injectedResult = await handler(handlerEvent(), {
    ...base,
    prisma: undefined,
    repository: injectedRepository
  });
  return {
    createRuntimeCalls,
    uninjectedResult,
    lambdaContextResult,
    injectedResult,
    uninjected: captures[0],
    lambdaContext: captures[1],
    injected: captures[2]
  };
}

function runHandlerCapture() {
  const result = spawnSync(process.execPath, [
    "--experimental-test-module-mocks",
    fileURLToPath(import.meta.url),
    HELPER_ARGUMENT
  ], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.notEqual(result.stdout, "", JSON.stringify({ stderr: result.stderr, error: result.error?.message }));
  return JSON.parse(result.stdout);
}

function assertHandlerCapture(capture) {
  assert.equal(capture.createRuntimeCalls, 2);
  assert.deepEqual(capture.uninjectedResult, { batchItemFailures: [] });
  assert.deepEqual(capture.lambdaContextResult, { batchItemFailures: [] });
  assert.deepEqual(capture.injectedResult, { batchItemFailures: [] });
  assert.deepEqual(capture.uninjected, {
    messageType: "keyword.initialize.v1",
    actualPrismaRepository: true,
    samePrismaClient: true,
    repositoryIsBase: false,
    repositoryIsInjected: false,
    artifactMaxBytes: 33554432,
    artifactStoreReplaced: true,
    dispatcherPreserved: true
  });
  assert.deepEqual(capture.injected, {
    messageType: "keyword.initialize.v1",
    actualPrismaRepository: false,
    samePrismaClient: false,
    repositoryIsBase: false,
    repositoryIsInjected: true,
    artifactMaxBytes: 33554432,
    artifactStoreReplaced: true,
    dispatcherPreserved: true
  });
  assert.deepEqual(capture.lambdaContext, capture.uninjected);
}

function recoveryBase({ active, pipelineFailure } = {}) {
  const events = [];
  const keywordQueries = [];
  const keywordSends = [];
  let transactionReceiver;
  const prisma = {
    async $transaction(work) {
      transactionReceiver = this;
      events.push("keyword:transaction");
      return work(this);
    },
    keywordResearch: {
      async findMany(input) {
        events.push("keyword:initializations");
        keywordQueries.push({ kind: "initializations", input });
        return [];
      }
    },
    keywordResearchTask: {
      async findMany(input) {
        events.push("keyword:tasks");
        keywordQueries.push({ kind: "tasks", input });
        return [];
      }
    },
    keywordResearchStage: {
      async findMany(input) {
        events.push("keyword:stages");
        keywordQueries.push({ kind: "stages", input });
        return [];
      }
    }
  };
  const base = {
    config: {
      awsPipelineKeywordResearchActive: active === true,
      awsPipelineKeywordResearchQueueUrl: QUEUE_URL,
      awsPipelineRecoveryAgeMs: 60000,
      awsPipelineDiscoveryQueueUrl: "https://sqs.example/discovery",
      awsPipelineDomainAggregationQueueUrl: "https://sqs.example/domain-aggregation",
      awsPipelineLeadQueueUrl: "https://sqs.example/lead",
      awsPipelineLeadAggregationQueueUrl: "https://sqs.example/lead-aggregation",
      awsPipelineTrafficQueueUrl: "https://sqs.example/traffic",
      awsPipelineFinalAggregationQueueUrl: "https://sqs.example/final"
    },
    prisma,
    repository: {
      async markStaleDataForSeoRequestsAmbiguous(receivedNow) {
        events.push("pipeline:mark");
        assert.strictEqual(receivedNow, NOW);
        if (pipelineFailure) throw pipelineFailure;
        return 0;
      }
    },
    coordinator: {
      async listRecoverable({ olderThan, limit }, receivedNow) {
        events.push("pipeline:list");
        assert.strictEqual(receivedNow, NOW);
        assert.equal(olderThan.getTime(), NOW.getTime() - 60000);
        assert.equal(limit, LIMIT);
        return { tasks: [], stages: [] };
      }
    },
    dispatcher: {
      async sendMany() {
        throw new Error("empty pipeline recovery must not send");
      },
      async sendOne(queueUrl, message) {
        keywordSends.push({ queueUrl, message });
        return { sentItemIds: ["unexpected"] };
      }
    }
  };
  return { base, events, keywordQueries, keywordSends, prisma, transactionReceiver: () => transactionReceiver };
}

async function captureRecovery(active) {
  const fixture = recoveryBase({ active });
  const result = await recoverCombinedWork({ now: NOW, limit: LIMIT }, fixture.base);
  return { ...fixture, result };
}

function assertInactiveRecovery(capture) {
  assert.deepEqual(capture.result, {
    pipeline: { tasksScanned: 0, tasksSent: 0, checksScanned: 0, checksSent: 0, paidMarkedAmbiguous: 0 },
    keyword: { outcome: "disabled" }
  });
  assert.deepEqual(capture.events, ["pipeline:mark", "pipeline:list"]);
  assert.equal(capture.keywordQueries.length, 0);
  assert.equal(capture.keywordSends.length, 0);
}

function assertActiveRecovery(capture) {
  assert.deepEqual(capture.result, {
    pipeline: { tasksScanned: 0, tasksSent: 0, checksScanned: 0, checksSent: 0, paidMarkedAmbiguous: 0 },
    keyword: { initializations: 0, taskDispatches: 0, aggregateChecks: 0, sent: 0 }
  });
  assert.deepEqual(capture.events, [
    "pipeline:mark", "pipeline:list", "keyword:transaction",
    "keyword:initializations", "keyword:tasks", "keyword:stages"
  ]);
  assert.strictEqual(capture.transactionReceiver(), capture.prisma);
  assert.deepEqual(capture.keywordQueries.map(({ kind, input }) => [kind, input.take]), [
    ["initializations", LIMIT], ["tasks", LIMIT], ["stages", LIMIT]
  ]);
  const taskWhere = capture.keywordQueries.find(({ kind }) => kind === "tasks").input.where;
  const stageWhere = capture.keywordQueries.find(({ kind }) => kind === "stages").input.where;
  assert.strictEqual(taskWhere.OR[0].leaseExpiresAt.lt, NOW);
  assert.strictEqual(taskWhere.OR[1].OR[1].nextAttemptAt.lte, NOW);
  assert.strictEqual(stageWhere.OR[1].aggregationLeaseExpiresAt.lt, NOW);
  assert.equal(capture.keywordSends.length, 0);
}

if (process.argv[2] === HELPER_ARGUMENT) {
  process.stdout.write(JSON.stringify(await runHandlerCaptureHelper()));
} else {
  test("[W7 CASE W7-RUNTIME-02] handler and recovery compose the exact keyword runtime", async (t) => {
    assertHandlerCapture(runHandlerCapture());
    assertInactiveRecovery(await captureRecovery(false));
    assertActiveRecovery(await captureRecovery(true));

    const firstFailure = new Error("w7-pipeline-first-failure");
    const failed = recoveryBase({ active: true, pipelineFailure: firstFailure });
    await assert.rejects(
      recoverCombinedWork({ now: NOW, limit: LIMIT }, failed.base),
      (error) => error === firstFailure
    );
    assert.deepEqual(failed.events, ["pipeline:mark"]);
    assert.equal(failed.keywordQueries.length, 0);
    assert.equal(failed.keywordSends.length, 0);
    t.diagnostic(w7CaseRecord("W7-RUNTIME-02"));
  });

  test("[W7 CONTROL W7-NC-03] retaining the base repository falsifies production repository identity", (t) => {
    const positive = runHandlerCapture();
    assertHandlerCapture(positive);
    const mutated = {
      ...positive,
      uninjected: {
        ...positive.uninjected,
        actualPrismaRepository: false,
        samePrismaClient: false,
        repositoryIsBase: true
      }
    };
    assert.throws(() => assertHandlerCapture(mutated));
    assertHandlerCapture(runHandlerCapture());
    t.diagnostic(w7ControlRecord("W7-NC-03"));
  });

  test("[W7 CONTROL W7-NC-04] invoking keyword recovery while inactive falsifies the zero-work branch", async (t) => {
    const positive = await captureRecovery(false);
    assertInactiveRecovery(positive);
    const mutated = {
      ...positive,
      events: [...positive.events, "keyword:transaction"],
      keywordQueries: [{ kind: "mutated-inactive-read", input: {} }],
      keywordSends: [{ queueUrl: QUEUE_URL, message: {} }]
    };
    assert.throws(() => assertInactiveRecovery(mutated));
    assertInactiveRecovery(await captureRecovery(false));
    t.diagnostic(w7ControlRecord("W7-NC-04"));
  });
}
