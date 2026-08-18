import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../src/prisma-client.js";
import { keywordResearchConfigV1 } from "../src/keyword-intelligence/config.js";
import { PrismaKeywordResearchRepository, newResearchId } from "../src/keyword-intelligence/repository.js";
import { S3ArtifactStore } from "../src/aws-pipeline/adapters/artifact-store.js";
import { createIsolatedTestSchema, deployPrismaMigrations } from "./helpers/isolated-postgres.js";
import { handler, KEYWORD_ARTIFACT_MAX_BYTES } from "../src/aws-pipeline/keyword-intelligence/handler.js";
import { processKeywordMessage, processInitialize } from "../src/aws-pipeline/keyword-intelligence/service.js";
import { keywordMessageSchema } from "../src/aws-pipeline/keyword-intelligence/contracts.js";
import { keywordResultKey, keywordManifestKey } from "../src/aws-pipeline/keyword-intelligence/keys.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const fp = (value) => createHash("sha256").update(String(value)).digest("hex");
const fixtureDir = fileURLToPath(new URL("./fixtures/keyword-intelligence", import.meta.url));
const readFixture = (name) => JSON.parse(readFileSync(`${fixtureDir}/${name}`, "utf8"));
const WORKER_MESSAGES = readFixture("worker-message-cases-v1.json");
const CONFIG = keywordResearchConfigV1();
const NOW = new Date();
const QUEUE_URL = "https://sqs.example/keyword-research";

function memoryS3() {
  const objects = new Map();
  const sentCommands = [];
  return {
    objects,
    sentCommands,
    async send(command) {
      sentCommands.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "PutObjectCommand") {
        if (command.input.IfNoneMatch === "*" && objects.has(command.input.Key)) {
          const error = new Error("exists");
          error.name = "PreconditionFailed";
          error.$metadata = { httpStatusCode: 412 };
          throw error;
        }
        objects.set(command.input.Key, { Body: Buffer.from(command.input.Body), Metadata: command.input.Metadata || {} });
        return {};
      }
      if (command.constructor.name === "GetObjectCommand") {
        const object = objects.get(command.input.Key);
        if (!object) {
          const error = new Error("no such key");
          error.name = "NoSuchKey";
          throw error;
        }
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
  return {
    sent,
    async sendOne(_queueUrl, message, schema) {
      const result = schema.safeParse(message);
      if (!result.success) throw new Error("PIPELINE_MESSAGE_INVALID");
      const parsed = result.data;
      sent.push(parsed);
      return { sentItemIds: [parsed.taskNaturalId ?? parsed.researchId ?? parsed.stage], failedItemIds: [] };
    },
    async sendMany() {
      throw new Error("keyword recovery never batches");
    }
  };
}

function overviewResponse(keywords) {
  const items = keywords.map((keyword, index) => {
    const monthly = [];
    for (let m = 0; m < 15; m += 1) {
      monthly.push({ year: 2024 + Math.floor((index + m) / 12), month: ((index + m) % 12) + 1, search_volume: 800 + index * 5 + m });
    }
    return {
      keyword,
      keyword_info: {
        search_volume: 1000 + index * 10,
        cpc: 1.0 + index / 100,
        competition: 0.3 + (index % 5) / 10,
        competition_level: index % 2 === 0 ? "MEDIUM" : "LOW"
      },
      monthly_searches: monthly,
      keyword_properties: { keyword_difficulty: 40 + (index % 20) },
      search_intent_info: { main_intent: index % 3 === 0 ? "transactional" : "commercial" }
    };
  });
  return {
    status_code: 20000,
    status_message: "Ok.",
    cost: 0.012 + 0.00012 * keywords.length,
    tasks_count: 1,
    results_count: 1,
    tasks: [{
      id: "00000000-0000-0000-0000-0000000000aa",
      status_code: 20000,
      status_message: "Ok.",
      cost: 0.012 + 0.00012 * keywords.length,
      result: [{ location_code: 2840, language_code: "en", items_count: items.length, items }]
    }]
  };
}

function expansionResponse(keyword, suffix) {
  const entries = [`${keyword} ${suffix} one`, `${keyword} ${suffix} two`, `${keyword} ${suffix} three`];
  const items = entries.map((entry) => (suffix === "related"
    ? { keyword_data: { keyword: entry }, depth: 2, related_keywords: [] }
    : { keyword: entry }));
  return {
    status_code: 20000,
    status_message: "Ok.",
    cost: 0.0156,
    tasks_count: 1,
    results_count: 1,
    tasks: [{
      id: "00000000-0000-0000-0000-0000000000aa",
      status_code: 20000,
      status_message: "Ok.",
      cost: 0.0156,
      result: [{ items_count: items.length, items }]
    }]
  };
}

function keywordHttp() {
  const calls = [];
  return {
    calls,
    async http(url, init) {
      const body = JSON.parse(init.body);
      const payload = body[0];
      calls.push({ url, payload });
      if (url.includes("keyword_suggestions")) return { status: 200, json: async () => expansionResponse(payload.keyword, "suggestions") };
      if (url.includes("related_keywords")) return { status: 200, json: async () => expansionResponse(payload.keyword, "related") };
      return { status: 200, json: async () => overviewResponse(payload.keywords) };
    }
  };
}

function runtimeFor(repo, s3, dispatch, httpSeam) {
  return {
    repository: repo,
    artifactStore: new S3ArtifactStore({ client: s3, bucket: "keyword-bucket", maxBytes: KEYWORD_ARTIFACT_MAX_BYTES }),
    dispatcher: dispatch,
    config: { awsPipelineBucket: "keyword-bucket", awsPipelineKeywordResearchQueueUrl: QUEUE_URL },
    s3Client: s3,
    clock: () => new Date(),
    http: httpSeam,
    secrets: { dataForSeoLogin: "login", dataForSeoPassword: "password" }
  };
}

async function resetThrottle(db, schema) {
  await db.$executeRawUnsafe(`UPDATE "${schema}"."KeywordProviderThrottle" SET "nextAllowedAt" = now() - interval '10 seconds'`);
}

async function drain(runtime, db, initial) {
  const processed = [];
  const queue = [initial];
  const seen = new Set();
  let prevSent = 0;
  while (queue.length) {
    const message = queue.shift();
    const key = `${message.type}:${message.taskNaturalId ?? ""}:${message.stage ?? ""}:${message.inputFingerprint ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (message.type !== "keyword.aggregate.check.v1") await resetThrottle(db, runtime.repository.schema);
    const result = await processKeywordMessage(message, runtime);
    processed.push({ message, result });
    for (let index = prevSent; index < runtime.dispatcher.sent.length; index += 1) {
      queue.push(runtime.dispatcher.sent[index]);
    }
    prevSent = runtime.dispatcher.sent.length;
    if (processed.length > 200) throw new Error("runaway dispatch loop");
  }
  return processed;
}

test("worker message fixtures parse exactly per PAY-KI-006", () => {
  for (const c of WORKER_MESSAGES.cases) {
    const payloads = Array.isArray(c.payload) ? c.payload : [c.payload];
    const accepted = payloads.filter((payload) => keywordMessageSchema.safeParse(payload).success).length;
    if (c.expect === "message_accepted") assert.equal(accepted, 1, c.id);
    if (c.expect === "message_rejected") assert.equal(accepted, 0, c.id);
    if (c.expect === "mixed_batch_partial") assert.equal(accepted, 1, c.id);
  }
});

test("handler rejects a mixed batch per-record and keeps valid records isolated", async () => {
  const repo = { getTaskContext: async () => ({ outcome: "not_found" }) };
  const s3 = memoryS3();
  const dispatch = memoryDispatcher();
  const rt = runtimeFor(repo, s3, dispatch, keywordHttp().http);
  const event = {
    Records: [
      { messageId: "m1", body: JSON.stringify({
        contractVersion: 1, type: "keyword.expansion.task.v1",
        researchId: "kr_synthetic0000000000000001", generation: 1, stage: "expansion",
        taskNaturalId: "tsynthetic0000000000000001",
        inputFingerprint: "a30692beb8993ea17fec19a9b3defec53b87f4049a2fe0914232280b085ab458"
      }) },
      { messageId: "m2", body: JSON.stringify({ contractVersion: 99, type: "keyword.initialize.v1", researchId: "x", generation: 1 }) }
    ]
  };
  const outcome = await handler(event, rt);
  assert.deepEqual(outcome.batchItemFailures, [{ itemIdentifier: "m2" }]);
});

test("processKeywordMessage rejects an unknown discriminator via invariant", async () => {
  const rt = runtimeFor({}, memoryS3(), memoryDispatcher(), keywordHttp().http);
  await assert.rejects(
    processKeywordMessage({ type: "keyword.unknown.v1" }, rt),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT"
  );
});

function isTransientPrismaError(error) {
  return error?.name === "PrismaClientUnknownRequestError" &&
    /Response from the Engine was empty/u.test(String(error?.message ?? ""));
}

async function withRetry(fn, attempts = 4) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isTransientPrismaError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw last;
}

function retryableRepository(repo) {
  return new Proxy(repo, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return (...args) => withRetry(() => value.apply(target, args));
    }
  });
}

async function withIsolatedDb(schema, fn) {
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema, {});
  let db;
  try {
    await deployPrismaMigrations(scopedUrl);
    db = createPrismaClient(scopedUrl);
    return await fn({ db, repo: retryableRepository(new PrismaKeywordResearchRepository(db)) });
  } finally {
    await db?.$disconnect().catch(() => {});
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.$disconnect().catch(() => {});
  }
}

function fakeMonitors() {
  const monitors = [];
  const factory = ({ intervalMs, now, renew }) => {
    const state = { failure: null, stopped: false, renewals: 0 };
    const monitor = {
      state,
      intervalMs,
      async renewNow() {
        if (state.stopped) return;
        state.renewals += 1;
        try {
          await renew(now());
        } catch (error) {
          state.failure ??= error;
          throw error;
        }
      },
      assertActive() {
        if (state.failure) throw state.failure;
      },
      async stop() {
        state.stopped = true;
        if (state.failure) throw state.failure;
      },
      async tick() {
        await monitor.renewNow();
      }
    };
    monitors.push(monitor);
    return monitor;
  };
  return { factory, monitors };
}

function clockedRuntime(repo, s3, dispatch, httpSeam, nowBox) {
  return {
    ...runtimeFor(repo, s3, dispatch, httpSeam),
    clock: () => new Date(nowBox.current)
  };
}

function countingHttp() {
  const calls = [];
  return {
    calls,
    async http(url, init) {
      const payload = JSON.parse(init.body)[0];
      calls.push({ url, payload });
      if (url.includes("keyword_suggestions")) return { status: 200, json: async () => expansionResponse(payload.keyword, "suggestions") };
      return { status: 200, json: async () => expansionResponse(payload.keyword, "related") };
    }
  };
}

async function createAndInitialize(db, repo, runtime, seeds) {
  const researchId = newResearchId();
  assert.equal((await repo.create({
    researchId, ownerId: "owner", configSnapshot: CONFIG, configFingerprint: fp("c"),
    seeds, markets: CONFIG.markets
  }, NOW)).outcome, "created");
  const initialized = await processInitialize({ contractVersion: 1, type: "keyword.initialize.v1", researchId, generation: 1 }, runtime);
  assert.equal(initialized.outcome, "initialized");
  return { researchId, expansionTask: runtime.dispatcher.sent.find((entry) => entry.type === "keyword.expansion.task.v1") };
}

test("SCN-KI-012: competing task owners at exact lease expiry keep one live fence, one terminal, and immutable replay", { skip: !enabled }, async () => {
  await withIsolatedDb("kiw3_scn012", async ({ db, repo }) => {
    const nowBox = { current: NOW.getTime() };
    const s3 = memoryS3();
    const dispatch = memoryDispatcher();
    const http = countingHttp();
    const runtimeA = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
    const runtimeB = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
    const monitors = fakeMonitors();
    const { expansionTask } = await createAndInitialize(db, repo, runtimeA, ["seed one"]);
    const message = { ...expansionTask };
    const taskId = message.taskNaturalId;
    const aToken = "a".repeat(32);

    const claimedA = await repo.claim({ taskId, owner: "owner-A", token: aToken }, new Date(nowBox.current));
    assert.equal(claimedA.outcome, "claimed", "owner A holds the lease at T0");
    for (const seconds of [20, 40, 60, 80, 100, 120]) {
      nowBox.current = NOW.getTime() + seconds * 1000;
      assert.equal((await repo.heartbeat({ taskId, token: aToken }, new Date(nowBox.current))).outcome, "claimed",
        `A heartbeat at T0+${seconds}s renews while live`);
    }
    nowBox.current = NOW.getTime() + 180000;
    assert.equal((await repo.heartbeat({ taskId, token: aToken }, new Date(nowBox.current))).outcome, "lost",
      "stale A heartbeat at exact last expiry changes zero rows");

    const resultB = await processKeywordMessage(message, runtimeB, { createLeaseMonitor: monitors.factory });
    assert.equal(resultB.outcome, "succeeded", "B reclaims at exact expiry and completes the task");
    const task = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
    assert.equal(task.state, "succeeded");
    assert.equal(task.attemptCount, 1, "one live fence produced one attempt");

    const staleTerminal = await repo.terminalize({
      taskId, token: aToken, state: "failed", safeErrorCode: "KEYWORD_PROVIDER_RETRY_EXHAUSTED"
    }, new Date(nowBox.current));
    assert.equal(staleTerminal.outcome, "conflict", "stale A terminal cannot overwrite the immutable succeeded row");
    const afterStale = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
    assert.equal(afterStale.state, "succeeded", "terminal state is immutable under a stale owner");
    assert.equal((await db.keywordResearchProviderAttempt.findMany({ where: { taskId } })).length, 1,
      "one attempt row total");

    const checkMessages = dispatch.sent.filter((entry) => entry.type === "keyword.aggregate.check.v1");
    assert.equal(checkMessages.length, 2, "initialize check plus exactly one check from the single terminal owner");

    const replay = await processKeywordMessage(message, runtimeB, { createLeaseMonitor: monitors.factory });
    assert.equal(replay.outcome, "conflict", "terminal task is immutable on service replay");
    assert.equal((await db.keywordResearchProviderAttempt.findMany({ where: { taskId } })).length, 1);
  });
});

test("SCN-KI-024: crash after settle before S3 then B recovery writes the byte-identical artifact with zero HTTP", { skip: !enabled }, async () => {
  await withIsolatedDb("kiw3_scn024a", async ({ db, repo }) => {
    const nowBox = { current: NOW.getTime() };
    const s3 = memoryS3();
    const dispatch = memoryDispatcher();
    const http = countingHttp();
    const runtimeA = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
    runtimeA.artifactStore = {
      async putImmutable() { const error = new Error("simulated S3 crash before put"); error.code = "PIPELINE_ARTIFACT_INVALID"; throw error; },
      async getValidated() { throw new Error("must not read during A"); }
    };
    const monitors = fakeMonitors();
    const { expansionTask } = await createAndInitialize(db, repo, runtimeA, ["seed one"]);
    const message = { ...expansionTask };

    await assert.rejects(
      processKeywordMessage(message, runtimeA, { createLeaseMonitor: monitors.factory }),
      (error) => error?.code === "PIPELINE_ARTIFACT_INVALID"
    );
    const task = await db.keywordResearchTask.findUnique({ where: { id: message.taskNaturalId } });
    assert.equal(task.state, "processing", "A crash leaves the task processing");
    const attempt = await db.keywordResearchProviderAttempt.findFirst({ where: { taskId: task.id } });
    assert.equal(attempt.state, "succeeded", "known success settled durably despite the crash");
    assert.equal(attempt.providerCostUsd.toFixed(8), "0.01560000");
    const cache = await db.keywordResearchCache.findUnique({ where: { requestFingerprint: task.requestFingerprint } });
    assert.ok(cache, "normalized cache written in the same settlement transaction");
    assert.equal(s3.objects.size, 0, "no artifact written before the crash");

    nowBox.current = NOW.getTime() + 60000;
    const runtimeB = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
    const monitorsB = fakeMonitors();
    const beforeCalls = http.calls.length;
    const resultB = await processKeywordMessage(message, runtimeB, { createLeaseMonitor: monitorsB.factory });
    assert.equal(resultB.outcome, "recovered", "B reclaims and reconstructs from attempt+cache");
    assert.equal(http.calls.length, beforeCalls, "B performs zero additional HTTP calls");
    assert.equal(s3.objects.size, 1, "exactly one immutable artifact");
    const terminal = await db.keywordResearchTask.findUnique({ where: { id: task.id } });
    assert.equal(terminal.state, "succeeded");
    assert.equal(terminal.attemptCount, 1);
    const artifactKey = terminal.artifactS3Key;
    const object = s3.objects.get(artifactKey);
    const artifact = JSON.parse(object.Body.toString("utf8"));
    assert.equal(artifact.costUsd, "0.01560000", "succeeded recovery writes the durable cost");
    assert.ok(terminal.artifactFingerprint, "artifact fingerprint recorded");
    const checkMessages = dispatch.sent.filter((entry) => entry.type === "keyword.aggregate.check.v1");
    assert.equal(checkMessages.length, 2, "initialize check plus exactly one recovery check");
  });
});

test("SCN-KI-024: crash after S3 before terminal then B recovery exact-matches the immutable artifact with zero HTTP", { skip: !enabled }, async () => {
  await withIsolatedDb("kiw3_scn024b", async ({ db, repo }) => {
    const nowBox = { current: NOW.getTime() };
    const s3 = memoryS3();
    const dispatch = memoryDispatcher();
    const http = countingHttp();
    const realStore = new S3ArtifactStore({ client: s3, bucket: "keyword-bucket", maxBytes: KEYWORD_ARTIFACT_MAX_BYTES });
    const runtimeA = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
    runtimeA.artifactStore = {
      async putImmutable(input) {
        const result = await realStore.putImmutable(input);
        const error = new Error("simulated S3 crash after put");
        error.code = "PIPELINE_ARTIFACT_INVALID";
        throw error;
      },
      async getValidated(input) { return realStore.getValidated(input); }
    };
    const monitors = fakeMonitors();
    const { expansionTask } = await createAndInitialize(db, repo, runtimeA, ["seed one"]);
    const message = { ...expansionTask };

    await assert.rejects(
      processKeywordMessage(message, runtimeA, { createLeaseMonitor: monitors.factory }),
      (error) => error?.code === "PIPELINE_ARTIFACT_INVALID"
    );
    const task = await db.keywordResearchTask.findUnique({ where: { id: message.taskNaturalId } });
    assert.equal(task.state, "processing");
    const orphanKey = [...s3.objects.keys()][0];
    assert.equal(s3.objects.size, 1, "the immutable orphan exists before terminalization");
    assert.ok(orphanKey, "orphan artifact key captured from S3");

    nowBox.current = NOW.getTime() + 60000;
    const runtimeB = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
    const monitorsB = fakeMonitors();
    const beforeCalls = http.calls.length;
    const resultB = await processKeywordMessage(message, runtimeB, { createLeaseMonitor: monitorsB.factory });
    assert.equal(resultB.outcome, "recovered");
    assert.equal(http.calls.length, beforeCalls, "B performs zero HTTP calls");
    assert.equal(s3.objects.size, 1, "no second artifact object");
    const terminal = await db.keywordResearchTask.findUnique({ where: { id: task.id } });
    assert.equal(terminal.state, "succeeded");
    assert.equal(terminal.artifactS3Key, orphanKey, "B reconciles the exact orphan key");
    const object = s3.objects.get(orphanKey);
    const artifact = JSON.parse(object.Body.toString("utf8"));
    assert.equal(artifact.costUsd, "0.01560000");
    const checkMessages = dispatch.sent.filter((entry) => entry.type === "keyword.aggregate.check.v1");
    assert.equal(checkMessages.length, 2, "initialize check plus exactly one recovery check");
  });
});

test("SCN-KI-025: delayed retry redelivery is dispatched only when due and early duplicate acknowledges without a call", { skip: !enabled }, async () => {
  await withIsolatedDb("kiw3_scn025", async ({ db, repo }) => {
    const nowBox = { current: NOW.getTime() };
    const s3 = memoryS3();
    const dispatch = memoryDispatcher();
    const http = countingHttp();
    const runtime = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
    const monitors = fakeMonitors();
    const { expansionTask } = await createAndInitialize(db, repo, runtime, ["seed one"]);
    const message = { ...expansionTask };

    await db.$executeRawUnsafe(
      `INSERT INTO "${repo.schema}"."KeywordProviderThrottle" ("provider", "nextAllowedAt", "updatedAt") VALUES ('dataforseo_labs_keyword', now() + interval '10 seconds', now())`
    );
    const sentBefore = dispatch.sent.length;
    const first = await processKeywordMessage(message, runtime, { createLeaseMonitor: monitors.factory });
    assert.equal(first.outcome, "retryAt", "throttle defers durably");
    const task = await db.keywordResearchTask.findUnique({ where: { id: message.taskNaturalId } });
    assert.equal(task.state, "pending");
    assert.equal(task.leaseToken, null, "voluntary release clears the lease");
    assert.ok(task.nextAttemptAt, "durable due time stored");
    assert.equal(http.calls.length, 0, "deferral performs no HTTP call");
    const attempts = await db.keywordResearchProviderAttempt.count({ where: { taskId: task.id } });
    assert.equal(attempts, 0, "deferral consumes no attempt");
    const redelivered = dispatch.sent.slice(sentBefore).filter((entry) =>
      entry.type === "keyword.expansion.task.v1" && entry.taskNaturalId === task.id);
    assert.equal(redelivered.length, 1, "one delayed same-task redelivery after monitor stop");
    assert.equal(redelivered[0].taskNaturalId, message.taskNaturalId, "same strict task message redelivered");

    await db.$executeRawUnsafe(`UPDATE "${repo.schema}"."KeywordProviderThrottle" SET "nextAllowedAt" = now() - interval '10 seconds'`);
    const early = await processKeywordMessage(message, runtime, { createLeaseMonitor: monitors.factory });
    assert.equal(early.outcome, "delayed", "early duplicate before due acknowledges without a call");
    assert.equal(http.calls.length, 0, "early duplicate performs zero HTTP");
    assert.equal((await db.keywordResearchProviderAttempt.count({ where: { taskId: task.id } })), 0);

    await db.$executeRawUnsafe(
      `UPDATE "${repo.schema}"."KeywordResearchTask" SET "nextAttemptAt" = '${new Date(nowBox.current - 10000).toISOString()}' WHERE "id" = '${task.id}'`
    );
    const due = await processKeywordMessage(message, runtime, { createLeaseMonitor: monitors.factory });
    assert.equal(due.outcome, "succeeded", "due redelivery runs the provider once");
    assert.equal(http.calls.length, 1);
  });
});

test("initialize creates the exact immutable expansion task set and replay dispatches without conflict", { skip: !enabled }, async () => {
  await withIsolatedDb("kiw3_init_1", async ({ db, repo }) => {
    const s3 = memoryS3();
    const dispatch = memoryDispatcher();
    const runtime = runtimeFor(repo, s3, dispatch, keywordHttp().http);
    const researchId = newResearchId();
    assert.equal((await repo.create({
      researchId, ownerId: "owner", configSnapshot: CONFIG, configFingerprint: fp("c"),
      seeds: ["seed one", "seed two"], markets: CONFIG.markets
    }, NOW)).outcome, "created");
    const message = { contractVersion: 1, type: "keyword.initialize.v1", researchId, generation: 1 };
    const first = await processInitialize(message, runtime);
    assert.equal(first.outcome, "initialized");
    assert.equal(dispatch.sent.filter((entry) => entry.type === "keyword.expansion.task.v1").length, 4);
    const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
    assert.equal(research.state, "running");
    const stage = await db.keywordResearchStage.findFirst({ where: { researchId } });
    assert.equal(stage.stage, "expansion");
    assert.equal(stage.expectedCount, 4);
    const replay = await processInitialize(message, runtime);
    assert.equal(replay.outcome, "initialized");
    assert.equal(dispatch.sent.filter((entry) => entry.type === "keyword.expansion.task.v1").length, 8);
  });
});

test("SCN-KI-001 full nonempty research completes durably with exact oracle objects/counters", { skip: !enabled }, async () => {
  await withIsolatedDb("kiw3_scn001", async ({ db, repo }) => {
    const s3 = memoryS3();
    const dispatch = memoryDispatcher();
    const http = keywordHttp();
    const runtime = runtimeFor(repo, s3, dispatch, http.http);
    const researchId = newResearchId();
    assert.equal((await repo.create({
      researchId, ownerId: "owner", configSnapshot: CONFIG, configFingerprint: fp("c"),
      seeds: ["seed one"], markets: CONFIG.markets
    }, NOW)).outcome, "created");
    await drain(runtime, db, {
      contractVersion: 1, type: "keyword.initialize.v1", researchId, generation: 1
    });
    const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
    assert.equal(research.state, "completed");
    assert.equal(research.selectionRevision, 1);
    assert.ok(research.resultFingerprint, "result fingerprint set");
    assert.ok(Array.isArray(research.result.keywords) && research.result.keywords.length > 0);
    assert.ok(Array.isArray(research.selection.items) && research.selection.items.length > 0);
    assert.equal(research.selection.items.length, Math.min(100, research.result.keywords.length));

    const stages = await db.keywordResearchStage.findMany({ where: { researchId }, orderBy: { stage: "asc" } });
    assert.deepEqual(stages.map((entry) => entry.stage), ["expansion", "anchor_screen", "market_overview"]);
    assert.ok(stages.every((entry) => entry.state === "completed"));

    const allTasks = await db.keywordResearchTask.findMany({ where: { stage: { researchId } } });
    assert.equal(allTasks.length, 11);
    assert.ok(allTasks.every((entry) => entry.state === "succeeded"));

    const types = new Set(dispatch.sent.map((entry) => entry.type));
    for (const type of ["keyword.expansion.task.v1", "keyword.overview.task.v1", "keyword.aggregate.check.v1"]) {
      assert.ok(types.has(type), `message type ${type} reached`);
    }

    const keys = [...s3.objects.keys()];
    assert.ok(keys.includes(keywordResultKey(researchId, 1)), `final result present`);
    assert.ok(keys.includes(keywordManifestKey(researchId, 1, "expansion")));
    assert.ok(keys.includes(keywordManifestKey(researchId, 1, "anchor_screen")));
    assert.ok(keys.includes(keywordManifestKey(researchId, 1, "market_overview")));
    assert.ok(keys.length >= 14, `at least 14 objects, got ${keys.length}`);
    assert.ok(http.calls.length <= 11, `at most 11 provider calls, got ${http.calls.length}`);
    const attempts = await db.keywordResearchProviderAttempt.findMany({ where: { task: { stage: { researchId } } } });
    assert.equal(attempts.length, http.calls.length);
    assert.ok(attempts.every((entry) => entry.state === "succeeded"));
  });
});

test("SCN-KI-013 five-seed maximum scale produces 19 first-pass calls and at most 95 attempt rows", { skip: !enabled }, async () => {
  await withIsolatedDb("kiw3_scn013", async ({ db, repo }) => {
    const s3 = memoryS3();
    const dispatch = memoryDispatcher();
    const http = keywordHttp();
    const runtime = runtimeFor(repo, s3, dispatch, http.http);
    const researchId = newResearchId();
    const seeds = ["seed one", "seed two", "seed three", "seed four", "seed five"];
    assert.equal((await repo.create({
      researchId, ownerId: "owner", configSnapshot: CONFIG, configFingerprint: fp("c"),
      seeds, markets: CONFIG.markets
    }, NOW)).outcome, "created");
    await drain(runtime, db, {
      contractVersion: 1, type: "keyword.initialize.v1", researchId, generation: 1
    });
    const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
    assert.equal(research.state, "completed");
    const allTasks = await db.keywordResearchTask.findMany({ where: { stage: { researchId } } });
    assert.equal(allTasks.length, 19);
    const attempts = await db.keywordResearchProviderAttempt.findMany({ where: { task: { stage: { researchId } } } });
    assert.equal(attempts.length, 19);
    assert.ok(attempts.length <= 95, `at most 95 attempt rows, got ${attempts.length}`);
    assert.equal(http.calls.length, 19, "19 first-pass calls");
    assert.ok(s3.objects.size <= 23, `at most 23 S3 objects, got ${s3.objects.size}`);
  });
});

test("SCN-KI-007 throttle defers without an attempt and the task is redelivered when due", { skip: !enabled }, async () => {
  await withIsolatedDb("kiw3_scn007", async ({ db, repo }) => {
    const s3 = memoryS3();
    const dispatch = memoryDispatcher();
    const http = keywordHttp();
    const runtime = runtimeFor(repo, s3, dispatch, http.http);
    const researchId = newResearchId();
    assert.equal((await repo.create({
      researchId, ownerId: "owner", configSnapshot: CONFIG, configFingerprint: fp("c"),
      seeds: ["seed one"], markets: CONFIG.markets
    }, NOW)).outcome, "created");
    await processInitialize({ contractVersion: 1, type: "keyword.initialize.v1", researchId, generation: 1 }, runtime);
    await db.$executeRawUnsafe(
      `INSERT INTO "${repo.schema}"."KeywordProviderThrottle" ("provider", "nextAllowedAt", "updatedAt") VALUES ('dataforseo_labs_keyword', now() + interval '10 seconds', now())`
    );
    const expansionTask = dispatch.sent.find((entry) => entry.type === "keyword.expansion.task.v1");
    const first = await processKeywordMessage(expansionTask, runtime);
    assert.equal(first.outcome, "retryAt");
    const task = await db.keywordResearchTask.findUnique({ where: { id: expansionTask.taskNaturalId } });
    assert.equal(task.state, "pending");
    assert.ok(task.nextAttemptAt, "durable retry due time stored");
    const attempts = await db.keywordResearchProviderAttempt.count({ where: { taskId: task.id } });
    assert.equal(attempts, 0, "throttle deferral consumes no attempt");
    assert.equal(http.calls.length, 0, "throttle deferral performs no HTTP call");
    await resetThrottle(db, repo.schema);
    await db.$executeRawUnsafe(`UPDATE "${repo.schema}"."KeywordResearchTask" SET "nextAttemptAt" = now() - interval '10 seconds' WHERE "id" = ${`'${task.id}'`}`);
    const second = await processKeywordMessage(expansionTask, runtime);
    assert.equal(second.outcome, "succeeded");
    assert.equal(http.calls.length, 1);
  });
});

test("negative control: bypassing the anchor worker leaves completion false", { skip: !enabled }, async () => {
  await withIsolatedDb("kiw3_negctl", async ({ db, repo }) => {
    const s3 = memoryS3();
    const dispatch = memoryDispatcher();
    const http = keywordHttp();
    const runtime = runtimeFor(repo, s3, dispatch, http.http);
    const researchId = newResearchId();
    assert.equal((await repo.create({
      researchId, ownerId: "owner", configSnapshot: CONFIG, configFingerprint: fp("c"),
      seeds: ["seed one"], markets: CONFIG.markets
    }, NOW)).outcome, "created");
    await processInitialize({ contractVersion: 1, type: "keyword.initialize.v1", researchId, generation: 1 }, runtime);
    const messages = [...dispatch.sent];
    for (const message of messages) {
      if (message.type === "keyword.expansion.task.v1") await processKeywordMessage(message, runtime);
    }
    const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
    assert.notEqual(research.state, "completed", "bypassing anchor worker must not complete research");
  });
});
