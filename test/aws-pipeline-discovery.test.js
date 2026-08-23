import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dispatchConfirmedQueries } from "../src/aws-pipeline/services/confirmed-query-dispatcher.js";
import { processDiscoveryMessage } from "../src/aws-pipeline/services/discovery-worker.js";
import { resolveStoreIdentity } from "../src/domain-resolver.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { executeRun } from "../src/server.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/aws-pipeline/v1/confirmed-query-manifest.valid.json", import.meta.url)));
const producedAt = "2026-08-11T09:52:32.910Z";

test("confirmed dispatcher writes the exact immutable manifest before atomic publication and sorted dispatch", async () => {
  const events = [];
  const runtime = {
    config: { awsPipelineDiscoveryQueueUrl: "discovery", awsPipelineDomainAggregationQueueUrl: "aggregate" },
    artifactStore: { async putImmutable(input) { events.push(["s3", input]); return { contentFingerprint: fingerprintJson(input.value) }; } },
    repository: { async publishAwsDiscoveryStage(input) {
      events.push(["publish", input]);
      return { stage: { id: "stage_1" }, dispatchItems: [...input.tasks].reverse() };
    } },
    dispatcher: {
      async sendMany(_queue, messages) { events.push(["send", messages]); return { sentItemIds: [messages[0].itemId], failedItemIds: [messages[1].itemId] }; },
      async sendOne() { throw new Error("unexpected zero check"); }
    },
    coordinator: { async recordDispatch(input) { events.push(["record", input]); } }
  };
  const result = await dispatchConfirmedQueries({ runId: fixture.runId, lease: { owner: "owner", token: "token" },
    categories: fixture.categories, confirmedRevision: 1, queriesConfirmedAt: new Date(producedAt),
    awsProviderConfig: fixture.awsProviderConfig, queries: fixture.queries, generation: 1, status: {} }, runtime);
  assert.deepEqual(events.map(([name]) => name), ["s3", "publish", "send", "record"]);
  assert.equal(events[0][1].producedAt, producedAt);
  assert.equal(events[1][1].manifestProducedAt.toISOString(), producedAt);
  assert.ok(events[2][1].every((message) => message.manifestProducedAt === producedAt));
  assert.deepEqual(events[3][1].itemKeys, [events[2][1][0].itemId]);
  assert.equal(result.sent.failedItemIds.length, 1);
});

test("discovery terminal replay performs no provider or artifact work", async () => {
  const manifestFingerprint = fingerprintJson(fixture);
  let writes = 0;
  let sends = 0;
  const message = { version: 1, type: "discovery.query", runId: fixture.runId, stage: "discovery",
    generation: 1, itemId: fixture.queries[0].id, manifestKey: `runs/${fixture.runId}/queries/manifest.json`,
    manifestFingerprint, manifestProducedAt: producedAt, attempt: 1 };
  const runtime = {
    artifactStore: {
      async getValidated() { return { value: fixture, contentFingerprint: manifestFingerprint }; },
      async getOptionalValidated() { throw new Error("artifact read after terminal claim"); },
      async putImmutable() { writes += 1; }
    },
    coordinator: { async claimTask() { return { outcome: "terminal", task: {}, stage: {} }; } },
    dispatcher: { async sendOne() { sends += 1; } }, config: {}
  };
  assert.deepEqual(await processDiscoveryMessage(message, runtime), { terminal: true, outcome: "replayed" });
  assert.equal(writes, 0);
  assert.equal(sends, 0);
});

test("discovery busy and cancelled claims preserve SQS terminal semantics", async () => {
  const manifestFingerprint = fingerprintJson(fixture);
  const message = { version: 1, type: "discovery.query", runId: fixture.runId, stage: "discovery",
    generation: 1, itemId: fixture.queries[0].id, manifestKey: `runs/${fixture.runId}/queries/manifest.json`,
    manifestFingerprint, manifestProducedAt: producedAt, attempt: 1 };
  for (const [claim, expected] of [["busy", { terminal: false, outcome: "busy" }],
    ["cancelled", { terminal: true, outcome: "cancelled" }]]) {
    const runtime = { artifactStore: { async getValidated() { return { value: fixture, contentFingerprint: manifestFingerprint }; } },
      coordinator: { async claimTask() { return { outcome: claim, task: {}, stage: {} }; } } };
    assert.deepEqual(await processDiscoveryMessage(message, runtime), expected);
  }
});

test("discovery writes an empty terminal artifact from persisted rejected probe results without providers", async () => {
  const manifest = structuredClone(fixture);
  manifest.queries = [structuredClone(fixture.queries[0])];
  manifest.queries[0].probeResults = [{ query: manifest.queries[0].query, rank: 1, url: "", title: "",
    snippet: "", rejectionReason: "invalid_url" }];
  const manifestFingerprint = fingerprintJson(manifest);
  const message = { version: 1, type: "discovery.query", runId: manifest.runId, stage: "discovery",
    generation: 1, itemId: manifest.queries[0].id, manifestKey: `runs/${manifest.runId}/queries/manifest.json`,
    manifestFingerprint, manifestProducedAt: producedAt, attempt: 1 };
  let artifact;
  let terminal;
  let checks = 0;
  const runtime = {
    config: { awsPipelineDomainAggregationQueueUrl: "aggregate" },
    artifactStore: {
      async getValidated() { return { value: manifest, contentFingerprint: manifestFingerprint }; },
      async getOptionalValidated() { return { outcome: "missing" }; },
      async putImmutable(input) { artifact = input.value; return { contentFingerprint: fingerprintJson(input.value) }; }
    },
    coordinator: {
      async claimTask() { return { outcome: "owned", task: { id: "task_1", createdAt: new Date(producedAt) }, stage: {} }; },
      async renewTask() { return { expiresAt: new Date(Date.now() + 60000) }; },
      async recordTerminal(input) { terminal = input; return { outcome: "recorded" }; }
    },
    dispatcher: { async sendOne() { checks += 1; return { sentItemIds: ["check"], failedItemIds: [] }; } }
  };
  assert.deepEqual(await processDiscoveryMessage(message, runtime), { terminal: true, outcome: "recorded" });
  assert.deepEqual(artifact.stores, []);
  assert.deepEqual(artifact.queryAudits, []);
  assert.equal(artifact.diagnostics.at(-1).code, "invalid_url");
  assert.equal("result_url" in artifact.diagnostics.at(-1), false);
  assert.equal(terminal.state, "succeeded");
  assert.equal(checks, 1);
});

test("AWS executeRun validates from a durable probe result before manifest publication", async () => {
  const rows = fixture.queries.map((query) => ({ ...query, probedAt: new Date(producedAt) }));
  const events = [];
  const repository = {
    prisma: {},
    async saveGeneratedQueryPlan() {},
    async loadConfirmedQueryPlans() { events.push("load"); return rows; },
    async saveQueryValidation(_runId, _lease, saved) { events.push("save"); assert.equal(saved, rows); },
    async updateProgress() { events.push("progress"); },
    async heartbeatRun() { events.push("heartbeat"); },
    async markFailed() { events.push("failed"); },
    async publishAwsDiscoveryStage(input) {
      events.push("publish");
      return { stage: { id: "stage_1" }, dispatchItems: input.tasks };
    }
  };
  let factories = 0;
  const runtime = {
    repository,
    secrets: { googleApiKey: "redacted-google-key", googleSearchEngineId: "fixture-engine" },
    config: { awsPipelineDiscoveryQueueUrl: "discovery", awsPipelineDomainAggregationQueueUrl: "aggregate" },
    artifactStore: {
      async getOptionalValidated({ key }) {
        assert.match(key, /\.result\.json$/u);
        return { outcome: "found", value: {
          contractVersion: "google-probe-result-v1", runId: fixture.runId, generation: 1,
          searchRequestFingerprint: key.match(/\/([a-f0-9]{64})\.result\.json$/u)[1],
          providerConfigFingerprint: fingerprintJson(fixture.awsProviderConfig.googleSearch),
          estimatedTotalResults: 1, nextPageAvailable: false,
          results: [{ rank: 1, url: "https://fixture.myshopify.com/products/item-1",
            title: "Fixture product", snippet: "Fixture specialist" }], rejections: []
        } };
      },
      async putImmutable({ value }) { events.push(value.contractVersion === "confirmed-query-manifest-v1" ? "manifest" : "put"); }
    },
    dispatcher: {
      async sendMany(_queue, messages) { events.push("send"); return { sentItemIds: messages.map((item) => item.itemId), failedItemIds: [] }; },
      async sendOne() { events.push("check"); }
    },
    coordinator: { async recordDispatch() { events.push("dispatch-record"); } }
  };
  const awsConfig = structuredClone(fixture.awsProviderConfig);
  awsConfig.googleSearch.engineIdFingerprint = fingerprintJson({ contractVersion: "google-search-engine-v1",
    searchEngineId: "fixture-engine" });
  const validation = async (config, _status, options) => {
    events.push("validate");
    assert.equal(config.requestTimeoutMs, undefined);
    assert.equal(config.googleResultsPerQuery, 10);
    assert.equal(options.now.toISOString(), producedAt);
    const page = await options.searchPage(rows[0].query);
    assert.equal(page.results[0].query, rows[0].query);
    return { valid: true, rows };
  };
  let loggedError;
  await executeRun({ config: {}, identifier: fixture.runId,
    categories: { items: fixture.categories, phase: "scraping", stage: "queued_query_validation",
      executionBackend: "aws", pipelineGeneration: 1, confirmedQueryRevision: 1,
      queriesConfirmedAt: producedAt, awsProviderConfig: awsConfig, progress: {} },
    lease: { owner: "owner", token: "token" }, queryValidationPipeline: validation,
    repository, logger(_event, fields) { loggedError = fields?.error; }, now: () => new Date(producedAt), leaseDurationMs: 90000,
    heartbeatIntervalMs: 20000, setIntervalFn: () => ({ unref() {} }), clearIntervalFn() {},
    pipelineRuntimeFactory: async () => { factories += 1; return runtime; } });
  assert.equal(factories, 1);
  assert.equal(loggedError, undefined, loggedError?.stack);
  assert.ok(events.indexOf("validate") < events.indexOf("save"));
  assert.ok(events.indexOf("save") < events.indexOf("manifest"));
  assert.ok(events.indexOf("manifest") < events.indexOf("publish"));
  assert.ok(events.indexOf("publish") < events.indexOf("send"));
});

function w6BridgeFixture() {
  const manifest = structuredClone(fixture);
  manifest.queries = [structuredClone(fixture.queries[0])];
  const query = manifest.queries[0];
  query.probeResults = Array.from({ length: 10 }, (_, index) => {
    const rank = index + 1;
    const nn = String(rank).padStart(2, "0");
    return {
      query: query.query,
      rank,
      url: `https://w6-bridge-q001-r${nn}.myshopify.com/products/result-${nn}`,
      title: query.query,
      snippet: query.query,
      rejectionReason: ""
    };
  });
  return manifest;
}

async function runW6BridgeTrial({ sentinel = false } = {}) {
  const manifest = w6BridgeFixture();
  const query = manifest.queries[0];
  const manifestFingerprint = fingerprintJson(manifest);
  const message = {
    version: 1,
    type: "discovery.query",
    runId: manifest.runId,
    stage: "discovery",
    generation: manifest.generation,
    itemId: query.id,
    manifestKey: `runs/${manifest.runId}/queries/manifest.json`,
    manifestFingerprint,
    manifestProducedAt: producedAt,
    attempt: 1
  };
  const expectedUrls = new Map(query.probeResults.map((result) => [
    result.url,
    String(result.rank).padStart(2, "0")
  ]));
  let resolverCalls = 0;
  let fetchCalls = 0;
  let manifestReads = 0;
  let optionalReads = 0;
  let immutableWrites = 0;
  let terminalTransitions = 0;
  let aggregationChecks = 0;
  let artifact;
  let terminalInput;
  let aggregationCheck;
  const deterministicFetch = async (url, config, options) => {
    fetchCalls += 1;
    assert.equal(expectedUrls.has(url), true);
    assert.equal(options.purpose, "storefront");
    assert.deepEqual(options.allowedHostnames, [new URL(url).hostname]);
    assert.equal(config.requestTimeoutMs, manifest.awsProviderConfig.discoveryIdentity.requestTimeoutMs);
    assert.equal(config.browserlessEnabled, false);
    const nn = expectedUrls.get(url);
    return {
      status: 200,
      finalUrl: url,
      contentType: "text/html",
      body: `<!doctype html><html><head><link rel="canonical" href="${url}"><meta name="generator" content="Shopify"></head><body><script>Shopify.theme={};</script><main><h1>${query.query}</h1><a href="/products/result-${nn}">${query.query}</a><img src="https://cdn.shopify.com/w6-fixture.png"></main></body></html>`,
      rendered: false,
      renderAttempted: false,
      renderContractVersion: "",
      fetchAssessment: null
    };
  };
  const sentinelFetch = async () => {
    fetchCalls += 1;
    throw new Error("W6SentinelFetchError");
  };
  const runtime = {
    config: { awsPipelineDomainAggregationQueueUrl: "aggregate" },
    artifactStore: {
      async getValidated() {
        manifestReads += 1;
        return { value: manifest, contentFingerprint: manifestFingerprint };
      },
      async getOptionalValidated() {
        optionalReads += 1;
        return { outcome: "missing" };
      },
      async putImmutable(input) {
        immutableWrites += 1;
        artifact = input.schema.parse(input.value);
        return { contentFingerprint: fingerprintJson(artifact) };
      }
    },
    coordinator: {
      async claimTask() {
        return { outcome: "owned", task: { id: "task_w6_bridge", createdAt: new Date(producedAt) }, stage: {} };
      },
      async renewTask() {
        return { expiresAt: new Date(Date.now() + 60000) };
      },
      async recordTerminal(input) {
        terminalTransitions += 1;
        terminalInput = input;
        return { outcome: "recorded" };
      }
    },
    dispatcher: {
      async sendOne(queue, value, schema) {
        aggregationChecks += 1;
        assert.equal(queue, "aggregate");
        aggregationCheck = schema.parse(value);
        return { sentItemIds: ["check"], failedItemIds: [] };
      }
    }
  };
  const resolver = (result, config) => {
    resolverCalls += 1;
    return resolveStoreIdentity(result, config, {
      fetch: sentinel ? sentinelFetch : deterministicFetch
    });
  };
  const globalFetchBefore = globalThis.fetch;
  const returned = await processDiscoveryMessage(message, runtime, { resolveStoreIdentityFn: resolver });
  assert.equal(globalThis.fetch, globalFetchBefore);
  return {
    manifest,
    query,
    returned,
    artifact,
    terminalInput,
    aggregationCheck,
    resolverCalls,
    fetchCalls,
    manifestReads,
    optionalReads,
    immutableWrites,
    terminalTransitions,
    aggregationChecks
  };
}

function assertW6Db13Oracle(trial) {
  assert.equal(trial.resolverCalls, 10);
  assert.equal(trial.fetchCalls, 10);
  assert.equal(trial.manifestReads, 1);
  assert.equal(trial.optionalReads, 1);
  assert.equal(trial.immutableWrites, 1);
  assert.equal(trial.terminalTransitions, 1);
  assert.equal(trial.aggregationChecks, 1);
  assert.deepEqual(trial.returned, { terminal: true, outcome: "recorded" });
  assert.equal(trial.terminalInput.state, "succeeded");
  assert.equal(trial.aggregationCheck.type, "aggregation.check");
  assert.equal(trial.aggregationCheck.runId, trial.manifest.runId);
  assert.equal(trial.aggregationCheck.stage, "discovery");
  assert.equal(trial.aggregationCheck.generation, trial.manifest.generation);
  assert.equal(trial.aggregationCheck.reason, "terminal_task_recorded");
  assert.equal(trial.artifact.stores.length, 10);
  assert.deepEqual(trial.artifact.diagnostics, []);
  const expectedDomains = trial.query.probeResults.map((result) => new URL(result.url).hostname).sort();
  const stableKeys = trial.artifact.stores.map(({ identity }) => identity.stableKey).sort();
  const myshopifyDomains = trial.artifact.stores.map(({ identity }) => identity.myshopifyDomain).sort();
  assert.equal(new Set(stableKeys).size, 10);
  assert.equal(new Set(myshopifyDomains).size, 10);
  assert.deepEqual(stableKeys, expectedDomains);
  assert.deepEqual(myshopifyDomains, expectedDomains);
  assert.ok(trial.artifact.stores.every(({ identity, candidatePayload }) =>
    identity.stableKey === candidatePayload.stableIdentity &&
    identity.myshopifyDomain === candidatePayload.myshopifyDomain));
}

test("W6-DB-13: discovery enforces the default and injected real resolver boundary", async () => {
  let invalidManifestReads = 0;
  const invalidRuntime = {
    artifactStore: {
      async getValidated() {
        invalidManifestReads += 1;
        throw new Error("manifest read after invalid dependency");
      }
    }
  };
  const invalidDependencies = [
    null,
    [],
    Object.create(null),
    { unknown: true },
    { resolveStoreIdentityFn: "not-a-function" }
  ];
  for (const dependencies of invalidDependencies) {
    await assert.rejects(
      processDiscoveryMessage({}, invalidRuntime, dependencies),
      (error) => error?.code === "PIPELINE_INPUT_CONFLICT"
    );
  }
  assert.equal(invalidManifestReads, 0);
  const source = await readFile(new URL("../src/aws-pipeline/services/discovery-worker.js", import.meta.url), "utf8");
  assert.match(source, /import \{ resolveStoreIdentity \} from "\.\.\/\.\.\/domain-resolver\.js";/u);
  assert.match(source, /const resolveStoreIdentityFn = dependencies\.resolveStoreIdentityFn \?\? resolveStoreIdentity;/u);
  assertW6Db13Oracle(await runW6BridgeTrial());
});

test("W6-NC-22: sentinel resolver falsifies the bridge oracle before a fresh positive", async () => {
  const control = await runW6BridgeTrial({ sentinel: true });
  assert.equal(control.resolverCalls, 10);
  assert.equal(control.artifact.stores.length, 0);
  assert.throws(() => assertW6Db13Oracle(control));
  assertW6Db13Oracle(await runW6BridgeTrial());
  console.log(JSON.stringify({
    certificate: "KI-W6-C153",
    required: 1,
    registered: 1,
    executed: 1,
    activated: 1,
    controlExpected: 1,
    controlFalsified: 1,
    freshPositive: 1,
    cases: ["W6-DB-13"],
    caseDigest: "16c3ae0197bc816cf676cb918ebf93914b30ebd40024966fd0afc0e3b7da3694",
    controls: ["W6-NC-22"],
    controlDigest: "e705d01d6de53d7659e5da3a2d0e44f89e7527206e0788d84d6684fb7361bb20"
  }));
});
