import { handleSqsBatch } from "../adapters/sqs-batch.js";
import { parseWorkMessage } from "../contracts/messages.js";
import { createPipelineRuntime } from "../runtime.js";
import { processLeadMessage } from "../services/lead-worker.js";

export async function handler(event) {
  if (!event || !Array.isArray(event.Records)) return { batchItemFailures: [] };
  const runtime = await createPipelineRuntime();
  return handleSqsBatch(event, (value) => processLeadMessage(parseWorkMessage(value), runtime));
}
