import assert from "node:assert/strict";
import test from "node:test";
import { recoverKeywordWork } from "../src/aws-pipeline/keyword-intelligence/recovery.js";
import { parseKeywordMessage } from "../src/aws-pipeline/keyword-intelligence/contracts.js";
import { keywordStageInputFingerprint } from "../src/aws-pipeline/keyword-intelligence/keys.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");

function dispatcher() {
  const sent = [];
  return {
    sent,
    async sendOne(_queueUrl, message, schema) {
      const parsed = parseKeywordMessage(message);
      sent.push(parsed);
      return { sentItemIds: [parsed.taskNaturalId ?? parsed.researchId ?? parsed.stage], failedItemIds: [] };
    }
  };
}

function runtime({ recoverRows, queueUrl = "https://sqs.example/keyword-research" } = {}) {
  return {
    config: { awsPipelineKeywordResearchQueueUrl: queueUrl },
    repository: {
      async recover(_now) {
        return { outcome: "found", ...recoverRows };
      }
    },
    dispatcher: dispatcher()
  };
}

const FINGERPRINT = "a30692beb8993ea17fec19a9b3defec53b87f4049a2fe0914232280b085ab458";

test("recovery reconstructs initialize, expansion/overview task, and check messages solely from returned rows", async () => {
  const tasks = [
    {
      researchId: "kr_recv00000000000000000001", generation: 1, stage: "expansion",
      stageId: "krs_e000000000000000000000001", taskId: "krt_a000000000000000000000001",
      itemKey: "0:suggestions", inputFingerprint: FINGERPRINT,
      endpointKey: "keyword_suggestions", requestFingerprint: FINGERPRINT
    },
    {
      researchId: "kr_recv00000000000000000001", generation: 1, stage: "anchor_screen",
      stageId: "krs_a000000000000000000000001", taskId: "krt_b000000000000000000000001",
      itemKey: "US:0", inputFingerprint: FINGERPRINT,
      endpointKey: "keyword_overview", requestFingerprint: FINGERPRINT
    },
    {
      researchId: "kr_recv00000000000000000001", generation: 1, stage: "market_overview",
      stageId: "krs_m000000000000000000000001", taskId: "krt_c000000000000000000000001",
      itemKey: "GB:0", inputFingerprint: FINGERPRINT,
      endpointKey: "keyword_overview", requestFingerprint: FINGERPRINT
    }
  ];
  const checks = [{
    researchId: "kr_recv00000000000000000001", generation: 1, stage: "expansion",
    stageId: "krs_e000000000000000000000001", stageInputFingerprint: FINGERPRINT
  }];
  const rt = runtime({
    recoverRows: {
      initializations: [{ researchId: "kr_recv00000000000000000001", generation: 1 }],
      taskDispatches: tasks,
      aggregateChecks: checks
    }
  });
  const result = await recoverKeywordWork({ now: NOW, limit: 100 }, rt);
  assert.equal(result.initializations, 1);
  assert.equal(result.taskDispatches, 3);
  assert.equal(result.aggregateChecks, 1);
  assert.equal(result.sent, 5);
  const types = rt.dispatcher.sent.map((m) => m.type);
  assert.deepEqual(types, [
    "keyword.initialize.v1",
    "keyword.expansion.task.v1",
    "keyword.overview.task.v1",
    "keyword.overview.task.v1",
    "keyword.aggregate.check.v1"
  ]);
  const [initialize, expTask, anchorTask, marketTask, check] = rt.dispatcher.sent;
  assert.equal(initialize.researchId, "kr_recv00000000000000000001");
  assert.equal(expTask.stage, "expansion");
  assert.equal(expTask.taskNaturalId, "krt_a000000000000000000000001");
  assert.equal(anchorTask.stage, "anchor_screen");
  assert.equal(marketTask.stage, "market_overview");
  assert.equal(check.stageInputFingerprint, FINGERPRINT);
  assert.equal(rt.dispatcher.sent.some((m) => m.seed !== undefined), false);
});

test("recovery sends through the single DEC-KI-027 queue URL and validates https", async () => {
  const rt = runtime({
    queueUrl: "http://insecure.example/queue",
    recoverRows: { initializations: [], taskDispatches: [], aggregateChecks: [] }
  });
  await assert.rejects(
    recoverKeywordWork({ now: NOW, limit: 100 }, rt),
    (error) => error.code === "KEYWORD_RUNTIME_CONFIG_INVALID"
  );
  const bad = runtime({
    recoverRows: { initializations: [], taskDispatches: [], aggregateChecks: [] },
    queueUrl: "not-a-url"
  });
  await assert.rejects(
    recoverKeywordWork({ now: NOW, limit: 100 }, bad),
    (error) => error.code === "KEYWORD_RUNTIME_CONFIG_INVALID"
  );
});

test("recovery check messages carry the stage input fingerprint from returned rows", async () => {
  const stageInputFingerprint = keywordStageInputFingerprint({
    researchId: "kr_recv00000000000000000001", generation: 1, stage: "expansion",
    tasks: [{ itemKey: "0:suggestions", inputFingerprint: FINGERPRINT,
      endpointKey: "keyword_suggestions", requestFingerprint: FINGERPRINT }]
  });
  const rt = runtime({
    recoverRows: {
      initializations: [],
      taskDispatches: [],
      aggregateChecks: [{
        researchId: "kr_recv00000000000000000001", generation: 1, stage: "expansion",
        stageId: "krs_e000000000000000000000001", stageInputFingerprint
      }]
    }
  });
  const result = await recoverKeywordWork({ now: NOW, limit: 100 }, rt);
  assert.equal(result.aggregateChecks, 1);
  assert.equal(rt.dispatcher.sent[0].stageInputFingerprint, stageInputFingerprint);
});

test("recovery validates its inputs and never calls a provider", async () => {
  const rt = runtime({ recoverRows: { initializations: [], taskDispatches: [], aggregateChecks: [] } });
  await assert.rejects(
    recoverKeywordWork({ now: "not-a-date", limit: 100 }, rt),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT"
  );
  await assert.rejects(
    recoverKeywordWork({ now: NOW, limit: 0 }, rt),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT"
  );
  assert.equal(typeof rt.repository.recover, "function");
  assert.equal(rt.dispatcher.sent.length, 0);
});
