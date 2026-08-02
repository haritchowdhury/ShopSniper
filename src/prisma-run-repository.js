import { createHash, randomBytes } from "node:crypto";
import {
  RunAdmissionRejectedError,
  RunIntentNotFoundError,
  RunLeaseLostError,
  RunTerminalConflictError,
  QueryRevisionConflictError,
  RunNotAwaitingQueryConfirmationError
} from "./api-errors.js";
import {
  diagnosticRecordToCreate,
  leadTrafficEnrichmentRecordToCreate,
  leadRecordToCreate,
  queryAuditRecordToCreate,
  trafficCacheRecordToUpsert
} from "./api-serializer.js";
import { loadConfig } from "./config.js";
import {
  DATAFORSEO_COUNTRY_LOCATION_CODES,
  DATAFORSEO_ITEM_TYPES,
  DATAFORSEO_RESPONSE_CONTRACT_VERSION,
  DATAFORSEO_TARGET_LIMIT,
  DATAFORSEO_TRAFFIC_CONTRACT_VERSION
} from "./enrichment/dataforseo/request.js";
import {
  CRUX_API_RESPONSE_CONTRACT_VERSION,
  CRUX_METRICS,
  CRUX_ORIGIN_METRICS_CONTRACT_VERSION
} from "./enrichment/crux/api-request.js";
import {
  CRUX_BIGQUERY_ORIGIN_LIMIT,
  CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION,
  CRUX_POPULARITY_CONTRACT_VERSION
} from "./enrichment/crux/bigquery-request.js";
import { getPrismaClient } from "./prisma-client.js";
import { createInitialProgress, progressFromStatus } from "./status.js";
import {
  GOOGLE_PROBE_CONTRACT_VERSION,
  normalizeProbeResults,
  queryProbeFingerprint
} from "./query-review.js";

const ACTIVE_STATES = ["queued", "running"];

function runId() {
  return `run_${randomBytes(18).toString("base64url")}`;
}

function runIntentId() {
  return `intent_${randomBytes(24).toString("base64url")}`;
}

function leaseToken() {
  return `lease_${randomBytes(24).toString("base64url")}`;
}

function queryId() {
  return `query_${randomBytes(18).toString("base64url")}`;
}

function jsonValue(value) {
  return value == null ? undefined : value;
}

function activeLeaseWhere(runIdentifier, lease, now) {
  return {
    id: runIdentifier,
    state: "running",
    leaseOwner: lease.owner,
    leaseToken: lease.token,
    leaseExpiresAt: { gt: now }
  };
}

function requireLeaseMutation(result) {
  if (result.count !== 1) throw new RunLeaseLostError();
  return result;
}

function childId(prefix, runIdentifier, identity) {
  const opaque = createHash("sha256")
    .update(`${runIdentifier}:${identity}`)
    .digest("base64url")
    .slice(0, 24);
  return `${prefix}_${opaque}`;
}

export function stableLeadId(runIdentifier, record, index) {
  const identity = record.identity_evidence?.stableHostname || record.resolved_domain;
  if (!identity && !Number.isInteger(index)) {
    throw new Error("A stable lead identity or deterministic index is required");
  }
  return childId("lead", runIdentifier, identity || index);
}

function isUniqueConstraint(error) {
  return error?.code === "P2002" || error?.cause?.code === "23505";
}

function canonicalJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function metricSetKey(values) {
  return [...values].sort().join(",");
}

function dataForSeoScopes() {
  return [
    "worldwide",
    ...Object.entries(DATAFORSEO_COUNTRY_LOCATION_CODES).map(
      ([countryIsoCode, locationCode]) => ({ countryIsoCode, locationCode })
    )
  ];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

export function trafficEnrichmentConfigSnapshot(config = {}) {
  const noCoverageFreshnessMs = config.trafficNoCoverageCacheFreshnessMs ?? 86400000;
  return deepFreeze({
    version: "traffic-enrichment-run-v1",
    dataForSeo: Object.freeze({
      enabled: config.dataForSeoEnrichmentEnabled === true,
      scopes: Object.freeze(dataForSeoScopes()),
      contractVersion: DATAFORSEO_TRAFFIC_CONTRACT_VERSION,
      responseContractVersion: DATAFORSEO_RESPONSE_CONTRACT_VERSION,
      metricSet: Object.freeze([...DATAFORSEO_ITEM_TYPES]),
      metricSetKey: metricSetKey(DATAFORSEO_ITEM_TYPES),
      targetLimit: DATAFORSEO_TARGET_LIMIT,
      cacheFreshnessMs: config.dataForSeoCacheFreshnessMs ?? 2592000000,
      noCoverageFreshnessMs,
      maxCostPerRunUsd: config.dataForSeoMaxCostPerRunUsd ?? 2,
      estimatedCostPerTaskUsd: 0.024,
      paidRequestStaleMs: config.trafficPaidRequestStaleMs ?? 900000
    }),
    crux: Object.freeze({
      enabled: config.cruxEnrichmentEnabled === true,
      rest: Object.freeze({
        contractVersion: CRUX_ORIGIN_METRICS_CONTRACT_VERSION,
        responseContractVersion: CRUX_API_RESPONSE_CONTRACT_VERSION,
        metricSet: Object.freeze([...CRUX_METRICS]),
        metricSetKey: metricSetKey(CRUX_METRICS),
        concurrency: config.cruxRestConcurrency ?? 2,
        cacheFreshnessMs: config.cruxRestCacheFreshnessMs ?? 86400000,
        noCoverageFreshnessMs
      }),
      bigQuery: Object.freeze({
        contractVersion: CRUX_POPULARITY_CONTRACT_VERSION,
        responseContractVersion: CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION,
        metricSet: Object.freeze([
          "popularity_rank", "phone_density", "desktop_density", "tablet_density"
        ]),
        metricSetKey: metricSetKey([
          "popularity_rank", "phone_density", "desktop_density", "tablet_density"
        ]),
        originLimit: CRUX_BIGQUERY_ORIGIN_LIMIT,
        location: config.cruxBigQueryLocation || "US",
        maxBytesBilled: config.cruxBigQueryMaxBytesBilled ?? 10000000000
      })
    })
  });
}

const SAFE_LEDGER_FAILURES = Object.freeze({
  DATAFORSEO_NOT_DISPATCHED: "The request failed before provider dispatch.",
  DATAFORSEO_ZERO_COST_REJECTION: "The provider rejected the request with proven zero cost."
});

function safeLedgerError(code) {
  const message = SAFE_LEDGER_FAILURES[code];
  if (!message) throw new Error("A recognized safe ledger error code is required");
  return { code, message };
}

function requirePaidDescriptor(descriptor) {
  if (!descriptor || !/^[a-f0-9]{64}$/u.test(descriptor.requestFingerprint || "")) {
    throw new Error("DataForSEO request fingerprint is invalid");
  }
  if (!Number.isInteger(descriptor.targetCount) || descriptor.targetCount < 1 ||
      descriptor.targetCount > DATAFORSEO_TARGET_LIMIT) {
    throw new Error("DataForSEO target count is invalid");
  }
  if (typeof descriptor.scopeKey !== "string" || !descriptor.scopeKey || descriptor.scopeKey.length > 128) {
    throw new Error("DataForSEO scope key is invalid");
  }
  if (!/^(?:worldwide|country:[A-Z]{2}:[1-9]\d*)$/u.test(descriptor.scopeKey)) {
    throw new Error("DataForSEO scope key is invalid");
  }
  if (descriptor.refreshSucceededAfterMs != null &&
      (!Number.isSafeInteger(descriptor.refreshSucceededAfterMs) ||
       descriptor.refreshSucceededAfterMs < 1)) {
    throw new Error("DataForSEO refresh freshness is invalid");
  }
  return descriptor;
}

function requirePaidPolicy(snapshot) {
  const policy = snapshot?.dataForSeo;
  if (!policy || !Number.isFinite(policy.maxCostPerRunUsd) || policy.maxCostPerRunUsd <= 0 ||
      !Number.isFinite(policy.estimatedCostPerTaskUsd) || policy.estimatedCostPerTaskUsd <= 0 ||
      !Number.isSafeInteger(policy.paidRequestStaleMs) || policy.paidRequestStaleMs < 1) {
    throw new Error("The immutable DataForSEO paid policy is invalid");
  }
  return policy;
}

function paidExposure(rows, policy) {
  return rows.reduce((total, row) => {
    if (row.state === "succeeded") {
      const cost = Number(row.providerCostUsd);
      return total + (Number.isFinite(cost) && cost >= 0 ? cost : policy.maxCostPerRunUsd);
    }
    const reservation = Number(row.reservationCostUsd);
    return total + (Number.isFinite(reservation) && reservation > 0
      ? reservation
      : policy.estimatedCostPerTaskUsd);
  }, 0);
}

function cacheId(record) {
  return childId("traffic_cache", record.source, canonicalJson({
    identity: record.identity,
    scopeKey: record.scopeKey,
    metricSetKey: record.metricSetKey,
    contractVersion: record.contractVersion
  }));
}

function resultFingerprint(payload) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function resultWhere(runIdentifier, ownerId, filters) {
  const where = { runId: runIdentifier, run: { ownerId } };
  if (filters.status) where.status = filters.status;
  if (filters.search) {
    where.OR = [
      "storeName",
      "resolvedDomain",
      "myshopifyDomain",
      "email",
      "shopType"
    ].map((field) => ({
      [field]: { contains: filters.search, mode: "insensitive" }
    }));
  }
  return where;
}

const SORT_FIELDS = {
  lead_score: "leadScore",
  store_name: "storeName",
  shop_type: "shopType",
  google_rank: "googleRank"
};

function resultOrder(filters) {
  if (!filters.sortBy) {
    return [
      { leadScore: { sort: "desc", nulls: "last" } },
      { storeName: { sort: "asc", nulls: "last" } },
      { id: "asc" }
    ];
  }
  const field = SORT_FIELDS[filters.sortBy];
  return [
    { [field]: { sort: filters.sortDirection, nulls: "last" } },
    { id: "asc" }
  ];
}

export class PrismaRunRepository {
  constructor(prisma = getPrismaClient(), runtimeConfig = {}) {
    this.prisma = prisma;
    this.trafficEnrichmentConfig = trafficEnrichmentConfigSnapshot(runtimeConfig);
  }

  async health() {
    await this.prisma.run.count();
  }

  runCreateData(ownerId, normalizedShopTypes, identifier = runId()) {
    return {
      id: identifier,
      ownerId,
      state: "queued",
      phase: "query_planning",
      stage: "queued_query_planning",
      normalizedShopTypes,
      progress: {
        ...createInitialProgress(),
        shopTypesTotal: normalizedShopTypes.length
      },
      pipelineVersion: 2,
      scoringVersion: 2,
      trafficEnrichmentConfig: this.trafficEnrichmentConfig
    };
  }

  async createRun(ownerId, normalizedShopTypes) {
    return this.prisma.run.create({
      data: this.runCreateData(ownerId, normalizedShopTypes)
    });
  }

  async createRunIntent(normalizedShopTypes, expiresAt) {
    return this.prisma.runIntent.create({
      data: {
        id: runIntentId(),
        normalizedShopTypes,
        expiresAt
      }
    });
  }

  async claimRunIntent(
    intentIdentifier,
    ownerId,
    now = new Date(),
    { allowCreate = true } = {}
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const intent = await transaction.runIntent.findUnique({
        where: { id: intentIdentifier }
      });
      if (!intent || intent.expiresAt <= now) {
        throw new RunIntentNotFoundError();
      }
      if (intent.claimedRunId) {
        if (intent.claimedByUserId !== ownerId) {
          throw new RunIntentNotFoundError();
        }
        const existingRun = await transaction.run.findFirst({
          where: { id: intent.claimedRunId, ownerId }
        });
        if (!existingRun) throw new RunIntentNotFoundError();
        return { run: existingRun, created: false };
      }
      if (!allowCreate) throw new RunAdmissionRejectedError();

      const identifier = runId();
      const claimed = await transaction.runIntent.updateMany({
        where: {
          id: intentIdentifier,
          claimedRunId: null,
          claimedByUserId: null,
          expiresAt: { gt: now }
        },
        data: {
          claimedByUserId: ownerId,
          claimedRunId: identifier
        }
      });
      if (claimed.count !== 1) {
        const concurrent = await transaction.runIntent.findUnique({
          where: { id: intentIdentifier }
        });
        if (
          concurrent?.claimedByUserId === ownerId &&
          concurrent.claimedRunId
        ) {
          const existingRun = await transaction.run.findFirst({
            where: { id: concurrent.claimedRunId, ownerId }
          });
          if (existingRun) return { run: existingRun, created: false };
        }
        throw new RunIntentNotFoundError();
      }

      const run = await transaction.run.create({
        data: this.runCreateData(
          ownerId,
          intent.normalizedShopTypes,
          identifier
        )
      });
      return { run, created: true };
    });
  }

  async claimNextQueuedRun(
    owner,
    now = new Date(),
    leaseDurationMs = 90_000
  ) {
    if (!owner) throw new Error("A worker lease owner is required");
    const token = leaseToken();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const next = await transaction.run.findFirst({
          where: { state: "queued" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }]
        });
        if (!next) return null;
        const claimed = await transaction.run.updateMany({
          where: { id: next.id, state: "queued" },
          data: {
            state: "running",
            stage: next.phase === "scraping"
              ? "validating_confirmed_queries"
              : "reading_categories",
            startedAt: next.startedAt || now,
            leaseOwner: owner,
            leaseToken: token,
            leaseAcquiredAt: now,
            leaseExpiresAt: expiresAt,
            lastHeartbeatAt: now,
            leaseAttempt: { increment: 1 },
            safeErrorCode: null,
            safeErrorMessage: null
          }
        });
        if (claimed.count !== 1) return null;
        const run = await transaction.run.findUnique({ where: { id: next.id } });
        return { run, lease: { owner, token, expiresAt } };
      });
    } catch (error) {
      if (isUniqueConstraint(error)) return null;
      throw error;
    }
  }

  async listRuns(ownerId, { page, pageSize }) {
    const where = { ownerId };
    const skip = (page - 1) * pageSize;
    const [totalItems, items] = await this.prisma.$transaction([
      this.prisma.run.count({ where }),
      this.prisma.run.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: pageSize
      })
    ]);
    return { totalItems, items };
  }

  async getRun(runIdentifier, ownerId) {
    return this.prisma.run.findFirst({
      where: { id: runIdentifier, ownerId },
      include: {
        queries: { select: { validationState: true } }
      }
    });
  }

  async getActiveRunForOwner(ownerId) {
    return this.prisma.run.findFirst({
      where: {
        ownerId,
        state: { in: [...ACTIVE_STATES, "awaiting_query_confirmation"] }
      },
      orderBy: { createdAt: "asc" }
    });
  }

  async saveGeneratedQueryPlan(
    runIdentifier,
    lease,
    { selected = [], audits = [], categories = [], config },
    status,
    now = new Date()
  ) {
    const requiredCount = config.generatedQueryCount ?? 10;
    const counts = new Array(categories.length).fill(0);
    for (const plan of selected) {
      const categoryIndex = categories.findIndex((category) =>
        category.shopType === plan.shopType &&
        category.businessQualifier === (plan.businessQualifier || "unspecified") &&
        category.originalShopType === (plan.originalShopType || "")
      );
      if (categoryIndex >= 0) counts[categoryIndex] += 1;
    }
    if (counts.some((count) => count !== requiredCount)) {
      throw new Error("Cannot publish an incomplete generated query plan");
    }
    const rows = selected.map((plan, sequence) => {
      const categoryIndex = categories.findIndex((category) =>
        category.shopType === plan.shopType &&
        category.businessQualifier === (plan.businessQualifier || "unspecified") &&
        category.originalShopType === (plan.originalShopType || "")
      );
      if (categoryIndex < 0) throw new Error("Generated query has no matching run category");
      const category = categories[categoryIndex];
      const fingerprint = queryProbeFingerprint(plan.query, category, config);
      return {
        id: queryId(),
        runId: runIdentifier,
        categoryIndex,
        sequence,
        query: plan.query,
        source: "generated",
        validationState: "valid",
        rejectionReason: null,
        queryScore: Number.isFinite(Number(plan.queryScore)) ? Number(plan.queryScore) : null,
        generationReason: plan.queryGenerationReason || null,
        sourceUrls: Array.isArray(plan.querySourceUrls) ? plan.querySourceUrls.slice(0, 8) : [],
        categoryVocabulary: plan.categoryVocabulary || [],
        probeSummary: {
          accepted: true,
          resultCount: Array.isArray(plan.results) ? plan.results.length : 0
        },
        probeResults: normalizeProbeResults(plan.results),
        probeContractVersion: GOOGLE_PROBE_CONTRACT_VERSION,
        probeFingerprint: fingerprint,
        probedAt: now
      };
    });
    const auditRows = audits.map((record, index) =>
      queryAuditRecordToCreate(
        runIdentifier,
        childId("audit", runIdentifier, index),
        index,
        record
      )
    );
    return this.prisma.$transaction(async (transaction) => {
      const transitioned = await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          state: "awaiting_query_confirmation",
          phase: "query_review",
          stage: "awaiting_query_confirmation",
          queryRevision: { increment: 1 },
          queryPlanReadyAt: now,
          progress: progressFromStatus(status),
          leaseOwner: null,
          leaseToken: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null
        }
      });
      requireLeaseMutation(transitioned);
      await transaction.runQuery.deleteMany({ where: { runId: runIdentifier } });
      await transaction.queryAudit.deleteMany({ where: { runId: runIdentifier } });
      if (rows.length) await transaction.runQuery.createMany({ data: rows });
      if (auditRows.length) await transaction.queryAudit.createMany({ data: auditRows });
      return transaction.run.findUnique({ where: { id: runIdentifier } });
    });
  }

  async saveQueryPlanningFailure(
    runIdentifier,
    lease,
    { audits = [], shortfalls = [] },
    status,
    now = new Date()
  ) {
    const auditRows = audits.map((record, index) =>
      queryAuditRecordToCreate(
        runIdentifier,
        childId("audit", runIdentifier, index),
        index,
        record
      )
    );
    const first = shortfalls[0] || {};
    const selected = Number.isInteger(first.selected) ? first.selected : 0;
    const target = Number.isInteger(first.target) ? first.target : 10;
    const category = first.shopType || "the category";
    const message = `${selected} of ${target} required queries passed for ${category}.`;

    return this.prisma.$transaction(async (transaction) => {
      const transitioned = await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          state: "failed",
          phase: "finished",
          stage: "failed",
          completedAt: now,
          resultsAvailable: false,
          safeErrorCode: "INSUFFICIENT_HIGH_QUALITY_QUERIES",
          safeErrorMessage: message,
          progress: progressFromStatus(status),
          leaseOwner: null,
          leaseToken: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null
        }
      });
      requireLeaseMutation(transitioned);
      await transaction.runQuery.deleteMany({ where: { runId: runIdentifier } });
      await transaction.queryAudit.deleteMany({ where: { runId: runIdentifier } });
      if (auditRows.length) await transaction.queryAudit.createMany({ data: auditRows });
      return transaction.run.findUnique({ where: { id: runIdentifier } });
    });
  }

  async getEditableQueries(runIdentifier, ownerId) {
    const run = await this.prisma.run.findFirst({
      where: { id: runIdentifier, ownerId },
      include: { queries: { orderBy: { sequence: "asc" } } }
    });
    return run;
  }

  async replaceEditableQueries(
    runIdentifier,
    ownerId,
    expectedRevision,
    queries,
    now = new Date()
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.run.findFirst({
        where: { id: runIdentifier, ownerId },
        include: { queries: true }
      });
      if (!run) return null;
      if (run.state !== "awaiting_query_confirmation" || run.phase !== "query_review") {
        throw new RunNotAwaitingQueryConfirmationError();
      }
      if (run.queryRevision !== expectedRevision) {
        throw new QueryRevisionConflictError(run.queryRevision);
      }
      const advanced = await transaction.run.updateMany({
        where: {
          id: runIdentifier,
          ownerId,
          state: "awaiting_query_confirmation",
          phase: "query_review",
          queryRevision: expectedRevision
        },
        data: { queryRevision: { increment: 1 } }
      });
      if (advanced.count !== 1) {
        const current = await transaction.run.findFirst({
          where: { id: runIdentifier, ownerId },
          select: { queryRevision: true }
        });
        throw new QueryRevisionConflictError(current?.queryRevision ?? expectedRevision);
      }
      const existingById = new Map(run.queries.map((row) => [row.id, row]));
      const rows = queries.map((item, sequence) => {
        const existing = item.id ? existingById.get(item.id) : null;
        const unchanged = existing &&
          existing.categoryIndex === item.categoryIndex &&
          existing.query === item.query;
        if (unchanged) return { ...existing, sequence, updatedAt: now };
        return {
          id: existing?.id || queryId(),
          runId: runIdentifier,
          categoryIndex: item.categoryIndex,
          sequence,
          query: item.query,
          source: existing ? "user_edited" : "user_added",
          validationState: "pending",
          rejectionReason: null,
          queryScore: existing?.queryScore ?? null,
          generationReason: existing?.generationReason ?? null,
          sourceUrls: existing?.sourceUrls || [],
          categoryVocabulary: jsonValue(existing?.categoryVocabulary) || [],
          probeSummary: undefined,
          probeResults: undefined,
          probeContractVersion: null,
          probeFingerprint: null,
          probedAt: null,
          createdAt: existing?.createdAt || now,
          updatedAt: now
        };
      });
      await transaction.runQuery.deleteMany({ where: { runId: runIdentifier } });
      if (rows.length) await transaction.runQuery.createMany({ data: rows });
      return transaction.run.findUnique({
        where: { id: runIdentifier },
        include: { queries: { orderBy: { sequence: "asc" } } }
      });
    });
  }

  async confirmQueryRevision(runIdentifier, ownerId, expectedRevision, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.run.findFirst({
        where: { id: runIdentifier, ownerId }
      });
      if (!run) return null;
      if (
        run.phase === "scraping" &&
        run.confirmedQueryRevision === expectedRevision &&
        ["queued", "running"].includes(run.state)
      ) return run;
      if (run.state !== "awaiting_query_confirmation" || run.phase !== "query_review") {
        throw new RunNotAwaitingQueryConfirmationError();
      }
      if (run.queryRevision !== expectedRevision) {
        throw new QueryRevisionConflictError(run.queryRevision);
      }
      const updated = await transaction.run.updateMany({
        where: {
          id: runIdentifier,
          ownerId,
          state: "awaiting_query_confirmation",
          phase: "query_review",
          queryRevision: expectedRevision
        },
        data: {
          state: "queued",
          phase: "scraping",
          stage: "queued_query_validation",
          confirmedQueryRevision: expectedRevision,
          queriesConfirmedAt: now,
          safeErrorCode: null,
          safeErrorMessage: null
        }
      });
      if (updated.count !== 1) throw new QueryRevisionConflictError(expectedRevision);
      return transaction.run.findUnique({ where: { id: runIdentifier } });
    });
  }

  async loadConfirmedQueryPlans(runIdentifier, lease, now = new Date()) {
    const run = await this.prisma.run.findFirst({
      where: activeLeaseWhere(runIdentifier, lease, now),
      include: { queries: { orderBy: { sequence: "asc" } } }
    });
    if (!run) throw new RunLeaseLostError();
    if (run.confirmedQueryRevision !== run.queryRevision) {
      throw new Error("Confirmed query revision no longer matches the editable revision");
    }
    return run.queries;
  }

  async saveQueryValidation(runIdentifier, lease, rows, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      const fenced = await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { stage: "validating_confirmed_queries" }
      });
      requireLeaseMutation(fenced);
      for (const row of rows) {
        await transaction.runQuery.updateMany({
          where: { id: row.id, runId: runIdentifier },
          data: {
            query: row.query,
            validationState: row.validationState,
            rejectionReason: row.rejectionReason || null,
            probeSummary: jsonValue(row.probeSummary),
            probeResults: jsonValue(row.probeResults),
            probeContractVersion: row.probeContractVersion || null,
            probeFingerprint: row.probeFingerprint || null,
            probedAt: row.probedAt || null
          }
        });
      }
    });
  }

  async returnRunToQueryReview(
    runIdentifier,
    lease,
    status,
    now = new Date()
  ) {
    const result = await this.prisma.run.updateMany({
      where: activeLeaseWhere(runIdentifier, lease, now),
      data: {
        state: "awaiting_query_confirmation",
        phase: "query_review",
        stage: "awaiting_query_confirmation",
        confirmedQueryRevision: null,
        queriesConfirmedAt: null,
        progress: progressFromStatus(status),
        leaseOwner: null,
        leaseToken: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null
      }
    });
    return requireLeaseMutation(result);
  }

  async deleteExpiredRunIntents(now = new Date()) {
    return this.prisma.runIntent.deleteMany({
      where: {
        expiresAt: { lte: now },
        claimedRunId: null
      }
    });
  }

  async updateProgress(runIdentifier, lease, status, now = new Date()) {
    const result = await this.prisma.run.updateMany({
      where: activeLeaseWhere(runIdentifier, lease, now),
      data: {
        stage: status.stage || "running",
        progress: progressFromStatus(status)
      }
    });
    return requireLeaseMutation(result);
  }

  async heartbeatRun(
    runIdentifier,
    lease,
    now = new Date(),
    leaseDurationMs = 90_000
  ) {
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    const result = await this.prisma.run.updateMany({
      where: activeLeaseWhere(runIdentifier, lease, now),
      data: { lastHeartbeatAt: now, leaseExpiresAt: expiresAt }
    });
    requireLeaseMutation(result);
    return { ...lease, expiresAt };
  }

  async readFreshTrafficCache(runIdentifier, lease, keys, now = new Date()) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const OR = keys.map((key) => {
      for (const field of ["source", "identity", "scopeKey", "metricSetKey", "contractVersion"]) {
        if (typeof key?.[field] !== "string" || !key[field]) {
          throw new Error("Traffic cache lookup key is invalid");
        }
      }
      return {
        source: key.source,
        identity: key.identity,
        scopeKey: key.scopeKey,
        metricSetKey: key.metricSetKey,
        contractVersion: key.contractVersion
      };
    });
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      return transaction.trafficEnrichmentCache.findMany({
        where: { expiresAt: { gt: now }, OR }
      });
    });
  }

  async readFreshLatestCruxBigQueryCache(
    runIdentifier,
    lease,
    identities,
    now = new Date()
  ) {
    if (!Array.isArray(identities) || identities.length === 0) return [];
    if (identities.some((identity) => typeof identity !== "string" || !identity)) {
      throw new Error("CrUX BigQuery cache identities are invalid");
    }
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      return transaction.trafficEnrichmentCache.findMany({
        where: {
          source: "crux_bigquery",
          identity: { in: [...new Set(identities)] },
          scopeKey: { startsWith: "month:" },
          expiresAt: { gt: now }
        },
        orderBy: [{ scopeKey: "desc" }, { identity: "asc" }]
      });
    });
  }

  async saveCruxTrafficCache(
    runIdentifier,
    lease,
    cacheRows,
    now = new Date()
  ) {
    if (!Array.isArray(cacheRows)) throw new Error("CrUX cache rows are required");
    if (cacheRows.some(({ source }) => !["crux_rest", "crux_bigquery"].includes(source))) {
      throw new Error("Only CrUX cache rows can be written through this method");
    }
    const rows = cacheRows.map((record) =>
      trafficCacheRecordToUpsert(cacheId(record), record)
    );
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      for (const row of rows) {
        const unique = {
          source: row.source,
          identity: row.identity,
          scopeKey: row.scopeKey,
          metricSetKey: row.metricSetKey,
          contractVersion: row.contractVersion
        };
        const update = { ...row };
        delete update.id;
        await transaction.trafficEnrichmentCache.upsert({
          where: { source_identity_scopeKey_metricSetKey_contractVersion: unique },
          create: row,
          update
        });
      }
      return rows.length;
    });
  }

  async planDataForSeoRequest(
    runIdentifier,
    lease,
    descriptor,
    now = new Date(),
    retryAfterConflict = true
  ) {
    const request = requirePaidDescriptor(descriptor);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        requireLeaseMutation(await transaction.run.updateMany({
          where: activeLeaseWhere(runIdentifier, lease, now),
          data: { lastHeartbeatAt: now }
        }));
        const existing = await transaction.dataForSeoRequestLedger.findUnique({
          where: { requestFingerprint: request.requestFingerprint }
        });
        if (existing &&
            (existing.targetCount !== request.targetCount || existing.scopeKey !== request.scopeKey)) {
          throw new Error("DataForSEO request fingerprint metadata does not match");
        }
        if (existing?.state === "planned" && existing.runId !== runIdentifier) {
          const priorRun = await transaction.run.findUnique({
            where: { id: existing.runId },
            select: { state: true, leaseExpiresAt: true }
          });
          if (priorRun?.state === "running" && priorRun.leaseExpiresAt > now) {
            return { outcome: "in_flight", ledger: existing };
          }
        }
        if (existing && existing.state !== "planned") {
          const succeededExpired =
            existing.state === "succeeded" &&
            existing.runId !== runIdentifier &&
            Number.isSafeInteger(request.refreshSucceededAfterMs) &&
            existing.completedAt instanceof Date &&
            existing.completedAt.getTime() + request.refreshSucceededAfterMs <= now.getTime();
          const knownFailureRetryable =
            existing.state === "failed" && existing.runId !== runIdentifier;
          if (!succeededExpired && !knownFailureRetryable) {
            return { outcome: existing.state, ledger: existing };
          }
        }
        const data = {
          runId: runIdentifier,
          targetCount: request.targetCount,
          scopeKey: request.scopeKey,
          state: "planned",
          plannedAt: now,
          safeErrorCode: null,
          safeErrorMessage: null,
          reservationCostUsd: null,
          providerCostUsd: null,
          leaseOwner: null,
          leaseToken: null,
          leaseAttempt: null,
          claimedAt: null,
          ambiguousAfter: null,
          completedAt: null
        };
        const ledger = existing
          ? await transaction.dataForSeoRequestLedger.update({
              where: { requestFingerprint: request.requestFingerprint }, data
            })
          : await transaction.dataForSeoRequestLedger.create({
              data: { requestFingerprint: request.requestFingerprint, ...data }
            });
        return { outcome: "planned", ledger };
      });
    } catch (error) {
      if (retryAfterConflict && isUniqueConstraint(error)) {
        return this.planDataForSeoRequest(
          runIdentifier, lease, descriptor, now, false
        );
      }
      throw error;
    }
  }

  async claimDataForSeoRequest(runIdentifier, lease, requestFingerprint, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const run = await transaction.run.findUnique({
        where: { id: runIdentifier },
        select: { trafficEnrichmentConfig: true }
      });
      const policy = requirePaidPolicy(run?.trafficEnrichmentConfig);
      const currentLedger = await transaction.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint }
      });
      if (!currentLedger) throw new Error("DataForSEO request was not planned");
      if (currentLedger.runId !== runIdentifier || currentLedger.state !== "planned") {
        return {
          outcome: currentLedger.state,
          networkAllowed: false,
          ledger: currentLedger
        };
      }
      const exposureRows = await transaction.dataForSeoRequestLedger.findMany({
        where: {
          runId: runIdentifier,
          state: { in: ["in_flight", "ambiguous", "succeeded"] }
        },
        select: { state: true, reservationCostUsd: true, providerCostUsd: true }
      });
      const exposureUsd = paidExposure(exposureRows, policy);
      if (exposureUsd + policy.estimatedCostPerTaskUsd > policy.maxCostPerRunUsd) {
        const ledger = await transaction.dataForSeoRequestLedger.findUnique({
          where: { requestFingerprint }
        });
        if (!ledger) throw new Error("DataForSEO request was not planned");
        return { outcome: "budget_exceeded", networkAllowed: false, exposureUsd, ledger };
      }
      const claimed = await transaction.dataForSeoRequestLedger.updateMany({
        where: { requestFingerprint, runId: runIdentifier, state: "planned" },
        data: {
          state: "in_flight",
          attempt: { increment: 1 },
          leaseOwner: lease.owner,
          leaseToken: lease.token,
          leaseAttempt: lease.attempt ?? null,
          claimedAt: now,
          reservationCostUsd: policy.estimatedCostPerTaskUsd,
          ambiguousAfter: new Date(now.getTime() + policy.paidRequestStaleMs)
        }
      });
      const ledger = await transaction.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint }
      });
      if (!ledger) throw new Error("DataForSEO request was not planned");
      return {
        outcome: claimed.count === 1 ? "in_flight" : ledger.state,
        networkAllowed: claimed.count === 1,
        exposureUsd: claimed.count === 1
          ? exposureUsd + policy.estimatedCostPerTaskUsd
          : exposureUsd,
        ledger
      };
    });
  }

  async markDataForSeoRequestSucceeded(
    runIdentifier,
    lease,
    requestFingerprint,
    { providerCostUsd, cacheRows },
    now = new Date()
  ) {
    if (!Number.isFinite(providerCostUsd) || providerCostUsd < 0) {
      throw new Error("DataForSEO provider cost is invalid");
    }
    if (!Array.isArray(cacheRows)) throw new Error("DataForSEO cache rows are required");
    if (cacheRows.some(({ source }) => source !== "dataforseo")) {
      throw new Error("A DataForSEO ledger can commit only DataForSEO cache rows");
    }
    const rows = cacheRows.map((record) => trafficCacheRecordToUpsert(cacheId(record), record));
    const identities = new Set(rows.map((row) => canonicalJson([
      row.source, row.identity, row.scopeKey, row.metricSetKey, row.contractVersion
    ])));
    if (identities.size !== rows.length) throw new Error("Traffic cache rows contain duplicates");

    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const succeeded = await transaction.dataForSeoRequestLedger.updateMany({
        where: {
          requestFingerprint,
          runId: runIdentifier,
          state: "in_flight",
          leaseOwner: lease.owner,
          leaseToken: lease.token
        },
        data: {
          state: "succeeded",
          providerCostUsd,
          reservationCostUsd: null,
          ambiguousAfter: null,
          completedAt: now,
          safeErrorCode: null,
          safeErrorMessage: null
        }
      });
      requireLeaseMutation(succeeded);
      for (const row of rows) {
        const unique = {
          source: row.source,
          identity: row.identity,
          scopeKey: row.scopeKey,
          metricSetKey: row.metricSetKey,
          contractVersion: row.contractVersion
        };
        const update = { ...row };
        delete update.id;
        await transaction.trafficEnrichmentCache.upsert({
          where: { source_identity_scopeKey_metricSetKey_contractVersion: unique },
          create: row,
          update
        });
      }
      return transaction.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint }
      });
    });
  }

  async markDataForSeoRequestFailed(
    runIdentifier,
    lease,
    requestFingerprint,
    { code },
    now = new Date()
  ) {
    const safeError = safeLedgerError(code);
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const failed = await transaction.dataForSeoRequestLedger.updateMany({
        where: {
          requestFingerprint,
          runId: runIdentifier,
          state: "in_flight",
          leaseOwner: lease.owner,
          leaseToken: lease.token
        },
        data: {
          state: "failed",
          reservationCostUsd: null,
          ambiguousAfter: null,
          safeErrorCode: safeError.code,
          safeErrorMessage: safeError.message,
          completedAt: now
        }
      });
      requireLeaseMutation(failed);
      return transaction.dataForSeoRequestLedger.findUnique({ where: { requestFingerprint } });
    });
  }

  async markDataForSeoRequestAmbiguous(
    runIdentifier,
    lease,
    requestFingerprint,
    now = new Date()
  ) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const ambiguous = await transaction.dataForSeoRequestLedger.updateMany({
        where: {
          requestFingerprint,
          runId: runIdentifier,
          state: "in_flight",
          leaseOwner: lease.owner,
          leaseToken: lease.token
        },
        data: {
          state: "ambiguous",
          safeErrorCode: "PAID_REQUEST_OUTCOME_AMBIGUOUS",
          safeErrorMessage: "The paid request outcome could not be confirmed safely.",
          completedAt: now
        }
      });
      requireLeaseMutation(ambiguous);
      return transaction.dataForSeoRequestLedger.findUnique({
        where: { requestFingerprint }
      });
    });
  }

  async getDataForSeoRunCostUsd(runIdentifier, lease, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const aggregate = await transaction.dataForSeoRequestLedger.aggregate({
        where: { runId: runIdentifier, state: "succeeded" },
        _sum: { providerCostUsd: true }
      });
      const value = aggregate._sum.providerCostUsd;
      return value == null ? 0 : Number(value);
    });
  }

  async getDataForSeoRunExposureUsd(runIdentifier, lease, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      requireLeaseMutation(await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: { lastHeartbeatAt: now }
      }));
      const run = await transaction.run.findUnique({
        where: { id: runIdentifier },
        select: { trafficEnrichmentConfig: true }
      });
      const policy = requirePaidPolicy(run?.trafficEnrichmentConfig);
      const rows = await transaction.dataForSeoRequestLedger.findMany({
        where: {
          runId: runIdentifier,
          state: { in: ["in_flight", "ambiguous", "succeeded"] }
        },
        select: { state: true, reservationCostUsd: true, providerCostUsd: true }
      });
      return paidExposure(rows, policy);
    });
  }

  async markStaleDataForSeoRequestsAmbiguous(now = new Date()) {
    return this.prisma.dataForSeoRequestLedger.updateMany({
      where: {
        state: "in_flight",
        OR: [
          { ambiguousAfter: { lte: now } },
          { ambiguousAfter: null }
        ],
        run: {
          OR: [
            { state: { not: "running" } },
            { leaseExpiresAt: { lte: now } },
            { leaseExpiresAt: null }
          ]
        }
      },
      data: {
        state: "ambiguous",
        safeErrorCode: "PAID_REQUEST_OUTCOME_AMBIGUOUS",
        safeErrorMessage: "The paid request outcome could not be confirmed safely.",
        completedAt: now
      }
    });
  }

  async saveCompletedResults(runIdentifier, lease, {
    leads,
    trafficEnrichments = [],
    trafficEnrichmentSummary = null,
    queryAudits = [],
    diagnostics = [],
    summary,
    pipelineVersion = 2,
    scoringVersion = 2
  }, status = null, now = new Date()) {
    const leadRows = leads.map((record, index) =>
      leadRecordToCreate(
        runIdentifier,
        stableLeadId(runIdentifier, record, index),
        record
      )
    );
    const leadIds = new Set(leadRows.map(({ id }) => id));
    const enrichmentRows = trafficEnrichments.map((record) => {
      if (!leadIds.has(record.leadId)) {
        throw new Error("Traffic enrichment references an unknown lead");
      }
      return leadTrafficEnrichmentRecordToCreate(
        childId("lead_traffic", runIdentifier, `${record.leadId}:${record.source}`),
        runIdentifier,
        record.leadId,
        record
      );
    });
    const enrichmentIdentities = new Set(
      enrichmentRows.map(({ leadId, source }) => `${leadId}\u0000${source}`)
    );
    if (enrichmentIdentities.size !== enrichmentRows.length) {
      throw new Error("Traffic enrichment contains duplicate lead/source rows");
    }
    const auditRows = queryAudits.map((record, index) =>
      queryAuditRecordToCreate(runIdentifier, childId("audit", runIdentifier, index), index, record)
    );
    const diagnosticRows = diagnostics.map((record, index) =>
      diagnosticRecordToCreate(runIdentifier, childId("diag", runIdentifier, index), index, record)
    );
    const finalProgress = status
      ? { ...progressFromStatus(status), outputRows: leads.length }
      : undefined;
    const fingerprint = resultFingerprint({
      leads: leadRows,
      queryAudits: auditRows,
      diagnostics: diagnosticRows,
      trafficEnrichments: enrichmentRows,
      trafficEnrichmentSummary,
      summary,
      pipelineVersion,
      scoringVersion
    });

    return this.prisma.$transaction(async (transaction) => {
      const published = await transaction.run.updateMany({
        where: activeLeaseWhere(runIdentifier, lease, now),
        data: {
          state: "completed",
          phase: "finished",
          stage: "completed",
          completedAt: now,
          resultsAvailable: true,
          leadSummary: summary,
          ...(trafficEnrichmentSummary != null
            ? { trafficEnrichmentSummary }
            : {}),
          pipelineVersion,
          scoringVersion,
          resultFingerprint: fingerprint,
          ...(finalProgress ? { progress: finalProgress } : {}),
          safeErrorCode: null,
          safeErrorMessage: null
        }
      });
      if (published.count !== 1) {
        const existing = await transaction.run.findUnique({
          where: { id: runIdentifier }
        });
        if (
          existing?.state === "completed" &&
          existing.leaseOwner === lease.owner &&
          existing.leaseToken === lease.token &&
          existing.resultFingerprint === fingerprint
        ) {
          return existing;
        }
        throw new RunTerminalConflictError();
      }
      await transaction.leadTrafficEnrichment.deleteMany({ where: { runId: runIdentifier } });
      await transaction.lead.deleteMany({ where: { runId: runIdentifier } });
      if (auditRows.length) {
        await transaction.queryAudit.deleteMany({ where: { runId: runIdentifier } });
      }
      await transaction.runDiagnostic.deleteMany({ where: { runId: runIdentifier } });
      if (leadRows.length) {
        await transaction.lead.createMany({ data: leadRows });
      }
      if (enrichmentRows.length) {
        await transaction.leadTrafficEnrichment.createMany({ data: enrichmentRows });
      }
      if (auditRows.length) await transaction.queryAudit.createMany({ data: auditRows });
      if (diagnosticRows.length) {
        await transaction.runDiagnostic.createMany({ data: diagnosticRows });
      }
      return transaction.run.findUnique({ where: { id: runIdentifier } });
    });
  }

  async markFailed(
    runIdentifier,
    lease,
    {
      code = "RUN_FAILED",
      message = "The run could not be completed. Please try again."
    } = {},
    status = null,
    now = new Date()
  ) {
    const result = await this.prisma.run.updateMany({
      where: activeLeaseWhere(runIdentifier, lease, now),
      data: {
        state: "failed",
        phase: "finished",
        stage: "failed",
        completedAt: now,
        resultsAvailable: false,
        safeErrorCode: code,
        safeErrorMessage: message,
        pipelineVersion: 2,
        scoringVersion: 2,
        ...(status ? { progress: progressFromStatus(status) } : {})
      }
    });
    return requireLeaseMutation(result);
  }

  async getResultsPage(runIdentifier, ownerId, filters) {
    const where = resultWhere(runIdentifier, ownerId, filters);
    const skip = (filters.page - 1) * filters.pageSize;
    const [totalItems, items] = await this.prisma.$transaction([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: resultOrder(filters),
        skip,
        take: filters.pageSize
      })
    ]);
    return { totalItems, items };
  }

  async getTrafficEnrichmentsForRun(runIdentifier, ownerId) {
    return this.prisma.leadTrafficEnrichment.findMany({
      where: { runId: runIdentifier, lead: { run: { ownerId } } },
      orderBy: [{ leadId: "asc" }, { source: "asc" }]
    });
  }

  async getQueryAuditsPage(runIdentifier, ownerId, { page, pageSize }) {
    const where = { runId: runIdentifier, run: { ownerId } };
    const skip = (page - 1) * pageSize;
    const [totalItems, items] = await this.prisma.$transaction([
      this.prisma.queryAudit.count({ where }),
      this.prisma.queryAudit.findMany({ where, orderBy: { sequence: "asc" }, skip, take: pageSize })
    ]);
    return { totalItems, items };
  }

  async getDiagnosticsPage(runIdentifier, ownerId, { page, pageSize }) {
    const where = { runId: runIdentifier, run: { ownerId } };
    const skip = (page - 1) * pageSize;
    const [totalItems, items] = await this.prisma.$transaction([
      this.prisma.runDiagnostic.count({ where }),
      this.prisma.runDiagnostic.findMany({ where, orderBy: { sequence: "asc" }, skip, take: pageSize })
    ]);
    return { totalItems, items };
  }

  async recoverExpiredRuns(now = new Date()) {
    return this.prisma.run.updateMany({
      where: {
        state: "running",
        OR: [
          { leaseExpiresAt: { lte: now } },
          { leaseExpiresAt: null }
        ]
      },
      data: {
        state: "failed",
        phase: "finished",
        stage: "failed",
        completedAt: now,
        resultsAvailable: false,
        safeErrorCode: "RUN_LEASE_EXPIRED",
        safeErrorMessage:
          "The worker stopped renewing this run. Please start a new run."
      }
    });
  }
}

export function createPrismaRunRepository(prisma, config = loadConfig()) {
  return new PrismaRunRepository(prisma, config);
}
