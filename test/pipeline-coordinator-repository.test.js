import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { PipelineCoordinatorRepository, assertCompleteAggregatorInTransaction,
  completeAggregatorInTransaction, registerStageInTransaction
} from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";

const migrationUrl = new URL("../prisma/migrations/20260811120000_aws_pipeline_coordinator/migration.sql", import.meta.url);
const remainderMigrationUrl = new URL("../prisma/migrations/20260812120000_aws_pipeline_remainder_foundations/migration.sql", import.meta.url);
const schemaUrl = new URL("../prisma/schema.prisma", import.meta.url);

test("G5 migration is additive and contains the exact coordinator constraints", async () => {
  const sql = await fs.readFile(migrationUrl, "utf8");
  for (const enumName of ["RunExecutionBackend", "PipelineStageName", "PipelineStageState", "PipelineTaskState"])
    assert.match(sql, new RegExp(`CREATE TYPE "${enumName}" AS ENUM`, "u"));
  assert.match(sql, /ADD COLUMN "executionBackend" "RunExecutionBackend" NOT NULL DEFAULT 'local'/u);
  assert.match(sql, /ADD COLUMN "pipelineGeneration" INTEGER NOT NULL DEFAULT 1/u);
  assert.match(sql, /ALTER TABLE "DataForSeoRequestLedger"[\s\S]*ADD COLUMN "resultFingerprint" TEXT/u);
  assert.match(sql, /CREATE TABLE "PipelineStage"/u);
  assert.match(sql, /CREATE TABLE "PipelineTask"/u);
  assert.match(sql, /"terminalCount" = "succeededCount" \+ "skippedCount" \+ "failedCount" \+ "cancelledCount"/u);
  assert.match(sql, /"terminalCount" <= "expectedCount"/u);
  assert.doesNotMatch(sql, /^\s*(?:DELETE|TRUNCATE|DROP TABLE|DROP TYPE)\b/imu);
});

test("G-R3 schema and migration add only the reconstructable coordinator foundations", async () => {
  const [schema, sql] = await Promise.all([
    fs.readFile(schemaUrl, "utf8"), fs.readFile(remainderMigrationUrl, "utf8")
  ]);
  assert.match(schema, /awsProviderConfig\s+Json\?/u);
  assert.match(schema, /manifestProducedAt\s+DateTime/u);
  assert.match(schema, /processingPipelineTaskId\s+String\?/u);
  assert.match(schema, /@@index\(\[processingPipelineTaskId\]\)/u);
  assert.match(sql, /ADD COLUMN "awsProviderConfig" JSONB/u);
  assert.match(sql, /ADD COLUMN "manifestProducedAt" TIMESTAMP\(3\)/u);
  assert.ok(sql.indexOf('ADD COLUMN "manifestProducedAt"') < sql.indexOf('SET "manifestProducedAt" = "createdAt"'));
  assert.ok(sql.indexOf('SET "manifestProducedAt" = "createdAt"') < sql.indexOf('ALTER COLUMN "manifestProducedAt" SET NOT NULL'));
  assert.match(sql, /ADD COLUMN "processingPipelineTaskId" TEXT/u);
  assert.match(sql, /CREATE INDEX "ShopWork_processingPipelineTaskId_idx"/u);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX "ShopWork_processingPipelineTaskId/u);
  assert.doesNotMatch(sql, /^\s*(?:DELETE|TRUNCATE|DROP|ALTER TYPE)\b/imu);
});

test("coordinator exports every locked method and rejects non-exact lease bounds before I/O", async () => {
  const prisma = { $transaction: async () => assert.fail("transaction must not start") };
  const repository = new PipelineCoordinatorRepository(prisma);
  for (const name of ["registerStage", "recordDispatch", "claimTask", "renewTask", "recordTerminal",
    "claimAggregator", "renewAggregator", "getCompleteStage", "completeAggregator", "listRecoverable",
    "cancelRunGeneration"]) assert.equal(typeof repository[name], "function", name);
  for (const primitive of [registerStageInTransaction, assertCompleteAggregatorInTransaction,
    completeAggregatorInTransaction]) assert.equal(typeof primitive, "function");

  await assert.rejects(repository.registerStage({ manifestS3Key: "key", manifestFingerprint: "a".repeat(64),
    tasks: [], manifestProducedAt: "2026-08-12T00:00:00.000Z" }, new Date()),
  (error) => error.code === "PIPELINE_INPUT_CONFLICT");

  await assert.rejects(repository.claimTask({ leaseDurationMs: 59_999 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  await assert.rejects(repository.renewTask({ leaseDurationMs: 60_001 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  await assert.rejects(repository.claimAggregator({ leaseDurationMs: 119_999 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  await assert.rejects(repository.renewAggregator({ leaseDurationMs: 120_001 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  await assert.rejects(repository.listRecoverable({ olderThan: new Date(), limit: 101 }, new Date()),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
});

test("renewTask uses the bounded coordinator transaction profile", async () => {
  const stopped = new Error("stop after transaction profile capture");
  let options;
  const prisma = {
    $transaction: async (_operation, receivedOptions) => {
      options = receivedOptions;
      throw stopped;
    }
  };
  const repository = new PipelineCoordinatorRepository(prisma);

  await assert.rejects(repository.renewTask({
    taskId: "task_profile_fixture",
    token: "00000000-0000-4000-8000-000000000001",
    leaseDurationMs: 60000
  }, new Date("2026-08-23T00:00:00.000Z")), (error) => error === stopped);
  assert.deepEqual(options, { maxWait: 5_000, timeout: 30_000 });
});

test("stage registration reconciles exact task identities independently of database collation order", async () => {
  const now = new Date("2026-08-14T10:17:58.965Z");
  let stageRow;
  let taskRows = [];
  const transaction = {
    pipelineStage: {
      createMany: async ({ data }) => {
        [stageRow] = data;
        return { count: 1 };
      },
      findUnique: async () => stageRow
    },
    pipelineTask: {
      createMany: async ({ data }) => {
        taskRows = data;
        return { count: data.length };
      },
      findMany: async () => [...taskRows].reverse()
    }
  };
  const tasks = [
    { itemKey: "query_X04IrwiXT8TzOQrm4c_VkAqW", inputFingerprint: "1".repeat(64) },
    { itemKey: "query_2t4juXx08haUSfn59L37S92T", inputFingerprint: "2".repeat(64) },
    { itemKey: "query_ljlNnVtzPY5YqXYJnz_zQ10R", inputFingerprint: "3".repeat(64) }
  ];
  const registered = await registerStageInTransaction(transaction, {
    runId: "run_collation_fixture_0001",
    stage: "discovery",
    generation: 1,
    manifestS3Key: "runs/run_collation_fixture_0001/queries/manifest.json",
    manifestFingerprint: "a".repeat(64),
    manifestProducedAt: now,
    tasks
  }, now);
  assert.equal(registered.outcome, "created");
  assert.deepEqual(new Map(registered.tasks.map((task) => [task.itemKey, task.inputFingerprint])),
    new Map(tasks.map((task) => [task.itemKey, task.inputFingerprint])));
});

test("all eleven coordinator transactions receive the frozen profile", async () => {
  const now = new Date("2026-08-23T00:00:00.000Z");
  const runId = "run_profile_fixture_0001";
  const taskToken = "00000000-0000-4000-8000-000000000001";
  const aggregatorToken = "00000000-0000-4000-8000-000000000002";
  const recordedOptions = [];
  let sentinel;
  const prisma = {
    $transaction: async (_operation, options) => {
      recordedOptions.push(options);
      throw sentinel;
    }
  };
  const repository = new PipelineCoordinatorRepository(prisma);
  const calls = [
    ["registerStage", { runId, stage: "discovery", generation: 1,
      manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint: "a".repeat(64),
      manifestProducedAt: now, tasks: [] }],
    ["recordDispatch", { stageId: "stage_profile_fixture", itemKeys: ["k1"] }],
    ["claimTask", { runId, stage: "discovery", generation: 1, itemKey: "k1",
      inputFingerprint: "a".repeat(64), owner: "spy", token: taskToken, leaseDurationMs: 60000 }],
    ["renewTask", { taskId: "task_profile_fixture", token: taskToken, leaseDurationMs: 60000 }],
    ["recordTerminal", { taskId: "task_profile_fixture", token: taskToken, inputFingerprint: "a".repeat(64),
      state: "succeeded", artifactS3Key: "runs/profile/result.json", artifactFingerprint: "b".repeat(64) }],
    ["claimAggregator", { runId, stage: "discovery", generation: 1, owner: "spy",
      token: aggregatorToken, leaseDurationMs: 120000 }],
    ["renewAggregator", { stageId: "stage_profile_fixture", token: aggregatorToken, leaseDurationMs: 120000 }],
    ["getCompleteStage", { runId, stage: "discovery", generation: 1, token: aggregatorToken }],
    ["completeAggregator", { stageId: "stage_profile_fixture", token: aggregatorToken, state: "completed" }],
    ["listRecoverable", { olderThan: now, limit: 100 }],
    ["cancelRunGeneration", { runId, generation: 1 }]
  ];
  assert.equal(calls.length, 11);
  for (const [method, input] of calls) {
    sentinel = new Error(`sentinel before the ${method} transaction operation runs`);
    await assert.rejects(repository[method](input, now), (error) => error === sentinel, method);
  }
  assert.equal(recordedOptions.length, 11);
  for (const options of recordedOptions) assert.deepEqual(options, { maxWait: 5_000, timeout: 30_000 });
});

test("locked helpers return complete raw rows without delegate reads and the coordinator ceilings are exact", async (t) => {
  const { pipelineStageId, pipelineTaskId } = await import("../src/aws-pipeline/core/keys.js");
  const now = new Date("2026-08-23T00:00:00.000Z");
  const runId = "run_profile_fixture_0001";
  const discoveryStageId = pipelineStageId(runId, "discovery", 1);
  const discoveryTaskId = pipelineTaskId(discoveryStageId, "k1");
  const taskToken = "00000000-0000-4000-8000-000000000001";
  const aggregatorToken = "00000000-0000-4000-8000-000000000002";
  const fingerprintA = "a".repeat(64);
  const fingerprintB = "b".repeat(64);
  const runRow = { id: runId, state: "running", executionBackend: "aws", pipelineGeneration: 1, leaseExpiresAt: null };
  const taskLeaseExpiry = new Date(now.getTime() + 60000);
  const aggregationLeaseExpiry = new Date(now.getTime() + 120000);
  const taskRow = (overrides = {}) => ({ id: "task_profile_fixture", stageId: "stage_profile_fixture",
    itemKey: "k1", inputFingerprint: fingerprintA, state: "pending", attemptCount: 0, dispatchCount: 0,
    lastDispatchedAt: null, leaseOwner: null, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null,
    leaseAttempt: 0, artifactS3Key: null, artifactFingerprint: null, terminalAt: null, safeErrorCode: null,
    safeErrorMessage: null, createdAt: now, updatedAt: now, ...overrides });
  const stageRow = (overrides = {}) => ({ id: "stage_profile_fixture", runId, stage: "discovery", generation: 1,
    manifestS3Key: `runs/${runId}/domains-manifest.json`, manifestFingerprint: fingerprintA,
    manifestProducedAt: now, expectedCount: 1, terminalCount: 0, succeededCount: 0, skippedCount: 0,
    failedCount: 0, cancelledCount: 0, state: "collecting", version: 1, aggregationOwner: null,
    aggregationLeaseToken: null, aggregationLeaseAcquiredAt: null, aggregationLeaseExpiresAt: null,
    aggregationAttempt: 0, safeErrorCode: null, safeErrorMessage: null, createdAt: now, updatedAt: now,
    completedAt: null, ...overrides });
  const aggregatingLease = { aggregationOwner: "spy", aggregationLeaseToken: aggregatorToken,
    aggregationLeaseAcquiredAt: now, aggregationLeaseExpiresAt: aggregationLeaseExpiry, aggregationAttempt: 1 };
  const makeStrictTransaction = ({ rawResults = [], taskUpdates = [], stageUpdates = [], taskFindMany } = {}) => {
    const operations = { raw: 0, deliberateDelegate: 0, writes: 0, total: 0 };
    const statements = [];
    const violations = [];
    const forbidden = (delegate) => {
      violations.push(delegate);
      throw new Error("delegate read must not occur");
    };
    let taskUpdateIndex = 0;
    let stageUpdateIndex = 0;
    const transaction = {
      $queryRaw: async (strings, ...values) => {
        operations.raw += 1; operations.total += 1;
        statements.push({ kind: "raw", sql: strings.join("?"), values });
        const result = rawResults[operations.raw - 1];
        if (result === undefined) throw new Error("raw query beyond the frozen statement ceiling");
        return result;
      },
      pipelineTask: {
        update: async (args) => {
          operations.writes += 1; operations.total += 1;
          statements.push({ kind: "write", delegate: "pipelineTask.update", args });
          const result = taskUpdates[taskUpdateIndex];
          taskUpdateIndex += 1;
          if (result === undefined) throw new Error("pipelineTask.update beyond the frozen write ceiling");
          return result;
        },
        findMany: async (args) => {
          if (!taskFindMany) return forbidden("pipelineTask.findMany");
          operations.deliberateDelegate += 1; operations.total += 1;
          statements.push({ kind: "delegate", delegate: "pipelineTask.findMany", args });
          return taskFindMany();
        },
        findUnique: async () => forbidden("pipelineTask.findUnique"),
        updateMany: async () => forbidden("pipelineTask.updateMany"),
        createMany: async () => forbidden("pipelineTask.createMany")
      },
      pipelineStage: {
        update: async (args) => {
          operations.writes += 1; operations.total += 1;
          statements.push({ kind: "write", delegate: "pipelineStage.update", args });
          const result = stageUpdates[stageUpdateIndex];
          stageUpdateIndex += 1;
          if (result === undefined) throw new Error("pipelineStage.update beyond the frozen write ceiling");
          return result;
        },
        findUnique: async () => forbidden("pipelineStage.findUnique"),
        findMany: async () => forbidden("pipelineStage.findMany"),
        createMany: async () => forbidden("pipelineStage.createMany")
      },
      run: { findUnique: async () => forbidden("run.findUnique"), updateMany: async () => forbidden("run.updateMany") }
    };
    const repository = new PipelineCoordinatorRepository({
      $transaction: async (operation) => operation(transaction)
    });
    return { operations, statements, violations, run: (method, input) => repository[method](input, now) };
  };

  const claimLockedTask = taskRow({ id: discoveryTaskId, stageId: discoveryStageId });
  const claimLockedStage = stageRow({ id: discoveryStageId });
  const claimedTaskRow = taskRow({ id: discoveryTaskId, stageId: discoveryStageId, state: "processing",
    attemptCount: 1, leaseAttempt: 1, leaseOwner: "spy", leaseToken: taskToken, leaseAcquiredAt: now,
    leaseExpiresAt: taskLeaseExpiry });
  const claim = makeStrictTransaction({ rawResults: [[], [claimLockedTask], [claimLockedStage], [runRow]],
    taskUpdates: [claimedTaskRow] });
  const claimed = await claim.run("claimTask", { runId, stage: "discovery", generation: 1, itemKey: "k1",
    inputFingerprint: fingerprintA, owner: "spy", token: taskToken, leaseDurationMs: 60000 });
  assert.deepEqual(claimed, { outcome: "owned", task: claimedTaskRow, stage: claimLockedStage });
  assert.equal(claimed.task, claimedTaskRow);
  assert.notEqual(claimed.task, claimLockedTask);
  assert.match(claim.statements[1].sql, /FROM "PipelineTask"/u);
  assert.match(claim.statements[1].sql, /FOR UPDATE/u);
  assert.deepEqual(claim.statements[1].values, [discoveryTaskId]);
  assert.match(claim.statements[2].sql, /FROM "PipelineStage"/u);
  assert.deepEqual(claim.statements[2].values, [discoveryStageId]);
  assert.match(claim.statements[3].sql, /FROM "Run"/u);
  assert.deepEqual(claim.statements[3].values, [runId]);
  assert.deepEqual(claim.statements[4].args, { where: { id: discoveryTaskId }, data: { state: "processing",
    attemptCount: { increment: 1 }, leaseAttempt: { increment: 1 }, leaseOwner: "spy", leaseToken: taskToken,
    leaseAcquiredAt: now, leaseExpiresAt: taskLeaseExpiry } });

  const renew = makeStrictTransaction({ rawResults: [[], [taskRow({ state: "processing", leaseOwner: "spy",
    leaseToken: taskToken, leaseAcquiredAt: now, leaseExpiresAt: taskLeaseExpiry })], [stageRow()], [runRow]],
  taskUpdates: [taskRow({ state: "processing", leaseOwner: "spy", leaseToken: taskToken,
    leaseAcquiredAt: now, leaseExpiresAt: taskLeaseExpiry })] });
  const renewed = await renew.run("renewTask", { taskId: "task_profile_fixture", token: taskToken,
    leaseDurationMs: 60000 });
  assert.deepEqual(renewed, { expiresAt: taskLeaseExpiry });

  const recordedTaskRow = taskRow({ state: "succeeded", attemptCount: 1, leaseOwner: "spy", leaseToken: taskToken,
    leaseAcquiredAt: now, leaseExpiresAt: taskLeaseExpiry, artifactS3Key: "runs/profile/result.json",
    artifactFingerprint: fingerprintB, terminalAt: now });
  const countedStage = stageRow({ terminalCount: 1, succeededCount: 1 });
  const readyStage = stageRow({ state: "ready", terminalCount: 1, succeededCount: 1 });
  const terminal = makeStrictTransaction({ rawResults: [[], [taskRow({ state: "processing", leaseOwner: "spy",
    leaseToken: taskToken, leaseAcquiredAt: now, leaseExpiresAt: taskLeaseExpiry })], [stageRow()], [runRow]],
  taskUpdates: [recordedTaskRow], stageUpdates: [countedStage, readyStage] });
  const recorded = await terminal.run("recordTerminal", { taskId: "task_profile_fixture", token: taskToken,
    inputFingerprint: fingerprintA, state: "succeeded", artifactS3Key: "runs/profile/result.json",
    artifactFingerprint: fingerprintB });
  assert.deepEqual(recorded, { outcome: "recorded", task: recordedTaskRow, stageBecameReady: true });
  assert.equal(recorded.task, recordedTaskRow);
  assert.deepEqual(terminal.statements[5].args, { where: { id: "stage_profile_fixture" },
    data: { terminalCount: { increment: 1 }, succeededCount: { increment: 1 } } });
  assert.deepEqual(terminal.statements[6].args, { where: { id: "stage_profile_fixture" },
    data: { state: "ready" } });

  const ownedAggregatingStage = stageRow({ id: discoveryStageId, state: "aggregating", terminalCount: 1,
    succeededCount: 1, ...aggregatingLease });
  const aggregatorClaim = makeStrictTransaction({ rawResults: [[], [stageRow({ id: discoveryStageId,
    state: "ready", terminalCount: 1, succeededCount: 1 })], [runRow]], stageUpdates: [ownedAggregatingStage] });
  const claimedAggregation = await aggregatorClaim.run("claimAggregator", { runId, stage: "discovery",
    generation: 1, owner: "spy", token: aggregatorToken, leaseDurationMs: 120000 });
  assert.deepEqual(claimedAggregation, { outcome: "owned", stage: ownedAggregatingStage });
  assert.equal(claimedAggregation.stage, ownedAggregatingStage);

  const aggregatorRenew = makeStrictTransaction({ rawResults: [[], [stageRow({ state: "aggregating",
    ...aggregatingLease })], [runRow]], stageUpdates: [stageRow({ state: "aggregating", ...aggregatingLease })] });
  const renewedAggregation = await aggregatorRenew.run("renewAggregator", { stageId: "stage_profile_fixture",
    token: aggregatorToken, leaseDurationMs: 120000 });
  assert.deepEqual(renewedAggregation, { expiresAt: aggregationLeaseExpiry });

  const completeAggregatingStage = stageRow({ id: discoveryStageId, state: "aggregating", terminalCount: 1,
    succeededCount: 1, ...aggregatingLease });
  const terminalTaskForStage = taskRow({ id: "task_profile_fixture", stageId: discoveryStageId,
    state: "succeeded", artifactS3Key: "runs/profile/result.json", artifactFingerprint: fingerprintB,
    terminalAt: now });
  const completeStageRead = makeStrictTransaction({ rawResults: [[], [completeAggregatingStage], [runRow]],
    taskFindMany: () => [terminalTaskForStage] });
  const completeAggregation = await completeStageRead.run("getCompleteStage", { runId, stage: "discovery",
    generation: 1, token: aggregatorToken });
  assert.deepEqual(completeAggregation, { run: runRow, stage: completeAggregatingStage,
    tasks: [terminalTaskForStage] });

  const completedStage = stageRow({ state: "completed", completedAt: now, ...aggregatingLease });
  const aggregatorCompletion = makeStrictTransaction({ rawResults: [[], [stageRow({ state: "aggregating",
    ...aggregatingLease })], [runRow]], stageUpdates: [completedStage] });
  const finishedAggregation = await aggregatorCompletion.run("completeAggregator",
    { stageId: "stage_profile_fixture", token: aggregatorToken, state: "completed" });
  assert.deepEqual(finishedAggregation, { stage: completedStage });
  assert.equal(finishedAggregation.stage, completedStage);

  const scenarios = [["claimTask", claim], ["renewTask", renew], ["recordTerminal", terminal],
    ["claimAggregator", aggregatorClaim], ["renewAggregator", aggregatorRenew],
    ["getCompleteStage", completeStageRead], ["completeAggregator", aggregatorCompletion]];
  for (const [, scenario] of scenarios) {
    assert.match(scenario.statements[0].sql, /set_config/u);
    assert.deepEqual(scenario.statements[0].values, ["public"]);
    assert.deepEqual(scenario.violations, []);
    assert.equal(scenario.statements.length, scenario.operations.total);
  }
  const observedCeilings = Object.fromEntries(scenarios.map(([method, scenario]) => [method, scenario.operations]));
  const expectedCeilings = {
    claimTask: { raw: 4, deliberateDelegate: 0, writes: 1, total: 5 },
    renewTask: { raw: 4, deliberateDelegate: 0, writes: 1, total: 5 },
    recordTerminal: { raw: 4, deliberateDelegate: 0, writes: 3, total: 7 },
    claimAggregator: { raw: 3, deliberateDelegate: 0, writes: 1, total: 4 },
    renewAggregator: { raw: 3, deliberateDelegate: 0, writes: 1, total: 4 },
    getCompleteStage: { raw: 3, deliberateDelegate: 1, writes: 0, total: 4 },
    completeAggregator: { raw: 3, deliberateDelegate: 0, writes: 1, total: 4 }
  };
  assert.deepEqual(observedCeilings, expectedCeilings);
  t.diagnostic("coordinator statement ceilings raw/deliberate-delegate/writes/total");
  for (const [method, counts] of Object.entries(observedCeilings)) {
    t.diagnostic(`${method} ${counts.raw}/${counts.deliberateDelegate}/${counts.writes}/${counts.total}`);
  }
});

test("recordDispatch locks complete rows once and never reloads tasks", async () => {
  const now = new Date("2026-08-23T00:00:00.000Z");
  const stageId = "stage_profile_fixture";
  const lockedTaskRows = [
    { id: "task_profile_k1", stageId, itemKey: "k1", inputFingerprint: "a".repeat(64), state: "pending",
      attemptCount: 0, dispatchCount: 0, lastDispatchedAt: null, leaseOwner: null, leaseToken: null,
      leaseAcquiredAt: null, leaseExpiresAt: null, leaseAttempt: 0, artifactS3Key: null,
      artifactFingerprint: null, terminalAt: null, safeErrorCode: null, safeErrorMessage: null,
      createdAt: now, updatedAt: now },
    { id: "task_profile_k2", stageId, itemKey: "k2", inputFingerprint: "a".repeat(64), state: "pending",
      attemptCount: 0, dispatchCount: 0, lastDispatchedAt: null, leaseOwner: null, leaseToken: null,
      leaseAcquiredAt: null, leaseExpiresAt: null, leaseAttempt: 0, artifactS3Key: null,
      artifactFingerprint: null, terminalAt: null, safeErrorCode: null, safeErrorMessage: null,
      createdAt: now, updatedAt: now }
  ];
  const stageRowFor = (expectedCount) => ({ id: stageId, runId: "run_profile_fixture_0001", stage: "discovery",
    generation: 1, manifestS3Key: `runs/run_profile_fixture_0001/domains-manifest.json`,
    manifestFingerprint: "a".repeat(64), manifestProducedAt: now, expectedCount, terminalCount: 0,
    succeededCount: 0, skippedCount: 0, failedCount: 0, cancelledCount: 0, state: "collecting", version: 1,
    aggregationOwner: null, aggregationLeaseToken: null, aggregationLeaseAcquiredAt: null,
    aggregationLeaseExpiresAt: null, aggregationAttempt: 0, safeErrorCode: null, safeErrorMessage: null,
    createdAt: now, updatedAt: now, completedAt: null });
  let taskReloads = 0;
  const forbidTaskReload = async () => {
    taskReloads += 1;
    throw new Error("task reload must not occur");
  };
  const makeDispatchRepository = ({ stage: lockedStageRow, updateMany }) => {
    const rawStatements = [];
    const repository = new PipelineCoordinatorRepository({
      $transaction: async (operation) => operation({
        $queryRaw: async (strings, ...values) => {
          rawStatements.push({ sql: strings.join("?"), values });
          const result = [[], lockedTaskRows, [lockedStageRow]][rawStatements.length - 1];
          if (result === undefined) throw new Error("raw query beyond the locked dispatch reads");
          return result;
        },
        pipelineTask: { findMany: forbidTaskReload, updateMany }
      })
    });
    return { repository, rawStatements };
  };
  let updateManyArgs;
  const dispatch = makeDispatchRepository({ stage: stageRowFor(2),
    updateMany: async (args) => { updateManyArgs = args; return { count: 1 }; } });
  const dispatched = await dispatch.repository.recordDispatch({ stageId, itemKeys: ["k1"] }, now);
  assert.deepEqual(dispatched, { count: 1 });
  assert.equal(taskReloads, 0);
  assert.equal(dispatch.rawStatements.length, 3);
  assert.match(dispatch.rawStatements[0].sql, /set_config/u);
  assert.deepEqual(dispatch.rawStatements[0].values, ["public"]);
  assert.match(dispatch.rawStatements[1].sql, /FROM "PipelineTask"/u);
  assert.match(dispatch.rawStatements[1].sql, /FOR UPDATE/u);
  assert.deepEqual(dispatch.rawStatements[1].values, [stageId]);
  assert.match(dispatch.rawStatements[2].sql, /FROM "PipelineStage"/u);
  assert.deepEqual(updateManyArgs, { where: { stageId, itemKey: { in: ["k1"] } },
    data: { dispatchCount: { increment: 1 }, lastDispatchedAt: now } });

  const cardinality = makeDispatchRepository({ stage: stageRowFor(3),
    updateMany: async () => { throw new Error("dispatch write must not follow a cardinality conflict"); } });
  await assert.rejects(cardinality.repository.recordDispatch({ stageId, itemKeys: ["k1"] }, now),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  assert.equal(taskReloads, 0);
});
