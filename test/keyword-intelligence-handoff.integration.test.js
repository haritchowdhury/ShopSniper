import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { createPrismaClient } from "../src/prisma-client.js";
import { PrismaKeywordResearchRepository, newResearchId } from "../src/keyword-intelligence/repository.js";
import { mapSelectionToQueries } from "../src/keyword-intelligence/query-mapper.js";
import { selectionItemId } from "../src/keyword-intelligence/selection.js";
import { PrismaRunRepository, newRunId } from "../src/prisma-run-repository.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema, deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true";
const NOW = new Date("2026-08-17T00:00:00.000Z");
const LATER = new Date(NOW.getTime() + 61_000);
const OWNER = "owner_kiw4";
const OTHER = "owner_b";
const SEEDS = ["seed a"];
const NINE_MARKETS = ["US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"].map((code) => ({ code }));
const CONFIG_SNAPSHOT = { anchor: "US", dedup: { stripTokens: [] } };
const CONFIG_FINGERPRINT = fingerprintJson(CONFIG_SNAPSHOT);
const CLIENT_REQUEST_ID_PREFIX = "client-request-id-";

const DB_IDS = ["W4-D01", "W4-D02", "W4-D03", "W4-D04", "W4-D05", "W4-D06"];
const REQUIRED = [...DB_IDS];
const FIVE_OPS = [
  "keywordResearch.findUnique",
  "keywordResearchHandoff.findUnique",
  "run.create",
  "runQuery.createMany",
  "keywordResearchHandoff.create"
];

const registered = new Set();
const executed = [];
const activationWitnesses = [];
const oracleFailures = [];
const skipped = [];

if (!enabled) skipped.push(...DB_IDS);

function utf8Compare(a, b) {
  return Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8"));
}

function digestOf(ids) {
  const sorted = [...ids].sort(utf8Compare);
  return createHash("sha256").update(sorted.map((id) => `${id}\n`).join(""), "utf8").digest("hex");
}

function register(id) {
  assert.equal(registered.has(id), false, `duplicate registration ${id}`);
  registered.add(id);
}

async function runDBCase(t, id, body) {
  register(id);
  await t.test(id, async () => {
    try {
      await body();
      executed.push(id);
      activationWitnesses.push(id);
    } catch (error) {
      oracleFailures.push(id);
      throw error;
    }
  }).catch(() => {});
}

function transactionOps(ops) {
  return ops.filter((op) => FIVE_OPS.includes(op));
}

function clientWithOperationSpy(client) {
  const ops = [];
  const realTransaction = client.$transaction.bind(client);
  const make = (obj, path) => new Proxy(obj, {
    get(target, prop) {
      if (prop === "then") return undefined;
      const value = target[prop];
      const nextPath = path ? `${path}.${String(prop)}` : String(prop);
      if (typeof value === "function") {
        return (...args) => {
          ops.push(nextPath);
          return value.apply(target, args);
        };
      }
      if (value && typeof value === "object") return make(value, nextPath);
      return value;
    }
  });
  client.$transaction = (work, ...rest) => realTransaction((tx) => work(make(tx, "")), ...rest);
  return { client, ops };
}

function clientWithInjectedFailure(client, shouldFail) {
  const realTransaction = client.$transaction.bind(client);
  const make = (obj, path) => new Proxy(obj, {
    get(target, prop) {
      if (prop === "then") return undefined;
      const value = target[prop];
      const nextPath = path ? `${path}.${String(prop)}` : String(prop);
      if (typeof value === "function") {
        return (...args) => {
          if (shouldFail(nextPath, args)) throw new Error(`injected:${nextPath}`);
          return value.apply(target, args);
        };
      }
      if (value && typeof value === "object") return make(value, nextPath);
      return value;
    }
  });
  client.$transaction = (work, ...rest) => realTransaction((tx) => work(make(tx, "")), ...rest);
  return client;
}

function makeSelectionItem(keyword, { seed = SEEDS[0], lane = "category_discovery" } = {}) {
  return {
    itemId: selectionItemId("manual", keyword),
    sourceKind: "manual",
    sourceKeywordId: null,
    originalKeyword: keyword,
    keyword,
    sourceSeeds: [seed],
    lane,
    facets: { audience: [], category: [], channel: [], fit: [], modifier: [] },
    metricsSnapshot: null,
  };
}

function buildSnapshot(research, items) {
  const selectionFingerprint = fingerprintJson({
    contractVersion: "keyword-selection-v1",
    researchId: research.id,
    selectionRevision: research.selectionRevision,
    items,
  });
  const mapped = mapSelectionToQueries(items);
  if (!mapped.ok) throw new Error("test snapshot mapping failed");
  const snapshotItems = items.map((item, index) => ({ ...item, initialQuery: mapped.rows[index].sequence }));
  const snapshot = {
    contractVersion: "keyword-run-snapshot-v1",
    researchId: research.id,
    selectionRevision: research.selectionRevision,
    selectionFingerprint,
    configFingerprint: research.configFingerprint,
    dedupStripTokens: [],
    seeds: research.seeds,
    items: snapshotItems,
  };
  return { selectionFingerprint, snapshotItems, snapshot };
}

async function createCompletedResearch(db, repo, { ownerId = OWNER, seeds = SEEDS, items }) {
  const researchId = newResearchId();
  const created = await repo.create({
    researchId, ownerId, configSnapshot: CONFIG_SNAPSHOT, configFingerprint: CONFIG_FINGERPRINT,
    seeds, markets: NINE_MARKETS,
  }, NOW);
  assert.equal(created.outcome, "created");
  const research = await db.keywordResearch.update({
    where: { id: researchId },
    data: { state: "completed", selection: { items }, selectionRevision: 1, completedAt: NOW, updatedAt: NOW },
  });
  return { researchId, research };
}

function handoffInput(repo, runRepo, research, {
  ownerId = OWNER,
  expectedSelectionRevision = research.selectionRevision,
  clientRequestId,
  selectionFingerprint,
  snapshotItems,
  snapshot,
  runId,
  constructRun,
  constructQueries,
}) {
  return {
    researchId: research.id,
    ownerId,
    expectedSelectionRevision,
    clientRequestId,
    selectionFingerprint,
    items: snapshotItems,
    runId,
    constructRun: constructRun || ((tx, context) => runRepo.createKeywordResearchRun(tx, {
      ...context,
      selectionRevision: research.selectionRevision,
      selectionFingerprint,
      snapshot,
    })),
    constructQueries: constructQueries || ((tx, context) => runRepo.createKeywordResearchQueries(tx, { ...context, snapshot })),
  };
}

function runHandoff(repo, runRepo, research, options) {
  return repo.createRun(handoffInput(repo, runRepo, research, options), NOW);
}

async function assertZeroPartial(researchId, runId, client) {
  const runs = await client.run.findMany({ where: { keywordResearchId: researchId } });
  assert.equal(runs.length, 0, "zero Run rows after an aborted handoff");
  const queries = await client.runQuery.count({ where: { runId } });
  assert.equal(queries, 0, "zero RunQuery rows after an aborted handoff");
  const handoffs = await client.keywordResearchHandoff.count({ where: { researchId } });
  assert.equal(handoffs, 0, "zero handoff rows after an aborted handoff");
  const research = await client.keywordResearch.findUnique({ where: { id: researchId } });
  assert.ok(research, "research row remains after an aborted handoff");
}

async function disconnect(client) {
  await client.$disconnect().catch(() => {});
}

function assertResearchRunRow(runRow, { runId, researchId, revision, now, clientRequestId, fingerprint }) {
  assert.equal(runRow.id, runId);
  assert.equal(runRow.state, "awaiting_query_confirmation");
  assert.equal(runRow.phase, "query_review");
  assert.equal(runRow.stage, "awaiting_query_confirmation");
  assert.equal(runRow.queryRevision, 1);
  assert.equal(runRow.queryPlanReadyAt.getTime(), now.getTime());
  assert.equal(runRow.keywordResearchId, researchId);
  assert.equal(runRow.keywordSelectionRevision, revision);
  assert.equal(runRow.queryPlanSource, "keyword_research");
  assert.equal(runRow.confirmedQueryRevision, null);
  assert.equal(runRow.queriesConfirmedAt, null);
  assert.equal(runRow.leaseOwner, null);
  assert.equal(runRow.leaseToken, null);
  assert.equal(runRow.keywordSelectionSnapshot.selectionFingerprint, fingerprint);
  assert.equal(runRow.keywordSelectionSnapshot.researchId, researchId);
  assert.equal(runRow.keywordSelectionSnapshot.selectionRevision, revision);
  assert.equal(runRow.keywordSelectionSnapshot.contractVersion, "keyword-run-snapshot-v1");
  assert.equal(runRow.keywordSelectionSnapshot.dedupStripTokens.length, 0);
  void clientRequestId;
}

const CASE_BODIES = {
  "W4-D01": async ({ scopedUrl }) => {
    const { client, ops } = clientWithOperationSpy(createPrismaClient(scopedUrl));
    const repo = new PrismaKeywordResearchRepository(client);
    const runRepo = new PrismaRunRepository(client);

    const items1 = [makeSelectionItem("boutique frames")];
    const r1 = await createCompletedResearch(client, repo, { items: items1 });
    const h1 = buildSnapshot(r1.research, items1);
    const runId1 = newRunId();
    const out1 = await runHandoff(repo, runRepo, r1.research, {
      clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0001`, ...h1, runId: runId1,
    });
    assert.equal(out1.outcome, "created");
    assert.equal(out1.run.id, runId1);
    assert.deepEqual(transactionOps(ops), FIVE_OPS, "exactly five named repository operations per handoff (N=1)");

    const runRow1 = await client.run.findUnique({ where: { id: runId1 } });
    assertResearchRunRow(runRow1, {
      runId: runId1, researchId: r1.researchId, revision: 1, now: NOW,
      clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0001`, fingerprint: h1.selectionFingerprint,
    });
    assert.deepEqual(runRow1.keywordSelectionSnapshot, h1.snapshot, "immutable keyword selection snapshot persisted byte-for-byte");

    const queries1 = await client.runQuery.findMany({ where: { runId: runId1 }, orderBy: { sequence: "asc" } });
    assert.equal(queries1.length, 1, "N=1 RunQuery rows");
    assert.equal(queries1[0].runId, runId1);
    assert.equal(queries1[0].categoryIndex, 0);
    assert.equal(queries1[0].query, "site:myshopify.com/products boutique frames");
    assert.equal(queries1[0].source, "generated");
    assert.equal(queries1[0].validationState, "pending");
    assert.equal(queries1[0].generationReason, "keyword_research");
    assert.equal(queries1[0].keywordResearchItemId, items1[0].itemId, "complete query item lineage");
    assert.equal(queries1[0].probeFingerprint, null);
    assert.equal(queries1[0].probedAt, null);

    const handoff1 = await client.keywordResearchHandoff.findUnique({
      where: { researchId_clientRequestId: { researchId: r1.researchId, clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0001` } },
    });
    assert.ok(handoff1, "handoff row created");
    assert.equal(handoff1.runId, runId1);
    assert.equal(handoff1.selectionRevision, 1);
    assert.equal(handoff1.selectionFingerprint, h1.selectionFingerprint);

    ops.length = 0;
    const items100 = Array.from({ length: 100 }, (_, index) => makeSelectionItem(`synthetic phrase ${index}`));
    const r100 = await createCompletedResearch(client, repo, { items: items100 });
    const h100 = buildSnapshot(r100.research, items100);
    const runId100 = newRunId();
    const out100 = await runHandoff(repo, runRepo, r100.research, {
      clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0002`, ...h100, runId: runId100,
    });
    assert.equal(out100.outcome, "created");
    assert.deepEqual(transactionOps(ops), FIVE_OPS, "exactly five named repository operations per handoff (N=100)");

    const queries100 = await client.runQuery.count({ where: { runId: runId100 } });
    assert.equal(queries100, 100, "exactly N=100 RunQuery rows");
    const handoffs100 = await client.keywordResearchHandoff.count({ where: { researchId: r100.researchId } });
    assert.equal(handoffs100, 1, "one handoff row for the 100-item handoff");
    await disconnect(client);
  },

  "W4-D02": async ({ scopedUrl }) => {
    async function runAt(scopedUrl, targets, body) {
      const client = clientWithInjectedFailure(createPrismaClient(scopedUrl), (path) => Object.hasOwn(targets, path));
      const repo = new PrismaKeywordResearchRepository(client);
      const runRepo = new PrismaRunRepository(client);
      await body({ client, repo, runRepo });
      await disconnect(client);
    }

    const items = [makeSelectionItem("rollback phrase")];

    await runAt(scopedUrl, { "run.create": true }, async ({ client, repo, runRepo }) => {
      const r = await createCompletedResearch(client, repo, { items });
      const h = buildSnapshot(r.research, items);
      const runId = newRunId();
      await assert.rejects(
        () => runHandoff(repo, runRepo, r.research, {
          clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0003`, ...h, runId,
        }),
        /injected:run\.create/,
        "throw at Run create escapes after rollback"
      );
      await assertZeroPartial(r.researchId, runId, client);
    });

    await runAt(scopedUrl, { "runQuery.createMany": true }, async ({ client, repo, runRepo }) => {
      const r = await createCompletedResearch(client, repo, { items });
      const h = buildSnapshot(r.research, items);
      const runId = newRunId();
      await assert.rejects(
        () => runHandoff(repo, runRepo, r.research, {
          clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0004`, ...h, runId,
        }),
        /injected:runQuery\.createMany/,
        "throw at RunQuery createMany escapes after rollback"
      );
      await assertZeroPartial(r.researchId, runId, client);
    });

    await runAt(scopedUrl, {}, async ({ client, repo, runRepo }) => {
      const r = await createCompletedResearch(client, repo, { items });
      const h = buildSnapshot(r.research, items);
      const runId = newRunId();
      const invalid = await repo.createRun(handoffInput(repo, runRepo, r.research, {
        clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0005`, ...h, runId,
        constructRun: async (tx, context) => {
          const created = await runRepo.createKeywordResearchRun(tx, {
            ...context,
            selectionRevision: r.research.selectionRevision,
            selectionFingerprint: h.selectionFingerprint,
            snapshot: h.snapshot,
          });
          return { ...created, id: "run_wrong" };
        },
      }), NOW);
      assert.equal(invalid.outcome, "conflict", "invalid Run output maps to a conflict only after rollback");
      assert.equal(invalid.code, "KEYWORD_RUN_HANDOFF_INVALID");
      await assertZeroPartial(r.researchId, runId, client);
    });

    await runAt(scopedUrl, {}, async ({ client, repo, runRepo }) => {
      const r = await createCompletedResearch(client, repo, { items });
      const h = buildSnapshot(r.research, items);
      const runId = newRunId();
      const invalid = await repo.createRun(handoffInput(repo, runRepo, r.research, {
        clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0006`, ...h, runId,
        constructQueries: async (tx, context) => {
          const rows = await runRepo.createKeywordResearchQueries(tx, { ...context, snapshot: h.snapshot });
          return rows.slice(0, rows.length - 1);
        },
      }), NOW);
      assert.equal(invalid.outcome, "conflict", "invalid query output maps to a conflict only after rollback");
      assert.equal(invalid.code, "KEYWORD_RUN_HANDOFF_INVALID");
      await assertZeroPartial(r.researchId, runId, client);
    });
  },

  "W4-D03": async ({ scopedUrl }) => {
    const client = createPrismaClient(scopedUrl);
    const repo = new PrismaKeywordResearchRepository(client);
    const runRepo = new PrismaRunRepository(client);
    const items = [makeSelectionItem("draft phrase")];

    const owned = await createCompletedResearch(client, repo, { items });
    const hOwned = buildSnapshot(owned.research, items);
    const ownerBRunId = newRunId();
    const ownerB = await repo.createRun(handoffInput(repo, runRepo, owned.research, {
      ownerId: OTHER,
      clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0007`,
      ...hOwned,
      runId: ownerBRunId,
    }), NOW);
    assert.equal(ownerB.outcome, "not_found", "owner B predicate yields not_found with zero writes");
    await assertZeroPartial(owned.researchId, ownerBRunId, client);

    const stale = await createCompletedResearch(client, repo, { items });
    const hStale = buildSnapshot(stale.research, items);
    const staleRunId = newRunId();
    const staleOut = await repo.createRun(handoffInput(repo, runRepo, stale.research, {
      expectedSelectionRevision: 2,
      clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0008`,
      ...hStale,
      runId: staleRunId,
    }), NOW);
    assert.equal(staleOut.outcome, "conflict", "stale revision predicate yields a conflict with zero writes");
    assert.equal(staleOut.code, "KEYWORD_SELECTION_REVISION_CONFLICT");
    await assertZeroPartial(stale.researchId, staleRunId, client);

    const conflictedId = newResearchId();
    const conflicted = await repo.create({
      researchId: conflictedId, ownerId: OWNER, configSnapshot: CONFIG_SNAPSHOT,
      configFingerprint: CONFIG_FINGERPRINT, seeds: SEEDS, markets: NINE_MARKETS,
    }, NOW);
    assert.equal(conflicted.outcome, "created");
    const hConflicted = buildSnapshot(conflicted.research, items);
    const conflictedRunId = newRunId();
    const conflictedOut = await repo.createRun(handoffInput(repo, runRepo, conflicted.research, {
      expectedSelectionRevision: 1,
      clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0009`,
      ...hConflicted,
      runId: conflictedRunId,
    }), NOW);
    assert.equal(conflictedOut.outcome, "conflict", "conflicted canonical draft predicate yields a conflict with zero writes");
    assert.equal(conflictedOut.code, "KEYWORD_RESEARCH_NOT_COMPLETED");
    await assertZeroPartial(conflictedId, conflictedRunId, client);

    const researchRow = await client.keywordResearch.findUnique({ where: { id: conflictedId } });
    assert.equal(researchRow.state, "queued", "not-completed research stays unchanged");
    await disconnect(client);
  },

  "W4-D04": async ({ scopedUrl }) => {
    const client = createPrismaClient(scopedUrl);
    const repo = new PrismaKeywordResearchRepository(client);
    const runRepo = new PrismaRunRepository(client);
    const items = [makeSelectionItem("replay phrase")];
    const r = await createCompletedResearch(client, repo, { items });
    const h = buildSnapshot(r.research, items);
    const clientRequestId = `${CLIENT_REQUEST_ID_PREFIX}0010`;

    const concurrent = await Promise.allSettled([
      runHandoff(repo, runRepo, r.research, { clientRequestId, ...h, runId: newRunId() }),
      runHandoff(repo, runRepo, r.research, { clientRequestId, ...h, runId: newRunId() }),
    ]);
    const fulfilled = concurrent.filter((result) => result.status === "fulfilled");
    assert.ok(fulfilled.length >= 1, "at least one concurrent equal-key call succeeds");
    for (const result of fulfilled) {
      assert.ok(["created", "found"].includes(result.value.outcome), "winning concurrent call is created or replay found");
    }

    const runs = await client.run.findMany({ where: { keywordResearchId: r.researchId } });
    assert.equal(runs.length, 1, "exactly one Run total under concurrent equal-key+fingerprint replay");
    const survivingRunId = runs[0].id;

    const replay = await runHandoff(repo, runRepo, r.research, {
      clientRequestId, ...h, runId: newRunId(),
    });
    assert.equal(replay.outcome, "found", "identical retry returns the same Run");
    assert.equal(replay.run.id, survivingRunId, "identical retry resolves to the surviving Run");

    const unequalFp = fingerprintJson({
      contractVersion: "keyword-selection-v1",
      researchId: r.researchId,
      selectionRevision: 1,
      items: [makeSelectionItem("other replay phrase")],
    });
    const fpConflict = await repo.createRun(handoffInput(repo, runRepo, r.research, {
      ...h,
      selectionFingerprint: unequalFp,
      clientRequestId,
      runId: newRunId(),
    }), NOW);
    assert.equal(fpConflict.outcome, "conflict", "unequal fingerprint under the same client key is a conflict");

    const revConflict = await repo.createRun(handoffInput(repo, runRepo, r.research, {
      expectedSelectionRevision: 2,
      clientRequestId,
      ...h,
      runId: newRunId(),
    }), NOW);
    assert.equal(revConflict.outcome, "conflict", "unequal revision under the same client key is a conflict");

    const runsAfter = await client.run.findMany({ where: { keywordResearchId: r.researchId } });
    assert.equal(runsAfter.length, 1, "no second Run after unequal retries");
    const queries = await client.runQuery.count({ where: { runId: survivingRunId } });
    assert.equal(queries, items.length, "no duplicate queries");
    const handoffs = await client.keywordResearchHandoff.count({ where: { researchId: r.researchId } });
    assert.equal(handoffs, 1, "no duplicate handoff rows");
    await disconnect(client);
  },

  "W4-D05": async ({ scopedUrl }) => {
    const client = createPrismaClient(scopedUrl);
    const repo = new PrismaKeywordResearchRepository(client);
    const runRepo = new PrismaRunRepository(client);
    const items = [makeSelectionItem("snapshot phrase one"), makeSelectionItem("snapshot phrase two")];
    const r = await createCompletedResearch(client, repo, { items });
    const h = buildSnapshot(r.research, items);
    const runId = newRunId();
    const out = await runHandoff(repo, runRepo, r.research, {
      clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0011`, ...h, runId,
    });
    assert.equal(out.outcome, "created");

    const preEditRun = await client.run.findUnique({ where: { id: runId } });
    const preEditSnapshot = structuredClone(preEditRun.keywordSelectionSnapshot);
    const preEditQueries = (await client.runQuery.findMany({ where: { runId }, orderBy: { sequence: "asc" } }))
      .map((row) => ({ id: row.id, sequence: row.sequence, query: row.query, categoryIndex: row.categoryIndex, keywordResearchItemId: row.keywordResearchItemId }));
    assert.equal(preEditQueries.length, items.length, "exactly N original query links before the edit");

    const saved = await repo.saveSelection({
      researchId: r.researchId, ownerId: OWNER, expectedRevision: 1,
      items: [makeSelectionItem("post edit phrase")],
    }, LATER);
    assert.equal(saved.outcome, "created");
    assert.equal(saved.selectionRevision, 2, "later selection CAS advances the research revision");

    const edited = await runRepo.replaceEditableQueries(runId, OWNER, 1, [
      { id: preEditQueries[0].id, categoryIndex: preEditQueries[0].categoryIndex, query: "site:myshopify.com/products edited phrase" },
      { id: preEditQueries[1].id, categoryIndex: preEditQueries[1].categoryIndex, query: preEditQueries[1].query },
    ], LATER);
    assert.ok(edited, "research query edit succeeds after the handoff");

    const postEditRun = await client.run.findUnique({ where: { id: runId } });
    const postEditQueries = (await client.runQuery.findMany({ where: { runId }, orderBy: { sequence: "asc" } }))
      .map((row) => ({ id: row.id, sequence: row.sequence, query: row.query, categoryIndex: row.categoryIndex, keywordResearchItemId: row.keywordResearchItemId }));

    assert.deepEqual(postEditRun.keywordSelectionSnapshot, preEditSnapshot, "live research does not alter the immutable snapshot");
    assert.equal(postEditRun.keywordSelectionRevision, 1, "selection revision stays frozen at the handoff revision");
    assert.equal(postEditRun.keywordSelectionSnapshot.selectionRevision, 1);
    assert.equal(postEditQueries.length, items.length, "exactly N query links after the edit");
    assert.deepEqual(
      postEditQueries.map((row) => row.keywordResearchItemId),
      preEditQueries.map((row) => row.keywordResearchItemId),
      "item lineage is unchanged by the edit"
    );
    assert.notEqual(postEditQueries[0].query, preEditQueries[0].query, "edit changed only the query text");
    assert.equal(postEditQueries[0].keywordResearchItemId, preEditQueries[0].keywordResearchItemId);
    await disconnect(client);
  },

  "W4-D06": async ({ scopedUrl }) => {
    const client = createPrismaClient(scopedUrl);
    const repo = new PrismaKeywordResearchRepository(client);
    const runRepo = new PrismaRunRepository(client);

    const legacyRun = await runRepo.createRun(OWNER, [{ originalShopType: "seed a", shopType: "seed a" }]);
    assert.equal(legacyRun.queryPlanSource, "legacy", "legacy run keeps the default discriminator");
    assert.equal(legacyRun.keywordResearchId, null, "legacy run carries null keyword lineage");
    assert.equal(legacyRun.keywordSelectionRevision, null);
    assert.equal(legacyRun.keywordSelectionSnapshot, null);

    const loaded = await runRepo.getEditableQueries(legacyRun.id, OWNER);
    assert.equal(loaded.id, legacyRun.id, "legacy run loads through the legacy repository path");

    await client.run.update({
      where: { id: legacyRun.id },
      data: { state: "awaiting_query_confirmation", phase: "query_review", stage: "awaiting_query_confirmation" },
    });
    const editedLegacy = await runRepo.replaceEditableQueries(legacyRun.id, OWNER, 0, [
      { id: null, categoryIndex: 0, query: "site:myshopify.com/products legacy edit" },
    ], NOW);
    assert.ok(editedLegacy, "legacy edit succeeds through the legacy repository path");
    assert.equal(editedLegacy.queries.length, 1);
    assert.equal(editedLegacy.queries[0].source, "user_added");
    assert.equal(editedLegacy.queries[0].keywordResearchItemId, null, "legacy rows carry no keyword item lineage");

    const { client: spyClient, ops } = clientWithOperationSpy(createPrismaClient(scopedUrl));
    const repoSpy = new PrismaKeywordResearchRepository(spyClient);
    const runRepoSpy = new PrismaRunRepository(spyClient);
    const items = Array.from({ length: 100 }, (_, index) => makeSelectionItem(`bulk phrase ${index}`));
    const r = await createCompletedResearch(spyClient, repoSpy, { items });
    const h = buildSnapshot(r.research, items);
    const runId = newRunId();
    const out = await runHandoff(repoSpy, runRepoSpy, r.research, {
      clientRequestId: `${CLIENT_REQUEST_ID_PREFIX}0012`, ...h, runId,
    });
    assert.equal(out.outcome, "created");
    const handoffOps = transactionOps(ops);
    assert.deepEqual(handoffOps, FIVE_OPS, "100-row handoff is five named operations with one bulk insert");
    assert.equal(handoffOps.filter((op) => op === "runQuery.createMany").length, 1, "one bulk handoff insert for 100 rows");
    assert.equal(await client.runQuery.count({ where: { runId } }), 100, "exactly 100 RunQuery rows");

    const editStart = ops.length;
    const rowsBefore = await client.runQuery.findMany({ where: { runId }, orderBy: { sequence: "asc" } });
    const editedResearch = await runRepoSpy.replaceEditableQueries(runId, OWNER, 1,
      rowsBefore.map((row) => ({ id: row.id, categoryIndex: row.categoryIndex, query: row.query })),
      LATER);
    assert.ok(editedResearch, "100-row research edit succeeds");
    assert.equal(editedResearch.queries.length, 100);
    const editOps = ops.slice(editStart);
    assert.equal(editOps.filter((op) => op.startsWith("runQuery.find")).length, 0, "no per-row query reads (no N+1)");
    assert.equal(editOps.filter((op) => op === "run.findFirst").length, 1, "one bounded run+queries read");
    assert.equal(editOps.filter((op) => op === "run.findUnique").length, 1, "one terminal run read");
    assert.equal(editOps.filter((op) => op === "run.updateMany").length, 1, "one revision CAS");
    assert.equal(editOps.filter((op) => op === "runQuery.deleteMany").length, 1, "one bulk rewrite delete");
    assert.equal(editOps.filter((op) => op === "runQuery.createMany").length, 1, "one bulk rewrite insert");
    await disconnect(spyClient);
    await disconnect(client);
  },
};

test("KI-W4 database handoff registry (D01-D06 in one disposable schema)", { skip: !enabled }, async (t) => {
  const schema = `kiw4_handoff_${Date.now().toString(36)}_${process.pid}`;
  let admin;
  let db;
  try {
    const harness = await createIsolatedTestSchema(schema);
    admin = harness.admin;
    deployPrismaMigrations(harness.scopedUrl);
    db = createPrismaClient(harness.scopedUrl);
    await assertMigrationStayedInSchema(db, schema);
    const ctx = { db, scopedUrl: harness.scopedUrl, schema };
    for (const id of DB_IDS) {
      await runDBCase(t, id, () => CASE_BODIES[id](ctx));
    }
  } finally {
    if (db) await db.$disconnect().catch(() => {});
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const [remaining] = await admin.$queryRawUnsafe(
        "SELECT schema_name::text AS name FROM information_schema.schemata WHERE schema_name = $1", schema
      );
      assert.equal(remaining, undefined, `disposable schema ${schema} must be absent after DROP`);
      await admin.$disconnect();
    }
  }
});

test("KI-W4 database execution certificate", () => {
  const required = [...REQUIRED].sort(utf8Compare);
  const registeredSorted = [...registered].sort(utf8Compare);
  const executedSorted = [...executed].sort(utf8Compare);
  const skippedSorted = [...skipped].sort(utf8Compare);
  const witnessesSorted = [...activationWitnesses].sort(utf8Compare);
  const failuresSorted = [...oracleFailures].sort(utf8Compare);
  if (enabled) {
    assert.deepEqual(registeredSorted, required, "required equals registered");
    assert.deepEqual(executedSorted, required, "required equals executed");
    assert.deepEqual(skippedSorted, [], "zero skipped");
    assert.deepEqual(failuresSorted, [], "zero oracle failures");
    assert.equal(witnessesSorted.length, required.length, "every ID carries an activation witness");
  } else {
    assert.deepEqual(registeredSorted, [], "no registrations while the database opt-in is absent");
    assert.deepEqual(executedSorted, [], "no executions while the database opt-in is absent");
    assert.deepEqual(skippedSorted, required, "all six IDs are listed as skipped without the database opt-in");
    assert.deepEqual(witnessesSorted, [], "no activation witnesses while skipped");
  }
  const certificate = {
    registry: "database",
    required,
    registered: registeredSorted,
    executed: executedSorted,
    skipped: skippedSorted,
    activationWitnesses: witnessesSorted,
    oracleFailures: failuresSorted,
    digests: {
      required: digestOf(required),
      registered: digestOf(registeredSorted),
      executed: digestOf(executedSorted),
    },
  };
  process.stdout.write(`KI_W4_EXECUTION_CERTIFICATE=${JSON.stringify(certificate)}\n`);
});
