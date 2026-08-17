import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPrismaClient } from "../src/prisma-client.js";
import { PrismaKeywordResearchRepository, keywordStageId, keywordTaskId,
  newLeaseToken, newResearchId, selectionItemId } from "../src/keyword-intelligence/repository.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const fp = (value) => createHash("sha256").update(String(value)).digest("hex");

const NINE_MARKETS = ["US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"].map((code) => ({ code }));

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const NOW = new Date("2026-08-17T00:00:00.000Z");
const LATER = new Date(NOW.getTime() + 121_000);

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

async function freshResearch(repo, researchId, ownerId = "owner_kiw1") {
  const created = await repo.create({ researchId, ownerId, configSnapshot: { anchor: "US" },
    configFingerprint: fp("c"), seeds: ["synthetic seed"], markets: NINE_MARKETS }, NOW);
  assert.equal(created.outcome, "created");
  return created;
}

const expansionTasks = (seedCount = 2) => Array.from({ length: seedCount }, (_, index) => ({
  itemKey: `${index}:suggestions`, inputFingerprint: fp(`i${index}`), endpointKey: "keyword_suggestions",
  requestFingerprint: fp(`r${index}`)
}));

async function completeResearchFlow(db, repo, researchId, ownerId) {
  await freshResearch(repo, researchId, ownerId);
  await repo.initialize({ researchId, ownerId, stage: "expansion", generation: 1,
    tasks: expansionTasks(2) }, NOW);
  const stageId = keywordStageId(researchId, "expansion", 1);
  for (const itemKey of ["0:suggestions", "1:suggestions"]) {
    const token = newLeaseToken();
    const taskId = keywordTaskId(stageId, itemKey);
    assert.equal((await repo.claim({ taskId, owner: "worker", token }, NOW)).outcome, "claimed");
    assert.equal((await repo.terminalize({ taskId, token, state: "succeeded",
      artifactS3Key: `runs/keyword-research/${researchId}/generation-1/expansion/${itemKey}.json`,
      artifactFingerprint: fp(itemKey[0]) }, NOW)).outcome, "terminal");
  }
  const aggregatorToken = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1,
    owner: "aggregator", token: aggregatorToken }, NOW);
  await repo.publishCandidateManifest({ researchId, stage: "expansion", generation: 1,
    token: aggregatorToken, manifestS3Key: `runs/keyword-research/${researchId}/generation-1/expansion/manifest.json`,
    manifestFingerprint: fp("m") }, NOW);
  await repo.publishStageCompletion({ researchId, stage: "expansion", generation: 1,
    token: aggregatorToken, nextStageTasks: [{ itemKey: "anchor", inputFingerprint: fp("a"),
      endpointKey: "keyword_overview", requestFingerprint: fp("ra") }] }, NOW);
  const anchorStageId = keywordStageId(researchId, "anchor_screen", 1);
  const anchorTaskId = keywordTaskId(anchorStageId, "anchor");
  const anchorToken = newLeaseToken();
  await repo.claim({ taskId: anchorTaskId, owner: "worker", token: anchorToken }, NOW);
  await repo.terminalize({ taskId: anchorTaskId, token: anchorToken, state: "succeeded",
    artifactS3Key: `runs/keyword-research/${researchId}/generation-1/anchor_screen/anchor.json`,
    artifactFingerprint: fp("x") }, NOW);
  await repo.claimAggregator({ researchId, stage: "anchor_screen", generation: 1,
    owner: "aggregator", token: aggregatorToken }, NOW);
  await repo.publishShortlist({ researchId, generation: 1, token: aggregatorToken,
    manifestS3Key: `runs/keyword-research/${researchId}/generation-1/anchor_screen/manifest.json`,
    manifestFingerprint: fp("s"), marketTasks: [{ itemKey: "US", inputFingerprint: fp("us"),
      endpointKey: "keyword_overview", requestFingerprint: fp("rus") }] }, NOW);
  const marketStageId = keywordStageId(researchId, "market_overview", 1);
  const marketTaskId = keywordTaskId(marketStageId, "US");
  const marketToken = newLeaseToken();
  await repo.claim({ taskId: marketTaskId, owner: "worker", token: marketToken }, NOW);
  await repo.terminalize({ taskId: marketTaskId, token: marketToken, state: "succeeded",
    artifactS3Key: `runs/keyword-research/${researchId}/generation-1/market_overview/US.json`,
    artifactFingerprint: fp("y") }, NOW);
  await repo.claimAggregator({ researchId, stage: "market_overview", generation: 1,
    owner: "aggregator", token: aggregatorToken }, NOW);
  await repo.publishStageCompletion({ researchId, stage: "market_overview", generation: 1,
    token: aggregatorToken }, NOW);
  return aggregatorToken;
}

test("migration catalog, enum values, uniques, defaults, legacy compatibility", { skip: !enabled }, async (t) => {
  const schema = `kiw1_catalog_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  await assertMigrationStayedInSchema(db, schema);
  await catalogAssertion(db, schema);
  const legacy = await db.run.create({ data: { id: "run_legacy_kiw1", state: "queued",
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
  const schema = `kiw1_negctl_${Date.now().toString(36)}`;
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
  const schema = `kiw1_research_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(createPrismaClient(scopedUrl));
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  assert.equal((await repo.create({ researchId, ownerId: "owner_kiw1", configSnapshot: { anchor: "US" },
    configFingerprint: fp("c"), seeds: ["synthetic seed"], markets: NINE_MARKETS }, NOW)).outcome, "found");
  assert.equal((await repo.create({ researchId, ownerId: "other", configSnapshot: { anchor: "US" },
    configFingerprint: fp("c"), seeds: ["synthetic seed"], markets: NINE_MARKETS }, NOW)).outcome, "conflict");
  assert.equal((await repo.getOwned({ researchId, ownerId: "other" })).outcome, "not_found");
  assert.equal((await repo.getOwned({ researchId, ownerId: "owner_kiw1" })).outcome, "found");
});

test("initialize, lease claim/heartbeat/loss/reclaim, terminal counters", { skip: !enabled }, async (t) => {
  const schema = `kiw1_leases_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(db);
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, ownerId: "owner_kiw1", stage: "expansion",
    generation: 1, tasks: expansionTasks(2) }, NOW);
  assert.equal(initialized.outcome, "created");
  assert.equal(initialized.stage.expectedCount, 2);
  assert.equal((await repo.initialize({ researchId, ownerId: "owner_kiw1", stage: "expansion",
    generation: 1, tasks: expansionTasks(2) }, NOW)).outcome, "found");
  const research = await repo.getOwned({ researchId, ownerId: "owner_kiw1" });
  assert.equal(research.research.state, "running");

  const taskId = keywordTaskId(initialized.stage.id, "0:suggestions");
  const claimToken = newLeaseToken();
  const delayed = await repo.claim({ taskId, owner: "w", token: claimToken }, NOW);
  assert.equal(delayed.outcome, "claimed");
  const competing = await repo.claim({ taskId, owner: "w2", token: newLeaseToken() }, NOW);
  assert.equal(competing.outcome, "lost");
  const heartbeat = await repo.heartbeat({ taskId, token: claimToken }, new Date(NOW.getTime() + 20_000));
  assert.equal(heartbeat.outcome, "claimed");
  assert.equal((await repo.heartbeat({ taskId, token: newLeaseToken() }, NOW)).outcome, "lost");
  const stolen = await repo.terminalize({ taskId, token: newLeaseToken(), state: "succeeded" }, NOW);
  assert.equal(stolen.outcome, "lost");
  const reclaimToken = newLeaseToken();
  const reclaimed = await repo.claim({ taskId, owner: "w3", token: reclaimToken }, LATER);
  assert.equal(reclaimed.outcome, "claimed");
  assert.equal(reclaimed.task.leaseAttempt, 2);

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
  const taskRow = await db.keywordResearchTask.findUnique({ where: { id: taskId } });
  assert.equal(taskRow.state, "succeeded");
  assert.ok(!Object.hasOwn(taskRow, "ownerId"));
  await db.$disconnect();
});

test("delayed claim honors nextAttemptAt", { skip: !enabled }, async (t) => {
  const schema = `kiw1_delay_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(db);
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  await repo.initialize({ researchId, ownerId: "owner_kiw1", stage: "expansion", generation: 1,
    tasks: [{ itemKey: "0:suggestions", inputFingerprint: fp("i"), endpointKey: "keyword_suggestions",
      requestFingerprint: fp("r"), nextAttemptAt: new Date(NOW.getTime() + 5_000) }] }, NOW);
  const stage = await db.keywordResearchStage.findUnique({ where: {
    id: keywordStageId(researchId, "expansion", 1) } });
  const taskId = keywordTaskId(stage.id, "0:suggestions");
  const early = await repo.claim({ taskId, owner: "w", token: newLeaseToken() }, NOW);
  assert.equal(early.outcome, "delayed");
  assert.equal(early.retryAt.getTime(), NOW.getTime() + 5_000);
  assert.equal((await repo.claim({ taskId, owner: "w", token: newLeaseToken() },
    new Date(NOW.getTime() + 6_000))).outcome, "claimed");
  await db.$disconnect();
});

test("attempt reservation, budget denial, settlement, ambiguity, privacy", { skip: !enabled }, async (t) => {
  const schema = `kiw1_budget_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(db);
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  await repo.initialize({ researchId, ownerId: "owner_kiw1", stage: "expansion", generation: 1,
    tasks: expansionTasks(2) }, NOW);
  const stage = await db.keywordResearchStage.findUnique({ where: {
    id: keywordStageId(researchId, "expansion", 1) } });
  const taskId = keywordTaskId(stage.id, "0:suggestions");
  const token = newLeaseToken();
  await repo.claim({ taskId, owner: "w", token }, NOW);
  const attempt = await repo.recordAttempt({ taskId, attemptNumber: 1,
    requestFingerprint: fp("r0"), reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "0.02000000" }, NOW);
  assert.equal(attempt.outcome, "created");
  assert.equal((await repo.recordAttempt({ taskId, attemptNumber: 1,
    requestFingerprint: fp("r0"), reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "0.02000000" }, NOW)).outcome, "found");
  assert.equal((await repo.recordAttempt({ taskId, attemptNumber: 1,
    requestFingerprint: fp("zz"), reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "0.02000000" }, NOW)).outcome, "conflict");
  const denied = await repo.recordAttempt({ taskId, attemptNumber: 2,
    requestFingerprint: fp("r1"), reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "0.02000000" }, NOW);
  assert.equal(denied.outcome, "conflict");
  assert.equal(denied.code, "KEYWORD_PROVIDER_BUDGET_EXHAUSTED");
  const secondTaskId = keywordTaskId(stage.id, "1:suggestions");
  const deniedOtherTask = await repo.recordAttempt({ taskId: secondTaskId, attemptNumber: 1,
    requestFingerprint: fp("r1"), reservationCostUsd: "0.01560000",
    maxCostPerResearchUsd: "0.02000000" }, NOW);
  assert.equal(deniedOtherTask.outcome, "conflict");

  const settled = await repo.settleAttempt({ taskId, attemptNumber: 1, state: "succeeded",
    providerCostUsd: "0.01200000", resultFingerprint: fp("n") }, NOW);
  assert.equal(settled.outcome, "terminal");
  assert.equal((await repo.settleAttempt({ taskId, attemptNumber: 1, state: "succeeded",
    providerCostUsd: "0.01200000", resultFingerprint: fp("n") }, NOW)).outcome, "found");
  assert.equal((await repo.settleAttempt({ taskId, attemptNumber: 1, state: "failed" }, NOW)).outcome,
    "conflict");
  const afterSettle = await repo.recordAttempt({ taskId: secondTaskId, attemptNumber: 1,
    requestFingerprint: fp("r1"), reservationCostUsd: "0.00790000",
    maxCostPerResearchUsd: "0.02000000" }, NOW);
  assert.equal(afterSettle.outcome, "created");

  const ambiguous = await repo.settleAttempt({ taskId: secondTaskId, attemptNumber: 1,
    state: "ambiguous", safeErrorCode: "KEYWORD_PROVIDER_AMBIGUOUS" }, NOW);
  assert.equal(ambiguous.outcome, "terminal");
  const ambiguousHeld = await repo.recordAttempt({ taskId, attemptNumber: 2,
    requestFingerprint: fp("r2"), reservationCostUsd: "0.00020000",
    maxCostPerResearchUsd: "0.02000000" }, NOW);
  assert.equal(ambiguousHeld.outcome, "conflict");
  assert.equal(ambiguousHeld.code, "KEYWORD_PROVIDER_BUDGET_EXHAUSTED");

  const attemptRow = await db.keywordResearchProviderAttempt.findUnique({ where: {
    taskId_attemptNumber: { taskId, attemptNumber: 1 } } });
  assert.ok(!Object.hasOwn(attemptRow, "ownerId"));
  await db.$disconnect();
});

test("aggregation lease competition and manifest/shortlist/stage completion", { skip: !enabled }, async (t) => {
  const schema = `kiw1_aggr_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(db);
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  await repo.initialize({ researchId, ownerId: "owner_kiw1", stage: "expansion", generation: 1,
    tasks: expansionTasks(2) }, NOW);
  const stageId = keywordStageId(researchId, "expansion", 1);
  const firstToken = newLeaseToken();
  const firstTaskId = keywordTaskId(stageId, "0:suggestions");
  await repo.claim({ taskId: firstTaskId, owner: "w", token: firstToken }, NOW);
  await repo.terminalize({ taskId: firstTaskId, token: firstToken, state: "succeeded",
    artifactS3Key: "runs/x.json", artifactFingerprint: fp("0") }, NOW);
  const tokenA = newLeaseToken();
  assert.equal((await repo.claimAggregator({ researchId, stage: "expansion", generation: 1,
    owner: "a1", token: tokenA }, NOW)).outcome, "claimed");
  assert.equal((await repo.claimAggregator({ researchId, stage: "expansion", generation: 1,
    owner: "a2", token: newLeaseToken() }, NOW)).outcome, "lost");
  const premature = await repo.publishStageCompletion({ researchId, stage: "expansion",
    generation: 1, token: tokenA, nextStageTasks: [{ itemKey: "anchor", inputFingerprint: fp("a"),
      endpointKey: "keyword_overview", requestFingerprint: fp("ra") }] }, NOW);
  assert.equal(premature.outcome, "conflict");
  const secondToken = newLeaseToken();
  const secondTaskId = keywordTaskId(stageId, "1:suggestions");
  await repo.claim({ taskId: secondTaskId, owner: "w", token: secondToken }, NOW);
  await repo.terminalize({ taskId: secondTaskId, token: secondToken, state: "succeeded",
    artifactS3Key: "runs/y.json", artifactFingerprint: fp("1") }, NOW);
  assert.equal((await repo.publishCandidateManifest({ researchId, stage: "expansion", generation: 1,
    token: newLeaseToken(), manifestS3Key: "runs/m.json", manifestFingerprint: fp("m") }, NOW)).outcome,
    "lost");
  const manifest = await repo.publishCandidateManifest({ researchId, stage: "expansion", generation: 1,
    token: tokenA, manifestS3Key: "runs/m.json", manifestFingerprint: fp("m") }, NOW);
  assert.equal(manifest.outcome, "terminal");
  assert.equal(manifest.stage.state, "aggregating");
  assert.equal((await repo.publishCandidateManifest({ researchId, stage: "expansion", generation: 1,
    token: tokenA, manifestS3Key: "runs/m.json", manifestFingerprint: fp("m") }, NOW)).outcome, "found");
  assert.equal((await repo.publishCandidateManifest({ researchId, stage: "expansion", generation: 1,
    token: tokenA, manifestS3Key: "runs/other.json", manifestFingerprint: fp("m") }, NOW)).outcome,
    "conflict");
  const completed = await repo.publishStageCompletion({ researchId, stage: "expansion",
    generation: 1, token: tokenA, nextStageTasks: [{ itemKey: "anchor", inputFingerprint: fp("a"),
      endpointKey: "keyword_overview", requestFingerprint: fp("ra") }] }, NOW);
  assert.equal(completed.outcome, "terminal");
  assert.equal(completed.stage.state, "completed");
  const anchorStage = await db.keywordResearchStage.findUnique({ where: {
    id: keywordStageId(researchId, "anchor_screen", 1) } });
  assert.ok(anchorStage, "anchor stage created");
  assert.equal(anchorStage.expectedCount, 1);
  assert.equal(anchorStage.state, "collecting");
  await db.$disconnect();
});

test("full flow publishes result, selection CAS, run handoff idempotency", { skip: !enabled }, async (t) => {
  const schema = `kiw1_flow_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(db);
  const researchId = newResearchId();
  await completeResearchFlow(db, repo, researchId, "owner_kiw1");

  assert.equal((await repo.saveSelection({ researchId, ownerId: "owner_kiw1", expectedRevision: 0,
    items: [{ itemId: selectionItemId("calculated", "synthetic seed") }] }, NOW)).outcome, "conflict");
  const published = await repo.publishResearchResult({ researchId, result: { summary: {} },
    resultFingerprint: fp("z") }, NOW);
  assert.equal(published.outcome, "terminal");
  assert.equal((await repo.publishResearchResult({ researchId, result: { summary: {} },
    resultFingerprint: fp("z") }, NOW)).outcome, "found");
  assert.equal((await repo.publishResearchResult({ researchId, result: { summary: { other: true } },
    resultFingerprint: fp("y") }, NOW)).outcome, "conflict");
  const completed = await repo.getOwned({ researchId, ownerId: "owner_kiw1" });
  assert.equal(completed.research.state, "completed");
  const selection = await repo.saveSelection({ researchId, ownerId: "owner_kiw1", expectedRevision: 0,
    items: [{ itemId: selectionItemId("calculated", "synthetic seed") }] }, NOW);
  assert.equal(selection.outcome, "created");
  assert.equal(selection.selectionRevision, 1);
  assert.equal((await repo.saveSelection({ researchId, ownerId: "owner_kiw1", expectedRevision: 0,
    items: [] }, NOW)).outcome, "conflict");
  assert.equal((await repo.saveSelection({ researchId, ownerId: "owner_kiw1", expectedRevision: 1,
    items: [] }, NOW)).outcome, "created");

  const handoffInput = { researchId, ownerId: "owner_kiw1", expectedSelectionRevision: 2,
    clientRequestId: "client-request-kw-0001", selectionFingerprint: fp("h"), runId: "run_kiw1_handoff_0001",
    items: [{ itemId: selectionItemId("calculated", "synthetic seed"), keyword: "synthetic seed" }] };
  const constructRun = async (tx, { runId, research, now, items }) => tx.run.create({ data: {
    id: runId, ownerId: research.ownerId, state: "queued", stage: "keyword_research",
    normalizedShopTypes: [], progress: {}, queryPlanSource: "keyword_research",
    keywordResearchId: research.id, keywordSelectionRevision: 2,
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
  assert.equal(retry.run.id, handoffInput.runId);
  const conflict = await repo.createRun({ ...handoffInput, selectionFingerprint: fp("x"),
    constructRun, constructQueries }, NOW);
  assert.equal(conflict.outcome, "conflict");
  const staleRevision = await repo.createRun({ ...handoffInput,
    clientRequestId: "client-request-kw-0002", expectedSelectionRevision: 1,
    constructRun, constructQueries }, NOW);
  assert.equal(staleRevision.outcome, "conflict");
  const runQueries = await db.runQuery.findMany({ where: { runId: handoffInput.runId } });
  assert.equal(runQueries.length, 1);
  assert.equal(runQueries[0].keywordResearchItemId, handoffInput.items[0].itemId);
  const laterSave = await repo.saveSelection({ researchId, ownerId: "owner_kiw1", expectedRevision: 2,
    items: [{ itemId: selectionItemId("calculated", "changed seed") }] }, LATER);
  assert.equal(laterSave.outcome, "created");
  assert.equal(laterSave.selectionRevision, 3);
  const storedRun = await db.run.findUnique({ where: { id: handoffInput.runId } });
  assert.equal(storedRun.keywordSelectionRevision, 2);
  assert.deepEqual(storedRun.keywordSelectionSnapshot.items, handoffInput.items);
  const researchAfter = await repo.getOwned({ researchId, ownerId: "owner_kiw1" });
  assert.equal(researchAfter.research.selectionRevision, 3);
  await db.$disconnect();
});

test("cache fresh/stale/conflict and throttle gap", { skip: !enabled }, async (t) => {
  const schema = `kiw1_cache_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(db);
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

test("recover finds expired task leases and due pending tasks", { skip: !enabled }, async (t) => {
  const schema = `kiw1_recov_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(db);
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  await repo.initialize({ researchId, ownerId: "owner_kiw1", stage: "expansion", generation: 1,
    tasks: expansionTasks(2) }, NOW);
  const stageId = keywordStageId(researchId, "expansion", 1);
  const claimedTaskId = keywordTaskId(stageId, "0:suggestions");
  await repo.claim({ taskId: claimedTaskId, owner: "w", token: newLeaseToken() }, NOW);
  const pendingTaskId = keywordTaskId(stageId, "1:suggestions");
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a",
    token: newLeaseToken() }, NOW);
  const empty = await repo.recover(NOW);
  assert.equal(empty.taskDispatches.length, 1);
  assert.equal(empty.taskDispatches[0].taskId, pendingTaskId);
  assert.equal(empty.aggregateChecks.length, 0);
  const recovered = await repo.recover(LATER);
  assert.equal(recovered.taskDispatches.length, 2);
  assert.ok(recovered.taskDispatches.some(({ taskId }) => taskId === claimedTaskId));
  assert.ok(recovered.taskDispatches.some(({ taskId }) => taskId === pendingTaskId));
  assert.equal(recovered.aggregateChecks.length, 1);
  assert.equal(recovered.aggregateChecks[0].researchId, researchId);
  await db.$disconnect();
});

test("zero-count stage advancement", { skip: !enabled }, async (t) => {
  const schema = `kiw1_zero_${Date.now().toString(36)}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  t.after(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  const repo = new PrismaKeywordResearchRepository(db);
  const researchId = newResearchId();
  await freshResearch(repo, researchId);
  const initialized = await repo.initialize({ researchId, ownerId: "owner_kiw1",
    stage: "expansion", generation: 1, tasks: [] }, NOW);
  assert.equal(initialized.outcome, "created");
  assert.equal(initialized.stage.state, "ready");
  assert.equal(initialized.stage.expectedCount, 0);
  const token = newLeaseToken();
  await repo.claimAggregator({ researchId, stage: "expansion", generation: 1, owner: "a",
    token }, NOW);
  const completed = await repo.publishStageCompletion({ researchId, stage: "expansion",
    generation: 1, token }, NOW);
  assert.equal(completed.outcome, "terminal");
  assert.equal(completed.stage.state, "completed");
  await db.$disconnect();
});
