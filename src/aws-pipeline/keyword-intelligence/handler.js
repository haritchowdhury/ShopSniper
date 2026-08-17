import { S3ArtifactStore } from "../adapters/artifact-store.js";
import { handleSqsBatch } from "../adapters/sqs-batch.js";
import { createPipelineRuntime } from "../runtime.js";
import { parseKeywordMessage } from "./contracts.js";
import { processKeywordMessage } from "./service.js";

export const KEYWORD_ARTIFACT_MAX_BYTES = 33554432;

export async function handler(event = {}, runtime) {
  const base = runtime ?? await createPipelineRuntime();
  if (!base.repository || !base.dispatcher || !base.artifactStore) {
    throw new Error("PIPELINE_INPUT_CONFLICT");
  }
  const keywordStore = new S3ArtifactStore({
    client: base.s3Client,
    bucket: base.config.awsPipelineBucket,
    maxBytes: KEYWORD_ARTIFACT_MAX_BYTES
  });
  const keywordRuntime = {
    ...base,
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