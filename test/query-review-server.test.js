import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { QueryRevisionConflictError } from "../src/api-errors.js";
import { createLeadServer } from "../src/server.js";

class ReviewRepository {
  constructor() {
    this.run = null;
    this.queries = [];
  }

  async health() {}
  async recoverExpiredRuns() { return { count: 0 }; }
  async createRun(ownerId, normalizedShopTypes) {
    this.run = {
      id: "run_queryreviewfixture",
      ownerId,
      state: "queued",
      phase: "query_planning",
      stage: "queued_query_planning",
      normalizedShopTypes,
      queryRevision: 0,
      confirmedQueryRevision: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      startedAt: null,
      completedAt: null,
      progress: { shopTypesTotal: normalizedShopTypes.length },
      resultsAvailable: false,
      safeErrorCode: null,
      safeErrorMessage: null,
      pipelineVersion: 2,
      scoringVersion: 2
    };
    return this.run;
  }
  async claimNextQueuedRun(owner, now, duration) {
    if (this.run?.state !== "queued") return null;
    this.run.state = "running";
    this.run.startedAt ||= now;
    this.run.leaseOwner = owner;
    this.run.leaseToken = "lease_review_fixture";
    this.run.leaseExpiresAt = new Date(now.getTime() + duration);
    return {
      run: { ...this.run },
      lease: { owner, token: this.run.leaseToken, expiresAt: this.run.leaseExpiresAt }
    };
  }
  assertLease(lease) {
    assert.equal(this.run.state, "running");
    assert.equal(this.run.leaseToken, lease.token);
  }
  async updateProgress(_id, lease, status) {
    this.assertLease(lease);
    this.run.stage = status.stage;
    this.run.progress = { ...status };
  }
  async heartbeatRun(_id, lease, now, duration) {
    this.assertLease(lease);
    this.run.leaseExpiresAt = new Date(now.getTime() + duration);
  }
  async saveGeneratedQueryPlan(_id, lease, planning) {
    this.assertLease(lease);
    this.queries = planning.selected.map((query, sequence) => ({
      id: `query_fixture_${sequence}`,
      categoryIndex: 0,
      sequence,
      query: query.query,
      source: "generated",
      validationState: "valid",
      rejectionReason: null,
      queryScore: query.queryScore,
      generationReason: query.queryGenerationReason,
      categoryVocabulary: query.categoryVocabulary,
      probedAt: new Date("2026-08-01T00:00:00.000Z")
    }));
    Object.assign(this.run, {
      state: "awaiting_query_confirmation",
      phase: "query_review",
      stage: "awaiting_query_confirmation",
      queryRevision: 1,
      leaseToken: null
    });
  }
  async getEditableQueries(id, ownerId) {
    return this.run?.id === id && this.run.ownerId === ownerId
      ? { ...this.run, queries: this.queries.map((row) => ({ ...row })) }
      : null;
  }
  async replaceEditableQueries(id, ownerId, revision, queries) {
    if (!await this.getEditableQueries(id, ownerId)) return null;
    if (revision !== this.run.queryRevision) {
      throw new QueryRevisionConflictError(this.run.queryRevision);
    }
    this.run.queryRevision += 1;
    this.queries = queries.map((row, sequence) => ({
      id: row.id || `query_added_${sequence}`,
      categoryIndex: row.categoryIndex,
      sequence,
      query: row.query,
      source: "user_edited",
      validationState: "pending",
      rejectionReason: null,
      queryScore: null,
      generationReason: null,
      categoryVocabulary: ["eyewear", "frames"],
      probedAt: null
    }));
    return this.getEditableQueries(id, ownerId);
  }
  async confirmQueryRevision(id, ownerId, revision) {
    if (!await this.getEditableQueries(id, ownerId)) return null;
    if (revision !== this.run.queryRevision) {
      throw new QueryRevisionConflictError(this.run.queryRevision);
    }
    Object.assign(this.run, {
      state: "queued",
      phase: "scraping",
      stage: "queued_query_validation",
      confirmedQueryRevision: revision
    });
    return this.run;
  }
  async loadConfirmedQueryPlans(_id, lease) {
    this.assertLease(lease);
    return this.queries.map((row) => ({ ...row }));
  }
  async saveQueryValidation(_id, lease, rows) {
    this.assertLease(lease);
    this.queries = rows.map((row) => ({ ...row }));
  }
  async returnRunToQueryReview(_id, lease) {
    this.assertLease(lease);
    this.run.state = "awaiting_query_confirmation";
    this.run.phase = "query_review";
    this.run.stage = "awaiting_query_confirmation";
    this.run.leaseToken = null;
  }
  async saveCompletedResults(_id, lease, result) {
    this.assertLease(lease);
    Object.assign(this.run, {
      state: "completed",
      phase: "finished",
      stage: "completed",
      completedAt: new Date("2026-08-01T00:01:00.000Z"),
      resultsAvailable: true,
      leadSummary: result.summary
    });
  }
  async markFailed() { throw new Error("unexpected failure"); }
  async getRun(id, ownerId) {
    return this.run?.id === id && this.run.ownerId === ownerId
      ? { ...this.run, queries: this.queries }
      : null;
  }
}

const headers = { "content-type": "application/json", "x-user-id": "owner_fixture" };

async function waitFor(base, runId, state) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${base}/api/runs/${runId}`, {
      headers: { "x-user-id": "owner_fixture" }
    });
    const body = await response.json();
    if (body.state === state) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run did not reach ${state}`);
}

test("HTTP workflow pauses for a durable revision and scrapes exactly the confirmed list", async (context) => {
  const repository = new ReviewRepository();
  let discoveryQueries;
  const server = createLeadServer({
    googleApiKey: "fixture",
    googleSearchEngineId: "fixture",
    openaiApiKey: "fixture",
    maxShopTypes: 10,
    maxQueries: 50,
    runRateLimitMax: 5,
    queryConfirmRateLimitMax: 5
  }, {
    repository,
    logger: () => {},
    planningPipeline: async () => ({
      selected: [{
        originalShopType: "Eyewear",
        shopType: "eyewear",
        businessQualifier: "unspecified",
        categoryVocabulary: ["eyewear", "frames"],
        query: "site:myshopify.com/products acetate eyewear frames",
        queryScore: 90,
        queryGenerationReason: "fixture",
        results: []
      }],
      audits: []
    }),
    queryValidationPipeline: async (_config, _status, { rows, categories }) => ({
      valid: true,
      rows: rows.map((row) => ({ ...row, validationState: "valid" })),
      queryPlans: rows.map((row) => ({
        ...categories[row.categoryIndex],
        query: row.query,
        results: []
      }))
    }),
    discoveryPipeline: async (_config, _status, { queryPlans }) => {
      discoveryQueries = queryPlans.map(({ query }) => query);
      return {
        leads: [],
        summary: { total: 0, qualified: 0, rejected: 0, failed: 0 }
      };
    },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {}
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await (await fetch(`${base}/api/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ shopTypes: ["Eyewear"] })
  })).json();
  assert.equal(created.queriesUrl, `/api/runs/${created.runId}/queries`);
  await waitFor(base, created.runId, "awaiting_query_confirmation");

  const draft = await (await fetch(`${base}${created.queriesUrl}`, {
    headers: { "x-user-id": "owner_fixture" }
  })).json();
  assert.equal(draft.revision, 1);
  assert.equal(draft.editable, true);

  const editedQuery = "site:myshopify.com/products round eyewear frames";
  const savedResponse = await fetch(`${base}${created.queriesUrl}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      revision: draft.revision,
      queries: [{ id: draft.queries[0].id, categoryIndex: 0, query: editedQuery }]
    })
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.revision, 2);

  const stale = await fetch(`${base}${created.queriesUrl}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      revision: 1,
      queries: saved.queries.map(({ id, categoryIndex, query }) => ({
        id,
        categoryIndex,
        query
      }))
    })
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "QUERY_REVISION_CONFLICT");

  const started = await fetch(`${base}/api/runs/${created.runId}/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({ revision: saved.revision })
  });
  assert.equal(started.status, 202);
  await waitFor(base, created.runId, "completed");
  assert.deepEqual(discoveryQueries, [editedQuery]);

  const foreign = await fetch(`${base}${created.queriesUrl}`, {
    headers: { "x-user-id": "another_owner" }
  });
  assert.equal(foreign.status, 404);
});
