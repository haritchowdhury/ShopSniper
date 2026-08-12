import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dispatchConfirmedQueries } from "../src/aws-pipeline/services/confirmed-query-dispatcher.js";
import { processDiscoveryMessage } from "../src/aws-pipeline/services/discovery-worker.js";
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
