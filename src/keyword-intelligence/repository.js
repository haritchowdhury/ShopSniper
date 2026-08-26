import { createHash, randomBytes } from "node:crypto";
import { blake2s } from "@noble/hashes/blake2.js";
import { prismaSchemaForClient } from "../prisma-client.js";
import { createDefaultSelection, normalizeSeeds } from "./selection.js";

const RESEARCH_ID = /^kr_[A-Za-z0-9_-]{24}$/u;
const KEYWORD_RESEARCH_INTENT_ID = /^intent_[A-Za-z0-9_-]{32}$/u;
const RUN_ID = /^run_[A-Za-z0-9_-]{16,80}$/u;
const ITEM_KEY = /^[A-Za-z0-9_.:-]{1,128}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32}$/u;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/u;
const STAGES = new Set(["expansion", "anchor_screen", "market_overview"]);
const TASK_TERMINAL = new Set(["succeeded", "skipped", "failed"]);
const ATTEMPT_TERMINAL = new Set(["succeeded", "failed", "ambiguous"]);
const ATTEMPT_NONTERMINAL = new Set(["planned", "in_flight"]);
const ENDPOINT_KEYS = new Set(["keyword_suggestions", "related_keywords", "keyword_overview"]);
const TASK_LEASE_MS = 60_000;
const AGGREGATION_LEASE_MS = 120_000;
const SHORT_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 5_000, timeout: 15_000 });
const SCALE_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 5_000, timeout: 30_000 });
const THROTTLE_MIN_GAP_MS = 2_000;
const CACHE_TTL_SECONDS = 604_800;
const MAX_RESULT_BYTES = 33_554_432;
const MAX_SELECTION_ITEMS = 200;
const MAX_DEFAULT_ITEMS = 100;
const MAX_HANDOFF_ITEMS = 100;
const MAX_ATTEMPTS = 5;
const DECIMAL_8 = /^\d+\.\d{8}$/u;
const MARKET_TASK_KEYS = ["GB:0", "CA:0", "AU:0", "NZ:0", "DE:0", "FR:0", "IN:0", "AE:0"];
const CODE_AMBIGUOUS = "KEYWORD_PROVIDER_AMBIGUOUS";
const CODE_THROTTLED = "KEYWORD_PROVIDER_THROTTLED";
const CODE_BUDGET_EXHAUSTED = "KEYWORD_PROVIDER_BUDGET_EXHAUSTED";
const CODE_RETRY_NOT_SCHEDULED = "KEYWORD_PROVIDER_RETRY_NOT_SCHEDULED";
const CODE_RESULT_TOO_LARGE = "KEYWORD_RESULT_TOO_LARGE";
const KEYWORD_RESEARCH_INTENT_TTL_MS = 3_600_000;

export class KeywordRepositoryError extends Error {
  constructor(code = "KEYWORD_INPUT_CONFLICT") {
    super(code);
    this.name = "KeywordRepositoryError";
    this.code = code;
  }
}

class FinalPublicationAbort extends Error {
  constructor(mapping) {
    super(mapping);
    this.name = "FinalPublicationAbort";
    this.mapping = mapping;
  }
}

class RunHandoffAbort extends Error {}

class ClaimIntentAbort extends Error {}

function conflict(code = "KEYWORD_INPUT_CONFLICT") {
  throw new KeywordRepositoryError(code);
}

function requireResearchId(value) {
  if (typeof value !== "string" || !RESEARCH_ID.test(value)) conflict();
  return value;
}

function requireKeywordResearchIntentId(value) {
  if (typeof value !== "string" || !KEYWORD_RESEARCH_INTENT_ID.test(value)) conflict();
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

function requireNormalizedSeeds(value) {
  const normalized = normalizeSeeds(value);
  if (!normalized.ok || normalized.seeds.length !== value.length ||
      normalized.seeds.some((seed, index) => seed !== value[index])) conflict();
  return normalized.seeds;
}

function requireStage(value) {
  if (!STAGES.has(value)) conflict();
  return value;
}

function requireGeneration(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) conflict();
  return value;
}

function requirePage(value, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) conflict();
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

function requireSafeErrorCode(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) conflict();
  return value;
}

function requireAttemptNumber(value) {
  if (!Number.isInteger(value) || value < 1) conflict();
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

export function newKeywordResearchIntentId() {
  return `intent_${randomBytes(24).toString("base64url")}`;
}

export function newLeaseToken() {
  return randomBytes(24).toString("base64url");
}

export function selectionItemId(sourceKind, originalNormalizedKeyword) {
  if (sourceKind !== "calculated" && sourceKind !== "manual") conflict();
  if (typeof originalNormalizedKeyword !== "string" || originalNormalizedKeyword.length === 0 ||
      [...originalNormalizedKeyword].length > 160) conflict();
  const digest = blake2s(new TextEncoder().encode(`${sourceKind}\n${originalNormalizedKeyword}`), { dkLen: 6 });
  return `ksi_${Buffer.from(digest).toString("hex")}`;
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
  requireAttemptNumber(attemptNumber);
  return derivedId("kra_", [taskId, attemptNumber]);
}

function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) conflict();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function stageInputFingerprint({ researchId, generation, stage, tasks }) {
  const ordered = [...tasks].sort((left, right) => left.itemKey.localeCompare(right.itemKey));
  const payload = {
    researchId,
    generation,
    stage,
    tasks: ordered.map((task) => ({
      itemKey: task.itemKey,
      inputFingerprint: task.inputFingerprint,
      endpointKey: task.endpointKey,
      requestFingerprint: task.requestFingerprint
    }))
  };
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function moneyString(value) {
  if (value === null || value === undefined) return null;
  return Number(value).toFixed(8);
}

function serializeMoney(value) {
  if (value === null || value === undefined) return null;
  return Number(value).toFixed(8);
}

function normalizeUsdInput(value) {
  if (value === null || value === undefined) return null;
  return Number(requireDecimalUsd(value)).toFixed(8);
}

function taskRegistrationMatches(task, expected) {
  return task.itemKey === expected.itemKey && task.inputFingerprint === expected.inputFingerprint &&
    task.endpointKey === expected.endpointKey && task.requestFingerprint === expected.requestFingerprint;
}

function sameNullable(left, right) {
  return (left ?? null) === (right ?? null);
}

function workerResearch(row) {
  return {
    id: row.id, state: row.state, generation: row.generation, contractVersion: row.contractVersion,
    configSnapshot: row.configSnapshot, configFingerprint: row.configFingerprint,
    seeds: row.seeds, markets: row.markets
  };
}

function workerStage(row) {
  return {
    id: row.id, researchId: row.researchId, stage: row.stage, generation: row.generation,
    state: row.state, expectedCount: row.expectedCount, terminalCount: row.terminalCount,
    succeededCount: row.succeededCount, skippedCount: row.skippedCount, failedCount: row.failedCount,
    manifestS3Key: row.manifestS3Key ?? null, manifestFingerprint: row.manifestFingerprint ?? null,
    manifestProducedAt: row.manifestProducedAt ?? null, createdAt: row.createdAt
  };
}

function workerTask(row) {
  return {
    id: row.id, stageId: row.stageId, itemKey: row.itemKey, inputFingerprint: row.inputFingerprint,
    endpointKey: row.endpointKey, requestFingerprint: row.requestFingerprint,
    nextAttemptAt: row.nextAttemptAt ?? null, state: row.state, attemptCount: row.attemptCount,
    leaseToken: row.leaseToken ?? null, leaseExpiresAt: row.leaseExpiresAt ?? null,
    createdAt: row.createdAt, artifactS3Key: row.artifactS3Key ?? null,
    artifactFingerprint: row.artifactFingerprint ?? null, terminalAt: row.terminalAt ?? null,
    safeErrorCode: row.safeErrorCode ?? null
  };
}

function workerAttempt(row) {
  return {
    attemptNumber: row.attemptNumber, state: row.state, requestFingerprint: row.requestFingerprint,
    reservationCostUsd: moneyString(row.reservationCostUsd), providerCostUsd: moneyString(row.providerCostUsd),
    safeErrorCode: row.safeErrorCode ?? null, resultFingerprint: row.resultFingerprint ?? null,
    plannedAt: row.plannedAt, completedAt: row.completedAt ?? null, ambiguousAfter: row.ambiguousAfter ?? null
  };
}

function requireTaskShapes(tasks) {
  if (!Array.isArray(tasks)) return false;
  for (const task of tasks) {
    if (!ITEM_KEY.test(task?.itemKey)) return false;
    if (!FINGERPRINT.test(task?.inputFingerprint)) return false;
    if (!ENDPOINT_KEYS.has(task?.endpointKey)) return false;
    if (!FINGERPRINT.test(task?.requestFingerprint)) return false;
    if (task?.nextAttemptAt !== undefined && task.nextAttemptAt !== null &&
        !(task.nextAttemptAt instanceof Date)) return false;
  }
  return true;
}

function requireUniqueTaskKeys(tasks) {
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.itemKey)) return false;
    seen.add(task.itemKey);
  }
  return true;
}

function sameTaskSet(persisted, expected) {
  if (!Array.isArray(persisted) || !Array.isArray(expected)) return false;
  if (persisted.length !== expected.length) return false;
  const expectedByItemKey = new Map(expected.map((task) => [task.itemKey, task]));
  return persisted.every((task) => {
    const wanted = expectedByItemKey.get(task.itemKey);
    return Boolean(wanted) && taskRegistrationMatches(task, wanted);
  });
}

function validSelectionItem(item) {
  return Boolean(item) && typeof item === "object" &&
    typeof item.itemId === "string" && /^ksi_[a-f0-9]{12}$/u.test(item.itemId) &&
    (item.sourceKind === "calculated" || item.sourceKind === "manual") &&
    typeof item.keyword === "string" && [...item.keyword].length <= 160 &&
    Array.isArray(item.sourceSeeds) &&
    typeof item.lane === "string" &&
    item.facets !== null && typeof item.facets === "object" &&
    (item.metricsSnapshot === null || (item.metricsSnapshot && typeof item.metricsSnapshot === "object"));
}

function retryDelaySeconds(taskId, attemptNumber) {
  const baseDelay = Math.min(60, 2 * 2 ** (attemptNumber - 1));
  const digest = createHash("sha256").update(`${taskId}:${attemptNumber}`, "utf8").digest("hex");
  const first8Hex = digest.slice(0, 8);
  const mod = Number.parseInt(first8Hex, 16) % 2501;
  const jitter = baseDelay * (mod / 10000);
  return Math.ceil(baseDelay + jitter);
}

function compareUnsignedUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareTaskRowsByUnsignedItemKey(left, right) {
  return compareUnsignedUtf8(left.itemKey, right.itemKey);
}

export class PrismaKeywordResearchRepository {
  constructor(client) {
    this.client = client;
    this.schema = prismaSchemaForClient(client);
  }

  async _transaction(work, options) {
    const callback = async (tx) => {
      if (this.schema && this.schema !== "public") {
        await tx.$queryRaw`SELECT set_config('search_path', ${this.schema}, true)`;
      }
      return work(tx);
    };
    return this.client.$transaction(callback, options);
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

  async createIntent(input, now) {
    requireNow(now);
    const intentId = requireKeywordResearchIntentId(input?.intentId);
    const seeds = requireNormalizedSeeds(input?.seeds);
    const expiresAt = requireNow(input?.expiresAt);
    if (expiresAt.getTime() !== now.getTime() + KEYWORD_RESEARCH_INTENT_TTL_MS) conflict();

    const existing = await this.client.keywordResearchIntent.findUnique({ where: { id: intentId } });
    if (existing) return { outcome: "conflict" };

    try {
      const intent = await this.client.keywordResearchIntent.create({ data: {
        id: intentId,
        seeds,
        createdAt: now,
        expiresAt
      } });
      return { outcome: "created", intent };
    } catch (error) {
      if (error?.code === "P2002") return { outcome: "conflict" };
      throw error;
    }
  }

  async claimIntent(input, now) {
    requireNow(now);
    const intentId = requireKeywordResearchIntentId(input?.intentId);
    const ownerId = requireOwner(input?.ownerId);
    const researchId = requireResearchId(input?.researchId);
    requireFingerprint(input?.configFingerprint);
    if (input?.configSnapshot === null || typeof input?.configSnapshot !== "object") conflict();
    if (!Array.isArray(input?.markets) || input.markets.length !== 9) conflict();

    try {
      return await this._transaction(async (tx) => {
        const intent = await tx.keywordResearchIntent.findUnique({ where: { id: intentId } });
        if (!intent) return { outcome: "not_found" };

        if (intent.claimedResearchId !== null) {
          if (intent.claimedByUserId !== ownerId) return { outcome: "not_found" };
          const research = await tx.keywordResearch.findUnique({ where: { id: intent.claimedResearchId } });
          if (!research || research.ownerId !== ownerId) return { outcome: "conflict" };
          return { outcome: "found", research };
        }
        if (intent.expiresAt.getTime() <= now.getTime()) return { outcome: "not_found" };

        const seeds = requireNormalizedSeeds(intent.seeds);
        const research = await tx.keywordResearch.create({ data: {
          id: researchId,
          ownerId,
          state: "queued",
          generation: 1,
          contractVersion: 1,
          configSnapshot: input.configSnapshot,
          configFingerprint: input.configFingerprint,
          seeds,
          markets: input.markets,
          progress: { stages: {} },
          selectionRevision: 0,
          createdAt: now
        } });

        const claimed = await tx.keywordResearchIntent.updateMany({
          where: {
            id: intentId,
            claimedResearchId: null,
            claimedByUserId: null,
            claimedAt: null,
            expiresAt: { gt: now }
          },
          data: {
            claimedAt: now,
            claimedByUserId: ownerId,
            claimedResearchId: researchId,
            seeds: []
          }
        });

        if (claimed.count === 1) return { outcome: "created", research };
        if (claimed.count !== 0) throw new ClaimIntentAbort();

        await tx.keywordResearch.delete({ where: { id: researchId } });
        const current = await tx.keywordResearchIntent.findUnique({ where: { id: intentId } });
        if (!current || current.expiresAt.getTime() <= now.getTime()) return { outcome: "not_found" };
        if (current.claimedResearchId !== null) {
          if (current.claimedByUserId !== ownerId) return { outcome: "not_found" };
          const found = await tx.keywordResearch.findUnique({ where: { id: current.claimedResearchId } });
          if (!found || found.ownerId !== ownerId) return { outcome: "conflict" };
          return { outcome: "found", research: found };
        }
        return { outcome: "conflict" };
      }, SHORT_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof ClaimIntentAbort || error?.code === "P2002") {
        return { outcome: "conflict" };
      }
      throw error;
    }
  }

  async deleteExpiredIntents(now) {
    requireNow(now);
    return this.client.keywordResearchIntent.deleteMany({ where: {
      expiresAt: { lte: now },
      claimedAt: null,
      claimedByUserId: null,
      claimedResearchId: null
    } });
  }

  async getOwned(input) {
    const researchId = requireResearchId(input?.researchId);
    const ownerId = requireOwner(input?.ownerId);
    const research = await this.client.keywordResearch.findUnique({ where: { id: researchId } });
    if (!research || research.ownerId !== ownerId) return { outcome: "not_found" };
    return { outcome: "found", research };
  }

  async getOwnedApiView(input) {
    const researchId = requireResearchId(input?.researchId);
    const ownerId = requireOwner(input?.ownerId);
    const research = await this.client.keywordResearch.findFirst({
      where: { id: researchId, ownerId },
      include: { stages: { orderBy: [{ stage: "asc" }, { generation: "asc" }] } }
    });
    if (!research) return { outcome: "not_found" };
    return { outcome: "found", research };
  }

  async listOwnerWorkspaceResearch(input) {
    const ownerId = requireOwner(input?.ownerId);
    const page = requirePage(input?.page);
    const pageSize = requirePage(input?.pageSize, 100);
    const where = { ownerId, runs: { none: {} } };
    return this._transaction(async (tx) => {
      const totalItems = await tx.keywordResearch.count({ where });
      const items = await tx.keywordResearch.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          seeds: true,
          state: true,
          selectionRevision: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          stages: {
            orderBy: [{ stage: "asc" }, { generation: "asc" }],
            select: { stage: true, state: true, generation: true }
          }
        }
      });
      return { totalItems, items };
    }, SHORT_TRANSACTION_OPTIONS);
  }

  async getWorkerResearch(input) {
    const researchId = requireResearchId(input?.researchId);
    const generation = requireGeneration(input?.generation ?? 1);
    const research = await this.client.keywordResearch.findUnique({ where: { id: researchId } });
    if (!research) return { outcome: "not_found" };
    if (research.generation !== generation) return { outcome: "conflict" };
    return { outcome: "found", research: workerResearch(research) };
  }

  async getTaskContext(input) {
    const taskId = requireNonempty(input?.taskId);
    const task = await this.client.keywordResearchTask.findUnique({
      where: { id: taskId },
      include: {
        stage: { include: { research: true } },
        attempts: { orderBy: { attemptNumber: "desc" }, take: 1 }
      }
    });
    if (!task || !task.stage || !task.stage.research) return { outcome: "not_found" };
    const latestAttempt = task.attempts[0] ?? null;
    return {
      outcome: "found",
      research: workerResearch(task.stage.research),
      stage: workerStage(task.stage),
      task: workerTask(task),
      latestAttempt: latestAttempt ? workerAttempt(latestAttempt) : null
    };
  }

  async getStageContext(input) {
    const researchId = requireResearchId(input?.researchId);
    const stageName = requireStage(input?.stage);
    const generation = requireGeneration(input?.generation ?? 1);
    const stageId = keywordStageId(researchId, stageName, generation);
    const stage = await this.client.keywordResearchStage.findUnique({
      where: { id: stageId },
      include: { research: true, tasks: { orderBy: { itemKey: "asc" } } }
    });
    if (!stage) return { outcome: "not_found" };
    if (stage.stage !== stageName) return { outcome: "conflict" };
    if (!stage.research) return { outcome: "not_found" };
    if (stage.research.generation !== generation) return { outcome: "conflict" };
    return {
      outcome: "found",
      research: workerResearch(stage.research),
      stage: workerStage(stage),
      tasks: stage.tasks.map(workerTask)
    };
  }

  async initialize(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const generation = requireGeneration(input?.generation ?? 1);
    if (input?.stage !== "expansion") conflict();
    if (!Array.isArray(input?.tasks) || !requireTaskShapes(input.tasks) || !requireUniqueTaskKeys(input.tasks)) {
      conflict();
    }
    const tasks = [...input.tasks];
    return this._transaction(async (tx) => {
      const research = await tx.keywordResearch.findUnique({ where: { id: researchId } });
      if (!research) return { outcome: "not_found" };
      if (research.generation !== generation) return { outcome: "conflict" };
      if (research.state !== "queued" && research.state !== "running") return { outcome: "conflict" };
      if (!Array.isArray(research.seeds) || research.seeds.length < 1) return { outcome: "conflict" };
      const expectedKeys = new Set();
      for (let index = 0; index < research.seeds.length; index += 1) {
        expectedKeys.add(`${index}:suggestions`);
        expectedKeys.add(`${index}:related`);
      }
      if (tasks.length !== expectedKeys.size ||
          tasks.some((task) => !expectedKeys.has(task.itemKey))) {
        return { outcome: "conflict" };
      }
      const stageId = keywordStageId(researchId, "expansion", generation);
      const existingStage = await tx.keywordResearchStage.findUnique({
        where: { id: stageId },
        include: { tasks: { orderBy: { itemKey: "asc" } } }
      });
      if (existingStage) {
        if (existingStage.expectedCount !== tasks.length) return { outcome: "conflict" };
        if (!sameTaskSet(existingStage.tasks, tasks)) return { outcome: "conflict" };
        return { outcome: "found", stage: workerStage(existingStage), tasks: existingStage.tasks.map(workerTask) };
      }
      if (research.state === "queued") {
        await tx.keywordResearch.update({ where: { id: researchId }, data: { state: "running", startedAt: now } });
      }
      const stage = await tx.keywordResearchStage.create({ data: {
        id: stageId, researchId, stage: "expansion", generation,
        expectedCount: tasks.length, state: tasks.length === 0 ? "ready" : "collecting",
        createdAt: now, updatedAt: now
      } });
      const stored = await tx.keywordResearchTask.createManyAndReturn({ data: tasks.map((task) => ({
        id: keywordTaskId(stageId, task.itemKey), stageId, itemKey: task.itemKey,
        inputFingerprint: task.inputFingerprint, endpointKey: task.endpointKey,
        requestFingerprint: task.requestFingerprint,
        nextAttemptAt: task.nextAttemptAt instanceof Date ? task.nextAttemptAt : null,
        createdAt: now, updatedAt: now
      })) });
      stored.sort(compareTaskRowsByUnsignedItemKey);
      return { outcome: "created", stage: workerStage(stage), tasks: stored.map(workerTask) };
    }, SCALE_TRANSACTION_OPTIONS);
  }

  async claim(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const owner = requireNonempty(input?.owner);
    const token = requireToken(input?.token);
    return this._transaction(async (tx) => {
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
      const updated = await tx.keywordResearchTask.updateManyAndReturn({
        where: { id: taskId, state: task.state, leaseToken: task.leaseToken },
        data: {
          state: "processing", leaseOwner: owner, leaseToken: token,
          leaseAcquiredAt: now, leaseExpiresAt: plusMilliseconds(now, TASK_LEASE_MS),
          leaseAttempt: { increment: 1 }, dispatchCount: { increment: 1 }, lastDispatchedAt: now,
          updatedAt: now
        }
      });
      if (updated.length !== 1) return { outcome: "lost" };
      return { outcome: "claimed", task: workerTask(updated[0]) };
    }, SHORT_TRANSACTION_OPTIONS);
  }

  async heartbeat(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const token = requireToken(input?.token);
    const leaseExpiresAt = plusMilliseconds(now, TASK_LEASE_MS);
    const updated = await this.client.keywordResearchTask.updateMany({
      where: {
        id: taskId,
        state: "processing",
        leaseToken: token,
        leaseExpiresAt: { gt: now }
      },
      data: { leaseExpiresAt, updatedAt: now }
    });
    return updated.count === 1
      ? { outcome: "claimed", leaseExpiresAt }
      : { outcome: "lost" };
  }

  async recordAttempt(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const token = requireToken(input?.token);
    const requestFingerprint = requireFingerprint(input?.requestFingerprint);
    const reservationCostUsd = normalizeUsdInput(requireDecimalUsd(input?.reservationCostUsd));
    const maxCostPerResearchUsd = normalizeUsdInput(requireDecimalUsd(input?.maxCostPerResearchUsd));
    return this._transaction(async (tx) => {
      const task = await tx.keywordResearchTask.findUnique({
        where: { id: taskId },
        include: {
          stage: true,
          attempts: { orderBy: { attemptNumber: "desc" }, take: 1 }
        }
      });
      if (!task) return { outcome: "not_found" };
      if (task.state === "processing" && task.leaseToken !== token) return { outcome: "lost" };
      if (task.state !== "processing") return { outcome: "lost" };
      if (task.leaseExpiresAt instanceof Date && task.leaseExpiresAt.getTime() <= now.getTime()) {
        return { outcome: "lost" };
      }
      if (task.requestFingerprint !== requestFingerprint) return { outcome: "conflict" };
      const latest = task.attempts[0] ?? null;
      if (latest && !ATTEMPT_TERMINAL.has(latest.state)) {
        if (latest.requestFingerprint === requestFingerprint &&
            serializeMoney(latest.reservationCostUsd) === reservationCostUsd) {
          return { outcome: "found", attempt: workerAttempt(latest), mayCall: false };
        }
        return { outcome: "conflict" };
      }
      if (latest && latest.state === "ambiguous") {
        if (latest.requestFingerprint === requestFingerprint &&
            serializeMoney(latest.reservationCostUsd) === reservationCostUsd) {
          return { outcome: "found", attempt: workerAttempt(latest), mayCall: false };
        }
        return { outcome: "conflict" };
      }
      if (latest && latest.state === "succeeded") return { outcome: "conflict" };
      const attemptNumber = task.attemptCount + 1;
      if (attemptNumber < 1 || attemptNumber > MAX_ATTEMPTS) {
        return { outcome: "conflict", code: "KEYWORD_PROVIDER_RETRY_EXHAUSTED" };
      }
      if (latest && latest.state === "failed") {
        if (task.nextAttemptAt === null) {
          return { outcome: "conflict", code: CODE_RETRY_NOT_SCHEDULED };
        }
      }
      const stage = task.stage;
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
        return { outcome: "conflict", code: CODE_BUDGET_EXHAUSTED };
      }
      const attempt = await tx.keywordResearchProviderAttempt.create({ data: {
        id: keywordAttemptId(taskId, attemptNumber), taskId, attemptNumber,
        state: "planned", requestFingerprint,
        reservationCostUsd, plannedAt: now, createdAt: now, updatedAt: now
      } });
      const dueNextAttemptAt = task.nextAttemptAt instanceof Date && task.nextAttemptAt.getTime() <= now.getTime()
        ? null
        : task.nextAttemptAt;
      await tx.keywordResearchTask.update({
        where: { id: taskId },
        data: { attemptCount: attemptNumber, nextAttemptAt: dueNextAttemptAt, updatedAt: now }
      });
      return { outcome: "created", attempt: workerAttempt(attempt), mayCall: true };
    }, SCALE_TRANSACTION_OPTIONS);
  }

  async settleAttempt(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const token = requireToken(input?.token);
    const attemptNumber = requireAttemptNumber(input?.attemptNumber);
    if (input?.state !== "succeeded" && input?.state !== "failed") conflict();
    const providerCostUsd = normalizeUsdInput(requireDecimalUsd(input?.providerCostUsd));
    const safeErrorCode = input?.safeErrorCode === undefined || input.safeErrorCode === null
      ? null
      : requireSafeErrorCode(input.safeErrorCode);
    const resultFingerprint = input?.resultFingerprint === undefined || input.resultFingerprint === null
      ? null
      : requireFingerprint(input.resultFingerprint);
    if (input.state === "succeeded" && input?.cacheEntry === null) conflict();
    if (input.state === "failed" && input?.cacheEntry !== null && input?.cacheEntry !== undefined) conflict();
    const cacheEntry = input.state === "succeeded" ? input.cacheEntry : null;
    if (cacheEntry) {
      requireNonempty(cacheEntry.cacheKey);
      if (!ENDPOINT_KEYS.has(cacheEntry.endpointKey)) conflict();
      if (cacheEntry.contractVersion !== 1) conflict();
      if (cacheEntry.normalizedResponse === null || typeof cacheEntry.normalizedResponse !== "object") conflict();
      requireFingerprint(cacheEntry.resultFingerprint);
      if (cacheEntry.ttlSeconds !== CACHE_TTL_SECONDS) conflict();
    }
    return this._transaction(async (tx) => {
      const attempt = await tx.keywordResearchProviderAttempt.findUnique({
        where: { taskId_attemptNumber: { taskId, attemptNumber } },
        include: { task: true }
      });
      if (!attempt) return { outcome: "not_found" };
      const task = attempt.task;
      if (!task) return { outcome: "not_found" };
      if (task.attemptCount !== attemptNumber) return { outcome: "conflict" };
      if (ATTEMPT_TERMINAL.has(attempt.state)) {
        const sameSettle = attempt.state === input.state &&
          serializeMoney(attempt.providerCostUsd) === providerCostUsd &&
          sameNullable(attempt.safeErrorCode, safeErrorCode) &&
          sameNullable(attempt.resultFingerprint, resultFingerprint);
        if (!sameSettle) return { outcome: "conflict" };
        if (input.state === "succeeded") {
          const cacheRow = await tx.keywordResearchCache.findUnique({
            where: { requestFingerprint: attempt.requestFingerprint }
          });
          if (!cacheRow || cacheRow.cacheKey !== cacheEntry.cacheKey ||
              cacheRow.endpointKey !== cacheEntry.endpointKey ||
              cacheRow.contractVersion !== cacheEntry.contractVersion ||
              cacheRow.resultFingerprint !== cacheEntry.resultFingerprint ||
              canonicalJson(cacheRow.normalizedResponse) !== canonicalJson(cacheEntry.normalizedResponse)) {
            return { outcome: "conflict" };
          }
        }
        const fenceActive = task.state === "processing" && task.leaseToken === token &&
          task.leaseExpiresAt instanceof Date && task.leaseExpiresAt.getTime() > now.getTime();
        return { outcome: "found", attempt: workerAttempt(attempt), fenceActive };
      }
      if (!ATTEMPT_NONTERMINAL.has(attempt.state)) return { outcome: "conflict" };
      const updated = await tx.keywordResearchProviderAttempt.updateManyAndReturn({
        where: { id: attempt.id, state: { in: ["planned", "in_flight"] } },
        data: {
          state: input.state,
          providerCostUsd,
          safeErrorCode,
          resultFingerprint,
          completedAt: now,
          ambiguousAfter: null,
          updatedAt: now
        }
      });
      if (updated.length !== 1) return { outcome: "lost" };
      if (input.state === "succeeded") {
        const existingCache = await tx.keywordResearchCache.findUnique({
          where: { requestFingerprint: attempt.requestFingerprint }
        });
        if (existingCache) {
          const same = existingCache.cacheKey === cacheEntry.cacheKey &&
            existingCache.endpointKey === cacheEntry.endpointKey &&
            existingCache.contractVersion === cacheEntry.contractVersion &&
            existingCache.resultFingerprint === cacheEntry.resultFingerprint &&
            canonicalJson(existingCache.normalizedResponse) === canonicalJson(cacheEntry.normalizedResponse);
          if (!same) return { outcome: "conflict" };
        } else {
          await tx.keywordResearchCache.create({ data: {
            requestFingerprint: attempt.requestFingerprint, cacheKey: cacheEntry.cacheKey,
            endpointKey: cacheEntry.endpointKey, contractVersion: 1,
            normalizedResponse: cacheEntry.normalizedResponse,
            resultFingerprint: cacheEntry.resultFingerprint,
            createdAt: now, expiresAt: plusMilliseconds(now, CACHE_TTL_SECONDS * 1000)
          } });
        }
      }
      const settled = updated[0];
      const fenceActive = task.state === "processing" && task.leaseToken === token &&
        task.leaseExpiresAt instanceof Date && task.leaseExpiresAt.getTime() > now.getTime();
      return {
        outcome: fenceActive ? "terminal" : "lost",
        attempt: workerAttempt(settled),
        fenceActive
      };
    }, SCALE_TRANSACTION_OPTIONS);
  }

  async markAttemptAmbiguous(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const attemptNumber = requireAttemptNumber(input?.attemptNumber);
    const requestFingerprint = requireFingerprint(input?.requestFingerprint);
    if (input?.safeErrorCode !== CODE_AMBIGUOUS) conflict();
    return this._transaction(async (tx) => {
      const attempt = await tx.keywordResearchProviderAttempt.findUnique({
        where: { taskId_attemptNumber: { taskId, attemptNumber } },
        include: { task: { include: { stage: { include: { research: true } } } } }
      });
      if (!attempt) return { outcome: "not_found" };
      if (attempt.state === "ambiguous") {
        return attempt.requestFingerprint === requestFingerprint
          ? { outcome: "found" }
          : { outcome: "conflict" };
      }
      if (!ATTEMPT_NONTERMINAL.has(attempt.state)) return { outcome: "conflict" };
      if (attempt.requestFingerprint !== requestFingerprint) return { outcome: "conflict" };
      await tx.keywordResearchProviderAttempt.updateMany({
        where: { id: attempt.id, state: { in: ["planned", "in_flight"] } },
        data: {
          state: "ambiguous", safeErrorCode: CODE_AMBIGUOUS,
          providerCostUsd: null, ambiguousAfter: now, updatedAt: now
        }
      });
      const task = attempt.task;
      if (!task) return { outcome: "not_found" };
      if (!TASK_TERMINAL.has(task.state)) {
        await tx.keywordResearchTask.updateMany({
          where: { id: taskId, state: task.state },
          data: {
            state: "failed", safeErrorCode: CODE_AMBIGUOUS, terminalAt: now,
            leaseOwner: null, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null,
            updatedAt: now
          }
        });
        const stage = task.stage;
        if (stage) {
          await tx.keywordResearchStage.update({
            where: { id: stage.id },
            data: { failedCount: { increment: 1 }, terminalCount: { increment: 1 }, updatedAt: now }
          });
          if (stage.state !== "completed" && stage.state !== "failed") {
            await tx.keywordResearchStage.updateMany({
              where: { id: stage.id, state: { notIn: ["completed", "failed"] } },
              data: {
                state: "failed", safeErrorCode: CODE_AMBIGUOUS, safeErrorMessage: null, completedAt: now,
                aggregationOwner: null, aggregationLeaseToken: null,
                aggregationLeaseAcquiredAt: null, aggregationLeaseExpiresAt: null,
                updatedAt: now
              }
            });
          }
          await tx.keywordResearch.updateMany({
            where: { id: stage.researchId, state: { notIn: ["completed", "failed"] } },
            data: { state: "failed", safeErrorCode: CODE_AMBIGUOUS, safeErrorMessage: null, completedAt: now, updatedAt: now }
          });
        }
      }
      return { outcome: "terminal" };
    }, SCALE_TRANSACTION_OPTIONS);
  }

  async deferTask(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const token = requireToken(input?.token);
    if (!(input?.nextAttemptAt instanceof Date) || !Number.isFinite(input.nextAttemptAt.getTime())) conflict();
    if (input?.safeErrorCode !== CODE_THROTTLED) conflict();
    const nextAttemptAt = input.nextAttemptAt;
    return this._transaction(async (tx) => {
      const task = await tx.keywordResearchTask.findUnique({
        where: { id: taskId },
        include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } }
      });
      if (!task) return { outcome: "not_found" };
      if (task.state === "pending" && task.leaseToken === null && task.leaseExpiresAt === null &&
          task.nextAttemptAt instanceof Date && task.nextAttemptAt.getTime() === nextAttemptAt.getTime() &&
          task.safeErrorCode === CODE_THROTTLED) {
        return { outcome: "delayed", retryAt: task.nextAttemptAt };
      }
      if (task.state !== "processing" || task.leaseToken !== token) return { outcome: "lost" };
      if (task.leaseExpiresAt instanceof Date && task.leaseExpiresAt.getTime() <= now.getTime()) {
        return { outcome: "lost" };
      }
      if (nextAttemptAt.getTime() <= now.getTime()) return { outcome: "conflict" };
      const latest = task.attempts[0] ?? null;
      if (latest && task.leaseAcquiredAt instanceof Date &&
          latest.plannedAt instanceof Date && latest.plannedAt.getTime() >= task.leaseAcquiredAt.getTime()) {
        return { outcome: "conflict" };
      }
      const updated = await tx.keywordResearchTask.updateMany({
        where: { id: taskId, state: "processing", leaseToken: token },
        data: {
          state: "pending", nextAttemptAt, safeErrorCode: CODE_THROTTLED,
          leaseOwner: null, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null,
          updatedAt: now
        }
      });
      if (updated.count !== 1) return { outcome: "lost" };
      return { outcome: "delayed", retryAt: nextAttemptAt };
    }, SHORT_TRANSACTION_OPTIONS);
  }

  async scheduleRetry(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const token = requireToken(input?.token);
    const attemptNumber = requireAttemptNumber(input?.attemptNumber);
    return this._transaction(async (tx) => {
      const task = await tx.keywordResearchTask.findUnique({
        where: { id: taskId },
        include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } }
      });
      if (!task) return { outcome: "not_found" };
      const latest = task.attempts[0] ?? null;
      if (!latest || latest.attemptNumber !== attemptNumber || latest.state !== "failed") {
        return { outcome: "conflict" };
      }
      if (task.state === "pending" && task.leaseToken === null && task.leaseExpiresAt === null &&
          task.nextAttemptAt instanceof Date) {
        return { outcome: "delayed", retryAt: task.nextAttemptAt };
      }
      if (attemptNumber >= MAX_ATTEMPTS) return { outcome: "conflict", code: "KEYWORD_PROVIDER_RETRY_EXHAUSTED" };
      const completedBase = latest.completedAt instanceof Date ? latest.completedAt.getTime() : now.getTime();
      const delaySeconds = retryDelaySeconds(taskId, attemptNumber);
      const retryAt = new Date(Math.max(completedBase + delaySeconds * 1000, now.getTime()));
      if (task.state !== "processing" || task.leaseToken !== token) return { outcome: "lost" };
      if (task.leaseExpiresAt instanceof Date && task.leaseExpiresAt.getTime() <= now.getTime()) {
        return { outcome: "lost" };
      }
      const updated = await tx.keywordResearchTask.updateMany({
        where: { id: taskId, state: "processing", leaseToken: token },
        data: {
          state: "pending", nextAttemptAt: retryAt,
          leaseOwner: null, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null,
          updatedAt: now
        }
      });
      if (updated.count !== 1) return { outcome: "lost" };
      return { outcome: "delayed", retryAt };
    }, SHORT_TRANSACTION_OPTIONS);
  }

  async terminalize(input, now) {
    requireNow(now);
    const taskId = requireNonempty(input?.taskId);
    const token = requireToken(input?.token);
    if (!TASK_TERMINAL.has(input?.state)) conflict();
    if (input?.artifactS3Key !== undefined && input.artifactS3Key !== null) requireNonempty(input.artifactS3Key);
    if (input?.artifactFingerprint != null) requireFingerprint(input.artifactFingerprint);
    return this._transaction(async (tx) => {
      const task = await tx.keywordResearchTask.findUnique({
        where: { id: taskId },
        include: { stage: true }
      });
      if (!task) return { outcome: "not_found" };
      if (TASK_TERMINAL.has(task.state)) {
        const duplicateSame = task.state === input.state &&
          sameNullable(task.artifactS3Key, input.artifactS3Key ?? null) &&
          sameNullable(task.artifactFingerprint, input.artifactFingerprint ?? null) &&
          sameNullable(task.safeErrorCode, input.safeErrorCode ?? null);
        return duplicateSame ? { outcome: "found", task: workerTask(task) } : { outcome: "conflict" };
      }
      if (task.state !== "processing" || task.leaseToken !== token) return { outcome: "lost" };
      if (!(task.leaseExpiresAt instanceof Date) || task.leaseExpiresAt.getTime() <= now.getTime()) return { outcome: "lost" };
      const updated = await tx.keywordResearchTask.updateManyAndReturn({
        where: { id: taskId, state: "processing", leaseToken: token, leaseExpiresAt: { gt: now } },
        data: {
          state: input.state, terminalAt: now,
          artifactS3Key: input.artifactS3Key ?? null,
          artifactFingerprint: input.artifactFingerprint ?? null,
          safeErrorCode: input.safeErrorCode ?? null,
          safeErrorMessage: input.safeErrorMessage ?? null,
          updatedAt: now
        }
      });
      if (updated.length !== 1) return { outcome: "lost" };
      const counter = input.state === "succeeded" ? "succeededCount"
        : input.state === "skipped" ? "skippedCount" : "failedCount";
      const stageRow = task.stage;
      await tx.keywordResearchStage.update({
        where: { id: task.stageId },
        data: { [counter]: { increment: 1 }, terminalCount: { increment: 1 }, updatedAt: now }
      });
      await tx.keywordResearchStage.updateMany({
        where: { id: task.stageId, state: "collecting", terminalCount: { gte: stageRow.expectedCount } },
        data: { state: "ready", updatedAt: now }
      });
      return { outcome: "terminal", task: workerTask(updated[0]) };
    }, SCALE_TRANSACTION_OPTIONS);
  }

  async claimAggregator(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const stageName = requireStage(input?.stage);
    const generation = requireGeneration(input?.generation ?? 1);
    const owner = requireNonempty(input?.owner);
    const token = requireToken(input?.token);
    return this._transaction(async (tx) => {
      const stageId = keywordStageId(researchId, stageName, generation);
      const stage = await tx.keywordResearchStage.findUnique({ where: { id: stageId } });
      if (!stage) return { outcome: "not_found" };
      if (stage.stage !== stageName) return { outcome: "conflict" };
      if (stage.state === "collecting") return { outcome: "not_ready", stage: workerStage(stage) };
      if (stage.state === "completed") {
        const exact = stage.terminalCount === stage.expectedCount &&
          stage.succeededCount + stage.skippedCount + stage.failedCount === stage.expectedCount;
        return exact ? { outcome: "found", stage: workerStage(stage) } : { outcome: "conflict" };
      }
      if (stage.state === "failed") return { outcome: "conflict" };
      const leaseLive = stage.aggregationLeaseExpiresAt instanceof Date &&
        stage.aggregationLeaseExpiresAt.getTime() > now.getTime();
      if (stage.state === "aggregating" && leaseLive) {
        return stage.aggregationLeaseToken === token
          ? { outcome: "found", stage: workerStage(stage) }
          : { outcome: "lost" };
      }
      const ready = stage.terminalCount === stage.expectedCount &&
        stage.succeededCount + stage.skippedCount + stage.failedCount === stage.expectedCount;
      if (stage.state === "ready") {
        if (!ready) return { outcome: "conflict" };
        const updated = await tx.keywordResearchStage.updateManyAndReturn({
          where: { id: stageId, state: "ready" },
          data: {
            state: "aggregating", aggregationOwner: owner, aggregationLeaseToken: token,
            aggregationLeaseAcquiredAt: now,
            aggregationLeaseExpiresAt: plusMilliseconds(now, AGGREGATION_LEASE_MS),
            aggregationAttempt: { increment: 1 }, updatedAt: now
          }
        });
        if (updated.length !== 1) return { outcome: "lost" };
        return { outcome: "claimed", stage: workerStage(updated[0]) };
      }
      if (stage.state === "aggregating") {
        const updated = await tx.keywordResearchStage.updateManyAndReturn({
          where: { id: stageId, state: "aggregating", aggregationLeaseExpiresAt: { lte: now } },
          data: {
            aggregationOwner: owner, aggregationLeaseToken: token,
            aggregationLeaseAcquiredAt: now,
            aggregationLeaseExpiresAt: plusMilliseconds(now, AGGREGATION_LEASE_MS),
            aggregationAttempt: { increment: 1 }, updatedAt: now
          }
        });
        if (updated.length !== 1) return { outcome: "lost" };
        return { outcome: "claimed", stage: workerStage(updated[0]) };
      }
      return { outcome: "conflict" };
    }, SHORT_TRANSACTION_OPTIONS);
  }

  async heartbeatAggregator(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const stage = requireStage(input?.stage);
    const generation = requireGeneration(input?.generation ?? 1);
    const token = requireToken(input?.token);
    const stageId = keywordStageId(researchId, stage, generation);
    const leaseExpiresAt = plusMilliseconds(now, AGGREGATION_LEASE_MS);
    const updated = await this.client.keywordResearchStage.updateMany({
      where: {
        id: stageId,
        researchId,
        stage,
        generation,
        state: "aggregating",
        aggregationLeaseToken: token,
        aggregationLeaseExpiresAt: { gt: now }
      },
      data: { aggregationLeaseExpiresAt: leaseExpiresAt, updatedAt: now }
    });
    return updated.count === 1
      ? { outcome: "claimed", leaseExpiresAt }
      : { outcome: "lost" };
  }

  async _completeStageAndCreateNext(tx, input, now) {
    const researchId = requireResearchId(input.researchId);
    const generation = requireGeneration(input.generation);
    const token = requireToken(input.token);
    requireNonempty(input.manifestS3Key);
    requireFingerprint(input.manifestFingerprint);
    const stageId = keywordStageId(researchId, input.stageName, generation);
    const stage = await tx.keywordResearchStage.findUnique({ where: { id: stageId } });
    if (!stage) return { outcome: "not_found" };
    if (stage.stage !== input.stageName) return { outcome: "conflict" };
    if (stage.state === "completed") {
      if (stage.manifestS3Key !== input.manifestS3Key || stage.manifestFingerprint !== input.manifestFingerprint) {
        return { outcome: "conflict" };
      }
      const nextStageId = keywordStageId(researchId, input.nextStageName, generation);
      const nextStage = await tx.keywordResearchStage.findUnique({
        where: { id: nextStageId },
        include: { tasks: { orderBy: { itemKey: "asc" } } }
      });
      if (!nextStage) return { outcome: "conflict" };
      if (!sameTaskSet(nextStage.tasks, input.nextStageTasks)) return { outcome: "conflict" };
      return { outcome: "found", stage: workerStage(stage), nextStage: workerStage(nextStage), tasks: nextStage.tasks.map(workerTask) };
    }
    if (stage.state !== "aggregating" || stage.aggregationLeaseToken !== token) return { outcome: "lost" };
    if (!(stage.aggregationLeaseExpiresAt instanceof Date) || stage.aggregationLeaseExpiresAt.getTime() <= now.getTime()) {
      return { outcome: "lost" };
    }
    if (stage.terminalCount !== stage.expectedCount) return { outcome: "conflict" };
    if (stage.manifestS3Key !== null &&
        (stage.manifestS3Key !== input.manifestS3Key || stage.manifestFingerprint !== input.manifestFingerprint)) {
      return { outcome: "conflict" };
    }
    const updated = await tx.keywordResearchStage.updateManyAndReturn({
      where: { id: stageId, state: "aggregating", aggregationLeaseToken: token, aggregationLeaseExpiresAt: { gt: now } },
      data: {
        manifestS3Key: input.manifestS3Key, manifestFingerprint: input.manifestFingerprint,
        manifestProducedAt: stage.createdAt, state: "completed", completedAt: now, updatedAt: now
      }
    });
    if (updated.length !== 1) return { outcome: "lost" };
    const completedStage = updated[0];
    const nextStageId = keywordStageId(researchId, input.nextStageName, generation);
    const nextStage = await tx.keywordResearchStage.create({ data: {
      id: nextStageId, researchId, stage: input.nextStageName, generation,
      expectedCount: input.nextStageTasks.length,
      state: input.nextStageTasks.length === 0 ? "ready" : "collecting",
      createdAt: now, updatedAt: now
    } });
    let nextTasks = [];
    if (input.nextStageTasks.length) {
      nextTasks = await tx.keywordResearchTask.createManyAndReturn({ data: input.nextStageTasks.map((task) => ({
        id: keywordTaskId(nextStageId, task.itemKey), stageId: nextStageId, itemKey: task.itemKey,
        inputFingerprint: task.inputFingerprint, endpointKey: task.endpointKey,
        requestFingerprint: task.requestFingerprint,
        nextAttemptAt: task.nextAttemptAt instanceof Date ? task.nextAttemptAt : null,
        createdAt: now, updatedAt: now
      })) });
      nextTasks.sort(compareTaskRowsByUnsignedItemKey);
    }
    return {
      outcome: "terminal", stage: workerStage(completedStage), nextStage: workerStage(nextStage),
      tasks: nextTasks.map(workerTask)
    };
  }

  async publishCandidateManifest(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const generation = requireGeneration(input?.generation ?? 1);
    const token = requireToken(input?.token);
    requireNonempty(input?.manifestS3Key);
    requireFingerprint(input?.manifestFingerprint);
    const tasks = Array.isArray(input?.nextStageTasks) ? input.nextStageTasks : [];
    if (tasks.length !== 1 || tasks[0]?.itemKey !== "US:0" || tasks[0]?.endpointKey !== "keyword_overview") {
      return { outcome: "conflict", code: "KEYWORD_ANCHOR_TASK_SET_INVALID" };
    }
    if (!requireTaskShapes(tasks) || !requireUniqueTaskKeys(tasks)) return { outcome: "conflict" };
    return this._transaction((tx) => this._completeStageAndCreateNext(tx, {
      researchId, generation, token, manifestS3Key: input.manifestS3Key,
      manifestFingerprint: input.manifestFingerprint,
      stageName: "expansion", nextStageName: "anchor_screen", nextStageTasks: tasks
    }, now), SCALE_TRANSACTION_OPTIONS);
  }

  async publishShortlist(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const generation = requireGeneration(input?.generation ?? 1);
    const token = requireToken(input?.token);
    requireNonempty(input?.manifestS3Key);
    requireFingerprint(input?.manifestFingerprint);
    const tasks = Array.isArray(input?.marketTasks) ? input.marketTasks : [];
    if (tasks.length !== MARKET_TASK_KEYS.length ||
        tasks.some((task, index) => task?.itemKey !== MARKET_TASK_KEYS[index] || task?.endpointKey !== "keyword_overview")) {
      return { outcome: "conflict", code: "KEYWORD_MARKET_TASK_SET_INVALID" };
    }
    if (!requireTaskShapes(tasks) || !requireUniqueTaskKeys(tasks)) return { outcome: "conflict" };
    return this._transaction((tx) => this._completeStageAndCreateNext(tx, {
      researchId, generation, token, manifestS3Key: input.manifestS3Key,
      manifestFingerprint: input.manifestFingerprint,
      stageName: "anchor_screen", nextStageName: "market_overview", nextStageTasks: tasks
    }, now), SCALE_TRANSACTION_OPTIONS);
  }

  async publishResearchResult(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const generation = requireGeneration(input?.generation ?? 1);
    const token = requireToken(input?.token);
    requireNonempty(input?.manifestS3Key);
    requireFingerprint(input?.manifestFingerprint);
    requireFingerprint(input?.resultFingerprint);
    if (input?.result === null || typeof input?.result !== "object") conflict();
    const serialized = JSON.stringify(input.result);
    if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
      return { outcome: "conflict", code: CODE_RESULT_TOO_LARGE };
    }
    const selectionItems = Array.isArray(input?.selectionItems) ? input.selectionItems : null;
    if (selectionItems === null || selectionItems.length > MAX_DEFAULT_ITEMS) {
      return { outcome: "conflict", code: "KEYWORD_SELECTION_INVALID" };
    }
    for (const item of selectionItems) {
      if (!validSelectionItem(item)) return { outcome: "conflict", code: "KEYWORD_SELECTION_INVALID" };
    }
    const rows = Array.isArray(input.result) ? input.result : input.result.keywords;
    if (!Array.isArray(rows)) return { outcome: "conflict", code: "KEYWORD_SELECTION_INVALID" };
    const expectedSelection = createDefaultSelection(rows);
    if (!expectedSelection.ok || canonicalJson(selectionItems) !== canonicalJson(expectedSelection.items)) {
      return { outcome: "conflict", code: "KEYWORD_SELECTION_MISMATCH" };
    }
    try {
      return await this._transaction(async (tx) => {
        const research = await tx.keywordResearch.findUnique({
          where: { id: researchId },
          include: { stages: { where: { generation } } }
        });
        if (!research) return { outcome: "not_found" };
        if (research.generation !== generation) return { outcome: "conflict" };
        const stagesById = new Map(research.stages.map((row) => [row.id, row]));
        const marketStageId = keywordStageId(researchId, "market_overview", generation);
        const marketStage = stagesById.get(marketStageId) ?? null;
        if (!marketStage) return { outcome: "conflict" };
        if (research.state === "completed") {
          const selectionMatches = research.selection !== null && typeof research.selection === "object" &&
            canonicalJson(research.selection.items) === canonicalJson(selectionItems);
          const manifestMatches = marketStage.manifestS3Key === input.manifestS3Key &&
            marketStage.manifestFingerprint === input.manifestFingerprint;
          const resultMatches = research.resultFingerprint === input.resultFingerprint &&
            research.selectionRevision === 1;
          return selectionMatches && manifestMatches && resultMatches
            ? { outcome: "found" }
            : { outcome: "conflict" };
        }
        if (research.state !== "running") return { outcome: "conflict" };
        const expansionStage = stagesById.get(keywordStageId(researchId, "expansion", generation)) ?? null;
        const anchorStage = stagesById.get(keywordStageId(researchId, "anchor_screen", generation)) ?? null;
        if (!expansionStage || !anchorStage || expansionStage.state !== "completed" || anchorStage.state !== "completed") {
          return { outcome: "conflict", code: "KEYWORD_STAGES_INCOMPLETE" };
        }
        if (marketStage.state === "completed") {
          return { outcome: "conflict" };
        }
        if (marketStage.state !== "aggregating") return { outcome: "conflict" };
        if (marketStage.aggregationLeaseToken !== token) return { outcome: "lost" };
        if (!(marketStage.aggregationLeaseExpiresAt instanceof Date) || marketStage.aggregationLeaseExpiresAt.getTime() <= now.getTime()) {
          return { outcome: "lost" };
        }
        if (marketStage.terminalCount !== marketStage.expectedCount ||
            marketStage.succeededCount + marketStage.skippedCount + marketStage.failedCount !== marketStage.expectedCount) {
          return { outcome: "conflict", code: "KEYWORD_STAGES_INCOMPLETE" };
        }
        if (marketStage.manifestS3Key !== null &&
            (marketStage.manifestS3Key !== input.manifestS3Key ||
             marketStage.manifestFingerprint !== input.manifestFingerprint)) {
          return { outcome: "conflict" };
        }
        const updated = await tx.keywordResearchStage.updateMany({
          where: { id: marketStageId, state: "aggregating", aggregationLeaseToken: token, aggregationLeaseExpiresAt: { gt: now } },
          data: {
            manifestS3Key: input.manifestS3Key, manifestFingerprint: input.manifestFingerprint,
            manifestProducedAt: marketStage.createdAt, state: "completed", completedAt: now, updatedAt: now
          }
        });
        if (updated.count !== 1) throw new FinalPublicationAbort("lost");
        const researchUpdated = await tx.keywordResearch.updateMany({
          where: { id: researchId, state: "running", generation },
          data: {
            state: "completed", result: input.result, resultFingerprint: input.resultFingerprint,
            selection: { items: selectionItems }, selectionRevision: 1,
            completedAt: now, updatedAt: now
          }
        });
        if (researchUpdated.count !== 1) throw new FinalPublicationAbort("conflict");
        return { outcome: "terminal" };
      }, SCALE_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof FinalPublicationAbort) return { outcome: error.mapping };
      throw error;
    }
  }

  async failStage(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const stageName = requireStage(input?.stage);
    const generation = requireGeneration(input?.generation ?? 1);
    const token = requireToken(input?.token);
    requireNonempty(input?.safeErrorCode ?? "KEYWORD_RESEARCH_STAGE_FAILED");
    return this._transaction(async (tx) => {
      const stageId = keywordStageId(researchId, stageName, generation);
      const updated = await tx.keywordResearchStage.updateMany({
        where: { id: stageId, state: "aggregating", aggregationLeaseToken: token, aggregationLeaseExpiresAt: { gt: now } },
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
    }, SHORT_TRANSACTION_OPTIONS);
  }

  async saveSelection(input, now) {
    requireNow(now);
    const researchId = requireResearchId(input?.researchId);
    const ownerId = requireOwner(input?.ownerId);
    if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision < 0) conflict();
    if (!Array.isArray(input?.items) || input.items.length > MAX_SELECTION_ITEMS) conflict();
    for (const item of input.items) requireSelectionItemId(item?.itemId);
    return this._transaction(async (tx) => {
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
    }, SHORT_TRANSACTION_OPTIONS);
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
    try {
      return await this._transaction(async (tx) => {
        const research = await tx.keywordResearch.findUnique({
          where: { id: researchId },
          include: {
            handoffs: {
              where: { clientRequestId: input.clientRequestId },
              include: { run: true }
            }
          }
        });
        if (!research || research.ownerId !== ownerId) return { outcome: "not_found" };
        const existingHandoff = research.handoffs[0] ?? null;
        if (existingHandoff) {
          if (existingHandoff.selectionFingerprint !== input.selectionFingerprint ||
              existingHandoff.selectionRevision !== input.expectedSelectionRevision) {
            return { outcome: "conflict" };
          }
          const run = existingHandoff.run;
          return run ? { outcome: "found", run } : { outcome: "conflict" };
        }
        if (research.state !== "completed") return { outcome: "conflict", code: "KEYWORD_RESEARCH_NOT_COMPLETED" };
        if (research.selectionRevision !== input.expectedSelectionRevision) {
          return { outcome: "conflict", code: "KEYWORD_SELECTION_REVISION_CONFLICT" };
        }
        const runId = requireRunId(input?.runId);
        const run = await input.constructRun(tx, { research, runId, now, items: input.items });
        if (!run || run.id !== runId || run.ownerId !== research.ownerId ||
            run.keywordResearchId !== researchId || run.queryPlanSource !== "keyword_research") {
          throw new RunHandoffAbort();
        }
        const queries = await input.constructQueries(tx, { run, items: input.items, now });
        if (!Array.isArray(queries) || queries.length !== input.items.length ||
            queries.some((query, index) => query?.runId !== runId ||
              query?.keywordResearchItemId !== input.items[index]?.itemId)) {
          throw new RunHandoffAbort();
        }
        await tx.keywordResearchHandoff.create({ data: {
          id: derivedId("krh_", [researchId, input.expectedSelectionRevision, input.clientRequestId]),
          researchId, selectionRevision: input.expectedSelectionRevision,
          clientRequestId: input.clientRequestId, selectionFingerprint: input.selectionFingerprint,
          runId, createdAt: now
        } });
        return { outcome: "created", run };
      }, SCALE_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof RunHandoffAbort) {
        return { outcome: "conflict", code: "KEYWORD_RUN_HANDOFF_INVALID" };
      }
      if (error?.code === "P2002") {
        const originalError = error;
        return await this._transaction(async (tx) => {
          const handoff = await tx.keywordResearchHandoff.findUnique({
            where: { researchId_clientRequestId: { researchId, clientRequestId: input.clientRequestId } },
            include: { run: true }
          });
          if (!handoff) throw originalError;
          if (handoff.selectionFingerprint !== input.selectionFingerprint ||
              handoff.selectionRevision !== input.expectedSelectionRevision) {
            return { outcome: "conflict", code: "KEYWORD_RUN_HANDOFF_CONFLICT" };
          }
          const run = handoff.run;
          return run ? { outcome: "found", run } : { outcome: "conflict", code: "KEYWORD_RUN_HANDOFF_CONFLICT" };
        }, SHORT_TRANSACTION_OPTIONS);
      }
      throw error;
    }
  }

  async recover(now, { limit } = {}) {
    requireNow(now);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) conflict();
    return this._transaction(async (tx) => {
      const initializations = await tx.keywordResearch.findMany({
        where: { state: "queued", stages: { none: { stage: "expansion" } } },
        take: limit,
        orderBy: { id: "asc" }
      });
      const tasks = await tx.keywordResearchTask.findMany({
        where: {
          OR: [
            { state: "processing", leaseExpiresAt: { lt: now } },
            { state: "pending", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }
          ]
        },
        include: { stage: true },
        take: limit,
        orderBy: { id: "asc" }
      });
      const stages = await tx.keywordResearchStage.findMany({
        where: {
          OR: [
            { state: "ready" },
            { state: "aggregating", aggregationLeaseExpiresAt: { lt: now } }
          ]
        },
        include: { tasks: { orderBy: { itemKey: "asc" } } },
        take: limit,
        orderBy: { id: "asc" }
      });
      const candidates = [];
      for (const research of initializations) {
        candidates.push({
          rank: 2, id: research.id, eligibility: research.createdAt, kind: "initialization", row: research
        });
      }
      for (const task of tasks) {
        if (!task.stage) continue;
        const eligibility = task.state === "processing"
          ? task.leaseExpiresAt
          : task.nextAttemptAt ?? task.updatedAt;
        candidates.push({ rank: 0, id: task.id, eligibility, kind: "task", row: task });
      }
      for (const stage of stages) {
        const eligibility = stage.state === "ready" ? stage.updatedAt : stage.aggregationLeaseExpiresAt;
        candidates.push({ rank: 1, id: stage.id, eligibility, kind: "stage", row: stage });
      }
      candidates.sort((left, right) => {
        const byEligibility = left.eligibility.getTime() - right.eligibility.getTime();
        if (byEligibility !== 0) return byEligibility;
        if (left.rank !== right.rank) return left.rank - right.rank;
        return compareUnsignedUtf8(left.id, right.id);
      });
      const selected = candidates.slice(0, limit);
      const initializationRows = [];
      const taskRows = [];
      const stageRows = [];
      for (const candidate of selected) {
        if (candidate.kind === "initialization") initializationRows.push(candidate.row);
        else if (candidate.kind === "task") taskRows.push(candidate.row);
        else stageRows.push(candidate.row);
      }
      return {
        outcome: "found",
        initializations: initializationRows.map((research) => ({
          researchId: research.id, generation: research.generation
        })),
        taskDispatches: taskRows.map((task) => ({
          researchId: task.stage.researchId,
          generation: task.stage.generation,
          stage: task.stage.stage,
          stageId: task.stageId,
          taskId: task.id,
          itemKey: task.itemKey,
          inputFingerprint: task.inputFingerprint,
          endpointKey: task.endpointKey,
          requestFingerprint: task.requestFingerprint
        })),
        aggregateChecks: stageRows.map((stage) => ({
          researchId: stage.researchId,
          generation: stage.generation,
          stage: stage.stage,
          stageId: stage.id,
          stageInputFingerprint: stageInputFingerprint({
            researchId: stage.researchId, generation: stage.generation, stage: stage.stage, tasks: stage.tasks
          })
        }))
      };
    }, SCALE_TRANSACTION_OPTIONS);
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
    if (!ENDPOINT_KEYS.has(input?.endpointKey)) conflict();
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
    return this._transaction(async (tx) => {
      const [row] = await tx.$queryRaw`
        WITH "inserted" AS (
          INSERT INTO "KeywordProviderThrottle" ("provider", "nextAllowedAt", "updatedAt")
          VALUES (${provider}, now() + make_interval(secs => ${minGapMs / 1000}::float8), now())
          ON CONFLICT ("provider") DO NOTHING
          RETURNING "nextAllowedAt"
        ), "updated" AS (
          UPDATE "KeywordProviderThrottle"
          SET "nextAllowedAt" = now() + make_interval(secs => ${minGapMs / 1000}::float8), "updatedAt" = now()
          WHERE "provider" = ${provider}
            AND "nextAllowedAt" <= now()
            AND NOT EXISTS (SELECT 1 FROM "inserted")
          RETURNING "nextAllowedAt"
        )
        SELECT "claimStatus", "nextAllowedAt" FROM (
          SELECT 'claimed' AS "claimStatus", "nextAllowedAt" FROM "inserted"
          UNION ALL
          SELECT 'claimed' AS "claimStatus", "nextAllowedAt" FROM "updated"
          UNION ALL
          SELECT 'delayed' AS "claimStatus", "nextAllowedAt" FROM "KeywordProviderThrottle"
          WHERE "provider" = ${provider}
            AND NOT EXISTS (SELECT 1 FROM "inserted")
            AND NOT EXISTS (SELECT 1 FROM "updated")
        ) AS "claimState"`;
      return row?.claimStatus === "claimed"
        ? { outcome: "claimed", nextAllowedAt: row.nextAllowedAt }
        : { outcome: "delayed", retryAt: row?.nextAllowedAt ?? new Date() };
    }, SHORT_TRANSACTION_OPTIONS);
  }
}
