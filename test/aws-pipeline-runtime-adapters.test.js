import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { z } from "zod";
import { NoSuchKey } from "@aws-sdk/client-s3";
import { S3ArtifactStore } from "../src/aws-pipeline/adapters/artifact-store.js";
import { SqsDispatcher } from "../src/aws-pipeline/adapters/queue-dispatcher.js";
import { handleSqsBatch } from "../src/aws-pipeline/adapters/sqs-batch.js";
import { aggregationCheckMessageSchema, workMessageSchema } from "../src/aws-pipeline/contracts/messages.js";
import { pipelineLog } from "../src/aws-pipeline/pipeline-log.js";
import { createPipelineRuntime } from "../src/aws-pipeline/runtime.js";
import { loadAwsPipelineConfig } from "../src/aws-pipeline/runtime-config.js";
import { loadPipelineSecrets } from "../src/aws-pipeline/secrets.js";

const fp = (character) => character.repeat(64);
const valueSchema = z.object({ value: z.string() }).strict();
const identity = {
  contractVersion: 1,
  runId: "run_runtime_adapter_0001",
  stage: "discovery",
  generation: 1,
  itemId: "query_a",
  inputFingerprint: fp("a"),
  producedAt: "2026-08-11T00:00:00.000Z"
};

function stream(...chunks) {
  return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield Buffer.from(chunk); } };
}

function stored(body, metadata, contentLength = Buffer.byteLength(body)) {
  return { Body: stream(body), Metadata: metadata, ContentLength: contentLength };
}

test("AWS config remains inert locally and validates the exact AWS activation surface", () => {
  const local = loadAwsPipelineConfig({ runExecutionBackend: "local", awsPipelineEnabled: false });
  assert.equal(local.awsPipelineActive, false);
  const active = loadAwsPipelineConfig({
    runExecutionBackend: "aws", awsPipelineEnabled: true, awsRegion: "ap-south-2",
    awsPipelineBucket: "fixture-bucket", awsPipelineSecretId: "fixture-secret",
    awsPipelineDiscoveryQueueUrl: "https://sqs.example/discovery",
    awsPipelineDomainAggregationQueueUrl: "https://sqs.example/domain",
    awsPipelineLeadQueueUrl: "https://sqs.example/lead",
    awsPipelineLeadAggregationQueueUrl: "https://sqs.example/lead-aggregation",
    awsPipelineTrafficQueueUrl: "https://sqs.example/traffic",
    awsPipelineFinalAggregationQueueUrl: "https://sqs.example/final"
  });
  assert.equal(active.awsPipelineActive, true);
  assert.throws(() => loadAwsPipelineConfig({ ...active, awsPipelineTrafficQueueUrl: "http://unsafe" }));
  assert.throws(() => loadAwsPipelineConfig({ runExecutionBackend: "aws", awsPipelineEnabled: false }));
});

test("runtime factory stays dependency-free in local mode and preserves the exact return surface", async () => {
  const marker = {};
  const runtime = await createPipelineRuntime({
    baseConfig: { runExecutionBackend: "local", awsPipelineEnabled: false },
    repository: marker,
    log: marker
  });
  assert.deepEqual(Object.keys(runtime), [
    "config", "prisma", "repository", "coordinator", "artifactStore", "dispatcher",
    "secrets", "s3Client", "sqsClient", "secretsClient", "log"
  ]);
  assert.equal(runtime.config.awsPipelineActive, false);
  assert.equal(runtime.repository, marker);
  assert.equal(runtime.log, marker);
  assert.equal(runtime.prisma, undefined);
});

test("S3 immutable writes reconcile exact replay and reject body or metadata drift", async () => {
  let put;
  let existing;
  const client = { async send(command) {
    if (command.constructor.name === "PutObjectCommand") {
      put = command.input;
      if (existing) throw Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } });
      return {};
    }
    return existing;
  } };
  const store = new S3ArtifactStore({ client, bucket: "fixture-bucket", maxBytes: 1000 });
  const first = await store.putImmutable({ ...identity, key: "runs/a.json", value: { value: "ok" }, schema: valueSchema });
  assert.equal(put.IfNoneMatch, "*");
  assert.equal(put.ServerSideEncryption, "AES256");
  assert.equal(put.ContentType, "application/json");
  assert.equal(put.Metadata["content-sha256"], first.contentFingerprint);
  existing = stored(put.Body, put.Metadata);
  assert.deepEqual(await store.putImmutable({ ...identity, key: "runs/a.json", value: { value: "ok" }, schema: valueSchema }), first);
  existing = stored('{"value":"changed"}', put.Metadata);
  await assert.rejects(
    store.putImmutable({ ...identity, key: "runs/a.json", value: { value: "ok" }, schema: valueSchema }),
    (error) => error.code === "PIPELINE_ARTIFACT_CONFLICT"
  );
  existing = stored(put.Body, { ...put.Metadata, stage: "lead" });
  await assert.rejects(
    store.putImmutable({ ...identity, key: "runs/a.json", value: { value: "ok" }, schema: valueSchema }),
    (error) => error.code === "PIPELINE_ARTIFACT_CONFLICT"
  );
});

test("S3 validated reads enforce metadata, canonical bytes, schema, and streaming size bounds", async () => {
  const writer = { async send(command) { this.input = command.input; return {}; } };
  const writingStore = new S3ArtifactStore({ client: writer, bucket: "fixture-bucket", maxBytes: 1000 });
  const written = await writingStore.putImmutable({ ...identity, key: "runs/a.json", value: { value: "ok" }, schema: valueSchema });
  const client = { response: stored(writer.input.Body, writer.input.Metadata), async send() { return this.response; } };
  const store = new S3ArtifactStore({ client, bucket: "fixture-bucket", maxBytes: 1000 });
  assert.deepEqual((await store.getValidated({ key: "runs/a.json", expected: { ...identity, contentFingerprint: written.contentFingerprint }, schema: valueSchema })).value, { value: "ok" });
  client.response = stored("{}", writer.input.Metadata, 1001);
  await assert.rejects(store.getValidated({ key: "runs/a.json", expected: identity, schema: valueSchema }));
  client.response = { Body: stream("123456", "789"), Metadata: writer.input.Metadata };
  const tiny = new S3ArtifactStore({ client, bucket: "fixture-bucket", maxBytes: 8 });
  await assert.rejects(tiny.getValidated({ key: "runs/a.json", expected: identity, schema: valueSchema }));
});

test("optional S3 validated reads distinguish only modeled NoSuchKey from invalid or conflicting artifacts", async () => {
  const writer = { async send(command) { this.input = command.input; return {}; } };
  const writingStore = new S3ArtifactStore({ client: writer, bucket: "fixture-bucket", maxBytes: 1000 });
  const written = await writingStore.putImmutable({
    ...identity, key: "runs/a.json", value: { value: "ok" }, schema: valueSchema
  });
  const expected = { ...identity, contentFingerprint: written.contentFingerprint };
  let result = stored(writer.input.Body, writer.input.Metadata);
  const commands = [];
  const client = { async send(command) {
    commands.push(command.constructor.name);
    if (result instanceof Error) throw result;
    return result;
  } };
  const store = new S3ArtifactStore({ client, bucket: "fixture-bucket", maxBytes: 1000 });

  const validated = await store.getValidated({ key: "runs/a.json", expected, schema: valueSchema });
  assert.deepEqual(await store.getOptionalValidated({ key: "runs/a.json", expected, schema: valueSchema }), {
    outcome: "found", ...validated
  });

  result = new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: "fixture missing" });
  assert.deepEqual(await store.getOptionalValidated({ key: "runs/a.json", expected, schema: valueSchema }), {
    outcome: "missing"
  });

  const invalidErrors = [
    Object.assign(new Error("fixture look-alike"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error("fixture generic 404"), { $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error("fixture denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error("fixture network"), { name: "TimeoutError" })
  ];
  for (const error of invalidErrors) {
    result = error;
    await assert.rejects(
      store.getOptionalValidated({ key: "runs/a.json", expected, schema: valueSchema }),
      (caught) => caught.code === "PIPELINE_ARTIFACT_INVALID"
    );
  }

  for (const body of ["not-json", '{"value": "ok"}', '{"value":1}']) {
    result = stored(body, writer.input.Metadata);
    await assert.rejects(
      store.getOptionalValidated({ key: "runs/a.json", expected, schema: valueSchema }),
      (error) => error.code === "PIPELINE_ARTIFACT_INVALID"
    );
  }
  result = { Metadata: writer.input.Metadata };
  await assert.rejects(
    store.getOptionalValidated({ key: "runs/a.json", expected, schema: valueSchema }),
    (error) => error.code === "PIPELINE_ARTIFACT_INVALID"
  );
  result = { Body: { async *[Symbol.asyncIterator]() { throw new Error("fixture stream failure"); } },
    Metadata: writer.input.Metadata };
  await assert.rejects(
    store.getOptionalValidated({ key: "runs/a.json", expected, schema: valueSchema }),
    (error) => error.code === "PIPELINE_ARTIFACT_INVALID"
  );

  result = stored(writer.input.Body, { ...writer.input.Metadata, stage: "lead" });
  await assert.rejects(
    store.getOptionalValidated({ key: "runs/a.json", expected, schema: valueSchema }),
    (error) => error.code === "PIPELINE_ARTIFACT_CONFLICT"
  );
  result = stored(writer.input.Body, writer.input.Metadata);
  await assert.rejects(
    store.getOptionalValidated({ key: "runs/a.json", expected: { ...expected, contentFingerprint: fp("f") }, schema: valueSchema }),
    (error) => error.code === "PIPELINE_ARTIFACT_CONFLICT"
  );

  const tiny = new S3ArtifactStore({ client, bucket: "fixture-bucket", maxBytes: 8 });
  result = stored("{}", writer.input.Metadata, 9);
  await assert.rejects(
    tiny.getOptionalValidated({ key: "runs/a.json", expected, schema: valueSchema }),
    (error) => error.code === "PIPELINE_ARTIFACT_INVALID"
  );
  result = { Body: stream("123456", "789"), Metadata: writer.input.Metadata };
  await assert.rejects(
    tiny.getOptionalValidated({ key: "runs/a.json", expected, schema: valueSchema }),
    (error) => error.code === "PIPELINE_ARTIFACT_INVALID"
  );
  assert.ok(commands.every((name) => name === "GetObjectCommand"));
});

function work(index) {
  return { version: 1, type: "discovery.query", runId: "run_runtime_adapter_0001",
    stage: "discovery", generation: 1, itemId: `query_${index}`,
    manifestKey: "runs/manifest.json", manifestFingerprint: fp("b"),
    manifestProducedAt: "2026-08-11T00:00:00.000Z", attempt: 1 };
}

test("SQS dispatcher chunks ten with deterministic IDs and retains partial recovery", async () => {
  const commands = [];
  const client = { async send(command) {
    commands.push(command.input);
    return { Successful: command.input.Entries.filter((_, index) => index !== 2).map(({ Id }) => ({ Id })),
      Failed: command.input.Entries.filter((_, index) => index === 2).map(({ Id }) => ({ Id })) };
  } };
  const dispatcher = new SqsDispatcher({ client });
  const result = await dispatcher.sendMany("https://sqs.example/queue", Array.from({ length: 12 }, (_, index) => work(index)), workMessageSchema);
  assert.deepEqual(commands.map(({ Entries }) => Entries.length), [10, 2]);
  assert.deepEqual(commands.flatMap(({ Entries }) => Entries.map(({ Id }) => Id)), Array.from({ length: 12 }, (_, index) => `m${String(index).padStart(4, "0")}`));
  assert.deepEqual(result.failedItemIds, ["query_2"]);
  assert.equal(result.sentItemIds.length, 11);
  assert.ok(commands.every((command) => command.Entries.every(({ MessageBody }) => !MessageBody.includes("credential"))));
});

test("SQS single and whole-batch failures return recoverable logical IDs", async () => {
  const client = { async send() { throw new Error("network"); } };
  const dispatcher = new SqsDispatcher({ client });
  assert.deepEqual(await dispatcher.sendOne("https://sqs.example/q", work(1), workMessageSchema), {
    sentItemIds: [], failedItemIds: ["query_1"]
  });
  const check = { version: 1, type: "aggregation.check", runId: "run_runtime_adapter_0001",
    stage: "discovery", generation: 1, reason: "recovery", attempt: 1 };
  assert.deepEqual(await dispatcher.sendMany("https://sqs.example/q", [check], aggregationCheckMessageSchema), {
    sentItemIds: [], failedItemIds: ["run_runtime_adapter_0001:discovery:1:recovery"]
  });
});

test("mixed SQS batches isolate malformed and nonterminal records while accepting terminal replay", async () => {
  const event = { Records: [
    { messageId: "a", body: JSON.stringify({ result: "ok" }) },
    { messageId: "b", body: "{" },
    { messageId: "c", body: JSON.stringify({ result: "retry" }) },
    { messageId: "d", body: JSON.stringify({ result: "terminal" }) }
  ] };
  const result = await handleSqsBatch(event, async (message) => {
    if (message.result === "retry") return { terminal: false };
    if (message.result === "terminal") throw Object.assign(new Error("replay"), { terminal: true });
    return { terminal: true };
  });
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: "b" }, { itemIdentifier: "c" }] });
});

function secret(overrides = {}) {
  return JSON.stringify({
    DATABASE_URL: "postgresql://fixture-user:fixture-password@example.invalid/db",
    GOOGLE_API_KEY: "fixture-google-key", GOOGLE_SEARCH_ENGINE_ID: "fixture-engine",
    BROWSERLESS_TOKEN: "fixture-browserless", BROWSERLESS_FALLBACK_TOKEN: "fixture-fallback",
    DATAFORSEO_LOGIN: "fixture-login", DATAFORSEO_PASSWORD: "fixture-password",
    CRUX_API_KEY: "fixture-crux", CRUX_BIGQUERY_PROJECT_ID: "fixture-project",
    GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({ client_email: "fixture@example.invalid",
      private_key: "fixture-private-key", project_id: "fixture-project" }), ...overrides
  });
}

test("Secrets Manager parsing is strict, cached per client/id, and failures are not cached", async () => {
  let calls = 0;
  const client = { async send() { calls += 1; return { SecretString: secret() }; } };
  const [first, second] = await Promise.all([
    loadPipelineSecrets({ client, secretId: "fixture" }), loadPipelineSecrets({ client, secretId: "fixture" })
  ]);
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(first.googleApplicationCredentials.project_id, "fixture-project");
  await loadPipelineSecrets({ client, secretId: "other" });
  assert.equal(calls, 2);
  const failing = { async send() { calls += 1; return { SecretString: secret({ UNKNOWN: "rejected" }) }; } };
  await assert.rejects(loadPipelineSecrets({ client: failing, secretId: "bad" }), (error) => error.code === "PIPELINE_CONTRACT_DRIFT" && error.message === error.code);
  await assert.rejects(loadPipelineSecrets({ client: failing, secretId: "bad" }));
  assert.equal(calls, 4);
});

test("pipeline logs use the exact allowlist and runtime modules import without I/O", () => {
  let output;
  const record = pipelineLog("fixture", { runId: "run_runtime_adapter_0001", outcome: "ok",
    password: "redacted", html: "redacted", email: "redacted" }, (line) => { output = line; });
  assert.deepEqual(record, { event: "fixture", runId: "run_runtime_adapter_0001", outcome: "ok" });
  assert.equal(output.includes("redacted"), false);
  const imported = spawnSync(process.execPath, ["--input-type=module", "--eval",
    'await import("./src/aws-pipeline/runtime.js");await import("./src/aws-pipeline/secrets.js");'],
  { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
});
