import assert from "node:assert/strict";
import test from "node:test";
import { KeywordRepositoryError, PrismaKeywordResearchRepository, keywordStageId,
  keywordTaskId, newLeaseToken, newResearchId, selectionItemId } from "../src/keyword-intelligence/repository.js";
import { selectionItemId as w2SelectionItemId } from "../src/keyword-intelligence/selection.js";
import * as repositoryModule from "../src/keyword-intelligence/repository.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
  assert.equal(typeof PrismaKeywordResearchRepository.prototype.heartbeatAggregator, "function");
});

test("KI-R2 heartbeat and heartbeatAggregator validate inputs fail-closed before any client call", async () => {
  const repo = new PrismaKeywordResearchRepository({
    $transaction: () => { throw new Error("must not open a transaction"); },
    keywordResearchTask: { updateMany: () => { throw new Error("must not touch the task client"); } },
    keywordResearchStage: { updateMany: () => { throw new Error("must not touch the stage client"); } }
  });
  await assert.rejects(() => repo.heartbeat({ taskId: "t", token: "short" }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.heartbeat({ taskId: "", token: TOKEN }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.heartbeatAggregator({ researchId: "bad", stage: "expansion", generation: 1,
    token: TOKEN }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.heartbeatAggregator({ researchId: RESEARCH, stage: "discovery", generation: 1,
    token: TOKEN }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.heartbeatAggregator({ researchId: RESEARCH, stage: "expansion", generation: 0,
    token: TOKEN }, NOW), KeywordRepositoryError);
  await assert.rejects(() => repo.heartbeatAggregator({ researchId: RESEARCH, stage: "expansion", generation: 1,
    token: "short" }, NOW), KeywordRepositoryError);
});

const SCN_KI_043_SOURCE_URL = new URL("../src/keyword-intelligence/repository.js", import.meta.url);
const SCN_KI_043_SOURCE_SHA256 = "17e55ed257f5027325b650ff22a4af9d8d3b34d3008f49b26c1637c379899cf6";
const SCN_KI_043_REQUIRED_CASES = ["W6-DB-01", "W6-DB-02"];
const SCN_KI_043_CONTROL_CASES = ["W6-NC-15"];
const SCN_KI_043_CASE_SET_DIGEST = "bdac823dcc377ac262913efa9e3cb91c22f09f893efc3d812107c948a83dfea6";
const SCN_KI_043_SHORT_PARTITION = ["claim", "deferTask", "scheduleRetry", "claimAggregator", "failStage",
  "saveSelection", "createRun#2", "claimThrottle"];
const SCN_KI_043_SCALE_PARTITION = ["initialize", "recordAttempt", "settleAttempt", "markAttemptAmbiguous",
  "terminalize", "publishCandidateManifest", "publishShortlist", "publishResearchResult", "createRun", "recover"];
const SCN_KI_043_FORBIDDEN_CALLBACK_SYMBOLS = /\b(?:dataforseo|fetch|http|s3|putobject|sqs|sendmessage)\b/iu;

function scnKi043Skeleton(text) {
  const chars = [...text];
  const blank = (index) => { if (index < chars.length && chars[index] !== "\n") chars[index] = " "; };
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") { blank(i); i += 1; }
    } else if (ch === "/" && chars[i + 1] === "*") {
      blank(i); blank(i + 1); i += 2;
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) { blank(i); i += 1; }
      blank(i); blank(i + 1); i += 2;
    } else if (ch === "\"" || ch === "'") {
      blank(i); i += 1;
      while (i < chars.length && chars[i] !== ch) {
        if (chars[i] === "\\") { blank(i); i += 1; }
        blank(i); i += 1;
      }
      blank(i); i += 1;
    } else if (ch === "`") {
      blank(i); i += 1;
      while (i < chars.length && chars[i] !== "`") {
        if (chars[i] === "\\") { blank(i); i += 1; blank(i); i += 1; continue; }
        if (chars[i] === "$" && chars[i + 1] === "{") {
          blank(i); i += 2;
          let depth = 0;
          while (i < chars.length) {
            const inner = chars[i];
            if (inner === "\"" || inner === "'" || inner === "`") {
              const quote = inner;
              blank(i); i += 1;
              while (i < chars.length && chars[i] !== quote) {
                if (chars[i] === "\\") { blank(i); i += 1; }
                blank(i); i += 1;
              }
              blank(i); i += 1;
              continue;
            }
            if (inner === "{") { depth += 1; i += 1; continue; }
            if (inner === "}") { i += 1; if (depth === 0) break; depth -= 1; continue; }
            i += 1;
          }
          continue;
        }
        blank(i); i += 1;
      }
      blank(i); i += 1;
    } else {
      i += 1;
    }
  }
  return chars.join("");
}

function scnKi043ArgumentSpans(skeletonText, openParenIndex) {
  const spans = [];
  let parens = 0; let brackets = 0; let braces = 0; let start = openParenIndex + 1;
  for (let i = openParenIndex + 1; i < skeletonText.length; i += 1) {
    const ch = skeletonText[i];
    if (ch === "(") parens += 1;
    else if (ch === "[") brackets += 1;
    else if (ch === "{") braces += 1;
    else if (ch === ")") {
      if (parens === 0 && brackets === 0 && braces === 0) {
        spans.push([start, i]);
        return { spans, closeIndex: i };
      }
      parens -= 1;
    } else if (ch === "]") brackets -= 1;
    else if (ch === "}") braces -= 1;
    else if (ch === "," && parens === 0 && brackets === 0 && braces === 0) {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  throw new Error("scnKi043: unbalanced argument list");
}

function scnKi043MethodHeaders(skeletonText) {
  const headers = [];
  const pattern = /^ {2}(?:async )?([A-Za-z_$][A-Za-z0-9_$]*)\(/gm;
  let match = pattern.exec(skeletonText);
  while (match !== null) {
    headers.push({ name: match[1], index: match.index });
    match = pattern.exec(skeletonText);
  }
  return headers;
}

function scnKi043EnclosingMethod(headers, position) {
  let enclosing = null;
  for (const header of headers) {
    if (header.index >= position) break;
    enclosing = header;
  }
  return enclosing;
}

function scnKi043TransactionCalls(sourceText) {
  const skeletonText = scnKi043Skeleton(sourceText);
  const headers = scnKi043MethodHeaders(skeletonText);
  const calls = [];
  const occurrences = new Map();
  const needle = "this._transaction(";
  let searchFrom = 0;
  for (;;) {
    const at = skeletonText.indexOf(needle, searchFrom);
    if (at === -1) break;
    const parsed = scnKi043ArgumentSpans(skeletonText, at + needle.length - 1);
    const method = scnKi043EnclosingMethod(headers, at);
    assert.ok(method !== null, "scnKi043: this._transaction call outside any repository method");
    const occurrence = (occurrences.get(method.name) ?? 0) + 1;
    occurrences.set(method.name, occurrence);
    calls.push({
      method: method.name,
      site: occurrence === 1 ? method.name : `${method.name}#${occurrence}`,
      openParenIndex: at + needle.length - 1,
      closeIndex: parsed.closeIndex,
      argumentSpans: parsed.spans,
      argumentTexts: parsed.spans.map(([from, to]) => sourceText.slice(from, to).trim())
    });
    searchFrom = parsed.closeIndex;
  }
  return { skeletonText, calls };
}

function scnKi043ProfileOracle(sourceText, label) {
  const { skeletonText, calls } = scnKi043TransactionCalls(sourceText);
  assert.ok(calls.length > 0, `${label}: no this._transaction call sites parsed`);
  for (const call of calls) {
    assert.ok(Number.isInteger(call.closeIndex) && call.closeIndex > call.openParenIndex,
      `${label}: ${call.site} did not parse`);
  }
  assert.equal(calls.length, 18, `${label}: expected exactly 18 this._transaction call sites`);
  const shortSites = [];
  const scaleSites = [];
  for (const call of calls) {
    assert.equal(call.argumentTexts.length, 2,
      `${label}: ${call.site} must pass exactly two arguments (work, options); got ${call.argumentTexts.length}`);
    const profile = call.argumentTexts[1];
    assert.ok(profile === "SHORT_TRANSACTION_OPTIONS" || profile === "SCALE_TRANSACTION_OPTIONS",
      `${label}: ${call.site} passes unknown transaction profile ${JSON.stringify(profile)}`);
    if (profile === "SHORT_TRANSACTION_OPTIONS") shortSites.push(call.site);
    else scaleSites.push(call.site);
    assert.doesNotMatch(call.argumentTexts[0], SCN_KI_043_FORBIDDEN_CALLBACK_SYMBOLS,
      `${label}: ${call.site} callback contains a forbidden provider/S3/SQS symbol`);
  }
  assert.equal(shortSites.length, 8, `${label}: short profile must cover exactly 8 sites`);
  assert.equal(scaleSites.length, 10, `${label}: scale profile must cover exactly 10 sites`);
  assert.deepEqual([...shortSites].sort(), [...SCN_KI_043_SHORT_PARTITION].sort(),
    `${label}: short-profile partition mismatch`);
  assert.deepEqual([...scaleSites].sort(), [...SCN_KI_043_SCALE_PARTITION].sort(),
    `${label}: scale-profile partition mismatch`);
  for (const name of new Set(calls.map((call) => call.method))) {
    const count = calls.filter((call) => call.method === name).length;
    if (name === "createRun") assert.equal(count, 2, `${label}: createRun must own exactly two sites`);
    else assert.equal(count, 1, `${label}: ${name} must own exactly one site`);
  }
  const constants = {};
  for (const name of ["SHORT_TRANSACTION_OPTIONS", "SCALE_TRANSACTION_OPTIONS"]) {
    const match = sourceText.match(new RegExp(`const ${name} = ([^;]+);`));
    assert.ok(match, `${label}: missing ${name} initializer`);
    const collapsed = match[1].replace(/\s+/g, "");
    const numbers = collapsed.match(/\{maxWait:([0-9_]+),timeout:([0-9_]+)\}/);
    assert.ok(numbers, `${label}: ${name} initializer is not the frozen literal shape`);
    constants[name] = {
      collapsed,
      maxWait: Number(numbers[1].replace(/_/g, "")),
      timeout: Number(numbers[2].replace(/_/g, ""))
    };
  }
  assert.equal(constants.SHORT_TRANSACTION_OPTIONS.collapsed, "Object.freeze({maxWait:5_000,timeout:15_000})",
    `${label}: SHORT_TRANSACTION_OPTIONS initializer drifted`);
  assert.equal(constants.SCALE_TRANSACTION_OPTIONS.collapsed, "Object.freeze({maxWait:5_000,timeout:30_000})",
    `${label}: SCALE_TRANSACTION_OPTIONS initializer drifted`);
  assert.deepEqual(
    { maxWait: constants.SHORT_TRANSACTION_OPTIONS.maxWait, timeout: constants.SHORT_TRANSACTION_OPTIONS.timeout },
    { maxWait: 5_000, timeout: 15_000 }, `${label}: SHORT_TRANSACTION_OPTIONS values drifted`);
  assert.deepEqual(
    { maxWait: constants.SCALE_TRANSACTION_OPTIONS.maxWait, timeout: constants.SCALE_TRANSACTION_OPTIONS.timeout },
    { maxWait: 5_000, timeout: 30_000 }, `${label}: SCALE_TRANSACTION_OPTIONS values drifted`);
  const clientNeedle = "this.client.$transaction(";
  let clientFrom = 0;
  const clientCalls = [];
  for (;;) {
    const at = skeletonText.indexOf(clientNeedle, clientFrom);
    if (at === -1) break;
    const parsed = scnKi043ArgumentSpans(skeletonText, at + clientNeedle.length - 1);
    clientCalls.push(parsed.spans.map(([from, to]) => sourceText.slice(from, to).trim()));
    clientFrom = parsed.closeIndex;
  }
  assert.equal(clientCalls.length, 1, `${label}: expected exactly one this.client.$transaction dispatch`);
  assert.deepEqual(clientCalls[0], ["callback", "options"],
    `${label}: _transaction must forward (callback, options); no one-argument client.$transaction(callback) branch may remain`);
  return { calls, shortSites, scaleSites, constants };
}

function scnKi043SortedLfDigest(ids) {
  const distinct = [...new Set(ids)];
  distinct.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return createHash("sha256").update(distinct.map((id) => `${id}\n`).join(""), "utf8").digest("hex");
}

function scnKi043ApplyDelegateData(row, data) {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).length === 1 && Number.isInteger(value.increment)) {
      next[key] = (next[key] ?? 0) + value.increment;
    } else {
      next[key] = value;
    }
  }
  return next;
}

function scnKi043MatchesWhere(row, where) {
  return Object.entries(where ?? {}).every(([key, expected]) => {
    if (expected !== null && typeof expected === "object") {
      if (Array.isArray(expected.in)) return expected.in.includes(row[key]);
      return false;
    }
    return row[key] === expected;
  });
}

function scnKi043FakeFixture() {
  const stageId = keywordStageId(RESEARCH, "expansion", 1);
  const research = {
    id: RESEARCH, ownerId: "owner-1", state: "running", generation: 1, contractVersion: 1,
    configSnapshot: { version: 1 }, configFingerprint: FP,
    seeds: ["alpine running vest"], markets: ["GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE", "US"],
    progress: { stages: {} }, selectionRevision: 0, createdAt: NOW
  };
  const stage = {
    id: stageId, researchId: RESEARCH, stage: "expansion", generation: 1, state: "ready",
    expectedCount: 3, terminalCount: 3, succeededCount: 2, skippedCount: 1, failedCount: 0,
    manifestS3Key: null, manifestFingerprint: null, manifestProducedAt: null,
    createdAt: NOW, updatedAt: NOW, completedAt: null,
    aggregationOwner: null, aggregationLeaseToken: null, aggregationLeaseAcquiredAt: null,
    aggregationLeaseExpiresAt: null, aggregationAttempt: 0, safeErrorCode: null, safeErrorMessage: null
  };
  const baseTask = (itemKey) => ({
    id: keywordTaskId(stageId, itemKey), stageId, itemKey,
    inputFingerprint: FP, endpointKey: "keyword_suggestions", requestFingerprint: FP,
    nextAttemptAt: null, state: "pending", attemptCount: 0,
    leaseOwner: null, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null,
    leaseAttempt: 0, dispatchCount: 0, lastDispatchedAt: null,
    createdAt: NOW, updatedAt: NOW, artifactS3Key: null, artifactFingerprint: null,
    terminalAt: null, safeErrorCode: null
  });
  const tasks = [
    { ...baseTask("1:suggestions"), state: "succeeded", attemptCount: 1, artifactS3Key: "runs/a.json", artifactFingerprint: FP, terminalAt: NOW },
    { ...baseTask("0:suggestions"), state: "pending", attemptCount: 1 },
    { ...baseTask("0:related"), state: "skipped", terminalAt: NOW }
  ];
  const attempt = {
    id: "kra_syntheticattempt01", taskId: keywordTaskId(stageId, "0:suggestions"), attemptNumber: 1,
    state: "failed", requestFingerprint: FP, reservationCostUsd: "0.01560000", providerCostUsd: null,
    safeErrorCode: "KEYWORD_PROVIDER_RETRY_NOT_SCHEDULED", resultFingerprint: null,
    plannedAt: NOW, completedAt: NOW, ambiguousAfter: null, createdAt: NOW, updatedAt: NOW
  };
  return { stageId, research, stage, tasks, attempts: [attempt] };
}

function scnKi043FakeClient() {
  const fixture = scnKi043FakeFixture();
  const ops = [];
  const transactions = [];
  const taskStore = new Map(fixture.tasks.map((row) => [row.id, { ...row }]));
  const stageStore = new Map([[fixture.stage.id, { ...fixture.stage }]]);
  const researchStore = new Map([[fixture.research.id, { ...fixture.research }]]);
  const attemptStore = new Map();
  for (const row of fixture.attempts) {
    const clone = { ...row };
    attemptStore.set(row.id, clone);
    attemptStore.set(`${row.taskId}:${row.attemptNumber}`, clone);
  }

  const taskWithIncludes = (row, include) => {
    const enriched = { ...row };
    if (include?.stage) {
      const stage = stageStore.get(row.stageId) ?? null;
      if (stage && include.stage.include?.research) {
        enriched.stage = { ...stage, research: { ...(researchStore.get(stage.researchId) ?? {}) } };
      } else if (stage) {
        enriched.stage = { ...stage };
      } else {
        enriched.stage = null;
      }
    }
    if (include?.attempts) {
      const ordered = [...attemptStore.values()].filter((attempt) => attempt.taskId === row.id)
        .sort((left, right) => right.attemptNumber - left.attemptNumber);
      enriched.attempts = include.attempts.take ? ordered.slice(0, include.attempts.take) : ordered;
    }
    return enriched;
  };

  const stageWithIncludes = (row, include) => {
    const enriched = { ...row };
    if (include?.research) enriched.research = { ...(researchStore.get(row.researchId) ?? {}) };
    if (include?.tasks) {
      const direction = include.tasks.orderBy?.itemKey ?? "asc";
      const list = [...taskStore.values()].filter((task) => task.stageId === row.id)
        .sort((left, right) => direction === "desc"
          ? right.itemKey.localeCompare(left.itemKey)
          : left.itemKey.localeCompare(right.itemKey));
      enriched.tasks = list.map((task) => ({ ...task }));
    }
    return enriched;
  };

  const keywordResearchTask = {
    async findUnique(args) {
      ops.push("keywordResearchTask.findUnique");
      const row = taskStore.get(args.where.id) ?? null;
      return row ? taskWithIncludes(row, args.include) : null;
    },
    async findMany(args) {
      ops.push("keywordResearchTask.findMany");
      return [...taskStore.values()].filter((row) => scnKi043MatchesWhere(row, args?.where)).map((row) => ({ ...row }));
    },
    async create(args) {
      ops.push("keywordResearchTask.create");
      taskStore.set(args.data.id, { ...args.data });
      return { ...args.data };
    },
    async createManyAndReturn(args) {
      ops.push("keywordResearchTask.createManyAndReturn");
      return args.data.map((datum) => { taskStore.set(datum.id, { ...datum }); return { ...datum }; });
    },
    async update(args) {
      ops.push("keywordResearchTask.update");
      const row = taskStore.get(args.where.id);
      assert.ok(row, "scnKi043 fake keywordResearchTask.update target missing");
      const next = scnKi043ApplyDelegateData(row, args.data);
      taskStore.set(args.where.id, next);
      return next;
    },
    async updateMany(args) {
      ops.push("keywordResearchTask.updateMany");
      let count = 0;
      for (const [id, row] of taskStore) {
        if (!scnKi043MatchesWhere(row, args.where)) continue;
        taskStore.set(id, scnKi043ApplyDelegateData(row, args.data));
        count += 1;
      }
      return { count };
    },
    async updateManyAndReturn(args) {
      ops.push("keywordResearchTask.updateManyAndReturn");
      const updated = [];
      for (const [id, row] of taskStore) {
        if (!scnKi043MatchesWhere(row, args.where)) continue;
        const next = scnKi043ApplyDelegateData(row, args.data);
        taskStore.set(id, next);
        updated.push(next);
      }
      return updated;
    }
  };

  const keywordResearchStage = {
    async findUnique(args) {
      ops.push("keywordResearchStage.findUnique");
      const row = stageStore.get(args.where.id) ?? null;
      return row ? stageWithIncludes(row, args.include) : null;
    },
    async findMany(args) {
      ops.push("keywordResearchStage.findMany");
      return [...stageStore.values()]
        .filter((row) => scnKi043MatchesWhere(row, args?.where))
        .map((row) => stageWithIncludes(row, args.include));
    },
    async create(args) {
      ops.push("keywordResearchStage.create");
      stageStore.set(args.data.id, { ...args.data });
      return { ...args.data };
    },
    async update(args) {
      ops.push("keywordResearchStage.update");
      const row = stageStore.get(args.where.id);
      assert.ok(row, "scnKi043 fake keywordResearchStage.update target missing");
      const next = scnKi043ApplyDelegateData(row, args.data);
      stageStore.set(args.where.id, next);
      return next;
    },
    async updateMany(args) {
      ops.push("keywordResearchStage.updateMany");
      let count = 0;
      for (const [id, row] of stageStore) {
        if (!scnKi043MatchesWhere(row, args.where)) continue;
        stageStore.set(id, scnKi043ApplyDelegateData(row, args.data));
        count += 1;
      }
      return { count };
    },
    async updateManyAndReturn(args) {
      ops.push("keywordResearchStage.updateManyAndReturn");
      const updated = [];
      for (const [id, row] of stageStore) {
        if (!scnKi043MatchesWhere(row, args.where)) continue;
        const next = scnKi043ApplyDelegateData(row, args.data);
        stageStore.set(id, next);
        updated.push(next);
      }
      return updated;
    }
  };

  const keywordResearchProviderAttempt = {
    async findUnique(args) {
      ops.push("keywordResearchProviderAttempt.findUnique");
      const key = args.where.id ??
        `${args.where.taskId_attemptNumber.taskId}:${args.where.taskId_attemptNumber.attemptNumber}`;
      const row = attemptStore.get(key) ?? null;
      if (!row) return null;
      const enriched = { ...row };
      if (args.include?.task) {
        const task = taskStore.get(row.taskId) ?? null;
        enriched.task = task ? taskWithIncludes(task, args.include.task.include) : null;
      }
      return enriched;
    },
    async create(args) {
      ops.push("keywordResearchProviderAttempt.create");
      attemptStore.set(args.data.id, { ...args.data });
      return { ...args.data };
    },
    async updateMany(args) {
      ops.push("keywordResearchProviderAttempt.updateMany");
      let count = 0;
      for (const [id, row] of attemptStore) {
        if (!scnKi043MatchesWhere(row, args.where)) continue;
        attemptStore.set(id, scnKi043ApplyDelegateData(row, args.data));
        count += 1;
      }
      return { count };
    },
    async updateManyAndReturn(args) {
      ops.push("keywordResearchProviderAttempt.updateManyAndReturn");
      const updated = [];
      for (const [id, row] of attemptStore) {
        if (!scnKi043MatchesWhere(row, args.where)) continue;
        const next = scnKi043ApplyDelegateData(row, args.data);
        attemptStore.set(id, next);
        updated.push(next);
      }
      return updated;
    }
  };

  const keywordResearch = {
    async findUnique(args) {
      ops.push("keywordResearch.findUnique");
      const row = researchStore.get(args.where.id) ?? null;
      if (!row) return null;
      const enriched = { ...row };
      if (args.include?.stages) {
        enriched.stages = [...stageStore.values()]
          .filter((stage) => stage.researchId === row.id &&
            (args.include.stages.where ? scnKi043MatchesWhere(stage, args.include.stages.where) : true))
          .map((stage) => ({ ...stage }));
      }
      if (args.include?.handoffs) enriched.handoffs = [];
      return enriched;
    },
    async findMany(args) {
      ops.push("keywordResearch.findMany");
      return [...researchStore.values()]
        .filter((row) => scnKi043MatchesWhere(row, args?.where))
        .map((row) => ({ ...row }));
    },
    async create(args) {
      ops.push("keywordResearch.create");
      researchStore.set(args.data.id, { ...args.data });
      return { ...args.data };
    },
    async updateMany(args) {
      ops.push("keywordResearch.updateMany");
      let count = 0;
      for (const [id, row] of researchStore) {
        if (!scnKi043MatchesWhere(row, args.where)) continue;
        researchStore.set(id, scnKi043ApplyDelegateData(row, args.data));
        count += 1;
      }
      return { count };
    }
  };

  const client = {
    keywordResearch,
    keywordResearchTask,
    keywordResearchStage,
    keywordResearchProviderAttempt,
    $queryRaw: () => { throw new Error("scnKi043 fake $queryRaw must not run while prismaSchemaForClient resolves public"); },
    $transaction: async (callback, options) => {
      transactions.push({ options });
      return callback(client);
    }
  };

  return { client, ops, transactions, fixture, stores: { taskStore, stageStore, attemptStore, researchStore } };
}

test("SCN-KI-043 unit: explicit transaction profiles and consolidated contexts", async () => {
  const executedCases = [];
  const registerExecutedCase = (id) => {
    assert.ok(SCN_KI_043_REQUIRED_CASES.includes(id), `scnKi043: unexpected executed case ${id}`);
    assert.ok(!executedCases.includes(id), `scnKi043: duplicate executed case ${id}`);
    executedCases.push(id);
  };

  const sourceText = readFileSync(SCN_KI_043_SOURCE_URL, "utf8");
  assert.equal(createHash("sha256").update(sourceText, "utf8").digest("hex"), SCN_KI_043_SOURCE_SHA256,
    "repository.js under test must be the accepted C112 bytes");

  const oracle = scnKi043ProfileOracle(sourceText, "W6-DB-01 production source");
  assert.ok(oracle.calls.length > 0 && oracle.calls.every((call) => call.closeIndex > call.openParenIndex),
    "W6-DB-01 activation witness: every call site parsed successfully");
  registerExecutedCase("W6-DB-01");

  const stageId = keywordStageId(RESEARCH, "expansion", 1);
  const taskId = keywordTaskId(stageId, "0:suggestions");
  const expectedResearchProjection = {
    id: RESEARCH, state: "running", generation: 1, contractVersion: 1,
    configSnapshot: { version: 1 }, configFingerprint: FP,
    seeds: ["alpine running vest"], markets: ["GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE", "US"]
  };
  const expectedStageProjection = {
    id: stageId, researchId: RESEARCH, stage: "expansion", generation: 1, state: "ready",
    expectedCount: 3, terminalCount: 3, succeededCount: 2, skippedCount: 1, failedCount: 0,
    manifestS3Key: null, manifestFingerprint: null, manifestProducedAt: null, createdAt: NOW
  };
  const expectedTaskProjection = (itemKey, overrides = {}) => ({
    id: keywordTaskId(stageId, itemKey), stageId, itemKey,
    inputFingerprint: FP, endpointKey: "keyword_suggestions", requestFingerprint: FP,
    nextAttemptAt: null, state: "pending", attemptCount: 0, leaseToken: null, leaseExpiresAt: null,
    createdAt: NOW, artifactS3Key: null, artifactFingerprint: null, terminalAt: null, safeErrorCode: null,
    ...overrides
  });

  const taskContextFake = scnKi043FakeClient();
  const taskContextRepo = new PrismaKeywordResearchRepository(taskContextFake.client);
  const taskContext = await taskContextRepo.getTaskContext({ taskId });
  assert.equal(taskContextFake.ops.length, 1, "W6-DB-02: getTaskContext must issue exactly one delegate operation");
  assert.deepEqual(taskContextFake.ops, ["keywordResearchTask.findUnique"]);
  assert.equal(taskContextFake.transactions.length, 0);
  assert.deepEqual(taskContext, {
    outcome: "found",
    research: expectedResearchProjection,
    stage: expectedStageProjection,
    task: expectedTaskProjection("0:suggestions", { state: "pending", attemptCount: 1 }),
    latestAttempt: {
      attemptNumber: 1, state: "failed", requestFingerprint: FP,
      reservationCostUsd: "0.01560000", providerCostUsd: null,
      safeErrorCode: "KEYWORD_PROVIDER_RETRY_NOT_SCHEDULED", resultFingerprint: null,
      plannedAt: NOW, completedAt: NOW, ambiguousAfter: null
    }
  });

  const stageContextFake = scnKi043FakeClient();
  const stageContextRepo = new PrismaKeywordResearchRepository(stageContextFake.client);
  const stageContext = await stageContextRepo.getStageContext({ researchId: RESEARCH, stage: "expansion", generation: 1 });
  assert.equal(stageContextFake.ops.length, 1, "W6-DB-02: getStageContext must issue exactly one delegate operation");
  assert.deepEqual(stageContextFake.ops, ["keywordResearchStage.findUnique"]);
  assert.equal(stageContextFake.transactions.length, 0);
  assert.deepEqual(stageContext.tasks.map((task) => task.itemKey), ["0:related", "0:suggestions", "1:suggestions"]);
  assert.deepEqual(stageContext, {
    outcome: "found",
    research: expectedResearchProjection,
    stage: expectedStageProjection,
    tasks: [
      expectedTaskProjection("0:related", { state: "skipped", terminalAt: NOW }),
      expectedTaskProjection("0:suggestions", { state: "pending", attemptCount: 1 }),
      expectedTaskProjection("1:suggestions", { state: "succeeded", attemptCount: 1, artifactS3Key: "runs/a.json", artifactFingerprint: FP, terminalAt: NOW })
    ]
  });

  const claimFake = scnKi043FakeClient();
  const claimRepo = new PrismaKeywordResearchRepository(claimFake.client);
  const claimed = await claimRepo.claim({ taskId, owner: "worker-a", token: TOKEN }, NOW);
  assert.ok(claimFake.ops.length <= 2, "W6-DB-02: claim operation ceiling is two");
  assert.deepEqual(claimFake.ops, ["keywordResearchTask.findUnique", "keywordResearchTask.updateManyAndReturn"]);
  assert.equal(claimFake.transactions.length, 1);
  assert.deepEqual(claimFake.transactions[0].options, { maxWait: 5_000, timeout: 15_000 },
    "W6-DB-02: claim must receive the SHORT transaction profile per DEC-KI-045");
  assert.deepEqual(claimed, {
    outcome: "claimed",
    task: expectedTaskProjection("0:suggestions", {
      state: "processing", attemptCount: 1, leaseToken: TOKEN, leaseExpiresAt: new Date(NOW.getTime() + 60_000)
    })
  });
  const storedClaimedTask = claimFake.stores.taskStore.get(taskId);
  assert.equal(storedClaimedTask.dispatchCount, 1);
  assert.equal(storedClaimedTask.leaseAttempt, 1);
  assert.equal(storedClaimedTask.leaseOwner, "worker-a");
  assert.equal(storedClaimedTask.leaseAcquiredAt, NOW);

  const aggregatorFake = scnKi043FakeClient();
  const aggregatorRepo = new PrismaKeywordResearchRepository(aggregatorFake.client);
  const aggregation = await aggregatorRepo.claimAggregator(
    { researchId: RESEARCH, stage: "expansion", generation: 1, owner: "aggregator-a", token: TOKEN }, NOW);
  assert.ok(aggregatorFake.ops.length <= 2, "W6-DB-02: claimAggregator operation ceiling is two");
  assert.deepEqual(aggregatorFake.ops, ["keywordResearchStage.findUnique", "keywordResearchStage.updateManyAndReturn"]);
  assert.equal(aggregatorFake.transactions.length, 1);
  assert.deepEqual(aggregatorFake.transactions[0].options, { maxWait: 5_000, timeout: 15_000 },
    "W6-DB-02: claimAggregator must receive the SHORT transaction profile per DEC-KI-045");
  assert.deepEqual(aggregation, {
    outcome: "claimed",
    stage: { ...expectedStageProjection, state: "aggregating" }
  });
  const storedAggregatingStage = aggregatorFake.stores.stageStore.get(stageId);
  assert.equal(storedAggregatingStage.aggregationOwner, "aggregator-a");
  assert.equal(storedAggregatingStage.aggregationLeaseToken, TOKEN);
  assert.equal(storedAggregatingStage.aggregationLeaseAcquiredAt, NOW);
  assert.equal(storedAggregatingStage.aggregationLeaseExpiresAt.getTime(), NOW.getTime() + 120_000);
  assert.equal(storedAggregatingStage.aggregationAttempt, 1);
  registerExecutedCase("W6-DB-02");

  const registeredCases = [...SCN_KI_043_REQUIRED_CASES];
  assert.equal(executedCases.length, registeredCases.length, "scnKi043: executed count must equal registered count");
  assert.ok(registeredCases.every((id) => executedCases.includes(id)), "scnKi043: zero skipped required cases");
  assert.ok(executedCases.every((id) => registeredCases.includes(id)), "scnKi043: zero unexpected executed cases");
  assert.equal(new Set(executedCases).size, executedCases.length, "scnKi043: zero duplicate executions");
  assert.equal(scnKi043SortedLfDigest(executedCases), SCN_KI_043_CASE_SET_DIGEST,
    "scnKi043: executed case set digest must equal the standard sorted-LF digest");
  assert.ok(SCN_KI_043_CONTROL_CASES.every((id) => !executedCases.includes(id)),
    "scnKi043: the negative control is registered separately and is excluded from the case digest");

  const claimCall = oracle.calls.find((call) => call.method === "claim");
  assert.ok(claimCall, "scnKi043: claim transaction site located for the negative control");
  const [optionFrom, optionTo] = claimCall.argumentSpans[1];
  const mutatedSource = sourceText.slice(0, optionFrom - 1) + sourceText.slice(optionTo);
  assert.notEqual(mutatedSource, sourceText);
  assert.equal((mutatedSource.match(/this\._transaction\(/g) ?? []).length, 18,
    "W6-NC-15: the mutation removes exactly one options argument, not a call site");
  assert.throws(() => scnKi043ProfileOracle(mutatedSource, "W6-NC-15 mutated copy"), /options/,
    "W6-NC-15: the unchanged profile oracle must fail on the mutated in-memory copy");
  assert.equal(createHash("sha256").update(readFileSync(SCN_KI_043_SOURCE_URL, "utf8"), "utf8").digest("hex"),
    SCN_KI_043_SOURCE_SHA256, "W6-NC-15: production bytes on disk were never edited");
});
