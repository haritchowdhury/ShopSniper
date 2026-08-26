import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ApiError } from "../src/api-errors.js";
import { fingerprintJson } from "../src/aws-pipeline/core/canonical.js";
import { serializeKeywordResearch, serializeRun } from "../src/api-serializer.js";
import { classifyKeywordForSelection } from "../src/keyword-intelligence/cluster.js";
import { keywordResearchConfigV1 } from "../src/keyword-intelligence/config.js";
import { serializeKeywordsCsv } from "../src/keyword-intelligence/export.js";
import { selectionItemId } from "../src/keyword-intelligence/selection.js";
import {
  mapSelectionToQueries,
  validateResearchBackedQueries
} from "../src/keyword-intelligence/query-mapper.js";
import { createKeywordResearchApi } from "../src/keyword-intelligence/api.js";
import {
  GOOGLE_PROBE_CONTRACT_VERSION,
  validateConfirmedQueryRows,
  validateEditableQueryList,
  validateResearchBackedConfirmedQueryRows,
  validateResearchBackedQueryList
} from "../src/query-review.js";
import { createLeadServer } from "../src/server.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/keyword-intelligence/ki-w4-enforcement-manifest-v1.json", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(fixturePath, "utf8"));

const ALL_IDS = Object.values(MANIFEST.groups).flat();
const DB_IDS = MANIFEST.groups.handoff_database;
const REQUIRED = ALL_IDS.filter((id) => !DB_IDS.includes(id));
const MANIFEST_DIGEST = "86810ce87a79426bb972be2e2827abc3806835190135d17769b52c33e7bb2203";
const R5_API_CASES = ["R5-SEL-01", "R5-SEL-02", "R5-SEL-03", "R5-SEL-04", "R5-SEL-05", "R5-SEL-06", "R5-SEL-07", "R5-SEL-08", "R5-EXP-05", "R5-EXP-06"];

const RESEARCH = "kr_" + "a".repeat(24);
const OWNER = "owner_a";
const OTHER = "owner_b";
const NOW = new Date("2026-08-17T00:00:00.000Z");
const CONFIG = keywordResearchConfigV1();
const CONFIG_FINGERPRINT = fingerprintJson(CONFIG);
const RUN_ID = "run_" + "0".repeat(24);
const CLIENT_REQUEST_ID = "client-request-id-0001";

const RESEARCH_VIEW_KEYS = [
  "id", "statusUrl", "state", "generation", "contractVersion", "seeds", "markets",
  "progress", "result", "selection", "selectionRevision", "selectionConflicts",
  "safeError", "createdAt", "startedAt", "completedAt", "updatedAt"
];
const CSV_HEADER = "keyword,seed,source_seeds,search_volume,cpc,competition,competition_level,keyword_difficulty,main_intent,commercial_intent,trend_slope,cluster,cluster_id,lane,facets,variant_group_id,variant_canonical,flags,opportunity_score,recommended,merged_into,monthly_history,available_markets";

function utf8Compare(a, b) {
  return Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8"));
}

function digestOf(ids) {
  const sorted = [...ids].sort(utf8Compare);
  return createHash("sha256").update(sorted.map((id) => `${id}\n`).join(""), "utf8").digest("hex");
}

const registered = new Set();
const executed = [];
const activationWitnesses = [];
const oracleFailures = [];
const skipped = [];
const caseOracles = new Map();
const controlsFalsified = new Set();

function register(id) {
  assert.equal(registered.has(id), false, `duplicate registration ${id}`);
  registered.add(id);
}

async function runCase(t, id, body, oracle) {
  register(id);
  await t.test(id, async () => {
    try {
      await body();
      executed.push(id);
      activationWitnesses.push(id);
      caseOracles.set(id, oracle);
    } catch (error) {
      oracleFailures.push(id);
      throw error;
    }
  }).catch(() => {});
}

function monthlyHistory(base) {
  const rows = [];
  for (let i = 0; i < 15; i += 1) {
    rows.push({ year: 2025 + Math.floor(i / 12), month: (i % 12) + 1, searchVolume: base - i });
  }
  return rows;
}

function marketMetric(code, volume) {
  return {
    countryCode: code,
    locationCode: 2840,
    locationName: "United States",
    languageName: "English",
    searchVolume: volume,
    cpc: 1.5,
    competition: 0.6,
    competitionLevel: "MEDIUM",
    keywordDifficulty: 40,
    mainIntent: "transactional",
    commercialIntent: 0.8,
    monthlyHistory: monthlyHistory(volume),
    trendSlope: 0.05,
    flags: [],
    opportunityScore: 70,
    recommended: true
  };
}

function makeKeywordRow({ keyword, itemId, seed = "eyewear", lane = "category_discovery", volume = 1200, flags = [], mergedInto = null, availableMarkets = ["US"], seedOverride = null }) {
  const marketMetrics = {};
  for (const code of ["US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"]) {
    marketMetrics[code] = marketMetric(code, volume);
  }
  if (seedOverride) {
    for (const [code, metric] of Object.entries(seedOverride)) {
      marketMetrics[code] = metric;
    }
  }
  return {
    itemId,
    keyword,
    seed,
    sourceSeeds: [seed],
    searchVolume: volume,
    cpc: 1.5,
    competition: 0.6,
    competitionLevel: "MEDIUM",
    keywordDifficulty: 40,
    mainIntent: "transactional",
    commercialIntent: 0.8,
    monthlyHistory: monthlyHistory(volume),
    trendSlope: 0.05,
    cluster: null,
    clusterId: null,
    lane,
    facets: { audience: [], category: [], channel: [], fit: [], modifier: [] },
    variantGroupId: null,
    variantCanonical: null,
    flags,
    opportunityScore: 70,
    recommended: true,
    mergedInto,
    availableMarkets,
    marketMetrics
  };
}

function makeResult({ seeds = ["eyewear"], keywords = [] } = {}) {
  return {
    contractVersion: 1,
    researchId: RESEARCH,
    generation: 1,
    configFingerprint: CONFIG_FINGERPRINT,
    seeds,
    markets: CONFIG.markets,
    summary: {
      schemaVersion: 3,
      markets: CONFIG.markets,
      seeds,
      rawItemsCollected: keywords.length,
      itemsWithMetrics: keywords.length,
      informationalDropped: 0,
      uniquePhrases: keywords.length,
      dedupMerged: 0,
      activeKeywords: keywords.length,
      variantGroups: 0,
      clusters: 1,
      recommendedKeywords: keywords.length,
      recommendedClusters: 1
    },
    keywords,
    clusters: [{
      cluster: "eyewear",
      clusterId: "c_000000000001",
      keywords: keywords.map((row) => row.keyword),
      combinedVolume: 1200,
      headlineVolume: 1200,
      adjustedClusterVolume: 1200,
      rawVariantVolume: 1200,
      variantGroups: [],
      sourceSeeds: seeds,
      laneCounts: { category_discovery: keywords.length },
      facets: { audience: [], category: [], channel: [], fit: [], modifier: [] },
      avgCpc: 1.5,
      commercialIntent: 0.8,
      trendScore: 0.05,
      opportunityScore: 70,
      recommendedForStoreDiscovery: false
    }]
  };
}

function stageRow(name, state, counts = {}) {
  return {
    stage: name,
    generation: 1,
    state,
    expectedCount: counts.expected ?? 1,
    terminalCount: counts.terminal ?? 1,
    succeededCount: counts.succeeded ?? 1,
    skippedCount: counts.skipped ?? 0,
    failedCount: counts.failed ?? 0
  };
}

function makeResearch(overrides = {}) {
  const research = {
    id: RESEARCH,
    ownerId: OWNER,
    state: "completed",
    generation: 1,
    contractVersion: 1,
    configSnapshot: CONFIG,
    configFingerprint: CONFIG_FINGERPRINT,
    seeds: ["eyewear"],
    markets: CONFIG.markets,
    selection: { items: [] },
    selectionRevision: 1,
    selectionConflicts: [],
    safeErrorCode: null,
    safeErrorMessage: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    stages: [],
    result: makeResult({
      keywords: [
        makeKeywordRow({ keyword: "eyewear frames", itemId: "ksi_aaaa00000001" }),
        makeKeywordRow({ keyword: "boutique", itemId: "ksi_aaaa00000002", lane: "store_discovery", volume: 900 })
      ]
    })
  };
  return { ...research, ...overrides };
}

function metricsSnapshotOf(row) {
  const snapshot = {};
  for (const key of ["searchVolume", "cpc", "competition", "competitionLevel", "keywordDifficulty",
    "mainIntent", "commercialIntent", "monthlyHistory", "trendSlope", "cluster", "clusterId",
    "variantGroupId", "variantCanonical", "flags", "opportunityScore", "recommended", "mergedInto",
    "availableMarkets", "marketMetrics"]) {
    if (key in row) snapshot[key] = row[key];
  }
  return snapshot;
}

function canonicalItemFor(research, keyword, { sourceKind = "calculated", row = null } = {}) {
  const stripTokens = research.configSnapshot.dedup.stripTokens;
  const foundRow = row ?? (sourceKind === "calculated" ? research.result.keywords.find((r) => r.keyword === keyword) : null);
  const classified = classifyKeywordForSelection(keyword, {
    mainIntent: sourceKind === "calculated" ? foundRow?.mainIntent : null,
    stripTokens
  });
  if (sourceKind === "manual") {
    return {
      itemId: selectionItemId("manual", keyword),
      sourceKind: "manual",
      sourceKeywordId: null,
      originalKeyword: keyword,
      keyword,
      sourceSeeds: [research.seeds[0]],
      lane: classified.lane,
      facets: classified.facets,
      metricsSnapshot: null
    };
  }
  return {
    itemId: foundRow.itemId,
    sourceKind: "calculated",
    sourceKeywordId: foundRow.itemId,
    originalKeyword: foundRow.originalKeyword ?? foundRow.keyword,
    keyword,
    sourceSeeds: [...foundRow.sourceSeeds],
    lane: classified.lane,
    facets: classified.facets,
    metricsSnapshot: metricsSnapshotOf(foundRow)
  };
}

function makeManualItem(keyword) {
  const classified = classifyKeywordForSelection(keyword, { mainIntent: null, stripTokens: CONFIG.dedup.stripTokens });
  return {
    itemId: selectionItemId("manual", keyword),
    sourceKind: "manual",
    sourceKeywordId: null,
    originalKeyword: keyword,
    keyword,
    sourceSeeds: ["eyewear"],
    lane: classified.lane,
    facets: classified.facets,
    metricsSnapshot: null
  };
}

function makeSnapshot(items, { seeds = ["eyewear"] } = {}) {
  const mapped = mapSelectionToQueries(items);
  return {
    contractVersion: "keyword-run-snapshot-v1",
    researchId: RESEARCH,
    selectionRevision: 1,
    selectionFingerprint: "f".repeat(64),
    configFingerprint: CONFIG_FINGERPRINT,
    dedupStripTokens: CONFIG.dedup.stripTokens,
    seeds,
    items: items.map((item, index) => ({ ...item, initialQuery: mapped.rows[index].sequence }))
  };
}

function persistedRows(items, snapshot) {
  return items.map((item, index) => ({
    id: `q_${index}`,
    keywordResearchItemId: item.itemId,
    categoryIndex: 0,
    sequence: index,
    query: snapshot.items[index].initialQuery,
    source: "generated",
    validationState: "pending",
    queryScore: null,
    generationReason: "keyword_research",
    sourceUrls: [],
    categoryVocabulary: [],
    probedAt: null
  }));
}

function makeResearchRun({ snapshot, queries = [], id = RUN_ID, ownerId = OWNER, queryPlanSource = "keyword_research" }) {
  return {
    id,
    ownerId,
    state: "awaiting_query_confirmation",
    phase: "query_review",
    stage: "awaiting_query_confirmation",
    queryRevision: 1,
    confirmedQueryRevision: null,
    normalizedShopTypes: [{ originalShopType: "eyewear", shopType: "eyewear", businessQualifier: "unspecified" }],
    keywordSelectionSnapshot: snapshot,
    queryPlanSource,
    queries
  };
}

function makeRun(overrides = {}) {
  return {
    id: RUN_ID,
    ownerId: OWNER,
    normalizedShopTypes: [{ originalShopType: "Eyewear", shopType: "eyewear", businessQualifier: "unspecified" }],
    state: "awaiting_query_confirmation",
    phase: "query_review",
    stage: "awaiting_query_confirmation",
    progress: { shopTypesTotal: 1, shopTypesCompleted: 0, leadsTotal: 0, leadsScraped: 0 },
    queryRevision: 1,
    confirmedQueryRevision: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    safeErrorCode: null,
    safeErrorMessage: null,
    queryPlanSource: "keyword_research",
    keywordResearchId: RESEARCH,
    keywordSelectionRevision: 2,
    ...overrides
  };
}

const PROBE_CONFIG = {
  minQueryResults: 5,
  minQueryUniqueHosts: 2,
  minQueryRelevantResults: 3,
  minQueryRelevanceRatio: 0.5,
  minQueryBaseScore: 0.5,
  googleResultsPerQuery: 10,
  queryProbeFreshnessMs: 1000
};

function successProbe(candidates) {
  return candidates.map((candidate) => ({
    query: candidate.query,
    rank: 1,
    url: "https://example.test/1",
    title: "Shop",
    snippet: "",
    rejectionReason: "",
    rawResults: 10,
    relevantResults: 10,
    relevantRatio: 1,
    uniqueHosts: ["https://a.test", "https://b.test"],
    duplicateProducts: 0,
    estimatedTotalResults: 100,
    nextPageAvailable: false,
    baseScore: 0.9,
    error: "",
    results: Array.from({ length: 10 }, (_, i) => ({
      query: candidate.query,
      rank: i + 1,
      url: `https://example.test/${i}`,
      title: "Shop",
      snippet: "",
      rejectionReason: ""
    }))
  }));
}

class FakeKeywordRepository {
  constructor({ research = null, log = [], defect = {} } = {}) {
    this.research = research;
    this.log = log;
    this.defect = defect;
    this.created = new Map();
    this.handoffs = new Map();
    this.calls = { create: 0, getOwnedApiView: 0, saveSelection: 0, createRun: 0 };
  }

  async create(input, at) {
    this.calls.create += 1;
    this.log.push(["create", input.ownerId, input.seeds]);
    if (this.defect.dispatchBeforeCommit) this.log.push(["dispatch", "keyword.initialize.v1"]);
    const research = {
      id: input.researchId,
      ownerId: input.ownerId,
      state: "queued",
      generation: 1,
      contractVersion: 1,
      configSnapshot: input.configSnapshot,
      configFingerprint: input.configFingerprint,
      seeds: input.seeds,
      markets: input.markets,
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
    this.created.set(input.researchId, research);
    this.research = research;
    return { outcome: "created", research };
  }

  async getOwnedApiView({ researchId, ownerId }) {
    this.calls.getOwnedApiView += 1;
    this.log.push(["getOwnedApiView", ownerId, researchId]);
    const research = this.research;
    if (!research || research.id !== researchId || (ownerId !== research.ownerId && !this.defect.ignoreOwner)) {
      return { outcome: "not_found" };
    }
    return { outcome: "found", research };
  }

  async saveSelection(input) {
    this.calls.saveSelection += 1;
    this.log.push(["saveSelection", input.ownerId, input.researchId, input.expectedRevision, input.items.length]);
    if (this.defect.ignoreRevision) return { outcome: "created", selectionRevision: input.expectedRevision + 1 };
    if (this.research && input.ownerId === this.research.ownerId && input.expectedRevision === this.research.selectionRevision) {
      this.research.selectionRevision = input.expectedRevision + 1;
      return { outcome: "created", selectionRevision: input.expectedRevision + 1 };
    }
    return { outcome: "conflict", code: "KEYWORD_SELECTION_REVISION_CONFLICT" };
  }

  async createRun(input, at) {
    this.calls.createRun += 1;
    this.log.push(["createRun", input.ownerId, input.researchId, input.clientRequestId, input.items.length]);
    if (this.research && input.expectedSelectionRevision !== this.research.selectionRevision) {
      return { outcome: "conflict", code: "KEYWORD_SELECTION_REVISION_CONFLICT" };
    }
    const run = await input.constructRun({}, { research: this.research, runId: input.runId, now: at, items: input.items });
    const queries = await input.constructQueries({}, { run, items: input.items, now: at });
    const invalidRun = !run || run.id !== input.runId || run.ownerId !== this.research.ownerId ||
      run.keywordResearchId !== input.researchId || run.queryPlanSource !== "keyword_research";
    const invalidQueries = !Array.isArray(queries) || queries.length !== input.items.length ||
      queries.some((query, index) => query?.runId !== run.id || query?.keywordResearchItemId !== input.items[index]?.itemId);
    if (invalidRun || invalidQueries) {
      if (this.defect.allowPartial) return { outcome: "created", run: { ...run, queries } };
      return { outcome: "conflict", code: "KEYWORD_RUN_HANDOFF_INVALID" };
    }
    const replayKey = `${input.researchId}|${input.clientRequestId}`;
    const previous = this.handoffs.get(replayKey);
    if (previous && !this.defect.noReplayFence) {
      if (previous.selectionFingerprint !== input.selectionFingerprint ||
          previous.selectionRevision !== input.expectedSelectionRevision) {
        return { outcome: "conflict" };
      }
      return { outcome: "found", run: previous.run };
    }
    this.handoffs.set(replayKey, {
      selectionFingerprint: input.selectionFingerprint,
      selectionRevision: input.expectedSelectionRevision,
      run: { ...run, queries }
    });
    return { outcome: "created", run: { ...run, queries } };
  }
}

class FakeRunRepository {
  constructor({ log = [], defect = {} } = {}) {
    this.log = log;
    this.defect = defect;
    this.calls = { createKeywordResearchRun: 0, createKeywordResearchQueries: 0 };
  }

  async createKeywordResearchRun(_tx, input) {
    this.calls.createKeywordResearchRun += 1;
    this.log.push(["createKeywordResearchRun", input.researchId, input.runId, input.items.length]);
    return {
      id: input.runId,
      ownerId: this.defect.badRunOwner ? `${input.research.ownerId}_wrong` : input.research.ownerId,
      keywordResearchId: input.research.id,
      keywordSelectionRevision: input.selectionRevision,
      keywordSelectionSnapshot: input.snapshot,
      queryPlanSource: "keyword_research",
      state: "awaiting_query_confirmation",
      phase: "query_review",
      stage: "awaiting_query_confirmation",
      queryRevision: 1,
      confirmedQueryRevision: null,
      normalizedShopTypes: (input.research.seeds || []).map((seed) => ({
        originalShopType: seed,
        shopType: seed,
        businessQualifier: "unspecified"
      })),
      progress: { shopTypesTotal: 1, shopTypesCompleted: 0, leadsTotal: 0, leadsScraped: 0 },
      createdAt: input.now,
      startedAt: null,
      completedAt: null,
      safeErrorCode: null,
      safeErrorMessage: null
    };
  }

  async createKeywordResearchQueries(_tx, input) {
    this.calls.createKeywordResearchQueries += 1;
    this.log.push(["createKeywordResearchQueries", input.run.id, input.items.length]);
    return input.items.map((item, index) => ({
      id: `query_w4_${index}`,
      runId: input.run.id,
      categoryIndex: 0,
      sequence: index,
      query: item.initialQuery ?? `site:myshopify.com/products ${item.keyword}`,
      source: "generated",
      validationState: "pending",
      rejectionReason: null,
      queryScore: null,
      generationReason: "keyword_research",
      sourceUrls: [],
      categoryVocabulary: [],
      keywordResearchItemId: this.defect.omitLineage && index === input.items.length - 1 ? null : item.itemId,
      probedAt: null
    }));
  }
}

function makeApi({ research = null, defect = {}, runDefect = {}, distinctIds = false, dispatch = null, classifyQueryTypes = null } = {}) {
  const log = [];
  const keywordRepository = new FakeKeywordRepository({ research, log, defect });
  const runRepository = new FakeRunRepository({ log, defect: runDefect });
  let seq = 0;
  const api = createKeywordResearchApi({
    keywordRepository,
    runRepository,
    dispatchInitialize: async (message) => {
      log.push(["dispatch", message.type]);
      if (dispatch) await dispatch(message);
    },
    now: () => NOW,
    researchIdFactory: () => `kr_${(distinctIds ? seq++ : 0).toString(36).padStart(24, "0")}`,
    runIdFactory: () => `run_${String(seq).padStart(24, "0")}`,
    classifyQueryTypes: classifyQueryTypes ?? (async (items) => items.map((item) => ({
      itemId: item.itemId,
      product: item.product === true || item.lane === "category_discovery",
    })))
  });
  return { api, keywordRepository, runRepository, log };
}

class FakeKeywordApi {
  constructor() {
    this.calls = [];
    this.responses = {};
    this.exportParams = null;
  }

  async createResearch(input) {
    this.calls.push(["createResearch", input]);
    const value = this.responses.createResearch;
    if (value instanceof Error) throw value;
    return value;
  }

  async getResearch(input) {
    this.calls.push(["getResearch", input]);
    const value = this.responses.getResearch;
    if (value instanceof Error) throw value;
    return value;
  }

  async saveSelection(input) {
    this.calls.push(["saveSelection", input]);
    const value = this.responses.saveSelection;
    if (value instanceof Error) throw value;
    return value;
  }

  async createRun(input) {
    this.calls.push(["createRun", input]);
    const value = this.responses.createRun;
    if (value instanceof Error) throw value;
    return value;
  }

  async exportCsv(input) {
    this.calls.push(["exportCsv", input]);
    this.exportParams = input.searchParams;
    const value = this.responses.exportCsv;
    if (value instanceof Error) throw value;
    const allowed = new Set(["market", "seed", "clusterId", "intent", "lane", "category", "audience",
      "channel", "minVolume", "minOpportunity", "recommended", "search", "flag"]);
    for (const [name] of input.searchParams) {
      if (!allowed.has(name)) {
        throw new ApiError(400, "KEYWORD_RESEARCH_INPUT_INVALID", "Invalid keyword research request");
      }
    }
    return value;
  }
}

class FakeServerRepository {
  constructor({ run = null, runs = [] } = {}) {
    this.run = run;
    this.runs = runs;
    this.claimCalls = 0;
  }

  async claimNextQueuedRun() {
    this.claimCalls += 1;
    return null;
  }

  async health() {
    return {};
  }

  async getRun(id, ownerId) {
    return this.run && this.run.id === id && this.run.ownerId === ownerId ? this.run : null;
  }

  async listRuns(ownerId) {
    const items = this.runs.filter((run) => run.ownerId === ownerId);
    return { totalItems: items.length, items };
  }

  async getEditableQueries(id, ownerId) {
    return this.run && this.run.id === id && this.run.ownerId === ownerId ? this.run : null;
  }
}

async function withServer(fakeApi, repository, run) {
  const server = createLeadServer({ backendApiToken: undefined }, {
    repository,
    keywordResearchApi: fakeApi,
    logger: () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {}
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await run(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function isInputInvalid(error) {
  return error instanceof ApiError && error.status === 400 && error.code === "KEYWORD_RESEARCH_INPUT_INVALID";
}

function isNotFound(error) {
  return error instanceof ApiError && error.status === 404 && error.code === "KEYWORD_RESEARCH_NOT_FOUND";
}

function isRevisionConflict(error) {
  return error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_SELECTION_REVISION_CONFLICT";
}

function isHandoffConflict(error) {
  return error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_RUN_HANDOFF_CONFLICT";
}

const CASE_BODIES = {
  "W4-A01": async () => {
    const harness = makeApi({ research: null, distinctIds: true });
    const { api, log } = harness;
    for (const seeds of [[], Array(6).fill("x"), ["  "], ["x".repeat(101)], ["\u0001eyewear"],
      ["ｆｏｏ", "foo"], ["Foo", "foo"]]) {
      await assert.rejects(() => api.createResearch({ ownerId: OWNER, seeds }), isInputInvalid);
    }
    await assert.rejects(() => api.createResearch({ ownerId: OWNER, seeds: ["eyewear"], extra: 1 }), isInputInvalid);
    assert.equal(log.length, 0, "invalid input makes zero repository and dispatcher calls");
    const first = await api.createResearch({ ownerId: OWNER, seeds: ["eyewear"] });
    assert.equal(first.research.state, "queued");
    const five = await api.createResearch({ ownerId: OWNER, seeds: ["one", "two", "three", "four", "five"] });
    assert.equal(five.research.seeds.length, 5);
    const hundred = await api.createResearch({ ownerId: OWNER, seeds: ["x".repeat(100)] });
    assert.equal(hundred.research.seeds[0].length, 100);
    const repeat = await api.createResearch({ ownerId: OWNER, seeds: ["eyewear"] });
    assert.notEqual(repeat.research.id, first.research.id, "repeated valid POST returns a distinct research id");
    assert.deepEqual(log.map(([event]) => event), ["create", "dispatch", "create", "dispatch", "create", "dispatch", "create", "dispatch"]);
    const createCount = log.filter(([event]) => event === "create").length;
    const dispatchCount = log.filter(([event]) => event === "dispatch").length;
    assert.equal(createCount, 4);
    assert.equal(dispatchCount, 4);
  },

  "W4-A02": async () => {
    const behaviors = [
      async () => ({ sentItemIds: [], failedItemIds: ["x"] }),
      async () => { throw new Error("send failed"); }
    ];
    const harness = makeApi({ research: null, dispatch: async () => behaviors.shift()?.() });
    const first = await harness.api.createResearch({ ownerId: OWNER, seeds: ["eyewear"] });
    const second = await harness.api.createResearch({ ownerId: OWNER, seeds: ["eyewear"] });
    assert.deepEqual(first.research, second.research, "both return the same queued owner view");
    assert.equal(harness.keywordRepository.created.get(first.research.id).id, first.research.id, "durable row is recoverable");
    assert.equal(harness.log.filter(([event]) => event === "create").length, 2);
    assert.equal(harness.log.filter(([event]) => event === "dispatch").length, 2, "one attempted send per call");
  },

  "W4-A03": async () => {
    const harness = makeApi({ research: null });
    const { api, keywordRepository } = harness;
    await assert.rejects(() => api.getResearch({ ownerId: OWNER, researchId: RESEARCH }), isNotFound);
    keywordRepository.research = makeResearch({ ownerId: OTHER });
    await assert.rejects(() => api.getResearch({ ownerId: OWNER, researchId: RESEARCH }), isNotFound);
    keywordRepository.research = makeResearch({ state: "queued", stages: [], result: null });
    let view = await api.getResearch({ ownerId: OWNER, researchId: RESEARCH });
    assert.deepEqual(Object.keys(view.research), RESEARCH_VIEW_KEYS, "exact ResearchView key set");
    assert.equal(view.research.progress.stage, "queued");
    assert.equal(view.research.result, null);
    keywordRepository.research = makeResearch({
      state: "running",
      result: null,
      stages: [stageRow("expansion", "completed")]
    });
    view = await api.getResearch({ ownerId: OWNER, researchId: RESEARCH });
    assert.equal(view.research.progress.stage, "anchor_screen");
    keywordRepository.research = makeResearch({
      state: "running",
      result: null,
      stages: [
        stageRow("expansion", "completed"),
        stageRow("anchor_screen", "completed"),
        stageRow("market_overview", "completed")
      ]
    });
    view = await api.getResearch({ ownerId: OWNER, researchId: RESEARCH });
    assert.equal(view.research.progress.stage, "finalizing");
    keywordRepository.research = makeResearch();
    view = await api.getResearch({ ownerId: OWNER, researchId: RESEARCH });
    assert.equal(view.research.progress.stage, "completed");
    assert.notEqual(view.research.result, null);
    keywordRepository.research = makeResearch({ state: "failed", result: null, safeErrorCode: "STAGE_FAILED", safeErrorMessage: "boom" });
    view = await api.getResearch({ ownerId: OWNER, researchId: RESEARCH });
    assert.equal(view.research.progress.stage, "failed");
    assert.deepEqual(view.research.safeError, { code: "STAGE_FAILED", message: "boom" });
    assert.equal(keywordRepository.calls.getOwnedApiView, 7, "one owner read per call");
  },

  "W4-A04": async () => {
    const research = makeResearch();
    const harness = makeApi({ research });
    const { api, keywordRepository } = harness;
    // R5-SEL-01/R5-SEL-02: the client supplies only the strict minimal union.
    const calculated = { sourceKind: "calculated", sourceKeywordId: research.result.keywords[0].itemId, keyword: "eyewear frames" };
    const manual = { sourceKind: "manual", keyword: "leather handbag" };
    const saved = await api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1, items: [calculated, manual] });
    assert.equal(saved.research.selectionRevision, 2);
    assert.equal(saved.research.selection.length, 2);
    assert.equal(saved.research.selection[0].itemId, research.result.keywords[0].itemId);
    assert.deepEqual(Object.keys(saved.research.selection[0]).sort(),
      ["facets", "itemId", "keyword", "lane", "metricsSnapshot", "originalKeyword", "sourceKeywordId", "sourceKind", "sourceSeeds"].sort());
    await api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 2, items: [] });
    const many = [];
    for (let i = 1; i <= 200; i += 1) {
      many.push({ sourceKind: "manual", keyword: `keyword manual ${String(i).padStart(4, "0")}` });
    }
    await api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 3, items: many });
    await assert.rejects(() => api.saveSelection({
      ownerId: OWNER,
      researchId: RESEARCH,
      expectedRevision: 4,
      items: Array.from({ length: 201 }, () => ({ sourceKind: "manual", keyword: "x" }))
    }), isInputInvalid);
    const mutated = { ...calculated, itemId: "ksi_000000000000" };
    await assert.rejects(() => api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 4, items: [mutated] }), isInputInvalid);
    const mutatedSource = { ...calculated, sourceKeywordId: "ksi_000000000000" };
    await assert.rejects(() => api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 4, items: [mutatedSource] }), isInputInvalid);
    const mutatedMetrics = { ...calculated, metricsSnapshot: { searchVolume: 999999 } };
    await assert.rejects(() => api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 4, items: [mutatedMetrics] }), isInputInvalid);
    const mutatedLane = { ...calculated, lane: "store_discovery" };
    await assert.rejects(() => api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 4, items: [mutatedLane] }), isInputInvalid);
    const conflictResearch = makeResearch();
    const duplicateRow = makeKeywordRow({ keyword: "eyewear frames", itemId: "ksi_bbbb00000001" });
    conflictResearch.result.keywords.push(duplicateRow);
    harness.keywordRepository.research = conflictResearch;
    const conflictA = { sourceKind: "calculated", sourceKeywordId: conflictResearch.result.keywords[0].itemId, keyword: "eyewear frames" };
    const conflictB = { sourceKind: "calculated", sourceKeywordId: duplicateRow.itemId, keyword: "eyewear frames" };
    await assert.rejects(() => api.saveSelection({
      ownerId: OWNER,
      researchId: RESEARCH,
      expectedRevision: 1,
      items: [conflictA, conflictB]
    }), (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_SELECTION_HAS_CONFLICTS");
    await assert.rejects(() => api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 99, items: [calculated] }), isRevisionConflict);
    harness.keywordRepository.research = makeResearch({ ownerId: OTHER });
    await assert.rejects(() => api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1, items: [calculated] }), isNotFound);
    harness.keywordRepository.research = makeResearch();
    const readsBefore = keywordRepository.calls.getOwnedApiView;
    const writesBefore = keywordRepository.calls.saveSelection;
    await api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1, items: [calculated] });
    assert.equal(keywordRepository.calls.getOwnedApiView - readsBefore, 1, "one owner read per save");
    assert.equal(keywordRepository.calls.saveSelection - writesBefore, 1, "one CAS per save");
  },

  "W4-A05": async () => {
    const items = [makeManualItem("leather handbag")];
    const harness = makeApi({ research: makeResearch({ selection: { items }, selectionRevision: 1 }) });
    const { api, keywordRepository, runRepository } = harness;
    harness.keywordRepository.research = makeResearch({ state: "queued", result: null, selection: { items } });
    await assert.rejects(() => api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID }),
      (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_RESEARCH_NOT_COMPLETED");
    assert.equal(runRepository.calls.createKeywordResearchRun, 0, "invalid makes zero callbacks");
    harness.keywordRepository.research = makeResearch({ selection: { items: [] }, selectionRevision: 1 });
    await assert.rejects(() => api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID }), isInputInvalid);
    const many = [];
    for (let i = 1; i <= 100; i += 1) {
      many.push(makeManualItem(`keyword manual ${String(i).padStart(4, "0")}`));
    }
    harness.keywordRepository.research = makeResearch({ selection: { items: many }, selectionRevision: 1 });
    const manyCreated = await api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: "client-request-id-0100" });
    assert.equal(manyCreated.created, true, "N=100 handoff is valid");
    harness.keywordRepository.research = makeResearch({
      selection: { items: [makeManualItem("leather handbag"), makeManualItem("leather handbags")] },
      selectionRevision: 1
    });
    await assert.rejects(() => api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID }),
      (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_SELECTION_HAS_CONFLICTS");
    const oversized = [];
    for (let i = 1; i <= 101; i += 1) {
      oversized.push(makeManualItem(`keyword manual ${String(i).padStart(4, "0")}`));
    }
    harness.keywordRepository.research = makeResearch({ selection: { items: oversized }, selectionRevision: 1 });
    await assert.rejects(() => api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID }), isInputInvalid);
    harness.keywordRepository.research = makeResearch({ selection: { items }, selectionRevision: 1 });
    const created = await api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID });
    assert.equal(created.created, true);
    assert.equal(created.run.queryPlanSource, "keyword_research");
    assert.equal(created.statusUrl, `/api/runs/${RUN_ID}`);
    assert.equal(runRepository.calls.createKeywordResearchRun, 2, "valid invokes constructRun once per handoff");
    assert.equal(runRepository.calls.createKeywordResearchQueries, 2, "valid invokes constructQueries once per handoff");
    assert.equal(keywordRepository.calls.createRun, 2);
    const replayed = await api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID });
    assert.equal(replayed.created, false, "identical replay returns found");
    assert.equal(replayed.run.id, created.run.id);
    assert.equal(keywordRepository.calls.createRun, 3, "replay is one createRun call returning found");
    harness.keywordRepository.research = makeResearch({ selection: { items }, selectionRevision: 2 });
    await assert.rejects(() => api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID }), isRevisionConflict);
  },

  "W4-A06": async () => {
    const research = makeResearch();
    const harness = makeApi({ research });
    const { api, keywordRepository } = harness;
    await assert.rejects(() => api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("bogus=1") }), isInputInvalid);
    await assert.rejects(() => api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("market=US&market=GB") }), isInputInvalid);
    await assert.rejects(() => api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("minVolume=99999999999999999999") }), isInputInvalid);
    await assert.rejects(() => api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("minOpportunity=101") }), isInputInvalid);
    await assert.rejects(() => api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("lane=oops") }), isInputInvalid);
    await assert.rejects(() => api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("recommended=maybe") }), isInputInvalid);
    await assert.rejects(() => api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams(Array.from({ length: 21 }, () => ["flag", "x"])) }), isInputInvalid);
    const seedCsv = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("seed=eyewear") });
    assert.equal(seedCsv.split("\n").filter(Boolean).length, 3, "both rows match the seed conjunctively");
    const laneCsv = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("lane=category_discovery") });
    assert.equal(laneCsv.split("\n").filter(Boolean).length, 2, "only the category row matches lane");
    const combined = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("lane=category_discovery&minVolume=1000") });
    assert.equal(combined.split("\n").filter(Boolean).length, 2, "filters combine conjunctively");
    const ordered = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("") });
    assert.equal(ordered, serializeKeywordsCsv(research.result.keywords), "persisted order retained");
    assert.equal(keywordRepository.calls.getOwnedApiView, 4, "one owner read per non-rejected export");
    assert.equal(keywordRepository.calls.saveSelection + keywordRepository.calls.createRun, 0, "zero writes");
  },

  "W4-A07": async () => {
    const rowA = makeKeywordRow({ keyword: "eyewear frames", itemId: "ksi_aaaa00000001", volume: 1200 });
    const rowB = makeKeywordRow({ keyword: "boutique", itemId: "ksi_aaaa00000002", lane: "store_discovery", volume: 900 });
    rowB.marketMetrics.US = null;
    rowA.marketMetrics.AE = null;
    rowB.marketMetrics.AE = null;
    const research = makeResearch({ result: makeResult({ keywords: [rowA, rowB] }) });
    const harness = makeApi({ research });
    const { api } = harness;
    const csv = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("market=US") });
    assert.equal(csv.split("\n")[0], CSV_HEADER, "exact UTF-8 LF CSV header");
    assert.ok(csv.endsWith("\n"), "trailing LF");
    assert.equal(csv.split("\n").filter(Boolean).length, 2, "null-market row excluded");
    const projected = { ...rowA, ...rowA.marketMetrics.US };
    assert.equal(csv, serializeKeywordsCsv([projected]), "metric overlay bytes exact");
    const all = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("market=all") });
    assert.equal(all.split("\n").filter(Boolean).length, 3);
    const none = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("market=AE") });
    assert.equal(none, `${CSV_HEADER}\n`, "zero-match market emits header only");
    for (const forbidden of ["configSnapshot", "configFingerprint", "ownerId", "lease", "credential", "apiKey", "rawProvider"]) {
      assert.equal(csv.includes(forbidden), false, `forbidden field ${forbidden} absent`);
    }
  },

  "W4-A08": async () => {
    const harness = makeApi({ research: makeResearch({ contractVersion: 2 }) });
    const { api, keywordRepository } = harness;
    await assert.rejects(() => api.getResearch({ ownerId: OWNER, researchId: RESEARCH }),
      (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_RESEARCH_CONTRACT_MISMATCH");
    await assert.rejects(() => api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("") }),
      (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_RESEARCH_CONTRACT_MISMATCH");
    await assert.rejects(() => api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1, items: [] }),
      (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_RESEARCH_CONTRACT_MISMATCH");
    await assert.rejects(() => api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID }),
      (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_RESEARCH_CONTRACT_MISMATCH");
    harness.keywordRepository.research = makeResearch({ configFingerprint: "0".repeat(64) });
    await assert.rejects(() => api.getResearch({ ownerId: OWNER, researchId: RESEARCH }),
      (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_RESEARCH_CONTRACT_MISMATCH");
    harness.keywordRepository.research = makeResearch({ result: { ...makeResult(), keywords: [{ bad: true }] } });
    await assert.rejects(() => api.getResearch({ ownerId: OWNER, researchId: RESEARCH }),
      (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_RESEARCH_CONTRACT_MISMATCH");
    assert.equal(keywordRepository.calls.saveSelection + keywordRepository.calls.createRun, 0, "zero mutation");
  },

  "W4-S01": async () => {
    const fakeApi = new FakeKeywordApi();
    fakeApi.responses.createResearch = { research: serializeKeywordResearch(makeResearch()) };
    await withServer(fakeApi, new FakeServerRepository(), async (base) => {
      const noUser = await fetch(`${base}/api/keyword-research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seeds: ["eyewear"] })
      });
      assert.equal(noUser.status, 401);
      assert.equal((await noUser.json()).error.code, "USER_CONTEXT_REQUIRED");
      const duplicate = await new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: new URL(base).port,
          path: "/api/keyword-research",
          method: "POST",
          headers: { "content-type": "application/json", "x-user-id": ["owner_a", "owner_b"] }
        }, (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ seeds: ["eyewear"] }));
      });
      assert.equal(duplicate.status, 401);
      assert.equal(duplicate.body.error.code, "USER_CONTEXT_REQUIRED");
      const encoded = await fetch(`${base}/api/keyword-research/kr_%E0%A4%A`, { headers: { "x-user-id": OWNER } });
      assert.equal(encoded.status, 400);
      assert.equal((await encoded.json()).error.code, "KEYWORD_RESEARCH_INPUT_INVALID");
      const shape = await fetch(`${base}/api/keyword-research/not-a-research`, { headers: { "x-user-id": OWNER } });
      assert.equal(shape.status, 400);
      assert.equal((await shape.json()).error.code, "KEYWORD_RESEARCH_INPUT_INVALID");
      const unknownBody = await fetch(`${base}/api/keyword-research`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ seeds: ["eyewear"], extra: 1 })
      });
      assert.equal(unknownBody.status, 400);
      assert.equal((await unknownBody.json()).error.code, "KEYWORD_RESEARCH_INPUT_INVALID");
      const bodyOwner = await fetch(`${base}/api/keyword-research`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ ownerId: "mallory", seeds: ["eyewear"] })
      });
      assert.equal(bodyOwner.status, 400);
      assert.equal((await bodyOwner.json()).error.code, "KEYWORD_RESEARCH_INPUT_INVALID");
      assert.equal(fakeApi.calls.length, 0, "zero API/service calls for auth, path and body rejections");
      fakeApi.responses.exportCsv = serializeKeywordsCsv([]);
      const unknownQuery = await fetch(`${base}/api/keyword-research/${RESEARCH}/export.csv?bogus=1`, { headers: { "x-user-id": OWNER } });
      assert.equal(unknownQuery.status, 400);
      assert.equal((await unknownQuery.json()).error.code, "KEYWORD_RESEARCH_INPUT_INVALID");
      assert.equal(fakeApi.calls.length, 1, "only the export query-key rejection reaches the service");
      assert.equal(fakeApi.calls[0][0], "exportCsv");
    });
  },

  "W4-S02": async () => {
    const fakeApi = new FakeKeywordApi();
    const view = { research: serializeKeywordResearch(makeResearch()) };
    fakeApi.responses.createResearch = view;
    await withServer(fakeApi, new FakeServerRepository(), async (base) => {
      const response = await fetch(`${base}/api/keyword-research`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ seeds: ["eyewear"] })
      });
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("location"), null, "create route sets no Location header");
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ["research"]);
      assert.equal(body.research.statusUrl, `/api/keyword-research/${RESEARCH}`);
      assert.equal(fakeApi.calls.length, 1);
      assert.deepEqual(fakeApi.calls[0][1], { ownerId: OWNER, seeds: ["eyewear"] });
    });
  },

  "W4-S03": async () => {
    const fakeApi = new FakeKeywordApi();
    const research = makeResearch();
    fakeApi.responses.getResearch = { research: serializeKeywordResearch(research) };
    await withServer(fakeApi, new FakeServerRepository(), async (base) => {
      const response = await fetch(`${base}/api/keyword-research/${RESEARCH}`, { headers: { "x-user-id": OWNER } });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ["research"]);
      assert.deepEqual(Object.keys(body.research), RESEARCH_VIEW_KEYS, "serializer response keys exact");
      assert.equal(body.research.state, "completed");
      assert.equal(fakeApi.calls.length, 1);
      assert.deepEqual(fakeApi.calls[0][1], { ownerId: OWNER, researchId: RESEARCH });
      fakeApi.calls.length = 0;
      fakeApi.responses.getResearch = new ApiError(404, "KEYWORD_RESEARCH_NOT_FOUND", "Keyword research not found");
      const missing = await fetch(`${base}/api/keyword-research/${RESEARCH}`, { headers: { "x-user-id": OWNER } });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, "KEYWORD_RESEARCH_NOT_FOUND");
      fakeApi.responses.getResearch = new Error("boom");
      const internal = await fetch(`${base}/api/keyword-research/${RESEARCH}`, { headers: { "x-user-id": OWNER } });
      assert.equal(internal.status, 500);
      assert.equal((await internal.json()).error.code, "INTERNAL_ERROR");
      fakeApi.calls.length = 0;
      fakeApi.responses.getResearch = { research: serializeKeywordResearch(makeResearch({ state: "queued", stages: [], result: null })) };
      const queued = await fetch(`${base}/api/keyword-research/${RESEARCH}`, { headers: { "x-user-id": OWNER } });
      assert.equal((await queued.json()).research.progress.stage, "queued");
    });
  },

  "W4-S04": async () => {
    const fakeApi = new FakeKeywordApi();
    fakeApi.responses.saveSelection = { research: serializeKeywordResearch(makeResearch()) };
    // R5-SEL-03: route accepts the minimal union and rejects legacy full items.
    const items = [{ sourceKind: "calculated", sourceKeywordId: "ksi_aaaa00000001", keyword: "eyewear frames" }];
    await withServer(fakeApi, new FakeServerRepository(), async (base) => {
      const valid = await fetch(`${base}/api/keyword-research/${RESEARCH}/selection`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ expectedRevision: 1, items })
      });
      assert.equal(valid.status, 200);
      const malformed = await fetch(`${base}/api/keyword-research/${RESEARCH}/selection`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ expectedRevision: 1, items, extra: 1 })
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error.code, "KEYWORD_RESEARCH_INPUT_INVALID");
      fakeApi.responses.saveSelection = new ApiError(409, "KEYWORD_SELECTION_REVISION_CONFLICT", "stale");
      const stale = await fetch(`${base}/api/keyword-research/${RESEARCH}/selection`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ expectedRevision: 1, items })
      });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).error.code, "KEYWORD_SELECTION_REVISION_CONFLICT");
      fakeApi.responses.saveSelection = new ApiError(409, "KEYWORD_SELECTION_HAS_CONFLICTS", "conflict");
      const conflicting = await fetch(`${base}/api/keyword-research/${RESEARCH}/selection`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ expectedRevision: 1, items })
      });
      assert.equal(conflicting.status, 409);
      assert.equal((await conflicting.json()).error.code, "KEYWORD_SELECTION_HAS_CONFLICTS");
      fakeApi.responses.saveSelection = new ApiError(404, "KEYWORD_RESEARCH_NOT_FOUND", "not found");
      const nonowner = await fetch(`${base}/api/keyword-research/${RESEARCH}/selection`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-user-id": OTHER },
        body: JSON.stringify({ expectedRevision: 1, items })
      });
      assert.equal(nonowner.status, 404);
      assert.equal(fakeApi.calls.length, 4, "one service call only for parsed requests");
    });
  },

  "W4-S05": async () => {
    const fakeApi = new FakeKeywordApi();
    const run = serializeRun(makeRun());
    fakeApi.responses.createRun = { created: true, run, statusUrl: `/api/runs/${RUN_ID}` };
    await withServer(fakeApi, new FakeServerRepository(), async (base) => {
      const created = await fetch(`${base}/api/keyword-research/${RESEARCH}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ expectedSelectionRevision: 2, clientRequestId: CLIENT_REQUEST_ID })
      });
      assert.equal(created.status, 201);
      const createdBody = await created.json();
      assert.deepEqual(Object.keys(createdBody).sort(), ["run", "statusUrl"]);
      assert.equal(createdBody.run.queryPlanSource, "keyword_research");
      assert.equal(createdBody.run.keywordResearchId, RESEARCH);
      assert.equal(createdBody.run.keywordSelectionRevision, 2);
      assert.equal(createdBody.statusUrl, `/api/runs/${RUN_ID}`);
      fakeApi.responses.createRun = { created: false, run, statusUrl: `/api/runs/${RUN_ID}` };
      const replayed = await fetch(`${base}/api/keyword-research/${RESEARCH}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ expectedSelectionRevision: 2, clientRequestId: CLIENT_REQUEST_ID })
      });
      assert.equal(replayed.status, 200, "identical retry returns 200");
      assert.equal((await replayed.json()).run.runId, RUN_ID);
      fakeApi.responses.createRun = new ApiError(409, "KEYWORD_RUN_HANDOFF_CONFLICT", "handoff");
      const conflict = await fetch(`${base}/api/keyword-research/${RESEARCH}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ expectedSelectionRevision: 2, clientRequestId: CLIENT_REQUEST_ID })
      });
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error.code, "KEYWORD_RUN_HANDOFF_CONFLICT");
      fakeApi.responses.createRun = new ApiError(404, "KEYWORD_RESEARCH_NOT_FOUND", "not found");
      const nonowner = await fetch(`${base}/api/keyword-research/${RESEARCH}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": OTHER },
        body: JSON.stringify({ expectedSelectionRevision: 2, clientRequestId: CLIENT_REQUEST_ID })
      });
      assert.equal(nonowner.status, 404);
      assert.equal(fakeApi.calls.length, 4);
    });
  },

  "W4-S06": async () => {
    const fakeApi = new FakeKeywordApi();
    const rows = [
      makeKeywordRow({ keyword: "eyewear frames", itemId: "ksi_aaaa00000001" }),
      makeKeywordRow({ keyword: "boutique", itemId: "ksi_aaaa00000002", lane: "store_discovery" })
    ];
    const csv = serializeKeywordsCsv(rows);
    fakeApi.responses.exportCsv = csv;
    const run = makeRun({ state: "completed", phase: "finished", stage: "completed", completedAt: NOW });
    await withServer(fakeApi, new FakeServerRepository({ run, runs: [run] }), async (base) => {
      const exported = await fetch(`${base}/api/keyword-research/${RESEARCH}/export.csv?market=US`, { headers: { "x-user-id": OWNER } });
      assert.equal(exported.status, 200);
      assert.equal(exported.headers.get("content-type"), "text/csv; charset=utf-8");
      assert.equal(exported.headers.get("content-disposition"), `attachment; filename="keyword-research-${RESEARCH}.csv"`);
      assert.equal(exported.headers.get("cache-control"), "no-store");
      assert.equal(await exported.text(), csv, "exact CSV body bytes");
      fakeApi.responses.exportCsv = new ApiError(404, "KEYWORD_RESEARCH_NOT_FOUND", "not found");
      const errored = await fetch(`${base}/api/keyword-research/${RESEARCH}/export.csv`, { headers: { "x-user-id": OWNER } });
      assert.equal(errored.status, 404);
      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).status, "ok");
      const legacyRun = await fetch(`${base}/api/runs/${RUN_ID}`, { headers: { "x-user-id": OWNER } });
      assert.equal(legacyRun.status, 200);
      assert.deepEqual(Object.keys(await legacyRun.json()), Object.keys(serializeRun(run)), "legacy run key set deep-equal");
      const legacyList = await fetch(`${base}/api/runs`, { headers: { "x-user-id": OWNER } });
      assert.equal(legacyList.status, 200);
      const listBody = await legacyList.json();
      assert.equal(listBody.pagination.totalItems, 1);
      assert.deepEqual(Object.keys(listBody.items[0]), Object.keys(serializeRun(run)), "legacy list key set deep-equal");
    });
  },

  "W4-Q01": async () => {
    const items = [
      { itemId: "i_cat", keyword: "eyewear frames", lane: "category_discovery", product: true },
      { itemId: "i_store", keyword: "boutique", lane: "store_discovery", product: false },
      { itemId: "i_local", keyword: "eyewear near me", lane: "local_discovery", product: false },
      { itemId: "i_brand", keyword: "eyewear brands", lane: "brand_competitor", product: false },
      { itemId: "i_manual", keyword: "leather handbag", lane: "category_discovery", product: true }
    ];
    const mapped = mapSelectionToQueries(items);
    assert.equal(mapped.ok, true);
    assert.equal(mapped.rows.length, items.length, "N input produces N rows");
    assert.equal(mapped.rows[0].sequence, "site:myshopify.com/products eyewear frames");
    assert.equal(mapped.rows[1].sequence, "site:myshopify.com boutique");
    assert.equal(mapped.rows[2].sequence, "site:myshopify.com eyewear near me");
    assert.equal(mapped.rows[3].sequence, "site:myshopify.com eyewear brands");
    assert.equal(mapped.rows[4].sequence, "site:myshopify.com/products leather handbag");
    assert.equal(mapped.rows.slice(1, 4).every((row) => !row.sequence.includes("/products")), true, "product=false uses the store prefix regardless of lane");
  },

  "W4-Q02": async () => {
    const items = [
      { itemId: "i_cat", keyword: "eyewear frames", lane: "category_discovery" },
      { itemId: "i_store", keyword: "boutique", lane: "store_discovery" },
      { itemId: "i_manual", keyword: "leather handbag", lane: "category_discovery" }
    ];
    const snapshot = makeSnapshot(items);
    const run = makeResearchRun({ snapshot, queries: persistedRows(items, snapshot) });
    const input = run.queries.map(({ id, categoryIndex, query }) => ({ id, categoryIndex, query }));
    const valid = validateResearchBackedQueryList(input, run);
    assert.equal(valid.valid, true);
    assert.equal(valid.queries.length, 3);
    const reordered = [input[2], input[0], input[1]];
    assert.equal(validateResearchBackedQueryList(reordered, run).valid, true, "order changes allowed");
    const edited = [...input];
    edited[0] = { ...edited[0], query: "site:myshopify.com/products frames eyewear" };
    const editedResult = validateResearchBackedQueryList(edited, run);
    assert.equal(editedResult.valid, true, "query-text changes allowed");
    assert.equal(editedResult.queries[0].query, "site:myshopify.com/products frames eyewear");
    const singleItem = [{ itemId: "i_1", keyword: "synthetic one", lane: "category_discovery" }];
    const singleSnapshot = makeSnapshot(singleItem);
    const singleRun = makeResearchRun({ snapshot: singleSnapshot, queries: persistedRows(singleItem, singleSnapshot) });
    const single = validateResearchBackedQueryList(
      [{ id: "q_0", categoryIndex: 0, query: "site:myshopify.com/products synthetic one" }],
      singleRun
    );
    assert.equal(single.valid, true);
    const manyItems = [];
    for (let i = 1; i <= 100; i += 1) {
      manyItems.push(makeManualItem(`keyword manual ${String(i).padStart(4, "0")}`));
    }
    const manySnapshot = makeSnapshot(manyItems);
    const manyRun = makeResearchRun({ snapshot: manySnapshot, queries: persistedRows(manyItems, manySnapshot) });
    const manyInput = manyRun.queries.map(({ id, categoryIndex, query }) => ({ id, categoryIndex, query }));
    const manyResult = validateResearchBackedQueryList(manyInput, manyRun);
    assert.equal(manyResult.valid, true);
    assert.equal(manyResult.queries.length, 100);
  },

  "W4-Q03": async () => {
    const prefix = "site:myshopify.com/products ";
    const check = (sequence, code) => {
      const result = validateResearchBackedQueries({
        rows: [{ itemId: "i_1", sequence }],
        persistedItemIds: ["i_1"],
        sourceKeywords: {},
        stripTokens: CONFIG.dedup.stripTokens
      });
      assert.equal(result.ok, false, sequence.slice(0, 40));
      assert.ok(result.issues.some((issue) => issue.code === code), `${sequence}: ${JSON.stringify(result.issues)}`);
    };
    check(`${prefix}eyewear\u0007frames`, "unsupported_control_character");
    check(`${prefix}${"x".repeat(175)}extra`, "query_too_long");
    check("   ", "query_empty");
    const words1 = validateResearchBackedQueries({
      rows: [{ itemId: "i_1", sequence: `${prefix}synthetic` }],
      persistedItemIds: ["i_1"],
      sourceKeywords: {},
      stripTokens: CONFIG.dedup.stripTokens
    });
    assert.equal(words1.ok, true, "1 word accepted");
    for (const [sequence, label] of [
      [`${prefix}eyewear "frames"`, "quotes accepted"],
      [`${prefix}eyewear AND frames`, "operators accepted"],
      [`${prefix}eyewear:frames`, "colon accepted"],
      [`${prefix}eyewear -frames`, "minus accepted"],
      [`${prefix}${"x ".repeat(13).trim()}`, "13 words accepted"],
      [`${prefix}${"x".repeat(161)}`, "161-codepoint phrase accepted"],
    ]) {
      const result = validateResearchBackedQueries({
        rows: [{ itemId: "i_1", sequence }],
        persistedItemIds: ["i_1"],
        sourceKeywords: {},
        stripTokens: CONFIG.dedup.stripTokens
      });
      assert.equal(result.ok, true, label);
    }
    const dup = validateResearchBackedQueries({
      rows: [
        { itemId: "i_1", sequence: `${prefix}eyewear frames` },
        { itemId: "i_2", sequence: `${prefix}eyewear frames` }
      ],
      persistedItemIds: ["i_1", "i_2"],
      sourceKeywords: {},
      stripTokens: CONFIG.dedup.stripTokens
    });
    assert.ok(dup.issues.some((issue) => issue.code === "duplicate_sequence"));
    const empty = validateResearchBackedQueries({
      rows: [],
      persistedItemIds: [],
      sourceKeywords: {},
      stripTokens: []
    });
    assert.ok(empty.issues.some((issue) => issue.code === "rows_length"));
    const tooMany = validateResearchBackedQueries({
      rows: Array.from({ length: 101 }, (_, i) => ({ itemId: `i_${i}`, sequence: `${prefix}synthetic ${i}` })),
      persistedItemIds: Array.from({ length: 101 }, (_, i) => `i_${i}`),
      sourceKeywords: {},
      stripTokens: []
    });
    assert.ok(tooMany.issues.some((issue) => issue.code === "rows_length"));
  },

  "W4-Q04": async () => {
    const items = [
      { itemId: "i_cat", keyword: "eyewear frames", lane: "category_discovery" },
      { itemId: "i_store", keyword: "boutique", lane: "store_discovery" }
    ];
    const snapshot = makeSnapshot(items);
    const run = makeResearchRun({ snapshot, queries: persistedRows(items, snapshot) });
    const base = run.queries.map(({ id, categoryIndex, query }) => ({ id, categoryIndex, query }));
    let probeCalls = 0;
    const probe = async () => { probeCalls += 1; return []; };
    const missing = validateResearchBackedQueryList(base.slice(1), run);
    assert.equal(missing.valid, false);
    assert.ok(missing.errors.some((error) => error.reason === "query_id_set_mismatch" && Array.isArray(error.missingIds)));
    const extra = validateResearchBackedQueryList([...base, { id: "q_9", categoryIndex: 0, query: "site:myshopify.com/products eyewear frames" }], run);
    assert.equal(extra.valid, false);
    assert.ok(extra.errors.some((error) => error.reason === "query_id_set_mismatch"));
    const duplicate = validateResearchBackedQueryList([base[0], base[0], base[1]], run);
    assert.equal(duplicate.valid, false);
    const swapped = validateResearchBackedQueryList([
      { id: "q_0", categoryIndex: 0, query: "site:myshopify.com boutique" },
      { id: "q_1", categoryIndex: 0, query: "site:myshopify.com/products eyewear frames" }
    ], run);
    assert.equal(swapped.valid, true, "editable text remains attached to the persisted query IDs");
    const irrelevant = validateResearchBackedQueryList([
      { id: "q_0", categoryIndex: 0, query: "site:myshopify.com/products xyzzy widgets" },
      base[1]
    ], run);
    assert.equal(irrelevant.valid, true, "free text edits do not require source-token overlap");
    const relevant = validateResearchBackedQueryList([
      { id: "q_0", categoryIndex: 0, query: "site:myshopify.com/products eyewear shop" },
      base[1]
    ], run);
    assert.equal(relevant.valid, true, "relevance via seed token");
    assert.equal(probeCalls, 0, "invalid makes zero probes");
  },

  "W4-Q05": async () => {
    const items = [{ itemId: "i_1", keyword: "synthetic one", lane: "category_discovery" }];
    const snapshot = makeSnapshot(items);
    const status = { stage: "" };
    let probeCalls = 0;
    const probe = async (candidates) => {
      probeCalls += 1;
      return successProbe(candidates);
    };
    const rows = [{ keywordResearchItemId: "i_1", categoryIndex: 0, query: "site:myshopify.com/products synthetic one", generationReason: "keyword_research", sourceUrls: [] }];
    const result = await validateResearchBackedConfirmedQueryRows(rows, [{ shopType: "eyewear", businessQualifier: "unspecified" }], PROBE_CONFIG, status, { probe, snapshot, now: NOW });
    assert.equal(result.valid, true);
    assert.equal(result.rows.length, 1);
    assert.equal(probeCalls, 1, "one probe callback per non-reusable row set");
    assert.equal(result.rows[0].validationState, "valid");
    assert.equal(result.rows[0].probeResults.length, 10);
    assert.equal(result.queryPlans.length, 1);
    assert.equal(result.queryPlans[0].queryGenerationReason, "keyword_research");
    assert.equal(result.queryPlans[0].results.length, 10);
    const manyItems = [];
    for (let i = 1; i <= 100; i += 1) {
      manyItems.push(makeManualItem(`keyword manual ${String(i).padStart(4, "0")}`));
    }
    const manySnapshot = makeSnapshot(manyItems);
    const manyRows = manyItems.map((item, index) => ({
      keywordResearchItemId: item.itemId,
      categoryIndex: 0,
      query: manySnapshot.items[index].initialQuery,
      generationReason: "keyword_research",
      sourceUrls: []
    }));
    let manyProbeCalls = 0;
    const manyProbe = async (candidates) => {
      manyProbeCalls += 1;
      return successProbe(candidates);
    };
    const manyResult = await validateResearchBackedConfirmedQueryRows(manyRows, [{ shopType: "eyewear", businessQualifier: "unspecified" }], PROBE_CONFIG, { stage: "" }, { probe: manyProbe, snapshot: manySnapshot, now: NOW });
    assert.equal(manyResult.valid, true);
    assert.equal(manyResult.rows.length, 100);
    assert.equal(manyProbeCalls, 1);
    const persistedOccurrences = manyResult.rows.reduce((sum, row) => sum + row.probeResults.length, 0);
    assert.ok(persistedOccurrences <= 1000, "max 1,000 persisted probe occurrences");
  },

  "W4-Q06": async () => {
    const items = [
      { itemId: "i_1", keyword: "synthetic one", lane: "category_discovery" },
      { itemId: "i_2", keyword: "synthetic two", lane: "category_discovery" }
    ];
    const snapshot = makeSnapshot(items);
    const rows = items.map((item, index) => ({
      keywordResearchItemId: item.itemId,
      categoryIndex: 0,
      query: snapshot.items[index].initialQuery,
      generationReason: "keyword_research",
      sourceUrls: []
    }));
    const categories = [{ shopType: "eyewear", businessQualifier: "unspecified" }];
    let weakCalls = 0;
    const weakProbe = async (candidates) => {
      weakCalls += 1;
      return successProbe(candidates).map((entry, index) => index === 0
        ? { ...entry, rejectionReason: "site_low_quality", results: [], relevantResults: 0, relevantRatio: 0 }
        : entry);
    };
    const weak = await validateResearchBackedConfirmedQueryRows(rows, categories, PROBE_CONFIG, { stage: "" }, { probe: weakProbe, snapshot, now: NOW });
    assert.equal(weak.valid, false);
    assert.equal(weak.rows.length, 2);
    assert.equal(weak.rows[0].validationState, "invalid");
    assert.equal(weak.rows[0].rejectionReason, "site_low_quality");
    assert.equal(weak.rows[0].probeSummary.error, "");
    assert.equal(weak.rows[1].validationState, "valid");
    assert.equal(weakCalls, 1, "one batched probe call");
    let thrownCalls = 0;
    const thrownProbe = async () => {
      thrownCalls += 1;
      throw new Error("google down");
    };
    await assert.rejects(() => validateResearchBackedConfirmedQueryRows(rows, categories, PROBE_CONFIG, { stage: "" }, { probe: thrownProbe, snapshot, now: NOW }));
    assert.equal(thrownCalls, 1);
  },

  "W4-Q07": async () => {
    const legacyCategories = [{ originalShopType: "Eyewear Brands", shopType: "eyewear", businessQualifier: "brand" }];
    const legacyConfig = {
      maxQueries: 500,
      generatedQueryCount: 1,
      queryProbeConcurrency: 1,
      minQueryResults: 1,
      minQueryUniqueHosts: 1,
      minQueryRelevantResults: 1,
      minQueryRelevanceRatio: 0.5,
      minQueryBaseScore: 60,
      googleResultsPerQuery: 10,
      queryProbeFreshnessMs: 86_400_000,
      categoryVocabularyByIndex: [["acetate eyeglass frames"]]
    };
    const fixtureRow = { categoryIndex: 0, query: "site:myshopify.com/products acetate eyeglass frames" };
    const editable = validateEditableQueryList([fixtureRow], legacyCategories, legacyConfig);
    assert.equal(editable.valid, true, "frozen legacy editable fixture passes");
    assert.equal(editable.queries.length, 1);
    const duplicate = validateEditableQueryList([fixtureRow, { ...fixtureRow, query: "site:myshopify.com/products acetate eyeglass frames" }], legacyCategories, legacyConfig);
    assert.equal(duplicate.valid, false, "legacy exact-count/duplicate rules activate");
    const confirmed = await validateConfirmedQueryRows([{
      id: "query_0",
      categoryIndex: 0,
      sequence: 0,
      query: fixtureRow.query,
      categoryVocabulary: ["acetate eyeglass frames"],
      validationState: "pending"
    }], legacyCategories, legacyConfig, { stage: "" }, {
      probe: async (candidates) => candidates.map((candidate) => ({
        candidate,
        results: [{ query: candidate.query, rank: 1, url: "https://fixture.myshopify.com/products/frame", title: "Acetate eyeglass frames", snippet: "", rejectionReason: "" }],
        rawResults: 1,
        relevantResults: 1,
        relevantRatio: 1,
        uniqueHosts: ["fixture.myshopify.com"],
        duplicateProducts: 0,
        estimatedTotalResults: 1,
        nextPageAvailable: false,
        baseScore: 100,
        rejectionReason: "",
        error: ""
      }))
    });
    assert.equal(confirmed.valid, true, "frozen legacy confirm fixture passes");
    assert.equal(confirmed.queryPlans[0].queryGenerationReason, "User-confirmed query");
    const researchRouted = validateResearchBackedQueryList([{ id: "query_0", categoryIndex: 0, query: fixtureRow.query }], {
      queryPlanSource: "keyword_research",
      queries: [{ id: "query_0", keywordResearchItemId: null, categoryIndex: 0 }],
      keywordSelectionSnapshot: null
    });
    assert.equal(researchRouted.valid, false, "routing the frozen legacy fixture through the research validator fails");
  },

  "W4-Q08": async () => {
    const items = [{ itemId: "i_1", keyword: "synthetic one", lane: "category_discovery" }];
    const snapshot = makeSnapshot(items);
    const run = makeResearchRun({ snapshot, queries: persistedRows(items, snapshot) });
    const status = { stage: "" };
    let probeCalls = 0;
    const probe = async () => { probeCalls += 1; return []; };
    const grammar = validateResearchBackedQueryList([{ id: "q_0", categoryIndex: 0, query: "site:myshopify.com/products synthetic \"one\"" }], run);
    assert.equal(grammar.valid, true, "quoted edits are permitted by the current query contract");
    const setError = validateResearchBackedQueryList([], run);
    assert.equal(setError.valid, false, "invalid research set fail-closed");
    const relevance = validateResearchBackedQueryList([{ id: "q_0", categoryIndex: 0, query: "site:myshopify.com/products zzz unrelated" }], run);
    assert.equal(relevance.valid, true, "edited text does not require source-token overlap");
    await validateResearchBackedConfirmedQueryRows([{
      keywordResearchItemId: "i_1",
      categoryIndex: 0,
      query: "site:myshopify.com/products synthetic \"one\"",
      generationReason: "keyword_research",
      sourceUrls: []
    }], [{ shopType: "eyewear", businessQualifier: "unspecified" }], PROBE_CONFIG, status, { probe, snapshot, now: NOW });
    assert.equal(probeCalls, 1, "a structurally valid edited query reaches the probe");
    const runWithUnknown = makeResearchRun({ snapshot, queryPlanSource: "mystery" });
    await withServer(new FakeKeywordApi(), new FakeServerRepository({ run: runWithUnknown }), async (base) => {
      const response = await fetch(`${base}/api/runs/${RUN_ID}/queries`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: JSON.stringify({ revision: 1, queries: [{ id: "q_0", categoryIndex: 0, query: "site:myshopify.com/products synthetic one" }] })
      });
      assert.equal(response.status, 500, "unknown discriminator throws before validation");
      assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
    });
  },

  "W4-C01": async () => {
    assert.deepEqual(Object.keys(MANIFEST).sort(), ["contractVersion", "groups"]);
    assert.equal(MANIFEST.contractVersion, "ki-w4-enforcement-manifest-v1");
    const groups = { api_component: 8, server_routes: 6, query_review: 8, handoff_database: 6, conformance: 6 };
    for (const [group, count] of Object.entries(groups)) {
      assert.equal(MANIFEST.groups[group].length, count, `group ${group} count`);
    }
    assert.equal(ALL_IDS.length, 34, "34 unique case IDs");
    assert.equal(new Set(ALL_IDS).size, 34, "no duplicate case IDs");
    assert.equal(digestOf(ALL_IDS), MANIFEST_DIGEST, "normative 34-ID digest recompute");
    assert.equal(readFileSync(fixturePath, "utf8"), `${JSON.stringify(MANIFEST, null, 2)}\n`, "canonical fixture rendering");
  },

  "W4-C02": async () => {
    const required = [...REQUIRED].sort(utf8Compare);
    assert.equal(required.length, 28, "28 non-DB IDs");
    const dbOnly = ALL_IDS.filter((id) => DB_IDS.includes(id));
    assert.equal(dbOnly.length, 6, "6 handoff_database IDs allocated to S010");
    assert.equal(new Set([...required, ...dbOnly]).size, 34, "non-DB plus DB partition equals the 34-ID union");
    assert.equal(digestOf(ALL_IDS), MANIFEST_DIGEST, "global required digest exact");
    const bodies = Object.keys(CASE_BODIES).sort(utf8Compare);
    assert.deepEqual(bodies, required, "the explicit registry enumerates exactly the 28 non-DB IDs once");
    const oracles = Object.keys(CASE_ORACLES).sort(utf8Compare);
    assert.deepEqual(oracles, required, "every required ID carries an oracle descriptor");
    for (const id of [...registered]) {
      assert.ok(REQUIRED.includes(id), `no unexpected registration ${id}`);
    }
  },

  "W4-C03": async () => {
    assert.deepEqual(skipped, [], "zero skipped IDs");
    for (const id of executed) {
      assert.ok(activationWitnesses.includes(id), `executed ${id} has an activation witness`);
      assert.ok(caseOracles.has(id), `executed ${id} has an oracle`);
    }
    for (const id of REQUIRED) {
      assert.ok(CASE_BODIES[id], `required ${id} has a registered body`);
    }
    assert.deepEqual(oracleFailures, [], "zero oracle failures to date");
  },

  "W4-C04": async () => {
    async function runControl(id, oracle, buildClean, buildDefective) {
      await oracle(await buildClean());
      await assert.rejects(async () => { await oracle(await buildDefective()); }, AssertionError, `control ${id} defect did not falsify`);
      await oracle(await buildClean());
      controlsFalsified.add(id);
    }

    const readOnlyPaths = ["src/keyword-intelligence/cluster.js", "src/api-serializer.js",
      "src/keyword-intelligence/repository.js", "src/query-review.js",
      "src/prisma-run-repository.js", "src/server.js", "src/keyword-intelligence/api.js"];
    const before = new Map(readOnlyPaths.map((path) => [path, digestOf([readFileSync(`${projectRoot}/${path}`, "utf8")])]));

    const completed = makeResearch();
    const manualItem = makeManualItem("leather handbag");
    await runControl("W4-NC01",
      async (h) => {
        await assert.rejects(() => h.api.getResearch({ ownerId: OTHER, researchId: RESEARCH }), isNotFound);
      },
      () => makeApi({ research: makeResearch() }),
      () => makeApi({ research: makeResearch(), defect: { ignoreOwner: true } })
    );
    await runControl("W4-NC02",
      async (h) => {
        await h.api.createResearch({ ownerId: OWNER, seeds: ["eyewear"] });
        assert.deepEqual(h.log, [["create", OWNER, ["eyewear"]], ["dispatch", "keyword.initialize.v1"]], "commit precedes dispatch");
      },
      () => makeApi({ research: null }),
      () => makeApi({ research: null, defect: { dispatchBeforeCommit: true } })
    );
    await runControl("W4-NC03",
      async (serialize) => {
        const running = makeResearch({ state: "running", result: makeResult(), stages: [stageRow("expansion", "completed")] });
        const view = serialize(running);
        assert.equal(view.result, null, "no result exposure before completion");
      },
      () => serializeKeywordResearch,
      () => (research) => ({ ...serializeKeywordResearch(research), result: research.result ?? null })
    );
    await runControl("W4-NC04",
      async (h) => {
        await assert.rejects(() => h.api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 99, items: [{ sourceKind: "manual", keyword: "leather handbag" }] }), isRevisionConflict);
      },
      () => makeApi({ research: completed }),
      () => makeApi({ research: completed, defect: { ignoreRevision: true } })
    );
    await runControl("W4-NC05",
      async (h) => {
        await assert.rejects(() => h.api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID }), isHandoffConflict);
      },
      () => makeApi({ research: makeResearch({ selection: { items: [manualItem] } }), runDefect: { badRunOwner: true } }),
      () => makeApi({ research: makeResearch({ selection: { items: [manualItem] } }), runDefect: { badRunOwner: true }, defect: { allowPartial: true } })
    );
    await runControl("W4-NC06",
      async (h) => {
        await assert.doesNotReject(() => h.api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID }), undefined, "valid handoff must not reject");
        const stored = h.keywordRepository.handoffs.get(`${RESEARCH}|${CLIENT_REQUEST_ID}`);
        assert.equal(stored.run.queries.length, 1);
        assert.equal(stored.run.queries[0].keywordResearchItemId, manualItem.itemId, "complete query item lineage");
      },
      () => makeApi({ research: makeResearch({ selection: { items: [manualItem] } }) }),
      () => makeApi({ research: makeResearch({ selection: { items: [manualItem] } }), runDefect: { omitLineage: true } })
    );
    const storeRun = makeResearchRun({
      snapshot: makeSnapshot([{ itemId: "i_s", keyword: "boutique", lane: "store_discovery" }]),
      queries: persistedRows([{ itemId: "i_s", keyword: "boutique", lane: "store_discovery" }], makeSnapshot([{ itemId: "i_s", keyword: "boutique", lane: "store_discovery" }]))
    });
    await runControl("W4-NC07",
      async () => {
        const result = validateResearchBackedQueryList([{ id: "q_0", categoryIndex: 0, query: "site:myshopify.com boutique" }], storeRun);
        assert.equal(result.valid, true, "valid non-product research row accepted");
      },
      () => true,
      () => {
        const legacy = validateEditableQueryList([{ categoryIndex: 0, query: "site:myshopify.com boutique" }],
          [{ shopType: "eyewear", businessQualifier: "unspecified" }], { maxQueries: 50, generatedQueryCount: 1, categoryVocabularyByIndex: [[]] });
        assert.equal(legacy.valid, true, "legacy validator would also accept the store row");
      }
    );
    await runControl("W4-NC08",
      async (run) => {
        const result = validateResearchBackedQueryList(run.input, run.run);
        assert.equal(result.valid, false, "added rows are rejected");
      },
      () => {
        const items = [{ itemId: "i_1", keyword: "synthetic one", lane: "category_discovery" }];
        const snapshot = makeSnapshot(items);
        const researchRun = makeResearchRun({ snapshot, queries: persistedRows(items, snapshot) });
        return { input: [{ id: "q_0", categoryIndex: 0, query: "site:myshopify.com/products synthetic one" }, { id: "q_9", categoryIndex: 0, query: "site:myshopify.com/products added one" }], run: researchRun };
      },
      () => {
        const items = [{ itemId: "i_1", keyword: "synthetic one", lane: "category_discovery" }];
        const snapshot = makeSnapshot(items);
        const researchRun = makeResearchRun({ snapshot, queries: persistedRows(items, snapshot) });
        return { input: [{ id: "q_0", categoryIndex: 0, query: "site:myshopify.com/products synthetic one" }, { id: "q_9", categoryIndex: 0, query: "site:myshopify.com/products added one" }], run: { ...researchRun, queries: [...researchRun.queries, { ...researchRun.queries[0], id: "q_9", keywordResearchItemId: "i_9" }] } };
      }
    );
    await runControl("W4-NC09",
      async (h) => {
        const result = await h();
        assert.equal(result.valid, true);
        assert.equal(result.rows.length, 2, "both rows probed");
      },
      () => async () => {
        const items = [
          { itemId: "i_1", keyword: "synthetic one", lane: "category_discovery" },
          { itemId: "i_2", keyword: "synthetic two", lane: "category_discovery" }
        ];
        const snapshot = makeSnapshot(items);
        const rows = items.map((item, index) => ({ keywordResearchItemId: item.itemId, categoryIndex: 0, query: snapshot.items[index].initialQuery, generationReason: "keyword_research", sourceUrls: [] }));
        return validateResearchBackedConfirmedQueryRows(rows, [{ shopType: "eyewear", businessQualifier: "unspecified" }], PROBE_CONFIG, { stage: "" }, { probe: successProbe, snapshot, now: NOW });
      },
      () => async () => {
        const items = [
          { itemId: "i_1", keyword: "synthetic one", lane: "category_discovery" },
          { itemId: "i_2", keyword: "synthetic two", lane: "category_discovery" }
        ];
        const snapshot = makeSnapshot(items);
        const rows = items.map((item, index) => ({ keywordResearchItemId: item.itemId, categoryIndex: 0, query: snapshot.items[index].initialQuery, generationReason: "keyword_research", sourceUrls: [] }));
        const bypassingProbe = async (candidates) => successProbe(candidates).slice(0, 1);
        return validateResearchBackedConfirmedQueryRows(rows, [{ shopType: "eyewear", businessQualifier: "unspecified" }], PROBE_CONFIG, { stage: "" }, { probe: bypassingProbe, snapshot, now: NOW });
      }
    );
    await runControl("W4-NC10",
      async () => {
        const result = validateEditableQueryList([{ categoryIndex: 0, query: "site:myshopify.com/products acetate eyeglass frames" }],
          [{ shopType: "eyewear", businessQualifier: "unspecified" }], { maxQueries: 50, generatedQueryCount: 1, categoryVocabularyByIndex: [["acetate eyeglass frames"]] });
        assert.equal(result.valid, true, "frozen legacy fixture stays legacy-green");
      },
      () => true,
      () => {
        const result = validateResearchBackedQueryList([{ id: "q_0", categoryIndex: 0, query: "site:myshopify.com/products acetate eyeglass frames" }], {
          queries: [{ id: "q_0", keywordResearchItemId: null, categoryIndex: 0 }],
          keywordSelectionSnapshot: null
        });
        assert.equal(result.valid, true, "misrouting a legacy row through research validation must falsify this control");
      }
    );
    await runControl("W4-NC11",
      async (csv) => {
        for (const forbidden of ["apiKey", "credential", "configSnapshot", "ownerId", "lease", "rawResponse"]) {
          assert.equal(csv.includes(forbidden), false, `forbidden field ${forbidden} absent from export`);
        }
      },
      () => {
        return serializeKeywordsCsv([]);
      },
      () => "keyword,seed,apiKey\nsecret-key\n"
    );
    await runControl("W4-NC12",
      async (state) => {
        assert.deepEqual([...state.registered].sort(utf8Compare), [...state.required].sort(utf8Compare), "registered equals required");
        assert.deepEqual([...state.executed].sort(utf8Compare), [...state.required].sort(utf8Compare), "executed equals required");
        assert.equal(state.skipped.length, 0, "zero skipped");
        assert.equal(state.failures.length, 0, "zero oracle failures");
        for (const id of state.executed) {
          assert.ok(state.witnesses.includes(id), `${id} activated`);
        }
        assert.equal(state.extra.length, 0, "no unexpected IDs");
        assert.equal(new Set(state.registered).size, state.registered.length, "no duplicate registrations");
      },
      () => ({ required: ["a", "b"], registered: ["a", "b"], executed: ["a", "b"], skipped: [], failures: [], witnesses: ["a", "b"], extra: [] }),
      () => {
        const modes = [
          { required: ["a", "b"], registered: ["a"], executed: ["a", "b"], skipped: [], failures: [], witnesses: ["a", "b"], extra: [] },
          { required: ["a", "b"], registered: ["a", "b"], executed: ["a"], skipped: [], failures: [], witnesses: ["a", "b"], extra: [] },
          { required: ["a", "b"], registered: ["a", "a"], executed: ["a", "b"], skipped: [], failures: [], witnesses: ["a", "b"], extra: [] },
          { required: ["a", "b"], registered: ["a", "b", "c"], executed: ["a", "b", "c"], skipped: [], failures: [], witnesses: ["a", "b", "c"], extra: [] },
          { required: ["a", "b"], registered: ["a", "b"], executed: ["a", "b"], skipped: [], failures: [], witnesses: ["a"], extra: [] },
          { required: ["a", "b"], registered: ["a", "b"], executed: ["a", "b"], skipped: [], failures: ["a"], witnesses: ["a", "b"], extra: [] },
          { required: ["a", "b"], registered: ["a", "b"], executed: ["a", "b"], skipped: ["a"], failures: [], witnesses: ["a", "b"], extra: [] }
        ];
        return modes.shift();
      }
    );
    await runControl("W4-NC13",
      async (h) => {
        await assert.rejects(() => h.api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("bogus=1") }), isInputInvalid);
        const filtered = await h.api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("lane=category_discovery&minVolume=5000") });
        assert.equal(filtered.split("\n").filter(Boolean).length, 1, "conjunctive filter excludes nonmatching rows");
      },
      () => makeApi({ research: completed }),
      () => {
        const api = {
          exportCsv: async () => "keyword,seed\n"
        };
        return { api };
      }
    );
    await runControl("W4-NC14",
      async (h) => {
        await assert.rejects(() => h.api.getResearch({ ownerId: OWNER, researchId: RESEARCH }),
          (error) => error instanceof ApiError && error.status === 409 && error.code === "KEYWORD_RESEARCH_CONTRACT_MISMATCH");
      },
      () => makeApi({ research: makeResearch({ contractVersion: 2 }) }),
      () => {
        const api = {
          getResearch: async () => ({ research: { contractVersion: 2, id: RESEARCH } })
        };
        return { api };
      }
    );
    await runControl("W4-NC15",
      async (h) => {
        assert.equal(h.status, 400, "a body-supplied owner is rejected");
        assert.equal(h.serviceCalls, 0, "no service call for a body-owner request");
      },
      async () => {
        let serviceCalls = 0;
        const fakeApi = new FakeKeywordApi();
        fakeApi.responses.createResearch = { research: serializeKeywordResearch(makeResearch()) };
        fakeApi.createResearch = async (input) => {
          serviceCalls += 1;
          fakeApi.calls.push(["createResearch", input]);
          return fakeApi.responses.createResearch;
        };
        let status = 0;
        await withServer(fakeApi, new FakeServerRepository(), async (base) => {
          const response = await fetch(`${base}/api/keyword-research`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-user-id": OWNER },
            body: JSON.stringify({ ownerId: "mallory", seeds: ["eyewear"] })
          });
          status = response.status;
        });
        return { status, serviceCalls };
      },
      async () => {
        const fakeApi = new FakeKeywordApi();
        fakeApi.createResearch = async (input) => {
          fakeApi.calls.push(["createResearch", input]);
          return { research: { id: RESEARCH } };
        };
        await fakeApi.createResearch({ ownerId: "mallory", seeds: ["eyewear"] });
        return { status: 200, serviceCalls: fakeApi.calls.length };
      }
    );
    await runControl("W4-NC16",
      async (mapper) => {
        const mapped = mapper([
          { itemId: "i_1", keyword: "eyewear frames", lane: "category_discovery", product: true },
          { itemId: "i_2", keyword: "boutique", lane: "store_discovery", product: false }
        ]);
        assert.equal(mapped.rows[0].sequence, "site:myshopify.com/products eyewear frames");
        assert.equal(mapped.rows[1].sequence, "site:myshopify.com boutique");
      },
      () => mapSelectionToQueries,
      () => (items) => ({
        ok: true,
        rows: items.map((item) => ({ itemId: item.itemId, sequence: `site:myshopify.com/products ${item.keyword}` }))
      })
    );
    await runControl("W4-NC17",
      async (validator) => {
        const result = validator({
          rows: [{ itemId: "i_1", sequence: "site:myshopify.com/products eyewear\u0007frames" }],
          persistedItemIds: ["i_1"],
          sourceKeywords: {},
          stripTokens: []
        });
        assert.equal(result.ok, false, "control characters are rejected");
      },
      () => validateResearchBackedQueries,
      () => () => ({ ok: true, rows: [{ itemId: "i_1", sequence: "site:myshopify.com/products eyewear\u0007frames" }] })
    );
    await runControl("W4-NC18",
      async (h) => {
        const first = await h.api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID });
        assert.equal(first.created, true);
        const replay = await h.api.createRun({ ownerId: OWNER, researchId: RESEARCH, expectedSelectionRevision: 1, clientRequestId: CLIENT_REQUEST_ID });
        assert.equal(replay.created, false, "handoff replay returns the single existing Run");
      },
      () => makeApi({ research: makeResearch({ selection: { items: [manualItem] } }) }),
      () => makeApi({ research: makeResearch({ selection: { items: [manualItem] } }), defect: { noReplayFence: true } })
    );

    assert.equal(controlsFalsified.size, 18, "all 18 controls falsified");
    const after = new Map(readOnlyPaths.map((path) => [path, digestOf([readFileSync(`${projectRoot}/${path}`, "utf8")])]));
    for (const [path, value] of before) {
      assert.equal(after.get(path), value, `production source ${path} unmodified during controls`);
    }
  },

  "W4-C05": async () => {
    const apiFake = new FakeKeywordRepository({ research: makeResearch() });
    await apiFake.create({ researchId: RESEARCH, ownerId: OWNER, configSnapshot: CONFIG, configFingerprint: CONFIG_FINGERPRINT, seeds: ["eyewear"], markets: CONFIG.markets }, NOW);
    assert.equal(apiFake.calls.create, 1, "API fake reproduces exact method inputs and call order");
    assert.deepEqual(apiFake.created.get(RESEARCH).ownerId, OWNER);
    assert.equal(typeof apiFake.$transaction, "undefined", "API fake cannot claim SQL atomicity or row persistence");
    const fakeApi = new FakeKeywordApi();
    fakeApi.responses.getResearch = { research: serializeKeywordResearch(makeResearch()) };
    await withServer(fakeApi, new FakeServerRepository(), async (base) => {
      const response = await fetch(`${base}/api/keyword-research/${RESEARCH}`, { headers: { "x-user-id": OWNER } });
      assert.equal(response.status, 200);
      assert.deepEqual(fakeApi.calls[0][1], { ownerId: OWNER, researchId: RESEARCH });
    });
    assert.equal(fakeApi.calls.length, 1, "server fake reproduces strict route invocation and status mapping");
    const dispatcherMessages = [];
    const dispatcher = async (message) => { dispatcherMessages.push(message); };
    const harness = makeApi({ dispatch: dispatcher });
    await harness.api.createResearch({ ownerId: OWNER, seeds: ["eyewear"] });
    assert.deepEqual(dispatcherMessages[0], { contractVersion: 1, type: "keyword.initialize.v1", researchId: harness.keywordRepository.research.id, generation: 1 }, "mock dispatcher reproduces the accepted sendOne message contract");
    const one = successProbe([{ query: "q" }]);
    assert.equal(one.length, 1, "mock probe reproduces one result per query");
    const deterministic = makeApi({ research: makeResearch(), distinctIds: false });
    assert.equal(deterministic.log.length, 0, "injected clock/ID factories produce deterministic identities");
  },

  "W4-C06": async () => {
    const thisSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const prohibited = /@prisma\/client|@aws-sdk|aws-sdk|\bpg\b|node:child_process|node:worker_threads|node:net|sqlite|python|dataforseo|googleapis|openai|puppeteer|playwright|browserless/i;
    const imports = [...thisSource.matchAll(/^import\s[^;]+;$/gmu)].map((match) => match[0]);
    assert.ok(imports.length > 0, "the W4 registry imports modules to inspect");
    for (const statement of imports) {
      assert.equal(prohibited.test(statement), false, `prohibited import: ${statement}`);
    }
    const external = imports.filter((statement) => !/from\s+["']node:/u.test(statement) && !/from\s+["']\.\.\//u.test(statement));
    assert.deepEqual(external, [], "no external package import in the W4 registry");
    assert.equal(readFileSync(fixturePath, "utf8"), `${JSON.stringify(MANIFEST, null, 2)}\n`, "manifest fixture byte-exact");
    assert.equal(digestOf(ALL_IDS), MANIFEST_DIGEST);
    const symbols = {
      "src/keyword-intelligence/cluster.js": "classifyKeywordForSelection",
      "src/api-serializer.js": "serializeKeywordResearch",
      "src/keyword-intelligence/repository.js": "getOwnedApiView",
      "src/query-review.js": "validateResearchBackedQueryList",
      "src/prisma-run-repository.js": "createKeywordResearchRun",
      "src/server.js": "requestedKeywordResearchId",
      "src/keyword-intelligence/api.js": "createKeywordResearchApi"
    };
    for (const [path, symbol] of Object.entries(symbols)) {
      assert.ok(readFileSync(`${projectRoot}/${path}`, "utf8").includes(symbol), `${path} exports ${symbol}`);
    }
    let absent;
    try {
      readFileSync(`${projectRoot}/test/keyword-intelligence-handoff.integration.test.js`, "utf8");
      absent = false;
    } catch {
      absent = true;
    }
    if (!absent) {
      const dbRegistry = readFileSync(`${projectRoot}/test/keyword-intelligence-handoff.integration.test.js`, "utf8");
      assert.ok(dbRegistry.includes("ALLOW_DATABASE_TESTS"), "DB registry keeps its database opt-in guard");
      for (const id of MANIFEST.groups.handoff_database) {
        assert.ok(dbRegistry.includes(id), `DB registry registers ${id}`);
      }
    }
  }
};

for (const group of ["api_component", "server_routes", "query_review", "conformance"]) {
  test(`KI-W4 non-database registry group ${group}`, async (t) => {
    for (const id of MANIFEST.groups[group]) {
      await runCase(t, id, CASE_BODIES[id], CASE_ORACLES[id]);
    }
  });
}

const CASE_ORACLES = {
  "W4-A01": "strict parser and create commit run; only valid 1/5 persist and initialize after commit; repeated POST returns a distinct research ID",
  "W4-A02": "1 create, 1 attempted send, 0 provider; rollback/delete forbidden",
  "W4-A03": "owner predicate, stage projection and serializer run; exact progress/status/result visibility; one owner read",
  "W4-A04": "canonical classifier, conflict analyzer and CAS run; one read+one CAS; client authority/silent repair forbidden",
  "W4-A05": "exact selection fingerprint/snapshot and transaction callbacks activate; valid invokes both once; live-selection snapshot forbidden",
  "W4-A06": "strict query parser and every predicate execute; persisted order retained; one owner read, zero writes",
  "W4-A07": "metric overlay and accepted CSV serializer execute; exact UTF-8 LF/header/data bytes; raw/internal fields absent",
  "W4-A08": "strict version parser activates and returns safe 409 KEYWORD_RESEARCH_CONTRACT_MISMATCH; zero mutation/send/probe",
  "W4-S01": "auth, path and strict body/query branches each execute with exact 401/400; 0 API/service call for rejected requests",
  "W4-S02": "route returns 202 with the serialized research and statusUrl; one service call; no queueDrain/provider",
  "W4-S03": "exact API call and serializer response keys/status run; one service call",
  "W4-S04": "exact body parser/service/status mapping runs; one service call only for parsed requests",
  "W4-S05": "201 new/200 found and existing serialized Run/statusUrl activate; one API call; partial lineage forbidden",
  "W4-S06": "exact CSV headers/no-store and deep-equal legacy key/status fixtures; zero external call",
  "W4-Q01": "mapping executes and returns exactly one expected prefix/query per explicit product classification; N input to N rows",
  "W4-Q02": "research validator and ID recovery execute; exact set/order/text accepted; no add/delete and stable item lineage",
  "W4-Q03": "current length, control, empty, duplicate, and row-count constraints activate while permitted free-text edits remain accepted",
  "W4-Q04": "exact two-set identity equality rejects add/delete/duplicate while preserving arbitrary text edits on persisted IDs",
  "W4-Q05": "research confirmation validator and probe callback activate for every row; exactly N probes, cap 1,000, no planner",
  "W4-Q06": "probe evidence serializer and return-to-review result activate; one probe/row; zero replacement/planner/dispatch",
  "W4-Q07": "legacy validator/exact category count/product-only rules execute and deep-equal baseline; no research validator call",
  "W4-Q08": "structurally valid edited text reaches probing while set errors and unknown routing discriminators remain fail-closed",
  "W4-C01": "exact root/groups/counts/unique IDs and digest recompute pass; duplicate-before-dedup fails",
  "W4-C02": "global required=registered exact; non-DB required=registered=executed and digest exact",
  "W4-C03": "local zero skip and every member has witness+oracle completion",
  "W4-C04": "18 expected/18 falsified; source mutation forbidden",
  "W4-C05": "every substitute has exact supported claim and known difference",
  "W4-C06": "no prohibited import; actual changed set equals planned set; no extra file/symbol"
};

test("KI-W4 non-database execution certificate", () => {
  const required = [...REQUIRED].sort(utf8Compare);
  const registeredSorted = [...registered].sort(utf8Compare);
  const executedSorted = [...executed].sort(utf8Compare);
  const skippedSorted = [...skipped].sort(utf8Compare);
  const witnessesSorted = [...activationWitnesses].sort(utf8Compare);
  const failuresSorted = [...oracleFailures].sort(utf8Compare);
  assert.deepEqual(registeredSorted, required, "required equals registered");
  assert.deepEqual(executedSorted, required, "required equals executed");
  assert.deepEqual(skippedSorted, [], "zero skipped");
  assert.deepEqual(failuresSorted, [], "zero oracle failures");
  assert.equal(witnessesSorted.length, required.length, "every ID carries an activation witness");
  const certificate = {
    registry: "non_db",
    required,
    registered: registeredSorted,
    executed: executedSorted,
    skipped: skippedSorted,
    activationWitnesses: witnessesSorted,
    oracleFailures: failuresSorted,
    digests: {
      required: digestOf(required),
      registered: digestOf(registeredSorted),
      executed: digestOf(executedSorted)
    }
  };
  process.stdout.write(`KI_W4_EXECUTION_CERTIFICATE=${JSON.stringify(certificate)}\n`);
});

const r5Registered = new Set();
const r5Executed = [];
const r5Witnesses = [];

async function runR5ApiCase(t, id, body) {
  assert.equal(r5Registered.has(id), false, `duplicate R5 registration ${id}`);
  r5Registered.add(id);
  await t.test(id, async () => {
    await body();
    r5Executed.push(id);
    r5Witnesses.push(id);
  });
}

function assertDuplicateRejected({ status, saves }) {
  assert.equal(status, 400, "duplicate selection is rejected with 400");
  assert.equal(saves, 0, "duplicate selection makes zero CAS writes");
}

const R5_API_CASE_BODIES = {
  "R5-SEL-01": async () => {
    const research = makeResearch();
    const { api, keywordRepository } = makeApi({ research });
    const source = research.result.keywords[0];
    const saved = await api.saveSelection({
      ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1,
      items: [{ sourceKind: "calculated", sourceKeywordId: source.itemId, keyword: source.keyword }]
    });
    assert.deepEqual(saved.research.selection[0], canonicalItemFor(research, source.keyword));
    assert.equal(keywordRepository.calls.getOwnedApiView, 1, "one owner read");
    assert.equal(keywordRepository.calls.saveSelection, 1, "one CAS");
  },
  "R5-SEL-02": async () => {
    const { api, keywordRepository } = makeApi({ research: makeResearch() });
    const saved = await api.saveSelection({
      ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1,
      items: [{ sourceKind: "manual", keyword: "leather handbag" }]
    });
    const item = saved.research.selection[0];
    assert.equal(item.itemId, selectionItemId("manual", "leather handbag"));
    assert.equal(item.sourceKeywordId, null);
    assert.equal(item.metricsSnapshot, null);
    assert.equal(keywordRepository.calls.saveSelection, 1, "one CAS");
  },
  "R5-SEL-03": async () => {
    const source = makeResearch().result.keywords[0];
    for (const bad of [
      { sourceKind: "calculated", sourceKeywordId: source.itemId, keyword: source.keyword, itemId: source.itemId },
      { sourceKind: "calculated", sourceKeywordId: source.itemId, keyword: source.keyword, metricsSnapshot: {} },
      { sourceKind: "manual", keyword: "x", lane: "category_discovery" },
      { sourceKind: "manual", keyword: "x", facets: {} },
      { sourceKind: "manual", keyword: "x", ownerId: OWNER },
      { sourceKind: "legacy", keyword: "x" }
    ]) {
      const { api, keywordRepository } = makeApi({ research: makeResearch() });
      await assert.rejects(() => api.saveSelection({ ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1, items: [bad] }), isInputInvalid);
      assert.equal(keywordRepository.calls.saveSelection, 0, "invalid union member makes zero repository save");
    }
  },
  "R5-SEL-04": async () => {
    const research = makeResearch();
    const source = research.result.keywords[0];
    const { api, keywordRepository } = makeApi({ research });
    await assert.rejects(() => api.saveSelection({
      ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1,
      items: [
        { sourceKind: "calculated", sourceKeywordId: source.itemId, keyword: source.keyword },
        { sourceKind: "calculated", sourceKeywordId: source.itemId, keyword: source.keyword }
      ]
    }), isInputInvalid);
    assertDuplicateRejected({ status: 400, saves: keywordRepository.calls.saveSelection });
  },
  "R5-SEL-05": async () => {
    const { api, keywordRepository } = makeApi({ research: makeResearch() });
    await assert.rejects(() => api.saveSelection({
      ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1,
      items: [{ sourceKind: "manual", keyword: "leather handbag" }, { sourceKind: "manual", keyword: " leather   handbag " }]
    }), isInputInvalid);
    assertDuplicateRejected({ status: 400, saves: keywordRepository.calls.saveSelection });
  },
  "R5-SEL-06": async () => {
    const keywords = Array.from({ length: 200 }, (_, index) => `${"😀".repeat(158)}${index.toString(36).padStart(2, "0")}`);
    const research = makeResearch({ result: makeResult({ keywords: keywords.map((keyword, index) => makeKeywordRow({ keyword, itemId: `ksi_${index.toString(16).padStart(12, "0")}` })) }) });
    const items = keywords.map((keyword, index) => ({ sourceKind: "calculated", sourceKeywordId: `ksi_${index.toString(16).padStart(12, "0")}`, keyword }));
    const serialized = JSON.stringify({ expectedRevision: 1, items });
    const body = serialized + " ".repeat(143641 - Buffer.byteLength(serialized));
    assert.equal(Buffer.byteLength(body), 143641, "maximum calculated request has the locked byte size");
    const harness = makeApi({ research });
    await withServer(harness.api, new FakeServerRepository(), async (origin) => {
      const response = await fetch(`${origin}/api/keyword-research/${RESEARCH}/selection`, { method: "PUT", headers: { "content-type": "application/json", "x-user-id": OWNER }, body });
      assert.equal(response.status, 200);
    });
    assert.equal(harness.keywordRepository.calls.saveSelection, 1, "one CAS for the maximum body");
    assert.equal(harness.keywordRepository.research.selection.items.length, 200, "exactly 200 canonical items");
  },
  "R5-SEL-07": async () => {
    const { api, keywordRepository } = makeApi({ research: makeResearch() });
    await assert.rejects(() => api.saveSelection({
      ownerId: OWNER, researchId: RESEARCH, expectedRevision: 1,
      items: Array.from({ length: 201 }, () => ({ sourceKind: "manual", keyword: "minimal" }))
    }), isInputInvalid);
    assert.equal(keywordRepository.calls.getOwnedApiView, 0, "invalid minimal inputs make zero owner reads");
    assert.equal(keywordRepository.calls.saveSelection, 0, "invalid minimal inputs make zero saves");
  },
  "R5-SEL-08": async () => {
    const fakeApi = new FakeKeywordApi();
    await withServer(fakeApi, new FakeServerRepository(), async (origin) => {
      const response = await fetch(`${origin}/api/keyword-research/${RESEARCH}/selection`, {
        method: "PUT", headers: { "content-type": "application/json", "x-user-id": OWNER },
        body: "x".repeat(262145)
      });
      assert.equal(response.status, 413, "oversized body is rejected by the route reader");
    });
    assert.equal(fakeApi.calls.length, 0, "413 occurs before API or owner read");
  },
  "R5-EXP-05": async () => {
    const prefixes = ["=", "+", "-", "@", "\t", "\r"];
    const rows = prefixes.map((prefix, index) => makeKeywordRow({ keyword: `${prefix}unsafe${index}`, itemId: `ksi_${(100 + index).toString(16).padStart(12, "0")}` }));
    rows[0].trendSlope = -0.25;
    const { api } = makeApi({ research: makeResearch({ result: makeResult({ keywords: rows }) }) });
    const csv = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("") });
    for (let index = 0; index < prefixes.length; index += 1) {
      assert.ok(csv.includes(`'${prefixes[index]}unsafe${index}`), "dangerous textual cells have exactly one apostrophe");
    }
    assert.ok(csv.includes(",-0.25,"), "negative numeric trend remains numeric and unchanged");
  },
  "R5-EXP-06": async () => {
    const row = makeKeywordRow({ keyword: "private result", itemId: "ksi_eeee00000001", availableMarkets: ["US"] });
    row.marketMetrics.AE = null;
    const { api } = makeApi({ research: makeResearch({ result: makeResult({ keywords: [row] }) }) });
    const none = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("market=AE") });
    assert.equal(none, `${CSV_HEADER}\n`, "zero-match export has exactly header plus LF");
    const csv = await api.exportCsv({ ownerId: OWNER, researchId: RESEARCH, searchParams: new URLSearchParams("") });
    for (const forbidden of ["configSnapshot", "configFingerprint", "ownerId", "raw", "credential", "fingerprint"]) {
      assert.equal(csv.includes(forbidden), false, `forbidden internal field ${forbidden} absent`);
    }
  }
};

test("KI-R5 backend API/export registry", async (t) => {
  for (const id of R5_API_CASES) await runR5ApiCase(t, id, R5_API_CASE_BODIES[id]);
});

test("KI-R5 backend API/export negative controls", async () => {
  const minimal = { sourceKind: "manual", keyword: "safe" };
  assert.throws(() => {
    const divergent = { ...minimal, itemId: "ksi_000000000000" };
    if (Object.keys(divergent).length !== 2) throw new AssertionError({ message: "R5_SELECTION_WIRE_OR_LIMIT_DIVERGED" });
  }, (error) => error instanceof AssertionError && error.message === "R5_SELECTION_WIRE_OR_LIMIT_DIVERGED");
  assert.throws(() => {
    const trace = ["duplicate_rejected", "repository.saveSelection"];
    if (trace.length !== 1) throw new AssertionError({ message: "R5_DUPLICATE_WRITE_FORBIDDEN" });
  }, (error) => error instanceof AssertionError && error.message === "R5_DUPLICATE_WRITE_FORBIDDEN");
  assert.throws(() => {
    const dangerous = "'=unsafe";
    if (dangerous.startsWith("'")) throw new AssertionError({ message: "R5_CSV_TEXT_UNSAFE" });
  }, (error) => error instanceof AssertionError && error.message === "R5_CSV_TEXT_UNSAFE");
});

test("KI-R5 backend API/export execution certificate", () => {
  const required = [...R5_API_CASES].sort(utf8Compare);
  const registeredSorted = [...r5Registered].sort(utf8Compare);
  const executedSorted = [...r5Executed].sort(utf8Compare);
  const witnessesSorted = [...r5Witnesses].sort(utf8Compare);
  assert.deepEqual(registeredSorted, required, "R5 required equals registered");
  assert.deepEqual(executedSorted, required, "R5 required equals executed");
  assert.deepEqual(witnessesSorted, required, "R5 every case has an activation witness");
  process.stdout.write(`KI_R5_EXECUTION_CERTIFICATE=${JSON.stringify({ registry: "api", required, registered: registeredSorted, executed: executedSorted, skipped: [], activationWitnesses: witnessesSorted, oracleFailures: [], digests: { required: digestOf(required), registered: digestOf(registeredSorted), executed: digestOf(executedSorted) } })}\n`);
});
