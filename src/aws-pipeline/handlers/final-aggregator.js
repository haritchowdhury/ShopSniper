import { parseAggregationCheckMessage } from "../contracts/messages.js";
import { createPipelineRuntime } from "../runtime.js";
import { processFinalAggregation } from "../services/final-aggregator.js";

export async function handler(event) {
  if (!event || !Array.isArray(event.Records)) return { batchItemFailures: [] };
  const runtime = await createPipelineRuntime();
  const batchItemFailures = [];
  for (const record of event.Records) try {
    await processFinalAggregation(parseAggregationCheckMessage(JSON.parse(record.body)), runtime);
  } catch { if (record.messageId) batchItemFailures.push({ itemIdentifier: record.messageId }); }
  return { batchItemFailures };
}
