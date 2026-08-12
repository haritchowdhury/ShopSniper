import { parseAggregationCheckMessage } from "../contracts/messages.js";
import { createPipelineRuntime } from "../runtime.js";
import { processDomainAggregation } from "../services/domain-aggregator.js";

export async function handler(event) {
  if (!event || !Array.isArray(event.Records)) return { batchItemFailures: [] };
  const runtime = await createPipelineRuntime();
  const failures = [];
  for (const record of event.Records) {
    try {
      await processDomainAggregation(parseAggregationCheckMessage(JSON.parse(record.body)), runtime);
    } catch {
      if (record.messageId) failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
