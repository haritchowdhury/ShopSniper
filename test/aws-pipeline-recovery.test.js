import assert from "node:assert/strict";
import test from "node:test";
import { cancelAwsRunGeneration, recoverPipelineWork } from "../src/aws-pipeline/services/recovery.js";
import { main, parseCancellationArguments } from "../scripts/cancel-aws-run.js";

const now = new Date("2026-08-12T12:00:00.000Z");
const stage = (name, suffix) => ({ id: `stage_${suffix}`, runId: `run_recovery_fixture_${suffix}`,
  stage: name, generation: 2, manifestS3Key: `runs/run_recovery_fixture_${suffix}/domains-manifest.json`,
  manifestFingerprint: "a".repeat(64), manifestProducedAt: new Date("2026-08-12T10:00:00.000Z"),
  aggregationAttempt: 2 });
const task = (itemKey, dispatchCount = 1) => ({ id: `task_${itemKey}`, itemKey, dispatchCount });

function runtimeFor(recoverable) {
  const events = [];
  return { events, runtime: { config: { awsPipelineRecoveryAgeMs: 60000,
    awsPipelineDiscoveryQueueUrl: "q-discovery", awsPipelineLeadQueueUrl: "q-lead",
    awsPipelineTrafficQueueUrl: "q-traffic", awsPipelineDomainAggregationQueueUrl: "q-domain-check",
    awsPipelineLeadAggregationQueueUrl: "q-lead-check", awsPipelineFinalAggregationQueueUrl: "q-final-check" },
  repository: { async markStaleDataForSeoRequestsAmbiguous(value) { events.push(["paid", value]); return { count: 2 }; } },
  coordinator: {
    async listRecoverable(input) { events.push(["list", input]); return recoverable; },
    async recordDispatch(input) { events.push(["record", input]); }
  }, dispatcher: {
    async sendMany(queue, messages) { events.push(["many", queue, messages]);
      return { sentItemIds: messages.filter((_, index) => index % 2 === 0).map(({ itemId }) => itemId),
        failedItemIds: messages.filter((_, index) => index % 2 === 1).map(({ itemId }) => itemId),
        results: messages.map(({ itemId }, index) => ({ index, itemId,
          outcome: index % 2 === 0 ? "sent" : "failed" })) }; },
    async sendOne(queue, message) { events.push(["one", queue, message]);
      return { sentItemIds: [message.stage], failedItemIds: [] }; }
  }, artifactStore: new Proxy({}, { get() { throw new Error("S3 forbidden"); } }) } };
}

test("recovery reconstructs exact ordered task/check messages and records only successful dispatches", async () => {
  const discovery = stage("discovery", "0001"); const lead = stage("lead", "0002");
  const traffic = stage("traffic_crux", "0003");
  const { runtime, events } = runtimeFor({ tasks: [{ task: task("query_1", 0), stage: discovery },
    { task: task("shop_1", 3), stage: lead }, { task: task("shop_2", 1), stage: traffic }],
  stages: [discovery, traffic] });
  const result = await recoverPipelineWork({ now, limit: 5 }, runtime);
  assert.deepEqual(result, { tasksScanned: 3, tasksSent: 3, checksScanned: 2,
    checksSent: 2, paidMarkedAmbiguous: 2 });
  const messages = events.filter(([type]) => type === "many").flatMap(([, , values]) => values);
  assert.deepEqual(messages.map(({ type, attempt }) => [type, attempt]),
    [["discovery.query", 1], ["lead.domain", 4], ["traffic.domain", 2]]);
  assert.deepEqual(events.filter(([type]) => type === "one").map(([, queue, value]) =>
    [queue, value.stage, value.attempt]), [["q-domain-check", "discovery", 3],
    ["q-final-check", "traffic_crux", 3]]);
  assert.ok(events.find(([type]) => type === "list")[1].olderThan.getTime() === now.getTime() - 60000);
});

for (const laterOnly of [false, true]) test(`recovery correlates duplicate logical IDs by position (${laterOnly ? "later only" : "both"})`, async () => {
  const first = stage("lead", "collision_1"); const second = stage("lead", "collision_2");
  const { runtime, events } = runtimeFor({ tasks: [{ task: task("shop_collision"), stage: first },
    { task: task("shop_collision"), stage: second }], stages: [] });
  runtime.dispatcher.sendMany = async (_queue, messages) => ({
    sentItemIds: laterOnly ? ["shop_collision"] : ["shop_collision", "shop_collision"],
    failedItemIds: laterOnly ? ["shop_collision"] : [],
    results: messages.map(({ itemId }, index) => ({ index, itemId,
      outcome: laterOnly && index === 0 ? "failed" : "sent" }))
  });
  await recoverPipelineWork({ now }, runtime);
  assert.deepEqual(events.filter(([type]) => type === "record").map(([, value]) => value), laterOnly
    ? [{ stageId: second.id, itemKeys: ["shop_collision"] }]
    : [{ stageId: first.id, itemKeys: ["shop_collision"] },
      { stageId: second.id, itemKeys: ["shop_collision"] }]);
});

test("recovery prevalidates the complete plan before the first send", async () => {
  const invalid = stage("lead", "0004"); invalid.manifestFingerprint = "wrong";
  const { runtime, events } = runtimeFor({ tasks: [{ task: task("shop_1"), stage: invalid }], stages: [] });
  await assert.rejects(recoverPipelineWork({ now }, runtime), (error) => error.code === "PIPELINE_INPUT_CONFLICT");
  assert.equal(events.some(([type]) => ["many", "one", "record"].includes(type)), false);
});

test("recovery validates bounds before durable work", async () => {
  let touched = false; const runtime = { config: { awsPipelineRecoveryAgeMs: 1 }, repository: {
    markStaleDataForSeoRequestsAmbiguous() { touched = true; } } };
  for (const input of [{ now: new Date("invalid") }, { now, limit: 0 }, { now, limit: 101 }])
    await assert.rejects(recoverPipelineWork(input, runtime));
  assert.equal(touched, false);
});

test("cancellation operation calls the coordinator exactly once", async () => {
  let calls = 0; const expected = { run: { state: "cancelled" }, stages: [], tasks: [] };
  assert.deepEqual(await cancelAwsRunGeneration({ runId: "run_cancel_fixture_0001", generation: 2, now }, {
    coordinator: { async cancelRunGeneration(input, value) { calls += 1;
      assert.deepEqual(input, { runId: "run_cancel_fixture_0001", generation: 2 }); assert.equal(value, now); return expected; } } }), expected);
  assert.equal(calls, 1);
});

test("cancellation CLI fails closed before runtime and prints only safe counts", async () => {
  assert.deepEqual(parseCancellationArguments(["--run-id", "run_cancel_fixture_0001", "--generation", "2",
    "--confirm", "run_cancel_fixture_0001:2"]), { runId: "run_cancel_fixture_0001", generation: 2 });
  for (const argv of [[], ["--run-id", "run_cancel_fixture_0001", "--generation", "2", "--confirm", "wrong"],
    ["--run-id", "run_cancel_fixture_0001", "--generation", "0", "--confirm", "run_cancel_fixture_0001:0"]])
    assert.throws(() => parseCancellationArguments(argv));
  let output; let calls = 0;
  await main(["--run-id", "run_cancel_fixture_0001", "--generation", "2", "--confirm", "run_cancel_fixture_0001:2"], {
    async operation() { calls += 1; return { run: { state: "cancelled", safeErrorCode: "PIPELINE_CANCELLED" },
      stages: [{ id: "private" }], tasks: [{ id: "private" }, { id: "private2" }] }; }, write(value) { output = value; } });
  assert.equal(calls, 1); assert.deepEqual(JSON.parse(output), { runId: "run_cancel_fixture_0001", generation: 2,
    stages: 1, tasks: 2, state: "cancelled", safeErrorCode: "PIPELINE_CANCELLED" });
  assert.equal(output.includes("private"), false);
});
