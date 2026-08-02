import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  PrismaRunRepository,
  stableLeadId,
  trafficEnrichmentConfigSnapshot
} from "../src/prisma-run-repository.js";

const LEASE = { owner: "worker_fixture", token: "lease_fixture" };
const NOW = new Date("2026-08-01T00:00:00.000Z");

function qualifiedLead(domain = "fixture.example") {
  return {
    resolved_domain: domain,
    status: "qualified",
    pipeline_version: 2,
    scoring_version: 2,
    lead_score: 80,
    score_breakdown: {
      version: 2,
      components: {
        identity: 14,
        shopifyValidation: 20,
        categoryFit: 24,
        contactEvidence: 22
      },
      total: 80,
      semantics: "deterministic_evidence_rank_not_probability"
    }
  };
}

function dataForSeoValue(target = "fixture.example") {
  return {
    contractVersion: "dataforseo-traffic-v1",
    target,
    scope: "worldwide",
    languageScope: "all_available",
    metrics: {
      organic: { etv: 10, count: 1 },
      paid: { etv: 0, count: 0 },
      featuredSnippet: { etv: 0, count: 0 },
      localPack: { etv: 0, count: 0 }
    },
    fetchedAt: "2026-08-01T00:00:00.000Z"
  };
}

function fakePrisma() {
  let findArguments;
  const prisma = {
    lead: {
      count: async () => 0,
      findMany: async (arguments_) => {
        findArguments = arguments_;
        return [];
      }
    },
    $transaction: async (operations) => Promise.all(operations)
  };
  return { prisma, arguments: () => findArguments };
}

test("run creation snapshots exact server-owned traffic enrichment policy without secrets", () => {
  const config = {
    dataForSeoEnrichmentEnabled: true,
    dataForSeoLogin: "must-not-persist",
    dataForSeoPassword: "must-not-persist",
    dataForSeoCacheFreshnessMs: 2592000000,
    dataForSeoMaxCostPerRunUsd: 2,
    trafficNoCoverageCacheFreshnessMs: 86400000,
    trafficPaidRequestStaleMs: 900000,
    cruxEnrichmentEnabled: true,
    cruxApiKey: "must-not-persist",
    cruxRestConcurrency: 2,
    cruxRestCacheFreshnessMs: 86400000,
    cruxBigQueryLocation: "US",
    cruxBigQueryMaxBytesBilled: 10000000000
  };
  const repository = new PrismaRunRepository({}, config);
  const data = repository.runCreateData("user", [], "run_fixture");
  assert.deepEqual(data.trafficEnrichmentConfig, trafficEnrichmentConfigSnapshot(config));
  assert.equal(data.trafficEnrichmentConfig.dataForSeo.scopes.length, 10);
  assert.equal(data.trafficEnrichmentConfig.dataForSeo.estimatedCostPerTaskUsd, 0.024);
  assert.equal(data.trafficEnrichmentConfig.dataForSeo.contractVersion, "dataforseo-traffic-v1");
  assert.equal(data.trafficEnrichmentConfig.crux.rest.contractVersion, "crux-origin-metrics-v1");
  assert.equal(data.trafficEnrichmentConfig.crux.bigQuery.contractVersion, "crux-popularity-v1");
  assert.doesNotMatch(JSON.stringify(data), /must-not-persist/u);
});

test("stable lead IDs are shared across equivalent lead identities", () => {
  const first = stableLeadId("run_fixture", {
    identity_evidence: { stableHostname: "fixture.example" },
    resolved_domain: "ignored.example"
  }, 0);
  const second = stableLeadId("run_fixture", {
    identity_evidence: { stableHostname: "fixture.example" }
  }, 99);
  assert.equal(first, second);
  assert.notEqual(first, stableLeadId("run_other", { resolved_domain: "fixture.example" }, 0));
});

test("fresh cache reads are exact and tenant-neutral", async () => {
  let query;
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      run: { updateMany: async () => ({ count: 1 }) },
      trafficEnrichmentCache: {
        findMany: async (arguments_) => { query = arguments_; return []; }
      }
    })
  });
  await repository.readFreshTrafficCache("run_abcdefghijklmnop", LEASE, [{
    source: "dataforseo",
    identity: "fixture.example",
    scopeKey: "worldwide",
    metricSetKey: "featured_snippet,local_pack,organic,paid",
    contractVersion: "dataforseo-traffic-v1"
  }], NOW);
  assert.deepEqual(query.where.expiresAt, { gt: NOW });
  assert.equal(query.where.OR[0].identity, "fixture.example");
  assert.equal("ownerId" in query.where.OR[0], false);
  let cacheRead = false;
  const stale = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      run: { updateMany: async () => ({ count: 0 }) },
      trafficEnrichmentCache: { findMany: async () => { cacheRead = true; return []; } }
    })
  });
  await assert.rejects(
    stale.readFreshTrafficCache("run_abcdefghijklmnop", LEASE, [query.where.OR[0]], NOW),
    /no longer owns/u
  );
  assert.equal(cacheRead, false);
});

test("paid request claim commits in-flight before granting network permission", async () => {
  let ledger;
  const calls = [];
  const ledgerModel = {
    findUnique: async () => ledger,
    create: async ({ data }) => { calls.push("ledger.create"); ledger = { ...data, attempt: 0 }; return ledger; },
    update: async ({ data }) => { ledger = { ...ledger, ...data }; return ledger; },
    updateMany: async ({ where, data }) => {
      calls.push(`ledger.updateMany:${data.state}`);
      if (!ledger || ledger.state !== where.state || ledger.runId !== where.runId) return { count: 0 };
      ledger = {
        ...ledger,
        ...data,
        attempt: data.attempt?.increment ? ledger.attempt + data.attempt.increment : ledger.attempt
      };
      return { count: 1 };
    }
  };
  const transaction = {
    run: {
      updateMany: async () => { calls.push("run.fence"); return { count: 1 }; },
      findUnique: async () => ({ trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({
        dataForSeoEnrichmentEnabled: true
      }) })
    },
    dataForSeoRequestLedger: ledgerModel
  };
  ledgerModel.findMany = async () => [];
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback(transaction)
  });
  const descriptor = {
    requestFingerprint: "a".repeat(64),
    targetCount: 1,
    scopeKey: "worldwide"
  };
  assert.equal((await repository.planDataForSeoRequest(
    "run_abcdefghijklmnop", LEASE, descriptor, NOW
  )).outcome, "planned");
  const claim = await repository.claimDataForSeoRequest(
    "run_abcdefghijklmnop", LEASE, descriptor.requestFingerprint, NOW
  );
  assert.equal(claim.networkAllowed, true);
  assert.equal(claim.ledger.state, "in_flight");
  assert.equal(claim.ledger.attempt, 1);
  assert.deepEqual(calls, [
    "run.fence", "ledger.create", "run.fence", "ledger.updateMany:in_flight"
  ]);
  assert.equal(Number(claim.ledger.reservationCostUsd), 0.024);
  assert.equal(claim.ledger.ambiguousAfter.toISOString(), "2026-08-01T00:15:00.000Z");
  const competing = await repository.claimDataForSeoRequest(
    "run_abcdefghijklmnop", LEASE, descriptor.requestFingerprint, NOW
  );
  assert.equal(competing.networkAllowed, false);
  assert.equal(competing.outcome, "in_flight");
});

test("successful paid fingerprints refresh only after their cache freshness window", async () => {
  const fingerprint = "f".repeat(64);
  const descriptor = {
    requestFingerprint: fingerprint,
    targetCount: 1,
    scopeKey: "worldwide",
    refreshSucceededAfterMs: 86400000
  };
  let ledger = {
    requestFingerprint: fingerprint,
    runId: "run_previous_abcdefghijkl",
    targetCount: 1,
    scopeKey: "worldwide",
    state: "succeeded",
    completedAt: new Date(NOW.getTime() - 1000)
  };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      run: { updateMany: async () => ({ count: 1 }) },
      dataForSeoRequestLedger: {
        findUnique: async () => ledger,
        update: async ({ data }) => { ledger = { ...ledger, ...data }; return ledger; }
      }
    })
  });
  assert.equal((await repository.planDataForSeoRequest(
    "run_current_abcdefghijkl", LEASE, descriptor, NOW
  )).outcome, "succeeded");
  ledger.completedAt = new Date(NOW.getTime() - 86400001);
  assert.equal((await repository.planDataForSeoRequest(
    "run_current_abcdefghijkl", LEASE, descriptor, NOW
  )).outcome, "planned");
  assert.equal(ledger.runId, "run_current_abcdefghijkl");
  assert.equal(ledger.providerCostUsd, null);
});

test("paid success fences the lease and commits ledger plus normalized cache atomically", async () => {
  const calls = [];
  let ledger = {
    requestFingerprint: "b".repeat(64),
    runId: "run_abcdefghijklmnop",
    state: "in_flight",
    leaseOwner: LEASE.owner,
    leaseToken: LEASE.token
  };
  const transaction = {
    run: { updateMany: async () => { calls.push("run.fence"); return { count: 1 }; } },
    dataForSeoRequestLedger: {
      updateMany: async ({ data }) => {
        calls.push("ledger.succeeded");
        ledger = { ...ledger, ...data };
        return { count: 1 };
      },
      findUnique: async () => ledger
    },
    trafficEnrichmentCache: {
      upsert: async () => calls.push("cache.upsert")
    }
  };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback(transaction)
  });
  const result = await repository.markDataForSeoRequestSucceeded(
    "run_abcdefghijklmnop",
    LEASE,
    ledger.requestFingerprint,
    {
      providerCostUsd: 0.012,
      cacheRows: [{
        source: "dataforseo",
        identity: "fixture.example",
        scopeKey: "worldwide",
        metricSetKey: "featured_snippet,local_pack,organic,paid",
        contractVersion: "dataforseo-traffic-v1",
        state: "available",
        normalizedPayload: dataForSeoValue(),
        fetchedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-31T00:00:00.000Z"
      }]
    },
    NOW
  );
  assert.equal(result.state, "succeeded");
  assert.deepEqual(calls, ["run.fence", "ledger.succeeded", "cache.upsert"]);

  let cacheTouched = false;
  const stale = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      run: { updateMany: async () => ({ count: 0 }) },
      dataForSeoRequestLedger: transaction.dataForSeoRequestLedger,
      trafficEnrichmentCache: { upsert: async () => { cacheTouched = true; } }
    })
  });
  await assert.rejects(stale.markDataForSeoRequestSucceeded(
    "run_abcdefghijklmnop", LEASE, ledger.requestFingerprint,
    { providerCostUsd: 0.012, cacheRows: [] }, NOW
  ), /no longer owns/u);
  assert.equal(cacheTouched, false);
});

test("only stale in-flight paid work on an inactive lease becomes ambiguous", async () => {
  let update;
  const repository = new PrismaRunRepository({
    dataForSeoRequestLedger: {
      updateMany: async (arguments_) => { update = arguments_; return { count: 1 }; }
    }
  });
  await repository.markStaleDataForSeoRequestsAmbiguous(NOW);
  assert.equal(update.where.state, "in_flight");
  assert.deepEqual(update.where.OR, [
    { ambiguousAfter: { lte: NOW } },
    { ambiguousAfter: null }
  ]);
  assert.equal(update.data.state, "ambiguous");
  assert.equal(update.data.safeErrorCode, "PAID_REQUEST_OUTCOME_AMBIGUOUS");
});

test("known paid failures persist only fixed privacy-safe diagnostics", async () => {
  let stored;
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      run: { updateMany: async () => ({ count: 1 }) },
      dataForSeoRequestLedger: {
        updateMany: async ({ data }) => { stored = data; return { count: 1 }; },
        findUnique: async () => ({ state: "failed", ...stored })
      }
    })
  });
  await repository.markDataForSeoRequestFailed(
    "run_abcdefghijklmnop",
    LEASE,
    "c".repeat(64),
    {
      code: "DATAFORSEO_NOT_DISPATCHED",
      message: "Bearer should-never-be-persisted"
    },
    NOW
  );
  assert.equal(stored.safeErrorMessage, "The request failed before provider dispatch.");
  assert.doesNotMatch(JSON.stringify(stored), /should-never/u);
  await assert.rejects(repository.markDataForSeoRequestFailed(
    "run_abcdefghijklmnop", LEASE, "c".repeat(64),
    { code: "CALLER_DEFINED", message: "fixture" }, NOW
  ), /recognized safe/u);
});

for (const [sortBy, modelField] of [
  ["lead_score", "leadScore"],
  ["store_name", "storeName"],
  ["shop_type", "shopType"],
  ["google_rank", "googleRank"]
]) {
  test(`repository maps the ${sortBy} sort to a fixed Prisma field`, async () => {
    const fake = fakePrisma();
    const repository = new PrismaRunRepository(fake.prisma);
    await repository.getResultsPage("run_abcdefghijklmnop", "user_alice", {
      page: 2,
      pageSize: 25,
      status: "qualified",
      search: "fashion",
      sortBy,
      sortDirection: "asc"
    });

    const query = fake.arguments();
    assert.equal(query.where.runId, "run_abcdefghijklmnop");
    assert.equal(query.where.run.ownerId, "user_alice");
    assert.equal(query.where.status, "qualified");
    assert.equal(query.where.OR.length, 5);
    assert.deepEqual(query.orderBy[0], {
      [modelField]: { sort: "asc", nulls: "last" }
    });
    assert.deepEqual(query.orderBy[1], { id: "asc" });
    assert.equal(query.skip, 25);
    assert.equal(query.take, 25);
  });
}

test("repository default ordering is deterministic with null scores last", async () => {
  const fake = fakePrisma();
  const repository = new PrismaRunRepository(fake.prisma);
  await repository.getResultsPage("run_abcdefghijklmnop", "user_alice", {
    page: 1,
    pageSize: 100,
    status: null,
    search: null,
    sortBy: null,
    sortDirection: "desc"
  });
  assert.deepEqual(fake.arguments().orderBy, [
    { leadScore: { sort: "desc", nulls: "last" } },
    { storeName: { sort: "asc", nulls: "last" } },
    { id: "asc" }
  ]);
});

test("restart recovery fails only expired or legacy-unleased running work", async () => {
  let updateArguments;
  const repository = new PrismaRunRepository({
    run: {
      updateMany: async (arguments_) => {
        updateArguments = arguments_;
        return { count: 1 };
      }
    }
  });

  await repository.recoverExpiredRuns(NOW);
  assert.equal(updateArguments.where.state, "running");
  assert.deepEqual(updateArguments.where.OR, [
    { leaseExpiresAt: { lte: NOW } },
    { leaseExpiresAt: null }
  ]);
  assert.equal(updateArguments.data.state, "failed");
  assert.equal(updateArguments.data.safeErrorCode, "RUN_LEASE_EXPIRED");
});

test("progress, heartbeat, and failure writes require the active lease fence", async () => {
  const updates = [];
  const repository = new PrismaRunRepository({
    run: {
      updateMany: async (arguments_) => {
        updates.push(arguments_);
        return { count: 1 };
      }
    }
  });
  await repository.updateProgress("run_abcdefghijklmnop", LEASE, { stage: "running" }, NOW);
  await repository.heartbeatRun("run_abcdefghijklmnop", LEASE, NOW, 60_000);
  await repository.markFailed("run_abcdefghijklmnop", LEASE, {}, null, NOW);
  for (const update of updates) {
    assert.deepEqual(update.where, {
      id: "run_abcdefghijklmnop",
      state: "running",
      leaseOwner: LEASE.owner,
      leaseToken: LEASE.token,
      leaseExpiresAt: { gt: NOW }
    });
  }

  const rejected = new PrismaRunRepository({
    run: { updateMany: async () => ({ count: 0 }) }
  });
  await assert.rejects(
    rejected.updateProgress("run_abcdefghijklmnop", LEASE, {}, NOW),
    /no longer owns/u
  );
});

test("completion writes leads, audits, diagnostics, and publication in one transaction", async () => {
  const calls = [];
  const model = (name) => ({
    deleteMany: async () => calls.push(`${name}.deleteMany`),
    createMany: async () => calls.push(`${name}.createMany`)
  });
  const transaction = {
    lead: model("lead"),
    leadTrafficEnrichment: model("leadTrafficEnrichment"),
    queryAudit: model("queryAudit"),
    runDiagnostic: model("runDiagnostic"),
    run: {
      updateMany: async () => { calls.push("run.updateMany"); return { count: 1 }; },
      findUnique: async () => { calls.push("run.findUnique"); return { resultsAvailable: true, pipelineVersion: 2 }; }
    }
  };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback(transaction)
  });
  const leadId = stableLeadId("run_abcdefghijklmnop", qualifiedLead(), 0);
  const result = await repository.saveCompletedResults("run_abcdefghijklmnop", LEASE, {
    leads: [qualifiedLead()],
    trafficEnrichments: [{
      leadId,
      source: "dataforseo",
      state: "partial",
      contractVersion: "dataforseo-traffic-v1",
      normalizedPayload: { records: [dataForSeoValue()] },
      fetchedAt: "2026-08-01T00:00:00.000Z"
    }],
    trafficEnrichmentSummary: { dataforseo: { available: 1 } },
    queryAudits: [{ query: "fixture", status: "selected" }],
    diagnostics: [{ scope: "query", code: "fixture", details: {} }],
    summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
  });
  assert.deepEqual(calls, [
    "run.updateMany",
    "leadTrafficEnrichment.deleteMany", "lead.deleteMany", "queryAudit.deleteMany", "runDiagnostic.deleteMany",
    "lead.createMany", "leadTrafficEnrichment.createMany", "queryAudit.createMany", "runDiagnostic.createMany", "run.findUnique"
  ]);
  assert.equal(result.resultsAvailable, true);
  assert.equal(result.pipelineVersion, 2);
});

test("completion mapper rejects semantically impossible enrichment before persistence", async () => {
  let transactionStarted = false;
  const repository = new PrismaRunRepository({
    $transaction: async () => { transactionStarted = true; }
  });
  const lead = qualifiedLead();
  const leadId = stableLeadId("run_abcdefghijklmnop", lead, 0);
  const value = dataForSeoValue();
  await assert.rejects(repository.saveCompletedResults("run_abcdefghijklmnop", LEASE, {
    leads: [lead],
    trafficEnrichments: [{
      leadId,
      source: "dataforseo",
      state: "partial",
      contractVersion: "dataforseo-traffic-v1",
      normalizedPayload: { records: [value, { ...value }] },
      fetchedAt: value.fetchedAt
    }],
    summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
  }), /normalized contract/u);
  assert.equal(transactionStarted, false);
});

test("query-planning shortfall stores audits and releases the lease atomically", async () => {
  const calls = [];
  let updateArguments;
  const transaction = {
    run: {
      updateMany: async (arguments_) => {
        calls.push("run.updateMany");
        updateArguments = arguments_;
        return { count: 1 };
      },
      findUnique: async () => ({ state: "failed" })
    },
    runQuery: { deleteMany: async () => calls.push("runQuery.deleteMany") },
    queryAudit: {
      deleteMany: async () => calls.push("queryAudit.deleteMany"),
      createMany: async () => calls.push("queryAudit.createMany")
    }
  };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback(transaction)
  });
  await repository.saveQueryPlanningFailure(
    "run_abcdefghijklmnop",
    LEASE,
    {
      audits: [{ shop_type: "clothing", status: "rejected", rejection_reason: "low_query_quality" }],
      shortfalls: [{ shopType: "clothing", selected: 9, target: 10 }]
    },
    { stage: "selecting_queries" },
    NOW
  );
  assert.deepEqual(calls, [
    "run.updateMany",
    "runQuery.deleteMany",
    "queryAudit.deleteMany",
    "queryAudit.createMany"
  ]);
  assert.equal(updateArguments.data.state, "failed");
  assert.equal(updateArguments.data.phase, "finished");
  assert.equal(updateArguments.data.safeErrorCode, "INSUFFICIENT_HIGH_QUALITY_QUERIES");
  assert.equal(updateArguments.data.safeErrorMessage, "9 of 10 required queries passed for clothing.");
  assert.equal(updateArguments.data.leaseToken, null);
  assert.deepEqual(updateArguments.where, {
    id: "run_abcdefghijklmnop",
    state: "running",
    leaseOwner: LEASE.owner,
    leaseToken: LEASE.token,
    leaseExpiresAt: { gt: NOW }
  });
});

test("lease loss prevents query-plan failure audits from being written", async () => {
  const calls = [];
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      run: {
        updateMany: async () => {
          calls.push("run.updateMany");
          return { count: 0 };
        }
      },
      runQuery: { deleteMany: async () => calls.push("runQuery.deleteMany") },
      queryAudit: {
        deleteMany: async () => calls.push("queryAudit.deleteMany"),
        createMany: async () => calls.push("queryAudit.createMany")
      }
    })
  });
  await assert.rejects(
    repository.saveQueryPlanningFailure(
      "run_abcdefghijklmnop",
      LEASE,
      { audits: [{ status: "rejected" }], shortfalls: [] },
      {},
      NOW
    ),
    /no longer owns/u
  );
  assert.deepEqual(calls, ["run.updateMany"]);
});

test("owner scope is applied to audit and diagnostic repository reads", async () => {
  const seen = [];
  const pageable = (name) => ({
    count: async ({ where }) => { seen.push([name, where]); return 0; },
    findMany: async () => []
  });
  const repository = new PrismaRunRepository({
    queryAudit: pageable("audit"),
    runDiagnostic: pageable("diagnostic"),
    $transaction: async (operations) => Promise.all(operations)
  });
  await repository.getQueryAuditsPage("run_abcdefghijklmnop", "user_alice", { page: 1, pageSize: 20 });
  await repository.getDiagnosticsPage("run_abcdefghijklmnop", "user_alice", { page: 1, pageSize: 20 });
  for (const [, where] of seen) assert.deepEqual(where.run, { ownerId: "user_alice" });
});

test("a child-write failure occurs after the conditional publication gate", async () => {
  let published = false;
  const noOp = { deleteMany: async () => {}, createMany: async () => {} };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      lead: noOp,
      leadTrafficEnrichment: noOp,
      queryAudit: noOp,
      runDiagnostic: {
        deleteMany: async () => {},
        createMany: async () => { throw new Error("injected durable write failure"); }
      },
      run: {
        updateMany: async () => { published = true; return { count: 1 }; },
        findUnique: async () => ({ state: "completed" })
      }
    })
  });
  await assert.rejects(repository.saveCompletedResults("run_abcdefghijklmnop", LEASE, {
    leads: [qualifiedLead()],
    queryAudits: [{ query: "fixture", status: "selected" }],
    diagnostics: [{ scope: "query", code: "fixture", details: {} }],
    summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
  }), /injected durable write failure/u);
  assert.equal(published, true);
});

test("completion replay is idempotent only for the same durable payload", async () => {
  let fingerprint;
  const transaction = {
    lead: { deleteMany: async () => {}, createMany: async () => {} },
    leadTrafficEnrichment: { deleteMany: async () => {}, createMany: async () => {} },
    queryAudit: { deleteMany: async () => {}, createMany: async () => {} },
    runDiagnostic: { deleteMany: async () => {}, createMany: async () => {} },
    run: {
      updateMany: async ({ data }) => {
        if (fingerprint) return { count: 0 };
        fingerprint = data.resultFingerprint;
        return { count: 1 };
      },
      findUnique: async () => ({ state: "completed", resultFingerprint: fingerprint })
    }
  };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback(transaction)
  });
  const payload = {
    leads: [qualifiedLead()],
    summary: { total: 1, qualified: 1, rejected: 0, failed: 0 }
  };
  await repository.saveCompletedResults("run_abcdefghijklmnop", LEASE, payload);
  transaction.run.findUnique = async () => ({
    state: "completed",
    leaseOwner: LEASE.owner,
    leaseToken: LEASE.token,
    resultFingerprint: fingerprint
  });
  await repository.saveCompletedResults("run_abcdefghijklmnop", LEASE, payload);
  await assert.rejects(
    repository.saveCompletedResults("run_abcdefghijklmnop", LEASE, {
      ...payload,
      summary: { total: 1, qualified: 0, rejected: 1, failed: 0 }
    }),
    /different terminal result/u
  );
});

test("G3 migration is additive and contains no historical-row rewrite", async () => {
  const url = new URL(
    "../prisma/migrations/20260731230000_g3_pipeline_quality/migration.sql",
    import.meta.url
  );
  const sql = await fs.readFile(url, "utf8");
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|DROP TABLE)\b/imu);
  assert.match(sql, /ADD COLUMN "pipelineVersion" INTEGER/u);
  assert.match(sql, /CREATE TABLE "QueryAudit"/u);
  assert.match(sql, /CREATE TABLE "RunDiagnostic"/u);
});

test("G-R4 migration preserves rows while widening query scores and adding provenance", async () => {
  const url = new URL(
    "../prisma/migrations/20260801000000_gr4_durable_v2/migration.sql",
    import.meta.url
  );
  const sql = await fs.readFile(url, "utf8");
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|DROP TABLE)\b/imu);
  assert.match(sql, /"queryScore" TYPE DOUBLE PRECISION/u);
  assert.match(sql, /ADD COLUMN "originalShopType" TEXT/u);
  assert.match(sql, /ADD COLUMN "resultFingerprint" TEXT/u);
});

test("G-R6 migration is additive and introduces the lease fence", async () => {
  const url = new URL(
    "../prisma/migrations/20260801090000_gr6_worker_leases/migration.sql",
    import.meta.url
  );
  const sql = await fs.readFile(url, "utf8");
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|DROP TABLE)\b/imu);
  assert.match(sql, /ADD COLUMN "leaseOwner" TEXT/u);
  assert.match(sql, /ADD COLUMN "leaseToken" TEXT/u);
  assert.match(sql, /ADD COLUMN "leaseExpiresAt" TIMESTAMP/u);
  assert.match(sql, /ADD COLUMN "leaseAttempt" INTEGER NOT NULL DEFAULT 0/u);
});

test("TE-3 migration is forward-only and adds isolated enrichment storage", async () => {
  const url = new URL(
    "../prisma/migrations/20260802090000_traffic_enrichment_v1/migration.sql",
    import.meta.url
  );
  const sql = await fs.readFile(url, "utf8");
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|DROP TABLE)\b/imu);
  assert.match(sql, /ADD COLUMN "trafficEnrichmentConfig" JSONB/u);
  assert.match(sql, /CREATE TABLE "TrafficEnrichmentCache"/u);
  assert.match(sql, /CREATE TABLE "LeadTrafficEnrichment"/u);
  assert.match(sql, /CREATE TABLE "DataForSeoRequestLedger"/u);
  assert.match(sql, /FOREIGN KEY \("leadId", "runId"\)/u);
});

test("TE-R2 migration adds only decimal reservation, deadline, and recovery index", async () => {
  const url = new URL(
    "../prisma/migrations/20260802120000_dataforseo_paid_safety/migration.sql",
    import.meta.url
  );
  const sql = await fs.readFile(url, "utf8");
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|DROP TABLE)\b/imu);
  assert.match(sql, /ADD COLUMN "reservationCostUsd" DECIMAL\(18,8\)/u);
  assert.match(sql, /ADD COLUMN "ambiguousAfter" TIMESTAMP/u);
  assert.match(sql, /\("state", "ambiguousAfter"\)/u);
  assert.doesNotMatch(sql, /DOUBLE PRECISION|REAL/u);
});
