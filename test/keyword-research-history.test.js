import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  serializeKeywordResearch,
  serializeKeywordResearchSummary,
} from "../src/api-serializer.js";
import { ApiError } from "../src/api-errors.js";
import { createKeywordResearchApi } from "../src/keyword-intelligence/api.js";
import {
  KeywordRepositoryError,
  PrismaKeywordResearchRepository,
} from "../src/keyword-intelligence/repository.js";
import { createLeadServer } from "../src/server.js";

const OWNER = "owner-history-a";
const FOREIGN = "owner-history-b";
const RESEARCH_ID = "kr_abcdefghijklmnopqrstuvwx";
const NOW = new Date("2026-08-26T12:05:00.000Z");
const REQUIRED = [
  "MRR-BE-01", "MRR-BE-02", "MRR-BE-03", "MRR-BE-04", "MRR-BE-05",
  "MRR-DB-01", "MRR-DB-02",
];
const EXPECTED_DIGEST = "fa497b08109ad34bfa8281e0b284d8304103dc7770051ca4c91e781cb317d6e8";
const executed = [];

function digest(ids) {
  return createHash("sha256")
    .update([...ids].sort().map((id) => `${id}\n`).join(""))
    .digest("hex");
}

function row(overrides = {}) {
  return {
    id: RESEARCH_ID,
    seeds: ["independent eyewear"],
    state: "running",
    selectionRevision: 0,
    createdAt: new Date("2026-08-26T12:00:00.000Z"),
    updatedAt: NOW,
    completedAt: null,
    stages: [
      { stage: "expansion", state: "completed", generation: 1 },
      { stage: "anchor_screen", state: "collecting", generation: 1 },
    ],
    ...overrides,
  };
}

function apiFor(items = [row()]) {
  let calls = 0;
  const keywordRepository = {
    async listOwnerWorkspaceResearch(input) {
      calls += 1;
      assert.deepEqual(input, { ownerId: OWNER, page: 1, pageSize: 20 });
      return { totalItems: items.length, items };
    },
  };
  const api = createKeywordResearchApi({
    keywordRepository,
    runRepository: {},
    dispatchInitialize: async () => {},
  });
  return { api, calls: () => calls };
}

function register(id) {
  assert.ok(REQUIRED.includes(id));
  assert.ok(!executed.includes(id));
  executed.push(id);
}

async function withServer(keywordResearchApi, callback) {
  const server = createLeadServer({ backendApiToken: undefined }, {
    keywordResearchApi,
    repository: {},
    logger: () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("MRR-W1 executable backend registry", async (t) => {
  await t.test("MRR-BE-01 exact list fixture and stage derivation", async () => {
    const expected = JSON.parse(readFileSync(
      new URL("./fixtures/keyword-research-history-v1.json", import.meta.url),
      "utf8",
    ));
    const harness = apiFor();
    const actual = await harness.api.listResearch({ ownerId: OWNER, page: 1, pageSize: 20 });
    assert.deepEqual(actual, expected);
    assert.equal(harness.calls(), 1);
    register("MRR-BE-01");
  });

  await t.test("MRR-BE-02 summary excludes full private material", () => {
    const material = row({
      state: "completed",
      completedAt: NOW,
      configSnapshot: { secretLike: "not-for-list" },
      result: { keywords: [{ customer: "not-for-list" }] },
      selection: { items: [{ keyword: "private draft" }] },
    });
    const summary = serializeKeywordResearchSummary(material);
    assert.deepEqual(Object.keys(summary), [
      "researchId", "seeds", "state", "stage", "selectionRevision",
      "createdAt", "updatedAt", "completedAt",
    ]);
    assert.equal(JSON.stringify(summary).includes("not-for-list"), false);
    const full = serializeKeywordResearch({
      ...material,
      generation: 1,
      contractVersion: 1,
      markets: [],
      selectionConflicts: [],
      safeErrorCode: null,
      startedAt: null,
    });
    assert.equal(full.progress.stage, "completed");
    register("MRR-BE-02");
  });

  await t.test("MRR-BE-03 route requires and forwards exactly one owner", async () => {
    const calls = [];
    const api = { async listResearch(input) { calls.push(input); return { pagination: {
      page: 1, pageSize: 20, totalItems: 0, totalPages: 0,
    }, items: [] }; } };
    await withServer(api, async (base) => {
      const anonymous = await fetch(`${base}/api/keyword-research`);
      assert.equal(anonymous.status, 401);
      assert.equal(calls.length, 0);
      const owned = await fetch(`${base}/api/keyword-research`, { headers: { "x-user-id": OWNER } });
      assert.equal(owned.status, 200);
      assert.equal(owned.headers.get("cache-control"), "no-store");
      assert.deepEqual(calls, [{ ownerId: OWNER, page: 1, pageSize: 20 }]);
    });
    register("MRR-BE-03");
  });

  await t.test("MRR-BE-04 repository performs two bounded reads and no writes", async () => {
    const operations = [];
    const client = {
      async $transaction(work, options) {
        operations.push(["transaction", options]);
        return work(this);
      },
      keywordResearch: {
        async count(args) { operations.push(["count", args]); return 100; },
        async findMany(args) { operations.push(["findMany", args]); return []; },
      },
    };
    const repository = new PrismaKeywordResearchRepository(client);
    await repository.listOwnerWorkspaceResearch({ ownerId: OWNER, page: 2, pageSize: 100 });
    assert.deepEqual(operations.map(([name]) => name), ["transaction", "count", "findMany"]);
    assert.deepEqual(operations[0][1], { maxWait: 5_000, timeout: 15_000 });
    assert.equal(operations[2][1].skip, 100);
    assert.equal(operations[2][1].take, 100);
    assert.equal(JSON.stringify(operations).includes("result"), false);
    register("MRR-BE-04");
  });

  await t.test("MRR-BE-05 exact pagination partitions", async () => {
    const calls = [];
    const api = { async listResearch(input) { calls.push(input); return { pagination: {
      page: input.page, pageSize: input.pageSize, totalItems: 0, totalPages: 0,
    }, items: [] }; } };
    await withServer(api, async (base) => {
      for (const query of ["?page=1&pageSize=100", "?page=2&pageSize=1"]) {
        assert.equal((await fetch(`${base}/api/keyword-research${query}`, { headers: { "x-user-id": OWNER } })).status, 200);
      }
      for (const query of [
        "?unknown=1", "?page=1&page=2", "?page=0", "?page=+1", "?page=1.5",
        "?page=%201", "?pageSize=101", "?pageSize=-1", "?pageSize=1&pageSize=2",
      ]) {
        const response = await fetch(`${base}/api/keyword-research${query}`, { headers: { "x-user-id": OWNER } });
        assert.equal(response.status, 400, query);
        assert.equal((await response.json()).error.code, "INVALID_QUERY_PARAMETERS");
      }
    });
    assert.equal(calls.length, 2);
    register("MRR-BE-05");
  });

  await t.test("MRR-DB-01 owner predicate is identical for count and rows", async () => {
    const args = [];
    const client = {
      async $transaction(work) { return work(this); },
      keywordResearch: {
        async count(value) { args.push(value); return 1; },
        async findMany(value) { args.push(value); return [row()]; },
      },
    };
    const result = await new PrismaKeywordResearchRepository(client)
      .listOwnerWorkspaceResearch({ ownerId: OWNER, page: 1, pageSize: 20 });
    const expectedWhere = { ownerId: OWNER, runs: { none: {} } };
    assert.deepEqual(args[0].where, expectedWhere);
    assert.deepEqual(args[1].where, expectedWhere);
    assert.notEqual(args[0].where.ownerId, FOREIGN);
    assert.equal(result.totalItems, 1);
    register("MRR-DB-01");
  });

  await t.test("MRR-DB-02 handoff exclusion and transient empty page", async () => {
    const calls = [];
    const client = {
      async $transaction(work) { return work(this); },
      keywordResearch: {
        async count(args) { calls.push(args); return 1; },
        async findMany(args) { calls.push(args); return []; },
      },
    };
    const result = await new PrismaKeywordResearchRepository(client)
      .listOwnerWorkspaceResearch({ ownerId: OWNER, page: 1, pageSize: 20 });
    assert.deepEqual(calls[0].where.runs, { none: {} });
    assert.deepEqual(calls[1].where.runs, { none: {} });
    assert.deepEqual(calls[1].orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    assert.deepEqual(result, { totalItems: 1, items: [] });
    await assert.rejects(
      () => new PrismaKeywordResearchRepository({ $transaction() { throw new Error("I/O"); } })
        .listOwnerWorkspaceResearch({ ownerId: OWNER, page: 0, pageSize: 20 }),
      KeywordRepositoryError,
    );
    register("MRR-DB-02");
  });
});

test("MRR-W1 execution certificate", () => {
  assert.deepEqual([...executed].sort(), [...REQUIRED].sort());
  assert.equal(new Set(executed).size, REQUIRED.length);
  assert.equal(digest(executed), EXPECTED_DIGEST);
});
