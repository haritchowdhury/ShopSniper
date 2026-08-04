import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  PrismaRunRepository,
  stableLeadId,
  trafficEnrichmentConfigSnapshot
} from "../src/prisma-run-repository.js";
import {
  runStoreId,
  runStoreCandidateFromDiscovery,
  shopIdForStableKey,
  stableShopIdentity
} from "../src/shop-persistence-contract.js";

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

function discoveredStore(index) {
  const label = String(index).padStart(3, "0");
  const hostname = `bulk-${label}.example`;
  const myshopify = `bulk-${label}.myshopify.com`;
  const intent = {
    originalShopType: "Eyewear brands",
    shopType: "eyewear",
    businessQualifier: "brand",
    categoryVocabulary: ["eyewear"]
  };
  const identityEvidence = {
    stableHostname: myshopify,
    displayHostname: hostname,
    observedHostnames: [hostname, myshopify],
    canonical: {
      url: `https://${hostname}/`,
      hostname,
      trusted: true,
      reason: "canonical_matches_observed_host"
    },
    method: "observed_myshopify_host",
    confidence: 100,
    mergedOccurrenceCount: 1
  };
  const candidate = {
    ...intent,
    categoryIntent: intent,
    categoryIntents: [intent],
    query: "site:myshopify.com eyewear",
    rank: index + 1,
    url: `https://${hostname}/`,
    queryScore: 90,
    queryGenerationReason: "bulk fixture",
    querySourceUrls: [],
    finalUrl: `https://${hostname}/`,
    canonicalUrl: `https://${hostname}/`,
    myshopifyDomain: myshopify,
    resolvedDomain: hostname,
    stableIdentity: myshopify,
    allowedHostnames: [hostname, myshopify],
    identityConfidence: 100,
    identityEvidence,
    occurrences: [{
      categoryIntent: intent,
      originalShopType: intent.originalShopType,
      shopType: intent.shopType,
      businessQualifier: intent.businessQualifier,
      query: "site:myshopify.com eyewear",
      queryScore: 90,
      queryGenerationReason: "bulk fixture",
      querySourceUrls: [],
      categoryVocabulary: intent.categoryVocabulary,
      rank: index + 1,
      resultUrl: `https://${hostname}/`,
      finalUrl: `https://${hostname}/`,
      resolvedDomain: hostname,
      myshopifyDomain: myshopify
    }],
    duplicateCount: 0
  };
  return {
    identity: stableShopIdentity(candidate),
    candidatePayload: runStoreCandidateFromDiscovery(candidate, [])
  };
}

function reusableProfile(store, index) {
  const hostname = store.candidatePayload.resolvedDomain;
  return {
    contractVersion: "shop-lead-profile-v1",
    storeName: `Bulk ${index}`,
    email: `hello@${hostname}`,
    emailSourceUrl: `https://${hostname}/contact`,
    phone: "",
    phoneSourceUrl: "",
    contactUrl: `https://${hostname}/contact`,
    socialProfiles: [],
    contactabilityTier: "direct",
    contactEvidence: { emails: [{ value: `hello@${hostname}` }] },
    identityConfidence: 100,
    identityEvidence: store.candidatePayload.identityEvidence,
    categoryAssessments: [],
    pageDiagnostics: { pagesExamined: 1, pageErrorTypes: [], aiErrorType: "" }
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

for (const size of [1, 40, 100]) {
  test(`store checkpoint uses a bounded database operation count for ${size} rows`, async () => {
    const calls = [];
    let storedRunStores = [];
    const transaction = {
      run: {
        updateMany: async ({ data }) => {
          calls.push("run.updateMany");
          assert.equal(data.stage, "stores_persisted");
          return { count: 1 };
        }
      },
      shop: {
        findMany: async () => {
          calls.push("shop.findMany");
          return [];
        }
      },
      runStore: {
        findMany: async () => {
          calls.push("runStore.findMany");
          return storedRunStores;
        },
        createMany: async ({ data }) => {
          calls.push("runStore.createMany");
          storedRunStores = data.map((row) => ({ ...row }));
          return { count: data.length };
        }
      },
      $queryRaw: async (_strings, ...values) => {
        const encoded = values.find((value) => typeof value === "string" && value.startsWith("["));
        if (!encoded) {
          calls.push("$queryRaw:schema");
          return [];
        }
        calls.push("$queryRaw:shops");
        return JSON.parse(encoded).map((row) => ({ ...row, createdAt: NOW, updatedAt: NOW }));
      }
    };
    const repository = new PrismaRunRepository({
      $transaction: async (callback) => callback(transaction)
    });
    const rows = await repository.saveDiscoveredStores(
      "run_abcdefghijklmnop",
      LEASE,
      Array.from({ length: size }, (_, index) => discoveredStore(index)),
      [],
      null,
      NOW
    );
    assert.equal(rows.length, size);
    assert.deepEqual(calls, [
      "$queryRaw:schema",
      "run.updateMany",
      "shop.findMany",
      "$queryRaw:shops",
      "runStore.findMany",
      "runStore.createMany",
      "runStore.findMany"
    ]);
  });
}

test("store checkpoint rejects oversized and duplicate batches before opening a transaction", async () => {
  let transactions = 0;
  const repository = new PrismaRunRepository({
    $transaction: async () => { transactions += 1; }
  });
  await assert.rejects(
    repository.saveDiscoveredStores(
      "run_abcdefghijklmnop",
      LEASE,
      Array.from({ length: 501 }, (_, index) => discoveredStore(index)),
      [],
      null,
      NOW
    ),
    /500-row limit/u
  );
  const repeated = discoveredStore(0);
  await assert.rejects(
    repository.saveDiscoveredStores(
      "run_abcdefghijklmnop", LEASE, [repeated, repeated], [], null, NOW
    ),
    /contain duplicates/u
  );
  assert.equal(transactions, 0);
});

test("zero-row lifecycle barriers advance truthfully without row-level writes", async () => {
  const storeCalls = [];
  const storeRepository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      $queryRaw: async () => { storeCalls.push("schema"); return []; },
      run: {
        updateMany: async ({ data }) => {
          storeCalls.push("run");
          assert.equal(data.stage, "stores_persisted");
          return { count: 1 };
        }
      }
    })
  });
  assert.deepEqual(await storeRepository.saveDiscoveredStores(
    "run_abcdefghijklmnop", LEASE, [], [], null, NOW
  ), []);
  assert.deepEqual(storeCalls, ["schema", "run"]);

  const leadCalls = [];
  const leadRepository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      $queryRaw: async () => { leadCalls.push("schema"); return []; },
      run: {
        findUnique: async () => {
          leadCalls.push("run.snapshot");
          return { trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({}) };
        },
        updateMany: async ({ data }) => {
          leadCalls.push(data.stage === "leads_persisted" ? "run.publish" : "run.fence");
          return { count: 1 };
        }
      },
      runStore: { count: async () => { leadCalls.push("runStore.count"); return 0; } },
      lead: {
        findMany: async () => { leadCalls.push("lead.summary"); return []; }
      }
    })
  });
  assert.deepEqual(await leadRepository.saveLeadBatch(
    "run_abcdefghijklmnop", LEASE, [], null, NOW
  ), { total: 0, qualified: 0, rejected: 0, failed: 0 });
  assert.deepEqual(leadCalls, [
    "schema", "run.fence", "runStore.count", "lead.summary", "run.snapshot", "run.publish"
  ]);

  let claimTransactionStarted = false;
  const claimRepository = new PrismaRunRepository({
    $transaction: async () => { claimTransactionStarted = true; }
  });
  assert.deepEqual(await claimRepository.claimShopWorkBatch(
    "run_abcdefghijklmnop", LEASE, [], NOW
  ), []);
  assert.equal(claimTransactionStarted, false);
});

test("DataForSEO scoring keeps lead checkpoints private until v3 finalization", async () => {
  let publication;
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      $queryRaw: async () => [],
      run: {
        findUnique: async () => ({
          trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({
            dataForSeoEnrichmentEnabled: true
          })
        }),
        updateMany: async ({ data }) => {
          if (data.stage === "leads_persisted") publication = data;
          return { count: 1 };
        }
      },
      runStore: { count: async () => 0 },
      lead: { findMany: async () => [] }
    })
  });
  await repository.saveLeadBatch("run_abcdefghijklmnop", LEASE, [], null, NOW);
  assert.equal(publication.resultsAvailable, false);
  assert.equal(publication.scoringVersion, 2);
});

test("progressive completion finalizes every lead to v3 before publication", async () => {
  const run = {
    trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({
      dataForSeoEnrichmentEnabled: true,
      cruxEnrichmentEnabled: false
    }),
    trafficEnrichmentSummary: null
  };
  const storedLead = {
    id: "lead_one",
    runId: "run_abcdefghijklmnop",
    status: "qualified",
    resolvedDomain: "fixture.example",
    finalUrl: "https://fixture.example/",
    identityConfidence: 100,
    shopifyConfidence: 100,
    relevanceScore: 100,
    email: "hello@fixture.example",
    phone: null,
    contactUrl: "https://fixture.example/contact",
    socialProfiles: [],
    pipelineVersion: 2,
    scoringVersion: 2,
    leadScore: 80,
    scoreBreakdown: {
      version: 2,
      components: {
        identity: 20,
        shopifyValidation: 25,
        categoryFit: 30,
        contactEvidence: 5
      },
      total: 80,
      semantics: "deterministic_evidence_rank_not_probability"
    }
  };
  const trafficRow = {
    leadId: "lead_one",
    source: "dataforseo",
    state: "partial",
    contractVersion: "dataforseo-traffic-v1",
    normalizedPayload: { records: [{
      contractVersion: "dataforseo-traffic-v1",
      target: "fixture.example",
      scope: "worldwide",
      languageScope: "all_available",
      metrics: {
        organic: { etv: 1000, count: 10 },
        paid: { etv: 0, count: 0 },
        featuredSnippet: { etv: 99999, count: 1 },
        localPack: { etv: 99999, count: 1 }
      },
      fetchedAt: "2026-08-04T00:00:00.000Z"
    }] }
  };
  let leadUpdate;
  let published;
  const transaction = {
    $queryRaw: async () => [],
    run: {
      findUnique: async () => run,
      updateMany: async ({ data }) => {
        if (data.state === "completed") published = data;
        return { count: 1 };
      }
    },
    runDiagnostic: {},
    lead: {
      findMany: async () => [storedLead],
      updateMany: async ({ data }) => { leadUpdate = data; return { count: 1 }; }
    },
    leadTrafficEnrichment: { findMany: async () => [trafficRow] }
  };
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback(transaction)
  });
  await repository.completeTrafficEnrichment(
    "run_abcdefghijklmnop",
    LEASE,
    { version: "traffic-enrichment-summary-v1" },
    [],
    null,
    NOW
  );
  assert.equal(leadUpdate.scoringVersion, 3);
  assert.equal(leadUpdate.leadScore, 75);
  assert.equal(leadUpdate.scoreBreakdown.components.traffic, 24);
  assert.equal(published.resultsAvailable, true);
  assert.equal(published.scoringVersion, 3);
});

test("a progressive v3 score write failure prevents the publication update", async () => {
  const run = {
    trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({
      dataForSeoEnrichmentEnabled: true
    }),
    trafficEnrichmentSummary: null
  };
  let publicationAttempted = false;
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      $queryRaw: async () => [],
      run: {
        findUnique: async () => run,
        updateMany: async ({ data }) => {
          if (data.state === "completed") publicationAttempted = true;
          return { count: 1 };
        }
      },
      lead: {
        findMany: async () => [{
          id: "lead_one",
          runId: "run_abcdefghijklmnop",
          status: "qualified",
          resolvedDomain: "fixture.example",
          finalUrl: "https://fixture.example/",
          socialProfiles: [],
          pipelineVersion: 2,
          scoringVersion: 2,
          leadScore: 80,
          scoreBreakdown: {
            version: 2,
            components: {
              identity: 20,
              shopifyValidation: 25,
              categoryFit: 30,
              contactEvidence: 5
            },
            total: 80,
            semantics: "deterministic_evidence_rank_not_probability"
          }
        }],
        updateMany: async () => { throw new Error("injected score write failure"); }
      },
      leadTrafficEnrichment: { findMany: async () => [] }
    })
  });
  await assert.rejects(
    repository.completeTrafficEnrichment(
      "run_abcdefghijklmnop",
      LEASE,
      { version: "traffic-enrichment-summary-v1" },
      [],
      null,
      NOW
    ),
    /injected score write failure/u
  );
  assert.equal(publicationAttempted, false);
});

for (const size of [1, 40, 100]) {
  test(`lead barrier uses a bounded database operation count for ${size} rows`, async () => {
    const calls = [];
    const runIdentifier = "run_abcdefghijklmnop";
    const stores = Array.from({ length: size }, (_, index) => discoveredStore(index));
    const runStores = stores.map((store) => {
      const shopId = shopIdForStableKey(store.identity.stableKey);
      return {
        id: runStoreId(runIdentifier, shopId),
        runId: runIdentifier,
        shopId,
        state: "processing",
        candidatePayload: store.candidatePayload,
        shop: { id: shopId, stableKey: store.identity.stableKey }
      };
    });
    let createdLeads = [];
    const transaction = {
      $queryRaw: async () => { calls.push("$queryRaw:schema"); return []; },
      run: {
        findUnique: async () => {
          calls.push("run.findUnique");
          return { trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({}) };
        },
        updateMany: async () => { calls.push("run.updateMany"); return { count: 1 }; }
      },
      runStore: {
        findMany: async () => { calls.push("runStore.findMany"); return runStores; },
        updateMany: async ({ where }) => {
          calls.push("runStore.updateMany");
          return { count: where.id.in.length };
        },
        count: async () => { calls.push("runStore.count"); return 0; }
      },
      shopLeadProfile: {
        findMany: async () => {
          calls.push("shopLeadProfile.findMany");
          return stores.map((store, index) => ({
            shopId: runStores[index].shopId,
            state: "completed",
            profilePayload: reusableProfile(store, index)
          }));
        }
      },
      lead: {
        findMany: async ({ select }) => {
          calls.push(select ? "lead.findMany:summary" : "lead.findMany:existing");
          return select ? createdLeads.map(({ status }) => ({ status })) : [];
        },
        createMany: async ({ data }) => {
          calls.push("lead.createMany");
          createdLeads = data;
          return { count: data.length };
        }
      }
    };
    const repository = new PrismaRunRepository({
      $transaction: async (callback) => callback(transaction)
    });
    const summary = await repository.saveLeadBatch(
      runIdentifier,
      LEASE,
      stores.map((store, index) => ({
        runStoreId: runStores[index].id,
        state: "completed",
        lead: qualifiedLead(store.identity.stableKey),
        profileReusable: true
      })),
      null,
      NOW
    );
    assert.deepEqual(summary, { total: size, qualified: size, rejected: 0, failed: 0 });
    assert.equal(createdLeads.length, size);
    assert.deepEqual(calls, [
      "$queryRaw:schema",
      "run.updateMany",
      "runStore.findMany",
      "shopLeadProfile.findMany",
      "lead.findMany:existing",
      "lead.createMany",
      "$queryRaw:schema",
      "runStore.updateMany",
      "runStore.count",
      "lead.findMany:summary",
      "run.findUnique",
      "run.updateMany"
    ]);
  });
}

for (const size of [1, 40, 100]) {
  test(`shop work claim uses a bounded database operation count for ${size} rows`, async () => {
    const calls = [];
    let workRows = [];
    const transaction = {
      $queryRaw: async (_strings, ...values) => {
        const encoded = values.find((value) => typeof value === "string" && value.startsWith("["));
        if (!encoded) {
          calls.push("schema.select");
          return [];
        }
        calls.push("work.bulkClaim");
        const claimed = JSON.parse(encoded);
        const won = new Set(claimed.map(({ id }) => id));
        workRows = workRows.map((row) => won.has(row.id)
          ? {
              ...row,
              state: "processing",
              processingRunId: "run_abcdefghijklmnop",
              processingLeaseToken: LEASE.token
            }
          : row);
        return claimed.map(({ id, shopId, workType, scopeKey }) => ({
          id, shopId, workType, scopeKey
        }));
      },
      run: { updateMany: async () => { calls.push("run.updateMany"); return { count: 1 }; } },
      shopWork: {
        createMany: async ({ data }) => {
          calls.push("shopWork.createMany");
          workRows = data.map((row) => ({
            ...row,
            processingRunId: null,
            processingLeaseToken: null,
            processingRun: null
          }));
          return { count: data.length };
        },
        findMany: async ({ include }) => {
          calls.push(include ? "shopWork.findMany:current" : "shopWork.findMany:durable");
          return workRows;
        }
      }
    };
    const repository = new PrismaRunRepository({
      $transaction: async (callback) => callback(transaction)
    });
    const claims = Array.from({ length: size }, (_, index) => ({
      shopId: `shop_${String(index).padStart(24, "0")}`,
      workType: "dataforseo",
      scopeKey: "worldwide"
    }));
    const result = await repository.claimShopWorkBatch(
      "run_abcdefghijklmnop", LEASE, claims, NOW
    );
    assert.equal(result.length, size);
    assert.ok(result.every(({ outcome, networkAllowed }) =>
      outcome === "won" && networkAllowed
    ));
    assert.deepEqual(calls, [
      "schema.select",
      "run.updateMany",
      "shopWork.createMany",
      "shopWork.findMany:current",
      "work.bulkClaim",
      "shopWork.findMany:durable"
    ]);
  });
}

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
    targetCount: 1,
    scopeKey: "worldwide",
    state: "in_flight",
    leaseOwner: LEASE.owner,
    leaseToken: LEASE.token
  };
  const transaction = {
    $queryRaw: async (_strings, ...values) => {
      const encoded = values.find((value) => typeof value === "string" && value.startsWith("["));
      if (!encoded) {
        calls.push("schema.select");
        return [];
      }
      calls.push("cache.bulkUpsert");
      return JSON.parse(encoded).map((row) => ({
        source: row.source,
        identity: row.identity,
        scopeKey: row.scopeKey,
        metricSetKey: row.metricSetKey,
        contractVersion: row.contractVersion
      }));
    },
    run: { updateMany: async () => { calls.push("run.fence"); return { count: 1 }; } },
    dataForSeoRequestLedger: {
      updateMany: async ({ data }) => {
        calls.push("ledger.succeeded");
        ledger = { ...ledger, ...data };
        return { count: 1 };
      },
      findUnique: async () => ledger
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
  assert.deepEqual(calls, [
    "schema.select", "run.fence", "ledger.succeeded", "cache.bulkUpsert"
  ]);

  let cacheTouched = false;
  const stale = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      $queryRaw: async () => [],
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

test("paid success rejects ledger scope and count mismatches before mutation", async () => {
  const ledger = {
    requestFingerprint: "d".repeat(64),
    runId: "run_abcdefghijklmnop",
    targetCount: 2,
    scopeKey: "worldwide",
    state: "in_flight",
    leaseOwner: LEASE.owner,
    leaseToken: LEASE.token
  };
  let mutated = false;
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      $queryRaw: async () => [],
      run: { updateMany: async () => ({ count: 1 }) },
      dataForSeoRequestLedger: {
        findUnique: async () => ledger,
        updateMany: async () => { mutated = true; return { count: 1 }; }
      }
    })
  });
  const cacheRow = {
    source: "dataforseo",
    identity: "fixture.example",
    scopeKey: "worldwide",
    metricSetKey: "featured_snippet,local_pack,organic,paid",
    contractVersion: "dataforseo-traffic-v1",
    state: "available",
    normalizedPayload: dataForSeoValue(),
    fetchedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 86_400_000)
  };
  await assert.rejects(repository.markDataForSeoRequestSucceeded(
    ledger.runId,
    LEASE,
    ledger.requestFingerprint,
    {
      providerCostUsd: 0.012,
      cacheRows: [cacheRow],
      workClaims: [{
        shopId: "shop_000000000000000000000001",
        workType: "dataforseo",
        scopeKey: "worldwide"
      }]
    },
    NOW
  ), /count does not match/iu);
  await assert.rejects(repository.markDataForSeoRequestSucceeded(
    ledger.runId,
    LEASE,
    ledger.requestFingerprint,
    {
      providerCostUsd: 0.012,
      cacheRows: [{ ...cacheRow, scopeKey: "country:NZ:2554" }],
      workClaims: []
    },
    NOW
  ), /scope does not match/iu);
  assert.equal(mutated, false);
});

test("CrUX success rejects mismatched progressive cache and work batches", async () => {
  let transactionStarted = false;
  const repository = new PrismaRunRepository({
    $transaction: async () => { transactionStarted = true; }
  });
  const cacheRow = {
    source: "crux_rest",
    identity: "https://fixture.example",
    scopeKey: "current",
    metricSetKey: "cumulative_layout_shift,experimental_time_to_first_byte,first_contentful_paint,form_factors,interaction_to_next_paint,largest_contentful_paint",
    contractVersion: "crux-origin-metrics-v1",
    state: "no_coverage",
    fetchedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 86_400_000)
  };
  await assert.rejects(repository.saveCruxTrafficCache(
    "run_abcdefghijklmnop",
    LEASE,
    [cacheRow],
    [{
      shopId: "shop_000000000000000000000001",
      workType: "crux_bigquery",
      scopeKey: "month:202607"
    }],
    NOW
  ), /mismatched source or scope/iu);
  await assert.rejects(repository.saveCruxTrafficCache(
    "run_abcdefghijklmnop",
    LEASE,
    [cacheRow],
    [{
      shopId: "shop_000000000000000000000001",
      workType: "crux_rest",
      scopeKey: "current"
    }, {
      shopId: "shop_000000000000000000000002",
      workType: "crux_rest",
      scopeKey: "current"
    }],
    NOW
  ), /do not reconcile/iu);
  assert.equal(transactionStarted, false);
});

test("only stale in-flight paid work on an inactive lease becomes ambiguous", async () => {
  let update;
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      $queryRaw: async () => [],
      $executeRaw: async () => 1,
      dataForSeoRequestLedger: {
        findMany: async () => [{
          requestFingerprint: "e".repeat(64),
          runId: "run_abcdefghijklmnop",
          scopeKey: "worldwide"
        }],
        updateMany: async (arguments_) => { update = arguments_; return { count: 1 }; }
      }
    })
  });
  const recovered = await repository.markStaleDataForSeoRequestsAmbiguous(NOW);
  assert.deepEqual(recovered, { count: 1, workCount: 1 });
  assert.equal(update.where.state, "in_flight");
  assert.deepEqual(update.where.requestFingerprint.in, ["e".repeat(64)]);
  assert.deepEqual(update.where.run.OR, [
    { state: { not: "running" } },
    { leaseExpiresAt: { lte: NOW } },
    { leaseExpiresAt: null }
  ]);
  assert.equal(update.data.state, "ambiguous");
  assert.equal(update.data.safeErrorCode, "PAID_REQUEST_OUTCOME_AMBIGUOUS");
});

test("paid recovery reconciles processing work for an already ambiguous ledger", async () => {
  let workUpdates = 0;
  let ledgerUpdated = false;
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      $queryRaw: async () => [],
      $executeRaw: async () => { workUpdates += 1; return 2; },
      dataForSeoRequestLedger: {
        findMany: async () => [],
        updateMany: async () => { ledgerUpdated = true; return { count: 0 }; }
      }
    })
  });
  assert.deepEqual(
    await repository.markStaleDataForSeoRequestsAmbiguous(NOW),
    { count: 0, workCount: 2 }
  );
  assert.equal(ledgerUpdated, false);
  assert.equal(workUpdates, 1);
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

test("repository result summaries apply non-status facets and retain every status count", async () => {
  let arguments_;
  const repository = new PrismaRunRepository({
    lead: {
      groupBy: async (value) => {
        arguments_ = value;
        return [
          { status: "qualified", _count: { _all: 4 } },
          { status: "rejected", _count: { _all: 2 } }
        ];
      }
    }
  });
  const summary = await repository.getResultSummary("run_abcdefghijklmnop", "user_alice", {
    status: "qualified",
    search: "optics",
    discoveryQueries: ["premium optics"]
  });
  assert.deepEqual(summary, { total: 6, qualified: 4, rejected: 2, failed: 0 });
  assert.equal(arguments_.where.status, undefined);
  assert.equal(arguments_.where.OR.length, 5);
  assert.deepEqual(arguments_.where.AND[0].OR, [
    { generatedQuery: { in: ["premium optics"] } },
    { searchQuery: { in: ["premium optics"] } }
  ]);
});

test("master leads exclude provisional leads from unfinished runs", async () => {
  let query;
  const repository = new PrismaRunRepository({
    $transaction: async (operations) => Promise.all(operations),
    userShop: {
      count: async () => 0,
      findMany: async (value) => { query = value; return []; }
    },
    trafficEnrichmentCache: { findMany: async () => [] }
  });
  await repository.getMasterLeadsPage("owner_fixture", {
    page: 1,
    pageSize: 20,
    search: "fixture",
    sortBy: "last_discovered",
    sortDirection: "desc",
    archived: false
  });
  assert.deepEqual(query.include.shop.include.leads.where, {
    run: {
      ownerId: "owner_fixture",
      state: "completed",
      resultsAvailable: true
    }
  });
  assert.deepEqual(
    query.where.OR.at(-1).shop.leads.some.run,
    { ownerId: "owner_fixture", state: "completed", resultsAvailable: true }
  );
});

test("result traffic reads are restricted to the requested page lead IDs", async () => {
  let arguments_;
  const repository = new PrismaRunRepository({
    leadTrafficEnrichment: {
      findMany: async (value) => { arguments_ = value; return []; }
    }
  });
  await repository.getTrafficEnrichmentsForLeadIds(
    "run_abcdefghijklmnop",
    "user_alice",
    ["lead_one", "lead_two"]
  );
  assert.deepEqual(arguments_.where, {
    runId: "run_abcdefghijklmnop",
    leadId: { in: ["lead_one", "lead_two"] },
    lead: { run: { ownerId: "user_alice" } }
  });
  assert.deepEqual(arguments_.orderBy, [{ leadId: "asc" }, { source: "asc" }]);
});

test("traffic overview reads only identities and owned normalized traffic rows", async () => {
  let arguments_;
  const repository = new PrismaRunRepository({
    lead: {
      findMany: async (value) => { arguments_ = value; return []; }
    }
  });
  await repository.getTrafficOverviewRows(
    "run_abcdefghijklmnop",
    "user_alice",
    { search: "fashion", discoveryQueries: ["premium optics"] }
  );
  assert.equal(arguments_.where.runId, "run_abcdefghijklmnop");
  assert.equal(arguments_.where.run.ownerId, "user_alice");
  assert.equal(arguments_.where.OR.length, 5);
  assert.deepEqual(arguments_.where.AND[0].OR, [
    { generatedQuery: { in: ["premium optics"] } },
    { searchQuery: { in: ["premium optics"] } }
  ]);
  assert.deepEqual(arguments_.select, {
    id: true,
    generatedQuery: true,
    searchQuery: true,
    trafficEnrichments: { orderBy: { source: "asc" } }
  });
  assert.deepEqual(arguments_.orderBy, { id: "asc" });
});

test("restart recovery requeues progressive checkpoints and fails only legacy work", async () => {
  const updates = [];
  const repository = new PrismaRunRepository({
    $transaction: async (callback) => callback({
      run: {
        updateMany: async (arguments_) => {
          updates.push(arguments_);
          return { count: 1 };
        }
      }
    })
  });

  const recovered = await repository.recoverExpiredRuns(NOW);
  assert.equal(recovered.count, 2);
  assert.equal(updates[0].where.state, "running");
  assert.deepEqual(updates[0].where.OR, [
    { leaseExpiresAt: { lte: NOW } },
    { leaseExpiresAt: null }
  ]);
  assert.deepEqual(updates[0].where.stage.in, [
    "stores_persisted", "discovering_leads", "leads_persisted", "enriching_traffic"
  ]);
  assert.equal(updates[0].data.state, "queued");
  assert.equal(updates[1].data.state, "failed");
  assert.equal(updates[1].data.safeErrorCode, "RUN_LEASE_EXPIRED");
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

test("DP migration preserves rows and replaces only the obsolete global worker slot", async () => {
  const sql = await fs.readFile(new URL(
    "../prisma/migrations/20260803120000_progressive_shop_persistence/migration.sql",
    import.meta.url
  ), "utf8");
  assert.match(sql, /DROP INDEX "Run_one_running_idx"/u);
  assert.match(sql, /CREATE TABLE "Shop"/u);
  assert.match(sql, /CREATE TABLE "RunStore"/u);
  assert.match(sql, /CREATE TABLE "ShopLeadProfile"/u);
  assert.match(sql, /CREATE TABLE "ShopWork"/u);
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|UPDATE "(?:Run|Lead)")\b/iu);
});
