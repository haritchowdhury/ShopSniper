import { createHash, randomBytes } from "node:crypto";
import { blake2s } from "@noble/hashes/blake2.js";
import { prismaSchemaForClient } from "../prisma-client.js";

const RESEARCH_ID = /^kr_[A-Za-z0-9_-]{24}$/u;
const RUN_ID = /^run_[A-Za-z0-9_-]{16,80}$/u;
const ITEM_KEY = /^[A-Za-z0-9_.:-]{1,128}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32}$/u;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/u;
const STAGES = new Set(["expansion", "anchor_screen", "market_overview"]);
const TASK_TERMINAL = new Set(["succeeded", "skipped", "failed"]);
const ATTEMPT_TERMINAL = new Set(["succeeded", "failed", "ambiguous"]);
const TASK_LEASE_MS = 60_000;
const AGGREGATION_LEASE_MS = 120_000;
const THROTTLE_MIN_GAP_MS = 2_000;
const CACHE_TTL_SECONDS = 604_800;
const MAX_RESULT_BYTES = 33_554_432;
const MAX_SELECTION_ITEMS = 200;
const MAX_HANDOFF_ITEMS = 100;
const DECIMAL_8 = /^\d+\.\d{8}$/u;

export class KeywordRepositoryError extends Error {
  constructor(code = "KEYWORD_INPUT_CONFLICT") {
    super(code);
    this.name = "KeywordRepositoryError";
    this.code = code;
  }
}

function conflict(code = "KEYWORD_INPUT_CONFLICT") {
  throw new KeywordRepositoryError(code);
}

function requireResearchId(value) {
  if (typeof value !== "string" || !RESEARCH_ID.test(value)) conflict();
  return value;
}

function requireRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) conflict();
  return value;
}

function requireItemKey(value) {
  if (typeof value !== "string" || !ITEM_KEY.test(value)) conflict();
  return value;
}

function requireFingerprint(value) {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) conflict();
  return value;
}

function requireToken(value) {
  if (typeof value !== "string" || !TOKEN.test(value)) conflict();
  return value;
}

function requireNonempty(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) conflict();
  return value;
}

function requireOwner(value) {
  return requireNonempty(value);
}

function requireNow(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) conflict();
  return value;
}

function requireStage(value) {
  if (!STAGES.has(value)) conflict();
  return value;
}

function requireGeneration(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) conflict();
  return value;
}

function requireDecimalUsd(value) {
  if (typeof value !== "string" || !DECIMAL_8.test(value)) conflict();
  return value;
}

function requireSelectionItemId(value) {
  if (typeof value !== "string" || !/^ksi_[a-f0-9]{12}$/u.test(value)) conflict();
  return value;
}

function plusMilliseconds(now, duration) {
  return new Date(now.getTime() + duration);
}

function derivedId(prefix, parts) {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 24);
  return `${prefix}${digest}`;
}

export function newResearchId() {
  return `kr_${randomBytes(18).toString("base64url")}`;
}

export function newLeaseToken() {
  return randomBytes(24).toString("base64url");
}

export function selectionItemId(sourceKind, originalNormalizedKeyword) {
  if (sourceKind !== "calculated" && sourceKind !== "manual") conflict();
  if (typeof originalNormalizedKeyword !== "string" || originalNormalizedKeyword.length === 0 ||
      originalNormalizedKeyword.length > 160) conflict();
  const digest = Buffer.from(blake2s(Buffer.from(`${sourceKind}\n${originalNormalizedKeyword}`, "utf8"))).toString("hex");
  return `ksi_${digest.slice(0, 12)}`;
}

export function keywordStageId(researchId, stage, generation) {
  requireResearchId(researchId);
  requireStage(stage);
  requireGeneration(generation);
  return derivedId("krs_", [researchId, stage, generation]);
}

export function keywordTaskId(stageId, itemKey) {
  requireNonempty(stageId);
  requireItemKey(itemKey);
  return derivedId("krt_", [stageId, itemKey]);
}

function keywordAttemptId(taskId, attemptNumber) {
  requireNonempty(taskId);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) conflict();
  return derivedId("kra_", [taskId, attemptNumber]);
}

function taskRegistrationMatches(task, expected) {
  return task.itemKey === expected.itemKey && task.inputFingerprint === expected.inputFingerprint &&
    task.endpointKey === expected.endpointKey && task.requestFingerprint === expected.requestFingerprint;
}

function sameNullable(left, right) {
  return (left ?? null) === (right ?? null);
}

function serializeMoney(value) {
  if (value === null || value === undefined) return null;
  return Number(value).toFixed(8);
}

function normalizeUsdInput(value) {
  if (value === null || value === undefined) return null;
  return Number(requireDecimalUsd(value)).toFixed(8);
}

function requireTaskInputs(tasks) {
  if (!Array.isArray(tasks)) conflict();
  for (const task of tasks) {
    requireItemKey(task?.itemKey);
    requireFingerprint(task?.inputFingerprint);
    if (!["keyword_suggestions", "related_keywords", "keyword_overview"].includes(task?.endpointKey)) {
      conflict();
    }
    requireFingerprint(task?.requestFingerprint);
  }
  const unique = new Set(tasks.map(({ itemKey }) => itemKey));
  if (unique.size !== tasks.length) conflict();
  return [...tasks].sort((left, right) => left.itemKey.localeCompare(right.itemKey));
}

export class PrismaKeywordResearchRepository {
  constructor(client) {
    this.client = client;
    this.schema = prismaSchemaForClient(client);
  }

  async transaction(work) {
    return this.client.$transaction(async (tx) => {
      if (this.schema && this.schema !== "public") {
        await tx.$queryRaw`SELECT set_config('search_path', ${this.schema}, true)`;
      }
      return work(tx);
    });
  }

  async create(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const ownerId = requireOwner(input?.ownerId);
    requireFingerprint(input?.configFingerprint);
    if (input?.configSnapshot === null || typeof input?.configSnapshot !== "object") conflict();
    if (!Array.isArray(input?.seeds) || input.seeds.length < 1 || input.seeds.length > 5) conflict();
    if (!Array.isArray(input?.markets) || input.markets.length !== 9) conflict();
    const existing = await this.client.keywordResearch.findUnique({ where: { id: researchId } });
    if (existing) {
      if (existing.ownerId !== ownerId || existing.configFingerprint !== input.configFingerprint) {
        return { outcome: "conflict" };
      }
      return { outcome: "found", research: existing };
    }
    const research = await this.client.keywordResearch.create({ data: {
      id: researchId, ownerId, state: "queued", generation: 1, contractVersion: 1,
      configSnapshot: input.configSnapshot, configFingerprint: input.configFingerprint,
      seeds: input.seeds, markets: input.markets, progress: { stages: {} },
      selectionRevision: 0, createdAt: now
    } });
    return { outcome: "created", research };
  }

  async getOwned(input) {
    const researchId = requireResearchId(input?.researchId);
    const ownerId = requireOwner(input?.ownerId);
    const research = await this.client.keywordResearch.findUnique({ where: { id: researchId } });
    if (!research || research.ownerId !== ownerId) return { outcome: "not_found" };
    return { outcome: "found", research };
  }

  async initialize(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const ownerId = requireOwner(input?.ownerId);
    const stageName = requireStage(input?.stage);
    const generation = requireGeneration(input?.generation ?? 1);
    const tasks = requireTaskInputs(input?.tasks ?? []);
    return this.transaction(async (tx) => {
      const research = await tx.keywordResearch.findUnique({ where: { id: researchId } });
      if (!research || research.ownerId !== ownerId || research.generation !== generation) {
        return { outcome: "not_found" };
      }
      if (research.state === "failed" || research.state === "completed") return { outcome: "conflict" };
      if (research.state === "queued") {
        await tx.keywordResearch.update({ where: { id: researchId }, data: { state: "running", startedAt: now } });
      }
      const stageId = keywordStageId(researchId, stageName, generation);
      const created = await tx.keywordResearchStage.createMany({ data: [{
        id: stageId, researchId, stage: stageName, generation,
        expectedCount: tasks.length, state: tasks.length === 0 ? "ready" : "collecting",
        createdAt: now, updatedAt: now
      }], skipDuplicates: true });
      if (created.count === 1 && tasks.length) {
        await tx.keywordResearchTask.createMany({ data: tasks.map((task) => ({
          id: keywordTaskId(stageId, task.itemKey), stageId, itemKey: task.itemKey,
          inputFingerprint: task.inputFingerprint, endpointKey: task.endpointKey,
          requestFingerprint: task.requestFingerprint,
          nextAttemptAt: task.nextAttemptAt instanceof Date ? task.nextAttemptAt : null,
          createdAt: now, updatedAt: now
        })) });
      }
      const stage = await tx.keywordResearchStage.findUnique({ where: { id: stageId } });
      const stored = await tx.keywordResearchTask.findMany({ where: { stageId }, orderBy: { itemKey: "asc" } });
      const expectedByItemKey = new Map(tasks.map((task) => [task.itemKey, task]));
      if (!stage || stage.expectedCount !== tasks.length ||
          stored.length !== tasks.length ||
          stored.some((task) => {
            const expected = expectedByItemKey.get(task.itemKey);
            return !expected || !taskRegistrationMatches(task, expected);
          })) {
        return { outcome: "conflict" };
      }
      return { outcome: created.count === 1 ? "created" : "found", stage, tasks: stored };
    });
  }

  async claim(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const owner = requireNonempty(input?.owner);
    const token = requireToken(input?.token);
    return this.transaction(async (tx) => {
      const task = await tx.keywordResearchTask.findUnique({ where: { id: taskId } });
      if (!task) return { outcome: "not_found" };
      if (TASK_TERMINAL.has(task.state)) return { outcome: "conflict" };
      const leaseLive = task.leaseExpiresAt instanceof Date && task.leaseExpiresAt.getTime() > now.getTime();
      if (task.state === "processing" && leaseLive && task.leaseToken !== token) {
        return { outcome: "lost" };
      }
      if (task.state === "pending" && task.nextAttemptAt instanceof Date &&
          task.nextAttemptAt.getTime() > now.getTime()) {
        return { outcome: "delayed", retryAt: task.nextAttemptAt };
      }
      const updated = await tx.keywordResearchTask.updateMany({
        where: { id: taskId, state: task.state, leaseToken: task.leaseToken },
        data: {
          state: "processing", leaseOwner: owner, leaseToken: token,
          leaseAcquiredAt: now, leaseExpiresAt: plusMilliseconds(now, TASK_LEASE_MS),
          leaseAttempt: { increment: 1 }, dispatchCount: { increment: 1 }, lastDispatchedAt: now,
          updatedAt: now
        }
      });
      if (updated.count !== 1) return { outcome: "lost" };
      return { outcome: "claimed", task: await tx.keywordResearchTask.findUnique({ where: { id: taskId } }) };
    });
  }

  async heartbeat(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const token = requireToken(input?.token);
    const updated = await this.client.keywordResearchTask.updateMany({
      where: { id: taskId, state: "processing", leaseToken: token },
      data: { leaseExpiresAt: plusMilliseconds(now, TASK_LEASE_MS), updatedAt: now }
    });
    if (updated.count !== 1) return { outcome: "lost" };
    return { outcome: "claimed", leaseExpiresAt: plusMilliseconds(now, TASK_LEASE_MS) };
  }

  async recordAttempt(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const attemptNumber = input?.attemptNumber;
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1) conflict();
    requireFingerprint(input?.requestFingerprint);
    const reservationCostUsd = requireDecimalUsd(input?.reservationCostUsd);
    const maxCostPerResearchUsd = requireDecimalUsd(input?.maxCostPerResearchUsd);
    return this.transaction(async (tx) => {
      const task = await tx.keywordResearchTask.findUnique({ where: { id: taskId } });
      if (!task) return { outcome: "not_found" };
      const existing = await tx.keywordResearchProviderAttempt.findUnique({
        where: { taskId_attemptNumber: { taskId, attemptNumber } }
      });
      if (existing) {
        if (existing.requestFingerprint !== input.requestFingerprint ||
            serializeMoney(existing.reservationCostUsd) !== normalizeUsdInput(reservationCostUsd)) {
          return { outcome: "conflict" };
        }
        return { outcome: "found", attempt: existing };
      }
      const stage = await tx.keywordResearchStage.findUnique({ where: { id: task.stageId } });
      if (!stage) return { outcome: "not_found" };
      const [exposure] = await tx.$queryRaw`
        SELECT (COALESCE(SUM(a."providerCostUsd"), 0)
              + COALESCE(SUM(CASE WHEN a."state" IN ('planned', 'in_flight', 'ambiguous')
                      THEN a."reservationCostUsd" ELSE 0 END), 0))::text AS "exposureUsd"
        FROM "KeywordResearchProviderAttempt" AS a
        JOIN "KeywordResearchTask" AS t ON t."id" = a."taskId"
        JOIN "KeywordResearchStage" AS s ON s."id" = t."stageId"
        WHERE s."researchId" = ${stage.researchId}
          AND s."generation" = ${stage.generation}`;
      if (BigInt(exposure.exposureUsd.replace(".", "")) + BigInt(reservationCostUsd.replace(".", "")) >
          BigInt(maxCostPerResearchUsd.replace(".", ""))) {
        return { outcome: "conflict", code: "KEYWORD_PROVIDER_BUDGET_EXHAUSTED" };
      }
      const attempt = await tx.keywordResearchProviderAttempt.create({ data: {
        id: keywordAttemptId(taskId, attemptNumber), taskId, attemptNumber,
        state: "planned", requestFingerprint: input.requestFingerprint,
        reservationCostUsd, plannedAt: now, createdAt: now, updatedAt: now
      } });
      return { outcome: "created", attempt };
    });
  }

  async settleAttempt(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    if (!Number.isInteger(input?.attemptNumber) || input?.attemptNumber < 1) conflict();
    if (!ATTEMPT_TERMINAL.has(input?.state)) conflict();
    if (input.state !== "ambiguous" && input?.providerCostUsd !== undefined) {
      requireDecimalUsd(input.providerCostUsd);
    }
    return this.transaction(async (tx) => {
      const attempt = await tx.keywordResearchProviderAttempt.findUnique({
        where: { taskId_attemptNumber: { taskId, attemptNumber: input.attemptNumber } }
      });
      if (!attempt) return { outcome: "not_found" };
      if (ATTEMPT_TERMINAL.has(attempt.state)) {
        const sameSettle = attempt.state === input.state &&
          serializeMoney(attempt.providerCostUsd) === normalizeUsdInput(input.providerCostUsd) &&
          sameNullable(attempt.safeErrorCode, input.safeErrorCode ?? null) &&
          sameNullable(attempt.resultFingerprint, input.resultFingerprint ?? null);
        return sameSettle ? { outcome: "found", attempt } : { outcome: "conflict" };
      }
      const updated = await tx.keywordResearchProviderAttempt.updateMany({
        where: { id: attempt.id, state: { in: ["planned", "in_flight"] } },
        data: {
          state: input.state,
          providerCostUsd: input.state === "ambiguous" ? null : input.providerCostUsd ?? null,
          safeErrorCode: input.safeErrorCode ?? null,
          resultFingerprint: input.resultFingerprint ?? null,
          completedAt: input.state === "ambiguous" ? null : now,
          ambiguousAfter: input.state === "ambiguous" ? now : null,
          updatedAt: now
        }
      });
      if (updated.count !== 1) return { outcome: "lost" };
      return { outcome: "terminal", attempt: await tx.keywordResearchProviderAttempt.findUnique({ where: { id: attempt.id } }) };
    });
  }

  async terminalize(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const token = requireToken(input?.token);
    if (!TASK_TERMINAL.has(input?.state)) conflict();
    if (input?.artifactS3Key !== undefined && input.artifactS3Key !== null) requireNonempty(input.artifactS3Key);
    if (input?.artifactFingerprint != null) requireFingerprint(input.artifactFingerprint);
    return this.transaction(async (tx) => {
      const task = await tx.keywordResearchTask.findUnique({ where: { id: taskId } });
      if (!task) return { outcome: "not_found" };
      if (TASK_TERMINAL.has(task.state)) {
        const duplicateSame = task.state === input.state &&
          sameNullable(task.artifactS3Key, input.artifactS3Key ?? null) &&
          sameNullable(task.artifactFingerprint, input.artifactFingerprint ?? null) &&
          sameNullable(task.safeErrorCode, input.safeErrorCode ?? null);
        return duplicateSame ? { outcome: "found", task } : { outcome: "conflict" };
      }
      if (task.state !== "processing" || task.leaseToken !== token) return { outcome: "lost" };
      const updated = await tx.keywordResearchTask.updateMany({
        where: { id: taskId, state: "processing", leaseToken: token },
        data: {
          state: input.state, terminalAt: now,
          artifactS3Key: input.artifactS3Key ?? null,
          artifactFingerprint: input.artifactFingerprint ?? null,
          safeErrorCode: input.safeErrorCode ?? null,
          safeErrorMessage: input.safeErrorMessage ?? null,
          updatedAt: now
        }
      });
      if (updated.count !== 1) return { outcome: "lost" };
      const counter = input.state === "succeeded" ? "succeededCount"
        : input.state === "skipped" ? "skippedCount" : "failedCount";
      const stageRow = await tx.keywordResearchStage.findUnique({ where: { id: task.stageId } });
      await tx.keywordResearchStage.update({
        where: { id: task.stageId },
        data: { [counter]: { increment: 1 }, terminalCount: { increment: 1 }, updatedAt: now }
      });
      await tx.keywordResearchStage.updateMany({
        where: { id: task.stageId, state: "collecting", terminalCount: { gte: stageRow.expectedCount } },
        data: { state: "ready", updatedAt: now }
      });
      return { outcome: "terminal", task: await tx.keywordResearchTask.findUnique({ where: { id: taskId } }) };
    });
  }

  async claimAggregator(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const stageName = requireStage(input?.stage);
    const generation = requireGeneration(input?.generation ?? 1);
    const owner = requireNonempty(input?.owner);
    const token = requireToken(input?.token);
    return this.transaction(async (tx) => {
      const stageId = keywordStageId(researchId, stageName, generation);
      const stage = await tx.keywordResearchStage.findUnique({ where: { id: stageId } });
      if (!stage) return { outcome: "not_found" };
      if (stage.state === "completed" || stage.state === "failed") return { outcome: "conflict" };
      const leaseLive = stage.aggregationLeaseExpiresAt instanceof Date &&
        stage.aggregationLeaseExpiresAt.getTime() > now.getTime();
      if (leaseLive && stage.aggregationLeaseToken !== token) return { outcome: "lost" };
      const updated = await tx.keywordResearchStage.updateMany({
        where: { id: stageId, aggregationLeaseToken: stage.aggregationLeaseToken,
          state: { in: ["collecting", "ready", "aggregating"] } },
        data: {
          state: "aggregating", aggregationOwner: owner, aggregationLeaseToken: token,
          aggregationLeaseAcquiredAt: now,
          aggregationLeaseExpiresAt: plusMilliseconds(now, AGGREGATION_LEASE_MS),
          aggregationAttempt: { increment: 1 }, updatedAt: now
        }
      });
      if (updated.count !== 1) return { outcome: "lost" };
      return { outcome: "claimed", stage: await tx.keywordResearchStage.findUnique({ where: { id: stageId } }) };
    });
  }

  async manifestInTransaction(tx, input, now, stageNameOverride) {
    const researchId = requireResearchId(input?.researchId);
    const stageName = requireStage(stageNameOverride ?? input?.stage);
    const generation = requireGeneration(input?.generation ?? 1);
    const token = requireToken(input?.token);
    requireNonempty(input?.manifestS3Key);
    requireFingerprint(input?.manifestFingerprint);
    const stageId = keywordStageId(researchId, stageName, generation);
    const stage = await tx.keywordResearchStage.findUnique({ where: { id: stageId } });
    if (!stage) return { outcome: "not_found" };
    if (stage.state === "completed" || stage.state === "failed") return { outcome: "conflict" };
    if (stage.state !== "aggregating" || stage.aggregationLeaseToken !== token) return { outcome: "lost" };
    if (stage.manifestS3Key !== null) {
      const same = stage.manifestS3Key === input.manifestS3Key &&
        stage.manifestFingerprint === input.manifestFingerprint;
      return same ? { outcome: "found", stage } : { outcome: "conflict" };
    }
    const updated = await tx.keywordResearchStage.updateMany({
      where: { id: stageId, state: "aggregating", aggregationLeaseToken: token, manifestS3Key: null },
      data: {
        manifestS3Key: input.manifestS3Key, manifestFingerprint: input.manifestFingerprint,
        manifestProducedAt: now, updatedAt: now
      }
    });
    if (updated.count !== 1) return { outcome: "lost" };
    return { outcome: "terminal", stage: await tx.keywordResearchStage.findUnique({ where: { id: stageId } }) };
  }

  async stageCompletionInTransaction(tx, identity, now, nextStageName, nextStageTasks) {
    const researchId = requireResearchId(identity?.researchId);
    const stageName = requireStage(identity?.stage);
    const generation = requireGeneration(identity?.generation ?? 1);
    const token = requireToken(identity?.token);
    const stageId = keywordStageId(researchId, stageName, generation);
    const stage = await tx.keywordResearchStage.findUnique({ where: { id: stageId } });
    if (!stage) return { outcome: "not_found" };
    if (stage.state === "completed") {
      return stage.terminalCount === stage.expectedCount
        ? { outcome: "found", stage }
        : { outcome: "conflict" };
    }
    if (stage.state === "failed" || stage.state !== "aggregating" || stage.aggregationLeaseToken !== token) {
      return { outcome: "lost" };
    }
    if (stage.terminalCount !== stage.expectedCount) return { outcome: "conflict" };
    const updated = await tx.keywordResearchStage.updateMany({
      where: { id: stageId, state: "aggregating", aggregationLeaseToken: token },
      data: { state: "completed", completedAt: now, updatedAt: now }
    });
    if (updated.count !== 1) return { outcome: "lost" };
    if (nextStageTasks.length) {
      const derivedNext = stageName === "expansion" ? "anchor_screen"
        : stageName === "anchor_screen" ? "market_overview" : null;
      if (derivedNext !== nextStageName) return { outcome: "conflict" };
      const nextStageId = keywordStageId(researchId, nextStageName, generation);
      await tx.keywordResearchStage.createMany({ data: [{
        id: nextStageId, researchId, stage: nextStageName, generation,
        expectedCount: nextStageTasks.length, state: "collecting", createdAt: now, updatedAt: now
      }], skipDuplicates: true });
      await tx.keywordResearchTask.createMany({ data: nextStageTasks.map((task) => ({
        id: keywordTaskId(nextStageId, task.itemKey), stageId: nextStageId, itemKey: task.itemKey,
        inputFingerprint: task.inputFingerprint, endpointKey: task.endpointKey,
        requestFingerprint: task.requestFingerprint,
        nextAttemptAt: task.nextAttemptAt instanceof Date ? task.nextAttemptAt : null,
        createdAt: now, updatedAt: now
      })) });
    }
    return { outcome: "terminal", stage: await tx.keywordResearchStage.findUnique({ where: { id: stageId } }) };
  }

  async publishCandidateManifest(input, now) {
    requireNow(now);
    return this.transaction((tx) => this.manifestInTransaction(tx, input, now));
  }

  async publishShortlist(input, now) {
    requireNow(now);
    const marketTasks = input?.marketTasks === undefined ? [] : requireTaskInputs(input.marketTasks);
    return this.transaction(async (tx) => {
      const manifest = await this.manifestInTransaction(tx, input, now, "anchor_screen");
      if (manifest.outcome !== "terminal" && manifest.outcome !== "found") return manifest;
      const completion = await this.stageCompletionInTransaction(tx, {
        researchId: input.researchId, stage: "anchor_screen",
        generation: input?.generation ?? 1, token: input.token
      }, now, "market_overview", marketTasks);
      return completion;
    });
  }

  async publishStageCompletion(input, now) {
    requireNow(now);
    const nextStageTasks = input?.nextStageTasks === undefined ? [] : requireTaskInputs(input.nextStageTasks);
    return this.transaction((tx) => this.stageCompletionInTransaction(tx, input, now,
      input?.stage === "expansion" ? "anchor_screen"
        : input?.stage === "anchor_screen" ? "market_overview" : null,
      nextStageTasks));
  }

  async failStage(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const stageName = requireStage(input?.stage);
    const generation = requireGeneration(input?.generation ?? 1);
    const token = requireToken(input?.token);
    requireNonempty(input?.safeErrorCode ?? "KEYWORD_RESEARCH_STAGE_FAILED");
    return this.transaction(async (tx) => {
      const stageId = keywordStageId(researchId, stageName, generation);
      const updated = await tx.keywordResearchStage.updateMany({
        where: { id: stageId, state: "aggregating", aggregationLeaseToken: token },
        data: {
          state: "failed", safeErrorCode: input.safeErrorCode ?? "KEYWORD_RESEARCH_STAGE_FAILED",
          safeErrorMessage: input.safeErrorMessage ?? null, completedAt: now, updatedAt: now
        }
      });
      if (updated.count !== 1) return { outcome: "lost" };
      await tx.keywordResearch.updateMany({
        where: { id: researchId, state: "running" },
        data: { state: "failed", safeErrorCode: input.safeErrorCode ?? "KEYWORD_RESEARCH_STAGE_FAILED",
          safeErrorMessage: input.safeErrorMessage ?? null, completedAt: now, updatedAt: now }
      });
      return { outcome: "terminal" };
    });
  }

  async publishResearchResult(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    requireFingerprint(input?.resultFingerprint);
    if (input?.result === null || typeof input?.result !== "object") conflict();
    const serialized = JSON.stringify(input.result);
    if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
      return { outcome: "conflict", code: "KEYWORD_RESULT_TOO_LARGE" };
    }
    return this.transaction(async (tx) => {
      const research = await tx.keywordResearch.findUnique({ where: { id: researchId } });
      if (!research) return { outcome: "not_found" };
      if (research.state === "completed") {
        return research.resultFingerprint === input.resultFingerprint
          ? { outcome: "found", research }
          : { outcome: "conflict" };
      }
      if (research.state !== "running") return { outcome: "conflict" };
      const stages = await tx.keywordResearchStage.findMany({ where: { researchId, generation: research.generation } });
      const allCompleted = stages.length === 3 && stages.every((stage) => stage.state === "completed");
      if (!allCompleted) return { outcome: "conflict", code: "KEYWORD_STAGES_INCOMPLETE" };
      const updated = await tx.keywordResearch.updateMany({
        where: { id: researchId, state: "running" },
        data: {
          state: "completed", result: input.result, resultFingerprint: input.resultFingerprint,
          completedAt: now, updatedAt: now
        }
      });
      if (updated.count !== 1) return { outcome: "lost" };
      return { outcome: "terminal", research: await tx.keywordResearch.findUnique({ where: { id: researchId } }) };
    });
  }

  async saveSelection(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const ownerId = requireOwner(input?.ownerId);
    if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision < 0) conflict();
    if (!Array.isArray(input?.items) || input.items.length > MAX_SELECTION_ITEMS) conflict();
    for (const item of input.items) requireSelectionItemId(item?.itemId);
    return this.transaction(async (tx) => {
      const research = await tx.keywordResearch.findUnique({ where: { id: researchId } });
      if (!research || research.ownerId !== ownerId) return { outcome: "not_found" };
      if (research.state !== "completed") return { outcome: "conflict" };
      if (research.selectionRevision !== input.expectedRevision) {
        return { outcome: "conflict", code: "KEYWORD_SELECTION_REVISION_CONFLICT" };
      }
      const updated = await tx.keywordResearch.updateMany({
        where: { id: researchId, selectionRevision: input.expectedRevision, state: "completed" },
        data: { selection: { items: input.items }, selectionRevision: input.expectedRevision + 1, updatedAt: now }
      });
      if (updated.count !== 1) {
        return { outcome: "conflict", code: "KEYWORD_SELECTION_REVISION_CONFLICT" };
      }
      return { outcome: "created", selectionRevision: input.expectedRevision + 1 };
    });
  }

  async createRun(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const ownerId = requireOwner(input?.ownerId);
    if (!Number.isInteger(input?.expectedSelectionRevision) || input.expectedSelectionRevision < 1) conflict();
    if (typeof input?.clientRequestId !== "string" || !CLIENT_REQUEST_ID.test(input.clientRequestId)) conflict();
    requireFingerprint(input?.selectionFingerprint);
    if (!Array.isArray(input?.items) || input.items.length < 1 || input.items.length > MAX_HANDOFF_ITEMS) conflict();
    for (const item of input.items) {
      requireSelectionItemId(item?.itemId);
      requireNonempty(item?.keyword);
    }
    if (typeof input?.constructRun !== "function" || typeof input?.constructQueries !== "function") conflict();
    return this.transaction(async (tx) => {
      const research = await tx.keywordResearch.findUnique({ where: { id: researchId } });
      if (!research || research.ownerId !== ownerId) return { outcome: "not_found" };
      const existingHandoff = await tx.keywordResearchHandoff.findUnique({
        where: { researchId_clientRequestId: { researchId, clientRequestId: input.clientRequestId } }
      });
      if (existingHandoff) {
        if (existingHandoff.selectionFingerprint !== input.selectionFingerprint ||
            existingHandoff.selectionRevision !== input.expectedSelectionRevision) {
          return { outcome: "conflict" };
        }
        const run = await tx.run.findUnique({ where: { id: existingHandoff.runId } });
        return run ? { outcome: "found", run } : { outcome: "conflict" };
      }
      if (research.state !== "completed") return { outcome: "conflict", code: "KEYWORD_RESEARCH_NOT_COMPLETED" };
      if (research.selectionRevision !== input.expectedSelectionRevision) {
        return { outcome: "conflict", code: "KEYWORD_SELECTION_REVISION_CONFLICT" };
      }
      const runId = requireRunId(input?.runId);
      const run = await input.constructRun(tx, { research, runId, now, items: input.items });
      if (!run || run.id !== runId || run.keywordResearchId !== researchId ||
          run.queryPlanSource !== "keyword_research") {
        return { outcome: "conflict", code: "KEYWORD_RUN_HANDOFF_INVALID" };
      }
      const queries = await input.constructQueries(tx, { run, items: input.items, now });
      if (!Array.isArray(queries) || queries.length !== input.items.length ||
          queries.some((query) => query?.runId !== runId)) {
        return { outcome: "conflict", code: "KEYWORD_RUN_HANDOFF_INVALID" };
      }
      await tx.keywordResearchHandoff.create({ data: {
        id: derivedId("krh_", [researchId, input.expectedSelectionRevision, input.clientRequestId]),
        researchId, selectionRevision: input.expectedSelectionRevision,
        clientRequestId: input.clientRequestId, selectionFingerprint: input.selectionFingerprint,
        runId, createdAt: now
      } });
      return { outcome: "created", run };
    });
  }

  async recover(now) {
    requireNow(now);
    return this.transaction(async (tx) => {
      const tasks = await tx.$queryRaw`
        SELECT t."id"::text AS "taskId", t."state"::text AS "state", t."stageId"::text AS "stageId"
        FROM "KeywordResearchTask" AS t
        WHERE (t."state" = 'processing' AND t."leaseExpiresAt" IS NOT NULL AND t."leaseExpiresAt" < ${now})
           OR (t."state" = 'pending' AND (t."nextAttemptAt" IS NULL OR t."nextAttemptAt" <= ${now}))`;
      const stages = await tx.$queryRaw`
        SELECT s."id"::text AS "stageId", s."researchId"::text AS "researchId",
               s."stage"::text AS "stage", s."generation" AS "generation"
        FROM "KeywordResearchStage" AS s
        WHERE s."state" = 'aggregating' AND s."aggregationLeaseExpiresAt" IS NOT NULL
          AND s."aggregationLeaseExpiresAt" < ${now}`;
      return {
        outcome: "found",
        taskDispatches: tasks.map((task) => ({ taskId: task.taskId, kind: "task" })),
        aggregateChecks: stages.map((stage) => ({
          researchId: stage.researchId, stage: stage.stage, generation: stage.generation, kind: "aggregate_check"
        }))
      };
    });
  }

  async cacheRead(input, now) {
    requireNow(now);
    requireFingerprint(input?.requestFingerprint);
    const cached = await this.client.keywordResearchCache.findUnique({
      where: { requestFingerprint: input.requestFingerprint }
    });
    if (!cached || cached.expiresAt.getTime() <= now.getTime()) return { outcome: "not_found" };
    return { outcome: "found", cache: cached };
  }

  async cacheWrite(input, now) {
    requireNow(now);
    requireFingerprint(input?.requestFingerprint);
    requireNonempty(input?.cacheKey);
    if (!["keyword_suggestions", "related_keywords", "keyword_overview"].includes(input?.endpointKey)) conflict();
    requireFingerprint(input?.resultFingerprint);
    if (input?.normalizedResponse === null || typeof input.normalizedResponse !== "object") conflict();
    if (!Number.isInteger(input?.ttlSeconds ?? CACHE_TTL_SECONDS) || input.ttlSeconds < 1) conflict();
    const ttl = input.ttlSeconds ?? CACHE_TTL_SECONDS;
    const existing = await this.client.keywordResearchCache.findUnique({
      where: { requestFingerprint: input.requestFingerprint }
    });
    if (existing) {
      const same = existing.cacheKey === input.cacheKey && existing.endpointKey === input.endpointKey &&
        existing.resultFingerprint === input.resultFingerprint;
      return same ? { outcome: "found", cache: existing } : { outcome: "conflict" };
    }
    const cache = await this.client.keywordResearchCache.create({ data: {
      requestFingerprint: input.requestFingerprint, cacheKey: input.cacheKey,
      endpointKey: input.endpointKey, contractVersion: 1,
      normalizedResponse: input.normalizedResponse, resultFingerprint: input.resultFingerprint,
      createdAt: now, expiresAt: plusMilliseconds(now, ttl * 1000)
    } });
    return { outcome: "created", cache };
  }

  async claimThrottle(input) {
    const provider = input?.provider ?? "dataforseo_labs_keyword";
    requireNonempty(provider);
    const minGapMs = input?.minGapMs ?? THROTTLE_MIN_GAP_MS;
    if (!Number.isInteger(minGapMs) || minGapMs < THROTTLE_MIN_GAP_MS) conflict();
    return this.transaction(async (tx) => {
      const claimed = await tx.$queryRaw`
        UPDATE "KeywordProviderThrottle"
        SET "nextAllowedAt" = now() + make_interval(secs => ${minGapMs / 1000}::float8), "updatedAt" = now()
        WHERE "provider" = ${provider} AND "nextAllowedAt" <= now()
        RETURNING "nextAllowedAt"`;
      if (claimed.length === 1) return { outcome: "claimed", nextAllowedAt: claimed[0].nextAllowedAt };
      const inserted = await tx.$queryRaw`
        INSERT INTO "KeywordProviderThrottle" ("provider", "nextAllowedAt", "updatedAt")
        VALUES (${provider}, now() + make_interval(secs => ${minGapMs / 1000}::float8), now())
        ON CONFLICT ("provider") DO NOTHING
        RETURNING "nextAllowedAt"`;
      if (inserted.length === 1) return { outcome: "claimed", nextAllowedAt: inserted[0].nextAllowedAt };
      const [existing] = await tx.$queryRaw`
        SELECT "nextAllowedAt" FROM "KeywordProviderThrottle" WHERE "provider" = ${provider}`;
      return { outcome: "delayed", retryAt: existing?.nextAllowedAt ?? new Date() };
    });
  }
}
