import assert from "node:assert/strict";
import test from "node:test";
import { recoverKeywordWork } from "../src/aws-pipeline/keyword-intelligence/recovery.js";
import { parseKeywordMessage } from "../src/aws-pipeline/keyword-intelligence/contracts.js";
import { keywordStageInputFingerprint } from "../src/aws-pipeline/keyword-intelligence/keys.js";
import { PipelineInvariantError } from "../src/aws-pipeline/contracts/errors.js";

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

function runtime({ recoverRows, queueUrl = "https://sqs.example/keyword-research", expectedLimit = 100 } = {}) {
  const recoverCalls = [];
  return {
    config: { awsPipelineKeywordResearchQueueUrl: queueUrl },
    repository: {
      recoverCalls,
      async recover(now, { limit }) {
        assert.ok(now instanceof Date, "repository.recover must receive the caller's Date");
        assert.equal(limit, expectedLimit, "repository.recover must receive the caller's forwarded limit");
        recoverCalls.push({ now, limit });
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
  assert.deepEqual(rt.repository.recoverCalls, []);
  assert.equal(rt.dispatcher.sent.length, 0);
});

const REGISTERED_CONTROLS = Object.freeze(["W6-NC-17"]);

test("SCN-KI-043 recovery caller: forwards bound and rejects over-return", async () => {
  const falsifiedControls = [];
  assert.deepEqual(REGISTERED_CONTROLS, ["W6-NC-17"]);
  assert.equal(REGISTERED_CONTROLS.includes("W6-DB-06"), false);

  const fp = (value) => value.toString(16).padStart(64, "0");
  const researchIdOf = (value) => `kr_recv${String(value).padStart(20, "0")}`;
  const taskNaturalIdOf = (value) => `krt_t${String(value).padStart(24, "0")}`;
  const STAGES = ["expansion", "anchor_screen", "market_overview"];

  const initializations = [];
  for (let index = 1; index <= 30; index += 1) {
    initializations.push({ researchId: researchIdOf(index), generation: 1 });
  }
  const taskDispatches = [];
  for (let index = 1; index <= 50; index += 1) {
    const isOverview = index % 2 === 0;
    taskDispatches.push({
      researchId: researchIdOf(100 + index),
      generation: 1,
      stage: isOverview ? STAGES[1 + (index % 4 === 0 ? 0 : 1)] : "expansion",
      stageId: `krs_s${String(index).padStart(24, "0")}`,
      taskId: taskNaturalIdOf(index),
      itemKey: isOverview ? `US:${index}` : "0:suggestions",
      inputFingerprint: fp(0x10 + index),
      endpointKey: isOverview ? "keyword_overview" : "keyword_suggestions",
      requestFingerprint: fp(0x10 + index)
    });
  }
  const aggregateChecks = [];
  for (let index = 1; index <= 20; index += 1) {
    aggregateChecks.push({
      researchId: researchIdOf(200 + index),
      generation: 1,
      stage: STAGES[index % 3],
      stageId: `krs_c${String(index).padStart(24, "0")}`,
      stageInputFingerprint: fp(0x80 + index)
    });
  }
  assert.equal(initializations.length + taskDispatches.length + aggregateChecks.length, 100);

  const expectedMessages = [];
  for (const initialization of initializations) {
    expectedMessages.push({
      contractVersion: 1,
      type: "keyword.initialize.v1",
      researchId: initialization.researchId,
      generation: initialization.generation
    });
  }
  for (const task of taskDispatches) {
    const isOverview = task.endpointKey === "keyword_overview";
    expectedMessages.push({
      contractVersion: 1,
      type: isOverview ? "keyword.overview.task.v1" : "keyword.expansion.task.v1",
      researchId: task.researchId,
      generation: task.generation,
      stage: isOverview ? task.stage : "expansion",
      taskNaturalId: task.taskId,
      inputFingerprint: task.inputFingerprint
    });
  }
  for (const check of aggregateChecks) {
    expectedMessages.push({
      contractVersion: 1,
      type: "keyword.aggregate.check.v1",
      researchId: check.researchId,
      generation: check.generation,
      stage: check.stage,
      stageInputFingerprint: check.stageInputFingerprint
    });
  }
  assert.equal(expectedMessages.length, 100);

  const positive = runtime({
    recoverRows: { initializations, taskDispatches, aggregateChecks }
  });
  const positiveCounts = await recoverKeywordWork({ now: NOW, limit: 100 }, positive);
  assert.deepEqual(positive.repository.recoverCalls, [{ now: NOW, limit: 100 }]);
  assert.deepEqual(positiveCounts, {
    initializations: 30, taskDispatches: 50, aggregateChecks: 20, sent: 100
  });
  assert.equal(positive.dispatcher.sent.length, 100);
  assert.deepEqual(positive.dispatcher.sent, expectedMessages);

  const singleCandidate = { researchId: researchIdOf(999), generation: 2 };
  const small = runtime({
    recoverRows: { initializations: [singleCandidate], taskDispatches: [], aggregateChecks: [] },
    expectedLimit: 1
  });
  const smallCounts = await recoverKeywordWork({ now: NOW, limit: 1 }, small);
  assert.deepEqual(small.repository.recoverCalls, [{ now: NOW, limit: 1 }]);
  assert.deepEqual(smallCounts, { initializations: 1, taskDispatches: 0, aggregateChecks: 0, sent: 1 });
  assert.deepEqual(small.dispatcher.sent, [{
    contractVersion: 1,
    type: "keyword.initialize.v1",
    researchId: singleCandidate.researchId,
    generation: 2
  }]);

  const overInitializations = [{ researchId: researchIdOf(400), generation: 1 }];
  const overTaskDispatches = [];
  for (let index = 1; index <= 99; index += 1) {
    overTaskDispatches.push({
      researchId: researchIdOf(500 + index),
      generation: 1,
      stage: "expansion",
      stageId: `krs_o${String(index).padStart(24, "0")}`,
      taskId: taskNaturalIdOf(1000 + index),
      itemKey: "0:suggestions",
      inputFingerprint: fp(0x400 + index),
      endpointKey: "keyword_suggestions",
      requestFingerprint: fp(0x400 + index)
    });
  }
  const overAggregateChecks = [{ researchId: researchIdOf(700), generation: 1, stage: "expansion", stageId: "krs_o999999999999999999999999", stageInputFingerprint: fp(0x7ff) }];
  assert.equal(overInitializations.length + overTaskDispatches.length + overAggregateChecks.length, 101);
  const over = runtime({
    recoverRows: { initializations: overInitializations, taskDispatches: overTaskDispatches, aggregateChecks: overAggregateChecks }
  });
  await assert.rejects(
    recoverKeywordWork({ now: NOW, limit: 100 }, over),
    (error) => {
      assert.ok(error instanceof PipelineInvariantError);
      assert.equal(error.name, "PipelineInvariantError");
      assert.equal(error.code, "PIPELINE_INPUT_CONFLICT");
      assert.equal(error.message, "PIPELINE_INPUT_CONFLICT");
      return true;
    }
  );
  assert.deepEqual(over.repository.recoverCalls, [{ now: NOW, limit: 100 }]);
  assert.equal(over.dispatcher.sent.length, 0);
  falsifiedControls.push("W6-NC-17");
  assert.deepEqual(falsifiedControls, REGISTERED_CONTROLS);

  for (const invalidLimit of [0, 101, 12.5]) {
    const invalid = runtime({
      recoverRows: { initializations: [], taskDispatches: [], aggregateChecks: [] }
    });
    await assert.rejects(
      recoverKeywordWork({ now: NOW, limit: invalidLimit }, invalid),
      (error) => error instanceof PipelineInvariantError && error.code === "PIPELINE_INPUT_CONFLICT"
    );
    assert.deepEqual(invalid.repository.recoverCalls, []);
    assert.equal(invalid.dispatcher.sent.length, 0);
  }
});
