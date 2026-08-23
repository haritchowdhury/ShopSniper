import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createPrismaClient } from "../src/prisma-client.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import {
  confirmedQueryManifestSchema, domainCandidateArtifactSchema, domainStageManifestSchema,
  parseConfirmedQueryManifest, parseQueryDiscoveryArtifact, queryDiscoveryArtifactSchema
} from "../src/aws-pipeline/contracts/artifacts.js";
import { workMessageSchema } from "../src/aws-pipeline/contracts/messages.js";
import { PipelineCoordinatorRepository } from "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { processDomainAggregation } from "../src/aws-pipeline/services/domain-aggregator.js";
import { PrismaRunRepository, trafficEnrichmentConfigSnapshot } from "../src/prisma-run-repository.js";
import { parseRunStoreCandidate, runStoreId, shopIdForStableKey,
  stableShopIdentity } from "../src/shop-persistence-contract.js";
import candidateFixture from "./fixtures/aws-pipeline/v1/per-query-discovery.valid.json" with { type: "json" };
import confirmedFixture from "./fixtures/aws-pipeline/v1/confirmed-query-manifest.valid.json" with { type: "json" };
import providerFixture from "./fixtures/aws-pipeline/v1/aws-provider-config.valid.json" with { type: "json" };
import { assertMigrationStayedInSchema, createIsolatedTestSchema,
  deployPrismaMigrations } from "./helpers/isolated-postgres.js";

const enabled = process.env.ALLOW_DATABASE_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
const fp = (value) => value.repeat(64);

function domainFor(runId) {
  const candidatePayload = parseRunStoreCandidate(candidateFixture.stores[0].candidatePayload);
  const identity = stableShopIdentity(candidatePayload);
  const shopId = shopIdForStableKey(identity.stableKey);
  return { shopId, runStoreId: runStoreId(runId, shopId), identity, candidatePayload };
}

async function createClaimedDiscovery(prisma, coordinator, runId, now) {
  await prisma.run.create({ data: {
    id: runId, ownerId: "g8_owner", state: "running", phase: "scraping", stage: "aws_discovery",
    normalizedShopTypes: [], progress: {}, executionBackend: "aws", pipelineGeneration: 1,
    trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({}), awsProviderConfig: providerFixture,
    resultsAvailable: false
  } });
  await prisma.queryAudit.create({ data: {
    id: `audit_${runId}`, runId, sequence: 0, query: "pre-review fixture", status: "selected",
    details: { preserved: true }
  } });
  const registered = await coordinator.registerStage({ runId, stage: "discovery", generation: 1,
    manifestS3Key: `runs/${runId}/queries/manifest.json`, manifestFingerprint: fp("a"),
    manifestProducedAt: now, tasks: [] }, now);
  const token = randomUUID();
  const claim = await coordinator.claimAggregator({ runId, stage: "discovery", generation: 1,
    owner: "g8-domain", token, leaseDurationMs: 120000 }, new Date(now.getTime() + 1));
  assert.equal(claim.outcome, "owned");
  return { stageId: registered.stage.id, token };
}

test("G8 atomically checkpoints domains, preserves audits, fences visibility, and rolls back conflicts",
  { skip: !enabled, timeout: 120_000 }, async () => {
    const schema = `g8_domain_${Date.now()}_${process.pid}`;
    const { admin: base, scopedUrl } = await createIsolatedTestSchema(schema);
    let prisma;
    try {
      deployPrismaMigrations(scopedUrl);
      prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const coordinator = new PipelineCoordinatorRepository(prisma);
      const repository = new PrismaRunRepository(prisma);
      const now = new Date("2026-08-12T10:00:00.000Z");

      const successRun = "run_g8_domain_success_0001";
      const successClaim = await createClaimedDiscovery(prisma, coordinator, successRun, now);
      const successDomain = domainFor(successRun);
      const manifestFingerprint = fp("b");
      const result = await repository.publishAwsDomainCheckpoint({ runId: successRun, generation: 1,
        stageId: successClaim.stageId, aggregationToken: successClaim.token,
        domainStageManifestKey: `runs/${successRun}/domains-manifest.json`,
        domainStageManifestFingerprint: manifestFingerprint, manifestProducedAt: now,
        domains: [successDomain], diagnostics: [{ scope: "query", code: "g8_fixture", details: { safe: true } }],
        leadTasks: [{ itemKey: successDomain.shopId, inputFingerprint: fp("c") }],
        status: { stage: "aws_lead", storesPersisted: 1 }
      }, new Date(now.getTime() + 2));
      assert.equal(result.stage.state, "completed");
      assert.equal(result.leadStage.expectedCount, 1);
      assert.deepEqual(result.dispatchItems, [{ itemKey: successDomain.shopId, inputFingerprint: fp("c") }]);
      assert.equal(await prisma.shop.count({ where: { id: successDomain.shopId } }), 1);
      assert.equal(await prisma.runStore.count({ where: { id: successDomain.runStoreId } }), 1);
      assert.equal(await prisma.runDiagnostic.count({ where: { runId: successRun } }), 1);
      assert.deepEqual((await prisma.queryAudit.findUnique({ where: {
        runId_sequence: { runId: successRun, sequence: 0 }
      } })).details, { preserved: true });
      const successStored = await prisma.run.findUnique({ where: { id: successRun } });
      assert.equal(successStored.stage, "aws_lead");
      assert.equal(successStored.resultsAvailable, false);

      const rollbackRun = "run_g8_domain_rollback_001";
      const rollbackClaim = await createClaimedDiscovery(prisma, coordinator, rollbackRun, now);
      const rollbackDomain = domainFor(rollbackRun);
      await prisma.runDiagnostic.create({ data: { id: `existing_${rollbackRun}`, runId: rollbackRun,
        sequence: 100000, scope: "query", code: "different", details: { preserved: true } } });
      await assert.rejects(repository.publishAwsDomainCheckpoint({ runId: rollbackRun, generation: 1,
        stageId: rollbackClaim.stageId, aggregationToken: rollbackClaim.token,
        domainStageManifestKey: `runs/${rollbackRun}/domains-manifest.json`,
        domainStageManifestFingerprint: fp("d"), manifestProducedAt: now,
        domains: [rollbackDomain], diagnostics: [{ scope: "query", code: "conflict", details: {} }],
        leadTasks: [{ itemKey: rollbackDomain.shopId, inputFingerprint: fp("e") }], status: { stage: "aws_lead" }
      }, new Date(now.getTime() + 2)), (error) => error.code === "PIPELINE_INPUT_CONFLICT");
      assert.equal(await prisma.runStore.count({ where: { id: rollbackDomain.runStoreId } }), 0);
      assert.equal(await prisma.pipelineStage.count({ where: { runId: rollbackRun, stage: "lead" } }), 0);
      const rollbackStage = await prisma.pipelineStage.findUnique({ where: { id: rollbackClaim.stageId } });
      assert.equal(rollbackStage.state, "aggregating");
      const rollbackStored = await prisma.run.findUnique({ where: { id: rollbackRun } });
      assert.equal(rollbackStored.stage, "aws_discovery");
      assert.equal(rollbackStored.resultsAvailable, false);
      assert.deepEqual((await prisma.queryAudit.findUnique({ where: {
        runId_sequence: { runId: rollbackRun, sequence: 0 }
      } })).details, { preserved: true });
      assert.equal(fingerprintJson(rollbackDomain.candidatePayload).length, 64);
    } finally {
      await prisma?.$disconnect();
      await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await base.$disconnect();
    }
  });

const W6_BRIDGE_CASES = Object.freeze(["W6-DB-14", "W6-DB-15"]);
const W6_BRIDGE_CONTROLS = Object.freeze(["W6-NC-23", "W6-NC-24"]);
const W6_BRIDGE_LOCAL_CASE_DIGEST = "781e64d60420ac6ddd741ea8a046489c44cd9e214e4bddf907a0d73a38e49ba7";
const W6_BRIDGE_LOCAL_CONTROL_DIGEST = "86c8b8431fc8414016eed1f66702017debe1b0d0cf7b6796bdbcbba9f3e38f6f";
const W6_BRIDGE_PACKAGE_CASE_DIGEST = "5342728a461b927afe37050b5f4e8df6df30f42698e3b75144f5872334e19600";
const W6_BRIDGE_PACKAGE_CONTROL_DIGEST = "97b186a9948a3fbb4077f1d6f4d39b2d635ad1325e37fb82cdb095661bfbe4ee";

function memberSetDigest(members) {
  assert.equal(new Set(members).size, members.length);
  return createHash("sha256").update([...members].sort().map((member) => `${member}\n`).join(""), "utf8").digest("hex");
}

function bridgeQuery(index, prefix) {
  const qqq = String(index).padStart(3, "0");
  const query = `site:myshopify.com/products ${prefix} query ${qqq}`;
  const probeResults = Array.from({ length: 10 }, (_, offset) => {
    const rank = offset + 1;
    const rr = String(rank).padStart(2, "0");
    return { query, rank, url: `https://${prefix}-q${qqq}-r${rr}.myshopify.com/products/result-${rr}`,
      title: query, snippet: query, rejectionReason: "" };
  });
  return { ...structuredClone(confirmedFixture.queries[0]), id: `query_${qqq}`, sequence: index - 1,
    query, probeFingerprint: fingerprintJson({ query, probeResults }), probeResults };
}

function bridgeStore(query, rank, prefix) {
  const qqq = query.id.slice(-3);
  const rr = String(rank).padStart(2, "0");
  const host = `${prefix}-q${qqq}-r${rr}.myshopify.com`;
  const url = `https://${host}/products/result-${rr}`;
  const store = structuredClone(candidateFixture.stores[0]);
  const evidence = { ...store.identity.identityEvidence, stableHostname: host, displayHostname: host,
    observedHostnames: [host], canonical: { ...store.identity.identityEvidence.canonical,
      url, hostname: host }, mergedOccurrenceCount: 1 };
  store.identity = { ...store.identity, stableKey: host, myshopifyDomain: host, resolvedDomain: host,
    canonicalUrl: url, identityEvidence: evidence };
  const candidate = store.candidatePayload;
  candidate.representative = { ...candidate.representative, query: query.query, rank, resultUrl: url,
    querySourceUrls: [url] };
  candidate.finalUrl = url;
  candidate.canonicalUrl = url;
  candidate.myshopifyDomain = host;
  candidate.resolvedDomain = host;
  candidate.stableIdentity = host;
  candidate.allowedHostnames = [host];
  candidate.identityEvidence = structuredClone(evidence);
  candidate.occurrences = candidate.occurrences.map((occurrence) => ({ ...occurrence,
    query: query.query, querySourceUrls: [url], rank, resultUrl: url, finalUrl: url, resolvedDomain: host,
    myshopifyDomain: host }));
  return store;
}

function bridgeFixture(runId, prefix, producedAt) {
  const queries = Array.from({ length: 100 }, (_, index) => bridgeQuery(index + 1, prefix));
  const manifest = parseConfirmedQueryManifest({ ...structuredClone(confirmedFixture), runId,
    generation: 1, confirmedRevision: 1, awsProviderConfig: structuredClone(providerFixture), queries });
  const manifestFingerprint = fingerprintJson(manifest);
  const manifestKey = `runs/${runId}/queries/manifest.json`;
  const artifacts = queries.map((query, queryIndex) => {
    const artifact = parseQueryDiscoveryArtifact({ ...structuredClone(candidateFixture), runId,
      generation: 1, queryId: query.id, confirmedRevision: 1,
      stores: Array.from({ length: 10 }, (_, rank) => bridgeStore(query, rank + 1, prefix)),
      queryAudits: [], diagnostics: queryIndex === 0
        ? [{ scope: "query", code: "w6_bridge_diagnostic", details: { safe: true } }]
        : [] });
    const inputFingerprint = fingerprintJson({ contractVersion: "discovery-query-input-v1",
      runId, generation: 1, confirmedRevision: 1, manifestFingerprint, query });
    return { query, artifact, inputFingerprint, artifactFingerprint: fingerprintJson(artifact),
      artifactKey: `runs/${runId}/queries/${query.id}/domains.json` };
  });
  const stableKeys = artifacts.flatMap(({ artifact }) => artifact.stores.map(({ candidatePayload }) =>
    stableShopIdentity(candidatePayload).stableKey));
  assert.equal(stableKeys.length, 1000);
  assert.equal(new Set(stableKeys).size, 1000);
  const domains = artifacts.flatMap(({ artifact }) => artifact.stores.map(({ candidatePayload }) => {
    const parsed = parseRunStoreCandidate(candidatePayload);
    const identity = stableShopIdentity(parsed);
    const shopId = shopIdForStableKey(identity.stableKey);
    return { shopId, runStoreId: runStoreId(runId, shopId), identity, candidatePayload: parsed };
  }));
  return { runId, prefix, producedAt, manifest, manifestFingerprint, manifestKey, artifacts,
    stableKeys, domains };
}

async function seedBridgeDiscovery(prisma, coordinator, fixture) {
  await prisma.run.create({ data: { id: fixture.runId, ownerId: `owner_${fixture.prefix}`,
    state: "running", phase: "scraping", stage: "aws_discovery", normalizedShopTypes: [],
    progress: {}, executionBackend: "aws", pipelineGeneration: 1, queryRevision: 1,
    confirmedQueryRevision: 1, trafficEnrichmentConfig: trafficEnrichmentConfigSnapshot({
      dataForSeoEnrichmentEnabled: false, cruxEnrichmentEnabled: false }),
    awsProviderConfig: providerFixture, resultsAvailable: false } });
  const registered = await coordinator.registerStage({ runId: fixture.runId, stage: "discovery",
    generation: 1, manifestS3Key: fixture.manifestKey,
    manifestFingerprint: fixture.manifestFingerprint, manifestProducedAt: fixture.producedAt,
    tasks: fixture.artifacts.map(({ query, inputFingerprint }) => ({ itemKey: query.id, inputFingerprint }))
  }, fixture.producedAt);
  assert.equal(registered.tasks.length, 100);
  await prisma.$transaction(registered.tasks.map((task) => {
    const artifact = fixture.artifacts.find(({ query }) => query.id === task.itemKey);
    return prisma.pipelineTask.update({ where: { id: task.id }, data: { state: "succeeded",
      artifactS3Key: artifact.artifactKey, artifactFingerprint: artifact.artifactFingerprint,
      terminalAt: fixture.producedAt } });
  }));
  await prisma.pipelineStage.update({ where: { id: registered.stage.id }, data: { state: "ready",
    expectedCount: 100, terminalCount: 100, succeededCount: 100 } });
  const tasks = await prisma.pipelineTask.findMany({
    where: { stageId: registered.stage.id }, orderBy: { itemKey: "asc" } });
  const artifactByQuery = new Map(fixture.artifacts.map((artifact) => [artifact.query.id, artifact]));
  assert.ok(tasks.every((task) => task.state === "succeeded" &&
    task.artifactS3Key === artifactByQuery.get(task.itemKey).artifactKey &&
    task.artifactFingerprint === artifactByQuery.get(task.itemKey).artifactFingerprint));
  const stage = await prisma.pipelineStage.findUnique({ where: { id: registered.stage.id } });
  assert.deepEqual({ state: stage.state, expected: stage.expectedCount, terminal: stage.terminalCount,
    succeeded: stage.succeededCount }, { state: "ready", expected: 100, terminal: 100, succeeded: 100 });
  return { ...registered, stage, tasks };
}

function strictMemoryArtifacts(fixture, seeded, counters) {
  const candidateIds = [];
  const stored = new Map([[fixture.manifestKey, { value: fixture.manifest,
    contentFingerprint: fixture.manifestFingerprint, metadata: {
      contractVersion: "confirmed-query-manifest-v1", runId: fixture.runId, stage: "discovery",
      generation: 1, itemId: "manifest", inputFingerprint: fixture.manifestFingerprint,
      producedAt: fixture.producedAt } }]]);
  const taskByItem = new Map(seeded.tasks.map((task) => [task.itemKey, task]));
  for (const artifact of fixture.artifacts) {
    const task = taskByItem.get(artifact.query.id);
    stored.set(artifact.artifactKey, { value: artifact.artifact,
      contentFingerprint: artifact.artifactFingerprint, metadata: {
        contractVersion: "query-discovery-artifact-v1", runId: fixture.runId, stage: "discovery",
        generation: 1, itemId: artifact.query.id, inputFingerprint: artifact.inputFingerprint,
        producedAt: task.createdAt } });
  }
  const same = (left, right) => String(left instanceof Date ? left.toISOString() : left) ===
    String(right instanceof Date ? right.toISOString() : right);
  return {
    async getValidated({ key, expected, schema }) {
      const record = stored.get(key);
      assert.ok(record, `missing strict in-memory artifact: ${key}`);
      for (const [name, value] of Object.entries(expected || {})) {
        const actual = name === "contentFingerprint" ? record.contentFingerprint : record.metadata[name];
        assert.ok(same(actual, value), `strict artifact metadata mismatch: ${name}`);
      }
      const value = schema.parse(structuredClone(record.value));
      if (value.contractVersion === "query-discovery-artifact-v1") {
        assert.equal(schema, queryDiscoveryArtifactSchema);
        counters.queryArtifactReads += 1;
      } else {
        assert.equal(schema, confirmedQueryManifestSchema);
        counters.manifestReads += 1;
      }
      return { value, contentFingerprint: record.contentFingerprint };
    },
    async putImmutable(input) {
      assert.equal(input.runId, fixture.runId);
      assert.equal(input.generation, 1);
      assert.ok(input.producedAt instanceof Date);
      const value = input.schema.parse(structuredClone(input.value));
      const contentFingerprint = fingerprintJson(value);
      assert.equal(input.inputFingerprint, contentFingerprint);
      if (input.contractVersion === "domain-candidate-v1") {
        assert.equal(input.schema, domainCandidateArtifactSchema);
        assert.equal(input.stage, "domain");
        assert.equal(input.itemId, value.shopId);
        assert.equal(input.key, `runs/${fixture.runId}/domains/${value.shopId}/candidate.json`);
        counters.domainCandidateWrites += 1;
        candidateIds.push(input.itemId);
      } else {
        assert.equal(input.contractVersion, "domain-stage-manifest-v1");
        assert.equal(input.schema, domainStageManifestSchema);
        assert.equal(input.stage, "domain");
        assert.equal(input.itemId, "manifest");
        assert.equal(input.key, `runs/${fixture.runId}/domains-manifest.json`);
        counters.domainManifestWrites += 1;
      }
      const prior = stored.get(input.key);
      if (prior) assert.equal(prior.contentFingerprint, contentFingerprint);
      stored.set(input.key, { value, contentFingerprint, metadata: { contractVersion: input.contractVersion,
        runId: input.runId, stage: input.stage, generation: input.generation, itemId: input.itemId,
        inputFingerprint: input.inputFingerprint, producedAt: input.producedAt } });
      return { contentFingerprint };
    },
    candidateIds
  };
}

function instrumentBridgeRuntime(prisma, fixture, seeded) {
  const counters = { manifestReads: 0, queryArtifactReads: 0, domainCandidateWrites: 0,
    domainManifestWrites: 0, reuseReads: 0, publications: 0, sendMany: 0, recordDispatch: 0 };
  const calls = { messages: [], recordItemIds: [] };
  const coordinatorBase = new PipelineCoordinatorRepository(prisma);
  const coordinator = new Proxy(coordinatorBase, { get(target, property) {
    const value = target[property];
    if (property === "recordDispatch") return async (input, now) => {
      counters.recordDispatch += 1;
      calls.recordItemIds.push(...input.itemKeys);
      return value.call(target, input, now);
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const repositoryBase = new PrismaRunRepository(prisma);
  const repository = new Proxy(repositoryBase, { get(target, property) {
    const value = target[property];
    if (property === "readAwsReuseInputs") return async (...args) => {
      counters.reuseReads += 1;
      return value.apply(target, args);
    };
    if (property === "publishAwsDomainCheckpoint") return async (...args) => {
      counters.publications += 1;
      return value.apply(target, args);
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const artifactStore = strictMemoryArtifacts(fixture, seeded, counters);
  const dispatcher = {
    async sendMany(queue, messages, schema) {
      assert.equal(queue, "memory://kiw6-lead");
      assert.equal(schema, workMessageSchema);
      const parsed = messages.map((message) => schema.parse(message));
      assert.equal(parsed.length, 1000);
      assert.equal(new Set(parsed.map(({ itemId }) => itemId)).size, 1000);
      assert.ok(parsed.every(({ type, stage }) => type === "lead.domain" && stage === "lead"));
      assert.ok(parsed.every(({ runId, generation, manifestKey }) => runId === fixture.runId &&
        generation === 1 && manifestKey === `runs/${fixture.runId}/domains-manifest.json`));
      assert.equal(new Set(parsed.map(({ manifestFingerprint }) => manifestFingerprint)).size, 1);
      assert.equal(new Set(parsed.map(({ manifestProducedAt }) => manifestProducedAt)).size, 1);
      counters.sendMany += 1;
      calls.messages.push(...parsed);
      return { sentItemIds: parsed.map(({ itemId }) => itemId), failedItemIds: [] };
    },
    async sendOne() { assert.fail("the 1,000-member lead stage must not emit a zero-count check"); }
  };
  return { runtime: { coordinator, repository, artifactStore, dispatcher,
    config: { awsPipelineLeadQueueUrl: "memory://kiw6-lead",
      awsPipelineLeadAggregationQueueUrl: "memory://kiw6-lead-check" } },
  counters, calls, coordinatorBase, repositoryBase };
}

function assertSuccessProjection(projection) {
  assert.equal(projection.shopIds.length, 1000);
  assert.equal(new Set(projection.shopIds).size, 1000);
  assert.equal(projection.runStoreIds.length, 1000);
  assert.equal(new Set(projection.runStoreIds).size, 1000);
  assert.equal(projection.leadTaskIds.length, 1000);
  assert.equal(new Set(projection.leadTaskIds).size, 1000);
  assert.equal(projection.messageIds.length, 1000);
  assert.equal(new Set(projection.messageIds).size, 1000);
  assert.equal(projection.candidateIds.length, 1000);
  assert.equal(new Set(projection.candidateIds).size, 1000);
  assert.deepEqual(projection.shopIds, projection.expectedShopIds);
  assert.deepEqual(projection.runStoreIds, projection.expectedRunStoreIds);
  assert.deepEqual(projection.leadTaskIds, projection.expectedShopIds);
  assert.deepEqual(projection.messageIds, projection.expectedShopIds);
  assert.deepEqual(projection.candidateIds, projection.expectedShopIds);
  assert.equal(projection.discoveryState, "completed");
  assert.equal(projection.leadState, "collecting");
  assert.equal(projection.leadExpectedCount, 1000);
  assert.equal(projection.runStage, "aws_lead");
  assert.equal(projection.resultsAvailable, false);
}

function assertRollbackProjection(projection) {
  assert.deepEqual(projection.runStoreIds, []);
  assert.equal(projection.leadStage, null);
  assert.deepEqual(projection.leadTaskIds, []);
  assert.deepEqual(projection.rollbackShopIds, []);
  assert.equal(projection.discoveryState, "aggregating");
  assert.equal(projection.runStage, "aws_discovery");
  assert.equal(projection.resultsAvailable, false);
}

test("SCN-KI-046 bridges 100 strict discovery artifacts to 1,000 fenced durable lead tasks",
  { skip: !enabled, timeout: 240_000 }, async () => {
    const requiredCases = [...W6_BRIDGE_CASES];
    const registeredCases = [...W6_BRIDGE_CASES];
    const executedCases = [];
    const activatedCases = [];
    const requiredControls = [...W6_BRIDGE_CONTROLS];
    const falsifiedControls = [];
    const freshPositiveControls = [];
    assert.equal(memberSetDigest(requiredCases), W6_BRIDGE_LOCAL_CASE_DIGEST);
    assert.equal(memberSetDigest(requiredControls), W6_BRIDGE_LOCAL_CONTROL_DIGEST);
    assert.equal(memberSetDigest(["W6-DB-13", ...requiredCases]), W6_BRIDGE_PACKAGE_CASE_DIGEST);
    assert.equal(memberSetDigest(["W6-NC-22", ...requiredControls]), W6_BRIDGE_PACKAGE_CONTROL_DIGEST);

    const schema = `kiw6_bridge_${Date.now()}_${process.pid}`;
    let base;
    let prisma;
    let scopedUrl;
    let certificate;
    let schemaRowCount = null;
    try {
      ({ admin: base, scopedUrl } = await createIsolatedTestSchema(schema));
      deployPrismaMigrations(scopedUrl);
      prisma = createPrismaClient(scopedUrl);
      await assertMigrationStayedInSchema(prisma, schema);
      const [{ currentSchema }] = await prisma.$queryRaw`SELECT current_schema()::text AS "currentSchema"`;
      assert.equal(currentSchema, schema);

      const producedAt = new Date("2026-08-23T12:00:00.000Z");
      const success = bridgeFixture("run_kiw6_bridge_success_0001", "w6-bridge", producedAt);
      const successCoordinator = new PipelineCoordinatorRepository(prisma);
      const successSeed = await seedBridgeDiscovery(prisma, successCoordinator, success);
      const successHarness = instrumentBridgeRuntime(prisma, success, successSeed);
      const originalFetch = globalThis.fetch;
      const monitors = [];
      const createLeaseMonitorFn = () => {
        const monitor = { active: true, assertActive() {},
          async renewNow() {}, async stop() { this.active = false; } };
        monitors.push(monitor);
        return monitor;
      };
      assert.deepEqual(await processDomainAggregation({ version: 1, type: "aggregation.check",
        runId: success.runId, stage: "discovery", generation: 1,
        reason: "terminal_task_recorded", attempt: 1 }, successHarness.runtime,
      { createLeaseMonitorFn }), { terminal: true, outcome: "completed" });
      assert.equal(monitors.length, 1);
      assert.equal(monitors[0].active, false);
      assert.equal(globalThis.fetch, originalFetch);
      assert.deepEqual(successHarness.counters, { manifestReads: 1, queryArtifactReads: 100,
        domainCandidateWrites: 1000, domainManifestWrites: 1, reuseReads: 1,
        publications: 1, sendMany: 1, recordDispatch: 1 });
      assert.equal(successHarness.calls.recordItemIds.length, 1000);
      assert.deepEqual([...successHarness.calls.recordItemIds].sort(),
        successHarness.calls.messages.map(({ itemId }) => itemId).sort());

      const successShops = await prisma.shop.findMany({ where: { stableKey: { startsWith: "w6-bridge-" } },
        orderBy: { id: "asc" } });
      const successRunStores = await prisma.runStore.findMany({ where: { runId: success.runId },
        orderBy: { id: "asc" } });
      const successDiscovery = await prisma.pipelineStage.findUnique({ where: { id: successSeed.stage.id } });
      const successLead = await prisma.pipelineStage.findUnique({ where: {
        runId_stage_generation: { runId: success.runId, stage: "lead", generation: 1 } } });
      const successLeadTasks = await prisma.pipelineTask.findMany({ where: { stageId: successLead.id },
        orderBy: { itemKey: "asc" } });
      const successRun = await prisma.run.findUnique({ where: { id: success.runId } });
      assert.equal(await prisma.pipelineStage.count({ where: { runId: success.runId,
        stage: "discovery", state: "completed" } }), 1);
      assert.equal(await prisma.pipelineStage.count({ where: { runId: success.runId,
        stage: "lead", state: "collecting" } }), 1);
      const expectedShopIds = success.domains.map(({ shopId }) => shopId).sort();
      const expectedRunStoreIds = success.domains.map(({ runStoreId: id }) => id).sort();
      assert.deepEqual(successShops.map(({ stableKey }) => stableKey).sort(), [...success.stableKeys].sort());
      assert.ok(successShops.every((shop) => shop.id === shopIdForStableKey(shop.stableKey)));
      assert.ok(successRunStores.every((row) => row.id === runStoreId(success.runId, row.shopId)));
      const successProjection = { shopIds: successShops.map(({ id }) => id),
        runStoreIds: successRunStores.map(({ id }) => id),
        leadTaskIds: successLeadTasks.map(({ itemKey }) => itemKey),
        messageIds: successHarness.calls.messages.map(({ itemId }) => itemId).sort(),
        candidateIds: [...successHarness.runtime.artifactStore.candidateIds].sort(),
        expectedShopIds, expectedRunStoreIds, discoveryState: successDiscovery.state,
        leadState: successLead.state, leadExpectedCount: successLead.expectedCount,
        runStage: successRun.stage, resultsAvailable: successRun.resultsAvailable };
      assertSuccessProjection(successProjection);
      executedCases.push("W6-DB-14");
      activatedCases.push("W6-DB-14");

      const duplicateSuccessWitness = structuredClone(successProjection);
      duplicateSuccessWitness.shopIds[999] = duplicateSuccessWitness.shopIds[0];
      assert.throws(() => assertSuccessProjection(duplicateSuccessWitness));
      falsifiedControls.push("W6-NC-23");
      assertSuccessProjection(successProjection);
      freshPositiveControls.push("W6-NC-23");

      const rollback = bridgeFixture("run_kiw6_bridge_rollback_0001", "w6-rollback", producedAt);
      const rollbackCoordinator = new PipelineCoordinatorRepository(prisma);
      const rollbackSeed = await seedBridgeDiscovery(prisma, rollbackCoordinator, rollback);
      await prisma.runDiagnostic.create({ data: { id: `existing_${rollback.runId}`, runId: rollback.runId,
        sequence: 100000, scope: "query", code: "preexisting_conflict", details: { preserved: true } } });
      const rollbackHarness = instrumentBridgeRuntime(prisma, rollback, rollbackSeed);
      await assert.rejects(processDomainAggregation({ version: 1, type: "aggregation.check",
        runId: rollback.runId, stage: "discovery", generation: 1,
        reason: "terminal_task_recorded", attempt: 1 }, rollbackHarness.runtime,
      { createLeaseMonitorFn }), (error) => error.code === "PIPELINE_INPUT_CONFLICT");
      assert.equal(rollbackHarness.counters.publications, 1);
      assert.equal(rollbackHarness.counters.sendMany, 0);
      assert.equal(rollbackHarness.counters.recordDispatch, 0);
      const rollbackDiscovery = await prisma.pipelineStage.findUnique({ where: { id: rollbackSeed.stage.id } });
      const rollbackLead = await prisma.pipelineStage.findUnique({ where: {
        runId_stage_generation: { runId: rollback.runId, stage: "lead", generation: 1 } } });
      const rollbackRun = await prisma.run.findUnique({ where: { id: rollback.runId } });
      const rollbackProjection = {
        runStoreIds: (await prisma.runStore.findMany({ where: { runId: rollback.runId } })).map(({ id }) => id),
        leadStage: rollbackLead,
        leadTaskIds: rollbackLead ? (await prisma.pipelineTask.findMany({ where: {
          stageId: rollbackLead.id } })).map(({ itemKey }) => itemKey) : [],
        rollbackShopIds: (await prisma.shop.findMany({ where: { stableKey: {
          startsWith: "w6-rollback-" } } })).map(({ id }) => id),
        discoveryState: rollbackDiscovery.state, runStage: rollbackRun.stage,
        resultsAvailable: rollbackRun.resultsAvailable };
      assertRollbackProjection(rollbackProjection);

      const stale = bridgeFixture("run_kiw6_bridge_stale_000001", "w6-stale", producedAt);
      const staleClaim = await createClaimedDiscovery(prisma,
        new PipelineCoordinatorRepository(prisma), stale.runId, producedAt);
      const wrongAggregationToken = randomUUID();
      assert.notEqual(wrongAggregationToken, staleClaim.token);
      await assert.rejects(new PrismaRunRepository(prisma).publishAwsDomainCheckpoint({ runId: stale.runId,
        generation: 1, stageId: staleClaim.stageId, aggregationToken: wrongAggregationToken,
        domainStageManifestKey: `runs/${stale.runId}/domains-manifest.json`,
        domainStageManifestFingerprint: fingerprintJson({ stale: true }), manifestProducedAt: producedAt,
        domains: stale.domains, diagnostics: [{ scope: "query", code: "w6_bridge_diagnostic",
          details: { safe: true } }], leadTasks: stale.domains.map(({ shopId }) => ({ itemKey: shopId,
          inputFingerprint: fingerprintJson({ stale: shopId }) })), status: { stage: "aws_lead",
          storesPersisted: 1000 } }, new Date()), (error) => error.code === "PIPELINE_LEASE_LOST");
      assert.equal(await prisma.runStore.count({ where: { runId: stale.runId } }), 0);
      assert.equal(await prisma.pipelineStage.count({ where: { runId: stale.runId, stage: "lead" } }), 0);
      assert.equal(await prisma.pipelineTask.count({ where: { stage: {
        runId: stale.runId, stage: "lead" } } }), 0);
      assert.equal(await prisma.shop.count({ where: { stableKey: { startsWith: "w6-stale-" } } }), 0);
      const staleDiscovery = await prisma.pipelineStage.findUnique({ where: { id: staleClaim.stageId } });
      assert.equal(staleDiscovery.state, "aggregating");
      const staleRun = await prisma.run.findUnique({ where: { id: stale.runId } });
      assert.equal(staleRun.stage, "aws_discovery");
      assert.equal(staleRun.resultsAvailable, false);
      executedCases.push("W6-DB-15");
      activatedCases.push("W6-DB-15");

      const exposedRollbackWitness = structuredClone(rollbackProjection);
      exposedRollbackWitness.runStoreIds = ["exposed_run_store"];
      exposedRollbackWitness.leadTaskIds = ["exposed_lead_task"];
      assert.throws(() => assertRollbackProjection(exposedRollbackWitness));
      falsifiedControls.push("W6-NC-24");
      assertRollbackProjection(rollbackProjection);
      freshPositiveControls.push("W6-NC-24");

      assert.deepEqual(registeredCases, requiredCases);
      assert.deepEqual(executedCases, requiredCases);
      assert.deepEqual(activatedCases, requiredCases);
      assert.deepEqual(falsifiedControls, requiredControls);
      assert.deepEqual(freshPositiveControls, requiredControls);
      certificate = { scenario: "SCN-KI-046", cases: {
        required: requiredCases.length, registered: registeredCases.length,
        executed: executedCases.length, activated: activatedCases.length,
        localDigest: memberSetDigest(requiredCases), packageDigest: W6_BRIDGE_PACKAGE_CASE_DIGEST },
      controls: { expected: requiredControls.length,
        falsified: falsifiedControls.length, freshPositive: freshPositiveControls.length,
        localDigest: memberSetDigest(requiredControls), packageDigest: W6_BRIDGE_PACKAGE_CONTROL_DIGEST },
      counts: { queries: 100, stableDomains: 1000,
        shops: 1000, runStores: 1000, leadTasks: 1000, leadMessages: 1000 },
      rollbackVisibility: 0, schemaRowCount: 0, paidCost: "$0.00" };
    } finally {
      try {
        await prisma?.$disconnect();
      } finally {
        if (base) {
          try {
            await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            const residual = await base.$queryRawUnsafe(
              "SELECT nspname FROM pg_namespace WHERE nspname = $1", schema);
            schemaRowCount = residual.length;
            assert.equal(schemaRowCount, 0);
          } finally {
            await base.$disconnect();
          }
        }
      }
    }
    assert.ok(certificate);
    assert.equal(schemaRowCount, 0);
    assert.equal(certificate.schemaRowCount, schemaRowCount);
    console.log(`SCN-KI-046 certificate ${JSON.stringify(certificate)}`);
  });
