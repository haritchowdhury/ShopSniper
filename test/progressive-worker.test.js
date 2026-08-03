import assert from "node:assert/strict";
import test from "node:test";
import { executeRun } from "../src/server.js";
import { createInitialStatus } from "../src/status.js";
import { trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";

const RUN_ID = "run_progressiveworkerfixture";
const LEASE = { owner: "worker_fixture", token: "lease_fixture" };

function qualifiedLead() {
  return {
    resolved_domain: "fixture.example",
    final_url: "https://fixture.example/",
    identity_evidence: { stableHostname: "fixture.example" },
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

test("progressive worker commits stores and leads before a traffic failure", async () => {
  const trace = [];
  let rowsListed = false;
  let storesCommitted = false;
  let profileCommitted = false;
  let leadsCommitted = false;
  let trafficFinalized = false;
  let broadFailureCalled = false;
  let storeCheckpointAttempts = 0;
  let profileCheckpointAttempts = 0;
  let leadBarrierAttempts = 0;
  const runStore = {
    id: "run_store_fixtureabcdefghijkl",
    shopId: "shop_fixtureabcdefghijklmnop",
    state: "discovered",
    candidatePayload: { representative: { resultUrl: "https://fixture.example/" } }
  };
  const repository = {
    saveGeneratedQueryPlan: async () => {},
    loadConfirmedQueryPlans: async () => [{ query: "fixture" }],
    saveQueryValidation: async () => {},
    updateProgress: async (_runId, _lease, status) => {
      trace.push(`progress:${status.stage}`);
      return { count: 1 };
    },
    heartbeatRun: async () => LEASE,
    saveDiscoveredStores: async () => {
      storeCheckpointAttempts += 1;
      storesCommitted = true;
      trace.push("stores:committed");
      if (storeCheckpointAttempts === 1) throw new Error("lost store acknowledgement");
      return [runStore];
    },
    listRunStoresForProcessing: async () => {
      if (rowsListed) return [];
      rowsListed = true;
      return [runStore];
    },
    claimRunStore: async () => ({ owned: true, runStore: { ...runStore, state: "processing" } }),
    readReusableShopLeadProfile: async () => null,
    claimShopWork: async () => ({ outcome: "won", networkAllowed: true }),
    saveDiscoveredShopLeadProfile: async () => {
      profileCheckpointAttempts += 1;
      profileCommitted = true;
      trace.push("profile:committed");
      if (profileCheckpointAttempts === 1) throw new Error("lost profile acknowledgement");
    },
    failShopLeadDiscovery: async () => {
      throw new Error("the lead path must not fail");
    },
    saveLeadBatch: async (_runId, _lease, outcomes) => {
      leadBarrierAttempts += 1;
      assert.equal(profileCommitted, true);
      assert.equal(outcomes.length, 1);
      leadsCommitted = true;
      trace.push("leads:barrier");
      if (leadBarrierAttempts === 1) throw new Error("lost barrier acknowledgement");
      return { total: 1, qualified: 1, rejected: 0, failed: 0 };
    },
    listPersistedQualifiedLeads: async () => [qualifiedLead()],
    saveTrafficSourceResults: async () => {},
    completeTrafficEnrichment: async (_runId, _lease, summary, diagnostics, status) => {
      assert.equal(leadsCommitted, true);
      assert.equal(summary.state, "failed");
      assert.equal(diagnostics.length, 1);
      assert.equal(status.storesDiscovered, 9);
      trafficFinalized = true;
      trace.push("traffic:failed-safely");
    },
    markFailed: async () => {
      broadFailureCalled = true;
    }
  };

  await executeRun({
    config: { storeConcurrency: 1 },
    identifier: RUN_ID,
    categories: {
      items: [{ originalShopType: "eyewear", shopType: "eyewear" }],
      phase: "scraping",
      stage: "validating_confirmed_queries",
      progress: { ...createInitialStatus(), storesDiscovered: 9 }
    },
    lease: LEASE,
    pipeline: async () => { throw new Error("legacy pipeline must not run"); },
    planningPipeline: async () => { throw new Error("planning must not run"); },
    queryValidationPipeline: async () => ({
      valid: true,
      rows: [{ query: "fixture", validationState: "valid" }],
      queryPlans: [{ query: "fixture", results: [] }]
    }),
    discoveryPipeline: async () => { throw new Error("legacy discovery must not run"); },
    storeDiscoveryPipeline: async () => ({
      stores: [{ identity: {}, candidatePayload: {} }],
      diagnostics: []
    }),
    leadDiscoveryPipeline: async () => {
      assert.equal(storesCommitted, true);
      trace.push("lead:network");
      return { lead: qualifiedLead(), profile: { contractVersion: "fixture" } };
    },
    leadDependencyOverrides: {},
    trafficOrchestrator: async () => {
      assert.equal(leadsCommitted, true);
      trace.push("traffic:started");
      throw new Error("traffic fixture failure");
    },
    trafficDependencyOverrides: {},
    trafficSnapshot: trafficEnrichmentConfigSnapshot({
      dataForSeoEnrichmentEnabled: true
    }),
    repository,
    logger: () => {},
    now: () => Date.parse("2026-08-03T00:00:00.000Z"),
    leaseDurationMs: 90_000,
    heartbeatIntervalMs: 20_000,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {}
  });

  assert.equal(trafficFinalized, true);
  assert.equal(broadFailureCalled, false);
  assert.equal(storeCheckpointAttempts, 2);
  assert.equal(profileCheckpointAttempts, 2);
  assert.equal(leadBarrierAttempts, 2);
  assert.ok(trace.indexOf("stores:committed") < trace.indexOf("lead:network"));
  assert.ok(trace.indexOf("profile:committed") < trace.indexOf("leads:barrier"));
  assert.ok(trace.indexOf("leads:barrier") < trace.indexOf("traffic:started"));
});

test("lead discovery remains sequential while the run lead barrier publishes once", async () => {
  let listed = false;
  let activeDiscoveries = 0;
  let maxActiveDiscoveries = 0;
  let profileWrites = 0;
  let leadBatchWrites = 0;
  const runStores = Array.from({ length: 3 }, (_, index) => ({
    id: `run_store_fixture_${index}`,
    shopId: `shop_fixture_${index}`,
    state: "discovered",
    candidatePayload: { representative: { resultUrl: `https://fixture-${index}.example/` } }
  }));
  const repository = {
    saveGeneratedQueryPlan: async () => {},
    saveDiscoveredStores: async () => {},
    saveLeadBatch: async (_runId, _lease, outcomes) => {
      leadBatchWrites += 1;
      assert.equal(profileWrites, 3);
      assert.equal(outcomes.length, 3);
      return { total: 3, qualified: 3, rejected: 0, failed: 0 };
    },
    updateProgress: async () => ({ count: 1 }),
    heartbeatRun: async () => LEASE,
    listRunStoresForProcessing: async () => {
      if (listed) return [];
      listed = true;
      return runStores;
    },
    claimRunStore: async (_runId, _lease, id) => ({
      owned: true,
      runStore: { ...runStores.find((row) => row.id === id), state: "processing" }
    }),
    readReusableShopLeadProfile: async () => null,
    claimShopWork: async () => ({ outcome: "won", networkAllowed: true }),
    saveDiscoveredShopLeadProfile: async () => { profileWrites += 1; },
    failShopLeadDiscovery: async () => { throw new Error("unexpected lead failure"); },
    listPersistedQualifiedLeads: async () => runStores.map((_, index) =>
      qualifiedLead(`fixture-${index}.example`)
    ),
    completeTrafficEnrichment: async () => {},
    markFailed: async () => { throw new Error("unexpected run failure"); }
  };

  await executeRun({
    config: { storeConcurrency: 99 },
    identifier: RUN_ID,
    categories: {
      items: [{ originalShopType: "eyewear", shopType: "eyewear" }],
      phase: "scraping",
      stage: "stores_persisted",
      progress: createInitialStatus()
    },
    lease: LEASE,
    pipeline: async () => { throw new Error("legacy pipeline must not run"); },
    planningPipeline: async () => { throw new Error("planning must not run"); },
    queryValidationPipeline: async () => { throw new Error("validation must not repeat"); },
    discoveryPipeline: async () => { throw new Error("legacy discovery must not run"); },
    storeDiscoveryPipeline: async () => { throw new Error("store discovery must not repeat"); },
    leadDiscoveryPipeline: async (_config, runStore) => {
      activeDiscoveries += 1;
      maxActiveDiscoveries = Math.max(maxActiveDiscoveries, activeDiscoveries);
      await Promise.resolve();
      activeDiscoveries -= 1;
      const index = runStores.findIndex(({ id }) => id === runStore.id);
      return {
        lead: qualifiedLead(`fixture-${index}.example`),
        profile: { contractVersion: `fixture-${index}` }
      };
    },
    leadDependencyOverrides: {},
    trafficOrchestrator: async () => { throw new Error("traffic is disabled"); },
    trafficDependencyOverrides: {},
    trafficSnapshot: trafficEnrichmentConfigSnapshot({}),
    repository,
    logger: () => {},
    now: () => Date.parse("2026-08-03T00:00:00.000Z"),
    leaseDurationMs: 90_000,
    heartbeatIntervalMs: 20_000,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {}
  });

  assert.equal(maxActiveDiscoveries, 1);
  assert.equal(profileWrites, 3);
  assert.equal(leadBatchWrites, 1);
});
