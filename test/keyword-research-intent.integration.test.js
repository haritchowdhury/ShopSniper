import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { keywordResearchConfigV1 } from "../src/keyword-intelligence/config.js";
import {
  newKeywordResearchIntentId,
  newResearchId,
  PrismaKeywordResearchRepository,
} from "../src/keyword-intelligence/repository.js";
import { createPrismaClient } from "../src/prisma-client.js";
import {
  assertMigrationStayedInSchema,
  createIsolatedTestSchema,
  deployPrismaMigrations,
} from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const REQUIRED = ["LKAI-DB-01", "LKAI-DB-02", "LKAI-DB-03", "LKAI-DB-04"];
const REQUIRED_CONTROLS = ["LKAI-NC-02"];
const registered = new Set();
const executed = new Set();
const falsifiedControls = new Set();
const NOW = new Date("2026-08-26T12:00:00.000Z");
const EXPIRES_AT = new Date(NOW.getTime() + 3_600_000);
const CONFIG = keywordResearchConfigV1();
const CONFIG_FINGERPRINT = fingerprintJson(CONFIG);

function intentInput(overrides = {}) {
  return {
    intentId: newKeywordResearchIntentId(),
    seeds: ["eyewear"],
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function claimInput(intentId, ownerId, overrides = {}) {
  return {
    intentId,
    ownerId,
    researchId: newResearchId(),
    configSnapshot: CONFIG,
    configFingerprint: CONFIG_FINGERPRINT,
    markets: CONFIG.markets,
    ...overrides,
  };
}

async function assertAtomicIntentMapping(db, { intentId, ownerId }) {
  const intent = await db.keywordResearchIntent.findUnique({ where: { id: intentId } });
  assert.ok(intent, "atomicity oracle requires the durable intent");
  const candidates = await db.keywordResearch.findMany({
    where: { ownerId },
    orderBy: { id: "asc" },
  });
  if (intent.claimedResearchId === null) {
    assert.equal(candidates.length, 0, "an unclaimed intent must have no candidate research orphan");
    return;
  }
  assert.equal(intent.claimedByUserId, ownerId, "claimed intent owner and research owner must agree");
  assert.equal(candidates.length, 1, "a claimed intent must map to exactly one candidate research");
  assert.equal(candidates[0].id, intent.claimedResearchId, "intent mapping must name the candidate research");
}

async function runCleanAtomicCandidate(db, repo, label) {
  const intent = intentInput({ seeds: [`${label} seed`] });
  const ownerId = `owner_${label}`;
  await repo.createIntent(intent, NOW);
  await assertAtomicIntentMapping(db, { intentId: intent.intentId, ownerId });
  const claimed = await repo.claimIntent(claimInput(intent.intentId, ownerId), NOW);
  assert.equal(claimed.outcome, "created", `${label}: clean claim must create`);
  await assertAtomicIntentMapping(db, { intentId: intent.intentId, ownerId });
}

async function splitBoundaryDefectiveClaim(db, input, now) {
  const intent = await db.keywordResearchIntent.findUnique({ where: { id: input.intentId } });
  assert.ok(intent, "defective claimant requires an intent");
  await db.$transaction((tx) => tx.keywordResearch.create({ data: {
    id: input.researchId,
    ownerId: input.ownerId,
    state: "queued",
    generation: 1,
    contractVersion: 1,
    configSnapshot: input.configSnapshot,
    configFingerprint: input.configFingerprint,
    seeds: intent.seeds,
    markets: input.markets,
    progress: { stages: {} },
    selectionRevision: 0,
    createdAt: now,
  } }));
  throw new Error("INJECTED_SPLIT_BOUNDARY_FAILURE_BEFORE_INTENT_CLAIM");
}

function lostCasProbe(intentId) {
  let arrivals = 0;
  let transactionNumber = 0;
  let release;
  let reject;
  const gate = new Promise((resolve, rejectGate) => {
    release = resolve;
    reject = rejectGate;
  });
  const timer = setTimeout(() => reject(new Error("lost-CAS read barrier timed out")), 10_000);
  const observations = [];
  const provisionalCreates = [];
  const provisionalDeletes = [];

  const allocateTransaction = () => {
    transactionNumber += 1;
    return transactionNumber;
  };

  const wrap = (tx, transaction) => {
    let firstIntentRead = true;
    const intentDelegate = new Proxy(tx.keywordResearchIntent, {
      get(target, property) {
        if (property === "findUnique") {
          return async (args) => {
            const row = await target.findUnique(args);
            if (firstIntentRead && args?.where?.id === intentId) {
              firstIntentRead = false;
              observations.push({
                transaction,
                claimedAt: row?.claimedAt ?? null,
                claimedByUserId: row?.claimedByUserId ?? null,
                claimedResearchId: row?.claimedResearchId ?? null,
              });
              arrivals += 1;
              if (arrivals === 2) {
                clearTimeout(timer);
                release();
              }
              await gate;
            }
            return row;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const researchDelegate = new Proxy(tx.keywordResearch, {
      get(target, property) {
        if (property === "create") {
          return async (args) => {
            const row = await target.create(args);
            provisionalCreates.push({ transaction, researchId: row.id });
            return row;
          };
        }
        if (property === "delete") {
          return async (args) => {
            const row = await target.delete(args);
            provisionalDeletes.push({ transaction, researchId: row.id });
            return row;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(tx, {
      get(target, property) {
        if (property === "keywordResearchIntent") return intentDelegate;
        if (property === "keywordResearch") return researchDelegate;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  return {
    allocateTransaction,
    wrap,
    observations,
    provisionalCreates,
    provisionalDeletes,
  };
}

function installLostCasProbe(repo, intentId) {
  const probe = lostCasProbe(intentId);
  const originalTransaction = repo._transaction.bind(repo);
  repo._transaction = (work, options) => {
    const transaction = probe.allocateTransaction();
    return originalTransaction(
      (tx) => work(probe.wrap(tx, transaction)),
      options
    );
  };
  return probe;
}

function assertLostCasActivated(probe, candidateResearchIds) {
  assert.equal(probe.observations.length, 2, "both claimants must cross the first-read barrier");
  assert.ok(probe.observations.every((row) =>
    row.claimedAt === null && row.claimedByUserId === null && row.claimedResearchId === null
  ), "both claimants must observe the intent unclaimed before either CAS");
  assert.deepEqual(
    new Set(probe.provisionalCreates.map(({ researchId }) => researchId)),
    new Set(candidateResearchIds),
    "both claimants must insert their provisional research"
  );
  assert.equal(probe.provisionalDeletes.length, 1, "the lost-CAS claimant must delete one provisional research");
  assert.ok(
    candidateResearchIds.includes(probe.provisionalDeletes[0].researchId),
    "the deleted provisional must belong to one activated claimant"
  );
}

async function setup(t, prefix) {
  const schema = `${prefix}_${randomBytes(6).toString("hex")}`;
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema);
  deployPrismaMigrations(scopedUrl);
  const db = createPrismaClient(scopedUrl);
  await assertMigrationStayedInSchema(db, schema);
  t.after(async () => {
    await db.$disconnect().catch(() => {});
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const [remaining] = await admin.$queryRawUnsafe(
      "SELECT schema_name::text AS name FROM information_schema.schemata WHERE schema_name = $1",
      schema
    );
    assert.equal(remaining, undefined, `disposable schema ${schema} must be absent after cleanup`);
    await admin.$disconnect();
  });
  return { db, repo: new PrismaKeywordResearchRepository(db), schema };
}

function register(id, implementation) {
  assert.ok(REQUIRED.includes(id), `unexpected case ${id}`);
  assert.equal(registered.has(id), false, `duplicate case ${id}`);
  registered.add(id);
  test(id, { skip: !enabled }, async (t) => {
    await implementation(t);
    executed.add(id);
  });
}

register("LKAI-DB-01", async (t) => {
  const { db, repo, schema } = await setup(t, "lkai_db01");
  const columns = await db.$queryRawUnsafe(`
    SELECT column_name::text AS name
    FROM information_schema.columns
    WHERE table_schema = '${schema}' AND table_name = 'KeywordResearchIntent'
    ORDER BY ordinal_position`);
  assert.deepEqual(columns.map(({ name }) => name), [
    "id", "seeds", "createdAt", "expiresAt", "claimedAt", "claimedByUserId", "claimedResearchId",
  ]);

  const indexes = await db.$queryRawUnsafe(`
    SELECT indexname::text AS name
    FROM pg_indexes
    WHERE schemaname = '${schema}' AND tablename = 'KeywordResearchIntent'`);
  assert.deepEqual(new Set(indexes.map(({ name }) => name)), new Set([
    "KeywordResearchIntent_pkey",
    "KeywordResearchIntent_claimedResearchId_key",
    "KeywordResearchIntent_expiresAt_idx",
  ]));

  const [foreignKey] = await db.$queryRawUnsafe(`
    SELECT con.conname::text AS name,
           confdeltype::text AS delete_action,
           confupdtype::text AS update_action
    FROM pg_constraint con
    JOIN pg_namespace ns ON ns.oid = con.connamespace
    WHERE ns.nspname = '${schema}'
      AND con.conname = 'KeywordResearchIntent_claimedResearchId_fkey'`);
  assert.deepEqual(foreignKey, {
    name: "KeywordResearchIntent_claimedResearchId_fkey",
    delete_action: "r",
    update_action: "c",
  });
  assert.equal(await db.runIntent.count(), 0, "legacy RunIntent remains queryable");

  const expiredUnclaimed = newKeywordResearchIntentId();
  const liveUnclaimed = newKeywordResearchIntentId();
  const claimedIntent = newKeywordResearchIntentId();
  const claimedResearch = newResearchId();
  await db.keywordResearch.create({ data: {
    id: claimedResearch,
    ownerId: "owner_cleanup",
    configSnapshot: CONFIG,
    configFingerprint: CONFIG_FINGERPRINT,
    seeds: ["claimed"],
    markets: CONFIG.markets,
    progress: { stages: {} },
    createdAt: NOW,
  } });
  await db.keywordResearchIntent.createMany({ data: [
    { id: expiredUnclaimed, seeds: ["expired"], createdAt: new Date(NOW.getTime() - 7_200_000), expiresAt: NOW },
    { id: liveUnclaimed, seeds: ["live"], createdAt: NOW, expiresAt: EXPIRES_AT },
    { id: claimedIntent, seeds: [], createdAt: new Date(NOW.getTime() - 7_200_000), expiresAt: NOW,
      claimedAt: new Date(NOW.getTime() - 3_600_000), claimedByUserId: "owner_cleanup",
      claimedResearchId: claimedResearch },
  ] });
  assert.deepEqual(await repo.deleteExpiredIntents(NOW), { count: 1 });
  assert.equal(await db.keywordResearchIntent.findUnique({ where: { id: expiredUnclaimed } }), null);
  assert.ok(await db.keywordResearchIntent.findUnique({ where: { id: liveUnclaimed } }));
  assert.ok(await db.keywordResearchIntent.findUnique({ where: { id: claimedIntent } }));
  const replay = await repo.claimIntent(claimInput(claimedIntent, "owner_cleanup"), NOW);
  assert.equal(replay.outcome, "found", "claimed mapping remains replayable after its original expiry");
  assert.equal(replay.research.id, claimedResearch);
  assert.deepEqual(
    await repo.claimIntent(claimInput(claimedIntent, "owner_foreign"), NOW),
    { outcome: "not_found" },
    "expired claimed mapping remains owner-private"
  );
});

register("LKAI-DB-02", async (t) => {
  const { db, repo } = await setup(t, "lkai_db02");
  const intent = intentInput();
  assert.equal((await repo.createIntent(intent, NOW)).outcome, "created");
  const duplicateResearchId = newResearchId();
  await db.keywordResearch.create({ data: {
    id: duplicateResearchId,
    ownerId: "existing_owner",
    configSnapshot: CONFIG,
    configFingerprint: CONFIG_FINGERPRINT,
    seeds: ["existing"],
    markets: CONFIG.markets,
    progress: { stages: {} },
    createdAt: NOW,
  } });
  assert.deepEqual(
    await repo.claimIntent(
      claimInput(intent.intentId, "owner_rollback", { researchId: duplicateResearchId }),
      NOW
    ),
    { outcome: "conflict" }
  );
  const unchanged = await db.keywordResearchIntent.findUnique({ where: { id: intent.intentId } });
  assert.equal(unchanged.claimedAt, null);
  assert.equal(unchanged.claimedByUserId, null);
  assert.equal(unchanged.claimedResearchId, null);
  assert.deepEqual(unchanged.seeds, ["eyewear"]);
  assert.equal(await db.keywordResearch.count(), 1, "failed insert leaves no provisional research");

  await runCleanAtomicCandidate(db, repo, "nc02_clean_before");

  const defectiveIntent = intentInput({ seeds: ["nc02 defective seed"] });
  const defectiveOwner = "owner_nc02_defective";
  await repo.createIntent(defectiveIntent, NOW);
  const defectiveInput = claimInput(defectiveIntent.intentId, defectiveOwner);
  await assertAtomicIntentMapping(db, {
    intentId: defectiveIntent.intentId,
    ownerId: defectiveOwner,
  });
  await assert.rejects(
    () => splitBoundaryDefectiveClaim(db, defectiveInput, NOW),
    /INJECTED_SPLIT_BOUNDARY_FAILURE_BEFORE_INTENT_CLAIM/
  );
  await assert.rejects(
    () => assertAtomicIntentMapping(db, {
      intentId: defectiveIntent.intentId,
      ownerId: defectiveOwner,
    }),
    assert.AssertionError,
    "the actual split-boundary orphan must fail the clean atomicity oracle"
  );
  await db.keywordResearch.delete({ where: { id: defectiveInput.researchId } });
  await assertAtomicIntentMapping(db, {
    intentId: defectiveIntent.intentId,
    ownerId: defectiveOwner,
  });

  await runCleanAtomicCandidate(db, repo, "nc02_clean_after");
  falsifiedControls.add("LKAI-NC-02");
});

register("LKAI-DB-03", async (t) => {
  const { db, repo } = await setup(t, "lkai_db03");
  const intent = intentInput();
  await repo.createIntent(intent, NOW);
  const leftInput = claimInput(intent.intentId, "owner_same");
  const rightInput = claimInput(intent.intentId, "owner_same");
  const probe = installLostCasProbe(repo, intent.intentId);
  const [left, right] = await Promise.all([
    repo.claimIntent(leftInput, NOW),
    repo.claimIntent(rightInput, NOW),
  ]);
  assertLostCasActivated(probe, [leftInput.researchId, rightInput.researchId]);
  assert.deepEqual(new Set([left.outcome, right.outcome]), new Set(["created", "found"]));
  assert.equal(left.research.id, right.research.id);
  assert.equal(await db.keywordResearch.count({ where: { ownerId: "owner_same" } }), 1);
  const mapped = await db.keywordResearchIntent.findUnique({ where: { id: intent.intentId } });
  assert.equal(mapped.claimedResearchId, left.research.id);
  assert.equal(mapped.claimedByUserId, "owner_same");
  assert.deepEqual(mapped.seeds, []);
});

register("LKAI-DB-04", async (t) => {
  const { db, repo } = await setup(t, "lkai_db04");
  const intent = intentInput();
  await repo.createIntent(intent, NOW);
  const leftInput = claimInput(intent.intentId, "owner_left");
  const rightInput = claimInput(intent.intentId, "owner_right");
  const probe = installLostCasProbe(repo, intent.intentId);
  const [left, right] = await Promise.all([
    repo.claimIntent(leftInput, NOW),
    repo.claimIntent(rightInput, NOW),
  ]);
  assertLostCasActivated(probe, [leftInput.researchId, rightInput.researchId]);
  assert.deepEqual(new Set([left.outcome, right.outcome]), new Set(["created", "not_found"]));
  const winner = left.outcome === "created" ? left : right;
  const winnerOwner = left.outcome === "created" ? "owner_left" : "owner_right";
  assert.equal(winner.research.ownerId, winnerOwner);
  assert.equal(await db.keywordResearch.count(), 1);
  const mapped = await db.keywordResearchIntent.findUnique({ where: { id: intent.intentId } });
  assert.equal(mapped.claimedByUserId, winnerOwner);
  assert.equal(mapped.claimedResearchId, winner.research.id);
});

test("LKAI database registry is exact", () => {
  assert.deepEqual([...registered].sort(), [...REQUIRED].sort());
  if (enabled) {
    assert.deepEqual([...executed].sort(), [...REQUIRED].sort());
    assert.deepEqual([...falsifiedControls].sort(), [...REQUIRED_CONTROLS].sort());
  }
});
