import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fingerprintJson } from "../../src/aws-pipeline/core/canonical.js";
import { keywordMessageSchema } from "../../src/aws-pipeline/keyword-intelligence/contracts.js";
import { keywordRequestFingerprint } from "../../src/aws-pipeline/keyword-intelligence/keys.js";
import { processInitialize, processKeywordMessage } from "../../src/aws-pipeline/keyword-intelligence/service.js";
import { processDiscoveryMessage } from "../../src/aws-pipeline/services/discovery-worker.js";
import { processDomainAggregation } from "../../src/aws-pipeline/services/domain-aggregator.js";
import { PipelineCoordinatorRepository } from "../../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
import { PrismaRunRepository } from "../../src/prisma-run-repository.js";
import { PrismaKeywordResearchRepository } from "../../src/keyword-intelligence/repository.js";
import { createLeadServer } from "../../src/server.js";
import { createPrismaClient } from "../../src/prisma-client.js";
import { validateResearchBackedConfirmedQueryRows } from "../../src/query-review.js";
import { parseGoogleSearchResponse } from "../../src/search.js";
import { runStoreId, shopIdForStableKey, stableShopIdentity } from "../../src/shop-persistence-contract.js";
import {
  assertMigrationStayedInSchema,
  assertSafeDisposableSchema,
  createIsolatedTestSchema,
  deployPrismaMigrations,
  resolveDirectTestDatabaseUrl
} from "./isolated-postgres.js";

class HarnessPreflightError extends Error { constructor(message) { super(message); this.name = this.constructor.name; } } const preflightError = HarnessPreflightError;

class HarnessStallError extends Error { constructor(message) { super(message); this.name = this.constructor.name; } } const stallError = HarnessStallError;

class HarnessCleanupError extends Error { constructor(message) { super(message); this.name = this.constructor.name; } } const cleanupError = HarnessCleanupError;

const pad2 = (n) => String(n).padStart(2, "0");
const pad3 = (n) => String(n).padStart(3, "0");
const hostTemplate = (q, r) => `w6-q${String(q).padStart(3, "0")}-r${String(r).padStart(2, "0")}.myshopify.com`;
const TASK_COSTS = { expansion: "0.01560000", anchor: "0.04800000", market: "0.03600000", total: "0.49200000" };
const SCHEMA_PREFIX = "kiw6_";
const DISPATCHER_METHODS = ["sendMany", "sendOne"];
const SCHEMA_ABSENCE_QUERY = "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1";
const SEED_KEYWORDS = ["insulated water bottle", "stainless lunch box", "silicone baking mat", "glass storage jar", "reusable straw set"];
const NEON_AUTH_COOKIE_SECRET_VALUE = "kiw6-local-e2e-cookie-secret-0000000000000000000000";
const BACKEND_CONFIG = Object.freeze({
  port: 0,
  host: "127.0.0.1",
  backendApiToken: "kiw6-backend-token",
  runExecutionBackend: "aws",
  runRateLimitWindowMs: 60000,
  runRateLimitMax: 1000,
  queryConfirmRateLimitWindowMs: 60000,
  queryConfirmRateLimitMax: 1000,
  generatedQueryCount: 10,
  maxQueries: 20,
  maxShopTypes: 5
});
const RUN_REPOSITORY_OPTIONS = Object.freeze({
  runExecutionBackend: "aws",
  browserlessUrl: "https://fixture.example",
  googleSearchEngineId: "fixture",
  googleResultsPerQuery: 10,
  requestTimeoutMs: 10000,
  maxPagesPerStore: 5,
  pageFetchConcurrency: 2,
  maxQueries: 20,
  generatedQueryCount: 10,
  queryProbeFreshnessMs: 60000,
  queryProbeConcurrency: 1,
  minQueryResults: 1,
  minQueryUniqueHosts: 1,
  minQueryRelevantResults: 1,
  minQueryRelevanceRatio: 0.1,
  minQueryBaseScore: 1,
  browserlessEnabled: false,
  enableAiNormalization: false,
  dataForSeoEnrichmentEnabled: true,
  cruxEnrichmentEnabled: true,
  cruxBigQueryProjectId: "fixture-project"
});
const PIPELINE_CONFIG = Object.freeze({
  awsPipelineBucket: "kiw6-bucket",
  awsPipelineKeywordResearchQueueUrl: "https://sqs.kiw6.local/keyword-research",
  awsPipelineDiscoveryQueueUrl: "https://sqs.kiw6.local/discovery",
  awsPipelineDomainAggregationQueueUrl: "https://sqs.kiw6.local/domain-aggregation",
  awsPipelineLeadQueueUrl: "https://sqs.kiw6.local/lead",
  awsPipelineLeadAggregationQueueUrl: "https://sqs.kiw6.local/lead-aggregation",
  awsPipelineTrafficQueueUrl: "https://sqs.kiw6.local/traffic",
  awsPipelineFinalAggregationQueueUrl: "https://sqs.kiw6.local/final-aggregation",
  awsPipelineRecoveryAgeMs: 1
});
const PIPELINE_SECRETS = Object.freeze({ dataForSeoLogin: "kiw6-login", dataForSeoPassword: "kiw6-password" });
const stoppedMonitor = () => ({ assertActive() {}, async renewNow() {}, async stop() {} });

export async function createKeywordIntelligenceE2eHarness({
  testDatabaseUrl = process.env.TEST_DATABASE_URL,
  testDirectDatabaseUrl = process.env.TEST_DIRECT_DATABASE_URL,
  productionDatabaseUrl = process.env.DATABASE_URL,
} = {}) {
  const urlOptions = { testDatabaseUrl, testDirectDatabaseUrl, productionDatabaseUrl };
  let directDatabaseUrl;
  try {
    directDatabaseUrl = resolveDirectTestDatabaseUrl(urlOptions);
  } catch (error) {
    throw new preflightError(String(error?.message ?? "invalid test database preconditions"));
  }
  const schema = `${SCHEMA_PREFIX}${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
  assertSafeDisposableSchema(schema);
  const { admin, scopedUrl } = await createIsolatedTestSchema(schema, urlOptions);
  await deployPrismaMigrations(scopedUrl);
  const initialPrisma = createPrismaClient(scopedUrl);
  await assertMigrationStayedInSchema(initialPrisma, schema);

  const nowBox = { current: new Date("2026-01-01T00:00:00.000Z") };
  const nowMs = () => nowBox.current.getTime();
  const events = [];
  const record = (event) => {
    events.push(Object.freeze({ ...event }));
  };
  const trace = () => Object.freeze([...events]);
  const sendsLog = [];
  const fixtureState = { corruptArtifact: null, missingTerminal: null };
  const providerAttemptCounts = new Map();
  let googleInvocations = 0;
  const googleFixture = JSON.parse(await readFile(
    new URL("../fixtures/providers/google/custom-search-v1-success.json", import.meta.url),
    "utf8"
  ));

  const expansionEnvelope = (items, cost) => ({
    status_code: 20000,
    status_message: "Ok.",
    cost,
    tasks_count: 1,
    results_count: 1,
    tasks: [{
      id: "00000000-0000-0000-0000-0000000000aa",
      status_code: 20000,
      status_message: "Ok.",
      cost,
      result: [{ items_count: items.length, items }]
    }]
  });
  const suggestionsResponse = (seed) => {
    const s = Math.max(0, SEED_KEYWORDS.indexOf(seed));
    const items = [];
    for (let i = 1; i <= 30; i += 1) {
      items.push({ keyword: `${seed} suggestion s${s}${pad2(i)}` });
    }
    return expansionEnvelope(items, Number(TASK_COSTS.expansion));
  };
  const relatedResponse = (seed) => {
    const s = Math.max(0, SEED_KEYWORDS.indexOf(seed));
    const items = [];
    for (let i = 1; i <= 30; i += 1) {
      items.push({ keyword_data: { keyword: `${seed} related r${s}${pad2(i)}` }, depth: 2, related_keywords: [] });
    }
    return expansionEnvelope(items, Number(TASK_COSTS.expansion));
  };
  const overviewResponseBody = (payload) => {
    const keywords = payload.keywords;
    const items = keywords.map((keyword, index) => {
      const monthly = [];
      for (let m = 0; m < 15; m += 1) {
        monthly.push({
          year: 2024 + Math.floor((index + m) / 12),
          month: ((index + m) % 12) + 1,
          search_volume: 800 + index * 5 + m
        });
      }
      return {
        keyword,
        keyword_info: {
          search_volume: 1000 + index * 10,
          cpc: 1.0 + index / 100,
          competition: 0.3 + (index % 5) / 10,
          competition_level: index % 2 === 0 ? "MEDIUM" : "LOW"
        },
        monthly_searches: monthly,
        keyword_properties: { keyword_difficulty: 40 + (index % 20) },
        search_intent_info: { main_intent: index % 3 === 0 ? "transactional" : "commercial" }
      };
    });
    const cost = 0.012 + 0.00012 * keywords.length;
    return {
      status_code: 20000,
      status_message: "Ok.",
      cost,
      tasks_count: 1,
      results_count: 1,
      tasks: [{
        id: "00000000-0000-0000-0000-0000000000aa",
        status_code: 20000,
        status_message: "Ok.",
        cost,
        result: [{ location_code: payload.location_code, language_code: payload.language_code, items_count: items.length, items }]
      }]
    };
  };
  const dataForSeoHttp = async (url, init) => {
    const payload = JSON.parse(init.body)[0];
    const urlText = String(url);
    let endpointKey;
    let taskType;
    let costUsd;
    if (urlText.includes("keyword_suggestions")) {
      endpointKey = "keyword_suggestions";
      taskType = "expansion-suggestions";
      costUsd = TASK_COSTS.expansion;
    } else if (urlText.includes("related_keywords")) {
      endpointKey = "related_keywords";
      taskType = "expansion-related";
      costUsd = TASK_COSTS.expansion;
    } else {
      endpointKey = "keyword_overview";
      const anchor = payload.location_code === 2840;
      taskType = anchor ? "anchor-overview" : "market-overview";
      costUsd = anchor ? TASK_COSTS.anchor : TASK_COSTS.market;
    }
    const requestFingerprint = keywordRequestFingerprint(endpointKey, payload);
    const attempt = (providerAttemptCounts.get(requestFingerprint) ?? 0) + 1;
    providerAttemptCounts.set(requestFingerprint, attempt);
    record({ kind: "dataforseo", op: "request", at: nowMs(), taskType, attempt, costUsd, requestFingerprint });
    const body = endpointKey === "keyword_suggestions"
      ? suggestionsResponse(payload.keyword)
      : endpointKey === "related_keywords"
        ? relatedResponse(payload.keyword)
        : overviewResponseBody(payload);
    return { status: 200, json: async () => body };
  };
  const googleSearchPage = async (receivedQuery) => {
    const q = googleInvocations + 1;
    googleInvocations += 1;
    const payload = structuredClone(googleFixture);
    payload.items = [];
    for (let r = 1; r <= 10; r += 1) {
      const host = hostTemplate(q, r);
      payload.items.push({
        title: receivedQuery,
        link: `https://${host}/products/result-${pad2(r)}`,
        snippet: receivedQuery,
        displayLink: host
      });
    }
    const page = parseGoogleSearchResponse(payload, receivedQuery);
    record({ kind: "google", op: "search-page", at: nowMs(), runQueryId: receivedQuery, occurrences: payload.items.length });
    return page;
  };
  const researchQueryValidationPipeline = (rows, categories, config, status, options) =>
    validateResearchBackedConfirmedQueryRows(rows, categories, config, status, { ...options, searchPage: googleSearchPage });

  const keywordQueueUrl = PIPELINE_CONFIG.awsPipelineKeywordResearchQueueUrl;
  const discoveryQueueUrl = PIPELINE_CONFIG.awsPipelineDiscoveryQueueUrl;
  const domainQueueUrl = PIPELINE_CONFIG.awsPipelineDomainAggregationQueueUrl;
  const artifactObjects = new Map();
  const validateStored = (stored, key, expected, schema) => {
    for (const [name, value] of Object.entries(expected || {})) {
      if (value === undefined) continue;
      const actual = name === "contentFingerprint" ? stored.contentFingerprint : stored.metadata[name];
      const normalizedActual = actual instanceof Date ? actual.toISOString() : actual;
      const normalizedValue = value instanceof Date ? value.toISOString() : value;
      if (String(normalizedActual) !== String(normalizedValue)) {
        const error = new Error(`PIPELINE_ARTIFACT_CONFLICT:${name}`);
        error.code = "PIPELINE_ARTIFACT_CONFLICT";
        throw error;
      }
    }
    const value = schema.parse(stored.value);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    record({ kind: "s3", op: "get-validated", at: nowMs(), key, contentFingerprint: stored.contentFingerprint, bytes });
    return { value, contentFingerprint: stored.contentFingerprint, bytes };
  };
  const artifactStore = {
    async putImmutable(input) {
      const value = input.schema.parse(input.value);
      const contentFingerprint = fingerprintJson(value);
      const bytes = Buffer.byteLength(JSON.stringify(value));
      const prior = artifactObjects.get(input.key);
      if (prior && prior.contentFingerprint !== contentFingerprint) {
        const error = new Error("PIPELINE_ARTIFACT_CONFLICT");
        error.code = "PIPELINE_ARTIFACT_CONFLICT";
        throw error;
      }
      artifactObjects.set(input.key, {
        value: structuredClone(value),
        contentFingerprint,
        metadata: {
          contractVersion: input.contractVersion,
          runId: input.runId,
          stage: input.stage,
          generation: input.generation,
          itemId: input.itemId,
          inputFingerprint: input.inputFingerprint,
          producedAt: input.producedAt
        }
      });
      record({ kind: "s3", op: "put-immutable", at: nowMs(), key: input.key, contentFingerprint, bytes });
      return { key: input.key, contentFingerprint, bytes };
    },
    async getValidated({ key, expected, schema }) {
      const stored = artifactObjects.get(key);
      if (!stored) {
        record({ kind: "s3", op: "get-missing", at: nowMs(), key, contentFingerprint: "", bytes: 0 });
        const error = new Error("The specified key does not exist.");
        error.name = "NoSuchKey";
        error.code = "NoSuchKey";
        throw error;
      }
      try {
        return validateStored(stored, key, expected, schema);
      } catch (error) {
        if (fixtureState.corruptArtifact?.key === key) fixtureState.corruptArtifact.rejected = true;
        throw error;
      }
    },
    async getOptionalValidated(input) {
      if (!artifactObjects.has(input.key)) {
        record({ kind: "s3", op: "get-missing", at: nowMs(), key: input.key, contentFingerprint: "", bytes: 0 });
        return { outcome: "missing" };
      }
      return { outcome: "found", ...await this.getValidated(input) };
    }
  };

  const pendingDeliveries = new Map([
    [PIPELINE_CONFIG.awsPipelineKeywordResearchQueueUrl, []],
    [PIPELINE_CONFIG.awsPipelineDiscoveryQueueUrl, []],
    [PIPELINE_CONFIG.awsPipelineDomainAggregationQueueUrl, []],
    [PIPELINE_CONFIG.awsPipelineLeadQueueUrl, []],
    [PIPELINE_CONFIG.awsPipelineLeadAggregationQueueUrl, []],
    [PIPELINE_CONFIG.awsPipelineTrafficQueueUrl, []],
    [PIPELINE_CONFIG.awsPipelineFinalAggregationQueueUrl, []]
  ]);
  let nextDeliveryId = 1;
  const validateMessage = (schema, message) => {
    const result = schema.safeParse(message);
    if (!result.success) {
      const error = new Error("PIPELINE_MESSAGE_INVALID");
      error.code = "PIPELINE_MESSAGE_INVALID";
      throw error;
    }
    return result.data;
  };
  const messageIdentity = (message) => message.itemId ?? message.taskNaturalId ??
    (message.runId ? `${message.runId}:${message.stage}:${message.generation}:${message.reason}` : message.researchId ?? message.stage);
  const enqueueDelivery = (queueUrl, message, visibleAtMs) => {
    const queue = pendingDeliveries.get(queueUrl);
    if (!queue) throw new preflightError(`unknown queue url ${queueUrl}`);
    const deliveryId = nextDeliveryId;
    nextDeliveryId += 1;
    queue.push({ deliveryId, message: structuredClone(message), visibleAtMs });
    return deliveryId;
  };
  const dispatcher = {
    async sendOne(queueUrl, message, schema, options = {}) {
      const parsed = validateMessage(schema, message);
      const optionKeys = Reflect.ownKeys(options ?? {});
      if (optionKeys.length > 1 || (optionKeys.length === 1 && optionKeys[0] !== "delaySeconds")) {
        throw new preflightError("unsupported dispatcher send options");
      }
      let delaySeconds;
      if (optionKeys.length === 1) {
        delaySeconds = options.delaySeconds;
        if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 900) {
          throw new preflightError("dispatcher delay seconds out of range");
        }
      }
      enqueueDelivery(queueUrl, parsed, nowMs() + (delaySeconds ?? 0) * 1000);
      record({ kind: "sqs", op: "send-one", at: nowMs(), count: 1, messageTypes: [parsed.type] });
      sendsLog.push({ queueUrl });
      return {
        sentItemIds: [messageIdentity(parsed)],
        failedItemIds: [],
        results: [{ index: 0, itemId: messageIdentity(parsed), outcome: "sent" }]
      };
    },
    async sendMany(queueUrl, messages, schema) {
      if (!Array.isArray(messages)) throw new preflightError("sendMany requires a message array");
      const parsed = messages.map((message) => validateMessage(schema, message));
      for (const message of parsed) {
        enqueueDelivery(queueUrl, message, nowMs());
      }
      const messageTypes = [...new Set(parsed.map((message) => message.type).filter(Boolean))];
      record({ kind: "sqs", op: "send-many", at: nowMs(), count: parsed.length, messageTypes });
      sendsLog.push({ queueUrl });
      return {
        sentItemIds: parsed.map(messageIdentity),
        failedItemIds: [],
        results: parsed.map((message, index) => ({ index, itemId: messageIdentity(message), outcome: "sent" }))
      };
    }
  };
  for (const method of DISPATCHER_METHODS) {
    if (typeof dispatcher[method] !== "function") {
      throw new preflightError(`dispatcher is missing ${method}`);
    }
  }
  const queueHead = (queueUrl) => pendingDeliveries.get(queueUrl)?.[0] ?? null;
  const takeQueueHead = (queueUrl) => pendingDeliveries.get(queueUrl)?.shift() ?? null;

  const state = {
    prisma: initialPrisma,
    runRepository: null,
    keywordRepository: null,
    coordinator: null,
    backendServer: null
  };
  const withClock = (args) => args.map((value, index) =>
    index === args.length - 1 && value instanceof Date ? nowBox.current : value);
  const pinDates = (base) => new Proxy(base, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== "function") return value;
      return (...args) => value.apply(target, withClock(args));
    }
  });
  const wrapKeywordRepository = (base) => new Proxy(base, {
    get(target, property) {
      if (property === "terminalize") {
        return async (input, now) => {
          if (fixtureState.missingTerminal && input?.taskId === fixtureState.missingTerminal.taskId) {
            return { outcome: "lost" };
          }
          return target.terminalize(...withClock([input, now]));
        };
      }
      const value = target[property];
      if (typeof value !== "function") return value;
      return (...args) => value.apply(target, withClock(args));
    }
  });
  const rebuildRepositories = () => {
    state.runRepository = pinDates(new PrismaRunRepository(state.prisma, RUN_REPOSITORY_OPTIONS));
    state.keywordRepository = wrapKeywordRepository(new PrismaKeywordResearchRepository(state.prisma));
    state.coordinator = pinDates(new PipelineCoordinatorRepository(state.prisma));
  };
  rebuildRepositories();

  const scheduledCallbacks = [];
  const schedule = (callback) => {
    scheduledCallbacks.push(callback);
  };
  const flushSchedule = () => {
    while (scheduledCallbacks.length) {
      scheduledCallbacks.shift()();
    }
  };
  const recordedIntervals = [];
  const setIntervalFn = (callback, intervalMs) => {
    const handle = { callback, intervalMs, cleared: false, unref() {} };
    recordedIntervals.push(handle);
    return handle;
  };
  const clearIntervalFn = (handle) => {
    if (handle && typeof handle === "object") handle.cleared = true;
  };
  const keywordRuntime = () => ({
    repository: state.keywordRepository,
    artifactStore,
    dispatcher,
    config: PIPELINE_CONFIG,
    clock: () => nowBox.current,
    http: dataForSeoHttp,
    secrets: PIPELINE_SECRETS
  });
  const downstreamRuntime = () => ({
    repository: state.runRepository,
    coordinator: state.coordinator,
    artifactStore,
    dispatcher,
    config: PIPELINE_CONFIG,
    clock: () => nowBox.current,
    secrets: PIPELINE_SECRETS
  });
  const pipelineRuntimeFactory = () => Object.freeze(downstreamRuntime());

  const ownerId = "kiw6-owner-a";
  const otherOwnerId = "kiw6-owner-b";
  let authMode = "owner-a";
  const setAuthOwner = (owner) => {
    if (owner === ownerId) authMode = "owner-a";
    else if (owner === otherOwnerId) authMode = "owner-b";
    else if (owner === null) authMode = "none";
    else throw new preflightError("unsupported auth owner");
  };
  const authServer = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && requestUrl.pathname === "/get-session") {
      const body = authMode === "none" ? null : { user: { id: authMode === "owner-a" ? ownerId : otherOwnerId } };
      record({ kind: "auth", op: "get-session", at: nowMs(), mode: authMode, status: 200 });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  const listenOn = (server, port) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const stopServer = (server) => new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await listenOn(authServer, 0);
  const authPort = authServer.address().port;

  const serverOptions = () => ({
    repository: state.runRepository,
    now: () => new Date(nowBox.current),
    schedule,
    leaseOwner: "kiw6-lease-owner",
    leaseDurationMs: 90000,
    heartbeatIntervalMs: 20000,
    recoveryIntervalMs: 15000,
    setIntervalFn,
    clearIntervalFn,
    logger: () => {},
    pipelineRuntimeFactory,
    researchQueryValidationPipeline
  });
  const buildBackendServer = () => {
    const server = createLeadServer(BACKEND_CONFIG, serverOptions());
    server.on("request", (request, response) => {
      response.on("finish", () => {
        let path = request.url || "/";
        try {
          path = new URL(request.url || "/", "http://localhost").pathname;
        } catch {
          path = request.url || "/";
        }
        record({
          kind: "http",
          op: "request",
          at: nowMs(),
          method: request.method || "",
          path,
          status: response.statusCode
        });
      });
    });
    return server;
  };
  state.backendServer = buildBackendServer();
  await listenOn(state.backendServer, 0);
  const backendPort = state.backendServer.address().port;

  const restartBackend = async () => {
    await stopServer(state.backendServer);
    await state.prisma.$disconnect().catch(() => {});
    state.prisma = createPrismaClient(scopedUrl);
    rebuildRepositories();
    const server = buildBackendServer();
    await listenOn(server, backendPort);
    state.backendServer = server;
  };

  const resetKeywordThrottle = async () => {
    const databaseSchema = state.keywordRepository.schema;
    await state.prisma.$executeRawUnsafe(
      `UPDATE "${databaseSchema}"."KeywordProviderThrottle" SET "nextAllowedAt" = now() - interval '10 seconds'`
    );
  };
  const latestResearch = async () =>
    state.prisma.keywordResearch.findFirst({ orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
  const latestRun = async () => {
    const research = await latestResearch();
    if (!research) return null;
    const handoff = await state.prisma.keywordResearchHandoff.findFirst({
      where: { researchId: research.id },
      orderBy: { createdAt: "desc" }
    });
    if (handoff) return state.prisma.run.findUnique({ where: { id: handoff.runId } });
    return state.prisma.run.findFirst({
      where: { keywordResearchId: research.id },
      orderBy: { createdAt: "desc" }
    });
  };
  const durableSummary = async () => {
    try {
      const snapshot = await readDurableState();
      return {
        research: snapshot.research.state,
        run: snapshot.run ? { state: snapshot.run.state, stage: snapshot.run.stage } : null,
        discovery: snapshot.discovery,
        domains: snapshot.domains
      };
    } catch {
      return {};
    }
  };
  const pendingTypeCounts = (queueUrls) => {
    const counts = {};
    for (const queueUrl of queueUrls) {
      for (const entry of pendingDeliveries.get(queueUrl) ?? []) {
        const type = entry.message?.type ?? "unknown";
        counts[type] = (counts[type] ?? 0) + 1;
      }
    }
    return counts;
  };

  const drainKeywordWork = async (stage) => {
    if (!["expansion", "anchor-screen", "markets", "settle"].includes(stage)) {
      throw new preflightError(`unsupported keyword drain stage ${stage}`);
    }
    const processedByType = {};
    const traceStart = events.length;
    const sendsStart = sendsLog.length;
    let invocations = 0;
    for (;;) {
      const head = queueHead(keywordQueueUrl);
      if (!head) break;
      if (stage === "expansion" && head.message.type === "keyword.overview.task.v1" && head.message.stage === "anchor_screen") break;
      if (stage === "anchor-screen" && head.message.type === "keyword.overview.task.v1" && head.message.stage === "market_overview") break;
      if (invocations >= 500) {
        throw new stallError(`keyword drain exceeded its step ceiling: pending=${JSON.stringify(pendingTypeCounts([keywordQueueUrl]))} durable=${JSON.stringify(await durableSummary())}`);
      }
      const entry = takeQueueHead(keywordQueueUrl);
      if (entry.visibleAtMs > nowBox.current.getTime()) {
        nowBox.current = new Date(entry.visibleAtMs);
      }
      if (entry.message.type === "keyword.expansion.task.v1" || entry.message.type === "keyword.overview.task.v1") {
        nowBox.current = new Date(nowBox.current.getTime() + 2000);
        await resetKeywordThrottle();
      }
      invocations += 1;
      if (entry.message.type === "keyword.initialize.v1") {
        await processInitialize(entry.message, keywordRuntime());
      } else {
        await processKeywordMessage(entry.message, keywordRuntime());
      }
      processedByType[entry.message.type] = (processedByType[entry.message.type] ?? 0) + 1;
    }
    const drainEvents = events.slice(traceStart);
    const research = await latestResearch();
    const providerAttempts = research
      ? await state.prisma.keywordResearchProviderAttempt.count({ where: { task: { stage: { researchId: research.id } } } })
      : 0;
    return {
      processedByType,
      providerCalls: drainEvents.filter((event) => event.kind === "dataforseo").length,
      providerAttempts,
      keywordObjects: drainEvents.filter((event) => event.kind === "s3" && event.op === "put-immutable").length,
      keywordQueueSends: sendsLog.slice(sendsStart).filter((send) => send.queueUrl === keywordQueueUrl).length
    };
  };

  const domainStageComplete = async () => {
    const run = await latestRun();
    if (!run) return false;
    const discoveryStage = await state.prisma.pipelineStage.findFirst({ where: { runId: run.id, stage: "discovery" } });
    return discoveryStage?.state === "completed";
  };
  const drainDownstream = async () => {
    const processedByType = {};
    let invocations = 0;
    let idlePolls = 0;
    for (;;) {
      flushSchedule();
      const discoveryHead = queueHead(discoveryQueueUrl);
      const domainHead = queueHead(domainQueueUrl);
      let selectedQueue = null;
      if (discoveryHead && (!domainHead || discoveryHead.deliveryId <= domainHead.deliveryId)) {
        selectedQueue = discoveryQueueUrl;
      } else if (domainHead) {
        selectedQueue = domainQueueUrl;
      }
      if (selectedQueue) {
        if (invocations >= 3000) {
          throw new stallError(`downstream drain exceeded its step ceiling: pending=${JSON.stringify(pendingTypeCounts([discoveryQueueUrl, domainQueueUrl, PIPELINE_CONFIG.awsPipelineLeadQueueUrl]))} durable=${JSON.stringify(await durableSummary())}`);
        }
        const entry = takeQueueHead(selectedQueue);
        invocations += 1;
        idlePolls = 0;
        if (selectedQueue === discoveryQueueUrl) {
          await processDiscoveryMessage(entry.message, downstreamRuntime());
        } else {
          await processDomainAggregation(entry.message, downstreamRuntime(), { createLeaseMonitorFn: stoppedMonitor });
        }
        processedByType[entry.message.type] = (processedByType[entry.message.type] ?? 0) + 1;
        continue;
      }
      if (await domainStageComplete()) break;
      if (idlePolls >= 2000) {
        throw new stallError(`downstream drain stalled waiting for durable work: pending=${JSON.stringify(pendingTypeCounts([discoveryQueueUrl, domainQueueUrl, PIPELINE_CONFIG.awsPipelineLeadQueueUrl]))} durable=${JSON.stringify(await durableSummary())}`);
      }
      idlePolls += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const run = await latestRun();
    let discoveryTasks = processedByType["discovery.query"] ?? 0;
    let stableDomains = 0;
    let leadTasks = 0;
    if (run) {
      const discoveryStage = await state.prisma.pipelineStage.findFirst({ where: { runId: run.id, stage: "discovery" } });
      if (discoveryStage) discoveryTasks = discoveryStage.expectedCount;
      const runStores = await state.prisma.runStore.findMany({ where: { runId: run.id }, include: { shop: true } });
      stableDomains = new Set(runStores.map(({ shop }) => shop?.stableKey).filter(Boolean)).size;
      const leadStage = await state.prisma.pipelineStage.findFirst({ where: { runId: run.id, stage: "lead" } });
      leadTasks = leadStage?.expectedCount ?? 0;
    }
    return { processedByType, discoveryTasks, stableDomains, leadTasks };
  };

  const fixtureProjection = async (entry, notReadyFlag) => {
    if (!entry) {
      return { calls: 0, objects: 0, terminalTasks: 0, nextStageRows: 0, [notReadyFlag]: false };
    }
    const researchId = entry.researchId;
    const [calls, objects, terminalTasks, nextStageRows, expansionStage] = await Promise.all([
      state.prisma.keywordResearchProviderAttempt.count({ where: { task: { stage: { researchId } } } }),
      state.prisma.keywordResearchTask.count({ where: { stage: { researchId }, artifactS3Key: { not: null } } }),
      state.prisma.keywordResearchTask.count({ where: { stage: { researchId }, terminalAt: { not: null } } }),
      state.prisma.keywordResearchStage.count({ where: { researchId, stage: { not: "expansion" } } }),
      state.prisma.keywordResearchStage.findFirst({ where: { researchId, stage: "expansion" } })
    ]);
    const flagValue = entry.rejected ?? Boolean(expansionStage && expansionStage.state !== "completed");
    return { calls, objects, terminalTasks, nextStageRows, [notReadyFlag]: flagValue };
  };
  const readDurableState = async () => {
    const research = await latestResearch();
    const handoff = research
      ? await state.prisma.keywordResearchHandoff.findFirst({ where: { researchId: research.id }, orderBy: { createdAt: "desc" } })
      : null;
    const run = research
      ? (handoff
        ? await state.prisma.run.findUnique({ where: { id: handoff.runId }, include: { queries: { select: { id: true } } } })
        : await state.prisma.run.findFirst({
          where: { keywordResearchId: research.id },
          orderBy: { createdAt: "desc" },
          include: { queries: { select: { id: true } } }
        }))
      : null;
    const result = research?.result;
    let discoveryView = { taskCount: 0, terminalCount: 0 };
    let domainsView = { stableHostCount: 0, shopCount: 0, runStoreCount: 0, leadTaskCount: 0, stageComplete: false };
    let discoveryStage = null;
    if (run) {
      discoveryStage = await state.prisma.pipelineStage.findFirst({ where: { runId: run.id, stage: "discovery" } });
      discoveryView = {
        taskCount: discoveryStage?.expectedCount ?? 0,
        terminalCount: discoveryStage?.terminalCount ?? 0
      };
      const runStores = await state.prisma.runStore.findMany({ where: { runId: run.id }, include: { shop: true } });
      for (const runStore of runStores) {
        const identity = stableShopIdentity(runStore.candidatePayload);
        if (runStore.shop) {
          if (identity.stableKey !== runStore.shop.stableKey) {
            throw new Error("stored stable shop identity does not match the run store shop");
          }
          if (shopIdForStableKey(runStore.shop.stableKey) !== runStore.shopId) {
            throw new Error("stored shop id does not match the stable key");
          }
        }
        if (runStoreId(run.id, runStore.shopId) !== runStore.id) {
          throw new Error("stored run store id does not match the run and shop identity");
        }
      }
      const leadStage = await state.prisma.pipelineStage.findFirst({ where: { runId: run.id, stage: "lead" } });
      domainsView = {
        stableHostCount: new Set(runStores.map(({ shop }) => shop?.stableKey).filter(Boolean)).size,
        shopCount: new Set(runStores.map(({ shopId }) => shopId)).size,
        runStoreCount: runStores.length,
        leadTaskCount: leadStage?.expectedCount ?? 0,
        stageComplete: discoveryStage?.state === "completed"
      };
    }
    return {
      research: {
        researchId: research?.id ?? "",
        ownerId: research?.ownerId ?? "",
        state: research?.state ?? "",
        selectionRevision: research?.selectionRevision ?? 0,
        selectionFingerprint: handoff?.selectionFingerprint ?? ""
      },
      keywordResult: {
        visible: Boolean(research && research.state === "completed" && result != null),
        rowCount: Array.isArray(result?.keywords) ? result.keywords.length : 0,
        defaultSelectionItemCount: Array.isArray(research?.selection?.items) ? research.selection.items.length : 0
      },
      run: run ? {
        runId: run.id,
        state: run.state,
        phase: run.phase,
        stage: run.stage,
        queryCount: run.queries.length,
        confirmedQueryRevision: run.confirmedQueryRevision ?? null,
        queriesConfirmedAt: run.queriesConfirmedAt ? new Date(run.queriesConfirmedAt).toISOString() : null,
        executionBackend: run.executionBackend,
        resultsAvailable: run.resultsAvailable
      } : null,
      handoff: handoff ? {
        handoffId: handoff.id,
        clientRequestId: handoff.clientRequestId,
        selectionRevision: handoff.selectionRevision,
        selectionFingerprint: handoff.selectionFingerprint,
        createdAtIso: new Date(handoff.createdAt).toISOString()
      } : null,
      discovery: discoveryView,
      domains: domainsView,
      fixtures: fixtureState.corruptArtifact || fixtureState.missingTerminal ? {
        corruptArtifact: await fixtureProjection(fixtureState.corruptArtifact, "rejected"),
        missingTerminal: await fixtureProjection(fixtureState.missingTerminal, "notReady")
      } : null
    };
  };

  const faultQueues = new Map([
    ["duplicate-next-keyword-message", keywordQueueUrl],
    ["reorder-pending-keyword-messages", keywordQueueUrl],
    ["duplicate-next-discovery-message", discoveryQueueUrl],
    ["reorder-pending-discovery-messages", discoveryQueueUrl],
    ["duplicate-next-domain-check-message", domainQueueUrl],
    ["reorder-pending-domain-check-messages", domainQueueUrl]
  ]);
  const injectCapturedDefect = async (faultId) => {
    const faultQueueUrl = faultQueues.get(faultId);
    if (faultQueueUrl) {
      if (faultId.startsWith("duplicate-next-")) {
        const head = queueHead(faultQueueUrl);
        if (!head) throw new preflightError(`no pending delivery available for ${faultId}`);
        const deliveryId = enqueueDelivery(faultQueueUrl, head.message, nowMs());
        return { faultId, deliveredType: head.message.type, deliveryId };
      }
      const queue = pendingDeliveries.get(faultQueueUrl);
      if (!queue.length) throw new preflightError(`no pending deliveries available for ${faultId}`);
      const reversed = queue.splice(0).reverse();
      const pendingCount = reversed.length;
      for (const entry of reversed) {
        enqueueDelivery(faultQueueUrl, entry.message, nowMs());
      }
      return { faultId, pendingCount };
    }
    if (faultId === "corrupt-stored-artifact") {
      const task = await state.prisma.keywordResearchTask.findFirst({
        where: { artifactS3Key: { not: null }, terminalAt: { not: null } },
        orderBy: [{ terminalAt: "desc" }, { id: "asc" }],
        include: { stage: { select: { researchId: true } } }
      });
      if (!task) throw new preflightError("no stored artifact belongs to a terminal task");
      const stored = artifactObjects.get(task.artifactS3Key);
      if (!stored) throw new preflightError("terminal task artifact is not present in the object store");
      stored.value = { ...stored.value, kiw6CorruptDefect: true };
      fixtureState.corruptArtifact = { key: task.artifactS3Key, researchId: task.stage.researchId, rejected: false };
      return { faultId, corruptedKey: task.artifactS3Key };
    }
    if (faultId === "omit-neon-terminal") {
      const research = await latestResearch();
      if (!research) throw new preflightError("no keyword research exists for a terminal omission");
      const task = await state.prisma.keywordResearchTask.findFirst({
        where: { stage: { researchId: research.id }, terminalAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });
      if (!task) throw new preflightError("no pending keyword task exists for a terminal omission");
      fixtureState.missingTerminal = { taskId: task.id, researchId: research.id, rejected: false };
      return { faultId, omittedTaskNaturalId: task.id };
    }
    throw new preflightError(`unsupported fault identifier ${faultId}`);
  };

  let closeMemo = null;
  const close = () => {
    if (!closeMemo) {
      closeMemo = (async () => {
        await stopServer(state.backendServer).catch(() => {});
        await stopServer(authServer).catch(() => {});
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        const rows = await admin.$queryRawUnsafe(SCHEMA_ABSENCE_QUERY, schema);
        if (rows.length > 0) {
          throw new cleanupError(`disposable schema survived cleanup: ${schema}`);
        }
        await state.prisma.$disconnect().catch(() => {});
        await admin.$disconnect();
        return { droppedSchema: schema, absenceWitness: { query: SCHEMA_ABSENCE_QUERY, rowCount: 0 } };
      })();
    }
    return closeMemo;
  };

  const frontendEnv = Object.freeze({
    BACKEND_API_BASE_URL: `http://127.0.0.1:${backendPort}`,
    BACKEND_API_TOKEN: "kiw6-backend-token",
    NEON_AUTH_BASE_URL: `http://127.0.0.1:${authPort}`,
    NEON_AUTH_COOKIE_SECRET: NEON_AUTH_COOKIE_SECRET_VALUE
  });

  return Object.freeze({ frontendEnv, ownerId, otherOwnerId, trace, setAuthOwner, drainKeywordWork, restartBackend, drainDownstream, readDurableState, injectCapturedDefect, close });
}
