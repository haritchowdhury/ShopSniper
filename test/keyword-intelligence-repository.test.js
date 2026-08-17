import assert from "node:assert/strict";
import test from "node:test";
import { KeywordRepositoryError, PrismaKeywordResearchRepository, keywordStageId,
  keywordTaskId, newLeaseToken, newResearchId, selectionItemId } from "../src/keyword-intelligence/repository.js";
import { selectionItemId as w2SelectionItemId } from "../src/keyword-intelligence/selection.js";
import * as repositoryModule from "../src/keyword-intelligence/repository.js";

const RESEARCH = "kr_" + "a".repeat(24);
const NOW = new Date("2026-08-17T00:00:00.000Z");
const TOKEN = "t".repeat(32);
const FP = "f".repeat(64);

test("newResearchId matches the locked kr_ plus 24 base64url identity", () => {
  for (let index = 0; index < 50; index += 1) {
    const id = newResearchId();
    assert.match(id, /^kr_[A-Za-z0-9_-]{24}$/u);
  }
  assert.notEqual(newResearchId(), newResearchId());
});

test("newLeaseToken is 24-byte base64url (32 chars)", () => {
  assert.match(newLeaseToken(), /^[A-Za-z0-9_-]{32}$/u);
});

test("selectionItemId is deterministic ksi_ plus 12 lowercase hex", () => {
  const first = selectionItemId("calculated", "synthetic keyword one");
  const repeat = selectionItemId("calculated", "synthetic keyword one");
  const otherKind = selectionItemId("manual", "synthetic keyword one");
  const otherKeyword = selectionItemId("calculated", "synthetic keyword two");
  assert.equal(first, repeat);
  assert.match(first, /^ksi_[a-f0-9]{12}$/u);
  assert.notEqual(first, otherKind);
  assert.notEqual(first, otherKeyword);
});

test("selectionItemId matches the W2 dkLen:6 stableId formula (DEC-KI-002/026)", () => {
  for (const keyword of ["synthetic keyword one", "vegan leather handbag", "men's running shoes"]) {
    assert.equal(selectionItemId("calculated", keyword), w2SelectionItemId("calculated", keyword));
    assert.equal(selectionItemId("manual", keyword), w2SelectionItemId("manual", keyword));
  }
  assert.equal(selectionItemId("calculated", "synthetic keyword one"), "ksi_77d16c2727c3");
});

test("selectionItemId rejects invalid source kind or keyword", () => {
  assert.throws(() => selectionItemId("imported", "x"), KeywordRepositoryError);
  assert.throws(() => selectionItemId("calculated", ""), KeywordRepositoryError);
  assert.throws(() => selectionItemId("calculated", "x".repeat(161)), KeywordRepositoryError);
});

test("keywordStageId and keywordTaskId are deterministic and validated", () => {
  const stageId = keywordStageId(RESEARCH, "expansion", 1);
  assert.equal(stageId, keywordStageId(RESEARCH, "expansion", 1));
  assert.match(stageId, /^krs_[A-Za-z0-9_-]{24}$/u);
  assert.notEqual(stageId, keywordStageId(RESEARCH, "anchor_screen", 1));
  const taskId = keywordTaskId(stageId, "0:suggestions");
  assert.equal(taskId, keywordTaskId(stageId, "0:suggestions"));
  assert.match(taskId, /^krt_[A-Za-z0-9_-]{24}$/u);
  assert.throws(() => keywordStageId("run_123", "expansion", 1), KeywordRepositoryError);
  assert.throws(() => keywordStageId(RESEARCH, "discovery", 1), KeywordRepositoryError);
  assert.throws(() => keywordStageId(RESEARCH, "expansion", 0), KeywordRepositoryError);
  assert.throws(() => keywordTaskId(stageId, "../escape"), KeywordRepositoryError);
});

test("repository input validation fails closed before any client call", async () => {
  const repo = new PrismaKeywordResearchRepository({
    $transaction: () => { throw new Error("must not open a transaction"); },
    keywordResearch: { findUnique: () => { throw new Error("must not touch the client"); } }
  });
  await assert.rejects(() => repo.create({ researchId: "bad", ownerId: "o", configSnapshot: {},
    configFingerprint: FP, seeds: ["s"], markets: [] }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.create({ researchId: RESEARCH, ownerId: "o", configSnapshot: {},
    configFingerprint: "nothex", seeds: ["s"], markets: [] }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.claim({ taskId: "t", owner: "o", token: "short" }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.getWorkerResearch({ researchId: "bad", generation: 1 }), KeywordRepositoryError);
  await assert.rejects(() => repo.getStageContext({ researchId: RESEARCH, stage: "discovery", generation: 1 }),
    KeywordRepositoryError);
  await assert.rejects(() => repo.initialize({ researchId: RESEARCH, generation: 1, stage: "anchor_screen",
    tasks: [] }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.initialize({ researchId: RESEARCH, generation: 1, stage: "expansion",
    tasks: [{ itemKey: "0:suggestions", inputFingerprint: "bad", endpointKey: "keyword_suggestions",
      requestFingerprint: FP }] }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.recordAttempt({ taskId: "t", token: "short", requestFingerprint: FP,
    reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.recordAttempt({ taskId: "t", token: TOKEN, requestFingerprint: FP,
    reservationCostUsd: "0.0156", maxCostPerResearchUsd: "3.00000000" }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.settleAttempt({ taskId: "t", token: TOKEN, attemptNumber: 0,
    state: "succeeded", providerCostUsd: "0.01200000", cacheEntry: null }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.settleAttempt({ taskId: "t", token: TOKEN, attemptNumber: 1,
    state: "succeeded", providerCostUsd: "0.01200000", cacheEntry: null }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.settleAttempt({ taskId: "t", token: TOKEN, attemptNumber: 1,
    state: "failed", providerCostUsd: "0.01200000", cacheEntry: { cacheKey: "k", endpointKey: "keyword_suggestions",
      contractVersion: 1, normalizedResponse: {}, resultFingerprint: FP, ttlSeconds: 604800 } }, NOW),
  KeywordRepositoryError);
  await assert.rejects(() => repo.markAttemptAmbiguous({ taskId: "t", attemptNumber: 1,
    requestFingerprint: FP, safeErrorCode: "KEYWORD_PROVIDER_THROTTLED" }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.deferTask({ taskId: "t", token: "short", nextAttemptAt: NOW,
    safeErrorCode: "KEYWORD_PROVIDER_THROTTLED" }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.deferTask({ taskId: "t", token: TOKEN, nextAttemptAt: "2026-08-17",
    safeErrorCode: "KEYWORD_PROVIDER_THROTTLED" }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.scheduleRetry({ taskId: "t", token: TOKEN, attemptNumber: 0 }, NOW),
    KeywordRepositoryError);
  await assert.rejects(() => repo.publishCandidateManifest({ researchId: RESEARCH, generation: 1,
    token: "short", manifestS3Key: "runs/m.json", manifestFingerprint: FP,
    nextStageTasks: [{ itemKey: "US:0", inputFingerprint: FP, endpointKey: "keyword_overview",
      requestFingerprint: FP }] }, NOW), KeywordRepositoryError);
  assert.equal((await repo.publishShortlist({ researchId: RESEARCH, generation: 1, token: TOKEN,
    manifestS3Key: "runs/s.json", manifestFingerprint: FP, marketTasks: [] }, NOW)).outcome, "conflict");
  assert.equal((await repo.publishResearchResult({ researchId: RESEARCH, generation: 1, token: TOKEN,
    manifestS3Key: "runs/m.json", manifestFingerprint: FP, result: {}, resultFingerprint: FP,
    selectionItems: [] }, NOW)).outcome, "conflict");
  await assert.rejects(() => repo.saveSelection({ researchId: RESEARCH, ownerId: "o", expectedRevision: -1,
    items: [] }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.saveSelection({ researchId: RESEARCH, ownerId: "o", expectedRevision: 1,
    items: Array.from({ length: 201 }, () => ({ itemId: "ksi_000000000000" })) }, NOW), KeywordRepositoryError);
});

test("publishResearchResult rejects oversized or non-conforming selection before any client call", async () => {
  const repo = new PrismaKeywordResearchRepository({
    $transaction: () => { throw new Error("must not open a transaction"); },
    keywordResearch: { findUnique: () => { throw new Error("must not touch the client"); } }
  });
  const oversized = { blob: "x".repeat(33_554_432) };
  const result = await repo.publishResearchResult({ researchId: RESEARCH, generation: 1, token: TOKEN,
    manifestS3Key: "runs/m.json", manifestFingerprint: FP, result: oversized, resultFingerprint: FP,
    selectionItems: [] }, NOW);
  assert.equal(result.outcome, "conflict");
  assert.equal(result.code, "KEYWORD_RESULT_TOO_LARGE");
  const badSelection = await repo.publishResearchResult({ researchId: RESEARCH, generation: 1, token: TOKEN,
    manifestS3Key: "runs/m.json", manifestFingerprint: FP, result: { keywords: [] },
    resultFingerprint: FP, selectionItems: Array.from({ length: 101 }, () => ({
      itemId: "ksi_000000000000", sourceKind: "calculated", keyword: "k", sourceSeeds: [],
      lane: "category_discovery", facets: {}, metricsSnapshot: null })) }, NOW);
  assert.equal(badSelection.outcome, "conflict");
});

test("createRun validates client request id and item bounds", async () => {
  const repo = new PrismaKeywordResearchRepository({
    $transaction: () => { throw new Error("must not open a transaction"); }
  });
  await assert.rejects(() => repo.createRun({ researchId: RESEARCH, ownerId: "o",
    expectedSelectionRevision: 1, clientRequestId: "short",
    selectionFingerprint: FP, items: [{ itemId: "ksi_000000000000", keyword: "k" }],
    constructRun: () => {}, constructQueries: () => {} }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.createRun({ researchId: RESEARCH, ownerId: "o",
    expectedSelectionRevision: 1, clientRequestId: "client-request-id-0001",
    selectionFingerprint: FP, items: [],
    constructRun: () => {}, constructQueries: () => {} }, NOW), KeywordRepositoryError);
});

test("corrective surface stays fail-closed: sentinel and transaction seam are private", () => {
  assert.equal(Object.hasOwn(repositoryModule, "FinalPublicationAbort"), false);
  assert.equal(Object.hasOwn(repositoryModule, "transaction"), false);
  assert.equal(Object.hasOwn(repositoryModule, "completeStageAndCreateNext"), false);
  assert.equal(typeof PrismaKeywordResearchRepository.prototype.recordAttempt, "function");
  assert.equal(typeof PrismaKeywordResearchRepository.prototype.scheduleRetry, "function");
  assert.equal(typeof PrismaKeywordResearchRepository.prototype.publishResearchResult, "function");
  assert.equal(typeof PrismaKeywordResearchRepository.prototype._transaction, "function");
  assert.equal(typeof PrismaKeywordResearchRepository.prototype._completeStageAndCreateNext, "function");
});