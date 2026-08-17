import assert from "node:assert/strict";
import test from "node:test";
import { KeywordRepositoryError, PrismaKeywordResearchRepository, keywordStageId,
  keywordTaskId, newLeaseToken, newResearchId, selectionItemId } from "../src/keyword-intelligence/repository.js";

const RESEARCH = "kr_" + "a".repeat(24);
const NOW = new Date("2026-08-17T00:00:00.000Z");
const TOKEN = "t".repeat(32);

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
    configFingerprint: "f".repeat(64), seeds: ["s"], markets: [] }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.create({ researchId: RESEARCH, ownerId: "o", configSnapshot: {},
    configFingerprint: "nothex", seeds: ["s"], markets: [] }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.claim({ taskId: "t", owner: "o", token: "short" }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.saveSelection({ researchId: RESEARCH, ownerId: "o", expectedRevision: -1,
    items: [] }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.saveSelection({ researchId: RESEARCH, ownerId: "o", expectedRevision: 1,
    items: Array.from({ length: 201 }, () => ({ itemId: "ksi_000000000000" })) }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.recordAttempt({ taskId: "t", attemptNumber: 1,
    requestFingerprint: "f".repeat(64), reservationCostUsd: "0.0156", maxCostPerResearchUsd: "3.00000000" },
  NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.recordAttempt({ taskId: "t", attemptNumber: 1,
    requestFingerprint: "f".repeat(64), reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" },
  new Date("invalid")), KeywordRepositoryError);
});

test("createRun validates client request id and item bounds", async () => {
  const repo = new PrismaKeywordResearchRepository({
    $transaction: () => { throw new Error("must not open a transaction"); }
  });
  await assert.rejects(() => repo.createRun({ researchId: RESEARCH, ownerId: "o",
    expectedSelectionRevision: 1, clientRequestId: "short",
    selectionFingerprint: "f".repeat(64), items: [{ itemId: "ksi_000000000000", keyword: "k" }],
    constructRun: () => {}, constructQueries: () => {} }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.createRun({ researchId: RESEARCH, ownerId: "o",
    expectedSelectionRevision: 1, clientRequestId: "client-request-id-0001",
    selectionFingerprint: "f".repeat(64), items: [],
    constructRun: () => {}, constructQueries: () => {} }, NOW), KeywordRepositoryError);
});
