import assert from "node:assert/strict";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { failedLeadForRunStore, materializeLeadFromProfile } from "../src/pipeline.js";
import { PrismaRunRepository, stableLeadId } from "../src/prisma-run-repository.js";
import {
  runStoreCandidateFromDiscovery,
  stableShopIdentity
} from "../src/shop-persistence-contract.js";
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" &&
  Boolean(process.env.TEST_DATABASE_URL);

function fixture() {
  const intent = {
    originalShopType: "Eyewear brands",
    shopType: "eyewear",
    businessQualifier: "brand",
    categoryVocabulary: ["eyewear"]
  };
  const identityEvidence = {
    stableHostname: "progressive.myshopify.com",
    displayHostname: "progressive.example",
    observedHostnames: ["progressive.example", "progressive.myshopify.com"],
    canonical: {
      url: "https://progressive.example/",
      hostname: "progressive.example",
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
    rank: 1,
    url: "https://progressive.example/",
    queryScore: 90,
    queryGenerationReason: "fixture",
    querySourceUrls: [],
    finalUrl: "https://progressive.example/",
    canonicalUrl: "https://progressive.example/",
    myshopifyDomain: "progressive.myshopify.com",
    resolvedDomain: "progressive.example",
    stableIdentity: "progressive.myshopify.com",
    allowedHostnames: ["progressive.example", "progressive.myshopify.com"],
    identityConfidence: 100,
    identityEvidence,
    occurrences: [{
      categoryIntent: {
        originalShopType: intent.originalShopType,
        shopType: intent.shopType,
        businessQualifier: intent.businessQualifier
      },
      originalShopType: intent.originalShopType,
      shopType: intent.shopType,
      businessQualifier: intent.businessQualifier,
      query: "site:myshopify.com eyewear",
      queryScore: 90,
      queryGenerationReason: "fixture",
      querySourceUrls: [],
      categoryVocabulary: ["eyewear"],
      rank: 1,
      resultUrl: "https://progressive.example/",
      finalUrl: "https://progressive.example/",
      resolvedDomain: "progressive.example",
      myshopifyDomain: "progressive.myshopify.com"
    }],
    duplicateCount: 0
  };
  const assessment = {
    intent,
    valid: true,
    accepted: true,
    shopifyConfidence: 100,
    relevanceScore: 90,
    rejectionReason: "",
    storeFit: { state: "specialist", reason: "fixture" }
  };
  const candidatePayload = runStoreCandidateFromDiscovery(candidate, [assessment]);
  const profile = {
    contractVersion: "shop-lead-profile-v1",
    storeName: "Progressive Fixture",
    email: "hello@progressive.example",
    emailSourceUrl: "https://progressive.example/contact",
    phone: "",
    phoneSourceUrl: "",
    contactUrl: "https://progressive.example/contact",
    socialProfiles: [],
    contactabilityTier: "direct",
    contactEvidence: { emails: [{ value: "hello@progressive.example" }] },
    identityConfidence: 100,
    identityEvidence,
    categoryAssessments: [{
      intent,
      shopifyConfidence: 100,
      relevanceScore: 90,
      storeFitState: "specialist",
      storeFitEvidence: { state: "specialist", reason: "fixture" },
      accepted: true
    }],
    pageDiagnostics: { pagesExamined: 2, pageErrorTypes: [], aiErrorType: "" }
  };
  return {
    identity: stableShopIdentity(candidate),
    candidatePayload,
    profile,
    lead: materializeLeadFromProfile(candidatePayload, profile)
  };
}

function bulkStoreFixture(index) {
  const label = String(index).padStart(3, "0");
  const hostname = `bulk-${label}.example`;
  const myshopifyDomain = `bulk-${label}.myshopify.com`;
  const intent = {
    originalShopType: "Eyewear brands",
    shopType: "eyewear",
    businessQualifier: "brand",
    categoryVocabulary: ["eyewear"]
  };
  const identityEvidence = {
    stableHostname: myshopifyDomain,
    displayHostname: hostname,
    observedHostnames: [hostname, myshopifyDomain],
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
    myshopifyDomain,
    resolvedDomain: hostname,
    stableIdentity: myshopifyDomain,
    allowedHostnames: [hostname, myshopifyDomain],
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
      myshopifyDomain
    }],
    duplicateCount: 0
  };
  return {
    identity: stableShopIdentity(candidate),
    candidatePayload: runStoreCandidateFromDiscovery(candidate, [{
      intent,
      valid: true,
      accepted: true,
      shopifyConfidence: 100,
      relevanceScore: 90,
      rejectionReason: "",
      storeFit: { state: "specialist", reason: "bulk fixture" }
    }])
  };
}

function bulkProfile(candidatePayload, index) {
  const hostname = candidatePayload.resolvedDomain;
  return {
    contractVersion: "shop-lead-profile-v1",
    storeName: `Bulk Fixture ${index}`,
    email: `hello@${hostname}`,
    emailSourceUrl: `https://${hostname}/contact`,
    phone: "",
    phoneSourceUrl: "",
    contactUrl: `https://${hostname}/contact`,
    socialProfiles: [],
    contactabilityTier: "direct",
    contactEvidence: { emails: [{ value: `hello@${hostname}` }] },
    identityConfidence: candidatePayload.identityConfidence,
    identityEvidence: candidatePayload.identityEvidence,
    categoryAssessments: candidatePayload.assessments.map(({ intent }) => ({
      intent,
      shopifyConfidence: 100,
      relevanceScore: 90,
      storeFitState: "specialist",
      storeFitEvidence: { state: "specialist", reason: "bulk fixture" },
      accepted: true
    })),
    pageDiagnostics: { pagesExamined: 1, pageErrorTypes: [], aiErrorType: "" }
  };
}

function bulkDataForSeoValue(target, fetchedAt) {
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
    fetchedAt: fetchedAt.toISOString()
  };
}

test(
  "progressive checkpoints deduplicate shops and claims while preserving leads after traffic failure",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const schema = `progressive_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    deployPrismaMigrations(scopedUrl);
    const prisma = createPrismaClient(scopedUrl);
    await assertMigrationStayedInSchema(prisma, schema);
    const repository = new PrismaRunRepository(prisma);
    try {
      const first = await repository.createRun("owner_a", [{ shopType: "eyewear" }]);
      const second = await repository.createRun("owner_b", [{ shopType: "eyewear" }]);
      const expiresAt = new Date(Date.now() + 600_000);
      const firstClaim = {
        run: first,
        lease: { owner: "worker_a", token: "lease_progressive_a", expiresAt }
      };
      const secondClaim = {
        run: second,
        lease: { owner: "worker_b", token: "lease_progressive_b", expiresAt }
      };
      await prisma.run.update({
        where: { id: first.id },
        data: {
          state: "running",
          phase: "scraping",
          leaseOwner: firstClaim.lease.owner,
          leaseToken: firstClaim.lease.token,
          leaseExpiresAt: expiresAt
        }
      });
      const store = fixture();
      const firstStores = await repository.saveDiscoveredStores(
        first.id,
        firstClaim.lease,
        [store],
        [],
        null
      );
      assert.equal(await prisma.shop.count(), 1);

      const shopId = firstStores[0].shopId;
      const workClaims = await Promise.all([
        repository.claimShopWork(
          first.id, firstClaim.lease, shopId, "lead_discovery", "current"
        ),
        repository.claimShopWork(
          first.id, firstClaim.lease, shopId, "lead_discovery", "current"
        )
      ]);
      assert.equal(workClaims.filter(({ networkAllowed }) => networkAllowed).length, 1);
      const winnerStore = await repository.claimRunStore(
        first.id, firstClaim.lease, firstStores[0].id
      );
      const discoveredLead = await repository.saveDiscoveredLead(
        first.id,
        firstClaim.lease,
        winnerStore.runStore.id,
        { profile: store.profile, lead: store.lead }
      );
      const discoveredReplay = await repository.saveDiscoveredLead(
        first.id,
        firstClaim.lease,
        winnerStore.runStore.id,
        { profile: store.profile, lead: store.lead }
      );
      assert.equal(discoveredReplay.id, discoveredLead.id);
      const firstGrant = await prisma.userShop.findUnique({
        where: { userId_shopId: { userId: "owner_a", shopId } }
      });
      assert.equal(firstGrant?.firstDiscoveredRunId, first.id);
      assert.equal(firstGrant?.lastDiscoveredRunId, first.id);
      assert.deepEqual(await prisma.userShopDiscovery.findMany({
        where: { userShopId: firstGrant.id },
        select: { runId: true, leadId: true }
      }), [{ runId: first.id, leadId: discoveredLead.id }]);
      const firstSummary = await repository.completeLeadDiscovery(first.id, firstClaim.lease);
      assert.equal(firstSummary.qualified, 1);
      await repository.completeTrafficEnrichment(
        first.id,
        firstClaim.lease,
        {
          version: "traffic-enrichment-summary-v1",
          state: "failed",
          safeErrorCode: "TRAFFIC_ENRICHMENT_FAILED"
        },
        [{ scope: "run", code: "traffic_enrichment_failed", details: { errorType: "Error" } }]
      );
      const completed = await prisma.run.findUnique({ where: { id: first.id } });
      assert.equal(completed.state, "completed");
      assert.equal(completed.resultsAvailable, true);
      assert.equal(await prisma.lead.count({ where: { runId: first.id } }), 1);

      await prisma.run.update({
        where: { id: second.id },
        data: {
          state: "running",
          phase: "scraping",
          leaseOwner: secondClaim.lease.owner,
          leaseToken: secondClaim.lease.token,
          leaseExpiresAt: expiresAt
        }
      });
      const secondStores = await repository.saveDiscoveredStores(
        second.id,
        secondClaim.lease,
        [store],
        [],
        null
      );
      assert.equal(firstStores[0].shopId, secondStores[0].shopId);
      assert.equal(await prisma.shop.count(), 1);
      assert.equal(await prisma.runStore.count(), 2);
      const reusable = await repository.readReusableShopLeadProfile(
        second.id, secondClaim.lease, shopId
      );
      const reusedStore = await repository.claimRunStore(
        second.id, secondClaim.lease, secondStores[0].id
      );
      const reusedLead = await repository.saveReusedLead(
        second.id,
        secondClaim.lease,
        reusedStore.runStore.id,
        materializeLeadFromProfile(store.candidatePayload, reusable.profilePayload)
      );
      const reusedReplay = await repository.saveReusedLead(
        second.id,
        secondClaim.lease,
        reusedStore.runStore.id,
        materializeLeadFromProfile(store.candidatePayload, reusable.profilePayload)
      );
      assert.equal(reusedReplay.id, reusedLead.id);
      const secondSummary = await repository.completeLeadDiscovery(second.id, secondClaim.lease);
      assert.equal(secondSummary.qualified, 1);
      assert.equal(await prisma.lead.count(), 2);
      assert.equal(await prisma.shopLeadProfile.count(), 1);

      const third = await repository.createRun("owner_c", [{ shopType: "eyewear" }]);
      const fourth = await repository.createRun("owner_d", [{ shopType: "eyewear" }]);
      const concurrentLeases = [
        { owner: "worker_c", token: "lease_progressive_c", expiresAt },
        { owner: "worker_d", token: "lease_progressive_d", expiresAt }
      ];
      await Promise.all([third, fourth].map((run, index) => prisma.run.update({
        where: { id: run.id },
        data: {
          state: "running",
          phase: "scraping",
          leaseOwner: concurrentLeases[index].owner,
          leaseToken: concurrentLeases[index].token,
          leaseExpiresAt: expiresAt
        }
      })));
      const thirdStores = await repository.saveDiscoveredStores(
        third.id,
        concurrentLeases[0],
        [store],
        [],
        null
      );
      const failedStore = await repository.claimRunStore(
        third.id,
        concurrentLeases[0],
        thirdStores[0].id
      );
      const failedLead = failedLeadForRunStore(
        store.candidatePayload,
        new Error("fixture lead failure")
      );
      const persistedFailedLead = await repository.saveFailedLead(
        third.id,
        concurrentLeases[0],
        failedStore.runStore.id,
        failedLead,
        {
          scope: "store",
          code: "lead_discovery_failed",
          result_url: store.candidatePayload.representative.resultUrl,
          details: { errorType: "Error", shopId }
        }
      );
      assert.equal(persistedFailedLead.id, stableLeadId(third.id, failedLead, 0));
      assert.equal((await prisma.runStore.findUnique({
        where: { id: failedStore.runStore.id }
      }))?.state, "failed");

      assert.deepEqual(await prisma.userShop.findMany({
        where: { shopId },
        orderBy: { userId: "asc" },
        select: {
          userId: true,
          firstDiscoveredRunId: true,
          lastDiscoveredRunId: true
        }
      }), [
        {
          userId: "owner_a",
          firstDiscoveredRunId: first.id,
          lastDiscoveredRunId: first.id
        },
        {
          userId: "owner_b",
          firstDiscoveredRunId: second.id,
          lastDiscoveredRunId: second.id
        },
        {
          userId: "owner_c",
          firstDiscoveredRunId: third.id,
          lastDiscoveredRunId: third.id
        }
      ]);
      const ownerDiscoveries = await prisma.userShopDiscovery.findMany({
        where: { runId: { in: [first.id, second.id, third.id] } },
        select: {
          runId: true,
          leadId: true,
          userShop: { select: { userId: true } }
        }
      });
      assert.deepEqual(ownerDiscoveries.sort((left, right) =>
        left.userShop.userId.localeCompare(right.userShop.userId)), [
        { runId: first.id, leadId: discoveredLead.id, userShop: { userId: "owner_a" } },
        { runId: second.id, leadId: reusedLead.id, userShop: { userId: "owner_b" } },
        { runId: third.id, leadId: persistedFailedLead.id, userShop: { userId: "owner_c" } }
      ]);
      const competingTrafficClaims = await Promise.all([third, fourth].map(
        (run, index) => repository.claimShopWork(
          run.id,
          concurrentLeases[index],
          shopId,
          "crux_rest",
          "current"
        )
      ));
      assert.equal(
        competingTrafficClaims.filter(({ networkAllowed }) => networkAllowed).length,
        1
      );
    } finally {
      await prisma.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  }
);

test(
  "100-store checkpoints stay within the default transaction timeout and concurrent batches converge",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const schema = `bulk_store_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    deployPrismaMigrations(scopedUrl);
    const prisma = createPrismaClient(scopedUrl);
    await assertMigrationStayedInSchema(prisma, schema);
    const repository = new PrismaRunRepository(prisma);
    try {
      const runs = await Promise.all([
        repository.createRun("owner_bulk_a", [{ shopType: "eyewear" }]),
        repository.createRun("owner_bulk_b", [{ shopType: "eyewear" }])
      ]);
      const expiresAt = new Date(Date.now() + 600_000);
      const leases = [
        { owner: "worker_bulk_a", token: "lease_bulk_store_a", expiresAt },
        { owner: "worker_bulk_b", token: "lease_bulk_store_b", expiresAt }
      ];
      await Promise.all(runs.map((run, index) => prisma.run.update({
        where: { id: run.id },
        data: {
          state: "running",
          phase: "scraping",
          leaseOwner: leases[index].owner,
          leaseToken: leases[index].token,
          leaseExpiresAt: expiresAt
        }
      })));
      const stores = Array.from({ length: 100 }, (_, index) => bulkStoreFixture(index));
      const startedAt = performance.now();
      const checkpoints = await Promise.all(runs.map((run, index) =>
        repository.saveDiscoveredStores(run.id, leases[index], stores, [], null)
      ));
      const durationMs = performance.now() - startedAt;
      assert.deepEqual(checkpoints.map(({ length }) => length), [100, 100]);
      assert.equal(await prisma.shop.count(), 100);
      assert.equal(await prisma.runStore.count(), 200);
      assert.ok(durationMs < 10_000, `concurrent store checkpoints took ${durationMs}ms`);
      assert.equal((await repository.saveDiscoveredStores(
        runs[0].id, leases[0], stores, [], null
      )).length, 100);
      const conflictingStore = {
        ...stores[0],
        candidatePayload: {
          ...stores[0].candidatePayload,
          duplicateCount: stores[0].candidatePayload.duplicateCount + 1
        }
      };
      await assert.rejects(
        repository.saveDiscoveredStores(runs[0].id, leases[0], [conflictingStore], [], null),
        /conflicting run-store replay/iu
      );

      const firstRunStores = checkpoints[0];
      const profiles = firstRunStores.map((row, index) => ({
        shopId: row.shopId,
        state: "completed",
        profilePayload: bulkProfile(row.candidatePayload, index),
        processingRunId: null
      }));
      await prisma.shopLeadProfile.createMany({ data: profiles });
      await prisma.runStore.updateMany({
        where: { runId: runs[0].id },
        data: { state: "processing" }
      });
      const outcomes = firstRunStores.map((row, index) => ({
        runStoreId: row.id,
        state: "completed",
        lead: materializeLeadFromProfile(row.candidatePayload, profiles[index].profilePayload),
        profileReusable: true
      }));
      const leadStartedAt = performance.now();
      const summary = await repository.saveLeadBatch(
        runs[0].id, leases[0], outcomes, null
      );
      const leadDurationMs = performance.now() - leadStartedAt;
      assert.deepEqual(summary, { total: 100, qualified: 100, rejected: 0, failed: 0 });
      assert.equal(await prisma.lead.count({ where: { runId: runs[0].id } }), 100);
      assert.equal(await prisma.runStore.count({
        where: { runId: runs[0].id, state: "completed" }
      }), 100);
      assert.equal((await prisma.run.findUnique({ where: { id: runs[0].id } })).resultsAvailable, true);
      assert.ok(leadDurationMs < 10_000, `100-lead checkpoint took ${leadDurationMs}ms`);
      assert.deepEqual(
        await repository.saveLeadBatch(runs[0].id, leases[0], outcomes, null),
        summary
      );
      const conflicting = outcomes.map((outcome, index) => index === 0
        ? { ...outcome, lead: { ...outcome.lead, email: "changed@bulk-000.example" } }
        : outcome);
      await assert.rejects(
        repository.saveLeadBatch(runs[0].id, leases[0], conflicting, null),
        /conflicting lead batch replay/iu
      );
      assert.equal(
        (await prisma.lead.findUnique({
          where: {
            runId_shopId: { runId: runs[0].id, shopId: firstRunStores[0].shopId }
          }
        }))?.email,
        outcomes[0].lead.email
      );

      const trafficNow = new Date(expiresAt.getTime() - 300_000);
      const nzClaims = firstRunStores.map(({ shopId }) => ({
        shopId,
        workType: "dataforseo",
        scopeKey: "country:NZ:2554"
      }));
      const competingClaims = await Promise.all([
        repository.claimShopWorkBatch(runs[0].id, leases[0], nzClaims, trafficNow),
        repository.claimShopWorkBatch(runs[1].id, leases[1], nzClaims, trafficNow)
      ]);
      assert.equal(
        competingClaims.flat().filter(({ networkAllowed }) => networkAllowed).length,
        100
      );
      for (const [index, result] of competingClaims.entries()) {
        const wonClaims = nzClaims.filter((_, claimIndex) => result[claimIndex].networkAllowed);
        if (wonClaims.length) {
          await repository.finishShopWorkClaims(
            runs[index].id,
            leases[index],
            wonClaims,
            "ambiguous",
            trafficNow
          );
        }
      }
      const ambiguousReplay = await repository.claimShopWorkBatch(
        runs[0].id, leases[0], nzClaims, trafficNow
      );
      assert.ok(ambiguousReplay.every(({ outcome, networkAllowed }) =>
        outcome === "ambiguous" && !networkAllowed
      ));

      const worldwideClaims = firstRunStores.map(({ shopId }) => ({
        shopId,
        workType: "dataforseo",
        scopeKey: "worldwide"
      }));
      const worldwideWork = await repository.claimShopWorkBatch(
        runs[0].id, leases[0], worldwideClaims, trafficNow
      );
      assert.ok(worldwideWork.every(({ networkAllowed }) => networkAllowed));
      const fingerprint = "e".repeat(64);
      await repository.planDataForSeoRequest(runs[0].id, leases[0], {
        requestFingerprint: fingerprint,
        targetCount: 100,
        scopeKey: "worldwide"
      }, trafficNow);
      assert.equal((await repository.claimDataForSeoRequest(
        runs[0].id, leases[0], fingerprint, trafficNow
      )).networkAllowed, true);
      const dataForSeoValues = firstRunStores.map(({ candidatePayload }) =>
        bulkDataForSeoValue(candidatePayload.resolvedDomain, trafficNow)
      );
      const paidCommitStartedAt = performance.now();
      await repository.markDataForSeoRequestSucceeded(
        runs[0].id,
        leases[0],
        fingerprint,
        {
          providerCostUsd: 0.012,
          cacheRows: dataForSeoValues.map((value) => ({
            source: "dataforseo",
            identity: value.target,
            scopeKey: "worldwide",
            metricSetKey: "featured_snippet,local_pack,organic,paid",
            contractVersion: "dataforseo-traffic-v1",
            state: "available",
            normalizedPayload: value,
            fetchedAt: trafficNow,
            expiresAt: new Date(trafficNow.getTime() + 86_400_000)
          })),
          workClaims: worldwideClaims
        },
        trafficNow
      );
      assert.ok(performance.now() - paidCommitStartedAt < 10_000);
      assert.equal(await prisma.trafficEnrichmentCache.count({
        where: { source: "dataforseo", scopeKey: "worldwide" }
      }), 100);

      const leadIds = outcomes.map((outcome, index) =>
        stableLeadId(runs[0].id, outcome.lead, index)
      );
      const sourceCommitStartedAt = performance.now();
      await repository.saveTrafficSourceResults(runs[0].id, leases[0], {
        sourceKey: "dataforseo",
        records: leadIds.map((leadId, index) => ({
          leadId,
          source: "dataforseo",
          state: "partial",
          contractVersion: "dataforseo-traffic-v1",
          normalizedPayload: { records: [dataForSeoValues[index]] },
          fetchedAt: trafficNow
        })),
        summary: { available: 0, partial: 100 },
        diagnostics: []
      }, trafficNow);
      assert.ok(performance.now() - sourceCommitStartedAt < 10_000);

      const cruxClaims = firstRunStores.map(({ shopId }) => ({
        shopId,
        workType: "crux_rest",
        scopeKey: "current"
      }));
      const cruxWork = await repository.claimShopWorkBatch(
        runs[0].id, leases[0], cruxClaims, trafficNow
      );
      assert.ok(cruxWork.every(({ networkAllowed }) => networkAllowed));
      await repository.saveCruxTrafficCache(
        runs[0].id,
        leases[0],
        firstRunStores.map(({ candidatePayload }) => ({
          source: "crux_rest",
          identity: `https://${candidatePayload.resolvedDomain}`,
          scopeKey: "current",
          metricSetKey: "cumulative_layout_shift,experimental_time_to_first_byte,first_contentful_paint,form_factors,interaction_to_next_paint,largest_contentful_paint",
          contractVersion: "crux-origin-metrics-v1",
          state: "no_coverage",
          fetchedAt: trafficNow,
          expiresAt: new Date(trafficNow.getTime() + 86_400_000)
        })),
        cruxClaims,
        trafficNow
      );
      await repository.saveTrafficSourceResults(runs[0].id, leases[0], {
        sourceKey: "cruxRest",
        records: leadIds.map((leadId) => ({
          leadId,
          source: "crux_rest",
          state: "no_coverage",
          contractVersion: "crux-origin-metrics-v1"
        })),
        summary: { no_coverage: 100 },
        diagnostics: []
      }, trafficNow);
      assert.equal(await prisma.leadTrafficEnrichment.count({
        where: { runId: runs[0].id }
      }), 200);

      await repository.completeTrafficEnrichment(
        runs[0].id,
        leases[0],
        { version: "traffic-enrichment-summary-v1", state: "failed" },
        []
      );
      assert.equal(await prisma.lead.count({ where: { runId: runs[0].id } }), 100);

      const ambiguousOwner = await repository.createRun(
        "owner_paid_ambiguous", [{ shopType: "eyewear" }]
      );
      const paidContender = await repository.createRun(
        "owner_paid_contender", [{ shopType: "eyewear" }]
      );
      const paidStart = new Date(trafficNow.getTime() + 60_000);
      const paidRecovery = new Date(paidStart.getTime() + 1_000_000);
      const ambiguousLease = {
        owner: "worker_paid_ambiguous",
        token: "lease_paid_ambiguous",
        expiresAt: new Date(paidStart.getTime() + 60_000)
      };
      const contenderLease = {
        owner: "worker_paid_contender",
        token: "lease_paid_contender",
        expiresAt: new Date(paidRecovery.getTime() + 600_000)
      };
      await Promise.all([
        [ambiguousOwner, ambiguousLease],
        [paidContender, contenderLease]
      ].map(([run, lease]) => prisma.run.update({
        where: { id: run.id },
        data: {
          state: "running",
          phase: "scraping",
          leaseOwner: lease.owner,
          leaseToken: lease.token,
          leaseExpiresAt: lease.expiresAt
        }
      })));
      const protectedClaim = [{
        shopId: firstRunStores[0].shopId,
        workType: "dataforseo",
        scopeKey: "country:IN:2356"
      }];
      assert.equal((await repository.claimShopWorkBatch(
        ambiguousOwner.id, ambiguousLease, protectedClaim, paidStart
      ))[0].networkAllowed, true);
      const ambiguousFingerprint = "7".repeat(64);
      await repository.planDataForSeoRequest(ambiguousOwner.id, ambiguousLease, {
        requestFingerprint: ambiguousFingerprint,
        targetCount: 1,
        scopeKey: protectedClaim[0].scopeKey
      }, paidStart);
      assert.equal((await repository.claimDataForSeoRequest(
        ambiguousOwner.id, ambiguousLease, ambiguousFingerprint, paidStart
      )).networkAllowed, true);
      await prisma.run.update({
        where: { id: ambiguousOwner.id },
        data: { state: "failed", leaseExpiresAt: paidStart }
      });
      const beforeRecovery = await repository.claimShopWorkBatch(
        paidContender.id, contenderLease, protectedClaim, new Date(paidStart.getTime() + 1)
      );
      assert.equal(beforeRecovery[0].networkAllowed, false);
      const [recoveredPaid, concurrentClaim] = await Promise.all([
        repository.markStaleDataForSeoRequestsAmbiguous(paidRecovery),
        repository.claimShopWorkBatch(
          paidContender.id, contenderLease, protectedClaim, paidRecovery
        )
      ]);
      assert.equal(recoveredPaid.count, 1);
      assert.equal(recoveredPaid.workCount, 1);
      assert.equal(concurrentClaim[0].networkAllowed, false);
      assert.equal((await prisma.shopWork.findUnique({
        where: {
          shopId_workType_scopeKey: {
            shopId: protectedClaim[0].shopId,
            workType: protectedClaim[0].workType,
            scopeKey: protectedClaim[0].scopeKey
          }
        }
      })).state, "ambiguous");
      const afterRecovery = await repository.claimShopWorkBatch(
        paidContender.id, contenderLease, protectedClaim, paidRecovery
      );
      assert.equal(afterRecovery[0].outcome, "ambiguous");
      assert.equal(afterRecovery[0].networkAllowed, false);

      const failedOwner = await repository.createRun(
        "owner_paid_failed", [{ shopType: "eyewear" }]
      );
      const failedLease = {
        owner: "worker_paid_failed",
        token: "lease_paid_failed",
        expiresAt: contenderLease.expiresAt
      };
      await prisma.run.update({
        where: { id: failedOwner.id },
        data: {
          state: "running",
          phase: "scraping",
          leaseOwner: failedLease.owner,
          leaseToken: failedLease.token,
          leaseExpiresAt: failedLease.expiresAt
        }
      });
      const retryableClaim = [{
        shopId: firstRunStores[1].shopId,
        workType: "dataforseo",
        scopeKey: "country:US:2840"
      }];
      assert.equal((await repository.claimShopWorkBatch(
        failedOwner.id, failedLease, retryableClaim, paidRecovery
      ))[0].networkAllowed, true);
      const failedFingerprint = "8".repeat(64);
      await repository.planDataForSeoRequest(failedOwner.id, failedLease, {
        requestFingerprint: failedFingerprint,
        targetCount: 1,
        scopeKey: retryableClaim[0].scopeKey
      }, paidRecovery);
      assert.equal((await repository.claimDataForSeoRequest(
        failedOwner.id, failedLease, failedFingerprint, paidRecovery
      )).networkAllowed, true);
      await repository.markDataForSeoRequestFailed(
        failedOwner.id,
        failedLease,
        failedFingerprint,
        { code: "DATAFORSEO_NOT_DISPATCHED" },
        paidRecovery
      );
      await prisma.run.update({
        where: { id: failedOwner.id },
        data: { state: "failed", leaseExpiresAt: paidRecovery }
      });
      const knownFailureRetry = await repository.claimShopWorkBatch(
        paidContender.id,
        contenderLease,
        retryableClaim,
        new Date(paidRecovery.getTime() + 1)
      );
      assert.equal(knownFailureRetry[0].networkAllowed, true);
    } finally {
      await prisma.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  }
);
