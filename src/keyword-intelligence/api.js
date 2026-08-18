import { z } from "zod";

import { ApiError } from "../api-errors.js";
import { fingerprintJson } from "../aws-pipeline/core/canonical.js";
import { serializeKeywordResearch, serializeRun } from "../api-serializer.js";
import { newResearchId } from "./repository.js";
import { keywordResearchConfigV1, keywordResearchConfigV1Schema } from "./config.js";
import { serializeKeywordsCsv } from "./export.js";
import { analyzeSelectionConflicts, normalizeSeeds, selectionItemId } from "./selection.js";
import { classifyKeywordForSelection } from "./cluster.js";
import { mapSelectionToQueries } from "./query-mapper.js";
import { keywordResearchResultV1Schema } from "./schemas.js";
import { newRunId } from "../prisma-run-repository.js";

const CODE_INPUT_INVALID = "KEYWORD_RESEARCH_INPUT_INVALID";
const CODE_CONTRACT_MISMATCH = "KEYWORD_RESEARCH_CONTRACT_MISMATCH";
const CODE_NOT_FOUND = "KEYWORD_RESEARCH_NOT_FOUND";
const CODE_NOT_COMPLETED = "KEYWORD_RESEARCH_NOT_COMPLETED";
const CODE_HAS_CONFLICTS = "KEYWORD_SELECTION_HAS_CONFLICTS";
const CODE_REVISION_CONFLICT = "KEYWORD_SELECTION_REVISION_CONFLICT";
const CODE_HANDOFF_CONFLICT = "KEYWORD_RUN_HANDOFF_CONFLICT";

const MAX_SEED_CODEPOINTS = 100;
const MAX_KEYWORD_CODEPOINTS = 160;
const MAX_SELECTION_ITEMS = 200;
const MAX_HANDOFF_ITEMS = 100;
const MAX_FLAG_COUNT = 20;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const RESEARCH_ID = /^kr_[A-Za-z0-9_-]{24}$/u;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/u;
const CLUSTER_ID = /^c_[a-f0-9]{12}$/u;
const LANES = ["category_discovery", "store_discovery", "local_discovery", "brand_competitor"];
const MARKET_VALUES = ["all", "US", "GB", "CA", "AU", "NZ", "DE", "FR", "IN", "AE"];
const METRIC_OVERLAY_KEYS = [
  "searchVolume", "cpc", "competition", "competitionLevel", "keywordDifficulty",
  "mainIntent", "commercialIntent", "monthlyHistory", "trendSlope", "flags",
  "opportunityScore", "recommended",
];
const METRICS_SNAPSHOT_KEYS = [
  "searchVolume", "cpc", "competition", "competitionLevel", "keywordDifficulty",
  "mainIntent", "commercialIntent", "monthlyHistory", "trendSlope", "cluster",
  "clusterId", "variantGroupId", "variantCanonical", "flags",
  "opportunityScore", "recommended", "mergedInto", "availableMarkets", "marketMetrics",
];

const ownerIdSchema = z.string().min(1).max(200);
const researchIdSchema = z.string().regex(RESEARCH_ID);

const createResearchInputSchema = z.strictObject({
  ownerId: ownerIdSchema,
  seeds: z.array(z.unknown()),
});

const getResearchInputSchema = z.strictObject({
  ownerId: ownerIdSchema,
  researchId: researchIdSchema,
});

const saveSelectionInputSchema = z.strictObject({
  ownerId: ownerIdSchema,
  researchId: researchIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  items: z.array(z.unknown()),
});

const createRunInputSchema = z.strictObject({
  ownerId: ownerIdSchema,
  researchId: researchIdSchema,
  expectedSelectionRevision: z.number().int().min(1),
  clientRequestId: z.string().regex(CLIENT_REQUEST_ID),
});

const exportCsvInputSchema = z.strictObject({
  ownerId: ownerIdSchema,
  researchId: researchIdSchema,
  searchParams: z.instanceof(URLSearchParams),
});

const exportParamsSchema = z.strictObject({
  market: z.enum(MARKET_VALUES).optional(),
  seed: z.string().min(1).max(200).optional(),
  clusterId: z.string().regex(CLUSTER_ID).optional(),
  intent: z.string().min(1).max(200).optional(),
  lane: z.enum(LANES).optional(),
  category: z.string().min(1).max(200).optional(),
  audience: z.string().min(1).max(200).optional(),
  channel: z.string().min(1).max(200).optional(),
  minVolume: z.number().int().min(0).max(2147483647).optional(),
  minOpportunity: z.number().int().min(0).max(100).optional(),
  recommended: z.boolean().optional(),
  search: z.string().min(1).max(200).optional(),
  flags: z.array(z.string().min(1).max(200)).max(MAX_FLAG_COUNT),
});

function inputInvalid(details) {
  return new ApiError(400, CODE_INPUT_INVALID, "Invalid keyword research request", details);
}

function contractMismatch() {
  return new ApiError(409, CODE_CONTRACT_MISMATCH, "Unsupported persisted keyword research contract");
}

function notFound() {
  return new ApiError(404, CODE_NOT_FOUND, "Keyword research not found");
}

function notCompleted() {
  return new ApiError(409, CODE_NOT_COMPLETED, "Keyword research has not completed");
}

function hasConflicts(conflicts) {
  return new ApiError(409, CODE_HAS_CONFLICTS, "Keyword selection has conflicts", { conflicts });
}

function revisionConflict() {
  return new ApiError(409, CODE_REVISION_CONFLICT, "Keyword selection revision is stale");
}

function handoffConflict() {
  return new ApiError(409, CODE_HANDOFF_CONFLICT, "Keyword run handoff conflict");
}

function parseStrict(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw inputInvalid({
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
      })),
    });
  }
  return parsed.data;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeKeyword(value) {
  if (typeof value !== "string") throw inputInvalid();
  if (CONTROL_RE.test(value)) throw inputInvalid();
  const normalized = normalizeText(value);
  const length = [...normalized].length;
  if (length < 1 || length > MAX_KEYWORD_CODEPOINTS) throw inputInvalid();
  return normalized;
}

function normalizeParamText(value, maxCodepoints) {
  if (typeof value !== "string") throw inputInvalid();
  const normalized = normalizeText(value);
  const length = [...normalized].length;
  if (length < 1 || length > maxCodepoints) throw inputInvalid();
  return normalized;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function metricsSnapshotOf(row) {
  if (!row || row.metricsSnapshot) return row?.metricsSnapshot ?? null;
  const snapshot = {};
  for (const key of METRICS_SNAPSHOT_KEYS) {
    if (key in row) snapshot[key] = row[key];
  }
  return snapshot;
}

function assertResearchContract(research) {
  if (!research || research.contractVersion !== 1) throw contractMismatch();
  const config = keywordResearchConfigV1Schema.safeParse(research.configSnapshot);
  if (!config.success) throw contractMismatch();
  if (fingerprintJson(research.configSnapshot) !== research.configFingerprint) throw contractMismatch();
  if (research.state === "completed") {
    const result = keywordResearchResultV1Schema.safeParse(research.result);
    if (!result.success) throw contractMismatch();
  }
}

function findResultRow(research, sourceKeywordId) {
  if (typeof sourceKeywordId !== "string") return null;
  const rows = research.result?.keywords;
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row.itemId === sourceKeywordId) ?? null;
}

function canonicalizeSelectionItem(research, item) {
  const stripTokens = research.configSnapshot?.dedup?.stripTokens ?? [];
  if (!item || typeof item !== "object" || Array.isArray(item)) throw inputInvalid();
  if (item.sourceKind === "calculated") {
    const row = findResultRow(research, item.sourceKeywordId);
    if (!row) throw inputInvalid();
    const keyword = normalizeKeyword(item.keyword);
    const classified = classifyKeywordForSelection(keyword, { mainIntent: row.mainIntent, stripTokens });
    const itemId = row.itemId;
    const originalKeyword = row.originalKeyword ?? row.keyword;
    const sourceSeeds = Array.isArray(row.sourceSeeds) ? [...row.sourceSeeds] : (row.seed ? [row.seed] : []);
    const metrics = metricsSnapshotOf(row);
    if (item.itemId !== itemId) throw inputInvalid();
    if (item.sourceKeywordId !== row.itemId) throw inputInvalid();
    if (item.originalKeyword !== originalKeyword) throw inputInvalid();
    if (!sameStringArray(item.sourceSeeds, sourceSeeds)) throw inputInvalid();
    if (!deepEqual(item.metricsSnapshot ?? null, metrics)) throw inputInvalid();
    if (item.lane !== classified.lane) throw inputInvalid();
    if (!deepEqual(item.facets ?? null, classified.facets)) throw inputInvalid();
    return {
      itemId,
      sourceKind: "calculated",
      sourceKeywordId: row.itemId,
      originalKeyword,
      keyword,
      sourceSeeds,
      lane: classified.lane,
      facets: classified.facets,
      metricsSnapshot: metrics,
    };
  }
  if (item.sourceKind === "manual") {
    const keyword = normalizeKeyword(item.keyword);
    const itemId = selectionItemId("manual", keyword);
    const originalKeyword = keyword;
    const firstSeed = research.seeds?.[0];
    if (typeof firstSeed !== "string" || firstSeed.length === 0) throw inputInvalid();
    const sourceSeeds = [firstSeed];
    const classified = classifyKeywordForSelection(keyword, { mainIntent: null, stripTokens });
    if (item.sourceKeywordId !== null) throw inputInvalid();
    if (item.metricsSnapshot !== null) throw inputInvalid();
    if (item.itemId !== itemId) throw inputInvalid();
    if (item.originalKeyword !== originalKeyword) throw inputInvalid();
    if (!sameStringArray(item.sourceSeeds, sourceSeeds)) throw inputInvalid();
    if (item.lane !== classified.lane) throw inputInvalid();
    if (!deepEqual(item.facets ?? null, classified.facets)) throw inputInvalid();
    return {
      itemId,
      sourceKind: "manual",
      sourceKeywordId: null,
      originalKeyword,
      keyword,
      sourceSeeds,
      lane: classified.lane,
      facets: classified.facets,
      metricsSnapshot: null,
    };
  }
  throw inputInvalid();
}

function buildRunSnapshot(research, items) {
  const selectionFingerprint = fingerprintJson({
    contractVersion: "keyword-selection-v1",
    researchId: research.id,
    selectionRevision: research.selectionRevision,
    items,
  });
  const mapped = mapSelectionToQueries(items);
  if (!mapped.ok) throw inputInvalid();
  const snapshotItems = items.map((item, index) => ({
    ...item,
    initialQuery: mapped.rows[index].sequence,
  }));
  const snapshot = {
    contractVersion: "keyword-run-snapshot-v1",
    researchId: research.id,
    selectionRevision: research.selectionRevision,
    selectionFingerprint,
    configFingerprint: research.configFingerprint,
    dedupStripTokens: [...(research.configSnapshot?.dedup?.stripTokens ?? [])],
    seeds: research.seeds,
    items: snapshotItems,
  };
  return { selectionFingerprint, snapshotItems, snapshot };
}

function parseExportParams(searchParams) {
  const singles = {};
  const flags = [];
  for (const [name, value] of searchParams.entries()) {
    if (name === "flag") {
      if (flags.length >= MAX_FLAG_COUNT) throw inputInvalid();
      flags.push(value);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(singles, name)) throw inputInvalid();
    singles[name] = value;
  }
  const params = {};
  for (const [name, value] of Object.entries(singles)) {
    if (name === "market") params.market = value;
    else if (name === "clusterId") params.clusterId = value;
    else if (name === "lane") params.lane = value;
    else if (name === "minVolume") {
      if (!/^\d+$/u.test(value)) throw inputInvalid();
      params.minVolume = Number(value);
    } else if (name === "minOpportunity") {
      if (!/^\d+$/u.test(value)) throw inputInvalid();
      params.minOpportunity = Number(value);
    } else if (name === "recommended") {
      if (value === "true") params.recommended = true;
      else if (value === "false") params.recommended = false;
      else throw inputInvalid();
    } else if (name === "seed") params.seed = normalizeParamText(value, MAX_SEED_CODEPOINTS);
    else if (name === "intent") params.intent = normalizeParamText(value, 40);
    else if (name === "category") params.category = normalizeParamText(value, 40);
    else if (name === "audience") params.audience = normalizeParamText(value, 40);
    else if (name === "channel") params.channel = normalizeParamText(value, 40);
    else if (name === "search") params.search = normalizeParamText(value, 160);
    else throw inputInvalid();
  }
  params.flags = flags.map((value) => normalizeParamText(value, 40));
  const parsed = exportParamsSchema.safeParse(params);
  if (!parsed.success) throw inputInvalid();
  return parsed.data;
}

function projectRows(rows, market) {
  if (market === "all") return rows;
  const projected = [];
  for (const row of rows) {
    const metric = row.marketMetrics?.[market];
    if (metric === null || metric === undefined) continue;
    const copy = { ...row };
    for (const key of METRIC_OVERLAY_KEYS) {
      copy[key] = metric[key];
    }
    projected.push(copy);
  }
  return projected;
}

function facetIncludes(row, key, value) {
  const values = row.facets?.[key];
  return Array.isArray(values) && values.includes(value);
}

function searchHaystack(row) {
  const parts = [row.keyword];
  for (const seed of row.sourceSeeds) parts.push(seed);
  if (row.cluster) parts.push(row.cluster);
  parts.push(row.lane);
  const facets = row.facets || {};
  for (const key of Object.keys(facets)) {
    for (const value of facets[key]) parts.push(value);
  }
  for (const flag of row.flags) parts.push(flag);
  return parts.join(" ").toLocaleLowerCase("en-US");
}

function matchesFilters(row, params) {
  if (params.seed !== undefined) {
    const target = params.seed.toLocaleLowerCase("en-US");
    if (!row.sourceSeeds.some((value) => normalizeText(value).toLocaleLowerCase("en-US") === target)) {
      return false;
    }
  }
  if (params.clusterId !== undefined && row.clusterId !== params.clusterId) return false;
  if (params.intent !== undefined && row.mainIntent !== params.intent) return false;
  if (params.lane !== undefined && row.lane !== params.lane) return false;
  if (params.category !== undefined && !facetIncludes(row, "category", params.category)) return false;
  if (params.audience !== undefined && !facetIncludes(row, "audience", params.audience)) return false;
  if (params.channel !== undefined && !facetIncludes(row, "channel", params.channel)) return false;
  if (params.minVolume !== undefined && !(row.searchVolume >= params.minVolume)) return false;
  if (params.minOpportunity !== undefined &&
      !(row.opportunityScore !== null && row.opportunityScore !== undefined && row.opportunityScore >= params.minOpportunity)) {
    return false;
  }
  if (params.recommended !== undefined && row.recommended !== params.recommended) return false;
  if (params.flags.length > 0 && !params.flags.every((flag) => row.flags.includes(flag))) return false;
  if (params.search !== undefined &&
      !searchHaystack(row).includes(params.search.toLocaleLowerCase("en-US"))) {
    return false;
  }
  return true;
}

export function createKeywordResearchApi({
  keywordRepository,
  runRepository,
  dispatchInitialize,
  now = () => new Date(),
  researchIdFactory = newResearchId,
  runIdFactory = newRunId,
  configSnapshot = keywordResearchConfigV1(),
}) {
  async function createResearch(input) {
    const parsed = parseStrict(createResearchInputSchema, input);
    const normalized = normalizeSeeds(parsed.seeds);
    if (!normalized.ok) {
      throw inputInvalid({ issues: normalized.issues });
    }
    const researchId = researchIdFactory();
    const configFingerprint = fingerprintJson(configSnapshot);
    const created = await keywordRepository.create({
      researchId,
      ownerId: parsed.ownerId,
      configSnapshot,
      configFingerprint,
      seeds: normalized.seeds,
      markets: configSnapshot.markets,
    }, now());
    if (created.outcome === "conflict") throw contractMismatch();
    if (created.outcome === "created") {
      try {
        await dispatchInitialize({
          contractVersion: 1,
          type: "keyword.initialize.v1",
          researchId,
          generation: 1,
        });
      } catch {
        // Swallowed after the durable commit; queued-row recovery is the retry authority.
      }
    }
    return { research: serializeKeywordResearch(created.research) };
  }

  async function getResearch(input) {
    const parsed = parseStrict(getResearchInputSchema, input);
    const view = await keywordRepository.getOwnedApiView({
      researchId: parsed.researchId,
      ownerId: parsed.ownerId,
    });
    if (view.outcome === "not_found") throw notFound();
    assertResearchContract(view.research);
    return { research: serializeKeywordResearch(view.research) };
  }

  async function saveSelection(input) {
    const parsed = parseStrict(saveSelectionInputSchema, input);
    if (parsed.items.length > MAX_SELECTION_ITEMS) throw inputInvalid();
    const timestamp = now();
    const view = await keywordRepository.getOwnedApiView({
      researchId: parsed.researchId,
      ownerId: parsed.ownerId,
    });
    if (view.outcome === "not_found") throw notFound();
    const research = view.research;
    assertResearchContract(research);
    if (research.state !== "completed") throw notCompleted();
    const draft = parsed.items.map((item) => canonicalizeSelectionItem(research, item));
    const analysis = analyzeSelectionConflicts(draft, research.configSnapshot);
    if (analysis.conflicts.length > 0) throw hasConflicts(analysis.conflicts);
    const saved = await keywordRepository.saveSelection({
      researchId: parsed.researchId,
      ownerId: parsed.ownerId,
      expectedRevision: parsed.expectedRevision,
      items: draft,
    }, timestamp);
    if (saved.outcome === "not_found") throw notFound();
    if (saved.outcome !== "created") throw revisionConflict();
    research.selection = { items: draft };
    research.selectionRevision = saved.selectionRevision;
    research.selectionConflicts = [];
    research.updatedAt = timestamp;
    return { research: serializeKeywordResearch(research) };
  }

  async function createRun(input) {
    const parsed = parseStrict(createRunInputSchema, input);
    const view = await keywordRepository.getOwnedApiView({
      researchId: parsed.researchId,
      ownerId: parsed.ownerId,
    });
    if (view.outcome === "not_found") throw notFound();
    const research = view.research;
    assertResearchContract(research);
    if (research.state !== "completed") throw notCompleted();
    if (research.selectionRevision !== parsed.expectedSelectionRevision) throw revisionConflict();
    const items = Array.isArray(research.selection?.items) ? research.selection.items : null;
    if (!items || items.length < 1 || items.length > MAX_HANDOFF_ITEMS) throw inputInvalid();
    const analysis = analyzeSelectionConflicts(items, research.configSnapshot);
    if (analysis.conflicts.length > 0) throw hasConflicts(analysis.conflicts);
    const { selectionFingerprint, snapshotItems, snapshot } = buildRunSnapshot(research, items);
    const runId = runIdFactory();
    const saved = await keywordRepository.createRun({
      researchId: parsed.researchId,
      ownerId: parsed.ownerId,
      expectedSelectionRevision: parsed.expectedSelectionRevision,
      clientRequestId: parsed.clientRequestId,
      selectionFingerprint,
      items: snapshotItems,
      runId,
      constructRun: (tx, context) => runRepository.createKeywordResearchRun(tx, {
        ...context,
        selectionRevision: research.selectionRevision,
        selectionFingerprint,
        snapshot,
      }),
      constructQueries: (tx, context) => runRepository.createKeywordResearchQueries(tx, {
        ...context,
        snapshot,
      }),
    }, now());
    if (saved.outcome === "not_found") throw notFound();
    if (saved.outcome !== "created" && saved.outcome !== "found") {
      if (saved.code === CODE_NOT_COMPLETED) throw notCompleted();
      if (saved.code === CODE_REVISION_CONFLICT) throw revisionConflict();
      throw handoffConflict();
    }
    return {
      created: saved.outcome === "created",
      run: serializeRun(saved.run),
      statusUrl: `/api/runs/${saved.run.id}`,
    };
  }

  async function exportCsv(input) {
    const parsed = parseStrict(exportCsvInputSchema, input);
    const params = parseExportParams(parsed.searchParams);
    const view = await keywordRepository.getOwnedApiView({
      researchId: parsed.researchId,
      ownerId: parsed.ownerId,
    });
    if (view.outcome === "not_found") throw notFound();
    const research = view.research;
    assertResearchContract(research);
    if (research.state !== "completed") throw notCompleted();
    const rows = research.result.keywords;
    const market = params.market ?? "all";
    const projected = projectRows(rows, market);
    const filtered = projected.filter((row) => matchesFilters(row, params));
    return serializeKeywordsCsv(filtered);
  }

  return {
    createResearch,
    getResearch,
    saveSelection,
    createRun,
    exportCsv,
  };
}
