import { PrismaKeywordResearchRepository } from "../../keyword-intelligence/repository.js";
import { S3ArtifactStore } from "../adapters/artifact-store.js";
import { handleSqsBatch } from "../adapters/sqs-batch.js";
import { createPipelineRuntime } from "../runtime.js";
import { parseKeywordMessage } from "./contracts.js";
import { processKeywordMessage } from "./service.js";

export const KEYWORD_ARTIFACT_MAX_BYTES = 33554432;

export async function handler(event = {}, runtime) {
  const injected = runtime != null;
  const base = injected ? runtime : await createPipelineRuntime();
  if (!injected) {
    let keywordQueueUrl;
    try {
      keywordQueueUrl = new URL(base?.config?.awsPipelineKeywordResearchQueueUrl);
    } catch {
      keywordQueueUrl = null;
    }
    if (base?.config?.awsPipelineKeywordResearchActive !== true || keywordQueueUrl?.protocol !== "https:") {
      throw Object.assign(new Error("KEYWORD_RUNTIME_CONFIG_INVALID"), {
        code: "KEYWORD_RUNTIME_CONFIG_INVALID"
      });
    }
  }
  if (!base?.dispatcher || !base?.s3Client || !base?.artifactStore ||
      !base?.config?.awsPipelineBucket || (!injected && !base?.prisma) ||
      (injected && !base?.repository)) {
    throw new Error("PIPELINE_INPUT_CONFLICT");
  }
  const repository = injected
    ? base.repository
    : new PrismaKeywordResearchRepository(base.prisma);
  const keywordStore = new S3ArtifactStore({
    client: base.s3Client,
    bucket: base.config.awsPipelineBucket,
    maxBytes: KEYWORD_ARTIFACT_MAX_BYTES
  });
  const keywordRuntime = {
    ...base,
    repository,
    artifactStore: keywordStore,
    clock: base.clock ?? (() => new Date()),
    http: base.http ?? globalThis.fetch,
    secrets: base.secrets ?? {}
  };
  return handleSqsBatch(event, async (message) => {
    const parsed = parseKeywordMessage(message);
    return processKeywordMessage(parsed, keywordRuntime);
  });
}
