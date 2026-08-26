import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError } from "../src/api-errors.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { recoverKeywordWork } from "../src/aws-pipeline/keyword-intelligence/recovery.js";
import { createKeywordResearchApi } from "../src/keyword-intelligence/api.js";
import { keywordResearchConfigV1 } from "../src/keyword-intelligence/config.js";
import { createLeadServer } from "../src/server.js";

const fixturePath = fileURLToPath(new URL(
  "./fixtures/keyword-intelligence/landing-keyword-auth-intent-v1.json",
  import.meta.url
));
const FIXTURE = JSON.parse(readFileSync(fixturePath, "utf8"));

const NOW = new Date("2026-08-26T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-08-26T13:00:00.000Z");
const OWNER = "owner_fixture";
const OTHER_OWNER = "owner_other";
const INTENT_ID = FIXTURE.valid.createResponse.intentId;
const RESEARCH_ID = FIXTURE.valid.claimCreatedResponse.research.id;
const CONFIG = keywordResearchConfigV1();

const REQUIRED_CASES = Object.freeze([
  "LKAI-BE-01",
  "LKAI-BE-02",
  "LKAI-BE-03",
  "LKAI-BE-04",
  "LKAI-BE-05",
  "LKAI-BE-06",
  "LKAI-BE-07"
]);
const UNIT_REQUIRED_CONTROLS = Object.freeze([
  "LKAI-NC-01",
  "LKAI-NC-03"
]);

const registered = new Set();
const executed = [];
const activationWitnesses = [];
const falsifiedControls = new Set();

function utf8Compare(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function digestOf(ids) {
  return createHash("sha256")
    .update([...ids].sort(utf8Compare).map((id) => `${id}\n`).join(""), "utf8")
    .digest("hex");
}

function makeQueuedResearch({
  id = RESEARCH_ID,
  ownerId = OWNER,
  seeds = ["independent eyewear"],
  markets = CONFIG.markets,
  configSnapshot = CONFIG,
  configFingerprint = fingerprintJson(configSnapshot),
  at = NOW
} = {}) {
  return {
    id,
    ownerId,
    state: "queued",
    generation: 1,
    contractVersion: 1,
    configSnapshot,
    configFingerprint,
    seeds,
    markets,
    selection: { items: [] },
    selectionRevision: 0,
    selectionConflicts: [],
    safeErrorCode: null,
    safeErrorMessage: null,
    createdAt: at,
    startedAt: null,
    completedAt: null,
    updatedAt: at,
    stages: [],
    result: null
  };
}

class IntentRepositoryFake {
  constructor({
    claimOutcome = "created",
    ownerId = OWNER,
    anonymousDispatchDefect = false,
    ignoreOwnerDefect = false
  } = {}) {
    this.claimOutcome = claimOutcome;
    this.ownerId = ownerId;
    this.anonymousDispatchDefect = anonymousDispatchDefect;
    this.ignoreOwnerDefect = ignoreOwnerDefect;
    this.onAnonymousIntentCreated = null;
    this.intent = null;
    this.research = null;
    this.log = [];
    this.calls = {
      create: 0,
      createIntent: 0,
      claimIntent: 0,
      deleteExpiredIntents: 0
    };
  }

  async create(input, at) {
    this.calls.create += 1;
    this.log.push(["research.commit", input.researchId]);
    this.research = makeQueuedResearch({
      id: input.researchId,
      ownerId: input.ownerId,
      seeds: input.seeds,
      markets: input.markets,
      configSnapshot: input.configSnapshot,
      configFingerprint: input.configFingerprint,
      at
    });
    return { outcome: "created", research: this.research };
  }

  async createIntent(input, at) {
    this.calls.createIntent += 1;
    this.log.push(["intent.commit", input.intentId]);
    this.intent = {
      id: input.intentId,
      seeds: [...input.seeds],
      createdAt: at,
      expiresAt: input.expiresAt,
      claimedAt: null,
      claimedByUserId: null,
      claimedResearchId: null
    };
    if (this.anonymousDispatchDefect) {
      await this.onAnonymousIntentCreated?.();
    }
    return { outcome: "created", intent: this.intent };
  }

  async deleteExpiredIntents(at) {
    this.calls.deleteExpiredIntents += 1;
    this.log.push(["intent.cleanup", at.toISOString()]);
    return { count: 0 };
  }

  async claimIntent(input, at) {
    this.calls.claimIntent += 1;
    this.log.push(["claim.transaction", input.ownerId, input.intentId]);
    if (this.claimOutcome === "not_found" ||
        (!this.ignoreOwnerDefect && input.ownerId !== this.ownerId)) {
      return { outcome: "not_found" };
    }
    if (this.claimOutcome === "conflict") return { outcome: "conflict" };
    if (!this.research) {
      this.research = makeQueuedResearch({
        id: input.researchId,
        ownerId: input.ownerId,
        seeds: this.intent?.seeds ?? ["independent eyewear"],
        markets: input.markets,
        configSnapshot: input.configSnapshot,
        configFingerprint: input.configFingerprint,
        at
      });
    }
    if (this.claimOutcome === "created") {
      this.intent ??= {
        id: input.intentId,
        seeds: ["independent eyewear"],
        createdAt: NOW,
        expiresAt: EXPIRES_AT,
        claimedAt: null,
        claimedByUserId: null,
        claimedResearchId: null
      };
      Object.assign(this.intent, {
        seeds: [],
        claimedAt: at,
        claimedByUserId: input.ownerId,
        claimedResearchId: input.researchId
      });
      this.log.push(["claim.commit", input.researchId]);
      return { outcome: "created", research: this.research };
    }
    return { outcome: "found", research: this.research };
  }
}

function makeApi({ repository = new IntentRepositoryFake(), dispatch } = {}) {
  const sent = [];
  const dispatchInitialize = async (message) => {
    sent.push(message);
    repository.log.push(["dispatch", message.researchId]);
    await dispatch?.(message);
  };
  repository.onAnonymousIntentCreated = async () => dispatchInitialize({
    contractVersion: 1,
    type: "keyword.initialize.v1",
    researchId: RESEARCH_ID,
    generation: 1
  });
  const api = createKeywordResearchApi({
    keywordRepository: repository,
    runRepository: {},
    now: () => NOW,
    intentIdFactory: () => INTENT_ID,
    researchIdFactory: () => RESEARCH_ID,
    dispatchInitialize
  });
  return { api, repository, sent };
}

class ServerRepositoryFake {
  async health() { return {}; }
  async claimNextQueuedRun() { return null; }
}

async function withServer(keywordResearchApi, operation, overrides = {}) {
  const server = createLeadServer({ backendApiToken: undefined }, {
    repository: overrides.repository ?? new ServerRepositoryFake(),
    keywordResearchApi,
    now: overrides.now,
    logger: () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {}
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function isInputInvalid(error) {
  return error instanceof ApiError &&
    error.status === 400 &&
    error.code === "KEYWORD_RESEARCH_INPUT_INVALID";
}

function isIntentNotFound(error) {
  return error instanceof ApiError &&
    error.status === 404 &&
    error.code === "KEYWORD_RESEARCH_INTENT_NOT_FOUND" &&
    error.message === FIXTURE.errors.intentNotFound.error.message;
}

async function runCase(t, id, body) {
  assert.equal(REQUIRED_CASES.includes(id), true, `unexpected case ${id}`);
  assert.equal(registered.has(id), false, `duplicate registration ${id}`);
  registered.add(id);
  await t.test(id, async () => {
    await body();
    activationWitnesses.push(id);
    executed.push(id);
  });
}

const CASES = {
  "LKAI-BE-01": async () => {
    for (const request of [
      FIXTURE.valid.createRequests.oneSeed,
      FIXTURE.valid.createRequests.fiveSeeds,
      FIXTURE.valid.createRequests.normalized.input
    ]) {
      const harness = makeApi();
      const created = await harness.api.createIntent(request);
      assert.deepEqual(created, FIXTURE.valid.createResponse);
      assert.equal(harness.repository.calls.createIntent, 1, "one durable intent insert");
      assert.equal(harness.repository.calls.create, 0, "anonymous create cannot create research");
      assert.equal(harness.sent.length, 0, "anonymous create cannot dispatch");
      assert.equal(
        harness.repository.intent.expiresAt.getTime() - harness.repository.intent.createdAt.getTime(),
        3_600_000,
        "intent expiry is exactly one hour"
      );
    }
    const normalized = makeApi();
    await normalized.api.createIntent(FIXTURE.valid.createRequests.normalized.input);
    assert.deepEqual(
      normalized.repository.intent.seeds,
      FIXTURE.valid.createRequests.normalized.output,
      "intent persists only normalized seeds"
    );

    const routeHarness = makeApi();
    await withServer(routeHarness.api, async (base) => {
      const response = await fetch(`${base}/api/keyword-research-intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(FIXTURE.valid.createRequests.oneSeed)
      });
      assert.equal(response.status, 201, "anonymous intent creation needs no X-User-Id");
      assert.deepEqual(await response.json(), FIXTURE.valid.createResponse, "strict create response fixture");
    });
    assert.equal(routeHarness.repository.calls.createIntent, 1);
    assert.equal(routeHarness.repository.calls.create, 0);
    assert.equal(routeHarness.sent.length, 0, "HTTP anonymous creation cannot dispatch");

    const legacyAcceptedAt = new Date("2026-08-26T12:34:56.789Z");
    const legacyCalls = { create: [], cleanup: [] };
    const legacyRepository = new ServerRepositoryFake();
    legacyRepository.createRunIntent = async (shopTypes, expiresAt) => {
      legacyCalls.create.push({ shopTypes, expiresAt });
      return { id: INTENT_ID, expiresAt };
    };
    legacyRepository.deleteExpiredRunIntents = async (timestamp) => {
      legacyCalls.cleanup.push(timestamp);
      return { count: 0 };
    };
    const legacyKeywordHarness = makeApi();
    await withServer(legacyKeywordHarness.api, async (base) => {
      const response = await fetch(`${base}/api/run-intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shopTypes: ["eyewear"] })
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.intentId, INTENT_ID);
      assert.equal(
        new Date(body.expiresAt).getTime() - legacyAcceptedAt.getTime(),
        3_600_000,
        "legacy intent expiry uses the single accepted Date timestamp"
      );
    }, {
      repository: legacyRepository,
      now: () => legacyAcceptedAt
    });
    assert.equal(legacyCalls.create.length, 1);
    assert.deepEqual(legacyCalls.create[0].shopTypes, [{
      shopType: "eyewear",
      originalShopType: "eyewear",
      businessQualifier: "unspecified"
    }]);
    assert.equal(legacyCalls.create[0].expiresAt.getTime(), legacyAcceptedAt.getTime() + 3_600_000);
    assert.equal(legacyCalls.cleanup.length, 1);
    assert.equal(
      legacyCalls.cleanup[0].getTime(),
      legacyCalls.create[0].expiresAt.getTime() - 3_600_000,
      "cleanup receives the same accepted timestamp used by the expiry formula"
    );
    assert.equal(legacyKeywordHarness.sent.length, 0, "legacy intent creation cannot dispatch keyword work");
  },

  "LKAI-BE-02": async () => {
    for (const invalid of FIXTURE.invalid.createRequests) {
      const harness = makeApi();
      await assert.rejects(
        harness.api.createIntent(invalid.body),
        isInputInvalid,
        invalid.name
      );
      assert.equal(harness.repository.calls.createIntent, 0, `${invalid.name}: zero intent writes`);
      assert.equal(harness.repository.calls.create, 0, `${invalid.name}: zero research writes`);
      assert.equal(harness.sent.length, 0, `${invalid.name}: zero dispatches`);
    }

    const routeApi = {
      calls: 0,
      async claimIntent() { this.calls += 1; }
    };
    await withServer(routeApi, async (base) => {
      for (const intentId of FIXTURE.invalid.claimIntentIds) {
        const response = await fetch(
          `${base}/api/keyword-research-intents/${intentId}/claim`,
          { method: "POST", headers: { "x-user-id": OWNER } }
        );
        assert.equal(response.status, 400, `malformed claim ID ${intentId}`);
        assert.equal((await response.json()).error.code, "KEYWORD_RESEARCH_INPUT_INVALID");
      }
      const nonemptyBody = await fetch(
        `${base}/api/keyword-research-intents/${encodeURIComponent(INTENT_ID)}/claim`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-user-id": OWNER },
          body: "{}"
        }
      );
      assert.equal(nonemptyBody.status, 400, "claim body must be absent");
      assert.equal((await nonemptyBody.json()).error.code, "KEYWORD_RESEARCH_INPUT_INVALID");
    });
    assert.equal(routeApi.calls, 0, "malformed paths never reach the intent service");
  },

  "LKAI-BE-03": async () => {
    const harness = makeApi();
    await withServer(harness.api, async (base) => {
      const unauthenticated = await fetch(`${base}/api/keyword-research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(FIXTURE.valid.createRequests.oneSeed)
      });
      assert.equal(unauthenticated.status, 401);
      assert.equal((await unauthenticated.json()).error.code, "USER_CONTEXT_REQUIRED");

      const response = await fetch(`${base}/api/keyword-research`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify(FIXTURE.valid.createRequests.oneSeed)
      });
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ["research"], "direct-create envelope remains byte/field compatible");
      assert.equal(body.research.id, RESEARCH_ID);
      assert.equal(body.research.statusUrl, `/api/keyword-research/${RESEARCH_ID}`);
    });
    assert.equal(harness.repository.calls.create, 1);
    assert.deepEqual(harness.sent, [{
      contractVersion: 1,
      type: "keyword.initialize.v1",
      researchId: RESEARCH_ID,
      generation: 1
    }]);
    assert.deepEqual(harness.repository.log.slice(0, 2), [
      ["research.commit", RESEARCH_ID],
      ["dispatch", RESEARCH_ID]
    ], "direct dispatch follows the durable create");
  },

  "LKAI-BE-04": async () => {
    const harness = makeApi();
    await harness.api.createIntent(FIXTURE.valid.createRequests.oneSeed);
    harness.repository.log.length = 0;
    const claimed = await harness.api.claimIntent({ ownerId: OWNER, intentId: INTENT_ID });
    assert.equal(claimed.created, true);
    assert.equal(claimed.research.id, RESEARCH_ID);
    assert.deepEqual(
      { research: claimed.research },
      FIXTURE.valid.claimCreatedResponse,
      "claim service returns the frozen serialized research"
    );
    assert.deepEqual(harness.repository.intent.seeds, [], "successful claim scrubs durable intent seeds");
    assert.equal(harness.repository.intent.claimedByUserId, OWNER);
    assert.equal(harness.repository.intent.claimedResearchId, RESEARCH_ID);
    assert.deepEqual(harness.repository.log, [
      ["claim.transaction", OWNER, INTENT_ID],
      ["claim.commit", RESEARCH_ID],
      ["dispatch", RESEARCH_ID]
    ], "initialize dispatch occurs only after the claim transaction commits");
    assert.equal(harness.sent.length, 1);

    const routeApi = {
      async createIntent() { throw new Error("not expected"); },
      async claimIntent(input) {
        assert.deepEqual(input, { ownerId: OWNER, intentId: INTENT_ID });
        return { created: true, research: FIXTURE.valid.claimCreatedResponse.research };
      }
    };
    await withServer(routeApi, async (base) => {
      const response = await fetch(
        `${base}/api/keyword-research-intents/${encodeURIComponent(INTENT_ID)}/claim`,
        { method: "POST", headers: { "x-user-id": OWNER } }
      );
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), FIXTURE.valid.claimCreatedResponse);
    });
  },

  "LKAI-BE-05": async () => {
    const repository = new IntentRepositoryFake({ claimOutcome: "found" });
    repository.research = makeQueuedResearch();
    repository.intent = {
      id: INTENT_ID,
      seeds: [],
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
      expiresAt: new Date("2026-08-26T11:00:00.000Z"),
      claimedAt: new Date("2026-08-26T10:30:00.000Z"),
      claimedByUserId: OWNER,
      claimedResearchId: RESEARCH_ID
    };
    const harness = makeApi({ repository });
    const claimed = await harness.api.claimIntent({ ownerId: OWNER, intentId: INTENT_ID });
    assert.equal(claimed.created, false);
    assert.equal(claimed.research.id, RESEARCH_ID);
    assert.deepEqual({ research: claimed.research }, FIXTURE.valid.claimReplayResponse);
    assert.equal(repository.calls.claimIntent, 1);
    assert.equal(repository.calls.create, 0, "replay creates no research");
    assert.equal(harness.sent.length, 0, "replay makes no immediate send");
    assert.ok(repository.intent.expiresAt <= NOW, "same-owner replay remains found after intent expiry");

    const routeApi = {
      async claimIntent(input) {
        assert.deepEqual(input, { ownerId: OWNER, intentId: INTENT_ID });
        return { created: false, research: FIXTURE.valid.claimReplayResponse.research };
      }
    };
    await withServer(routeApi, async (base) => {
      const response = await fetch(
        `${base}/api/keyword-research-intents/${encodeURIComponent(INTENT_ID)}/claim`,
        { method: "POST", headers: { "x-user-id": OWNER } }
      );
      assert.equal(response.status, 200, "same-owner HTTP replay returns 200");
      assert.deepEqual(await response.json(), FIXTURE.valid.claimReplayResponse);
    });
  },

  "LKAI-BE-06": async () => {
    for (const scenario of ["missing", "expired", "foreign"]) {
      const repository = new IntentRepositoryFake({ claimOutcome: "not_found" });
      const harness = makeApi({ repository });
      await assert.rejects(
        harness.api.claimIntent({
          ownerId: scenario === "foreign" ? OTHER_OWNER : OWNER,
          intentId: INTENT_ID
        }),
        isIntentNotFound,
        scenario
      );
      assert.equal(repository.calls.create, 0, `${scenario}: zero research writes`);
      assert.equal(harness.sent.length, 0, `${scenario}: zero sends`);
    }

    const routeApi = {
      async claimIntent() {
        throw new ApiError(
          404,
          "KEYWORD_RESEARCH_INTENT_NOT_FOUND",
          FIXTURE.errors.intentNotFound.error.message
        );
      }
    };
    await withServer(routeApi, async (base) => {
      const unauthenticated = await fetch(
        `${base}/api/keyword-research-intents/${encodeURIComponent(INTENT_ID)}/claim`,
        { method: "POST" }
      );
      assert.equal(unauthenticated.status, 401);
      assert.deepEqual(await unauthenticated.json(), FIXTURE.errors.userContextRequired);

      const response = await fetch(
        `${base}/api/keyword-research-intents/${encodeURIComponent(INTENT_ID)}/claim`,
        { method: "POST", headers: { "x-user-id": OTHER_OWNER } }
      );
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), FIXTURE.errors.intentNotFound);
    });
  },

  "LKAI-BE-07": async () => {
    const harness = makeApi({ dispatch: async () => { throw new Error("injected send loss"); } });
    const claimed = await harness.api.claimIntent({ ownerId: OWNER, intentId: INTENT_ID });
    assert.equal(claimed.created, true, "dispatch loss does not erase the committed result");
    assert.equal(harness.repository.research.state, "queued");
    assert.equal(harness.sent.length, 1, "the immediate send was attempted once");

    const recoveredMessages = [];
    const recovery = await recoverKeywordWork({ now: NOW, limit: 100 }, {
      config: { awsPipelineKeywordResearchQueueUrl: "https://sqs.example/keyword-research" },
      repository: {
        async recover() {
          return {
            outcome: "found",
            initializations: [{ researchId: RESEARCH_ID, generation: 1 }],
            taskDispatches: [],
            aggregateChecks: []
          };
        }
      },
      dispatcher: {
        async sendOne(_queueUrl, message) {
          recoveredMessages.push(message);
          return { sentItemIds: [message.researchId], failedItemIds: [] };
        }
      }
    });
    assert.deepEqual(recovery, {
      initializations: 1,
      taskDispatches: 0,
      aggregateChecks: 0,
      sent: 1
    });
    assert.deepEqual(recoveredMessages, [{
      contractVersion: 1,
      type: "keyword.initialize.v1",
      researchId: RESEARCH_ID,
      generation: 1
    }]);
  }
};

test("landing keyword auth backend registry", async (t) => {
  assert.equal(FIXTURE.contractVersion, "landing-keyword-auth-intent-v1");
  assert.deepEqual(Object.keys(FIXTURE.valid.createResponse), ["intentId", "expiresAt"]);
  assert.match(FIXTURE.valid.createResponse.intentId, /^intent_[A-Za-z0-9_-]{32}$/u);
  assert.equal(
    FIXTURE.invalid.createRequests.find(({ name }) => name === "over 100 code points").body.seeds[0].length,
    101,
    "literal boundary fixture contains exactly 101 code points"
  );
  for (const id of REQUIRED_CASES) await runCase(t, id, CASES[id]);
});

test("landing keyword auth backend negative controls", async () => {
  const zeroAnonymousDispatchOracle = async (harness) => {
    await harness.api.createIntent(FIXTURE.valid.createRequests.oneSeed);
    assert.equal(harness.sent.length, 0, "anonymous API path must not dispatch");
  };
  await zeroAnonymousDispatchOracle(makeApi());
  await assert.rejects(
    () => zeroAnonymousDispatchOracle(makeApi({
      repository: new IntentRepositoryFake({ anonymousDispatchDefect: true })
    })),
    AssertionError,
    "the injected anonymous-dispatch defect must fail the production-path oracle"
  );
  await zeroAnonymousDispatchOracle(makeApi());
  falsifiedControls.add("LKAI-NC-01");

  const foreignReplayNotFoundOracle = async (harness) => {
    await assert.rejects(
      harness.api.claimIntent({ ownerId: OTHER_OWNER, intentId: INTENT_ID }),
      isIntentNotFound
    );
    assert.equal(harness.sent.length, 0, "foreign replay must not dispatch");
  };
  const cleanForeignRepository = () => {
    const repository = new IntentRepositoryFake({ claimOutcome: "found" });
    repository.research = makeQueuedResearch();
    return repository;
  };
  await foreignReplayNotFoundOracle(makeApi({ repository: cleanForeignRepository() }));
  const defectiveRepository = new IntentRepositoryFake({
    claimOutcome: "found",
    ignoreOwnerDefect: true
  });
  defectiveRepository.research = makeQueuedResearch();
  await assert.rejects(
    () => foreignReplayNotFoundOracle(makeApi({ repository: defectiveRepository })),
    AssertionError,
    "the injected ignore-owner defect must fail the production-path oracle"
  );
  await foreignReplayNotFoundOracle(makeApi({ repository: cleanForeignRepository() }));
  falsifiedControls.add("LKAI-NC-03");
});

test("landing keyword auth backend execution certificate", () => {
  const required = [...REQUIRED_CASES].sort(utf8Compare);
  const registeredSorted = [...registered].sort(utf8Compare);
  const executedSorted = [...executed].sort(utf8Compare);
  const witnessesSorted = [...activationWitnesses].sort(utf8Compare);
  const controlsSorted = [...falsifiedControls].sort(utf8Compare);
  assert.deepEqual(registeredSorted, required, "required equals registered");
  assert.deepEqual(executedSorted, required, "required equals executed");
  assert.deepEqual(witnessesSorted, required, "every case has an activation witness");
  assert.deepEqual(
    controlsSorted,
    [...UNIT_REQUIRED_CONTROLS].sort(utf8Compare),
    "all unit-level W1 controls falsified"
  );
  process.stdout.write(`LKAI_W1_BACKEND_EXECUTION_CERTIFICATE=${JSON.stringify({
    required,
    registered: registeredSorted,
    executed: executedSorted,
    skipped: [],
    activationWitnesses: witnessesSorted,
    oracleFailures: [],
    falsifiedControls: controlsSorted,
    digests: {
      required: digestOf(required),
      registered: digestOf(registeredSorted),
      executed: digestOf(executedSorted),
      controls: digestOf(controlsSorted)
    }
  })}\n`);
});
