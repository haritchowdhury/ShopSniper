import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../src/aws-pipeline/core/bounded-concurrency.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("mapWithConcurrency preserves positions and enforces its exact maximum", async () => {
  const gates = Array.from({ length: 6 }, deferred);
  let active = 0;
  let maximum = 0;
  const running = mapWithConcurrency(gates, 3, async (gate, index) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active -= 1;
    return `value-${index}`;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 3);
  gates[2].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  gates[3].resolve();
  gates[1].resolve();
  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  gates[5].resolve();
  gates[4].resolve();
  assert.deepEqual(await running, Array.from({ length: 6 }, (_, index) => `value-${index}`));
  assert.equal(maximum, 3);
});

test("mapWithConcurrency validates before side effects and accepts empty input", async () => {
  let calls = 0;
  assert.deepEqual(await mapWithConcurrency([], 1, () => { calls += 1; }), []);
  for (const args of [[null, 1, () => {}], [[], 0, () => {}], [[], 33, () => {}],
    [[], 1.5, () => {}], [[], 1, null]]) {
    await assert.rejects(mapWithConcurrency(...args), { code: "PIPELINE_INPUT_CONFLICT" });
  }
  assert.equal(calls, 0);
});

test("mapWithConcurrency drains started work, stops assignment, and throws lowest failed index", async () => {
  const gates = Array.from({ length: 8 }, deferred);
  const started = [];
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  try {
    const running = mapWithConcurrency(gates, 3, async (gate, index) => {
      started.push(index);
      return gate.promise;
    });
    await new Promise((resolve) => setImmediate(resolve));
    gates[2].reject(new Error("index-two"));
    gates[0].reject(new Error("index-zero"));
    gates[1].resolve("one");
    await assert.rejects(running, /index-zero/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [0, 1, 2]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});
