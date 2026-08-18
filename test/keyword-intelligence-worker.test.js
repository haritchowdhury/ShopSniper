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
import {
  keywordMessageSchema,
  KEYWORD_PROVIDER_AMBIGUOUS,
  KEYWORD_PROVIDER_AUTH_FAILED,
  KEYWORD_PROVIDER_CONTRACT_MISMATCH,
  KEYWORD_PROVIDER_TASK_FAILED,
  KEYWORD_PROVIDER_RETRYABLE,
  KEYWORD_PROVIDER_RETRY_EXHAUSTED
} from "../src/aws-pipeline/keyword-intelligence/contracts.js";
import {
  keywordResultKey,
  keywordManifestKey,
  keywordRequestFingerprint,
  keywordTaskInputFingerprint
} from "../src/aws-pipeline/keyword-intelligence/keys.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";

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

async function cleanDurableRows(db, repo) {
  const schema = repo.schema;
  await db.$executeRawUnsafe(`DELETE FROM "${schema}"."KeywordResearchCache"`);
  await db.$executeRawUnsafe(`DELETE FROM "${schema}"."KeywordProviderThrottle"`);
  await db.$executeRawUnsafe(`DELETE FROM "${schema}"."KeywordResearch"`);
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

const ENFORCEMENT_MANIFEST = readFixture("ki-r3-enforcement-manifest-v1.json");
const TASK_COMPONENT_IDS = ENFORCEMENT_MANIFEST.groups.task_component;
const RECOVERY_COMPONENT_IDS = ENFORCEMENT_MANIFEST.groups.recovery_component;
const DATABASE_IDS = ENFORCEMENT_MANIFEST.groups.task_database;
const R4_MANIFEST = readFixture("ki-r4-enforcement-manifest-v1.json");
const R4_WORKER_CONFLICT_IDS = R4_MANIFEST.groups.worker_component.filter((id) => id.endsWith("-conflict"));
const R4_WORKER_FALSIFY_IDS = R4_MANIFEST.groups.worker_component.filter((id) => id.endsWith("-falsifies"));

const COMPONENT_RESEARCH_ID = "kr_r3comp000000000000000000";
const COMPONENT_TASK_ID = "krt_r3comp00000000000000000";
const COMPONENT_STAGE_ID = "krs_r3comp00000000000000000";
const COMPONENT_T0 = new Date("2026-08-17T00:00:00.000Z");

function countOp(trace, op) {
  return trace.filter((entry) => entry === op).length;
}

function assertNoOp(trace, op) {
  assert.equal(countOp(trace, op), 0, `trace must not contain ${op}: ${JSON.stringify(trace)}`);
}

function assertDecisiveTail(trace, decisive) {
  let pos = 0;
  for (const op of decisive) {
    const idx = trace.indexOf(op, pos);
    assert.notEqual(idx, -1, `trace ${JSON.stringify(trace)} is missing ${op}`);
    pos = idx + 1;
  }
  for (const op of trace.slice(pos)) {
    assert.ok(op === "assert" || op === "stop",
      `unexpected op ${op} after decisive tail in ${JSON.stringify(trace)}`);
  }
}

function expansionComponentPayload() {
  const entries = ["seed one suggestions one", "seed one suggestions two", "seed one suggestions three"];
  const items = entries.map((keyword) => ({ keyword }));
  return {
    status_code: 20000, status_message: "Ok.", cost: 0.0156, tasks_count: 1, results_count: 1,
    tasks: [{ id: "t", status_code: 20000, status_message: "Ok.", cost: 0.0156,
      result: [{ items_count: items.length, items }] }]
  };
}

function componentHarness(spec = {}) {
  const trace = spec.trace ?? [];
  const nowBox = spec.nowBox ?? { current: COMPONENT_T0.getTime() };
  const clock = () => new Date(nowBox.current);
  const suggestionRequest = { keyword: "seed one", location_code: 2840, language_code: "en", limit: 30 };
  const inputFp = keywordTaskInputFingerprint({
    contractVersion: "keyword-expansion-input-v1", researchId: COMPONENT_RESEARCH_ID, generation: 1,
    payload: { seed: "seed one", endpointKey: "keyword_suggestions" }
  });
  const reqFp = keywordRequestFingerprint("keyword_suggestions", suggestionRequest);
  const task = {
    id: COMPONENT_TASK_ID, stageId: COMPONENT_STAGE_ID, itemKey: "0:suggestions",
    inputFingerprint: inputFp, endpointKey: "keyword_suggestions", requestFingerprint: reqFp,
    nextAttemptAt: spec.nextAttemptAt ?? null, state: "pending", attemptCount: spec.attemptCount ?? 0,
    leaseToken: null, leaseExpiresAt: null, createdAt: COMPONENT_T0,
    artifactS3Key: null, artifactFingerprint: null, safeErrorCode: null
  };
  const stage = {
    id: COMPONENT_STAGE_ID, researchId: COMPONENT_RESEARCH_ID, stage: "expansion", generation: 1,
    state: "collecting", expectedCount: 2, terminalCount: 0, succeededCount: 0, skippedCount: 0,
    failedCount: 0, manifestS3Key: null, manifestFingerprint: null, manifestProducedAt: null, createdAt: COMPONENT_T0
  };
  const research = {
    id: COMPONENT_RESEARCH_ID, generation: 1, state: "running", contractVersion: 1,
    configSnapshot: CONFIG, configFingerprint: fp("c"), seeds: ["seed one"], markets: CONFIG.markets
  };
  const repo = {
    trace,
    getTaskContext: async () => { trace.push("ctx"); return { outcome: "found", research, stage, task, latestAttempt: spec.latestAttempt ?? null }; },
    getStageContext: async () => { trace.push("ctx"); return { outcome: "found", research, stage, tasks: [task] }; },
    claim: async ({ taskId, owner, token }) => { trace.push("claim"); task.state = "processing"; task.leaseToken = token; task.leaseExpiresAt = new Date(nowBox.current + 60000); return { outcome: "claimed", task }; },
    heartbeat: async () => ({ outcome: "claimed" }),
    heartbeatAggregator: async () => ({ outcome: "claimed" }),
    recordAttempt: async () => spec.recordOutcome ?? { outcome: "created", attempt: { attemptNumber: 1 }, mayCall: true },
    settleAttempt: async () => spec.settleOutcome ?? { outcome: "terminal", attempt: { attemptNumber: 1 }, fenceActive: true },
    cacheRead: async () => { trace.push("cache"); return spec.cacheReadOutcome ?? { outcome: "not_found" }; },
    claimThrottle: async () => ({ outcome: "claimed" }),
    deferTask: async () => ({ outcome: "delayed", retryAt: new Date(nowBox.current + 2000) }),
    markAttemptAmbiguous: async () => { trace.push("markAmbiguous"); return spec.markAmbiguousOutcome ?? { outcome: "terminal" }; },
    scheduleRetry: async () => {
      trace.push("scheduleRetry");
      const outcome = spec.scheduleRetryOutcome ?? { outcome: "delayed", retryAt: new Date(nowBox.current + 4000) };
      if (outcome.outcome === "delayed") task.nextAttemptAt = outcome.retryAt;
      return outcome;
    },
    terminalize: async () => { trace.push("terminalize"); return { outcome: spec.terminalizeOutcome ?? "terminal" }; }
  };
  const controller = { failOnAssert: spec.failOnAssert };
  const monitors = [];
  const renewTimes = [];
  const monitorFactory = ({ intervalMs, now, renew }) => {
    const state = { failure: null, stopped: false, renewals: 0, assertCount: 0 };
    const monitor = {
      state,
      async renewNow() {
        trace.push("renew");
        renewTimes.push(new Date(now().getTime()).getTime());
        state.renewals += 1;
        if (state.stopped) return;
        try { await renew(now()); } catch (error) { state.failure ??= error; throw error; }
      },
      assertActive() {
        state.assertCount += 1;
        trace.push("assert");
        if (controller.failOnAssert !== undefined && state.assertCount === controller.failOnAssert) {
          const error = new Error("PIPELINE_LEASE_LOST");
          error.code = "PIPELINE_LEASE_LOST";
          state.failure ??= error;
          throw error;
        }
        if (state.failure) throw state.failure;
      },
      async stop() { trace.push("stop"); state.stopped = true; if (state.failure) throw state.failure; },
      async tick() { await monitor.renewNow(); }
    };
    monitors.push(monitor);
    return monitor;
  };
  const holder = { monitors, renewTimes };
  const s3 = {
    async putImmutable() { trace.push("s3.put"); return { key: "runs/put.json", contentFingerprint: fp("put") }; },
    async getValidated() { trace.push("s3.get"); return { value: {} }; }
  };
  const dispatch = {
    async sendOne(_q, message, _schema, _options) {
      trace.push(message.type.endsWith(".task.v1") ? "sendTask" : "sendCheck");
      const logicalId = message.taskNaturalId ?? message.researchId;
      return spec.dispatchFailure
        ? { sentItemIds: [], failedItemIds: [logicalId] }
        : { sentItemIds: [logicalId], failedItemIds: [] };
    }
  };
  const httpDefault = async () => {
    trace.push("http");
    if (spec.tickHttp) await spec.tickHttp({ holder, nowBox });
    return { status: 200, json: async () => { trace.push("json"); return expansionComponentPayload(); } };
  };
  const authFailureHttp = async () => {
    trace.push("http");
    return { status: 401, json: async () => { trace.push("json"); return { status_code: 40100, status_message: "Unauthorized.", cost: 0.0156 }; } };
  };
  const runtime = {
    repository: repo, artifactStore: s3, dispatcher: dispatch,
    config: { awsPipelineBucket: "keyword-bucket", awsPipelineKeywordResearchQueueUrl: QUEUE_URL },
    clock, http: spec.authFailure ? authFailureHttp : httpDefault,
    secrets: { dataForSeoLogin: "login", dataForSeoPassword: "password" }
  };
  const message = {
    contractVersion: 1, type: "keyword.expansion.task.v1", researchId: COMPONENT_RESEARCH_ID,
    generation: 1, stage: "expansion", taskNaturalId: task.id, inputFingerprint: inputFp
  };
  return { trace, repo, runtime, message, monitorFactory, holder, task };
}

async function runTaskComponentCase(caseId) {
  switch (caseId) {
    case "R3-T01-success-terminal-check": {
      const h = componentHarness({ terminalizeOutcome: "terminal" });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.terminal, true);
      assert.equal(result.outcome, "succeeded");
      assertDecisiveTail(h.trace, ["s3.put", "renew", "stop", "assert", "terminalize", "sendCheck"]);
      assert.equal(countOp(h.trace, "sendCheck"), 1);
      assert.equal(countOp(h.trace, "http"), 1);
      break;
    }
    case "R3-T02-success-found-check": {
      const h = componentHarness({ terminalizeOutcome: "found" });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "found");
      assertDecisiveTail(h.trace, ["s3.put", "renew", "stop", "assert", "terminalize", "sendCheck"]);
      assert.equal(countOp(h.trace, "sendCheck"), 1);
      break;
    }
    case "R3-T03-success-lost-no-check": {
      const h = componentHarness({ terminalizeOutcome: "lost" });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "lost");
      assertDecisiveTail(h.trace, ["s3.put", "renew", "stop", "assert", "terminalize"]);
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T04-success-conflict-no-check": {
      const h = componentHarness({ terminalizeOutcome: "conflict" });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "conflict");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T05-success-not-found-no-check": {
      const h = componentHarness({ terminalizeOutcome: "not_found" });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "not_found");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T06-failure-terminal-check": {
      const h = componentHarness({ terminalizeOutcome: "terminal", authFailure: true });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "terminal");
      assertDecisiveTail(h.trace, ["renew", "stop", "assert", "terminalize", "sendCheck"]);
      assert.equal(countOp(h.trace, "sendCheck"), 1);
      break;
    }
    case "R3-T07-failure-found-check": {
      const h = componentHarness({ terminalizeOutcome: "found", authFailure: true });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "found");
      assertDecisiveTail(h.trace, ["renew", "stop", "assert", "terminalize", "sendCheck"]);
      break;
    }
    case "R3-T08-failure-lost-no-check": {
      const h = componentHarness({ terminalizeOutcome: "lost", authFailure: true });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "lost");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T09-failure-conflict-no-check": {
      const h = componentHarness({ terminalizeOutcome: "conflict", authFailure: true });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "conflict");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T10-failure-not-found-no-check": {
      const h = componentHarness({ terminalizeOutcome: "not_found", authFailure: true });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "not_found");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T11-loss-before-http-zero-call": {
      const h = componentHarness({ failOnAssert: 4 });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error.code === "PIPELINE_LEASE_LOST"
      );
      assert.equal(countOp(h.trace, "http"), 0, "loss before http makes zero HTTP calls");
      assert.equal(countOp(h.trace, "markAmbiguous"), 1);
      assertNoOp(h.trace, "s3.put");
      assertNoOp(h.trace, "terminalize");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T12-loss-during-fetch-ambiguity": {
      const h = componentHarness({ failOnAssert: 5 });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error.code === "PIPELINE_LEASE_LOST"
      );
      assert.equal(countOp(h.trace, "http"), 1);
      assert.equal(countOp(h.trace, "json"), 0);
      assert.equal(countOp(h.trace, "markAmbiguous"), 1);
      assertNoOp(h.trace, "s3.put");
      assertNoOp(h.trace, "terminalize");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T13-loss-during-json-ambiguity": {
      const h = componentHarness({ failOnAssert: 7 });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error.code === "PIPELINE_LEASE_LOST"
      );
      assert.equal(countOp(h.trace, "http"), 1);
      assert.equal(countOp(h.trace, "json"), 1);
      assert.equal(countOp(h.trace, "markAmbiguous"), 1);
      assertNoOp(h.trace, "s3.put");
      assertNoOp(h.trace, "terminalize");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T14-loss-before-s3": {
      const h = componentHarness({ failOnAssert: 9 });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error.code === "PIPELINE_LEASE_LOST"
      );
      assert.ok(countOp(h.trace, "s3.put") <= 1, "at most one orphan s3.put allowed");
      assertNoOp(h.trace, "terminalize");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T15-loss-during-s3": {
      const h = componentHarness({ failOnAssert: 10 });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error.code === "PIPELINE_LEASE_LOST"
      );
      assert.ok(countOp(h.trace, "s3.put") <= 1, "at most one orphan s3.put allowed");
      assertNoOp(h.trace, "terminalize");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T16-loss-after-s3-before-terminal": {
      const h = componentHarness({ failOnAssert: 11 });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error.code === "PIPELINE_LEASE_LOST"
      );
      assert.ok(countOp(h.trace, "s3.put") <= 1, "at most one orphan s3.put allowed");
      assertNoOp(h.trace, "terminalize");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-T17-six-renewals-over-120s": {
      const nowBox = { current: COMPONENT_T0.getTime() };
      let holderRef;
      const h = componentHarness({
        nowBox,
        tickHttp: async ({ holder }) => {
          holderRef = holder;
          for (const seconds of [20, 40, 60, 80, 100, 120]) {
            nowBox.current = COMPONENT_T0.getTime() + seconds * 1000;
            await holder.monitors[0].tick();
          }
        }
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "succeeded");
      const renews = holderRef.renewTimes;
      assert.ok(renews.length >= 6, `at least six renewals, got ${renews.length}`);
      const scheduled = [20, 40, 60, 80, 100, 120].map((seconds) => COMPONENT_T0.getTime() + seconds * 1000);
      for (let index = 0; index < 6; index += 1) {
        assert.equal(renews[index], scheduled[index], `renewal ${index + 1} at the exact 20s cadence`);
        if (index + 1 < 6) {
          assert.ok(renews[index] < renews[index + 1], "timer renewals are strictly nonoverlapping in time");
        }
      }
      break;
    }
    case "R3-T18-terminal-gate-negative-control": {
      const production = componentHarness({ terminalizeOutcome: "lost" });
      const productionResult = await processKeywordMessage(production.message, production.runtime, { createLeaseMonitor: production.monitorFactory });
      assert.equal(productionResult.outcome, "lost");
      assertNoOp(production.trace, "sendCheck", "production never sends a check after a lost terminal gate");
      const mutated = componentHarness({ terminalizeOutcome: "terminal" });
      const mutatedResult = await processKeywordMessage(mutated.message, mutated.runtime, { createLeaseMonitor: mutated.monitorFactory });
      assert.equal(mutatedResult.outcome, "succeeded");
      assert.equal(countOp(mutated.trace, "sendCheck"), 1);
      assert.notEqual(countOp(production.trace, "sendCheck"), countOp(mutated.trace, "sendCheck"),
        "treating a lost terminal gate as terminal must falsify the zero-check oracle");
      break;
    }
    default:
      assert.fail(`unhandled task_component case ${caseId}`);
  }
}

const COMPONENT_NORMALIZED = { keywords: ["recovered one"] };
const COMPONENT_MATCH_FP = fingerprintJson(COMPONENT_NORMALIZED);
const COMPONENT_REQ_FP = keywordRequestFingerprint("keyword_suggestions",
  { keyword: "seed one", location_code: 2840, language_code: "en", limit: 30 });

function succeededAttempt(overrides = {}) {
  return {
    attemptNumber: 1, state: "succeeded", requestFingerprint: COMPONENT_REQ_FP,
    resultFingerprint: COMPONENT_MATCH_FP, providerCostUsd: "0.01560000",
    safeErrorCode: null, ...overrides
  };
}

async function runRecoveryComponentCase(caseId) {
  switch (caseId) {
    case "R3-R01-success-terminal-check": {
      const h = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "found", cache: { normalizedResponse: COMPONENT_NORMALIZED, resultFingerprint: COMPONENT_MATCH_FP } },
        terminalizeOutcome: "terminal"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assertDecisiveTail(h.trace, ["cache", "s3.put", "renew", "stop", "assert", "terminalize", "sendCheck"]);
      assert.equal(countOp(h.trace, "http"), 0);
      break;
    }
    case "R3-R02-success-found-check": {
      const h = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "found", cache: { normalizedResponse: COMPONENT_NORMALIZED, resultFingerprint: COMPONENT_MATCH_FP } },
        terminalizeOutcome: "found"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assertDecisiveTail(h.trace, ["cache", "s3.put", "renew", "stop", "assert", "terminalize", "sendCheck"]);
      assert.equal(countOp(h.trace, "http"), 0);
      break;
    }
    case "R3-R03-success-lost-no-check": {
      const h = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "found", cache: { normalizedResponse: COMPONENT_NORMALIZED, resultFingerprint: COMPONENT_MATCH_FP } },
        terminalizeOutcome: "lost"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assertNoOp(h.trace, "sendCheck");
      assert.equal(countOp(h.trace, "http"), 0);
      break;
    }
    case "R3-R04-success-conflict-no-check": {
      const h = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "found", cache: { normalizedResponse: COMPONENT_NORMALIZED, resultFingerprint: COMPONENT_MATCH_FP } },
        terminalizeOutcome: "conflict"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-R05-success-not-found-no-check": {
      const h = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "found", cache: { normalizedResponse: COMPONENT_NORMALIZED, resultFingerprint: COMPONENT_MATCH_FP } },
        terminalizeOutcome: "not_found"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assertNoOp(h.trace, "sendCheck");
      break;
    }
    case "R3-R06-cache-missing-terminal-ambiguity": {
      const h = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "not_found" },
        terminalizeOutcome: "terminal"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assert.equal(countOp(h.trace, "http"), 0);
      assertNoOp(h.trace, "scheduleRetry");
      assertNoOp(h.trace, "s3.put");
      assertDecisiveTail(h.trace, ["cache", "renew", "stop", "assert", "terminalize", "sendCheck"]);
      break;
    }
    case "R3-R07-cache-expired-terminal-ambiguity": {
      const h = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "not_found" },
        terminalizeOutcome: "terminal"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assert.equal(countOp(h.trace, "http"), 0);
      assertNoOp(h.trace, "scheduleRetry");
      assertDecisiveTail(h.trace, ["cache", "renew", "stop", "assert", "terminalize", "sendCheck"]);
      break;
    }
    case "R3-R08-cache-fingerprint-mismatch-ambiguity": {
      const h = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "found", cache: { normalizedResponse: COMPONENT_NORMALIZED, resultFingerprint: fp("other") } },
        terminalizeOutcome: "terminal"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assert.equal(countOp(h.trace, "http"), 0);
      assertNoOp(h.trace, "scheduleRetry");
      assertDecisiveTail(h.trace, ["cache", "renew", "stop", "assert", "terminalize", "sendCheck"]);
      break;
    }
    case "R3-R09-planned-attempt-ambiguity-check": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "planned", requestFingerprint: COMPONENT_REQ_FP, resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: null },
        markAmbiguousOutcome: { outcome: "terminal" }
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assertDecisiveTail(h.trace, ["markAmbiguous", "stop", "sendCheck"]);
      assert.equal(countOp(h.trace, "sendCheck"), 1);
      assert.equal(countOp(h.trace, "http"), 0);
      break;
    }
    case "R3-R10-auth-failure-no-retry": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "failed", requestFingerprint: COMPONENT_REQ_FP, resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: KEYWORD_PROVIDER_AUTH_FAILED },
        terminalizeOutcome: "terminal"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assert.equal(countOp(h.trace, "http"), 0);
      assertNoOp(h.trace, "scheduleRetry");
      assertDecisiveTail(h.trace, ["renew", "stop", "assert", "terminalize", "sendCheck"]);
      break;
    }
    case "R3-R11-contract-failure-no-retry": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "failed", requestFingerprint: COMPONENT_REQ_FP, resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: KEYWORD_PROVIDER_CONTRACT_MISMATCH },
        terminalizeOutcome: "terminal"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assert.equal(countOp(h.trace, "http"), 0);
      assertNoOp(h.trace, "scheduleRetry");
      assertDecisiveTail(h.trace, ["renew", "stop", "assert", "terminalize", "sendCheck"]);
      break;
    }
    case "R3-R12-task-failure-no-retry": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "failed", requestFingerprint: COMPONENT_REQ_FP, resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: KEYWORD_PROVIDER_TASK_FAILED },
        terminalizeOutcome: "terminal"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assert.equal(countOp(h.trace, "http"), 0);
      assertNoOp(h.trace, "scheduleRetry");
      assertDecisiveTail(h.trace, ["renew", "stop", "assert", "terminalize", "sendCheck"]);
      break;
    }
    case "R3-R13-retryable-delayed-send": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 2, state: "failed", requestFingerprint: COMPONENT_REQ_FP, resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: KEYWORD_PROVIDER_RETRYABLE },
        scheduleRetryOutcome: { outcome: "delayed", retryAt: new Date(COMPONENT_T0.getTime() + 4000) }
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assertDecisiveTail(h.trace, ["scheduleRetry", "stop", "sendTask"]);
      assert.equal(countOp(h.trace, "sendTask"), 1);
      assert.equal(countOp(h.trace, "http"), 0);
      break;
    }
    case "R3-R14-attempt-five-exhausted-terminal": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 5, state: "failed", requestFingerprint: COMPONENT_REQ_FP, resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: KEYWORD_PROVIDER_RETRYABLE },
        terminalizeOutcome: "terminal"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assert.equal(countOp(h.trace, "http"), 0);
      assertNoOp(h.trace, "scheduleRetry");
      assertDecisiveTail(h.trace, ["renew", "stop", "assert", "terminalize", "sendCheck"]);
      break;
    }
    case "R3-R15-delayed-send-failure-durable": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "failed", requestFingerprint: COMPONENT_REQ_FP, resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: KEYWORD_PROVIDER_RETRYABLE },
        scheduleRetryOutcome: { outcome: "delayed", retryAt: new Date(COMPONENT_T0.getTime() + 4000) },
        dispatchFailure: true
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assert.equal(countOp(h.trace, "sendTask"), 1, "failed delayed send is recorded");
      assert.ok(h.task.nextAttemptAt instanceof Date, "durable delayed state remains after send failure");
      assert.equal(countOp(h.trace, "http"), 0);
      break;
    }
    case "R3-R16-monitor-stopped-before-dispatch": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "failed", requestFingerprint: COMPONENT_REQ_FP, resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: KEYWORD_PROVIDER_RETRYABLE },
        scheduleRetryOutcome: { outcome: "delayed", retryAt: new Date(COMPONENT_T0.getTime() + 4000) }
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      const stopIndex = h.trace.indexOf("stop");
      const sendIndex = h.trace.indexOf("sendTask");
      assert.ok(stopIndex !== -1 && sendIndex !== -1 && stopIndex < sendIndex,
        `monitor stop must precede delayed dispatch in ${JSON.stringify(h.trace)}`);
      break;
    }
    case "R3-R17-unknown-failed-code-conflict": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "failed", requestFingerprint: null, resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: "KEYWORD_PROVIDER_UNKNOWN" }
      });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error.code === "PIPELINE_INPUT_CONFLICT"
      );
      break;
    }
    case "R3-R18-recovery-fence-negative-control": {
      const production = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "not_found" },
        terminalizeOutcome: "lost"
      });
      const productionResult = await processKeywordMessage(production.message, production.runtime, { createLeaseMonitor: production.monitorFactory });
      assert.equal(productionResult.outcome, "recovered");
      assertNoOp(production.trace, "sendCheck", "production never sends a check when the recovery fence is lost");
      assertNoOp(production.trace, "s3.put");
      const mutated = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "not_found" },
        terminalizeOutcome: "terminal"
      });
      const mutatedResult = await processKeywordMessage(mutated.message, mutated.runtime, { createLeaseMonitor: mutated.monitorFactory });
      assert.equal(mutatedResult.outcome, "recovered");
      assert.equal(countOp(mutated.trace, "sendCheck"), 1);
      assert.notEqual(countOp(production.trace, "sendCheck"), countOp(mutated.trace, "sendCheck"),
        "unfenced recovery must falsify the no-terminal/check oracle");
      break;
    }
    default:
      assert.fail(`unhandled recovery_component case ${caseId}`);
  }
}

test("SCN-KI-029: task_component and recovery_component enforcement manifests execute every case with exact traces", async (t) => {
  const executedTask = [];
  const executedRecovery = [];
  for (const caseId of TASK_COMPONENT_IDS) {
    await t.test(caseId, async () => {
      executedTask.push(caseId);
      await runTaskComponentCase(caseId);
    });
  }
  for (const caseId of RECOVERY_COMPONENT_IDS) {
    await t.test(caseId, async () => {
      executedRecovery.push(caseId);
      await runRecoveryComponentCase(caseId);
    });
  }
  const sortedTask = [...executedTask].sort();
  const sortedRecovery = [...executedRecovery].sort();
  const sortedTaskExpected = [...TASK_COMPONENT_IDS].sort();
  const sortedRecoveryExpected = [...RECOVERY_COMPONENT_IDS].sort();
  assert.deepEqual(sortedTask, sortedTaskExpected, "every task_component manifest ID executed exactly once");
  assert.equal(executedTask.length, TASK_COMPONENT_IDS.length);
  assert.deepEqual(sortedRecovery, sortedRecoveryExpected, "every recovery_component manifest ID executed exactly once");
  assert.equal(executedRecovery.length, RECOVERY_COMPONENT_IDS.length);
  const taskHash = createHash("sha256").update(sortedTask.join("\n")).digest("hex");
  assert.equal(taskHash, "d6773f3749e9f68c3b270df9ad63aba6297328b5578d1e5f3346ee2683518110");
  const recoveryHash = createHash("sha256").update(sortedRecovery.join("\n")).digest("hex");
  assert.equal(recoveryHash, "b6d8b7a1435b6a62da061980afd370290f16b899774bba32578e3df9cc5f2737");
});

async function runR4WorkerCase(caseId) {
  switch (caseId) {
    case "R4-W01-planned-identity-mismatch-conflict": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "planned", requestFingerprint: fp("r4-w01-other"), resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: null },
        markAmbiguousOutcome: { outcome: "terminal" }
      });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error?.code === "PIPELINE_INPUT_CONFLICT"
      );
      assert.equal(countOp(h.trace, "markAmbiguous"), 0);
      assert.equal(countOp(h.trace, "sendCheck"), 0);
      assert.equal(countOp(h.trace, "http"), 0);
      break;
    }
    case "R4-W02-terminal-failure-identity-mismatch-conflict": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "failed", requestFingerprint: fp("r4-w02-other"), resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: KEYWORD_PROVIDER_AUTH_FAILED },
        terminalizeOutcome: "terminal"
      });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error?.code === "PIPELINE_INPUT_CONFLICT"
      );
      assert.equal(countOp(h.trace, "terminalize"), 0);
      assert.equal(countOp(h.trace, "sendCheck"), 0);
      break;
    }
    case "R4-W03-retryable-failure-identity-mismatch-conflict": {
      const h = componentHarness({
        latestAttempt: { attemptNumber: 1, state: "failed", requestFingerprint: fp("r4-w03-other"), resultFingerprint: null, providerCostUsd: "0.01560000", safeErrorCode: KEYWORD_PROVIDER_RETRYABLE },
        scheduleRetryOutcome: { outcome: "delayed", retryAt: new Date(COMPONENT_T0.getTime() + 4000) }
      });
      await assert.rejects(
        processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory }),
        (error) => error?.code === "PIPELINE_INPUT_CONFLICT"
      );
      assert.equal(countOp(h.trace, "scheduleRetry"), 0);
      assert.equal(countOp(h.trace, "sendTask"), 0);
      break;
    }
    case "R4-W04-ordinary-lost-check-injection-falsifies": {
      const h = componentHarness({ terminalizeOutcome: "lost" });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "lost");
      assertDecisiveTail(h.trace, ["s3.put", "renew", "stop", "assert", "terminalize"]);
      assertNoOp(h.trace, "sendCheck");
      const mutatedTrace = [...h.trace, "sendCheck"];
      assert.throws(() => assertNoOp(mutatedTrace, "sendCheck"), (e) => e instanceof assert.AssertionError);
      const fresh = componentHarness({ terminalizeOutcome: "lost" });
      const freshResult = await processKeywordMessage(fresh.message, fresh.runtime, { createLeaseMonitor: fresh.monitorFactory });
      assert.equal(freshResult.outcome, "lost");
      assertNoOp(fresh.trace, "sendCheck");
      break;
    }
    case "R4-W05-recovery-lost-write-injection-falsifies": {
      const h = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "found", cache: { normalizedResponse: COMPONENT_NORMALIZED, resultFingerprint: COMPONENT_MATCH_FP } },
        terminalizeOutcome: "lost"
      });
      const result = await processKeywordMessage(h.message, h.runtime, { createLeaseMonitor: h.monitorFactory });
      assert.equal(result.outcome, "recovered");
      assertNoOp(h.trace, "sendCheck");
      assert.equal(countOp(h.trace, "http"), 0);
      assert.equal(countOp(h.trace, "terminalize"), 1, "recovery-lost trace records exactly one terminalize");
      const mutatedTrace = [...h.trace, "terminalize", "sendCheck"];
      assert.throws(() => assert.equal(countOp(mutatedTrace, "terminalize"), 1), (e) => e instanceof assert.AssertionError);
      assert.throws(() => assertNoOp(mutatedTrace, "sendCheck"), (e) => e instanceof assert.AssertionError);
      const fresh = componentHarness({
        latestAttempt: succeededAttempt(),
        cacheReadOutcome: { outcome: "found", cache: { normalizedResponse: COMPONENT_NORMALIZED, resultFingerprint: COMPONENT_MATCH_FP } },
        terminalizeOutcome: "lost"
      });
      const freshResult = await processKeywordMessage(fresh.message, fresh.runtime, { createLeaseMonitor: fresh.monitorFactory });
      assert.equal(freshResult.outcome, "recovered");
      assertNoOp(fresh.trace, "sendCheck");
      assert.equal(countOp(fresh.trace, "terminalize"), 1, "fresh recovery-lost trace also records exactly one terminalize");
      break;
    }
    default:
      assert.fail(`unhandled R4 worker case ${caseId}`);
  }
}

test("SCN-KI-033: durable attempt/task request identity fence rejects every unequal mismatch", async (t) => {
  const executed = [];
  for (const caseId of R4_WORKER_CONFLICT_IDS) {
    await t.test(caseId, async () => {
      await runR4WorkerCase(caseId);
      executed.push(caseId);
    });
  }
  const sortedExecuted = [...executed].sort();
  const sortedExpected = [...R4_WORKER_CONFLICT_IDS].sort();
  assert.deepEqual(sortedExecuted, sortedExpected, "every R4 identity-fence manifest ID executed exactly once");
  assert.equal(executed.length, R4_WORKER_CONFLICT_IDS.length);
});

test("SCN-KI-034: worker oracle falsification controls mutate only captured evidence", async (t) => {
  const executed = [];
  for (const caseId of R4_WORKER_FALSIFY_IDS) {
    await t.test(caseId, async () => {
      await runR4WorkerCase(caseId);
      executed.push(caseId);
    });
  }
  const sortedExecuted = [...executed].sort();
  const sortedExpected = [...R4_WORKER_FALSIFY_IDS].sort();
  assert.deepEqual(sortedExecuted, sortedExpected, "every R4 falsification manifest ID executed exactly once");
  assert.equal(executed.length, R4_WORKER_FALSIFY_IDS.length);
});

function r3AuthFailureHttp(calls) {
  return {
    calls,
    async http(url) {
      calls.push(url);
      return { status: 401, json: async () => ({ status_code: 40100, status_message: "Unauthorized.", cost: 0.0156 }) };
    }
  };
}

function r3RetryableHttp(calls) {
  return {
    calls,
    async http(url) {
      calls.push(url);
      return { status: 429, json: async () => ({ status_code: 20000, status_message: "Ok.", cost: 0.0156, tasks: [] }) };
    }
  };
}

function r3FailOnAssertMonitorFactory(failOnAssert) {
  return function factory({ intervalMs, now, renew }) {
    const state = { failure: null, stopped: false, assertCount: 0 };
    return {
      async renewNow() {
        if (state.stopped) return;
        try { await renew(now()); } catch (error) { state.failure ??= error; throw error; }
      },
      assertActive() {
        state.assertCount += 1;
        if (failOnAssert !== undefined && state.assertCount === failOnAssert) {
          const error = new Error("PIPELINE_LEASE_LOST");
          error.code = "PIPELINE_LEASE_LOST";
          state.failure ??= error;
          throw error;
        }
        if (state.failure) throw state.failure;
      },
      async stop() { state.stopped = true; if (state.failure) throw state.failure; }
    };
  };
}

test("SCN-KI-030: task_database enforcement manifest executes every durable case exactly once", { skip: !enabled }, async (t) => {
  const executed = [];
  await withIsolatedDb("kir4_scn030", async ({ db, repo }) => {
    for (const caseId of DATABASE_IDS) {
      await t.test(caseId, async () => {
        await t_scn030(caseId, executed, { db, repo });
      });
    }
  });
  const sortedExecuted = [...executed].sort();
  const sortedExpected = [...DATABASE_IDS].sort();
  assert.deepEqual(sortedExecuted, sortedExpected, "every task_database manifest ID executed exactly once");
  assert.equal(executed.length, DATABASE_IDS.length);
  const hash = createHash("sha256").update(sortedExecuted.join("\n")).digest("hex");
  assert.equal(hash, "9e8a3973d5430be70e26f68bb235b831b96f17162d30277a40b06942cc94e934");
});

async function t_scn030(caseId, executed, { db, repo }) {
  executed.push(caseId);
  switch (caseId) {
      case "R3-D01-after-settle-before-s3-recover": {
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
        assert.equal(task.state, "processing");
        const attempt = await db.keywordResearchProviderAttempt.findFirst({ where: { taskId: task.id } });
        assert.equal(attempt.state, "succeeded");
        assert.equal(attempt.providerCostUsd.toFixed(8), "0.01560000");
        const cache = await db.keywordResearchCache.findUnique({ where: { requestFingerprint: task.requestFingerprint } });
        assert.ok(cache, "normalized cache written in the settlement transaction");
        assert.equal(s3.objects.size, 0, "no artifact before the crash");

        nowBox.current = NOW.getTime() + 60000;
        const runtimeB = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
        const monitorsB = fakeMonitors();
        const beforeCalls = http.calls.length;
        const resultB = await processKeywordMessage(message, runtimeB, { createLeaseMonitor: monitorsB.factory });
        assert.equal(resultB.outcome, "recovered");
        assert.equal(http.calls.length, beforeCalls, "zero recovery HTTP calls");
        assert.equal(s3.objects.size, 1, "one immutable artifact");
        const terminal = await db.keywordResearchTask.findUnique({ where: { id: task.id } });
        assert.equal(terminal.state, "succeeded");
        assert.equal(terminal.attemptCount, 1, "one retained attempt");
        const artifact = JSON.parse(s3.objects.get(terminal.artifactS3Key).Body.toString("utf8"));
        assert.equal(artifact.costUsd, "0.01560000");
        const checks = dispatch.sent.filter((entry) => entry.type === "keyword.aggregate.check.v1");
        assert.equal(checks.length, 2, "initialize check plus exactly one recovery check");
        await cleanDurableRows(db, repo);
        break;
      }
      case "R3-D02-after-s3-before-terminal-recover": {
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
        assert.equal(s3.objects.size, 1, "one immutable orphan before terminalization");

        nowBox.current = NOW.getTime() + 60000;
        const runtimeB = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
        const monitorsB = fakeMonitors();
        const beforeCalls = http.calls.length;
        const resultB = await processKeywordMessage(message, runtimeB, { createLeaseMonitor: monitorsB.factory });
        assert.equal(resultB.outcome, "recovered");
        assert.equal(http.calls.length, beforeCalls, "zero recovery HTTP calls");
        assert.equal(s3.objects.size, 1, "no second artifact object");
        const terminal = await db.keywordResearchTask.findUnique({ where: { id: task.id } });
        assert.equal(terminal.state, "succeeded");
        assert.equal(terminal.artifactS3Key, orphanKey, "B reconciles the exact orphan key");
        const artifact = JSON.parse(s3.objects.get(orphanKey).Body.toString("utf8"));
        assert.equal(artifact.costUsd, "0.01560000");
        const checks = dispatch.sent.filter((entry) => entry.type === "keyword.aggregate.check.v1");
        assert.equal(checks.length, 2);
        await cleanDurableRows(db, repo);
        break;
      }
      case "R3-D03-terminal-failure-crash-no-retry": {
        const nowBox = { current: NOW.getTime() };
        const s3 = memoryS3();
        const dispatch = memoryDispatcher();
        const http = r3AuthFailureHttp([]);
        const runtimeA = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
        const monitors = fakeMonitors();
        const { expansionTask } = await createAndInitialize(db, repo, runtimeA, ["seed one"]);
        const message = { ...expansionTask };
        await assert.rejects(
          processKeywordMessage(message, runtimeA, { createLeaseMonitor: r3FailOnAssertMonitorFactory(8) }),
          (error) => error?.code === "PIPELINE_LEASE_LOST"
        );
        const task = await db.keywordResearchTask.findUnique({ where: { id: message.taskNaturalId } });
        assert.equal(task.state, "processing", "crash before terminalize leaves the task processing");
        const attempt = await db.keywordResearchProviderAttempt.findFirst({ where: { taskId: task.id } });
        assert.equal(attempt.state, "failed");
        assert.equal(attempt.safeErrorCode, "KEYWORD_PROVIDER_AUTH_FAILED", "terminal failure settled durably");
        assert.equal((await db.keywordResearchProviderAttempt.count({ where: { taskId: task.id } })), 1);

        nowBox.current = NOW.getTime() + 60000;
        const runtimeB = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
        const monitorsB = fakeMonitors();
        const beforeCalls = http.calls.length;
        const resultB = await processKeywordMessage(message, runtimeB, { createLeaseMonitor: monitorsB.factory });
        assert.equal(resultB.outcome, "recovered");
        assert.equal(http.calls.length, beforeCalls, "B performs zero HTTP calls for a terminal failure");
        const terminal = await db.keywordResearchTask.findUnique({ where: { id: task.id } });
        assert.equal(terminal.state, "skipped", "expansion terminal failure maps to skipped");
        assert.equal(terminal.safeErrorCode, "KEYWORD_PROVIDER_AUTH_FAILED", "exact safe code preserved");
        assert.equal((await db.keywordResearchProviderAttempt.count({ where: { taskId: task.id } })), 1,
          "terminal failure never creates a second attempt");
        const checks = dispatch.sent.filter((entry) => entry.type === "keyword.aggregate.check.v1");
        assert.equal(checks.length, 2, "initialize check plus one terminal failure check");
        await cleanDurableRows(db, repo);
        break;
      }
      case "R3-D04-retryable-crash-schedules-once": {
        const nowBox = { current: NOW.getTime() };
        const s3 = memoryS3();
        const dispatch = memoryDispatcher();
        const http = r3RetryableHttp([]);
        const crashProxy = new Proxy(repo, {
          get(target, prop) {
            const value = target[prop];
            if (prop === "scheduleRetry") {
              return async () => { throw new Error("simulated crash before retry scheduling"); };
            }
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
        const runtimeA = clockedRuntime(crashProxy, s3, dispatch, http.http, nowBox);
        const monitors = fakeMonitors();
        const { expansionTask } = await createAndInitialize(db, repo, runtimeA, ["seed one"]);
        const message = { ...expansionTask };
        await assert.rejects(
          processKeywordMessage(message, runtimeA, { createLeaseMonitor: monitors.factory }),
          (error) => error?.code === "PIPELINE_INPUT_CONFLICT" || /simulated crash/u.test(error?.message ?? "")
        );
        const task = await db.keywordResearchTask.findUnique({ where: { id: message.taskNaturalId } });
        assert.equal(task.state, "processing");
        const attempt = await db.keywordResearchProviderAttempt.findFirst({ where: { taskId: task.id } });
        assert.equal(attempt.state, "failed");
        assert.equal(attempt.safeErrorCode, "KEYWORD_PROVIDER_RETRYABLE");
        assert.equal(attempt.attemptNumber, 1);
        assert.equal(task.nextAttemptAt, null, "no durable retry before the crash");

        nowBox.current = NOW.getTime() + 60000;
        const runtimeB = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
        const monitorsB = fakeMonitors();
        const beforeCalls = http.calls.length;
        const sentBefore = dispatch.sent.length;
        const resultB = await processKeywordMessage(message, runtimeB, { createLeaseMonitor: monitorsB.factory });
        assert.equal(resultB.outcome, "recovered", "B schedules the durable retry and dispatches it once");
        assert.equal(http.calls.length, beforeCalls, "B performs zero HTTP for a crash-before-schedule retry");
        const after = await db.keywordResearchTask.findUnique({ where: { id: task.id } });
        assert.ok(after.nextAttemptAt, "one durable retry schedule");
        assert.equal((await db.keywordResearchProviderAttempt.count({ where: { taskId: task.id } })), 1,
          "never two simultaneous attempts");
        const redelivered = dispatch.sent.slice(sentBefore).filter((entry) =>
          entry.type === "keyword.expansion.task.v1" && entry.taskNaturalId === task.id);
        assert.equal(redelivered.length, 1, "one due retry dispatch");
        await cleanDurableRows(db, repo);
        break;
      }
      case "R3-D05-renewed-expiry-stale-owner-denied": {
        const nowBox = { current: NOW.getTime() };
        const s3 = memoryS3();
        const dispatch = memoryDispatcher();
        const http = countingHttp();
        const runtimeA = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
        const monitors = fakeMonitors();
        const { expansionTask } = await createAndInitialize(db, repo, runtimeA, ["seed one"]);
        const message = { ...expansionTask };
        const taskId = message.taskNaturalId;
        const aToken = "a".repeat(32);
        const claimedA = await repo.claim({ taskId, owner: "owner-A", token: aToken }, new Date(nowBox.current));
        assert.equal(claimedA.outcome, "claimed");
        for (const seconds of [20, 40, 60, 80, 100, 120]) {
          nowBox.current = NOW.getTime() + seconds * 1000;
          assert.equal((await repo.heartbeat({ taskId, token: aToken }, new Date(nowBox.current))).outcome, "claimed",
            `A renews at T0+${seconds}s`);
        }
        nowBox.current = NOW.getTime() + 180000;
        const runtimeB = clockedRuntime(repo, s3, dispatch, http.http, nowBox);
        const monitorsB = fakeMonitors();
        const resultB = await processKeywordMessage(message, runtimeB, { createLeaseMonitor: monitorsB.factory });
        assert.equal(resultB.outcome, "succeeded", "B reclaims at exact renewed expiry and completes");
        const terminal = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
        assert.equal(terminal.state, "succeeded");
        const before = JSON.stringify(terminal);
        const stageBefore = JSON.stringify(await db.keywordResearchStage.findUnique({ where: { id: terminal.stageId } }));

        const staleHeartbeat = await repo.heartbeat({ taskId, token: aToken }, new Date(nowBox.current));
        assert.equal(staleHeartbeat.outcome, "lost");
        const staleTerminal = await repo.terminalize({
          taskId, token: aToken, state: "succeeded", artifactS3Key: "runs/x.json", artifactFingerprint: fp("x")
        }, new Date(nowBox.current));
        assert.equal(staleTerminal.outcome, "conflict", "stale A cannot overwrite the immutable terminal row");
        const after = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
        assert.equal(JSON.stringify(after), before, "task row deep-equal before/after stale A");
        const stageAfter = await db.keywordResearchStage.findUnique({ where: { id: terminal.stageId } });
        assert.equal(JSON.stringify(stageAfter), stageBefore, "stage row deep-equal before/after stale A");
        assert.equal(s3.objects.size, 1, "no stale S3 write");
        const checks = dispatch.sent.filter((entry) => entry.type === "keyword.aggregate.check.v1");
        assert.equal(checks.length, 2, "initialize plus exactly one terminal check");
        await cleanDurableRows(db, repo);
        break;
      }
      default:
        assert.fail(`unhandled task_database case ${caseId}`);
    }
}
