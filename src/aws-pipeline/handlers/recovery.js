import { createPipelineRuntime } from "../runtime.js";
import { PipelineInvariantError } from "../contracts/errors.js";
import { recoverPipelineWork } from "../services/recovery.js";
import { recoverKeywordWork } from "../keyword-intelligence/recovery.js";
import { PrismaKeywordResearchRepository } from "../../keyword-intelligence/repository.js";

export async function recoverCombinedWork({ now, limit = 100 }, base) {
  const pipeline = await recoverPipelineWork({ now, limit }, base);
  if (base.config?.awsPipelineKeywordResearchActive !== true) {
    return { pipeline, keyword: { outcome: "disabled" } };
  }
  if (!base.prisma) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const keywordRepository = new PrismaKeywordResearchRepository(base.prisma);
  const keyword = await recoverKeywordWork(
    { now, limit },
    { ...base, repository: keywordRepository }
  );
  return { pipeline, keyword };
}

export async function handler(event = {}) {
  const runtime = await createPipelineRuntime();
  if (!runtime.repository || !runtime.coordinator || !runtime.dispatcher) throw new Error("PIPELINE_INPUT_CONFLICT");
  const now = new Date();
  return recoverCombinedWork({ now, limit: event.limit ?? 100 }, runtime);
}
