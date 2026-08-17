import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executeProviderAttempt } from "../src/aws-pipeline/keyword-intelligence/dataforseo-labs-adapter.js";
import { keywordRequestFingerprint } from "../src/aws-pipeline/keyword-intelligence/keys.js";
import {
  KEYWORD_PROVIDER_AMBIGUOUS,
  KEYWORD_PROVIDER_AUTH_FAILED,
  KEYWORD_PROVIDER_BUDGET_EXHAUSTED,
  KEYWORD_PROVIDER_CONTRACT_MISMATCH,
  KEYWORD_PROVIDER_RETRY_EXHAUSTED,
  KEYWORD_PROVIDER_TASK_FAILED
} from "../src/aws-pipeline/keyword-intelligence/contracts.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/keyword-intelligence", import.meta.url));

function readFixture(name) {
  return JSON.parse(readFileSync(`${fixtureDir}/${name}`, "utf8"));
}

const SUGGESTIONS_FIXTURE = readFixture("dataforseo-suggestions-cases-v1.json");
const RELATED_FIXTURE = readFixture("dataforseo-related-cases-v1.json");
const OVERVIEW_FIXTURE = readFixture("dataforseo-overview-cases-v1.json");

const CONFIG = {
  maxCostPerResearchUsd: "3.00000000",
  api: {
    baseUrl: "https://api.dataforseo.com/v3",
    timeoutSeconds: 120,
    retry: {
      maxAttempts: 4,
      retryableStatus: [429, 500, 502, 503, 504],
      retryableApiCodes: [40601, 40602, 50001, 50002, 40107]
    },
    credentials: { login: "login", password: "password" }
  }
};

const NOW = new Date("2026-08-17T00:00:00.000Z");
const fp = (value) => createHash("sha256").update(String(value)).digest("hex");

const SUGGESTION_REQUEST = { keyword: "synthetic keyword one", location_code: 2840, language_code: "en", limit: 30 };
const RELATED_REQUEST = { ...SUGGESTION_REQUEST, depth: 2 };
const OVERVIEW_REQUEST = { keywords: ["synthetic keyword one", "synthetic keyword two"], location_code: 2840, language_code: "en" };

function taskFor(endpointKey, request) {
  return {
    id: "krt_task0000000000000000000001",
    leaseToken: "token0000000000000000000000000",
    endpointKey,
    requestFingerprint: keywordRequestFingerprint(endpointKey, request),
    request
  };
}

function repository(overrides = {}) {
  const calls = { settle: 0, ambiguous: 0, scheduleRetry: 0, deferTask: 0, recordAttempt: 0, throttle: 0, cacheRead: 0 };
  const repo = {
    calls,
    cacheRead: async () => { calls.cacheRead += 1; return { outcome: "not_found" }; },
    claimThrottle: async () => { calls.throttle += 1; return { outcome: "claimed" }; },
    recordAttempt: async () => { calls.recordAttempt += 1; return { outcome: "created", attempt: { attemptNumber: 1 }, mayCall: true }; },
    settleAttempt: async () => { calls.settle += 1; return { outcome: "terminal", attempt: { attemptNumber: 1 } }; },
    markAttemptAmbiguous: async () => { calls.ambiguous += 1; return { outcome: "terminal" }; },
    scheduleRetry: async () => { calls.scheduleRetry += 1; return { outcome: "delayed", retryAt: new Date(NOW.getTime() + 4000) }; },
    deferTask: async () => { calls.deferTask += 1; return { outcome: "delayed", retryAt: new Date(NOW.getTime() + 2000) }; },
    ...overrides
  };
  return repo;
}

function clock() {
  return new Date(NOW.getTime());
}

async function attempt({ endpointKey, request, payload, http, repo = repository() }) {
  const task = taskFor(endpointKey, request);
  const httpImpl = http ?? (async () => ({ status: 200, json: async () => payload }));
  return executeProviderAttempt({ task, config: CONFIG, clock, http: httpImpl, repository: repo });
}

test("adapter parses every suggestions payload certificate", async () => {
  for (const c of SUGGESTIONS_FIXTURE.cases) {
    const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: c.payload });
    if (c.expect === "normalized" || c.expect === "normalized_dedup") {
      assert.equal(result.outcome, "succeeded", c.id);
      assert.ok(Array.isArray(result.normalized.keywords), c.id);
    } else if (c.expect === "normalized_empty") {
      assert.equal(result.outcome, "succeeded", c.id);
      assert.deepEqual(result.normalized.keywords, [], c.id);
    } else if (c.expect === "provider_task_failed") {
      assert.equal(result.outcome, "failed", c.id);
      assert.equal(result.code, KEYWORD_PROVIDER_TASK_FAILED, c.id);
    } else {
      assert.equal(result.outcome, "failed", c.id);
      assert.equal(result.code, KEYWORD_PROVIDER_CONTRACT_MISMATCH, c.id);
    }
  }
});

test("adapter parses every related payload certificate (keyword_data only; no item.keyword alias)", async () => {
  for (const c of RELATED_FIXTURE.cases) {
    const result = await attempt({ endpointKey: "related_keywords", request: RELATED_REQUEST, payload: c.payload });
    if (c.expect === "normalized" || c.expect === "normalized_empty") {
      assert.equal(result.outcome, "succeeded", c.id);
      assert.ok(Array.isArray(result.normalized.keywords), c.id);
    } else {
      assert.equal(result.outcome, "failed", c.id);
      assert.equal(result.code, KEYWORD_PROVIDER_CONTRACT_MISMATCH, c.id);
    }
  }
});

test("adapter parses every overview payload certificate and drops unusable metrics", async () => {
  for (const c of OVERVIEW_FIXTURE.cases) {
    const result = await attempt({ endpointKey: "keyword_overview", request: OVERVIEW_REQUEST, payload: c.payload });
    if (c.expect === "normalized") {
      assert.equal(result.outcome, "succeeded", c.id);
      assert.ok(Array.isArray(result.normalized.metrics), c.id);
    } else if (c.expect === "no_usable_metric") {
      assert.equal(result.outcome, "succeeded", c.id);
      assert.deepEqual(result.normalized.metrics, [], c.id);
    } else {
      assert.equal(result.outcome, "failed", c.id);
      assert.equal(result.code, KEYWORD_PROVIDER_CONTRACT_MISMATCH, c.id);
    }
  }
});

test("adapter preserves provider order and case-insensitive first-occurrence dedup (SG003)", async () => {
  const c = SUGGESTIONS_FIXTURE.cases.find((entry) => entry.id === "SG003");
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: c.payload });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(result.normalized.keywords, ["Synthetic Keyword One", "synthetic keyword two"]);
});

test("adapter moves item-level monthly_searches into keyword_info for normalized overview metrics", async () => {
  const c = OVERVIEW_FIXTURE.cases.find((entry) => entry.id === "OV001");
  const result = await attempt({ endpointKey: "keyword_overview", request: OVERVIEW_REQUEST, payload: c.payload });
  assert.equal(result.outcome, "succeeded");
  const metric = result.normalized.metrics[0];
  assert.equal(metric.keyword, "synthetic keyword one");
  assert.equal(metric.keyword_info.search_volume, 1300);
  assert.equal(metric.keyword_info.monthly_searches.length, 15);
});

test("cache hit performs zero provider attempts and returns normalized cache", async () => {
  const normalized = { keywords: ["cached one"] };
  const repo = repository({ cacheRead: async () => ({ outcome: "found", cache: { normalizedResponse: normalized } }) });
  let httpCalls = 0;
  const http = async () => { httpCalls += 1; throw new Error("must not be called"); };
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "cacheHit");
  assert.deepEqual(result.normalized, normalized);
  assert.equal(httpCalls, 0);
  assert.equal(repo.calls.recordAttempt, 0);
  assert.equal(repo.calls.throttle, 0);
});

test("budget denial creates no attempt row and performs zero HTTP calls", async () => {
  const repo = repository({ recordAttempt: async () => ({ outcome: "conflict", code: KEYWORD_PROVIDER_BUDGET_EXHAUSTED }) });
  let httpCalls = 0;
  const http = async () => { httpCalls += 1; throw new Error("must not be called"); };
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, KEYWORD_PROVIDER_BUDGET_EXHAUSTED);
  assert.equal(result.attempt, null);
  assert.equal(httpCalls, 0);
  assert.equal(repo.calls.settle, 0);
});

test("throttle deferral consumes no attempt and performs no HTTP call", async () => {
  const repo = repository({ claimThrottle: async () => ({ outcome: "delayed", retryAt: new Date(NOW.getTime() + 3000) }) });
  let httpCalls = 0;
  const http = async () => { httpCalls += 1; throw new Error("must not be called"); };
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "retryAt");
  assert.equal(result.reason, "throttled");
  assert.equal(repo.calls.deferTask, 1);
  assert.equal(repo.calls.recordAttempt, 0);
  assert.equal(httpCalls, 0);
});

test("known retryable response settles the failed attempt and schedules a durable retry", async () => {
  let scheduleNumber;
  let settleCount = 0;
  const repo = repository({
    settleAttempt: async (input) => {
      settleCount += 1;
      assert.equal(input.state, "failed");
      return { outcome: "terminal", attempt: { attemptNumber: 1 } };
    },
    scheduleRetry: async (input) => {
      scheduleNumber = input.attemptNumber;
      return { outcome: "delayed", retryAt: new Date(NOW.getTime() + 4000) };
    }
  });
  const http = async () => ({ status: 429, json: async () => ({ status_code: 20000, status_message: "Ok.", tasks: [] }) });
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "retryAt");
  assert.equal(result.reason, "retry");
  assert.equal(settleCount, 1);
  assert.equal(scheduleNumber, 1);
});

test("attempt-five retry exhaustion returns RETRY_EXHAUSTED without a sixth schedule", async () => {
  const repo = repository({
    settleAttempt: async () => ({ outcome: "terminal", attempt: { attemptNumber: 5 } }),
    scheduleRetry: async () => ({ outcome: "conflict", code: KEYWORD_PROVIDER_RETRY_EXHAUSTED })
  });
  const http = async () => ({ status: 500, json: async () => ({ status_code: 20000, status_message: "Ok.", tasks: [] }) });
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, KEYWORD_PROVIDER_RETRY_EXHAUSTED);
});

test("HTTP 401 and root 40100 map to terminal auth failure with reported cost settled", async () => {
  for (const [status, body] of [
    [401, { status_code: 40100, status_message: "Unauthorized." }],
    [200, { status_code: 40100, status_message: "Unauthorized.", cost: 0.0156, tasks: [] }]
  ]) {
    const settled = [];
    const repo = repository({ settleAttempt: async (input) => { settled.push(input); return { outcome: "terminal", attempt: { attemptNumber: 1 } }; } });
    const http = async () => ({ status, json: async () => body });
    const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
    assert.equal(result.outcome, "failed");
    assert.equal(result.code, KEYWORD_PROVIDER_AUTH_FAILED);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].state, "failed");
  }
});

test("transport error after the durable marker marks the attempt ambiguous and never repeats", async () => {
  const repo = repository();
  const http = async () => { throw new Error("network down"); };
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.code, KEYWORD_PROVIDER_AMBIGUOUS);
  assert.equal(repo.calls.ambiguous, 1);
  assert.equal(repo.calls.settle, 0);
});

test("malformed 200 response (billed, no strict response) marks ambiguity", async () => {
  const repo = repository();
  const http = async () => ({ status: 200, json: async () => { throw new SyntaxError("bad json"); } });
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(repo.calls.ambiguous, 1);
});

test("recordAttempt conflict without code fails closed via invariant", async () => {
  const repo = repository({ recordAttempt: async () => ({ outcome: "conflict" }) });
  const http = async () => { throw new Error("must not be called"); };
  await assert.rejects(
    attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo }),
    (error) => error.code === "PIPELINE_INPUT_CONFLICT"
  );
});

test("matching existing nonterminal marker is marked ambiguous with zero calls", async () => {
  const repo = repository({
    recordAttempt: async () => ({ outcome: "found", attempt: { attemptNumber: 1 }, mayCall: false })
  });
  let httpCalls = 0;
  const http = async () => { httpCalls += 1; throw new Error("must not be called"); };
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(repo.calls.ambiguous, 1);
  assert.equal(httpCalls, 0);
});

test("settleAttempt lost fence still reports the known outcome and cost", async () => {
  const repo = repository({ settleAttempt: async () => ({ outcome: "lost", attempt: { attemptNumber: 1 }, fenceActive: false }) });
  const c = SUGGESTIONS_FIXTURE.cases.find((entry) => entry.id === "SG001");
  const http = async () => ({ status: 200, json: async () => c.payload });
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(result.normalized.keywords, ["synthetic keyword one", "synthetic keyword two"]);
});

test("success settles the reported provider cost exactly", async () => {
  let settledInput;
  const repo = repository({
    settleAttempt: async (input) => { settledInput = input; return { outcome: "terminal", attempt: { attemptNumber: 1 } }; }
  });
  const c = SUGGESTIONS_FIXTURE.cases.find((entry) => entry.id === "SG001");
  const http = async () => ({ status: 200, json: async () => c.payload });
  const result = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.providerCostUsd, "0.01560000");
  assert.equal(settledInput.state, "succeeded");
  assert.equal(settledInput.cacheEntry.contractVersion, 1);
  assert.equal(settledInput.cacheEntry.ttlSeconds, 604800);
  assert.equal(settledInput.cacheEntry.endpointKey, "keyword_suggestions");
});

test("overview reservation follows DEC-KI-009 per-keyword formula", async () => {
  const records = [];
  const repo = repository({ recordAttempt: async (input) => { records.push(input.reservationCostUsd); return { outcome: "created", attempt: { attemptNumber: 1 }, mayCall: true }; } });
  const c = OVERVIEW_FIXTURE.cases.find((entry) => entry.id === "OV001");
  const request = { keywords: Array.from({ length: 300 }, (_, i) => `k${i}`), location_code: 2840, language_code: "en" };
  const http = async () => ({ status: 200, json: async () => c.payload });
  await attempt({ endpointKey: "keyword_overview", request, payload: {}, http, repo });
  assert.equal(records[0], (0.012 + 0.00012 * 300).toFixed(8));
});

test("negative control: retry-after-ambiguity would require a second call (call-count oracle)", async () => {
  const repo = repository();
  const http = async () => { throw new Error("down"); };
  const first = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(first.outcome, "ambiguous");
  assert.equal(repo.calls.ambiguous, 1);
  const second = await attempt({ endpointKey: "keyword_suggestions", request: SUGGESTION_REQUEST, payload: {}, http, repo });
  assert.equal(second.outcome, "ambiguous");
  assert.equal(repo.calls.ambiguous, 2);
  assert.equal(repo.calls.recordAttempt, 2);
});
