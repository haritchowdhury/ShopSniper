import { prismaSchemaForClient } from "../../prisma-client.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { pipelineStageId, pipelineTaskId } from "../core/keys.js";

const TERMINAL_STATES = new Set(["succeeded", "skipped", "failed", "cancelled"]);
const FINISHED_STAGE_STATES = new Set(["completed", "failed"]);
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const SCHEMA = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PIPELINE_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 5_000, timeout: 30_000 });

function conflict(code = "PIPELINE_INPUT_CONFLICT") {
  throw new PipelineInvariantError(code);
}

function requireNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) conflict();
  return now;
}

function requireProducedAt(value) {
  return requireNow(value);
}

function requireLease(value, expected) {
  if (value !== expected) conflict();
}

function requireFingerprint(value) {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) conflict();
}

function requireNonempty(value) {
  if (typeof value !== "string" || value.length === 0) conflict();
}

function requireToken(value) {
  if (typeof value !== "string" || !UUID.test(value)) conflict();
}

function plusMilliseconds(now, duration) {
  return new Date(now.getTime() + duration);
}

function sameNullable(left, right) {
  return (left ?? null) === (right ?? null);
}

function taskRegistrationMatches(task, expected) {
  return task.itemKey === expected.itemKey && task.inputFingerprint === expected.inputFingerprint;
}

function sameInstant(left, right) {
  return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
}

function terminalMatches(task, input) {
  return task.state === input.state && task.inputFingerprint === input.inputFingerprint &&
    sameNullable(task.artifactS3Key, input.artifactS3Key) &&
    sameNullable(task.artifactFingerprint, input.artifactFingerprint) &&
    sameNullable(task.safeErrorCode, input.safeErrorCode) &&
    sameNullable(task.safeErrorMessage, input.safeErrorMessage);
}

async function selectSchema(transaction, schema) {
  await transaction.$queryRaw`SELECT set_config('search_path', ${schema}, true)`;
}

async function lockedTask(transaction, taskId) {
  const rows = await transaction.$queryRaw`
    SELECT * FROM "PipelineTask" WHERE "id" = ${taskId} FOR UPDATE
  `;
  if (rows.length !== 1) conflict();
  return rows[0];
}

async function lockedStage(transaction, stageId) {
  const rows = await transaction.$queryRaw`
    SELECT * FROM "PipelineStage" WHERE "id" = ${stageId} FOR UPDATE
  `;
  if (rows.length !== 1) conflict();
  return rows[0];
}

async function lockedRun(transaction, runId) {
  const rows = await transaction.$queryRaw`
    SELECT * FROM "Run" WHERE "id" = ${runId} FOR UPDATE
  `;
  if (rows.length !== 1) conflict();
  return rows[0];
}

function activeAwsRun(run, generation) {
  return run.executionBackend === "aws" && run.pipelineGeneration === generation && run.state === "running";
}

function trafficRunLeaseIsLive(run, stage, now) {
  return stage === "traffic_crux" && run.leaseExpiresAt instanceof Date && run.leaseExpiresAt > now;
}

export async function registerStageInTransaction(transaction, input, now) {
  requireNow(now);
  requireProducedAt(input?.manifestProducedAt);
  requireNonempty(input?.manifestS3Key);
  requireFingerprint(input?.manifestFingerprint);
  if (!Array.isArray(input?.tasks)) conflict();
  const orderedTasks = [...input.tasks].sort((left, right) => left.itemKey.localeCompare(right.itemKey));
  if (new Set(orderedTasks.map(({ itemKey }) => itemKey)).size !== orderedTasks.length) conflict();
  for (const task of orderedTasks) {
    requireNonempty(task.itemKey);
    requireFingerprint(task.inputFingerprint);
  }
  const stageId = pipelineStageId(input.runId, input.stage, input.generation);
  const taskRows = orderedTasks.map((task) => ({
    id: pipelineTaskId(stageId, task.itemKey), stageId, itemKey: task.itemKey,
    inputFingerprint: task.inputFingerprint, createdAt: now, updatedAt: now
  }));
  const created = await transaction.pipelineStage.createMany({ data: [{
    id: stageId, runId: input.runId, stage: input.stage, generation: input.generation,
    manifestS3Key: input.manifestS3Key, manifestFingerprint: input.manifestFingerprint,
    manifestProducedAt: input.manifestProducedAt,
    expectedCount: taskRows.length, state: taskRows.length === 0 ? "ready" : "collecting",
    createdAt: now, updatedAt: now
  }], skipDuplicates: true });
  const stage = await transaction.pipelineStage.findUnique({ where: { id: stageId } });
  if (!stage || stage.runId !== input.runId || stage.stage !== input.stage ||
      stage.generation !== input.generation || stage.manifestS3Key !== input.manifestS3Key ||
      stage.manifestFingerprint !== input.manifestFingerprint ||
      !sameInstant(stage.manifestProducedAt, input.manifestProducedAt) ||
      stage.expectedCount !== taskRows.length) conflict();
  if (created.count === 1 && taskRows.length) {
    await transaction.pipelineTask.createMany({ data: taskRows });
  }
  const tasks = await transaction.pipelineTask.findMany({ where: { stageId }, orderBy: { itemKey: "asc" } });
  const expectedByItemKey = new Map(orderedTasks.map((task) => [task.itemKey, task]));
  if (tasks.length !== orderedTasks.length || tasks.some((task) => {
    const expected = expectedByItemKey.get(task.itemKey);
    return !expected || !taskRegistrationMatches(task, expected);
  })) conflict();
  return { outcome: created.count === 1 ? "created" : "replayed", stage, tasks };
}

export async function assertCompleteAggregatorInTransaction(transaction, { runId, stage, generation, token }, now) {
  requireNow(now);
  requireToken(token);
  const stageId = pipelineStageId(runId, stage, generation);
  const stageRow = await lockedStage(transaction, stageId);
  const run = await lockedRun(transaction, runId);
  if (trafficRunLeaseIsLive(run, stage, now)) conflict("PIPELINE_NOT_READY");
  if (stageRow.state !== "aggregating" || stageRow.aggregationLeaseToken !== token ||
      !stageRow.aggregationLeaseExpiresAt || stageRow.aggregationLeaseExpiresAt <= now ||
      !activeAwsRun(run, generation)) conflict("PIPELINE_LEASE_LOST");
  const tasks = await transaction.pipelineTask.findMany({ where: { stageId }, orderBy: { itemKey: "asc" } });
  if (tasks.length !== stageRow.expectedCount || stageRow.terminalCount !== stageRow.expectedCount ||
      tasks.some((task) => !TERMINAL_STATES.has(task.state))) conflict("PIPELINE_NOT_READY");
  const counts = Object.fromEntries([...TERMINAL_STATES].map((state) => [state, tasks.filter((task) => task.state === state).length]));
  if (counts.succeeded !== stageRow.succeededCount || counts.skipped !== stageRow.skippedCount ||
      counts.failed !== stageRow.failedCount || counts.cancelled !== stageRow.cancelledCount) conflict();
  return { run, stage: stageRow, tasks };
}

export async function completeAggregatorInTransaction(transaction, input, now) {
  requireNow(now);
  requireToken(input?.token);
  if (!FINISHED_STAGE_STATES.has(input?.state)) conflict();
  const current = await lockedStage(transaction, input.stageId);
  const run = await lockedRun(transaction, current.runId);
  if (current.state !== "aggregating" || current.aggregationLeaseToken !== input.token ||
      !current.aggregationLeaseExpiresAt || current.aggregationLeaseExpiresAt <= now ||
      !activeAwsRun(run, current.generation) || trafficRunLeaseIsLive(run, current.stage, now)) {
    conflict(current.state === "cancelled" || run.state === "cancelled" ? "PIPELINE_CANCELLED" : "PIPELINE_LEASE_LOST");
  }
  const stage = await transaction.pipelineStage.update({ where: { id: input.stageId }, data: {
    state: input.state, safeErrorCode: input.safeErrorCode ?? null,
    safeErrorMessage: input.safeErrorMessage ?? null, completedAt: now
  } });
  return { stage };
}

export class PipelineCoordinatorRepository {
  constructor(prisma) {
    if (!prisma) conflict();
    this.prisma = prisma;
    this.databaseSchema = prismaSchemaForClient(prisma);
    if (!SCHEMA.test(this.databaseSchema)) conflict();
  }

  async registerStage(input, now) {
    requireNow(now);
    requireProducedAt(input?.manifestProducedAt);
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      return registerStageInTransaction(transaction, input, now);
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async recordDispatch({ stageId, itemKeys }, now) {
    requireNow(now);
    if (!Array.isArray(itemKeys) || new Set(itemKeys).size !== itemKeys.length) conflict();
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      const lockedTasks = await transaction.$queryRaw`
        SELECT * FROM "PipelineTask" WHERE "stageId" = ${stageId} ORDER BY "id" FOR UPDATE
      `;
      const stage = await lockedStage(transaction, stageId);
      if (["failed", "cancelled"].includes(stage.state)) conflict("PIPELINE_CANCELLED");
      if (lockedTasks.length !== stage.expectedCount) conflict();
      const requestedItemKeys = new Set(itemKeys);
      const requested = lockedTasks.filter((task) => requestedItemKeys.has(task.itemKey));
      if (requested.length !== itemKeys.length) conflict();
      const updated = await transaction.pipelineTask.updateMany({
        where: { stageId, itemKey: { in: itemKeys } },
        data: { dispatchCount: { increment: 1 }, lastDispatchedAt: now }
      });
      return { count: updated.count };
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async claimTask(input, now) {
    requireNow(now);
    requireLease(input?.leaseDurationMs, 60000);
    requireFingerprint(input?.inputFingerprint);
    requireNonempty(input?.owner);
    requireToken(input?.token);
    const stageId = pipelineStageId(input.runId, input.stage, input.generation);
    const taskId = pipelineTaskId(stageId, input.itemKey);
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      let task = await lockedTask(transaction, taskId);
      const stage = await lockedStage(transaction, stageId);
      const run = await lockedRun(transaction, input.runId);
      if (task.stageId !== stageId || task.inputFingerprint !== input.inputFingerprint) conflict();
      if (task.state === "cancelled" || stage.state === "cancelled" || run.state === "cancelled" || !activeAwsRun(run, input.generation)) {
        return { outcome: "cancelled", task, stage };
      }
      if (TERMINAL_STATES.has(task.state)) return { outcome: "terminal", task, stage };
      if (stage.state !== "collecting") return { outcome: "busy", task, stage };
      if (task.state === "processing" && task.leaseExpiresAt && task.leaseExpiresAt > now) {
        return { outcome: "busy", task, stage };
      }
      task = await transaction.pipelineTask.update({ where: { id: taskId }, data: {
        state: "processing", attemptCount: { increment: 1 }, leaseAttempt: { increment: 1 },
        leaseOwner: input.owner, leaseToken: input.token, leaseAcquiredAt: now,
        leaseExpiresAt: plusMilliseconds(now, input.leaseDurationMs)
      } });
      return { outcome: "owned", task, stage };
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async renewTask({ taskId, token, leaseDurationMs }, now) {
    requireNow(now);
    requireLease(leaseDurationMs, 60000);
    requireToken(token);
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      const task = await lockedTask(transaction, taskId);
      const stage = await lockedStage(transaction, task.stageId);
      const run = await lockedRun(transaction, stage.runId);
      if (task.state !== "processing" || task.leaseToken !== token || !task.leaseExpiresAt ||
          task.leaseExpiresAt <= now || stage.state !== "collecting" || !activeAwsRun(run, stage.generation)) {
        conflict(task.state === "cancelled" || stage.state === "cancelled" || run.state === "cancelled"
          ? "PIPELINE_CANCELLED" : "PIPELINE_LEASE_LOST");
      }
      const expiresAt = plusMilliseconds(now, leaseDurationMs);
      await transaction.pipelineTask.update({ where: { id: taskId }, data: { leaseExpiresAt: expiresAt } });
      return { expiresAt };
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async recordTerminal(input, now) {
    requireNow(now);
    requireToken(input?.token);
    requireFingerprint(input?.inputFingerprint);
    requireNonempty(input?.artifactS3Key);
    requireFingerprint(input?.artifactFingerprint);
    if (!TERMINAL_STATES.has(input?.state)) conflict();
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      let task = await lockedTask(transaction, input.taskId);
      let stage = await lockedStage(transaction, task.stageId);
      const run = await lockedRun(transaction, stage.runId);
      if (task.inputFingerprint !== input.inputFingerprint) conflict();
      if (TERMINAL_STATES.has(task.state)) {
        if (task.leaseToken === input.token && terminalMatches(task, input)) {
          return { outcome: "replayed", task, stageBecameReady: false };
        }
        conflict(task.state === "cancelled" ? "PIPELINE_CANCELLED" : "PIPELINE_INPUT_CONFLICT");
      }
      if (task.state !== "processing" || task.leaseToken !== input.token || !task.leaseExpiresAt ||
          task.leaseExpiresAt <= now || stage.state !== "collecting" || !activeAwsRun(run, stage.generation)) {
        conflict(stage.state === "cancelled" || run.state === "cancelled" ? "PIPELINE_CANCELLED" : "PIPELINE_LEASE_LOST");
      }
      task = await transaction.pipelineTask.update({ where: { id: task.id }, data: {
        state: input.state, artifactS3Key: input.artifactS3Key,
        artifactFingerprint: input.artifactFingerprint, terminalAt: now,
        safeErrorCode: input.safeErrorCode ?? null, safeErrorMessage: input.safeErrorMessage ?? null
      } });
      const counter = `${input.state}Count`;
      stage = await transaction.pipelineStage.update({ where: { id: stage.id }, data: {
        terminalCount: { increment: 1 }, [counter]: { increment: 1 }
      } });
      const stageBecameReady = stage.terminalCount === stage.expectedCount;
      if (stageBecameReady) {
        stage = await transaction.pipelineStage.update({ where: { id: stage.id }, data: { state: "ready" } });
      }
      return { outcome: "recorded", task, stageBecameReady };
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async claimAggregator(input, now) {
    requireNow(now);
    requireLease(input?.leaseDurationMs, 120000);
    requireNonempty(input?.owner);
    requireToken(input?.token);
    const stageId = pipelineStageId(input.runId, input.stage, input.generation);
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      let stage = await lockedStage(transaction, stageId);
      const run = await lockedRun(transaction, input.runId);
      if (stage.state === "cancelled" || run.state === "cancelled" || !activeAwsRun(run, input.generation)) {
        return { outcome: "cancelled", stage };
      }
      if (FINISHED_STAGE_STATES.has(stage.state)) return { outcome: "terminal", stage };
      if (trafficRunLeaseIsLive(run, stage.stage, now)) return { outcome: "busy", stage };
      if (stage.terminalCount !== stage.expectedCount) return { outcome: "not_ready", stage };
      if (stage.state === "aggregating" && stage.aggregationLeaseExpiresAt && stage.aggregationLeaseExpiresAt > now) {
        return { outcome: "busy", stage };
      }
      if (stage.state !== "ready" && stage.state !== "aggregating") return { outcome: "not_ready", stage };
      stage = await transaction.pipelineStage.update({ where: { id: stageId }, data: {
        state: "aggregating", aggregationOwner: input.owner, aggregationLeaseToken: input.token,
        aggregationLeaseAcquiredAt: now, aggregationLeaseExpiresAt: plusMilliseconds(now, input.leaseDurationMs),
        aggregationAttempt: { increment: 1 }
      } });
      return { outcome: "owned", stage };
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async renewAggregator({ stageId, token, leaseDurationMs }, now) {
    requireNow(now);
    requireLease(leaseDurationMs, 120000);
    requireToken(token);
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      const stage = await lockedStage(transaction, stageId);
      const run = await lockedRun(transaction, stage.runId);
      if (stage.state !== "aggregating" || stage.aggregationLeaseToken !== token ||
          !stage.aggregationLeaseExpiresAt || stage.aggregationLeaseExpiresAt <= now ||
          !activeAwsRun(run, stage.generation)) {
        conflict(stage.state === "cancelled" || run.state === "cancelled" ? "PIPELINE_CANCELLED" : "PIPELINE_LEASE_LOST");
      }
      const expiresAt = plusMilliseconds(now, leaseDurationMs);
      await transaction.pipelineStage.update({ where: { id: stageId }, data: { aggregationLeaseExpiresAt: expiresAt } });
      return { expiresAt };
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async getCompleteStage(input, now) {
    requireNow(now);
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      return assertCompleteAggregatorInTransaction(transaction, input, now);
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async completeAggregator(input, now) {
    requireNow(now);
    requireToken(input?.token);
    if (!FINISHED_STAGE_STATES.has(input?.state)) conflict();
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      return completeAggregatorInTransaction(transaction, input, now);
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async listRecoverable({ olderThan, limit = 100 }, now) {
    requireNow(now);
    requireNow(olderThan);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) conflict();
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      const taskRows = await transaction.pipelineTask.findMany({
        where: { stage: { run: { executionBackend: "aws", state: "running" }, state: "collecting" }, OR: [
          { state: "pending", OR: [{ lastDispatchedAt: null }, { lastDispatchedAt: { lte: olderThan } }] },
          { state: "processing", leaseExpiresAt: { lte: now } }
        ] }, include: { stage: true }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: limit
      });
      const stages = taskRows.length === limit ? [] : await transaction.pipelineStage.findMany({
        where: { run: { executionBackend: "aws", state: "running" }, OR: [
          { state: "ready", updatedAt: { lte: olderThan } },
          { state: "aggregating", aggregationLeaseExpiresAt: { lte: now } }
        ] }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: limit - taskRows.length
      });
      const tasks = taskRows.map(({ stage, ...task }) => ({ task, stage }));
      return { tasks, stages };
    }, PIPELINE_TRANSACTION_OPTIONS);
  }

  async cancelRunGeneration({ runId, generation }, now) {
    requireNow(now);
    return this.prisma.$transaction(async (transaction) => {
      await selectSchema(transaction, this.databaseSchema);
      const taskLocks = await transaction.$queryRaw`
        SELECT task."id" FROM "PipelineTask" AS task
        JOIN "PipelineStage" AS stage ON stage."id" = task."stageId"
        WHERE stage."runId" = ${runId} AND stage."generation" = ${generation}
        ORDER BY task."id" FOR UPDATE OF task
      `;
      const stageLocks = await transaction.$queryRaw`
        SELECT "id" FROM "PipelineStage"
        WHERE "runId" = ${runId} AND "generation" = ${generation}
        ORDER BY "id" FOR UPDATE
      `;
      const run = await lockedRun(transaction, runId);
      if (run.executionBackend !== "aws" || run.pipelineGeneration !== generation)
        conflict("PIPELINE_INPUT_CONFLICT");
      if (stageLocks.length === 0 && taskLocks.length === 0) conflict();
      const stagesBefore = await transaction.pipelineStage.findMany({ where: { runId, generation }, orderBy: { id: "asc" } });
      for (const stage of stagesBefore) {
        if (["completed", "failed", "cancelled"].includes(stage.state)) continue;
        const cancelled = await transaction.pipelineTask.updateMany({
          where: { stageId: stage.id, state: { in: ["pending", "processing"] } },
          data: { state: "cancelled", terminalAt: now, safeErrorCode: "PIPELINE_CANCELLED",
            safeErrorMessage: "PIPELINE_CANCELLED", leaseExpiresAt: now }
        });
        await transaction.pipelineStage.update({ where: { id: stage.id }, data: {
          state: "cancelled", terminalCount: { increment: cancelled.count },
          cancelledCount: { increment: cancelled.count }, aggregationLeaseExpiresAt: now,
          safeErrorCode: "PIPELINE_CANCELLED", safeErrorMessage: "PIPELINE_CANCELLED", completedAt: now
        } });
      }
      const stages = await transaction.pipelineStage.findMany({ where: { runId, generation }, orderBy: { id: "asc" } });
      const tasks = await transaction.pipelineTask.findMany({ where: { stage: { runId, generation } }, orderBy: { id: "asc" } });
      const updated = await transaction.run.updateMany({ where: { id: runId, executionBackend: "aws",
        pipelineGeneration: generation, state: "running" }, data: { state: "cancelled", phase: "finished",
        stage: "cancelled", completedAt: now, resultsAvailable: false,
        safeErrorCode: "PIPELINE_CANCELLED", safeErrorMessage: "PIPELINE_CANCELLED",
        leaseOwner: null, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null,
        lastHeartbeatAt: null } });
      if (updated.count !== 1) conflict("PIPELINE_CANCELLED");
      return { run: await transaction.run.findUnique({ where: { id: runId } }), stages, tasks };
    }, PIPELINE_TRANSACTION_OPTIONS);
  }
}
