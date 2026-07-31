import { createHash, randomBytes } from "node:crypto";
import { ActiveRunError } from "./api-errors.js";
import { leadRecordToCreate } from "./api-serializer.js";
import { getPrismaClient } from "./prisma-client.js";
import { createInitialProgress, progressFromStatus } from "./status.js";

const ACTIVE_STATES = ["queued", "running"];

function runId() {
  return `run_${randomBytes(18).toString("base64url")}`;
}

function leadId(runIdentifier, index) {
  const opaque = createHash("sha256")
    .update(`${runIdentifier}:${index}`)
    .digest("base64url")
    .slice(0, 24);
  return `lead_${opaque}`;
}

function isUniqueConstraint(error) {
  return error?.code === "P2002" || error?.cause?.code === "23505";
}

function resultWhere(runIdentifier, filters) {
  const where = { runId: runIdentifier };
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

  async createRun(normalizedShopTypes) {
    try {
      return await this.prisma.run.create({
        data: {
          id: runId(),
          state: "queued",
          stage: "queued",
          normalizedShopTypes,
          progress: {
            ...createInitialProgress(),
            shopTypesTotal: normalizedShopTypes.length
          }
        }
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const active = await this.getActiveRun().catch(() => null);
      throw new ActiveRunError(active?.id || null);
    }
  }

  async markRunning(runIdentifier) {
    return this.prisma.run.update({
      where: { id: runIdentifier },
      data: {
        state: "running",
        stage: "reading_categories",
        startedAt: new Date(),
        safeErrorCode: null,
        safeErrorMessage: null
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

  async saveCompletedResults(runIdentifier, { leads, summary }, status = null) {
    const leadRows = leads.map((record, index) =>
      leadRecordToCreate(runIdentifier, leadId(runIdentifier, index), record)
    );
    const finalProgress = status
      ? { ...progressFromStatus(status), outputRows: leads.length }
      : undefined;

    return this.prisma.$transaction(async (transaction) => {
      await transaction.lead.deleteMany({ where: { runId: runIdentifier } });
      if (leadRows.length) {
        await transaction.lead.createMany({ data: leadRows });
      }
      return transaction.run.update({
        where: { id: runIdentifier },
        data: {
          state: "completed",
          stage: "completed",
          completedAt: new Date(),
          resultsAvailable: true,
          leadSummary: summary,
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

  async getRun(runIdentifier) {
    return this.prisma.run.findUnique({ where: { id: runIdentifier } });
  }

  async getActiveRun() {
    return this.prisma.run.findFirst({
      where: { state: { in: ACTIVE_STATES } },
      orderBy: { createdAt: "asc" }
    });
  }

  async getResultsPage(runIdentifier, filters) {
    const where = resultWhere(runIdentifier, filters);
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

  async recoverInterruptedRuns() {
    return this.prisma.run.updateMany({
      where: { state: { in: ACTIVE_STATES } },
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
