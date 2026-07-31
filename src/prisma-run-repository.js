import { createHash, randomBytes } from "node:crypto";
import { RunIntentNotFoundError } from "./api-errors.js";
import {
  diagnosticRecordToCreate,
  leadRecordToCreate,
  queryAuditRecordToCreate
} from "./api-serializer.js";
import { getPrismaClient } from "./prisma-client.js";
import { createInitialProgress, progressFromStatus } from "./status.js";

const ACTIVE_STATES = ["queued", "running"];

function runId() {
  return `run_${randomBytes(18).toString("base64url")}`;
}

function runIntentId() {
  return `intent_${randomBytes(24).toString("base64url")}`;
}

function childId(prefix, runIdentifier, identity) {
  const opaque = createHash("sha256")
    .update(`${runIdentifier}:${identity}`)
    .digest("base64url")
    .slice(0, 24);
  return `${prefix}_${opaque}`;
}

function isUniqueConstraint(error) {
  return error?.code === "P2002" || error?.cause?.code === "23505";
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
  constructor(prisma = getPrismaClient()) {
    this.prisma = prisma;
  }

  async health() {
    await this.prisma.run.count();
  }

  runCreateData(ownerId, normalizedShopTypes, identifier = runId()) {
    return {
      id: identifier,
      ownerId,
      state: "queued",
      stage: "queued",
      normalizedShopTypes,
      progress: {
        ...createInitialProgress(),
        shopTypesTotal: normalizedShopTypes.length
      },
      pipelineVersion: 2,
      scoringVersion: 2
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

  async claimRunIntent(intentIdentifier, ownerId, now = new Date()) {
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

  async claimNextQueuedRun() {
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
            stage: "reading_categories",
            startedAt: new Date(),
            safeErrorCode: null,
            safeErrorMessage: null
          }
        });
        if (claimed.count !== 1) return null;
        return transaction.run.findUnique({ where: { id: next.id } });
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
      where: { id: runIdentifier, ownerId }
    });
  }

  async getActiveRunForOwner(ownerId) {
    return this.prisma.run.findFirst({
      where: { ownerId, state: { in: ACTIVE_STATES } },
      orderBy: { createdAt: "asc" }
    });
  }

  async deleteExpiredRunIntents(now = new Date()) {
    return this.prisma.runIntent.deleteMany({
      where: {
        expiresAt: { lte: now },
        claimedRunId: null
      }
    });
  }

  async updateProgress(runIdentifier, status) {
    return this.prisma.run.updateMany({
      where: { id: runIdentifier, state: { in: ACTIVE_STATES } },
      data: {
        stage: status.stage || "running",
        progress: progressFromStatus(status)
      }
    });
  }

  async saveCompletedResults(runIdentifier, {
    leads,
    queryAudits = [],
    diagnostics = [],
    summary,
    pipelineVersion = 2,
    scoringVersion = 2
  }, status = null) {
    const leadRows = leads.map((record, index) =>
      leadRecordToCreate(
        runIdentifier,
        childId(
          "lead",
          runIdentifier,
          record.identity_evidence?.stableHostname || record.resolved_domain || index
        ),
        record
      )
    );
    const auditRows = queryAudits.map((record, index) =>
      queryAuditRecordToCreate(runIdentifier, childId("audit", runIdentifier, index), index, record)
    );
    const diagnosticRows = diagnostics.map((record, index) =>
      diagnosticRecordToCreate(runIdentifier, childId("diag", runIdentifier, index), index, record)
    );
    const finalProgress = status
      ? { ...progressFromStatus(status), outputRows: leads.length }
      : undefined;

    return this.prisma.$transaction(async (transaction) => {
      await transaction.lead.deleteMany({ where: { runId: runIdentifier } });
      await transaction.queryAudit.deleteMany({ where: { runId: runIdentifier } });
      await transaction.runDiagnostic.deleteMany({ where: { runId: runIdentifier } });
      if (leadRows.length) {
        await transaction.lead.createMany({ data: leadRows });
      }
      if (auditRows.length) await transaction.queryAudit.createMany({ data: auditRows });
      if (diagnosticRows.length) {
        await transaction.runDiagnostic.createMany({ data: diagnosticRows });
      }
      return transaction.run.update({
        where: { id: runIdentifier },
        data: {
          state: "completed",
          stage: "completed",
          completedAt: new Date(),
          resultsAvailable: true,
          leadSummary: summary,
          pipelineVersion,
          scoringVersion,
          ...(finalProgress ? { progress: finalProgress } : {}),
          safeErrorCode: null,
          safeErrorMessage: null
        }
      });
    });
  }

  async markFailed(
    runIdentifier,
    {
      code = "RUN_FAILED",
      message = "The run could not be completed. Please try again."
    } = {},
    status = null
  ) {
    return this.prisma.run.update({
      where: { id: runIdentifier },
      data: {
        state: "failed",
        stage: "failed",
        completedAt: new Date(),
        resultsAvailable: false,
        safeErrorCode: code,
        safeErrorMessage: message,
        ...(status ? { progress: progressFromStatus(status) } : {})
      }
    });
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

  async recoverInterruptedRuns() {
    return this.prisma.run.updateMany({
      where: { state: "running" },
      data: {
        state: "failed",
        stage: "failed",
        completedAt: new Date(),
        resultsAvailable: false,
        safeErrorCode: "RUN_INTERRUPTED",
        safeErrorMessage:
          "The backend restarted before this run completed. Please start a new run."
      }
    });
  }
}

export function createPrismaRunRepository(prisma) {
  return new PrismaRunRepository(prisma);
}
