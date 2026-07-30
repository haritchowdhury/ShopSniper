import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createLeadServer } from "../src/server.js";

test("server exposes health, status, asynchronous run, and conflict control", async (context) => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const config = {
    googleApiKey: "test",
    googleSearchEngineId: "test",
    openaiApiKey: "test"
  };
  const server = createLeadServer(config, {
    pipeline: async (_config, status) => {
      status.queriesTotal = 1;
      await blocked;
      status.queriesProcessed = 1;
      status.outputRows = 0;
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const started = await fetch(`${base}/run`, { method: "POST" });
  assert.equal(started.status, 202);
  const accepted = await started.json();
  assert.equal(accepted.state, "running");
  assert(accepted.runId);

  const conflict = await fetch(`${base}/run`, { method: "POST" });
  assert.equal(conflict.status, 409);

  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finalStatus = await (await fetch(`${base}/status`)).json();
  assert.equal(finalStatus.state, "completed");
  assert.equal(finalStatus.stage, "completed");
  assert.equal(finalStatus.queriesProcessed, 1);
});
