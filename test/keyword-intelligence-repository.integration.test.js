import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPrismaClient } from "../src/prisma-client.js";
import { PrismaKeywordResearchRepository, keywordStageId, keywordTaskId,
  newLeaseToken, newResearchId, selectionItemId } from "../src/keyword-intelligence/repository.js";
import { createDefaultSelection } from "../src/keyword-intelligence/selection.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const fp = (value) => createHash("sha256").update(String(value)).digest("hex");

const NINE_MARKETS = ["US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"].map((code) => ({ code }));

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const NOW = new Date("2026-08-17T00:00:00.000Z");
const LATER = new Date(NOW.getTime() + 121_000);
const EARLY = new Date(NOW.getTime() + 61_000);

const KEYWORD_TABLES = {
  KeywordResearch: ["id", "ownerId", "state", "generation", "contractVersion", "configSnapshot",
    "configFingerprint", "seeds", "markets", "progress", "result", "resultFingerprint", "selection",
    "selectionRevision", "safeErrorCode", "safeErrorMessage", "createdAt", "startedAt", "completedAt",
    "updatedAt"],
  KeywordResearchStage: ["id", "researchId", "stage", "generation", "manifestS3Key",
    "manifestFingerprint", "manifestProducedAt", "expectedCount", "terminalCount", "succeededCount",
    "skippedCount", "failedCount", "cancelledCount", "state", "version", "aggregationOwner",
    "aggregationLeaseToken", "aggregationLeaseAcquiredAt", "aggregationLeaseExpiresAt",
    "aggregationAttempt", "safeErrorCode", "safeErrorMessage", "createdAt", "updatedAt", "completedAt"],
  KeywordResearchTask: ["id", "stageId", "itemKey", "inputFingerprint", "endpointKey",
    "requestFingerprint", "nextAttemptAt", "state", "attemptCount", "dispatchCount",
    "lastDispatchedAt", "leaseOwner", "leaseToken", "leaseAcquiredAt", "leaseExpiresAt", "leaseAttempt",
    "artifactS3Key", "artifactFingerprint", "terminalAt", "safeErrorCode", "safeErrorMessage",
    "createdAt", "updatedAt"],
  KeywordResearchCache: ["requestFingerprint", "cacheKey", "endpointKey", "contractVersion",
    "normalizedResponse", "resultFingerprint", "createdAt", "expiresAt"],
  KeywordResearchProviderAttempt: ["id", "taskId", "attemptNumber", "state", "requestFingerprint",
    "plannedAt", "claimedAt", "ambiguousAfter", "completedAt", "reservationCostUsd",
    "providerCostUsd", "safeErrorCode", "resultFingerprint", "createdAt", "updatedAt"],
  KeywordProviderThrottle: ["provider", "nextAllowedAt", "updatedAt"],
  KeywordResearchHandoff: ["id", "researchId", "selectionRevision", "clientRequestId",
    "selectionFingerprint", "runId", "createdAt"]
};

const ENUM_VALUES = {
  KeywordResearchState: ["queued", "running", "completed", "failed"],
  KeywordResearchStageName: ["expansion", "anchor_screen", "market_overview"],
  KeywordResearchStageState: ["collecting", "ready", "aggregating", "completed", "failed"],
  KeywordResearchTaskState: ["pending", "processing", "succeeded", "skipped", "failed"],
  RunQueryPlanSource: ["legacy", "keyword_research"]
};

const REQUIRED_UNIQUE_INDEXES = [
  "KeywordResearchStage_researchId_stage_generation_key",
  "KeywordResearchTask_stageId_itemKey_key",
  "KeywordResearchTask_leaseToken_key",
  "KeywordResearchProviderAttempt_taskId_attemptNumber_key",
  "KeywordResearchHandoff_researchId_clientRequestId_key",
  "KeywordResearchHandoff_runId_key"
];

async function catalogAssertion(db, schema) {
  const columns = await db.$queryRawUnsafe(`
    SELECT table_name::text AS table_name, column_name::text AS column_name
    FROM information_schema.columns WHERE table_schema = '${schema}'
      AND table_name IN ('${Object.keys(KEYWORD_TABLES).join("','")}')
    ORDER BY table_name, ordinal_position`);
  const byTable = new Map();
  for (const row of columns) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
    byTable.get(row.table_name).push(row.column_name);
  }
  for (const [table, expectedColumns] of Object.entries(KEYWORD_TABLES)) {
    const actual = byTable.get(table) ?? [];
    assert.deepEqual([...actual].sort(), [...expectedColumns].sort(), `${table} columns`);
  }
  for (const [enumName, values] of Object.entries(ENUM_VALUES)) {
    const rows = await db.$queryRawUnsafe(`
      SELECT e.enumlabel::text AS label FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = '${schema}' AND t.typname = '${enumName}' ORDER BY e.enumsortorder`);
    assert.deepEqual(rows.map(({ label }) => label), values, `${enumName} values`);
  }
  const indexes = await db.$queryRawUnsafe(`
    SELECT indexname::text AS indexname FROM pg_indexes
    WHERE schemaname = '${schema}' AND tablename IN ('${Object.keys(KEYWORD_TABLES).join("','")}')`);
  const indexNames = new Set(indexes.map(({ indexname }) => indexname));
  for (const name of REQUIRED_UNIQUE_INDEXES) {
    assert.ok(indexNames.has(name), `missing unique index ${name}`);
  }
  const runColumns = await db.$queryRawUnsafe(`
    SELECT column_name::text AS column_name FROM information_schema.columns
    WHERE table_schema = '${schema}' AND table_name = 'Run' AND column_name IN
      ('keywordResearchId','keywordSelectionRevision','keywordSelectionSnapshot','queryPlanSource')`);
  assert.equal(runColumns.length, 4, "Run lineage columns");
  const runQueryColumns = await db.$queryRawUnsafe(`
    SELECT column_name::text AS column_name FROM information_schema.columns
    WHERE table_schema = '${schema}' AND table_name = 'RunQuery' AND column_name = 'keywordResearchItemId'`);
  assert.equal(runQueryColumns.length, 1, "RunQuery lineage column");
}

async function freshResearch(repo, researchId, ownerId = "owner_kiw1", seedCount = 1) {
  const seeds = Array.from({ length: seedCount }, (_, index) => `seed ${index}`);
  const created = await repo.create({ researchId, ownerId, configSnapshot: { anchor: "US" },
    configFingerprint: fp("c"), seeds, markets: NINE_MARKETS }, NOW);
  assert.equal(created.outcome, "created");
  return created;
}

const expansionTasksFor = (seedCount = 1) => Array.from({ length: seedCount * 2 }, (_, index) => {
  const suffix = index % 2 === 0 ? "suggestions" : "related";
  return {
    itemKey: `${Math.floor(index / 2)}:${suffix}`,
    inputFingerprint: fp(`i${index}`),
    endpointKey: suffix === "suggestions" ? "keyword_suggestions" : "related_keywords",
    requestFingerprint: fp(`r${index}`)
  };
});

const marketTasksFor = () => ["GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"].map((code) => ({
  itemKey: `${code}:0`, inputFingerprint: fp(`market-${code}-input`),
  endpointKey: "keyword_overview", requestFingerprint: fp(`market-${code}-request`)
}));

async function completeStageTasks(db, repo, stageId, itemKeys, state = "succeeded", at = NOW) {
  for (const itemKey of itemKeys) {
    const taskId = keywordTaskId(stageId, itemKey);
    const token = newLeaseToken();
    assert.equal((await repo.claim({ taskId, owner: "worker", token }, at)).outcome, "claimed");
    assert.equal((await repo.terminalize({ taskId, token, state,
      artifactS3Key: `runs/${stageId}/${itemKey}.json`, artifactFingerprint: fp(itemKey) }, at)).outcome,
    "terminal");
  }
}

async function advanceToMarketStage(db, repo, researchId) {
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, initialized.stage.id, initialized.tasks.map((task) => task.itemKey));
  const expAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token: expAgg }, NOW);
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("anchor-input"),
    endpointKey: "keyword_overview", requestFingerprint: fp("anchor-request") };
  const candidate = await repo.publishCandidateManifest({ researchId, generation: 1, token: expAgg,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  await completeStageTasks(db, repo, candidate.nextStage.id, ["US:0"]);
  const ancAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "anchor_screen", generation: 1, owner: "a", token: ancAgg }, NOW);
  const shortlist = await repo.publishShortlist({ researchId, generation: 1, token: ancAgg,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks: marketTasksFor() }, NOW);
  await completeStageTasks(db, repo, shortlist.nextStage.id, shortlist.tasks.map((task) => task.itemKey));
  const mktToken = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "market_overview", generation: 1, owner: "a", token: mktToken }, NOW);
  return { mktToken, marketStageId: shortlist.nextStage.id };
}

function makeKeywordRow(keyword, overrides = {}) {
  return {
    itemId: selectionItemId("calculated", keyword),
    keyword,
    originalKeyword: keyword,
    seed: "seed 0",
    sourceSeeds: ["seed 0"],
    lane: "category_discovery",
    facets: { audience: [], category: [], channel: [], fit: [], modifier: [] },
    metricsSnapshot: {
      searchVolume: 100, cpc: 1.2, competition: 0.5, competitionLevel: "MEDIUM",
      keywordDifficulty: 30, mainIntent: "commercial", commercialIntent: 0.8,
      monthlyHistory: [], trendSlope: 0.1, flags: [], opportunityScore: 90,
      recommended: true, mergedInto: null, availableMarkets: ["US"],
      marketMetrics: { US: { searchVolume: 100 } }
    },
    recommended: true, opportunityScore: 90, searchVolume: 100, mergedInto: null,
    ...overrides
  };
}

function makeResult(keywords, researchId = "") {
  return {
    contractVersion: 1, researchId, generation: 1, configFingerprint: fp("c"),
    seeds: ["seed 0"], markets: NINE_MARKETS, summary: {}, keywords, clusters: []
  };
}

const defaultSelectionFor = (keywords) => {
  const result = makeResult(keywords);
  return createDefaultSelection(keywords).items;
};

function injectFailures(target, shouldFail) {
  const make = (obj, path) => new Proxy(obj, {
    get(t, prop) {
      if (prop === "then") return undefined;
      const value = t[prop];
      const nextPath = path ? `${path}.${String(prop)}` : String(prop);
      if (typeof value === "function") {
        return (...args) => {
          if (shouldFail(nextPath, args)) throw new Error(`injected:${nextPath}`);
          return value.apply(t, args);
        };
      }
      if (value && typeof value === "object") return make(value, nextPath);
      return value;
    }
  });
  return make(target, "");
}

function clientWithInjectedFailure(client, shouldFail) {
  const realTransaction = client.$transaction.bind(client);
  client.$transaction = (work, ...rest) => realTransaction((tx) => work(injectFailures(tx, shouldFail)), ...rest);
  return client;
}

function clientWithInjectedZeroCount(client, shouldZero) {
  const realTransaction = client.$transaction.bind(client);
  client.$transaction = (work, ...rest) => realTransaction((tx) => work(injectZeroCounts(tx, shouldZero)), ...rest);
  return client;
}

function clientWithRemovedTaskHeartbeatPredicate(client, key) {
  const wrap = (target, path) => new Proxy(target, {
    get(t, prop) {
      if (prop === "then") return undefined;
      const value = t[prop];
      const nextPath = path ? `${path}.${String(prop)}` : String(prop);
      if (nextPath === "keywordResearchTask.updateMany") {
        return (args) => {
          const cloned = structuredClone(args);
          delete cloned.where[key];
          return value.apply(t, [cloned]);
        };
      }
      if (typeof value === "function") return value.bind(t);
      if (value && typeof value === "object") return wrap(value, nextPath);
      return value;
    }
  });
  return wrap(client, "");
}

function clientWithQuerySpy(client) {
  const spy = { taskReads: 0, taskWrites: 0, stageReads: 0, stageWrites: 0 };
  const namespaces = [
    ["keywordResearchTask", "task"],
    ["keywordResearchStage", "stage"]
  ];
  for (const [ns, label] of namespaces) {
    for (const name of ["findUnique", "findMany", "updateMany"]) {
      const isRead = name.startsWith("find");
      const real = client[ns][name].bind(client[ns]);
      client[ns][name] = (...args) => {
        if (isRead) spy[`${label}Reads`] += 1;
        else spy[`${label}Writes`] += 1;
        return real(...args);
      };
    }
  }
  return { client, spy };
}

async function withPublicationTransactionProbe(client, { timeoutOverride } = {}, run) {
  const originalTransaction = client.$transaction;
  const observation = { options: null, delayActivated: false };
  client.$transaction = (work, ...args) => {
    const suppliedOptions = args[0];
    observation.options = suppliedOptions === undefined ? undefined : structuredClone(suppliedOptions);
    const effectiveOptions = timeoutOverride === undefined || suppliedOptions === undefined
      ? suppliedOptions : { ...suppliedOptions, timeout: timeoutOverride };
    return originalTransaction.call(client, async (tx) => {
      const researchDelegate = tx.keywordResearch;
      let delayed = false;
      const delayedResearchDelegate = new Proxy(researchDelegate, {
        get(target, prop) {
          const value = target[prop];
          if (prop === "updateMany") {
            return (query) => {
              const isFinalPublication = !delayed && query?.data?.state === "completed" &&
                query.data.resultFingerprint !== undefined;
              if (!isFinalPublication) return value.apply(target, [query]);
              delayed = true;
              observation.delayActivated = true;
              return tx.$queryRawUnsafe("SELECT ''::text AS slept FROM pg_sleep(21.000)")
                .then(() => value.apply(target, [query]));
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      const probedTx = new Proxy(tx, {
        get(target, prop) {
          if (prop === "keywordResearch") return delayedResearchDelegate;
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      return work(probedTx);
    }, effectiveOptions);
  };
  try {
    return await run(observation);
  } finally {
    client.$transaction = originalTransaction;
  }
}

async function snapshotResearchRows(db, { researchId, stageIds, nextStageId }) {
  const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
  const stages = {};
  for (const id of stageIds) stages[id] = await db.keywordResearchStage.findUnique({ where: { id } });
  const nextStage = nextStageId ? await db.keywordResearchStage.findUnique({ where: { id: nextStageId } }) : null;
  const nextTasks = nextStageId
    ? await db.keywordResearchTask.findMany({ where: { stageId: nextStageId }, orderBy: { itemKey: "asc" } })
    : [];
  return { research, stages, nextStage, nextTasks };
}

async function assertSnapshotUnchanged(db, options, label) {
  const after = await snapshotResearchRows(db, options);
  assert.deepEqual(after, options.before, label);
  return after;
}


function injectZeroCounts(target, shouldZero) {
  const make = (obj, path) => new Proxy(obj, {
    get(t, prop) {
      if (prop === "then") return undefined;
      const value = t[prop];
      const nextPath = path ? `${path}.${String(prop)}` : String(prop);
      if (typeof value === "function") {
        return (...args) => {
          if (shouldZero(nextPath, args)) return Promise.resolve({ count: 0 });
          return value.apply(t, args);
        };
      }
      if (value && typeof value === "object") return make(value, nextPath);
      return value;
    }
  });
  return make(target, "");
}

async function setupRepo(t, schemaPrefix) {
  const schema = `${schemaPrefix}_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const [remaining] = await admin.$queryRawUnsafe(
      "SELECT schema_name::text AS name FROM information_schema.schemata WHERE schema_name = $1", schema
    );
    assert.equal(remaining, undefined, `disposable schema ${schema} must be absent after DROP`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  await assertMigrationStayedInSchema(db, schema);
  const repo = new PrismaKeywordResearchRepository(db);
  return { schema, db, repo };
}

test("migration catalog, enum values, uniques, defaults, legacy compatibility", { skip: !enabled }, async (t) => {
  const { schema, db } = await setupRepo(t, "kir1_catalog");
  await catalogAssertion(db, schema);
  const legacy = await db.run.create({ data: { id: "run_legacy_kir1", state: "queued",
    stage: "discovery", normalizedShopTypes: [], progress: {} } });
  assert.equal(legacy.queryPlanSource, "legacy");
  assert.equal(legacy.keywordResearchId, null);
  assert.equal(legacy.keywordSelectionRevision, null);
  const defaults = await db.keywordResearch.create({ data: { id: newResearchId(), ownerId: "o",
    configSnapshot: {}, configFingerprint: fp("d"), seeds: [], markets: [], progress: {} } });
  assert.equal(defaults.state, "queued");
  assert.equal(defaults.generation, 1);
  assert.equal(defaults.selectionRevision, 0);
  await db.$disconnect();
});

test("negative control: removing one unique constraint fails the catalog assertion", { skip: !enabled }, async (t) => {
  const schema = `kir1_negctl_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  await admin.$executeRawUnsafe(`DROP INDEX "${schema}"."KeywordResearchTask_stageId_itemKey_key"`);
  const db = createPrismaClient(scopedUrl);
  await assert.rejects(() => catalogAssertion(db, schema), assert.AssertionError);
  await db.$disconnect();
});

test("research create/getOwned idempotency and ownership", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_research");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  assert.equal((await repo.create({ researchId, ownerId: "owner_kiw1", configSnapshot: { anchor: "US" },
    configFingerprint: fp("c"), seeds: ["seed 0"], markets: NINE_MARKETS }, NOW)).outcome, "found");
  assert.equal((await repo.create({ researchId, ownerId: "other", configSnapshot: { anchor: "US" },
    configFingerprint: fp("c"), seeds: ["seed 0"], markets: NINE_MARKETS }, NOW)).outcome, "conflict");
  assert.equal((await repo.getOwned({ researchId, ownerId: "other" })).outcome, "not_found");
  assert.equal((await repo.getOwned({ researchId, ownerId: "owner_kiw1" })).outcome, "found");
  await db.$disconnect();
});

test("worker context projections are ownerless and exact (DEC-KI-026)", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_context");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  assert.equal(initialized.outcome, "created");
  assert.deepEqual(Object.keys(initialized.stage).sort(), [
    "createdAt", "expectedCount", "failedCount", "id", "manifestFingerprint", "manifestProducedAt",
    "manifestS3Key", "researchId", "skippedCount", "stage", "state", "succeededCount",
    "terminalCount", "generation"
  ].sort());
  assert.ok(!Object.hasOwn(initialized.stage, "aggregationOwner"));
  assert.ok(!Object.hasOwn(initialized.tasks[0], "leaseOwner"));
  assert.ok(!Object.hasOwn(initialized.tasks[0], "safeErrorMessage"));

  const worker = await repo.getWorkerResearch({ researchId, generation: 1 });
  assert.equal(worker.outcome, "found");
  assert.ok(!Object.hasOwn(worker.research, "ownerId"));
  assert.equal(worker.research.id, researchId);
  assert.equal(worker.research.generation, 1);
  assert.equal((await repo.getWorkerResearch({ researchId, generation: 2 })).outcome, "conflict");
  assert.equal((await repo.getWorkerResearch({ researchId: newResearchId(), generation: 1 })).outcome, "not_found");

  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const context = await repo.getTaskContext({ taskId });
  assert.equal(context.outcome, "found");
  assert.ok(!Object.hasOwn(context.research, "ownerId"));
  assert.equal(context.task.id, taskId);
  assert.equal(context.latestAttempt, null);
  assert.ok(!Object.hasOwn(context.stage, "aggregationOwner"));

  const stageContext = await repo.getStageContext({ researchId, stage: "expansion", generation: 1 });
  assert.equal(stageContext.outcome, "found");
  assert.equal(stageContext.tasks.length, 2);
  assert.equal(stageContext.tasks[0].itemKey, "0:related");
  assert.equal(stageContext.tasks[1].itemKey, "0:suggestions");
  assert.ok(!Object.hasOwn(stageContext.stage, "aggregationOwner"));
  assert.equal((await repo.getStageContext({ researchId, stage: "expansion", generation: 2 })).outcome, "conflict");
  assert.equal((await repo.getStageContext({ researchId, stage: "anchor_screen", generation: 1 })).outcome, "not_found");
  await db.$disconnect();
});

test("ownerless initialize exact replay, mismatch, and seed/task-set validation", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_init");
  const researchId = newResearchId();
  await freshResearch(repo, researchId, "owner_kiw1", 2);
  const tasks = expansionTasksFor(2);
  const created = await repo.initialize({ researchId, generation: 1, stage: "expansion", tasks }, NOW);
  assert.equal(created.outcome, "created");
  assert.equal(created.stage.expectedCount, 4);
  assert.equal(created.tasks.length, 4);
  assert.equal((await repo.getOwned({ researchId, ownerId: "owner_kiw1" })).research.state, "running");
  const replay = await repo.initialize({ researchId, generation: 1, stage: "expansion", tasks }, NOW);
  assert.equal(replay.outcome, "found");
  assert.deepEqual(replay.tasks.map((task) => task.itemKey).sort(),
    ["0:related", "0:suggestions", "1:related", "1:suggestions"]);
  const changed = tasks.map((task) => task.itemKey === "0:suggestions"
    ? { ...task, requestFingerprint: fp("changed") } : task);
  assert.equal((await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: changed }, NOW)).outcome, "conflict");
  const missing = tasks.slice(0, 3);
  assert.equal((await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: missing }, NOW)).outcome, "conflict");
  assert.equal((await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(2) }, new Date(NOW.getTime() + 5_000))).outcome, "found");
  assert.equal((await repo.initialize({ researchId, generation: 2, stage: "expansion",
    tasks }, NOW)).outcome, "conflict");
  const other = newResearchId();
  assert.equal((await repo.initialize({ researchId: other, generation: 1, stage: "expansion",
    tasks }, NOW)).outcome, "not_found");
  await db.$disconnect();
});

test("claim/heartbeat/loss/reclaim under the token fence", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_leases");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const claimToken = newLeaseToken();
  const claimed = await repo.claim({ taskId, owner: "w", token: claimToken }, NOW);
  assert.equal(claimed.outcome, "claimed");
  assert.equal(claimed.task.leaseToken, claimToken);
  assert.equal((await repo.claim({ taskId, owner: "w2", token: newLeaseToken() }, NOW)).outcome, "lost");
  assert.equal((await repo.heartbeat({ taskId, token: claimToken }, new Date(NOW.getTime() + 20_000))).outcome, "claimed");
  assert.equal((await repo.heartbeat({ taskId, token: newLeaseToken() }, NOW)).outcome, "lost");
  assert.equal((await repo.terminalize({ taskId, token: newLeaseToken(), state: "succeeded" }, NOW)).outcome, "lost");
  const reclaimToken = newLeaseToken();
  assert.equal((await repo.claim({ taskId, owner: "w3", token: reclaimToken }, LATER)).outcome, "claimed");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  assert.equal(taskRow.leaseAttempt, 2);
  const terminal = await repo.terminalize({ taskId, token: reclaimToken, state: "succeeded",
    artifactS3Key: "runs/x.json", artifactFingerprint: fp("a") }, LATER);
  assert.equal(terminal.outcome, "terminal");
  const stage = await db.keywordResearchStage.findUnique({ where: { id: initialized.stage.id } });
  assert.equal(stage.succeededCount, 1);
  assert.equal(stage.terminalCount, 1);
  assert.equal(stage.state, "collecting");
  assert.equal((await repo.terminalize({ taskId, token: reclaimToken, state: "succeeded",
    artifactS3Key: "runs/x.json", artifactFingerprint: fp("a") }, LATER)).outcome, "found");
  assert.equal((await repo.terminalize({ taskId, token: reclaimToken, state: "failed" }, LATER)).outcome,
    "conflict");
  await db.$disconnect();
});

test("recordAttempt token fence, derived attempt number, budget, ceiling, retry-not-scheduled, replay", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_attempt");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const stageId = initialized.stage.id;
  const taskId = keywordTaskId(stageId, "0:suggestions");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });

  const wrongToken = await repo.recordAttempt({ taskId, token: newLeaseToken(),
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(wrongToken.outcome, "lost");
  assert.equal((await repo.recordAttempt({ taskId, token: newLeaseToken(),
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, NOW)).outcome, "lost");

  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  const created = await repo.recordAttempt({ taskId, token,
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "0.02000000" }, NOW);
  assert.equal(created.outcome, "created");
  assert.equal(created.mayCall, true);
  assert.equal(created.attempt.attemptNumber, 1);
  assert.equal(created.attempt.reservationCostUsd, "0.01560000");

  const replay = await repo.recordAttempt({ taskId, token,
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "0.02000000" }, NOW);
  assert.equal(replay.outcome, "found");
  assert.equal(replay.mayCall, false);

  const secondTaskId = keywordTaskId(stageId, "0:related");
  const secondToken = newLeaseToken();
  await repo.claim({ taskId: secondTaskId, owner: "w", token: secondToken }, NOW);
  const denied = await repo.recordAttempt({ taskId: secondTaskId, token: secondToken,
    requestFingerprint: (await db.keywordResearchTask.findUnique({ where: { id: secondTaskId } })).requestFingerprint,
    reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "0.02000000" }, NOW);
  assert.equal(denied.outcome, "conflict");
  assert.equal(denied.code, "KEYWORD_PROVIDER_BUDGET_EXHAUSTED");

  const settled = await repo.settleAttempt({ taskId, token, attemptNumber: 1, state: "succeeded",
    providerCostUsd: "0.01200000", resultFingerprint: fp("n"),
    cacheEntry: { cacheKey: "kw:suggestions:abc", endpointKey: "keyword_suggestions",
      contractVersion: 1, normalizedResponse: { keywords: ["a"] }, resultFingerprint: fp("n"),
      ttlSeconds: 604800 } }, NOW);
  assert.equal(settled.outcome, "terminal");

  const afterSettle = await repo.recordAttempt({ taskId: secondTaskId, token: secondToken,
    requestFingerprint: (await db.keywordResearchTask.findUnique({ where: { id: secondTaskId } })).requestFingerprint,
    reservationCostUsd: "0.00790000", maxCostPerResearchUsd: "0.02000000" }, NOW);
  assert.equal(afterSettle.outcome, "created");

  await db.keywordResearchTask.update({ where: { id: secondTaskId },
    data: { attemptCount: 5 } });
  await db.keywordResearchProviderAttempt.create({ data: {
    id: keywordTaskId(stageId, "x"), taskId: secondTaskId, attemptNumber: 5,
    state: "failed", requestFingerprint: fp("a5"), reservationCostUsd: "0.01560000",
    providerCostUsd: "0.01200000", plannedAt: NOW, completedAt: NOW, createdAt: NOW, updatedAt: NOW
  } });
  const ceiling = await repo.recordAttempt({ taskId: secondTaskId, token: secondToken,
    requestFingerprint: (await db.keywordResearchTask.findUnique({ where: { id: secondTaskId } })).requestFingerprint,
    reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(ceiling.outcome, "conflict");
  assert.equal(ceiling.code, "KEYWORD_PROVIDER_RETRY_EXHAUSTED");

  await db.keywordResearchProviderAttempt.deleteMany({ where: { taskId: secondTaskId, attemptNumber: { gte: 2 } } });
  await db.keywordResearchProviderAttempt.update({
    where: { taskId_attemptNumber: { taskId: secondTaskId, attemptNumber: 1 } },
    data: { state: "failed", providerCostUsd: "0.01200000", completedAt: NOW }
  });
  await db.keywordResearchTask.update({ where: { id: secondTaskId }, data: { attemptCount: 1 } });
  const retryNotScheduled = await repo.recordAttempt({ taskId: secondTaskId, token: secondToken,
    requestFingerprint: (await db.keywordResearchTask.findUnique({ where: { id: secondTaskId } })).requestFingerprint,
    reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" },
  new Date(NOW.getTime() + 5_000));
  assert.equal(retryNotScheduled.outcome, "conflict");
  assert.equal(retryNotScheduled.code, "KEYWORD_PROVIDER_RETRY_NOT_SCHEDULED");
  await db.$disconnect();
});

test("settleAttempt atomic cost settlement plus normalized cache even after fence loss", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_settle");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  const created = await repo.recordAttempt({ taskId, token, requestFingerprint: taskRow.requestFingerprint,
    reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(created.outcome, "created");

  const cacheEntry = { cacheKey: "kw:suggestions:abc", endpointKey: "keyword_suggestions",
    contractVersion: 1, normalizedResponse: { keywords: ["alpha"] }, resultFingerprint: fp("n"),
    ttlSeconds: 604800 };
  const settled = await repo.settleAttempt({ taskId, token, attemptNumber: 1, state: "succeeded",
    providerCostUsd: "0.01200000", resultFingerprint: fp("n"), cacheEntry }, NOW);
  assert.equal(settled.outcome, "terminal");
  assert.equal(settled.fenceActive, true);
  const attemptRow = await db.keywordResearchProviderAttempt.findUnique({
    where: { taskId_attemptNumber: { taskId, attemptNumber: 1 } } });
  assert.equal(attemptRow.state, "succeeded");
  assert.equal(Number(attemptRow.providerCostUsd).toFixed(8), "0.01200000");
  const cacheRow = await db.keywordResearchCache.findUnique({
    where: { requestFingerprint: taskRow.requestFingerprint } });
  assert.ok(cacheRow);
  assert.equal(cacheRow.contractVersion, 1);
  assert.equal(cacheRow.expiresAt.getTime(), NOW.getTime() + 604800 * 1000);

  const replay = await repo.settleAttempt({ taskId, token, attemptNumber: 1, state: "succeeded",
    providerCostUsd: "0.01200000", resultFingerprint: fp("n"), cacheEntry }, NOW);
  assert.equal(replay.outcome, "found");
  const conflict = await repo.settleAttempt({ taskId, token, attemptNumber: 1, state: "succeeded",
    providerCostUsd: "0.01200000", resultFingerprint: fp("other"), cacheEntry }, NOW);
  assert.equal(conflict.outcome, "conflict");

  const staleToken = newLeaseToken();
  const lostSettle = await repo.settleAttempt({ taskId, token: staleToken, attemptNumber: 1,
    state: "succeeded", providerCostUsd: "0.01200000", resultFingerprint: fp("n"), cacheEntry },
  new Date(NOW.getTime() + 61_000));
  assert.equal(lostSettle.outcome, "found");
  assert.equal(lostSettle.fenceActive, false);

  const failTaskId = keywordTaskId(initialized.stage.id, "0:related");
  const failToken = newLeaseToken();
  await repo.claim({ taskId: failTaskId, owner: "w", token: failToken }, NOW);
  const failRow = await db.keywordResearchTask.findUnique({ where: { id: failTaskId } });
  await repo.recordAttempt({ taskId: failTaskId, token: failToken,
    requestFingerprint: failRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, NOW);
  const failed = await repo.settleAttempt({ taskId: failTaskId, token: failToken, attemptNumber: 1,
    state: "failed", providerCostUsd: "0.01200000", safeErrorCode: "KEYWORD_PROVIDER_TASK_FAILED",
    cacheEntry: null }, NOW);
  assert.equal(failed.outcome, "terminal");
  const failedAttempt = await db.keywordResearchProviderAttempt.findUnique({
    where: { taskId_attemptNumber: { taskId: failTaskId, attemptNumber: 1 } } });
  assert.equal(failedAttempt.safeErrorCode, "KEYWORD_PROVIDER_TASK_FAILED");
  assert.equal(failedAttempt.ambiguousAfter, null);
  assert.ok(!Object.hasOwn(failedAttempt, "ownerId"));
  await db.$disconnect();
});

test("cache settlement is all-or-none: injected cache write rolls back attempt settlement", { skip: !enabled }, async (t) => {
  const schema = `kir1_settle_rollback_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(
    clientWithInjectedFailure(db, (path) => path === "keywordResearchCache.create")
  );
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  await repo.recordAttempt({ taskId, token, requestFingerprint: taskRow.requestFingerprint,
    reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW);
  const cacheEntry = { cacheKey: "kw:suggestions:abc", endpointKey: "keyword_suggestions",
    contractVersion: 1, normalizedResponse: { keywords: ["alpha"] }, resultFingerprint: fp("n"),
    ttlSeconds: 604800 };
  await assert.rejects(() => repo.settleAttempt({ taskId, token, attemptNumber: 1, state: "succeeded",
    providerCostUsd: "0.01200000", resultFingerprint: fp("n"), cacheEntry }, NOW),
  /injected:keywordResearchCache.create/);
  const attemptRow = await db.keywordResearchProviderAttempt.findUnique({
    where: { taskId_attemptNumber: { taskId, attemptNumber: 1 } } });
  assert.equal(attemptRow.state, "planned");
  const cacheRow = await db.keywordResearchCache.findUnique({
    where: { requestFingerprint: taskRow.requestFingerprint } });
  assert.equal(cacheRow, null);
  await db.$disconnect();
});

test("markAttemptAmbiguous fails task/stage/research once, holds reservation, and never authorizes a second call", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_ambig");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  const created = await repo.recordAttempt({ taskId, token, requestFingerprint: taskRow.requestFingerprint,
    reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(created.outcome, "created");

  const marked = await repo.markAttemptAmbiguous({ taskId, attemptNumber: 1,
    requestFingerprint: taskRow.requestFingerprint, safeErrorCode: "KEYWORD_PROVIDER_AMBIGUOUS" },
  new Date(NOW.getTime() + 61_000));
  assert.equal(marked.outcome, "terminal");
  const attemptRow = await db.keywordResearchProviderAttempt.findUnique({
    where: { taskId_attemptNumber: { taskId, attemptNumber: 1 } } });
  assert.equal(attemptRow.state, "ambiguous");
  assert.equal(attemptRow.providerCostUsd, null);
  assert.equal(Number(attemptRow.reservationCostUsd).toFixed(8), "0.01560000");
  const taskAfter = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  assert.equal(taskAfter.state, "failed");
  assert.equal(taskAfter.safeErrorCode, "KEYWORD_PROVIDER_AMBIGUOUS");
  assert.equal(taskAfter.leaseToken, null);
  const stageAfter = await db.keywordResearchStage.findUnique({ where: { id: initialized.stage.id } });
  assert.equal(stageAfter.state, "failed");
  assert.equal(stageAfter.failedCount, 1);
  assert.equal(stageAfter.terminalCount, 1);
  assert.equal(stageAfter.aggregationLeaseToken, null);
  const researchAfter = await db.keywordResearch.findUnique({ where: { id: researchId } });
  assert.equal(researchAfter.state, "failed");

  assert.equal((await repo.markAttemptAmbiguous({ taskId, attemptNumber: 1,
    requestFingerprint: taskRow.requestFingerprint, safeErrorCode: "KEYWORD_PROVIDER_AMBIGUOUS" }, NOW)).outcome,
  "found");
  assert.equal((await repo.markAttemptAmbiguous({ taskId, attemptNumber: 1,
    requestFingerprint: fp("wrong"), safeErrorCode: "KEYWORD_PROVIDER_AMBIGUOUS" }, NOW)).outcome, "conflict");

  const second = await repo.recordAttempt({ taskId, token: newLeaseToken(),
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, new Date(NOW.getTime() + 61_000));
  assert.equal(second.outcome, "lost");
  assert.notEqual(second.mayCall, true);
  await db.$disconnect();
});

test("deferTask throttle delay consumes no attempt and replays idempotently", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_defer");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  const retryAt = new Date(NOW.getTime() + 5_000);
  const deferred = await repo.deferTask({ taskId, token, nextAttemptAt: retryAt,
    safeErrorCode: "KEYWORD_PROVIDER_THROTTLED" }, NOW);
  assert.equal(deferred.outcome, "delayed");
  assert.equal(deferred.retryAt.getTime(), retryAt.getTime());
  const taskAfter = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  assert.equal(taskAfter.state, "pending");
  assert.equal(taskAfter.attemptCount, 0);
  assert.equal(taskAfter.nextAttemptAt.getTime(), retryAt.getTime());
  assert.equal(taskAfter.leaseToken, null);
  assert.equal(taskAfter.leaseOwner, null);
  assert.equal(taskAfter.leaseAcquiredAt, null);
  assert.equal(taskAfter.leaseExpiresAt, null);
  assert.equal(taskAfter.safeErrorCode, "KEYWORD_PROVIDER_THROTTLED");
  const replay = await repo.deferTask({ taskId, token, nextAttemptAt: retryAt,
    safeErrorCode: "KEYWORD_PROVIDER_THROTTLED" }, NOW);
  assert.equal(replay.outcome, "delayed");
  assert.equal(replay.retryAt.getTime(), retryAt.getTime());
  assert.equal((await repo.claim({ taskId, owner: "w", token: newLeaseToken() }, NOW)).outcome, "delayed");
  assert.equal((await repo.claim({ taskId, owner: "w", token: newLeaseToken() },
    new Date(NOW.getTime() + 6_000))).outcome, "claimed");

  const secondTaskId = keywordTaskId(initialized.stage.id, "0:related");
  const secondToken = newLeaseToken();
  await repo.claim({ taskId: secondTaskId, owner: "w", token: secondToken }, NOW);
  const secondRow = await db.keywordResearchTask.findUnique({ where: { id: secondTaskId } });
  await repo.recordAttempt({ taskId: secondTaskId, token: secondToken,
    requestFingerprint: secondRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, NOW);
  const conflict = await repo.deferTask({ taskId: secondTaskId, token: secondToken,
    nextAttemptAt: new Date(NOW.getTime() + 5_000), safeErrorCode: "KEYWORD_PROVIDER_THROTTLED" }, NOW);
  assert.equal(conflict.outcome, "conflict");
  await db.$disconnect();
});

test("scheduleRetry crash/reclaim/schedule/due sequence derives retryAt from DEC-KI-007", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_retry");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  const attempt = await repo.recordAttempt({ taskId, token, requestFingerprint: taskRow.requestFingerprint,
    reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(attempt.outcome, "created");
  const settled = await repo.settleAttempt({ taskId, token, attemptNumber: 1, state: "failed",
    providerCostUsd: "0.01200000", safeErrorCode: "KEYWORD_PROVIDER_RETRYABLE", cacheEntry: null }, NOW);
  assert.equal(settled.outcome, "terminal");
  assert.equal(settled.fenceActive, true);

  const recovered = await repo.recover(LATER);
  assert.ok(recovered.taskDispatches.some(({ taskId: id }) => id === taskId));
  const reclaimToken = newLeaseToken();
  assert.equal((await repo.claim({ taskId, owner: "w", token: reclaimToken }, LATER)).outcome, "claimed");
  const premature = await repo.recordAttempt({ taskId, token: reclaimToken,
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, LATER);
  assert.equal(premature.outcome, "conflict");
  assert.equal(premature.code, "KEYWORD_PROVIDER_RETRY_NOT_SCHEDULED");

  const scheduled = await repo.scheduleRetry({ taskId, token: reclaimToken, attemptNumber: 1 }, LATER);
  assert.equal(scheduled.outcome, "delayed");
  assert.ok(scheduled.retryAt instanceof Date);
  const taskAfter = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  assert.equal(taskAfter.state, "pending");
  assert.equal(taskAfter.nextAttemptAt.getTime(), scheduled.retryAt.getTime());
  assert.equal(taskAfter.leaseToken, null);
  assert.equal(taskAfter.attemptCount, 1);
  assert.equal((await repo.scheduleRetry({ taskId, token: reclaimToken, attemptNumber: 1 }, LATER)).outcome,
    "delayed");
  const earlyClaim = await repo.claim({ taskId, owner: "w", token: newLeaseToken() },
    new Date(scheduled.retryAt.getTime() - 1_000));
  assert.equal(earlyClaim.outcome, "delayed");
  const dueToken = newLeaseToken();
  assert.equal((await repo.claim({ taskId, owner: "w", token: dueToken }, scheduled.retryAt)).outcome, "claimed");
  const staleAttempt = await repo.recordAttempt({ taskId, token: newLeaseToken(),
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, scheduled.retryAt);
  assert.equal(staleAttempt.outcome, "lost");
  const retried2 = await repo.recordAttempt({ taskId, token: dueToken,
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, scheduled.retryAt);
  assert.equal(retried2.outcome, "created");
  assert.equal(retried2.attempt.attemptNumber, 2);

  await repo.settleAttempt({ taskId, token: dueToken, attemptNumber: 2, state: "failed",
    providerCostUsd: "0.01200000", safeErrorCode: "KEYWORD_PROVIDER_RETRYABLE", cacheEntry: null },
  scheduled.retryAt);
  await db.keywordResearchProviderAttempt.create({ data: {
    id: "kra_ceiling_001", taskId, attemptNumber: 5,
    state: "failed", requestFingerprint: fp("a5"), reservationCostUsd: "0.01560000",
    providerCostUsd: "0.01200000", plannedAt: NOW, completedAt: NOW, createdAt: NOW, updatedAt: NOW
  } });
  await db.keywordResearchTask.update({ where: { id: taskId }, data: { attemptCount: 5 } });
  const ceilingSchedule = await repo.scheduleRetry({ taskId, token: dueToken, attemptNumber: 5 },
    scheduled.retryAt);
  assert.equal(ceilingSchedule.outcome, "conflict");
  assert.equal(ceilingSchedule.code, "KEYWORD_PROVIDER_RETRY_EXHAUSTED");
  await db.$disconnect();
});

test("claimAggregator readiness gating, competing tokens, expiry reclaim, and zero-count advancement", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_aggregator");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const stageId = initialized.stage.id;
  const early = await repo.claimAggregator({ researchId, stage: "expansion", generation: 1,
    owner: "a1", token: newLeaseToken() }, NOW);
  assert.equal(early.outcome, "not_ready");
  const stageBefore = await db.keywordResearchStage.findUnique({ where: { id: stageId } });
  assert.equal(stageBefore.state, "collecting");
  assert.equal(stageBefore.aggregationLeaseToken, null);

  await completeStageTasks(db, repo, stageId, initialized.tasks.map((task) => task.itemKey));
  const tokenA = newLeaseToken();
  assert.equal((await repo.claimAggregator({ researchId, stage: "expansion", generation: 1,
    owner: "a1", token: tokenA }, NOW)).outcome, "claimed");
  assert.equal((await repo.claimAggregator({ researchId, stage: "expansion", generation: 1,
    owner: "a2", token: newLeaseToken() }, NOW)).outcome, "lost");
  assert.equal((await repo.claimAggregator({ researchId, stage: "expansion", generation: 1,
    owner: "a1", token: tokenA }, NOW)).outcome, "found");
  const expiredToken = newLeaseToken();
  assert.equal((await repo.claimAggregator({ researchId, stage: "expansion", generation: 1,
    owner: "a3", token: expiredToken }, LATER)).outcome, "claimed");
  const stageAfter = await db.keywordResearchStage.findUnique({ where: { id: stageId } });
  assert.equal(stageAfter.aggregationLeaseToken, expiredToken);
  assert.equal(stageAfter.state, "aggregating");

  const research2 = newResearchId();
  await freshResearch(repo, research2, "owner_kiw1", 2);
  const init2 = await repo.initialize({ researchId: research2, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(2) }, NOW);
  await completeStageTasks(db, repo, init2.stage.id, init2.tasks.map((task) => task.itemKey));
  await db.keywordResearchStage.update({ where: { id: init2.stage.id },
    data: { state: "ready", terminalCount: 1 } });
  const corrupt = await repo.claimAggregator({ researchId: research2, stage: "expansion", generation: 1,
    owner: "a", token: newLeaseToken() }, NOW);
  assert.equal(corrupt.outcome, "conflict");

  const research3 = newResearchId();
  await freshResearch(repo, research3, "owner_kiw1", 1);
  const zeroStage = await db.keywordResearchStage.create({ data: {
    id: keywordStageId(research3, "expansion", 1), researchId: research3, stage: "expansion",
    generation: 1, expectedCount: 0, state: "ready", createdAt: NOW, updatedAt: NOW
  } });
  const zeroClaim = await repo.claimAggregator({ researchId: research3, stage: "expansion", generation: 1,
    owner: "a", token: newLeaseToken() }, NOW);
  assert.equal(zeroClaim.outcome, "claimed");
  assert.equal(zeroClaim.stage.id, zeroStage.id);
  await db.$disconnect();
});

test("publishCandidateManifest requires the exact US:0 task, is atomic, and replays", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_candidate");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const stageId = initialized.stage.id;
  await completeStageTasks(db, repo, stageId, initialized.tasks.map((task) => task.itemKey));
  const wrongSet = await repo.publishCandidateManifest({ researchId, generation: 1, token: newLeaseToken(),
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"),
    nextStageTasks: [{ itemKey: "US:1", inputFingerprint: fp("i"), endpointKey: "keyword_overview",
      requestFingerprint: fp("r") }] }, NOW);
  assert.equal(wrongSet.outcome, "conflict");

  const token = newLeaseToken();
  assert.equal((await repo.claimAggregator({ researchId, stage: "expansion", generation: 1,
    owner: "a", token }, NOW)).outcome, "claimed");
  const expansionBefore = await db.keywordResearchStage.findUnique({ where: { id: stageId } });
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("anchor-input"),
    endpointKey: "keyword_overview", requestFingerprint: fp("anchor-request") };
  const published = await repo.publishCandidateManifest({ researchId, generation: 1, token,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  assert.equal(published.outcome, "terminal");
  assert.equal(published.stage.state, "completed");
  assert.equal(published.stage.manifestProducedAt.getTime(), expansionBefore.createdAt.getTime());
  assert.equal(published.nextStage.stage, "anchor_screen");
  assert.equal(published.tasks.length, 1);
  assert.equal(published.tasks[0].itemKey, "US:0");

  const replay = await repo.publishCandidateManifest({ researchId, generation: 1, token,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  assert.equal(replay.outcome, "found");
  assert.deepEqual(replay.tasks.map((task) => task.itemKey), ["US:0"]);
  const mismatch = await repo.publishCandidateManifest({ researchId, generation: 1, token,
    manifestS3Key: "runs/other.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  assert.equal(mismatch.outcome, "conflict");

  const research2 = newResearchId();
  await freshResearch(repo, research2, "owner_kiw1", 1);
  const init2 = await repo.initialize({ researchId: research2, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, init2.stage.id, init2.tasks.map((task) => task.itemKey));
  const agg2 = newLeaseToken();
  await repo.claimAggregator({ researchId: research2, stage: "expansion", generation: 1,
    owner: "a", token: agg2 }, NOW);
  const stale = await repo.publishCandidateManifest({ researchId: research2, generation: 1,
    token: newLeaseToken(), manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"),
    nextStageTasks: [anchorTask] }, NOW);
  assert.equal(stale.outcome, "lost");
  const expStage2 = await db.keywordResearchStage.findUnique({ where: { id: init2.stage.id } });
  assert.equal(expStage2.manifestS3Key, null);
  assert.equal(expStage2.state, "aggregating");
  const anchor2 = await db.keywordResearchStage.findUnique({ where: { id: keywordStageId(research2, "anchor_screen", 1) } });
  assert.equal(anchor2, null);
  await db.$disconnect();
});

test("publishCandidateManifest rollback: injected anchor-stage failure leaves expansion wholly unchanged", { skip: !enabled }, async (t) => {
  const schema = `kir1_candidate_rollback_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(
    clientWithInjectedFailure(db, (path, args) =>
      path === "keywordResearchStage.create" && args[0]?.data?.stage === "anchor_screen")
  );
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, initialized.stage.id, initialized.tasks.map((task) => task.itemKey));
  const token = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token }, NOW);
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("anchor-input"),
    endpointKey: "keyword_overview", requestFingerprint: fp("anchor-request") };
  await assert.rejects(() => repo.publishCandidateManifest({ researchId, generation: 1, token,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW),
  /injected:keywordResearchStage.create/);
  const expStage = await db.keywordResearchStage.findUnique({ where: { id: initialized.stage.id } });
  assert.equal(expStage.manifestS3Key, null);
  assert.equal(expStage.manifestFingerprint, null);
  assert.equal(expStage.state, "aggregating");
  const anchor = await db.keywordResearchStage.findUnique({ where: { id: keywordStageId(researchId, "anchor_screen", 1) } });
  assert.equal(anchor, null);
  await db.$disconnect();
});

test("publishShortlist requires the exact eight remaining-market tasks, is atomic, and replays", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_shortlist");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, initialized.stage.id, initialized.tasks.map((task) => task.itemKey));
  const expAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token: expAgg }, NOW);
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("anchor-input"),
    endpointKey: "keyword_overview", requestFingerprint: fp("anchor-request") };
  const candidate = await repo.publishCandidateManifest({ researchId, generation: 1, token: expAgg,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  assert.equal(candidate.outcome, "terminal");
  const anchorStageId = candidate.nextStage.id;
  await completeStageTasks(db, repo, anchorStageId, ["US:0"]);
  const anchorBefore = await db.keywordResearchStage.findUnique({ where: { id: anchorStageId } });

  const wrongSet = await repo.publishShortlist({ researchId, generation: 1, token: newLeaseToken(),
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks: marketTasksFor().slice(0, 7) },
  NOW);
  assert.equal(wrongSet.outcome, "conflict");

  const ancAgg = newLeaseToken();
  assert.equal((await repo.claimAggregator({ researchId, stage: "anchor_screen", generation: 1,
    owner: "a", token: ancAgg }, NOW)).outcome, "claimed");
  const marketTasks = marketTasksFor();
  const shortlist = await repo.publishShortlist({ researchId, generation: 1, token: ancAgg,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks }, NOW);
  assert.equal(shortlist.outcome, "terminal");
  assert.equal(shortlist.stage.state, "completed");
  assert.equal(shortlist.stage.manifestProducedAt.getTime(), anchorBefore.createdAt.getTime());
  assert.equal(shortlist.nextStage.stage, "market_overview");
  assert.deepEqual(shortlist.tasks.map((task) => task.itemKey),
    [...["GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"].map((code) => `${code}:0`)].sort());
  const replay = await repo.publishShortlist({ researchId, generation: 1, token: ancAgg,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks }, NOW);
  assert.equal(replay.outcome, "found");
  const mismatch = await repo.publishShortlist({ researchId, generation: 1, token: ancAgg,
    manifestS3Key: "runs/other.json", manifestFingerprint: fp("s"), marketTasks }, NOW);
  assert.equal(mismatch.outcome, "conflict");
  await db.$disconnect();
});

test("publishShortlist rollback: injected market-task failure leaves anchor wholly unchanged", { skip: !enabled }, async (t) => {
  const schema = `kir1_shortlist_rollback_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(
    clientWithInjectedFailure(db, (path, args) =>
      path === "keywordResearchTask.createMany" && Array.isArray(args[0]?.data) &&
      args[0].data.length === 8 && args[0].data[0]?.itemKey === "GB:0")
  );
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, initialized.stage.id, initialized.tasks.map((task) => task.itemKey));
  const expAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token: expAgg }, NOW);
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("anchor-input"),
    endpointKey: "keyword_overview", requestFingerprint: fp("anchor-request") };
  const candidate = await repo.publishCandidateManifest({ researchId, generation: 1, token: expAgg,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  assert.equal(candidate.outcome, "terminal");
  const anchorStageId = candidate.nextStage.id;
  await completeStageTasks(db, repo, anchorStageId, ["US:0"]);
  const ancAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "anchor_screen", generation: 1, owner: "a", token: ancAgg }, NOW);
  await assert.rejects(() => repo.publishShortlist({ researchId, generation: 1, token: ancAgg,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks: marketTasksFor() }, NOW),
  /injected:keywordResearchTask.createMany/);
  const anchorAfter = await db.keywordResearchStage.findUnique({ where: { id: anchorStageId } });
  assert.equal(anchorAfter.manifestS3Key, null);
  assert.equal(anchorAfter.state, "aggregating");
  const market = await db.keywordResearchStage.findUnique({ where: { id: keywordStageId(researchId, "market_overview", 1) } });
  assert.equal(market, null);
  await db.$disconnect();
});

test("publishResearchResult requires completed stages, deep-equal W2 default selection, and publishes atomically with revision one", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_result");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, initialized.stage.id, initialized.tasks.map((task) => task.itemKey));
  const expAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token: expAgg }, NOW);
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("anchor-input"),
    endpointKey: "keyword_overview", requestFingerprint: fp("anchor-request") };
  const candidate = await repo.publishCandidateManifest({ researchId, generation: 1, token: expAgg,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  assert.equal(candidate.outcome, "terminal");
  await completeStageTasks(db, repo, candidate.nextStage.id, ["US:0"]);
  const ancAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "anchor_screen", generation: 1, owner: "a", token: ancAgg }, NOW);
  const shortlist = await repo.publishShortlist({ researchId, generation: 1, token: ancAgg,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks: marketTasksFor() }, NOW);
  assert.equal(shortlist.outcome, "terminal");
  await completeStageTasks(db, repo, shortlist.nextStage.id, shortlist.tasks.map((task) => task.itemKey));

  const mktAgg = newLeaseToken();
  assert.equal((await repo.claimAggregator({ researchId, stage: "market_overview", generation: 1,
    owner: "a", token: mktAgg }, NOW)).outcome, "claimed");
  const marketBefore = await db.keywordResearchStage.findUnique({ where: { id: shortlist.nextStage.id } });

  const keywords = [makeKeywordRow("alpha keyword"), makeKeywordRow("beta keyword")];
  const result = makeResult(keywords, researchId);
  const selectionItems = defaultSelectionFor(keywords);

  const premature = await repo.publishResearchResult({ researchId, generation: 1, token: newLeaseToken(),
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("rf"), selectionItems }, NOW);
  assert.equal(premature.outcome, "lost");

  const altered = selectionItems.map((item, index) => index === 0
    ? { ...item, itemId: selectionItemId("calculated", "different") } : item);
  const rejected = await repo.publishResearchResult({ researchId, generation: 1, token: mktAgg,
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("rf"), selectionItems: altered }, NOW);
  assert.equal(rejected.outcome, "conflict");

  const published = await repo.publishResearchResult({ researchId, generation: 1, token: mktAgg,
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("rf"), selectionItems }, NOW);
  assert.equal(published.outcome, "terminal");
  const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
  assert.equal(research.state, "completed");
  assert.equal(research.resultFingerprint, fp("rf"));
  assert.equal(research.selectionRevision, 1);
  assert.deepEqual(research.selection.items, selectionItems);
  const marketAfter = await db.keywordResearchStage.findUnique({ where: { id: shortlist.nextStage.id } });
  assert.equal(marketAfter.state, "completed");
  assert.equal(marketAfter.manifestS3Key, "runs/final.json");
  assert.equal(marketAfter.manifestProducedAt.getTime(), marketBefore.createdAt.getTime());
  const expansionStage = await db.keywordResearchStage.findUnique({
    where: { id: keywordStageId(researchId, "expansion", 1) } });
  assert.equal(expansionStage.state, "completed");
  const anchorStage = await db.keywordResearchStage.findUnique({
    where: { id: keywordStageId(researchId, "anchor_screen", 1) } });
  assert.equal(anchorStage.state, "completed");

  const replay = await repo.publishResearchResult({ researchId, generation: 1, token: mktAgg,
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("rf"), selectionItems }, NOW);
  assert.equal(replay.outcome, "found");
  const resultMismatch = await repo.publishResearchResult({ researchId, generation: 1, token: mktAgg,
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("other"), selectionItems }, NOW);
  assert.equal(resultMismatch.outcome, "conflict");

  const saved = await repo.saveSelection({ researchId, ownerId: "owner_kiw1", expectedRevision: 1,
    items: selectionItems }, NOW);
  assert.equal(saved.outcome, "created");
  assert.equal(saved.selectionRevision, 2);
  await db.$disconnect();
});

test("publishResearchResult rollback: injected research-completion failure leaves result, selection, manifest, and research unchanged", { skip: !enabled }, async (t) => {
  const schema = `kir1_result_rollback_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(
    clientWithInjectedFailure(db, (path, args) =>
      path === "keywordResearch.updateMany" && args[0]?.data?.state === "completed" &&
      args[0]?.data?.resultFingerprint !== undefined)
  );
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, initialized.stage.id, initialized.tasks.map((task) => task.itemKey));
  const expAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token: expAgg }, NOW);
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("anchor-input"),
    endpointKey: "keyword_overview", requestFingerprint: fp("anchor-request") };
  const candidate = await repo.publishCandidateManifest({ researchId, generation: 1, token: expAgg,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  await completeStageTasks(db, repo, candidate.nextStage.id, ["US:0"]);
  const ancAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "anchor_screen", generation: 1, owner: "a", token: ancAgg }, NOW);
  const shortlist = await repo.publishShortlist({ researchId, generation: 1, token: ancAgg,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks: marketTasksFor() }, NOW);
  await completeStageTasks(db, repo, shortlist.nextStage.id, shortlist.tasks.map((task) => task.itemKey));
  const mktAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "market_overview", generation: 1, owner: "a", token: mktAgg }, NOW);
  const keywords = [makeKeywordRow("alpha keyword")];
  const result = makeResult(keywords, researchId);
  const selectionItems = defaultSelectionFor(keywords);
  await assert.rejects(() => repo.publishResearchResult({ researchId, generation: 1, token: mktAgg,
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("rf"), selectionItems }, NOW),
  /injected:keywordResearch.updateMany/);
  const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
  assert.equal(research.state, "running");
  assert.equal(research.result, null);
  assert.equal(research.resultFingerprint, null);
  assert.equal(research.selection, null);
  assert.equal(research.selectionRevision, 0);
  const marketAfter = await db.keywordResearchStage.findUnique({ where: { id: shortlist.nextStage.id } });
  assert.equal(marketAfter.state, "aggregating");
  assert.equal(marketAfter.manifestS3Key, null);
  await db.$disconnect();
});

test("SCN-KI-042: publication timeout options prove deterministic rollback and 30-second success", { skip: !enabled }, async (t) => {
  const requiredCases = ["W6-TXN-01", "W6-TXN-02"];
  const controlCases = ["W6-NC-14"];
  const executed = new Set();
  const digest = (members) => createHash("sha256").update(
    [...members].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).join("\n") + "\n"
  ).digest("hex");
  assert.equal(new Set(requiredCases).size, requiredCases.length);
  assert.equal(new Set(controlCases).size, controlCases.length);
  assert.equal(digest(requiredCases), "dd72e2292dac7c33d2250be7af0770401bde67695176d1b76c530b9c7bc10d39");

  const { db, repo } = await setupRepo(t, "kiw6_txn042");
  const negativeResearchId = newResearchId();
  await freshResearch(repo, negativeResearchId);
  const negative = await advanceToMarketStage(db, repo, negativeResearchId);
  const negativeKeywords = Array.from({ length: 200 }, (_, index) => makeKeywordRow(`negative keyword ${index}`));
  const negativeResult = makeResult(negativeKeywords, negativeResearchId);
  const negativeSelection = defaultSelectionFor(negativeKeywords);
  const negativeResearchBefore = await db.keywordResearch.findUnique({ where: { id: negativeResearchId } });
  const negativeStageBefore = await db.keywordResearchStage.findUnique({ where: { id: negative.marketStageId } });
  let negativeObservation;
  await assert.rejects(() => withPublicationTransactionProbe(db, { timeoutOverride: 20_000 }, async (observation) => {
    negativeObservation = observation;
    await repo.publishResearchResult({ researchId: negativeResearchId, generation: 1, token: negative.mktToken,
      manifestS3Key: "runs/txn-042-negative.json", manifestFingerprint: fp("txn-042-negative"),
      result: negativeResult, resultFingerprint: fp("txn-042-negative-result"), selectionItems: negativeSelection }, NOW);
  }), (error) => error?.code === "P2028" && /transaction/i.test(error.message));
  assert.deepEqual(negativeObservation.options, { maxWait: 5_000, timeout: 30_000 });
  assert.equal(negativeObservation.delayActivated, true);
  const negativeResearchAfter = await db.keywordResearch.findUnique({ where: { id: negativeResearchId } });
  const negativeStageAfter = await db.keywordResearchStage.findUnique({ where: { id: negative.marketStageId } });
  assert.deepEqual(negativeResearchAfter, negativeResearchBefore);
  assert.deepEqual(negativeStageAfter, negativeStageBefore);
  executed.add("W6-TXN-01");
  executed.add("W6-NC-14");

  const positiveResearchId = newResearchId();
  await freshResearch(repo, positiveResearchId);
  const positive = await advanceToMarketStage(db, repo, positiveResearchId);
  const positiveKeywords = Array.from({ length: 200 }, (_, index) => makeKeywordRow(`positive keyword ${index}`));
  const positiveResult = makeResult(positiveKeywords, positiveResearchId);
  const positiveSelection = defaultSelectionFor(positiveKeywords);
  let positiveObservation;
  const published = await withPublicationTransactionProbe(db, {}, async (observation) => {
    positiveObservation = observation;
    return repo.publishResearchResult({ researchId: positiveResearchId, generation: 1, token: positive.mktToken,
      manifestS3Key: "runs/txn-042-positive.json", manifestFingerprint: fp("txn-042-positive"),
      result: positiveResult, resultFingerprint: fp("txn-042-positive-result"), selectionItems: positiveSelection }, NOW);
  });
  assert.deepEqual(positiveObservation.options, { maxWait: 5_000, timeout: 30_000 });
  assert.equal(positiveObservation.delayActivated, true);
  assert.equal(published.outcome, "terminal");
  const positiveResearch = await db.keywordResearch.findUnique({ where: { id: positiveResearchId } });
  const positiveStage = await db.keywordResearchStage.findUnique({ where: { id: positive.marketStageId } });
  assert.equal(positiveResearch.state, "completed");
  assert.equal(positiveResearch.result.keywords.length, 200);
  assert.equal(positiveResearch.selection.items.length, 100);
  assert.equal(positiveResearch.selectionRevision, 1);
  assert.equal(positiveStage.state, "completed");
  assert.equal(positiveStage.manifestS3Key, "runs/txn-042-positive.json");
  assert.equal(positiveStage.manifestFingerprint, fp("txn-042-positive"));
  const positiveAfterPublication = structuredClone({ positiveResearch, positiveStage });
  const replay = await repo.publishResearchResult({ researchId: positiveResearchId, generation: 1, token: positive.mktToken,
    manifestS3Key: "runs/txn-042-positive.json", manifestFingerprint: fp("txn-042-positive"),
    result: positiveResult, resultFingerprint: fp("txn-042-positive-result"), selectionItems: positiveSelection }, NOW);
  assert.equal(replay.outcome, "found");
  const positiveAfterReplay = {
    positiveResearch: await db.keywordResearch.findUnique({ where: { id: positiveResearchId } }),
    positiveStage: await db.keywordResearchStage.findUnique({ where: { id: positive.marketStageId } })
  };
  assert.deepEqual(positiveAfterReplay, positiveAfterPublication);
  executed.add("W6-TXN-02");
  assert.deepEqual([...executed].sort(), [...requiredCases, ...controlCases].sort());
  await db.$disconnect();
});

test("recover projects initialize/task/check messages with deterministic ordering and fingerprints", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_recover");
  const queuedId = newResearchId();
  await freshResearch(repo, queuedId, "owner_kiw1", 1);

  const researchId = newResearchId();
  await freshResearch(repo, researchId, "owner_kiw1", 2);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(2) }, NOW);
  const stageId = initialized.stage.id;
  const claimedTaskId = keywordTaskId(stageId, "0:suggestions");
  await repo.claim({ taskId: claimedTaskId, owner: "w", token: newLeaseToken() }, NOW);
  await completeStageTasks(db, repo, stageId, ["0:related", "1:suggestions", "1:related"]);
  await db.keywordResearchStage.update({ where: { id: stageId }, data: { state: "ready" } });
  const staleAggStageId = keywordStageId(queuedId, "anchor_screen", 1);
  await db.keywordResearchStage.create({ data: {
    id: staleAggStageId, researchId: queuedId, stage: "anchor_screen", generation: 1,
    expectedCount: 1, state: "aggregating",
    aggregationLeaseExpiresAt: new Date(NOW.getTime() - 1_000),
    createdAt: NOW, updatedAt: NOW
  } });

  const empty = await repo.recover(NOW);
  assert.ok(empty.initializations.some(({ researchId: id }) => id === queuedId));
  assert.equal(empty.taskDispatches.filter(({ taskId }) => taskId === claimedTaskId).length, 0);
  assert.ok(empty.aggregateChecks.some(({ stageId: id }) => id === stageId));
  assert.ok(empty.aggregateChecks.some(({ stageId: id }) => id === staleAggStageId));

  const recovered = await repo.recover(LATER);
  assert.ok(recovered.initializations.some(({ researchId: id }) => id === queuedId));
  assert.ok(recovered.taskDispatches.some(({ taskId }) => taskId === claimedTaskId));
  const dispatch = recovered.taskDispatches.find(({ taskId }) => taskId === claimedTaskId);
  assert.equal(dispatch.researchId, researchId);
  assert.equal(dispatch.generation, 1);
  assert.equal(dispatch.stage, "expansion");
  assert.equal(dispatch.stageId, stageId);
  assert.equal(dispatch.itemKey, "0:suggestions");
  assert.equal(dispatch.inputFingerprint, (await db.keywordResearchTask.findUnique({ where: { id: claimedTaskId } })).inputFingerprint);
  assert.equal(dispatch.endpointKey, "keyword_suggestions");
  assert.equal(dispatch.requestFingerprint, (await db.keywordResearchTask.findUnique({ where: { id: claimedTaskId } })).requestFingerprint);
  const checks = recovered.aggregateChecks;
  for (const check of checks) {
    assert.match(check.stageInputFingerprint, /^[a-f0-9]{64}$/u);
    assert.ok(check.researchId && check.generation && check.stage && check.stageId);
  }
  const orderedIds = recovered.taskDispatches.map(({ taskId }) => taskId);
  assert.deepEqual(orderedIds, [...orderedIds].sort());
  const orderedChecks = checks.map(({ stageId }) => stageId);
  assert.deepEqual(orderedChecks, [...orderedChecks].sort());
  const orderedInit = recovered.initializations.map(({ researchId: id }) => id);
  assert.deepEqual(orderedInit, [...orderedInit].sort());

  const again = await repo.recover(LATER);
  assert.deepEqual(again.aggregateChecks.map((check) => check.stageInputFingerprint),
    recovered.aggregateChecks.map((check) => check.stageInputFingerprint));
  await db.$disconnect();
});

test("full durable flow: initialize → expansion → candidate → shortlist → result with owner API handoff intact", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_flow");
  const researchId = newResearchId();
  await freshResearch(repo, researchId, "owner_kiw1", 2);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(2) }, NOW);
  await completeStageTasks(db, repo, initialized.stage.id, initialized.tasks.map((task) => task.itemKey));
  const expAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token: expAgg }, NOW);
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("anchor-input"),
    endpointKey: "keyword_overview", requestFingerprint: fp("anchor-request") };
  const candidate = await repo.publishCandidateManifest({ researchId, generation: 1, token: expAgg,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  assert.equal(candidate.outcome, "terminal");
  await completeStageTasks(db, repo, candidate.nextStage.id, ["US:0"]);
  const ancAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "anchor_screen", generation: 1, owner: "a", token: ancAgg }, NOW);
  const shortlist = await repo.publishShortlist({ researchId, generation: 1, token: ancAgg,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks: marketTasksFor() }, NOW);
  assert.equal(shortlist.outcome, "terminal");
  await completeStageTasks(db, repo, shortlist.nextStage.id, shortlist.tasks.map((task) => task.itemKey));
  const mktAgg = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "market_overview", generation: 1, owner: "a", token: mktAgg }, NOW);

  const keywords = [makeKeywordRow("alpha keyword"), makeKeywordRow("beta keyword")];
  const result = makeResult(keywords, researchId);
  const selectionItems = defaultSelectionFor(keywords);
  assert.equal((await repo.publishResearchResult({ researchId, generation: 1, token: mktAgg,
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("rf"), selectionItems }, NOW)).outcome, "terminal");

  const handoffInput = { researchId, ownerId: "owner_kiw1", expectedSelectionRevision: 1,
    clientRequestId: "client-request-kw-0001", selectionFingerprint: fp("h"),
    runId: "run_kir1_handoff_0001", items: selectionItems.map((item) => ({ itemId: item.itemId, keyword: item.keyword })) };
  const constructRun = async (tx, { runId, research, now, items }) => tx.run.create({ data: {
    id: runId, ownerId: research.ownerId, state: "queued", stage: "keyword_research",
    normalizedShopTypes: [], progress: {}, queryPlanSource: "keyword_research",
    keywordResearchId: research.id, keywordSelectionRevision: 1,
    keywordSelectionSnapshot: { items }, createdAt: now } });
  const constructQueries = async (tx, { run, items, now }) => Promise.all(items.map((item, index) =>
    tx.runQuery.create({ data: { id: `rq_${run.id}_${index}`, runId: run.id, categoryIndex: 0,
      sequence: index, query: item.keyword, source: "generated",
      keywordResearchItemId: item.itemId, createdAt: now, updatedAt: now } })));
  const created = await repo.createRun({ ...handoffInput, constructRun, constructQueries }, NOW);
  assert.equal(created.outcome, "created");
  assert.equal(created.run.queryPlanSource, "keyword_research");
  const retry = await repo.createRun({ ...handoffInput, constructRun, constructQueries }, NOW);
  assert.equal(retry.outcome, "found");
  const runQueries = await db.runQuery.findMany({ where: { runId: handoffInput.runId } });
  assert.equal(runQueries.length, selectionItems.length);
  assert.equal(runQueries[0].keywordResearchItemId, selectionItems[0].itemId);
  const laterSave = await repo.saveSelection({ researchId, ownerId: "owner_kiw1", expectedRevision: 1,
    items: selectionItems }, LATER);
  assert.equal(laterSave.outcome, "created");
  assert.equal(laterSave.selectionRevision, 2);
  await db.$disconnect();
});

test("cache fresh/stale/conflict and throttle gap", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_cache");
  assert.equal((await repo.cacheRead({ requestFingerprint: fp("c") }, NOW)).outcome, "not_found");
  const written = await repo.cacheWrite({ requestFingerprint: fp("c"), cacheKey: "kw:suggestions:abc",
    endpointKey: "keyword_suggestions", normalizedResponse: { keywords: ["a"] },
    resultFingerprint: fp("n"), ttlSeconds: 60 }, NOW);
  assert.equal(written.outcome, "created");
  assert.equal((await repo.cacheWrite({ requestFingerprint: fp("c"), cacheKey: "kw:suggestions:abc",
    endpointKey: "keyword_suggestions", normalizedResponse: { keywords: ["a"] },
    resultFingerprint: fp("n"), ttlSeconds: 60 }, NOW)).outcome, "found");
  assert.equal((await repo.cacheWrite({ requestFingerprint: fp("c"), cacheKey: "kw:suggestions:abc",
    endpointKey: "keyword_suggestions", normalizedResponse: { keywords: ["b"] },
    resultFingerprint: fp("n2"), ttlSeconds: 60 }, NOW)).outcome, "conflict");
  assert.equal((await repo.cacheRead({ requestFingerprint: fp("c") },
    new Date(NOW.getTime() + 59_000))).outcome, "found");
  assert.equal((await repo.cacheRead({ requestFingerprint: fp("c") },
    new Date(NOW.getTime() + 61_000))).outcome, "not_found");

  const first = await repo.claimThrottle({});
  assert.equal(first.outcome, "claimed");
  const second = await repo.claimThrottle({});
  assert.equal(second.outcome, "delayed");
  assert.ok(second.retryAt instanceof Date);
  await db.$disconnect();
});

test("negative control: stale task token never mutates (task-token predicate)", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_neg_token");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  const stale = await repo.recordAttempt({ taskId, token: newLeaseToken(),
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(stale.outcome, "lost");
  const attemptCount = await db.keywordResearchProviderAttempt.count({ where: { taskId } });
  assert.equal(attemptCount, 0);
  const taskAfter = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  assert.equal(taskAfter.attemptCount, 0);
  const terminalizeStale = await repo.terminalize({ taskId, token: newLeaseToken(), state: "succeeded",
    artifactS3Key: "runs/x.json", artifactFingerprint: fp("x") }, NOW);
  assert.equal(terminalizeStale.outcome, "lost");
  await db.$disconnect();
});

test("SCN-KI-021: attempt-five planned/in_flight replay reconciles before the sixth-attempt ceiling", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_r21_ceiling");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  await db.keywordResearchTask.update({ where: { id: taskId }, data: { attemptCount: 5 } });
  await db.keywordResearchProviderAttempt.create({ data: {
    id: "kra_r21_planned5", taskId, attemptNumber: 5, state: "planned",
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    plannedAt: NOW, createdAt: NOW, updatedAt: NOW
  } });

  const equalReplay = await repo.recordAttempt({ taskId, token,
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(equalReplay.outcome, "found");
  assert.equal(equalReplay.mayCall, false);
  assert.equal(equalReplay.attempt.attemptNumber, 5);
  assert.equal(await db.keywordResearchProviderAttempt.count({ where: { taskId } }), 1);
  assert.equal((await db.keywordResearchTask.findUnique({ where: { id: taskId } })).attemptCount, 5);

  const unequal = await repo.recordAttempt({ taskId, token,
    requestFingerprint: fp("different"), reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(unequal.outcome, "conflict");

  await db.keywordResearchProviderAttempt.update({
    where: { taskId_attemptNumber: { taskId, attemptNumber: 5 } },
    data: { state: "in_flight" }
  });
  const inFlightReplay = await repo.recordAttempt({ taskId, token,
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(inFlightReplay.outcome, "found");
  assert.equal(inFlightReplay.mayCall, false);
  assert.equal(await db.keywordResearchProviderAttempt.count({ where: { taskId } }), 1);

  await db.keywordResearchProviderAttempt.update({
    where: { taskId_attemptNumber: { taskId, attemptNumber: 5 } },
    data: { state: "failed", providerCostUsd: "0.01200000", completedAt: NOW }
  });
  const exhausted = await repo.recordAttempt({ taskId, token,
    requestFingerprint: taskRow.requestFingerprint, reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(exhausted.outcome, "conflict");
  assert.equal(exhausted.code, "KEYWORD_PROVIDER_RETRY_EXHAUSTED");
  await db.$disconnect();
});

test("SCN-KI-021: scheduleRetry replays the persisted due time before, at, and after it regardless of clock", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_r21_retry");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  const attempt = await repo.recordAttempt({ taskId, token, requestFingerprint: taskRow.requestFingerprint,
    reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW);
  assert.equal(attempt.outcome, "created");
  await repo.settleAttempt({ taskId, token, attemptNumber: 1, state: "failed",
    providerCostUsd: "0.01200000", safeErrorCode: "KEYWORD_PROVIDER_RETRYABLE", cacheEntry: null }, NOW);

  const scheduled = await repo.scheduleRetry({ taskId, token, attemptNumber: 1 }, NOW);
  assert.equal(scheduled.outcome, "delayed");
  const storedAt = scheduled.retryAt;
  assert.ok(storedAt instanceof Date);
  const taskScheduled = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  assert.equal(taskScheduled.state, "pending");
  assert.equal(taskScheduled.nextAttemptAt.getTime(), storedAt.getTime());
  assert.equal(taskScheduled.leaseToken, null);

  for (const offset of [-1, 0, 60_000]) {
    const replay = await repo.scheduleRetry({ taskId, token, attemptNumber: 1 },
      new Date(storedAt.getTime() + offset));
    assert.equal(replay.outcome, "delayed");
    assert.equal(replay.retryAt.getTime(), storedAt.getTime());
  }
  const taskAfter = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  assert.equal(taskAfter.nextAttemptAt.getTime(), storedAt.getTime());
  assert.equal(taskAfter.state, "pending");
  assert.equal(taskAfter.attemptCount, 1);
  assert.equal(await db.keywordResearchProviderAttempt.count({ where: { taskId } }), 1);

  assert.equal((await repo.scheduleRetry({ taskId, token, attemptNumber: 2 }, storedAt)).outcome, "conflict");
  const dueClaim = await repo.claim({ taskId, owner: "w", token: newLeaseToken() }, storedAt);
  assert.equal(dueClaim.outcome, "claimed");
  await db.$disconnect();
});

test("SCN-KI-021: zero-row market-stage conditional update returns lost and leaves the set wholly unchanged", { skip: !enabled }, async (t) => {
  const schema = `kir1_r21_mktzero_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(clientWithInjectedZeroCount(db, (path, args) =>
    path === "keywordResearchStage.updateMany" && args[0]?.data?.manifestS3Key === "runs/final.json"));
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const { mktToken, marketStageId } = await advanceToMarketStage(db, repo, researchId);
  const keywords = [makeKeywordRow("alpha keyword")];
  const result = makeResult(keywords, researchId);
  const selectionItems = defaultSelectionFor(keywords);

  const published = await repo.publishResearchResult({ researchId, generation: 1, token: mktToken,
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("rf"), selectionItems }, NOW);
  assert.equal(published.outcome, "lost");
  const marketAfter = await db.keywordResearchStage.findUnique({ where: { id: marketStageId } });
  assert.equal(marketAfter.state, "aggregating");
  assert.equal(marketAfter.manifestS3Key, null);
  assert.equal(marketAfter.manifestFingerprint, null);
  const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
  assert.equal(research.state, "running");
  assert.equal(research.result, null);
  assert.equal(research.resultFingerprint, null);
  assert.equal(research.selection, null);
  assert.equal(research.selectionRevision, 0);
  await db.$disconnect();
});

test("SCN-KI-021: zero-row research conditional update returns conflict and rolls back the market write", { skip: !enabled }, async (t) => {
  const schema = `kir1_r21_reszero_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(clientWithInjectedZeroCount(db, (path, args) =>
    path === "keywordResearch.updateMany" && args[0]?.data?.resultFingerprint !== undefined));
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const { mktToken, marketStageId } = await advanceToMarketStage(db, repo, researchId);
  const keywords = [makeKeywordRow("alpha keyword")];
  const result = makeResult(keywords, researchId);
  const selectionItems = defaultSelectionFor(keywords);

  const published = await repo.publishResearchResult({ researchId, generation: 1, token: mktToken,
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("rf"), selectionItems }, NOW);
  assert.equal(published.outcome, "conflict");
  const marketAfter = await db.keywordResearchStage.findUnique({ where: { id: marketStageId } });
  assert.equal(marketAfter.state, "aggregating");
  assert.equal(marketAfter.manifestS3Key, null);
  assert.equal(marketAfter.manifestFingerprint, null);
  const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
  assert.equal(research.state, "running");
  assert.equal(research.result, null);
  assert.equal(research.resultFingerprint, null);
  assert.equal(research.selection, null);
  assert.equal(research.selectionRevision, 0);
  await db.$disconnect();
});

test("SCN-KI-021: completed market stage with running research is a conflicting partial state with no write", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir1_r21_partial");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const { mktToken, marketStageId } = await advanceToMarketStage(db, repo, researchId);
  await db.keywordResearchStage.update({ where: { id: marketStageId },
    data: { state: "completed", manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"),
      completedAt: NOW } });
  const keywords = [makeKeywordRow("alpha keyword")];
  const result = makeResult(keywords, researchId);
  const selectionItems = defaultSelectionFor(keywords);

  const published = await repo.publishResearchResult({ researchId, generation: 1, token: mktToken,
    manifestS3Key: "runs/final.json", manifestFingerprint: fp("final"), result,
    resultFingerprint: fp("rf"), selectionItems }, NOW);
  assert.equal(published.outcome, "conflict");
  const marketAfter = await db.keywordResearchStage.findUnique({ where: { id: marketStageId } });
  assert.equal(marketAfter.state, "completed");
  assert.equal(marketAfter.manifestS3Key, "runs/final.json");
  const research = await db.keywordResearch.findUnique({ where: { id: researchId } });
  assert.equal(research.state, "running");
  assert.equal(research.result, null);
  assert.equal(research.resultFingerprint, null);
  assert.equal(research.selection, null);
  assert.equal(research.selectionRevision, 0);
  await db.$disconnect();
});

async function setupExpansionAggregator(db, repo, researchId) {
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, initialized.stage.id, initialized.tasks.map((task) => task.itemKey));
  const token = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token }, NOW);
  return { token, stageId: initialized.stage.id };
}

async function setupAnchorAggregator(db, repo, researchId) {
  const { token: expToken } = await setupExpansionAggregator(db, repo, researchId);
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("ai"), endpointKey: "keyword_overview",
    requestFingerprint: fp("ar") };
  const candidate = await repo.publishCandidateManifest({ researchId, generation: 1, token: expToken,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW);
  await completeStageTasks(db, repo, candidate.nextStage.id, ["US:0"]);
  const token = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "anchor_screen", generation: 1, owner: "a", token }, NOW);
  return { token, stageId: candidate.nextStage.id };
}

test("SCN-KI-022: task lease boundary at +59,999ms/exact/+1ms with B reclaim and stale-A heartbeat/terminalize losing with unchanged rows and exactly one counter", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kiw2_taskbnd");
  const researchId = newResearchId();
  await freshResearch(repo, researchId, "owner_kiw1", 2);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(2) }, NOW);
  const stageId = initialized.stage.id;
  const taskId = keywordTaskId(stageId, "0:suggestions");
  const tokenA = newLeaseToken();
  await repo.claim({ taskId, owner: "a", token: tokenA }, NOW);

  const hbAt = new Date(NOW.getTime() + 59_999);
  const hb = await repo.heartbeat({ taskId, token: tokenA }, hbAt);
  assert.equal(hb.outcome, "claimed");
  assert.equal(hb.leaseExpiresAt.getTime(), NOW.getTime() + 119_999,
    "live heartbeat at +59,999ms extends expiry to exactly +119,999ms");
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  assert.equal(taskRow.leaseExpiresAt.getTime(), NOW.getTime() + 119_999);

  const tokenB = newLeaseToken();
  assert.equal((await repo.claim({ taskId, owner: "b", token: tokenB },
    new Date(NOW.getTime() + 119_998))).outcome, "lost", "B loses at renewed-expiry minus 1ms");
  assert.equal((await repo.claim({ taskId, owner: "b", token: tokenB },
    new Date(NOW.getTime() + 119_999))).outcome, "claimed", "B wins at exact renewed expiry");

  const before = {
    task: await db.keywordResearchTask.findUnique({ where: { id: taskId } }),
    stage: await db.keywordResearchStage.findUnique({ where: { id: stageId } })
  };
  assert.equal((await repo.heartbeat({ taskId, token: tokenA },
    new Date(NOW.getTime() + 119_999))).outcome, "lost", "stale A heartbeat lost after B reclaim");
  assert.deepEqual(await db.keywordResearchTask.findUnique({ where: { id: taskId } }), before.task,
    "task row unchanged after stale A heartbeat");
  assert.deepEqual(await db.keywordResearchStage.findUnique({ where: { id: stageId } }), before.stage,
    "stage row unchanged after stale A heartbeat");
  assert.equal((await repo.terminalize({ taskId, token: tokenA, state: "succeeded",
    artifactS3Key: "runs/t.json", artifactFingerprint: fp("t") },
  new Date(NOW.getTime() + 119_999))).outcome, "lost", "stale A terminalize lost after B reclaim");
  assert.deepEqual(await db.keywordResearchTask.findUnique({ where: { id: taskId } }), before.task,
    "task row unchanged after stale A terminalize");
  assert.deepEqual(await db.keywordResearchStage.findUnique({ where: { id: stageId } }), before.stage,
    "stage row unchanged after stale A terminalize");

  assert.equal((await repo.terminalize({ taskId, token: tokenB, state: "succeeded",
    artifactS3Key: "runs/t.json", artifactFingerprint: fp("t") },
  new Date(NOW.getTime() + 119_999))).outcome, "terminal", "B terminalizes once");
  assert.equal((await repo.terminalize({ taskId, token: tokenB, state: "succeeded",
    artifactS3Key: "runs/t.json", artifactFingerprint: fp("t") },
  new Date(NOW.getTime() + 119_999))).outcome, "found", "exact replay returns found");
  const stageAfter = await db.keywordResearchStage.findUnique({ where: { id: stageId } });
  assert.equal(stageAfter.terminalCount, 1, "owning-stage terminal counter exactly one");
  assert.equal(stageAfter.succeededCount, 1, "owning-stage succeeded counter exactly one");

  const researchId2 = newResearchId();
  await freshResearch(repo, researchId2, "owner_kiw1", 1);
  const init2 = await repo.initialize({ researchId: researchId2, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const taskId2 = keywordTaskId(init2.stage.id, "0:suggestions");
  const tokenA2 = newLeaseToken();
  await repo.claim({ taskId: taskId2, owner: "a", token: tokenA2 }, NOW);
  assert.equal((await repo.heartbeat({ taskId: taskId2, token: tokenA2 },
    new Date(NOW.getTime() + 59_999))).outcome, "claimed");
  assert.equal((await repo.claim({ taskId: taskId2, owner: "b", token: newLeaseToken() },
    new Date(NOW.getTime() + 120_000))).outcome, "claimed", "separate +1ms repetition reclaims");
  await db.$disconnect();
});

test("SCN-KI-022: aggregation heartbeat at exactly +40,000ms extends to +160,000ms with one write and zero reads and unchanged owner/token/acquired/attempt/counters/manifests; competitor loses at -1ms and reclaims at exact/+1ms", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kiw2_aggbnd");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, initialized.stage.id, initialized.tasks.map((task) => task.itemKey));
  const stageId = initialized.stage.id;
  const tokenA = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token: tokenA }, NOW);

  const stageBefore = await db.keywordResearchStage.findUnique({ where: { id: stageId } });
  const { client, spy } = clientWithQuerySpy(db);
  const spied = new PrismaKeywordResearchRepository(client);
  const hbAt = new Date(NOW.getTime() + 40_000);
  const hb = await spied.heartbeatAggregator({ researchId, stage: "expansion", generation: 1,
    token: tokenA }, hbAt);
  assert.equal(hb.outcome, "claimed");
  assert.equal(hb.leaseExpiresAt.getTime(), NOW.getTime() + 160_000,
    "aggregation heartbeat at +40,000ms extends expiry to exactly +160,000ms");
  assert.equal(spy.stageWrites, 1, "one stage write");
  assert.equal(spy.stageReads, 0, "zero stage reads");
  assert.equal(spy.taskWrites, 0, "zero task writes");
  const stageAfter = await db.keywordResearchStage.findUnique({ where: { id: stageId } });
  assert.equal(stageAfter.aggregationLeaseExpiresAt.getTime(), NOW.getTime() + 160_000);
  assert.equal(stageAfter.aggregationOwner, stageBefore.aggregationOwner, "owner unchanged");
  assert.equal(stageAfter.aggregationLeaseToken, stageBefore.aggregationLeaseToken, "token unchanged");
  assert.equal(stageAfter.aggregationLeaseAcquiredAt.getTime(), stageBefore.aggregationLeaseAcquiredAt.getTime(),
    "acquired-at unchanged");
  assert.equal(stageAfter.aggregationAttempt, stageBefore.aggregationAttempt, "attempt unchanged");
  assert.equal(stageAfter.succeededCount, stageBefore.succeededCount, "succeeded counter unchanged");
  assert.equal(stageAfter.terminalCount, stageBefore.terminalCount, "terminal counter unchanged");
  assert.equal(stageAfter.manifestS3Key, stageBefore.manifestS3Key, "manifest key unchanged");
  assert.equal(stageAfter.manifestFingerprint, stageBefore.manifestFingerprint, "manifest fingerprint unchanged");
  assert.equal(stageAfter.state, "aggregating", "state unchanged");

  const tokenB = newLeaseToken();
  assert.equal((await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "b",
    token: tokenB }, new Date(NOW.getTime() + 159_999))).outcome, "lost", "competitor loses at renewed-expiry minus 1ms");
  assert.equal((await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "b",
    token: tokenB }, new Date(NOW.getTime() + 160_000))).outcome, "claimed", "competitor reclaims at exact renewed expiry");

  const researchId2 = newResearchId();
  await freshResearch(repo, researchId2);
  const init2 = await repo.initialize({ researchId: researchId2, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, init2.stage.id, init2.tasks.map((task) => task.itemKey));
  const a2 = newLeaseToken();
  await repo.claimAggregator({ researchId: researchId2, stage: "expansion", generation: 1, owner: "a",
    token: a2 }, NOW);
  assert.equal((await repo.claimAggregator({ researchId: researchId2, stage: "expansion", generation: 1,
    owner: "b", token: newLeaseToken() }, new Date(NOW.getTime() + 120_001))).outcome, "claimed",
  "separate +1ms repetition reclaims");
  assert.equal((await repo.heartbeatAggregator({ researchId: researchId2, stage: "expansion", generation: 1,
    token: newLeaseToken() }, hbAt)).outcome, "lost", "wrong token loses");

  const researchId3 = newResearchId();
  await freshResearch(repo, researchId3);
  const init3 = await repo.initialize({ researchId: researchId3, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, init3.stage.id, init3.tasks.map((task) => task.itemKey));
  const a3 = newLeaseToken();
  await repo.claimAggregator({ researchId: researchId3, stage: "expansion", generation: 1, owner: "a",
    token: a3 }, NOW);
  assert.equal((await repo.heartbeatAggregator({ researchId: researchId3, stage: "expansion", generation: 1,
    token: a3 }, new Date(NOW.getTime() + 121_000))).outcome, "lost", "expired lease loses");
  await db.$disconnect();
});

test("SCN-KI-022: stale owners lose candidate/shortlist/final/fail with full row-equality witnesses; B publishes each exactly once, exact replays return found, and a second failStage has no second terminal", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kiw2_stalepaths");

  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("ai"), endpointKey: "keyword_overview",
    requestFingerprint: fp("ar") };

  const resC = newResearchId();
  await freshResearch(repo, resC);
  const { token: aC, stageId: cStageId } = await setupExpansionAggregator(db, repo, resC);
  const bC = newLeaseToken();
  await repo.claimAggregator({ researchId: resC, stage: "expansion", generation: 1, owner: "b",
    token: bC }, new Date(NOW.getTime() + 121_000));
  const cOptions = { researchId: resC, stageIds: [cStageId],
    nextStageId: keywordStageId(resC, "anchor_screen", 1) };
  const beforeC = await snapshotResearchRows(db, cOptions);
  assert.equal((await repo.publishCandidateManifest({ researchId: resC, generation: 1, token: aC,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] },
  new Date(NOW.getTime() + 121_000))).outcome, "lost", "stale A candidate lost");
  await assertSnapshotUnchanged(db, { ...cOptions, before: beforeC },
    "candidate stale call leaves research/stage/next-stage rows and task set equal");
  assert.equal((await repo.publishCandidateManifest({ researchId: resC, generation: 1, token: bC,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] },
  new Date(NOW.getTime() + 121_000))).outcome, "terminal", "B candidate publishes once");
  assert.equal((await repo.publishCandidateManifest({ researchId: resC, generation: 1, token: bC,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] },
  new Date(NOW.getTime() + 121_000))).outcome, "found", "candidate exact replay returns found");

  const resS = newResearchId();
  await freshResearch(repo, resS);
  const { token: aS, stageId: sStageId } = await setupAnchorAggregator(db, repo, resS);
  const bS = newLeaseToken();
  await repo.claimAggregator({ researchId: resS, stage: "anchor_screen", generation: 1, owner: "b",
    token: bS }, new Date(NOW.getTime() + 121_000));
  const sOptions = { researchId: resS, stageIds: [sStageId],
    nextStageId: keywordStageId(resS, "market_overview", 1) };
  const beforeS = await snapshotResearchRows(db, sOptions);
  assert.equal((await repo.publishShortlist({ researchId: resS, generation: 1, token: aS,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks: marketTasksFor() },
  new Date(NOW.getTime() + 121_000))).outcome, "lost", "stale A shortlist lost");
  await assertSnapshotUnchanged(db, { ...sOptions, before: beforeS },
    "shortlist stale call leaves research/stage/next-stage rows and task set equal");
  assert.equal((await repo.publishShortlist({ researchId: resS, generation: 1, token: bS,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks: marketTasksFor() },
  new Date(NOW.getTime() + 121_000))).outcome, "terminal", "B shortlist publishes once");
  assert.equal((await repo.publishShortlist({ researchId: resS, generation: 1, token: bS,
    manifestS3Key: "runs/s.json", manifestFingerprint: fp("s"), marketTasks: marketTasksFor() },
  new Date(NOW.getTime() + 121_000))).outcome, "found", "shortlist exact replay returns found");

  const resF = newResearchId();
  await freshResearch(repo, resF);
  const { mktToken: aF, marketStageId: fStageId } = await advanceToMarketStage(db, repo, resF);
  const bF = newLeaseToken();
  await repo.claimAggregator({ researchId: resF, stage: "market_overview", generation: 1, owner: "b",
    token: bF }, new Date(NOW.getTime() + 121_000));
  const keywords = [makeKeywordRow("alpha keyword")];
  const result = makeResult(keywords, resF);
  const selectionItems = defaultSelectionFor(keywords);
  const fOptions = { researchId: resF, stageIds: [fStageId], nextStageId: null };
  const beforeF = await snapshotResearchRows(db, fOptions);
  assert.equal((await repo.publishResearchResult({ researchId: resF, generation: 1, token: aF,
    manifestS3Key: "runs/f.json", manifestFingerprint: fp("f"), result,
    resultFingerprint: fp("rf"), selectionItems }, new Date(NOW.getTime() + 121_000))).outcome,
  "lost", "stale A final publication lost");
  await assertSnapshotUnchanged(db, { ...fOptions, before: beforeF },
    "final stale call leaves research/stage rows and selection/result equal");
  assert.equal((await repo.publishResearchResult({ researchId: resF, generation: 1, token: bF,
    manifestS3Key: "runs/f.json", manifestFingerprint: fp("f"), result,
    resultFingerprint: fp("rf"), selectionItems }, new Date(NOW.getTime() + 121_000))).outcome,
  "terminal", "B final publication once");
  assert.equal((await repo.publishResearchResult({ researchId: resF, generation: 1, token: bF,
    manifestS3Key: "runs/f.json", manifestFingerprint: fp("f"), result,
    resultFingerprint: fp("rf"), selectionItems }, new Date(NOW.getTime() + 121_000))).outcome,
  "found", "final exact replay returns found");

  const resFail = newResearchId();
  await freshResearch(repo, resFail);
  const { mktToken: aFail, marketStageId: failStageId } = await advanceToMarketStage(db, repo, resFail);
  const bFail = newLeaseToken();
  await repo.claimAggregator({ researchId: resFail, stage: "market_overview", generation: 1, owner: "b",
    token: bFail }, new Date(NOW.getTime() + 121_000));
  const failOptions = { researchId: resFail, stageIds: [failStageId], nextStageId: null };
  const beforeFail = await snapshotResearchRows(db, failOptions);
  assert.equal((await repo.failStage({ researchId: resFail, stage: "market_overview", generation: 1,
    token: aFail, safeErrorCode: "X" }, new Date(NOW.getTime() + 121_000))).outcome, "lost",
  "stale A fail-stage lost");
  await assertSnapshotUnchanged(db, { ...failOptions, before: beforeFail },
    "fail stale call leaves research/stage rows equal");
  assert.equal((await repo.failStage({ researchId: resFail, stage: "market_overview", generation: 1,
    token: bFail, safeErrorCode: "X" }, new Date(NOW.getTime() + 121_000))).outcome, "terminal",
  "B fail-stage once");
  const secondFail = await repo.failStage({ researchId: resFail, stage: "market_overview", generation: 1,
    token: bFail, safeErrorCode: "X" }, new Date(NOW.getTime() + 121_000));
  assert.equal(secondFail.outcome, "lost", "second failStage creates no second terminal transition");
  const failResearch = await db.keywordResearch.findUnique({ where: { id: resFail } });
  assert.equal(failResearch.state, "failed", "research failed exactly once");
  await db.$disconnect();
});

test("SCN-KI-022: exactly one task terminal counter and one aggregation publication occur, never two", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kiw2_onceterm");
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const stageId = initialized.stage.id;
  const taskId = keywordTaskId(stageId, "0:suggestions");
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  assert.equal((await repo.terminalize({ taskId, token, state: "succeeded",
    artifactS3Key: "runs/t.json", artifactFingerprint: fp("t") }, NOW)).outcome, "terminal");
  const stageAfter = await db.keywordResearchStage.findUnique({ where: { id: stageId } });
  assert.equal(stageAfter.succeededCount, 1, "one terminal counter");
  assert.equal(stageAfter.terminalCount, 1);

  await completeStageTasks(db, repo, stageId, ["0:related"]);
  const aggToken = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a", token: aggToken }, NOW);
  const anchorTask = { itemKey: "US:0", inputFingerprint: fp("ai"), endpointKey: "keyword_overview",
    requestFingerprint: fp("ar") };
  assert.equal((await repo.publishCandidateManifest({ researchId, generation: 1, token: aggToken,
    manifestS3Key: "runs/m.json", manifestFingerprint: fp("m"), nextStageTasks: [anchorTask] }, NOW)).outcome,
  "terminal", "one aggregation publication");
  const anchorStages = await db.keywordResearchStage.findMany({
    where: { id: keywordStageId(researchId, "anchor_screen", 1) } });
  assert.equal(anchorStages.length, 1, "exactly one anchor stage created");
  await db.$disconnect();
});

test("SCN-KI-022 V5: removing one heartbeat predicate falsifies the unchanged lost oracle via assert.rejects and the unwrapped client restores it", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kiw2_v5ctrl");
  const researchId = newResearchId();
  await freshResearch(repo, researchId, "owner_kiw1", 3);
  const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(3) }, NOW);
  const stageId = initialized.stage.id;
  const AT10 = new Date(NOW.getTime() + 10_000);
  const AT61 = new Date(NOW.getTime() + 61_000);

  async function freshTask(itemKey) {
    const taskId = keywordTaskId(stageId, itemKey);
    const token = newLeaseToken();
    await repo.claim({ taskId, owner: "w", token }, NOW);
    return { taskId, token };
  }

  const assertLostHeartbeat = async (repo_, taskId, token, at) => {
    const result = await repo_.heartbeat({ taskId, token }, at);
    assert.equal(result.outcome, "lost");
  };

  {
    const { taskId } = await freshTask("0:suggestions");
    const wrapped = clientWithRemovedTaskHeartbeatPredicate(db, "leaseToken");
    const wrappedRepo = new PrismaKeywordResearchRepository(wrapped);
    await assert.rejects(
      () => assertLostHeartbeat(wrappedRepo, taskId, newLeaseToken(), AT10),
      assert.AssertionError,
      "control 1: removing the token predicate falsifies the wrong-token lost oracle"
    );
    const { taskId: freshId } = await freshTask("0:related");
    await assertLostHeartbeat(repo, freshId, newLeaseToken(), AT10);
  }

  {
    const { taskId, token } = await freshTask("1:suggestions");
    await repo.terminalize({ taskId, token, state: "succeeded", artifactS3Key: "runs/x.json",
      artifactFingerprint: fp("x") }, NOW);
    const wrapped = clientWithRemovedTaskHeartbeatPredicate(db, "state");
    const wrappedRepo = new PrismaKeywordResearchRepository(wrapped);
    await assert.rejects(
      () => assertLostHeartbeat(wrappedRepo, taskId, token, AT10),
      assert.AssertionError,
      "control 2: removing the state predicate falsifies the terminal-row lost oracle"
    );
    const { taskId: freshId, token: freshToken } = await freshTask("1:related");
    await repo.terminalize({ taskId: freshId, token: freshToken, state: "succeeded",
      artifactS3Key: "runs/y.json", artifactFingerprint: fp("y") }, NOW);
    await assertLostHeartbeat(repo, freshId, freshToken, AT10);
  }

  {
    const { taskId, token } = await freshTask("2:suggestions");
    const wrapped = clientWithRemovedTaskHeartbeatPredicate(db, "leaseExpiresAt");
    const wrappedRepo = new PrismaKeywordResearchRepository(wrapped);
    await assert.rejects(
      () => assertLostHeartbeat(wrappedRepo, taskId, token, AT61),
      assert.AssertionError,
      "control 3: removing the live-expiry predicate falsifies the expired-owner lost oracle"
    );
    const { taskId: freshId, token: freshToken } = await freshTask("2:related");
    await assertLostHeartbeat(repo, freshId, freshToken, AT61);
  }
  await db.$disconnect();
});

test("SCN-KI-023: same-token task heartbeat at original expiry +60,000ms returns lost with unchanged task/stage rows; stale aggregation heartbeat at renewed expiry +160,000ms after B reclaim returns lost with unchanged stage/research rows", { skip: !enabled }, async (t) => {
  const { db, repo } = await setupRepo(t, "kir2_rt2");

  const resT = newResearchId();
  await freshResearch(repo, resT);
  const initT = await repo.initialize({ researchId: resT, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  const stageIdT = initT.stage.id;
  const taskId = keywordTaskId(stageIdT, "0:suggestions");
  const tokenA = newLeaseToken();
  assert.equal((await repo.claim({ taskId, owner: "a", token: tokenA }, NOW)).outcome, "claimed");
  assert.equal((await db.keywordResearchTask.findUnique({ where: { id: taskId } })).leaseExpiresAt.getTime(),
    NOW.getTime() + 60_000, "task lease original expiry is exactly T0+60,000ms");

  const beforeT = {
    task: await db.keywordResearchTask.findUnique({ where: { id: taskId } }),
    stage: await db.keywordResearchStage.findUnique({ where: { id: stageIdT } })
  };
  const hbT = await repo.heartbeat({ taskId, token: tokenA }, new Date(NOW.getTime() + 60_000));
  assert.equal(hbT.outcome, "lost", "same-token task heartbeat at exact original expiry returns lost");
  assert.deepEqual(await db.keywordResearchTask.findUnique({ where: { id: taskId } }), beforeT.task,
    "task row unchanged after same-token heartbeat at original expiry");
  assert.deepEqual(await db.keywordResearchStage.findUnique({ where: { id: stageIdT } }), beforeT.stage,
    "stage row unchanged after same-token heartbeat at original expiry");

  const resA = newResearchId();
  await freshResearch(repo, resA);
  const initA = await repo.initialize({ researchId: resA, generation: 1, stage: "expansion",
    tasks: expansionTasksFor(1) }, NOW);
  await completeStageTasks(db, repo, initA.stage.id, initA.tasks.map((task) => task.itemKey));
  const stageIdA = initA.stage.id;
  const tokenA2 = newLeaseToken();
  await repo.claimAggregator({ researchId: resA, stage: "expansion", generation: 1, owner: "a",
    token: tokenA2 }, NOW);
  const renew = await repo.heartbeatAggregator({ researchId: resA, stage: "expansion", generation: 1,
    token: tokenA2 }, new Date(NOW.getTime() + 40_000));
  assert.equal(renew.outcome, "claimed");
  assert.equal(renew.leaseExpiresAt.getTime(), NOW.getTime() + 160_000,
    "aggregation heartbeat renews expiry to exactly T0+160,000ms");

  const tokenB = newLeaseToken();
  assert.equal((await repo.claimAggregator({ researchId: resA, stage: "expansion", generation: 1,
    owner: "b", token: tokenB }, new Date(NOW.getTime() + 160_000))).outcome, "claimed",
  "aggregator B reclaims at exact renewed expiry T0+160,000ms");

  const beforeA = {
    research: await db.keywordResearch.findUnique({ where: { id: resA } }),
    stage: await db.keywordResearchStage.findUnique({ where: { id: stageIdA } })
  };
  const hbA = await repo.heartbeatAggregator({ researchId: resA, stage: "expansion", generation: 1,
    token: tokenA2 }, new Date(NOW.getTime() + 160_000));
  assert.equal(hbA.outcome, "lost", "stale A aggregation heartbeat returns lost after B reclaim");
  assert.deepEqual(await db.keywordResearchStage.findUnique({ where: { id: stageIdA } }), beforeA.stage,
    "stage row unchanged after stale A aggregation heartbeat");
  assert.deepEqual(await db.keywordResearch.findUnique({ where: { id: resA } }), beforeA.research,
    "research row unchanged after stale A aggregation heartbeat");

  await db.$disconnect();
});

const W6_SCALE_PROFILE = { maxWait: 5_000, timeout: 30_000 };
const W6_SHORT_PROFILE = { maxWait: 5_000, timeout: 15_000 };
const W6_COUNTED_MODELS = new Set(["keywordResearch", "keywordResearchStage", "keywordResearchTask",
  "keywordResearchCache", "keywordResearchProviderAttempt", "keywordResearchHandoff", "run", "runQuery"]);
const W6_DELEGATE_OPERATIONS = new Set(["findUnique", "findFirst", "findMany", "create", "createMany",
  "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "delete", "deleteMany",
  "count", "aggregate", "groupBy", "upsert"]);

function createOperationCounter(db) {
  const state = { delegateOps: 0, rawStatements: 0, opLog: [], transactionOptions: [] };
  const sqlTextOf = (argument) => {
    if (typeof argument === "string") return argument;
    if (Array.isArray(argument?.strings)) return argument.strings.join(" ");
    return String(argument?.sql ?? "");
  };
  const wrapDelegate = (delegate, modelName) => new Proxy(delegate, {
    get(target, prop) {
      if (prop === "then") return undefined;
      const value = target[prop];
      if (typeof value !== "function") return value;
      if (W6_DELEGATE_OPERATIONS.has(prop)) {
        return (...args) => {
          state.delegateOps += 1;
          state.opLog.push(`${modelName}.${prop}`);
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    }
  });
  const wrapOperations = (target) => new Proxy(target, {
    get(t, prop) {
      if (prop === "then") return undefined;
      if (prop === "$transaction") {
        const real = t.$transaction.bind(t);
        return (work, options) => {
          state.transactionOptions.push(options === undefined ? null : structuredClone(options));
          return real((tx) => work(wrapOperations(tx)), options);
        };
      }
      if (prop === "$queryRaw" || prop === "$queryRawUnsafe" ||
          prop === "$executeRaw" || prop === "$executeRawUnsafe") {
        const real = t[prop].bind(t);
        return (...args) => {
          if (!sqlTextOf(args[0]).includes("set_config")) state.rawStatements += 1;
          return real(...args);
        };
      }
      const value = t[prop];
      if (W6_COUNTED_MODELS.has(prop) && value && typeof value === "object") {
        return wrapDelegate(value, String(prop));
      }
      return typeof value === "function" ? value.bind(t) : value;
    }
  });
  return {
    client: wrapOperations(db),
    reset() {
      state.delegateOps = 0;
      state.rawStatements = 0;
      state.opLog.length = 0;
      state.transactionOptions.length = 0;
    },
    snapshot() {
      return {
        delegateOps: state.delegateOps,
        rawStatements: state.rawStatements,
        opLog: [...state.opLog],
        transactionOptions: state.transactionOptions.map((options) => structuredClone(options))
      };
    }
  };
}

function clientWithOneExtraDelegateRead(client, modelName) {
  const wrap = (target) => new Proxy(target, {
    get(t, prop) {
      if (prop === "then") return undefined;
      const value = t[prop];
      if (prop === "$transaction" && typeof value === "function") {
        return (work, options) => value.call(t, (tx) => work(wrap(tx)), options);
      }
      if (prop === modelName && value && typeof value === "object") {
        return new Proxy(value, {
          get(delegate, delegateProp) {
            if (delegateProp === "then") return undefined;
            const fn = delegate[delegateProp];
            if (delegateProp === "findUnique" && typeof fn === "function") {
              return (...args) => Promise.resolve(fn.apply(delegate, args))
                .then(() => fn.apply(delegate, args));
            }
            return typeof fn === "function" ? fn.bind(delegate) : fn;
          }
        });
      }
      return typeof value === "function" ? value.bind(t) : value;
    }
  });
  return wrap(client);
}

test("SCN-KI-043: set-based transaction ceilings and bounded recovery", { skip: !enabled }, async (t) => {
  const requiredCases = ["W6-DB-03", "W6-DB-04", "W6-DB-05", "W6-DB-06", "W6-DB-07"];
  const controlCases = ["W6-NC-16"];
  const unsignedSort = (left, right) => Buffer.from(left).compare(Buffer.from(right));
  const sortedLfDigest = (members) => createHash("sha256").update(
    [...members].sort(unsignedSort).join("\n") + "\n"
  ).digest("hex");
  assert.equal(new Set(requiredCases).size, requiredCases.length);
  assert.equal(new Set(controlCases).size, controlCases.length);
  assert.equal(sortedLfDigest(requiredCases), "5e80c31a18622c0466176aa8668ff82e00ef6e90a15484eb1fc2710f0ce14261");

  const registered = [];
  const registeredControls = [];
  const executed = [];
  const executedControls = [];

  const { schema, db, repo } = await setupRepo(t, "kiw6_c115");
  const [schemaWitness] = await db.$queryRawUnsafe("SELECT current_schema()::text AS current");
  assert.equal(schemaWitness.current, schema, "SCN-KI-043 writes only inside its disposable schema");
  assert.notEqual(schemaWitness.current, "public", "SCN-KI-043 never targets public");
  const counter = createOperationCounter(db);
  const measuredRepo = new PrismaKeywordResearchRepository(counter.client);

  const assertScaleTransactions = (label) => {
    const { transactionOptions } = counter.snapshot();
    assert.ok(transactionOptions.length >= 1, `${label} recorded its transactions`);
    for (const options of transactionOptions) assert.deepEqual(options, W6_SCALE_PROFILE, `${label} scale profile`);
  };
  const assertDelegateLog = (expectedLog, label) => {
    assert.deepEqual(counter.snapshot().opLog, expectedLog, `${label} delegate operations`);
  };
  const assertDelegateCeiling = (ceiling, label) => {
    assert.ok(counter.snapshot().delegateOps <= ceiling, `${label} at most ${ceiling} delegate operations`);
  };

  await t.test("W6-DB-06 bounded recovery: three reads, deterministic first 100, prefix bound", async () => {
    registered.push("W6-DB-06");
    const base = NOW.getTime();
    const atSecond = (second) => new Date(base + second * 1000);
    const initId = (index) => `kr_w6db06init${String(index).padStart(14, "0")}`;
    const taskResearchId = (index) => `kr_w6db06task${String(index).padStart(14, "0")}`;
    const stageResearchId = (index) => `kr_w6db06stg${String(index).padStart(15, "0")}`;
    const researchRows = [];
    for (let index = 0; index < 40; index += 1) {
      researchRows.push({ id: initId(index), ownerId: "owner_kiw1", state: "queued", generation: 1,
        contractVersion: 1, configSnapshot: {}, configFingerprint: fp(`w6db06-init-${index}`),
        seeds: ["w6db06 seed"], markets: NINE_MARKETS, progress: {}, selectionRevision: 0,
        createdAt: atSecond(81 + index), updatedAt: atSecond(81 + index) });
    }
    for (let index = 0; index < 40; index += 1) {
      researchRows.push({ id: taskResearchId(index), ownerId: "owner_kiw1", state: "running",
        generation: 1, contractVersion: 1, configSnapshot: {}, configFingerprint: fp(`w6db06-task-${index}`),
        seeds: ["w6db06 seed"], markets: NINE_MARKETS, progress: {}, selectionRevision: 0,
        createdAt: NOW, updatedAt: NOW });
    }
    for (let index = 0; index < 40; index += 1) {
      researchRows.push({ id: stageResearchId(index), ownerId: "owner_kiw1", state: "running",
        generation: 1, contractVersion: 1, configSnapshot: {}, configFingerprint: fp(`w6db06-stage-${index}`),
        seeds: ["w6db06 seed"], markets: NINE_MARKETS, progress: {}, selectionRevision: 0,
        createdAt: NOW, updatedAt: NOW });
    }
    const stageRows = [];
    const taskRows = [];
    const taskPlan = [];
    for (let source = 0; source < 40; source += 1) {
      const stageId = keywordStageId(taskResearchId(source), "expansion", 1);
      taskPlan.push({ source, stageId, taskId: keywordTaskId(stageId, "0:suggestions") });
    }
    taskPlan.sort((left, right) => unsignedSort(left.taskId, right.taskId));
    const expectedTaskIds = [];
    taskPlan.forEach((plan, taskRank) => {
      expectedTaskIds.push(plan.taskId);
      stageRows.push({ id: plan.stageId, researchId: taskResearchId(plan.source), stage: "expansion",
        generation: 1, expectedCount: 1, state: "collecting", createdAt: NOW, updatedAt: NOW });
      taskRows.push({ id: plan.taskId, stageId: plan.stageId, itemKey: "0:suggestions",
        inputFingerprint: fp(`w6db06-task-input-${plan.source}`), endpointKey: "keyword_suggestions",
        requestFingerprint: fp(`w6db06-task-request-${plan.source}`), nextAttemptAt: atSecond(1 + taskRank),
        state: "pending", attemptCount: 0, dispatchCount: 0, createdAt: NOW, updatedAt: NOW });
    });
    const readyPlan = [];
    for (let source = 0; source < 20; source += 1) {
      readyPlan.push({ source, stageId: keywordStageId(stageResearchId(source), "anchor_screen", 1) });
    }
    readyPlan.sort((left, right) => unsignedSort(left.stageId, right.stageId));
    const expectedReadyStageIds = [];
    readyPlan.forEach((plan, readyRank) => {
      expectedReadyStageIds.push(plan.stageId);
      stageRows.push({ id: plan.stageId, researchId: stageResearchId(plan.source), stage: "anchor_screen",
        generation: 1, expectedCount: 0, state: "ready", createdAt: NOW, updatedAt: atSecond(41 + readyRank) });
    });
    const expiredPlan = [];
    for (let source = 20; source < 40; source += 1) {
      expiredPlan.push({ source, stageId: keywordStageId(stageResearchId(source), "market_overview", 1) });
    }
    expiredPlan.sort((left, right) => unsignedSort(left.stageId, right.stageId));
    const expectedExpiredStageIds = [];
    expiredPlan.forEach((plan, expiredRank) => {
      expectedExpiredStageIds.push(plan.stageId);
      stageRows.push({ id: plan.stageId, researchId: stageResearchId(plan.source), stage: "market_overview",
        generation: 1, expectedCount: 0, state: "aggregating",
        aggregationLeaseExpiresAt: atSecond(61 + expiredRank), createdAt: NOW, updatedAt: NOW });
    });
    await db.keywordResearch.createMany({ data: researchRows });
    await db.keywordResearchStage.createMany({ data: stageRows });
    await db.keywordResearchTask.createMany({ data: taskRows });
    const recoverNow = atSecond(200);

    counter.reset();
    const recovered = await measuredRepo.recover(recoverNow, { limit: 100 });
    assert.equal(recovered.outcome, "found");
    assert.equal(counter.snapshot().delegateOps, 3, "W6-DB-06 exactly three bounded delegate reads");
    assertDelegateLog(["keywordResearch.findMany", "keywordResearchTask.findMany",
      "keywordResearchStage.findMany"], "W6-DB-06 recovery reads");
    assertScaleTransactions("W6-DB-06 recovery");
    assert.equal(recovered.taskDispatches.length, 40);
    assert.equal(recovered.aggregateChecks.length, 40);
    assert.equal(recovered.initializations.length, 20);
    assert.equal(recovered.taskDispatches.length + recovered.aggregateChecks.length +
      recovered.initializations.length, 100, "W6-DB-06 returns exactly the bounded first 100 members");
    assert.deepEqual(recovered.taskDispatches.map(({ taskId }) => taskId), expectedTaskIds,
      "W6-DB-06 task members follow ascending eligibility order");
    assert.deepEqual(recovered.aggregateChecks.map(({ stageId }) => stageId),
      [...expectedReadyStageIds, ...expectedExpiredStageIds],
      "W6-DB-06 stage members order ready then expired-aggregation by eligibility");
    assert.deepEqual(recovered.initializations.map(({ researchId }) => researchId),
      Array.from({ length: 20 }, (_, index) => initId(index)),
      "W6-DB-06 returns only the first twenty eligible initializations");
    assert.ok(!recovered.initializations.some(({ researchId }) => researchId === initId(20)),
      "W6-DB-06 never returns the 101st member");

    counter.reset();
    const prefix = await measuredRepo.recover(recoverNow, { limit: 7 });
    assert.equal(prefix.outcome, "found");
    assert.equal(counter.snapshot().delegateOps, 3, "W6-DB-06 prefix recovery also uses three reads");
    assertDelegateLog(["keywordResearch.findMany", "keywordResearchTask.findMany",
      "keywordResearchStage.findMany"], "W6-DB-06 prefix recovery reads");
    assertScaleTransactions("W6-DB-06 prefix recovery");
    assert.deepEqual(prefix.taskDispatches.map(({ taskId }) => taskId), expectedTaskIds.slice(0, 7),
      "W6-DB-06 smaller limit returns the exact merged-order prefix");
    assert.equal(prefix.aggregateChecks.length, 0);
    assert.equal(prefix.initializations.length, 0);
    executed.push("W6-DB-06");
  });

  await t.test("W6-DB-03 provider ledger: fenced attempts, settlement ceilings, rollback", async () => {
    registered.push("W6-DB-03");
    const researchId = newResearchId();
    await freshResearch(repo, researchId, "owner_kiw1", 2);
    const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
      tasks: expansionTasksFor(2) }, NOW);
    const stageId = initialized.stage.id;
    const taskA = keywordTaskId(stageId, "0:suggestions");
    const taskB = keywordTaskId(stageId, "0:related");
    const taskC = keywordTaskId(stageId, "1:suggestions");
    const taskD = keywordTaskId(stageId, "1:related");
    const rowA = await db.keywordResearchTask.findUnique({ where: { id: taskA } });
    const rowB = await db.keywordResearchTask.findUnique({ where: { id: taskB } });
    const rowC = await db.keywordResearchTask.findUnique({ where: { id: taskC } });
    const rowD = await db.keywordResearchTask.findUnique({ where: { id: taskD } });
    const cacheEntryFor = (row, normalized) => ({ cacheKey: `kw:w6db03:${row.requestFingerprint.slice(0, 12)}`,
      endpointKey: row.endpointKey, contractVersion: 1, normalizedResponse: normalized,
      resultFingerprint: fp(`w6db03-result-${row.requestFingerprint}`), ttlSeconds: 604800 });
    const tokenA = newLeaseToken();
    await repo.claim({ taskId: taskA, owner: "w", token: tokenA }, NOW);

    counter.reset();
    assert.equal((await measuredRepo.recordAttempt({ taskId: taskA, token: newLeaseToken(),
      requestFingerprint: rowA.requestFingerprint, reservationCostUsd: "0.01560000",
      maxCostPerResearchUsd: "3.00000000" }, NOW)).outcome, "lost");
    assertDelegateCeiling(4, "W6-DB-03 recordAttempt fence loss");
    assertDelegateLog(["keywordResearchTask.findUnique"], "W6-DB-03 recordAttempt fence loss");
    assertScaleTransactions("W6-DB-03 recordAttempt fence loss");
    assert.equal(await db.keywordResearchProviderAttempt.count({ where: { taskId: taskA } }), 0,
      "W6-DB-03 fence loss creates no attempt row");

    counter.reset();
    const created = await measuredRepo.recordAttempt({ taskId: taskA, token: tokenA,
      requestFingerprint: rowA.requestFingerprint, reservationCostUsd: "0.01560000",
      maxCostPerResearchUsd: "3.00000000" }, NOW);
    assert.equal(created.outcome, "created");
    assert.equal(created.mayCall, true);
    assert.equal(created.attempt.attemptNumber, 1);
    assertDelegateCeiling(4, "W6-DB-03 recordAttempt created");
    assertDelegateLog(["keywordResearchTask.findUnique", "keywordResearchProviderAttempt.create",
      "keywordResearchTask.update"], "W6-DB-03 recordAttempt created");
    assert.equal(counter.snapshot().rawStatements, 1,
      "W6-DB-03 recordAttempt exposure aggregate is one statement");
    assertScaleTransactions("W6-DB-03 recordAttempt created");

    counter.reset();
    const settled = await measuredRepo.settleAttempt({ taskId: taskA, token: tokenA, attemptNumber: 1,
      state: "succeeded", providerCostUsd: "0.01200000",
      resultFingerprint: fp(`w6db03-result-${rowA.requestFingerprint}`),
      cacheEntry: cacheEntryFor(rowA, { keywords: ["w6db03-alpha"] }) }, NOW);
    assert.equal(settled.outcome, "terminal");
    assert.equal(settled.fenceActive, true);
    assertDelegateCeiling(4, "W6-DB-03 settleAttempt success");
    assertDelegateLog(["keywordResearchProviderAttempt.findUnique",
      "keywordResearchProviderAttempt.updateManyAndReturn", "keywordResearchCache.findUnique",
      "keywordResearchCache.create"], "W6-DB-03 settleAttempt success");
    assertScaleTransactions("W6-DB-03 settleAttempt success");
    const attemptRowA = await db.keywordResearchProviderAttempt.findUnique({
      where: { taskId_attemptNumber: { taskId: taskA, attemptNumber: 1 } } });
    assert.equal(attemptRowA.state, "succeeded");
    assert.equal(Number(attemptRowA.providerCostUsd).toFixed(8), "0.01200000");
    const cacheRowA = await db.keywordResearchCache.findUnique({
      where: { requestFingerprint: rowA.requestFingerprint } });
    assert.ok(cacheRowA, "W6-DB-03 success settlement persists the cache row");
    assert.equal(cacheRowA.contractVersion, 1);
    assert.equal(cacheRowA.expiresAt.getTime(), NOW.getTime() + 604800 * 1000);

    counter.reset();
    assert.equal((await measuredRepo.settleAttempt({ taskId: taskA, token: tokenA, attemptNumber: 1,
      state: "succeeded", providerCostUsd: "0.01200000",
      resultFingerprint: fp(`w6db03-result-${rowA.requestFingerprint}`),
      cacheEntry: cacheEntryFor(rowA, { keywords: ["w6db03-alpha"] }) }, NOW)).outcome, "found");
    assertDelegateCeiling(4, "W6-DB-03 settleAttempt exact replay");
    assertDelegateLog(["keywordResearchProviderAttempt.findUnique", "keywordResearchCache.findUnique"],
      "W6-DB-03 settleAttempt exact replay");
    assertScaleTransactions("W6-DB-03 settleAttempt exact replay");
    assert.equal(await db.keywordResearchProviderAttempt.count({ where: { taskId: taskA } }), 1,
      "W6-DB-03 exact replay creates no second attempt row");

    const tokenB = newLeaseToken();
    await repo.claim({ taskId: taskB, owner: "w", token: tokenB }, NOW);
    await repo.recordAttempt({ taskId: taskB, token: tokenB, requestFingerprint: rowB.requestFingerprint,
      reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW);
    counter.reset();
    const failed = await measuredRepo.settleAttempt({ taskId: taskB, token: tokenB, attemptNumber: 1,
      state: "failed", providerCostUsd: "0.01200000", safeErrorCode: "KEYWORD_PROVIDER_TASK_FAILED",
      cacheEntry: null }, NOW);
    assert.equal(failed.outcome, "terminal");
    assert.equal(failed.fenceActive, true);
    assertDelegateCeiling(4, "W6-DB-03 settleAttempt failure");
    assertDelegateLog(["keywordResearchProviderAttempt.findUnique",
      "keywordResearchProviderAttempt.updateManyAndReturn"], "W6-DB-03 settleAttempt failure");
    assertScaleTransactions("W6-DB-03 settleAttempt failure");
    const attemptRowB = await db.keywordResearchProviderAttempt.findUnique({
      where: { taskId_attemptNumber: { taskId: taskB, attemptNumber: 1 } } });
    assert.equal(attemptRowB.state, "failed");
    assert.equal(attemptRowB.safeErrorCode, "KEYWORD_PROVIDER_TASK_FAILED");
    assert.equal(attemptRowB.ambiguousAfter, null);
    assert.equal(await db.keywordResearchCache.count({ where: { requestFingerprint: rowB.requestFingerprint } }),
      0, "W6-DB-03 failure settlement writes no cache row");

    const tokenC = newLeaseToken();
    await repo.claim({ taskId: taskC, owner: "w", token: tokenC }, NOW);
    await repo.recordAttempt({ taskId: taskC, token: tokenC, requestFingerprint: rowC.requestFingerprint,
      reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW);
    counter.reset();
    const lostSettle = await measuredRepo.settleAttempt({ taskId: taskC, token: newLeaseToken(),
      attemptNumber: 1, state: "succeeded", providerCostUsd: "0.01200000",
      resultFingerprint: fp(`w6db03-result-${rowC.requestFingerprint}`),
      cacheEntry: cacheEntryFor(rowC, { keywords: ["w6db03-gamma"] }) }, NOW);
    assert.equal(lostSettle.outcome, "lost");
    assert.equal(lostSettle.fenceActive, false);
    assertDelegateCeiling(4, "W6-DB-03 settleAttempt fence loss");
    assertDelegateLog(["keywordResearchProviderAttempt.findUnique",
      "keywordResearchProviderAttempt.updateManyAndReturn", "keywordResearchCache.findUnique",
      "keywordResearchCache.create"], "W6-DB-03 settleAttempt fence loss");
    assertScaleTransactions("W6-DB-03 settleAttempt fence loss");
    const attemptRowC = await db.keywordResearchProviderAttempt.findUnique({
      where: { taskId_attemptNumber: { taskId: taskC, attemptNumber: 1 } } });
    assert.equal(attemptRowC.state, "succeeded",
      "W6-DB-03 fence loss still settles attempt cost atomically");
    assert.equal(Number(attemptRowC.providerCostUsd).toFixed(8), "0.01200000");
    assert.ok(await db.keywordResearchCache.findUnique({
      where: { requestFingerprint: rowC.requestFingerprint } }),
      "W6-DB-03 fence loss still persists the normalized cache row");

    const tokenD = newLeaseToken();
    await repo.claim({ taskId: taskD, owner: "w", token: tokenD }, NOW);
    await repo.recordAttempt({ taskId: taskD, token: tokenD, requestFingerprint: rowD.requestFingerprint,
      reservationCostUsd: "0.01560000", maxCostPerResearchUsd: "3.00000000" }, NOW);
    const beforeRollback = {
      attempt: await db.keywordResearchProviderAttempt.findUnique({
        where: { taskId_attemptNumber: { taskId: taskD, attemptNumber: 1 } } }),
      task: await db.keywordResearchTask.findUnique({ where: { id: taskD } })
    };
    const originalTransaction = db.$transaction;
    const rollbackRepo = new PrismaKeywordResearchRepository(clientWithInjectedFailure(db, (path, args) =>
      path === "keywordResearchCache.create" && args[0]?.data?.requestFingerprint === rowD.requestFingerprint));
    try {
      await assert.rejects(() => rollbackRepo.settleAttempt({ taskId: taskD, token: tokenD, attemptNumber: 1,
        state: "succeeded", providerCostUsd: "0.01200000",
        resultFingerprint: fp(`w6db03-result-${rowD.requestFingerprint}`),
        cacheEntry: cacheEntryFor(rowD, { keywords: ["w6db03-delta"] }) }, NOW),
      /injected:keywordResearchCache.create/);
    } finally {
      db.$transaction = originalTransaction;
    }
    assert.deepEqual(await db.keywordResearchProviderAttempt.findUnique({
      where: { taskId_attemptNumber: { taskId: taskD, attemptNumber: 1 } } }), beforeRollback.attempt,
      "W6-DB-03 rolled-back settlement leaves the attempt row unchanged");
    assert.deepEqual(await db.keywordResearchTask.findUnique({ where: { id: taskD } }), beforeRollback.task,
      "W6-DB-03 rolled-back settlement leaves the task row unchanged");
    assert.equal(await db.keywordResearchCache.count({ where: { requestFingerprint: rowD.requestFingerprint } }),
      0, "W6-DB-03 rolled-back settlement leaves no cache row");
    executed.push("W6-DB-03");
  });

  await t.test("W6-DB-04 terminal/publication fencing, once-only counters, ready transition, ceilings", async () => {
    registered.push("W6-DB-04");
    const researchT = newResearchId();
    await freshResearch(repo, researchT);
    const initT = await repo.initialize({ researchId: researchT, generation: 1, stage: "expansion",
      tasks: expansionTasksFor(1) }, NOW);
    const stageT = initT.stage.id;
    const taskOne = keywordTaskId(stageT, "0:suggestions");
    const taskTwo = keywordTaskId(stageT, "0:related");
    const tokenOne = newLeaseToken();
    await repo.claim({ taskId: taskOne, owner: "w", token: tokenOne }, NOW);
    const beforeStale = {
      task: await db.keywordResearchTask.findUnique({ where: { id: taskOne } }),
      stage: await db.keywordResearchStage.findUnique({ where: { id: stageT } })
    };
    counter.reset();
    assert.equal((await measuredRepo.terminalize({ taskId: taskOne, token: newLeaseToken(),
      state: "succeeded", artifactS3Key: "runs/w6db04-t.json", artifactFingerprint: fp("w6db04-t") },
      NOW)).outcome, "lost");
    assertDelegateCeiling(4, "W6-DB-04 stale terminalize");
    assertDelegateLog(["keywordResearchTask.findUnique"], "W6-DB-04 stale terminalize");
    assertScaleTransactions("W6-DB-04 stale terminalize");
    assert.deepEqual(await db.keywordResearchTask.findUnique({ where: { id: taskOne } }), beforeStale.task,
      "W6-DB-04 stale terminalize leaves the task row unchanged");
    assert.deepEqual(await db.keywordResearchStage.findUnique({ where: { id: stageT } }), beforeStale.stage,
      "W6-DB-04 stale terminalize increments no counter and writes no terminal state");

    counter.reset();
    assert.equal((await measuredRepo.terminalize({ taskId: taskOne, token: tokenOne, state: "succeeded",
      artifactS3Key: "runs/w6db04-t.json", artifactFingerprint: fp("w6db04-t") }, NOW)).outcome, "terminal");
    assertDelegateCeiling(4, "W6-DB-04 terminalize mutation");
    assertDelegateLog(["keywordResearchTask.findUnique", "keywordResearchTask.updateManyAndReturn",
      "keywordResearchStage.update", "keywordResearchStage.updateMany"], "W6-DB-04 terminalize mutation");
    assertScaleTransactions("W6-DB-04 terminalize mutation");
    const stageOneTerminal = await db.keywordResearchStage.findUnique({ where: { id: stageT } });
    assert.equal(stageOneTerminal.succeededCount, 1);
    assert.equal(stageOneTerminal.terminalCount, 1);
    assert.equal(stageOneTerminal.state, "collecting",
      "W6-DB-04 ready transition waits for full terminality");

    counter.reset();
    assert.equal((await measuredRepo.terminalize({ taskId: taskOne, token: tokenOne, state: "succeeded",
      artifactS3Key: "runs/w6db04-t.json", artifactFingerprint: fp("w6db04-t") }, NOW)).outcome, "found");
    assertDelegateCeiling(4, "W6-DB-04 terminalize replay");
    assertDelegateLog(["keywordResearchTask.findUnique"], "W6-DB-04 terminalize replay");
    assertScaleTransactions("W6-DB-04 terminalize replay");
    const stageAfterReplay = await db.keywordResearchStage.findUnique({ where: { id: stageT } });
    assert.equal(stageAfterReplay.succeededCount, 1, "W6-DB-04 counters stay once-only on replay");
    assert.equal(stageAfterReplay.terminalCount, 1, "W6-DB-04 terminal counter stays once-only on replay");

    const tokenTwo = newLeaseToken();
    await repo.claim({ taskId: taskTwo, owner: "w", token: tokenTwo }, NOW);
    counter.reset();
    assert.equal((await measuredRepo.terminalize({ taskId: taskTwo, token: tokenTwo, state: "succeeded",
      artifactS3Key: "runs/w6db04-t2.json", artifactFingerprint: fp("w6db04-t2") }, NOW)).outcome, "terminal");
    assertDelegateCeiling(4, "W6-DB-04 terminalize completes the stage");
    assertDelegateLog(["keywordResearchTask.findUnique", "keywordResearchTask.updateManyAndReturn",
      "keywordResearchStage.update", "keywordResearchStage.updateMany"],
      "W6-DB-04 terminalize completes the stage");
    assertScaleTransactions("W6-DB-04 terminalize completes the stage");
    const stageComplete = await db.keywordResearchStage.findUnique({ where: { id: stageT } });
    assert.equal(stageComplete.state, "ready", "W6-DB-04 conditional ready transition at full terminality");
    assert.equal(stageComplete.terminalCount, 2);

    const anchorTask = { itemKey: "US:0", inputFingerprint: fp("w6db04-anchor-input"),
      endpointKey: "keyword_overview", requestFingerprint: fp("w6db04-anchor-request") };
    const anchorTaskSet = (list) => list.map((task) => ({ itemKey: task.itemKey,
      inputFingerprint: task.inputFingerprint, endpointKey: task.endpointKey,
      requestFingerprint: task.requestFingerprint }));
    const researchCandidate = newResearchId();
    await freshResearch(repo, researchCandidate);
    const { token: candidateToken, stageId: candidateStageId } =
      await setupExpansionAggregator(db, repo, researchCandidate);
    const candidateOptions = { researchId: researchCandidate, stageIds: [candidateStageId],
      nextStageId: keywordStageId(researchCandidate, "anchor_screen", 1) };
    const beforeCandidate = await snapshotResearchRows(db, candidateOptions);
    counter.reset();
    assert.equal((await measuredRepo.publishCandidateManifest({ researchId: researchCandidate,
      generation: 1, token: newLeaseToken(), manifestS3Key: "runs/w6db04-candidate.json",
      manifestFingerprint: fp("w6db04-candidate"), nextStageTasks: [anchorTask] }, NOW)).outcome, "lost");
    assertDelegateCeiling(4, "W6-DB-04 stale candidate publication");
    assertDelegateLog(["keywordResearchStage.findUnique"], "W6-DB-04 stale candidate publication");
    assertScaleTransactions("W6-DB-04 stale candidate publication");
    await assertSnapshotUnchanged(db, { ...candidateOptions, before: beforeCandidate },
      "W6-DB-04 stale candidate publication has zero visibility");

    counter.reset();
    const published = await measuredRepo.publishCandidateManifest({ researchId: researchCandidate,
      generation: 1, token: candidateToken, manifestS3Key: "runs/w6db04-candidate.json",
      manifestFingerprint: fp("w6db04-candidate"), nextStageTasks: [anchorTask] }, NOW);
    assert.equal(published.outcome, "terminal");
    assertDelegateCeiling(4, "W6-DB-04 candidate publication mutation");
    assertDelegateLog(["keywordResearchStage.findUnique", "keywordResearchStage.updateManyAndReturn",
      "keywordResearchStage.create", "keywordResearchTask.createManyAndReturn"],
      "W6-DB-04 candidate publication mutation");
    assertScaleTransactions("W6-DB-04 candidate publication mutation");
    assert.equal(published.stage.state, "completed");
    assert.equal(published.stage.manifestS3Key, "runs/w6db04-candidate.json");
    assert.equal(published.nextStage.stage, "anchor_screen");

    counter.reset();
    const candidateReplay = await measuredRepo.publishCandidateManifest({ researchId: researchCandidate,
      generation: 1, token: candidateToken, manifestS3Key: "runs/w6db04-candidate.json",
      manifestFingerprint: fp("w6db04-candidate"), nextStageTasks: [anchorTask] }, NOW);
    assert.equal(candidateReplay.outcome, "found");
    assertDelegateCeiling(4, "W6-DB-04 candidate publication replay");
    assertDelegateLog(["keywordResearchStage.findUnique", "keywordResearchStage.findUnique"],
      "W6-DB-04 candidate publication replay");
    assertScaleTransactions("W6-DB-04 candidate publication replay");
    assert.deepEqual(candidateReplay.stage, published.stage, "W6-DB-04 replay stage equality");
    assert.deepEqual(anchorTaskSet(candidateReplay.tasks), anchorTaskSet([anchorTask]),
      "W6-DB-04 replay returns the exact anchor task set");

    const researchShortlist = newResearchId();
    await freshResearch(repo, researchShortlist);
    const { token: shortlistToken, stageId: anchorStageId } =
      await setupAnchorAggregator(db, repo, researchShortlist);
    const shortlistOptions = { researchId: researchShortlist, stageIds: [anchorStageId],
      nextStageId: keywordStageId(researchShortlist, "market_overview", 1) };
    const beforeShortlist = await snapshotResearchRows(db, shortlistOptions);
    const marketTasks = marketTasksFor();
    counter.reset();
    assert.equal((await measuredRepo.publishShortlist({ researchId: researchShortlist, generation: 1,
      token: newLeaseToken(), manifestS3Key: "runs/w6db04-shortlist.json",
      manifestFingerprint: fp("w6db04-shortlist"), marketTasks }, NOW)).outcome, "lost");
    assertDelegateCeiling(4, "W6-DB-04 stale shortlist publication");
    assertDelegateLog(["keywordResearchStage.findUnique"], "W6-DB-04 stale shortlist publication");
    assertScaleTransactions("W6-DB-04 stale shortlist publication");
    await assertSnapshotUnchanged(db, { ...shortlistOptions, before: beforeShortlist },
      "W6-DB-04 stale shortlist publication has zero visibility");

    counter.reset();
    const shortlist = await measuredRepo.publishShortlist({ researchId: researchShortlist, generation: 1,
      token: shortlistToken, manifestS3Key: "runs/w6db04-shortlist.json",
      manifestFingerprint: fp("w6db04-shortlist"), marketTasks }, NOW);
    assert.equal(shortlist.outcome, "terminal");
    assertDelegateCeiling(4, "W6-DB-04 shortlist publication mutation");
    assertDelegateLog(["keywordResearchStage.findUnique", "keywordResearchStage.updateManyAndReturn",
      "keywordResearchStage.create", "keywordResearchTask.createManyAndReturn"],
      "W6-DB-04 shortlist publication mutation");
    assertScaleTransactions("W6-DB-04 shortlist publication mutation");
    assert.equal(shortlist.nextStage.stage, "market_overview");
    assert.equal(shortlist.tasks.length, 8);

    counter.reset();
    const shortlistReplay = await measuredRepo.publishShortlist({ researchId: researchShortlist,
      generation: 1, token: shortlistToken, manifestS3Key: "runs/w6db04-shortlist.json",
      manifestFingerprint: fp("w6db04-shortlist"), marketTasks }, NOW);
    assert.equal(shortlistReplay.outcome, "found");
    assertDelegateCeiling(4, "W6-DB-04 shortlist publication replay");
    assertDelegateLog(["keywordResearchStage.findUnique", "keywordResearchStage.findUnique"],
      "W6-DB-04 shortlist publication replay");
    assertScaleTransactions("W6-DB-04 shortlist publication replay");
    assert.deepEqual(shortlistReplay.stage, shortlist.stage, "W6-DB-04 shortlist replay stage equality");
    assert.deepEqual(anchorTaskSet(shortlistReplay.tasks), anchorTaskSet(marketTasks)
      .sort((left, right) => Buffer.compare(Buffer.from(left.itemKey), Buffer.from(right.itemKey))),
      "W6-DB-04 shortlist replay returns the exact eight-market task set");
    executed.push("W6-DB-04");
  });

  await t.test("W6-DB-05 maximum initialization and maximum saved handoff", async () => {
    registered.push("W6-DB-05");
    const researchInit = newResearchId();
    await freshResearch(repo, researchInit, "owner_kiw1", 5);
    counter.reset();
    const initialized = await measuredRepo.initialize({ researchId: researchInit, generation: 1,
      stage: "expansion", tasks: expansionTasksFor(5) }, NOW);
    assert.equal(initialized.outcome, "created");
    assert.equal(initialized.stage.expectedCount, 10);
    assert.equal(initialized.tasks.length, 10);
    assert.deepEqual(initialized.tasks.map((task) => task.itemKey),
      ["0:related", "0:suggestions", "1:related", "1:suggestions", "2:related", "2:suggestions",
        "3:related", "3:suggestions", "4:related", "4:suggestions"],
      "W6-DB-05 ten itemKey-sorted expansion tasks");
    assert.equal(await db.keywordResearchTask.count({ where: { stageId: initialized.stage.id } }), 10);
    assertDelegateCeiling(5, "W6-DB-05 maximum initialization");
    assertDelegateLog(["keywordResearch.findUnique", "keywordResearchStage.findUnique",
      "keywordResearch.update", "keywordResearchStage.create", "keywordResearchTask.createManyAndReturn"],
      "W6-DB-05 maximum initialization");
    assert.equal(counter.snapshot().opLog[counter.snapshot().opLog.length - 1],
      "keywordResearchTask.createManyAndReturn", "W6-DB-05 no post-create task reload");
    assertScaleTransactions("W6-DB-05 maximum initialization");

    const researchHandoff = newResearchId();
    await freshResearch(repo, researchHandoff);
    const { mktToken } = await advanceToMarketStage(db, repo, researchHandoff);
    const keywords = Array.from({ length: 100 }, (_, index) => makeKeywordRow(`w6db05 handoff keyword ${index}`));
    const result = makeResult(keywords, researchHandoff);
    const selectionItems = defaultSelectionFor(keywords);
    assert.equal(selectionItems.length, 100, "W6-DB-05 maximum saved selection has exactly 100 items");
    assert.equal((await repo.publishResearchResult({ researchId: researchHandoff, generation: 1,
      token: mktToken, manifestS3Key: "runs/w6db05-final.json", manifestFingerprint: fp("w6db05-final"),
      result, resultFingerprint: fp("w6db05-result"), selectionItems }, NOW)).outcome, "terminal");
    const runId = "run_kiw6_c115_handoff_0001";
    const handoffInput = { researchId: researchHandoff, ownerId: "owner_kiw1", expectedSelectionRevision: 1,
      clientRequestId: "client-request-w6db05-0001", selectionFingerprint: fp("w6db05-handoff"),
      runId, items: selectionItems.map((item) => ({ itemId: item.itemId, keyword: item.keyword })) };
    const constructRun = async (tx, { runId: id, research, now, items }) => tx.run.create({ data: {
      id, ownerId: research.ownerId, state: "queued", stage: "keyword_research",
      normalizedShopTypes: [], progress: {}, queryPlanSource: "keyword_research",
      keywordResearchId: research.id, keywordSelectionRevision: 1,
      keywordSelectionSnapshot: { items }, createdAt: now } });
    const constructQueries = async (tx, { run, items, now }) => {
      const rows = await tx.runQuery.createManyAndReturn({ data: items.map((item, index) => ({
        id: `rq_${run.id}_${index}`, runId: run.id, categoryIndex: 0, sequence: index,
        query: item.keyword, source: "generated", keywordResearchItemId: item.itemId,
        createdAt: now, updatedAt: now })) });
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      return items.map((item, index) => rowsById.get(`rq_${run.id}_${index}`));
    };
    counter.reset();
    const createdRun = await measuredRepo.createRun({ ...handoffInput, constructRun, constructQueries }, NOW);
    assert.equal(createdRun.outcome, "created");
    assert.equal(createdRun.run.queryPlanSource, "keyword_research");
    assert.equal(await db.run.count(), 1, "W6-DB-05 exactly one Run");
    assert.equal(await db.runQuery.count({ where: { runId } }), 100, "W6-DB-05 exactly 100 RunQuery rows");
    assert.equal(await db.keywordResearchHandoff.count({ where: { researchId: researchHandoff } }), 1,
      "W6-DB-05 exactly one handoff row");
    assert.deepEqual((await db.runQuery.findMany({ where: { runId }, orderBy: { sequence: "asc" } }))
      .map((row) => row.keywordResearchItemId), selectionItems.map((item) => item.itemId),
      "W6-DB-05 RunQuery lineage preserves selection order");
    assertDelegateCeiling(4, "W6-DB-05 maximum handoff initial transaction");
    assertDelegateLog(["keywordResearch.findUnique", "run.create", "runQuery.createManyAndReturn",
      "keywordResearchHandoff.create"], "W6-DB-05 maximum handoff initial transaction");
    assertScaleTransactions("W6-DB-05 maximum handoff initial transaction");

    counter.reset();
    const replayRun = await measuredRepo.createRun({ ...handoffInput, constructRun, constructQueries }, NOW);
    assert.equal(replayRun.outcome, "found");
    assert.equal(replayRun.run.id, runId, "W6-DB-05 same-key replay returns the same Run");
    assert.equal(await db.run.count(), 1, "W6-DB-05 replay creates zero new Runs");
    assert.equal(await db.runQuery.count({ where: { runId } }), 100,
      "W6-DB-05 replay creates zero new RunQuery rows");
    assert.equal(await db.keywordResearchHandoff.count({ where: { researchId: researchHandoff } }), 1,
      "W6-DB-05 replay creates zero new handoff rows");
    assertDelegateCeiling(4, "W6-DB-05 same-key replay");
    assertDelegateLog(["keywordResearch.findUnique"], "W6-DB-05 same-key replay");
    assertScaleTransactions("W6-DB-05 same-key replay");

    counter.reset();
    assert.equal((await measuredRepo.createRun({ ...handoffInput, constructRun, constructQueries,
      selectionFingerprint: fp("w6db05-unequal") }, NOW)).outcome, "conflict",
      "W6-DB-05 unequal same-key request conflicts");
    assertDelegateCeiling(4, "W6-DB-05 unequal same-key conflict");
    assertDelegateLog(["keywordResearch.findUnique"], "W6-DB-05 unequal same-key conflict");
    assertScaleTransactions("W6-DB-05 unequal same-key conflict");
    executed.push("W6-DB-05");
  });

  await t.test("W6-DB-07 concurrent throttle: one statement, one claimant, shared boundary, due reclaim", async () => {
    registered.push("W6-DB-07");
    const provider = "w6db07_throttle_probe";
    counter.reset();
    const concurrent = await Promise.all(Array.from({ length: 5 }, () =>
      measuredRepo.claimThrottle({ provider })));
    const concurrentSnapshot = counter.snapshot();
    assert.equal(concurrentSnapshot.delegateOps, 0, "W6-DB-07 throttle uses no delegate operations");
    assert.equal(concurrentSnapshot.rawStatements, 5,
      "W6-DB-07 exactly one SQL statement per invocation");
    assert.equal(concurrentSnapshot.transactionOptions.length, 5,
      "W6-DB-07 one transaction per invocation");
    for (const options of concurrentSnapshot.transactionOptions) {
      assert.deepEqual(options, W6_SHORT_PROFILE, "W6-DB-07 short transaction profile");
    }
    assert.equal(concurrent.filter(({ outcome }) => outcome === "claimed").length, 1,
      "W6-DB-07 exactly one claimant");
    const delayed = concurrent.filter(({ outcome }) => outcome === "delayed");
    assert.equal(delayed.length, 4, "W6-DB-07 all competitors delayed");
    const [claimed] = concurrent.filter(({ outcome }) => outcome === "claimed");
    assert.ok(claimed.nextAllowedAt instanceof Date);
    for (const competitor of delayed) {
      assert.ok(competitor.retryAt instanceof Date);
      assert.equal(competitor.retryAt.getTime(), claimed.nextAllowedAt.getTime(),
        "W6-DB-07 every competitor shares the same future boundary timestamp");
    }
    const throttleRow = await db.keywordProviderThrottle.findUnique({ where: { provider } });
    assert.equal(throttleRow.nextAllowedAt.getTime(), claimed.nextAllowedAt.getTime(),
      "W6-DB-07 durable row carries the shared boundary");

    counter.reset();
    assert.equal((await measuredRepo.claimThrottle({ provider })).outcome, "delayed",
      "W6-DB-07 the boundary is still future for the next claimant");
    assert.equal(counter.snapshot().rawStatements, 1, "W6-DB-07 boundary recheck is one statement");
    assert.equal(counter.snapshot().delegateOps, 0);
    assert.deepEqual(counter.snapshot().transactionOptions, [W6_SHORT_PROFILE],
      "W6-DB-07 boundary recheck transaction profile");

    await db.$executeRawUnsafe(
      `UPDATE "KeywordProviderThrottle" SET "nextAllowedAt" = now() - interval '1 second' ` +
      `WHERE "provider" = '${provider}'`);
    counter.reset();
    const dueClaim = await measuredRepo.claimThrottle({ provider });
    assert.equal(dueClaim.outcome, "claimed", "W6-DB-07 an exact-due claimant claims after the gap");
    assert.ok(dueClaim.nextAllowedAt instanceof Date);
    assert.equal(counter.snapshot().rawStatements, 1, "W6-DB-07 due claim is one statement");
    assert.equal(counter.snapshot().delegateOps, 0);
    assert.deepEqual(counter.snapshot().transactionOptions, [W6_SHORT_PROFILE],
      "W6-DB-07 due claim transaction profile");
    executed.push("W6-DB-07");
  });

  await t.test("W6-NC-16 negative control: one reintroduced delegate read falsifies the ceiling", async () => {
    registeredControls.push("W6-NC-16");
    const researchId = newResearchId();
    await freshResearch(repo, researchId);
    const initialized = await repo.initialize({ researchId, generation: 1, stage: "expansion",
      tasks: expansionTasksFor(1) }, NOW);
    const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
    const ceilingWitness = async (repoUnderTest) => {
      counter.reset();
      const context = await repoUnderTest.getTaskContext({ taskId });
      assert.equal(context.outcome, "found");
      assertDelegateCeiling(1, "W6-NC-16 getTaskContext single delegate read");
    };
    const wrappedRepo = new PrismaKeywordResearchRepository(
      clientWithOneExtraDelegateRead(counter.client, "keywordResearchTask"));
    await assert.rejects(() => ceilingWitness(wrappedRepo), assert.AssertionError,
      "W6-NC-16 the extra redundant read must make the unchanged ceiling assertion throw");
    await ceilingWitness(measuredRepo);
    executedControls.push("W6-NC-16");
  });

  assert.equal(registered.length, requiredCases.length, "SCN-KI-043 registered the five required cases");
  assert.equal(new Set(registered).size, registered.length, "SCN-KI-043 zero duplicate registrations");
  assert.deepEqual([...registered].sort(unsignedSort), [...requiredCases].sort(unsignedSort),
    "SCN-KI-043 registered equals required");
  assert.equal(executed.length, requiredCases.length,
    "SCN-KI-043 executed the five required cases with zero skips");
  assert.equal(new Set(executed).size, executed.length, "SCN-KI-043 zero duplicate executions");
  assert.deepEqual([...executed].sort(unsignedSort), [...requiredCases].sort(unsignedSort),
    "SCN-KI-043 executed equals registered equals required");
  assert.equal(sortedLfDigest(executed), "5e80c31a18622c0466176aa8668ff82e00ef6e90a15484eb1fc2710f0ce14261",
    "SCN-KI-043 sorted-LF digest of the executed case set");
  assert.deepEqual([...registeredControls].sort(unsignedSort), [...controlCases].sort(unsignedSort),
    "SCN-KI-043 registered control set equality");
  assert.equal(new Set(registeredControls).size, registeredControls.length,
    "SCN-KI-043 zero duplicate registered controls");
  assert.deepEqual([...executedControls].sort(unsignedSort), [...controlCases].sort(unsignedSort),
    "SCN-KI-043 control set equality");
  assert.equal(new Set(executedControls).size, executedControls.length,
    "SCN-KI-043 zero duplicate controls");
  await db.$disconnect();
});
