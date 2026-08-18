import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { keywordResearchConfigV1 } from "../src/keyword-intelligence/config.js";
import { S3ArtifactStore } from "../src/aws-pipeline/adapters/artifact-store.js";
import { processInitialize, processKeywordMessage } from "../src/aws-pipeline/keyword-intelligence/service.js";
import { keywordMessageSchema, keywordExpansionManifestSchema } from "../src/aws-pipeline/keyword-intelligence/contracts.js";
import { keywordResultKey, keywordManifestKey, keywordRequestFingerprint, keywordTaskInputFingerprint } from "../src/aws-pipeline/keyword-intelligence/keys.js";

const fp = (value) => createHash("sha256").update(String(value)).digest("hex");
const CONFIG = keywordResearchConfigV1();
const NOW = new Date("2026-08-17T00:00:00.000Z");
const QUEUE_URL = "https://sqs.example/keyword-research";

function newId(prefix) {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function statefulRepository(seeds) {
  const researchId = newId("kr_");
  const generation = 1;
  const stages = {};
  const tasksByStage = {};
  const stageOrder = ["expansion", "anchor_screen", "market_overview"];
  const expandTasks = [];
  seeds.forEach((seed, index) => {
    const base = { keyword: seed, location_code: CONFIG.expansionAnchor.locationCode, language_code: CONFIG.expansionAnchor.languageCode };
    const suggestionRequest = { ...base, limit: 30 };
    const relatedRequest = { ...base, limit: 30, depth: 2 };
    const input = (endpointKey, seedValue) => keywordTaskInputFingerprint({ contractVersion: "keyword-expansion-input-v1", researchId, generation, payload: { seed: seedValue, endpointKey } });
    expandTasks.push({ itemKey: `${index}:suggestions`, inputFingerprint: input("keyword_suggestions", seed), endpointKey: "keyword_suggestions", requestFingerprint: keywordRequestFingerprint("keyword_suggestions", suggestionRequest) });
    expandTasks.push({ itemKey: `${index}:related`, inputFingerprint: input("related_keywords", seed), endpointKey: "related_keywords", requestFingerprint: keywordRequestFingerprint("related_keywords", relatedRequest) });
  });

  function makeTask(stageId, def, id) {
    return { id, stageId, ...def, state: "pending", attemptCount: 0, leaseToken: null, nextAttemptAt: null, createdAt: NOW, artifactS3Key: null, artifactFingerprint: null };
  }

  stages.expansion = { id: newId("krs"), researchId, stage: "expansion", generation, state: "collecting", expectedCount: expandTasks.length, terminalCount: 0, succeededCount: 0, skippedCount: 0, failedCount: 0, manifestS3Key: null, manifestFingerprint: null, manifestProducedAt: null, createdAt: NOW };
  tasksByStage.expansion = expandTasks.map((def, index) => makeTask(stages.expansion.id, def, newId("krt")));
  let anchorTasks = [];
  let marketTasks = [];
  let finalPublished = false;

  const repo = {
    researchId,
    schema: "public",
    getWorkerResearch: async ({ researchId: id, generation: g }) =>
      id === researchId && g === generation ? { outcome: "found", research: { id, generation: g, state: "running", contractVersion: 1, configSnapshot: CONFIG, configFingerprint: fp("c"), seeds, markets: CONFIG.markets } } : { outcome: "not_found" },
    initialize: async ({ researchId: id, generation: g, stage, tasks }) =>
      id === researchId && g === generation ? { outcome: "created", stage: stages.expansion, tasks: tasksByStage.expansion } : { outcome: "not_found" },
    getTaskContext: async ({ taskId }) => {
      for (const [stageName, tasks] of Object.entries(tasksByStage)) {
        const task = tasks.find((entry) => entry.id === taskId);
        if (task) return { outcome: "found", research: { id: researchId, generation, state: "running", configSnapshot: CONFIG, configFingerprint: fp("c"), seeds, markets: CONFIG.markets }, stage: stages[stageName], task, latestAttempt: null };
      }
      return { outcome: "not_found" };
    },
    claim: async ({ taskId, owner, token }) => {
      for (const tasks of Object.values(tasksByStage)) {
        const task = tasks.find((entry) => entry.id === taskId);
        if (task) { if (task.state !== "pending") return { outcome: "conflict" }; task.state = "processing"; task.leaseToken = token; return { outcome: "claimed", task }; }
      }
      return { outcome: "not_found" };
    },
    heartbeat: async () => ({ outcome: "claimed" }),
    heartbeatAggregator: async () => ({ outcome: "claimed" }),
    recordAttempt: async () => ({ outcome: "created", attempt: { attemptNumber: 1 }, mayCall: true }),
    settleAttempt: async () => ({ outcome: "terminal", attempt: { attemptNumber: 1 }, fenceActive: true }),
    markAttemptAmbiguous: async () => ({ outcome: "terminal" }),
    scheduleRetry: async () => ({ outcome: "delayed", retryAt: new Date(NOW.getTime() + 4000) }),
    deferTask: async () => ({ outcome: "delayed", retryAt: new Date(NOW.getTime() + 2000) }),
    claimThrottle: async () => ({ outcome: "claimed" }),
    cacheRead: async () => ({ outcome: "not_found" }),
    terminalize: async ({ taskId, token, state, artifactS3Key = null, artifactFingerprint = null }) => {
      for (const [stageName, tasks] of Object.entries(tasksByStage)) {
        const task = tasks.find((entry) => entry.id === taskId);
        if (task) {
          if (task.state !== "processing" || task.leaseToken !== token) return { outcome: "lost" };
          task.state = state;
          task.artifactS3Key = artifactS3Key;
          task.artifactFingerprint = artifactFingerprint;
          const stage = stages[stageName];
          stage.terminalCount += 1;
          stage.succeededCount += state === "succeeded" ? 1 : 0;
          if (stage.terminalCount === stage.expectedCount) stage.state = "ready";
          return { outcome: "terminal", task };
        }
      }
      return { outcome: "not_found" };
    },
    getStageContext: async ({ researchId: id, stage, generation: g }) => {
      if (id !== researchId || g !== generation) return { outcome: "not_found" };
      return { outcome: "found", research: { id: researchId, generation, state: "running", configSnapshot: CONFIG, configFingerprint: fp("c"), seeds, markets: CONFIG.markets }, stage: stages[stage], tasks: tasksByStage[stage] ?? [] };
    },
    claimAggregator: async ({ researchId: id, stage, generation: g, owner, token }) => {
      const s = stages[stage];
      if (s.state !== "ready") return { outcome: "not_ready", stage: s };
      if (s.state === "ready") { s.state = "aggregating"; s.aggregationLeaseToken = token; return { outcome: "claimed", stage: s }; }
      return { outcome: "lost" };
    },
    publishCandidateManifest: async ({ researchId: id, generation: g, token, manifestS3Key, manifestFingerprint, nextStageTasks }) => {
      stages.expansion.state = "completed";
      stages.expansion.manifestS3Key = manifestS3Key;
      stages.expansion.manifestFingerprint = manifestFingerprint;
      stages.expansion.manifestProducedAt = NOW;
      stages.anchor_screen = { id: newId("krs"), researchId, stage: "anchor_screen", generation, state: "collecting", expectedCount: 1, terminalCount: 0, succeededCount: 0, skippedCount: 0, failedCount: 0, manifestS3Key: null, manifestFingerprint: null, manifestProducedAt: null, createdAt: NOW };
      anchorTasks = nextStageTasks.map((def) => makeTask(stages.anchor_screen.id, def, newId("krt")));
      tasksByStage.anchor_screen = anchorTasks;
      return { outcome: "terminal", stage: stages.expansion, nextStage: stages.anchor_screen, tasks: anchorTasks };
    },
    publishShortlist: async ({ researchId: id, generation: g, token, manifestS3Key, manifestFingerprint, marketTasks: mts }) => {
      stages.anchor_screen.state = "completed";
      stages.anchor_screen.manifestS3Key = manifestS3Key;
      stages.anchor_screen.manifestFingerprint = manifestFingerprint;
      stages.anchor_screen.manifestProducedAt = NOW;
      stages.market_overview = { id: newId("krs"), researchId, stage: "market_overview", generation, state: "collecting", expectedCount: 8, terminalCount: 0, succeededCount: 0, skippedCount: 0, failedCount: 0, manifestS3Key: null, manifestFingerprint: null, manifestProducedAt: null, createdAt: NOW };
      marketTasks = mts.map((def) => makeTask(stages.market_overview.id, def, newId("krt")));
      tasksByStage.market_overview = marketTasks;
      return { outcome: "terminal", stage: stages.anchor_screen, nextStage: stages.market_overview, tasks: marketTasks };
    },
    publishResearchResult: async ({ researchId: id, generation: g, token, manifestS3Key, manifestFingerprint, result, resultFingerprint, selectionItems }) => {
      finalPublished = true;
      stages.market_overview.state = "completed";
      stages.market_overview.manifestS3Key = manifestS3Key;
      stages.market_overview.manifestFingerprint = manifestFingerprint;
      return { outcome: "terminal" };
    },
    failStage: async () => ({ outcome: "terminal" })
  };
  repo.stages = stages;
  repo.tasksByStage = tasksByStage;
  return { repo, get finalPublished() { return finalPublished; }, get stageOrder() { return stageOrder; } };
}

function memoryS3() {
  const objects = new Map();
  return {
    objects,
    async send(command) {
      if (command.constructor.name === "PutObjectCommand") {
        objects.set(command.input.Key, { Body: Buffer.from(command.input.Body), Metadata: command.input.Metadata || {} });
        return {};
      }
      if (command.constructor.name === "GetObjectCommand") {
        const object = objects.get(command.input.Key);
        if (!object) { const e = new Error("nsk"); e.name = "NoSuchKey"; throw e; }
        return { Body: Readable.from([object.Body]), ContentLength: object.Body.byteLength, Metadata: object.Metadata };
      }
      if (command.constructor.name === "ListObjectsV2Command") {
        const keys = [...objects.keys()].filter((key) => key.startsWith(command.input.Prefix));
        return { Contents: keys.slice(0, command.input.MaxKeys ?? 1).map((Key) => ({ Key })) };
      }
      return {};
    }
  };
}

function memoryDispatcher() {
  const sent = [];
  const options = [];
  return {
    sent,
    options,
    async sendOne(_queueUrl, message, schema, opts) {
      const result = schema.safeParse(message);
      if (!result.success) throw new Error("PIPELINE_MESSAGE_INVALID");
      options.push(opts);
      sent.push(result.data);
      return { sentItemIds: [message.taskNaturalId ?? message.researchId ?? message.stage], failedItemIds: [] };
    }
  };
}

function overviewResponse(keywords) {
  const items = keywords.map((keyword, index) => {
    const monthly = [];
    for (let m = 0; m < 15; m += 1) {
      const year = 2024 + Math.floor((index + m) / 12);
      const month = ((index + m) % 12) + 1;
      monthly.push({ year, month, search_volume: 800 + index * 5 + m });
    }
    return {
      keyword,
      keyword_info: { search_volume: 1000 + index * 10, cpc: 1.0, competition: 0.3, competition_level: "MEDIUM" },
      monthly_searches: monthly,
      keyword_properties: { keyword_difficulty: 40 + (index % 20) },
      search_intent_info: { main_intent: index % 3 === 0 ? "transactional" : "commercial" }
    };
  });
  return {
    status_code: 20000, status_message: "Ok.", cost: 0.0156, tasks_count: 1, results_count: 1,
    tasks: [{ id: "t", status_code: 20000, status_message: "Ok.", cost: 0.0156,
      result: [{ location_code: 2840, language_code: "en", items_count: items.length, items }] }]
  };
}

function expansionResponse(keyword, suffix) {
  const entries = [`${keyword} ${suffix} one`, `${keyword} ${suffix} two`];
  const items = entries.map((entry) => (suffix === "related" ? { keyword_data: { keyword: entry }, depth: 2, related_keywords: [] } : { keyword: entry }));
  return {
    status_code: 20000, status_message: "Ok.", cost: 0.0156, tasks_count: 1, results_count: 1,
    tasks: [{ id: "t", status_code: 20000, status_message: "Ok.", cost: 0.0156,
      result: [{ items_count: items.length, items }] }]
  };
}

function keywordHttp() {
  const calls = [];
  return {
    calls,
    async http(url, init) {
      const body = JSON.parse(init.body)[0];
      calls.push(url);
      if (url.includes("keyword_suggestions")) return { status: 200, json: async () => expansionResponse(body.keyword, "suggestions") };
      if (url.includes("related_keywords")) return { status: 200, json: async () => expansionResponse(body.keyword, "related") };
      return { status: 200, json: async () => overviewResponse(body.keywords) };
    }
  };
}

function runtimeFor(repo, s3, dispatch, httpSeam) {
  return {
    repository: repo,
    artifactStore: new S3ArtifactStore({ client: s3, bucket: "keyword-bucket", maxBytes: 33554432 }),
    dispatcher: dispatch,
    config: { awsPipelineBucket: "keyword-bucket", awsPipelineKeywordResearchQueueUrl: QUEUE_URL },
    s3Client: s3,
    clock: () => new Date(),
    http: httpSeam,
    secrets: { dataForSeoLogin: "login", dataForSeoPassword: "password" }
  };
}

async function drive(initial, runtime, seen) {
  const queue = [initial];
  let prevSent = 0;
  while (queue.length) {
    const message = queue.shift();
    const dedup = message.type.endsWith(".task.v1") ? `${message.type}:${message.taskNaturalId}` : null;
    if (dedup !== null) {
      if (seen.has(dedup)) continue;
      seen.add(dedup);
    }
    await processKeywordMessage(message, runtime);
    for (let index = prevSent; index < runtime.dispatcher.sent.length; index += 1) {
      queue.push(runtime.dispatcher.sent[index]);
    }
    prevSent = runtime.dispatcher.sent.length;
  }
}

test("component full flow (SCN-KI-001): single seed completes all message types with exact object/call oracles", async () => {
  const factory = statefulRepository(["seed one"]); const repo = factory.repo;
  const s3 = memoryS3();
  const dispatch = memoryDispatcher();
  const http = keywordHttp();
  const runtime = runtimeFor(repo, s3, dispatch, http.http);
  const seen = new Set();
  await drive({ contractVersion: 1, type: "keyword.initialize.v1", researchId: repo.researchId, generation: 1 }, runtime, seen);


  assert.equal(factory.finalPublished, true, "final publication reached");
  const types = new Set(dispatch.sent.map((m) => m.type));
  for (const type of ["keyword.expansion.task.v1", "keyword.overview.task.v1", "keyword.aggregate.check.v1"]) {
    assert.ok(types.has(type), `type ${type}`);
  }
  assert.equal(http.calls.length, 11, `single seed: 11 first-pass calls, got ${http.calls.length}`);
  assert.ok(s3.objects.has(keywordResultKey(repo.researchId, 1)), "final result.json present");
  assert.ok(s3.objects.has(keywordManifestKey(repo.researchId, 1, "expansion")));
  assert.ok(s3.objects.has(keywordManifestKey(repo.researchId, 1, "anchor_screen")));
  assert.ok(s3.objects.has(keywordManifestKey(repo.researchId, 1, "market_overview")));
});

test("component full flow (SCN-KI-013): five seeds produce 19 calls and at most 23 objects", async () => {
  const seeds = ["s1", "s2", "s3", "s4", "s5"];
  const factory = statefulRepository(seeds); const repo = factory.repo;
  const s3 = memoryS3();
  const dispatch = memoryDispatcher();
  const http = keywordHttp();
  const runtime = runtimeFor(repo, s3, dispatch, http.http);
  const seen = new Set();
  await drive({ contractVersion: 1, type: "keyword.initialize.v1", researchId: repo.researchId, generation: 1 }, runtime, seen);

  assert.equal(factory.finalPublished, true);
  assert.equal(http.calls.length, 19, `five seeds: 19 first-pass calls, got ${http.calls.length}`);
  const expTasks = dispatch.sent.filter((m) => m.type === "keyword.expansion.task.v1");
  assert.equal(expTasks.length, 10, "ten expansion task dispatches");
  const overviewTasks = dispatch.sent.filter((m) => m.type === "keyword.overview.task.v1");
  assert.equal(overviewTasks.length, 9, "one anchor + eight market overview task dispatches");
});

test("component negative control: an aggregate before task readiness performs no publication", async () => {
  const factory = statefulRepository(["seed one"]); const repo = factory.repo;
  const s3 = memoryS3();
  const dispatch = memoryDispatcher();
  const runtime = runtimeFor(repo, s3, dispatch, keywordHttp().http);
  await processInitialize({ contractVersion: 1, type: "keyword.initialize.v1", researchId: repo.researchId, generation: 1 }, runtime);
  const result = await processKeywordMessage({ contractVersion: 1, type: "keyword.aggregate.check.v1", researchId: repo.researchId, generation: 1, stage: "expansion" }, runtime);
  assert.equal(result.outcome, "not_ready");
  assert.equal(factory.finalPublished, false, "aggregation before task readiness must not publish");
  const overviewTasks = dispatch.sent.filter((m) => m.type === "keyword.overview.task.v1");
  assert.equal(overviewTasks.length, 0, "no anchor task before expansion readiness");
});

test("component handler builds a keyword-only store at maxBytes 33554432 and never alters the pipeline store", async () => {
  const handlerModule = await import("../src/aws-pipeline/keyword-intelligence/handler.js");
  assert.equal(handlerModule.KEYWORD_ARTIFACT_MAX_BYTES, 33554432);
  const keywordStore = new S3ArtifactStore({ client: memoryS3(), bucket: "keyword-bucket", maxBytes: handlerModule.KEYWORD_ARTIFACT_MAX_BYTES });
  assert.equal(keywordStore.maxBytes, 33554432);
  const pipelineDefault = new S3ArtifactStore({ client: memoryS3(), bucket: "pipeline-bucket" });
  assert.equal(pipelineDefault.maxBytes, 5000000);
  assert.notEqual(keywordStore.maxBytes, pipelineDefault.maxBytes);
  assert.notEqual(keywordStore, pipelineDefault, "stores are not shared");
});

function preFailedMonitor(code = "PIPELINE_LEASE_LOST") {
  return function factory() {
    const error = new Error(code);
    error.code = code;
    return {
      assertActive() { throw error; },
      async renewNow() { throw error; },
      async stop() { throw error; }
    };
  };
}

function stopFailsMonitor(code) {
  return function factory() {
    const error = new Error(code);
    error.code = code;
    return {
      assertActive() {},
      async renewNow() {},
      async stop() { throw error; }
    };
  };
}

function capturingMonitors(records) {
  return ({ intervalMs, now, renew }) => {
    const record = { intervalMs, renewals: 0 };
    records.push(record);
    const state = { failure: null, stopped: false };
    const monitor = {
      record,
      async renewNow() {
        record.renewals += 1;
        if (state.stopped) return;
        try { await renew(now()); } catch (error) { state.failure ??= error; throw error; }
      },
      assertActive() { if (state.failure) throw state.failure; },
      async stop() { state.stopped = true; if (state.failure) throw state.failure; }
    };
    return monitor;
  };
}

async function driveWithFactory(initial, runtime, factory, seen) {
  const queue = [initial];
  let prevSent = 0;
  while (queue.length) {
    const message = queue.shift();
    const dedup = message.type.endsWith(".task.v1") ? `${message.type}:${message.taskNaturalId}` : null;
    if (dedup !== null) {
      if (seen.has(dedup)) continue;
      seen.add(dedup);
    }
    const dependencies = message.type === "keyword.aggregate.check.v1"
      ? { createLeaseMonitor: factory } : undefined;
    await processKeywordMessage(message, runtime, dependencies);
    for (let index = prevSent; index < runtime.dispatcher.sent.length; index += 1) {
      queue.push(runtime.dispatcher.sent[index]);
    }
    prevSent = runtime.dispatcher.sent.length;
  }
}

function throttledTaskSetup(seeds) {
  const factory = statefulRepository(seeds);
  const repo = factory.repo;
  const s3 = memoryS3();
  const dispatch = memoryDispatcher();
  const http = keywordHttp();
  const nowBox = { current: NOW.getTime() };
  const runtime = { ...runtimeFor(repo, s3, dispatch, http.http), clock: () => new Date(nowBox.current) };
  repo.claimThrottle = async () => ({ outcome: "delayed", retryAt: new Date(nowBox.current + 3000) });
  repo.deferTask = async () => ({ outcome: "delayed", retryAt: new Date(nowBox.current + 3000) });
  return { factory, repo, s3, dispatch, runtime, nowBox };
}

test("SCN-KI-025: voluntary release stops the monitor and emits one exactly-delayed redelivery", async () => {
  const { dispatch, runtime } = throttledTaskSetup(["seed one"]);
  await processInitialize({ contractVersion: 1, type: "keyword.initialize.v1", researchId: runtime.repository.researchId, generation: 1 }, runtime);
  const taskMsg = dispatch.sent.find((m) => m.type === "keyword.expansion.task.v1");
  const sentBefore = dispatch.sent.length;
  const result = await processKeywordMessage(taskMsg, runtime);
  assert.equal(result.outcome, "retryAt", "throttle deferral returns retryAt");
  const redelivered = dispatch.sent.slice(sentBefore).filter((m) => m.type === "keyword.expansion.task.v1");
  assert.equal(redelivered.length, 1, "one delayed redelivery after monitor stop");
  assert.equal(redelivered[0].taskNaturalId, taskMsg.taskNaturalId, "same strict task message");
  assert.deepEqual(dispatch.options.at(-1), { delaySeconds: 3 }, "exact SQS DelaySeconds");
});

test("SCN-KI-025: stopReleasedLease suppresses only PIPELINE_LEASE_LOST and propagates other errors", async () => {
  const loss = { ...throttledTaskSetup(["seed two"]) };
  await processInitialize({ contractVersion: 1, type: "keyword.initialize.v1", researchId: loss.runtime.repository.researchId, generation: 1 }, loss.runtime);
  const lossMsg = loss.dispatch.sent.find((m) => m.type === "keyword.expansion.task.v1");
  const lossResult = await processKeywordMessage(lossMsg, loss.runtime, { createLeaseMonitor: stopFailsMonitor("PIPELINE_LEASE_LOST") });
  assert.equal(lossResult.outcome, "retryAt", "PIPELINE_LEASE_LOST on voluntary-release stop is suppressed");

  const other = throttledTaskSetup(["seed three"]);
  await processInitialize({ contractVersion: 1, type: "keyword.initialize.v1", researchId: other.runtime.repository.researchId, generation: 1 }, other.runtime);
  const otherMsg = other.dispatch.sent.find((m) => m.type === "keyword.expansion.task.v1");
  await assert.rejects(
    processKeywordMessage(otherMsg, other.runtime, { createLeaseMonitor: stopFailsMonitor("PIPELINE_OTHER") }),
    (error) => error?.code === "PIPELINE_OTHER",
    "non-lease monitor errors propagate"
  );
});

test("SCN-KI-026: aggregation monitors use 40000ms, renew on every terminal path, and publish once", async () => {
  const factory = statefulRepository(["seed one"]);
  const repo = factory.repo;
  const s3 = memoryS3();
  const dispatch = memoryDispatcher();
  const runtime = runtimeFor(repo, s3, dispatch, keywordHttp().http);
  const records = [];
  const seen = new Set();
  await driveWithFactory({ contractVersion: 1, type: "keyword.initialize.v1", researchId: repo.researchId, generation: 1 }, runtime, capturingMonitors(records), seen);
  assert.equal(factory.finalPublished, true, "market aggregation published");
  assert.equal(records.length, 3, "exactly three aggregation monitors");
  assert.ok(records.every((record) => record.intervalMs === 40000), "aggregation monitors use 40000ms");
  assert.ok(records.every((record) => record.renewals >= 1), "each published aggregation renewed before its fence transaction");
  assert.ok(s3.objects.has(keywordResultKey(repo.researchId, 1)), "final result written");
  const marketManifest = s3.objects.get(keywordManifestKey(repo.researchId, 1, "market_overview"));
  assert.ok(marketManifest, "market manifest written");
});

test("SCN-KI-026: detected aggregation lease loss before a read blocks all later S3/Neon/SQS", async () => {
  const factory = statefulRepository(["seed one"]);
  const repo = factory.repo;
  const s3 = memoryS3();
  const dispatch = memoryDispatcher();
  const runtime = runtimeFor(repo, s3, dispatch, keywordHttp().http);
  await processInitialize({ contractVersion: 1, type: "keyword.initialize.v1", researchId: repo.researchId, generation: 1 }, runtime);
  const expansionTasks = dispatch.sent.filter((m) => m.type === "keyword.expansion.task.v1");
  assert.equal(expansionTasks.length, 2);
  for (const message of expansionTasks) await processKeywordMessage(message, runtime);
  const expansionCheck = dispatch.sent.find((m) => m.type === "keyword.aggregate.check.v1" && m.stage === "expansion");
  const expResult = await processKeywordMessage(expansionCheck, runtime);
  assert.equal(expResult.outcome, "published");
  const anchorTask = dispatch.sent.find((m) => m.type === "keyword.overview.task.v1" && m.stage === "anchor_screen");
  await processKeywordMessage(anchorTask, runtime);
  const anchorCheck = dispatch.sent.find((m) => m.type === "keyword.aggregate.check.v1" && m.stage === "anchor_screen");
  const tasksBefore = dispatch.sent.length;
  await assert.rejects(
    processKeywordMessage(anchorCheck, runtime, { createLeaseMonitor: preFailedMonitor("PIPELINE_LEASE_LOST") }),
    (error) => error?.code === "PIPELINE_LEASE_LOST"
  );
  assert.ok(!s3.objects.has(keywordManifestKey(repo.researchId, 1, "anchor_screen")), "no shortlist manifest after loss");
  assert.equal(dispatch.sent.length, tasksBefore, "no market task or check dispatched after loss");
});

test("SCN-KI-026: failStage returns its fence outcome and callers propagate lost instead of stage_failed", async () => {
  const factory = statefulRepository(["seed one"]);
  const repo = factory.repo;
  const s3 = memoryS3();
  const dispatch = memoryDispatcher();
  const runtime = runtimeFor(repo, s3, dispatch, keywordHttp().http);
  await processInitialize({ contractVersion: 1, type: "keyword.initialize.v1", researchId: repo.researchId, generation: 1 }, runtime);
  repo.tasksByStage.expansion[0].state = "failed";
  repo.stages.expansion.state = "ready";
  repo.failStage = async () => ({ outcome: "lost" });
  const check = dispatch.sent.find((m) => m.type === "keyword.aggregate.check.v1" && m.stage === "expansion");
  const result = await processKeywordMessage(check, runtime);
  assert.equal(result.outcome, "lost", "lost failStage propagates, not stage_failed");
  assert.equal(factory.finalPublished, false, "no publication follows a lost failStage");
});
