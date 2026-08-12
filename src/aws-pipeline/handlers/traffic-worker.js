import { parseWorkMessage } from "../contracts/messages.js";
import { createPipelineRuntime } from "../runtime.js";
import { processTrafficBatch } from "../services/traffic-worker.js";

export async function handler(event) {
  if (!event || !Array.isArray(event.Records)) return { batchItemFailures: [] };
  const runtime = await createPipelineRuntime();
  const records = [];
  const invalid = [];
  for (const record of event.Records) {
    try { records.push({ recordId: record.messageId, message: parseWorkMessage(JSON.parse(record.body)) }); }
    catch { if (record.messageId) invalid.push(record.messageId); }
  }
  try {
    const result = await processTrafficBatch(records, runtime);
    return { batchItemFailures: [...new Set([...invalid,
      ...result.results.filter(({ terminal }) => !terminal).map(({ recordId }) => recordId)])].sort()
      .map((itemIdentifier) => ({ itemIdentifier })) };
  } catch {
    return { batchItemFailures: [...new Set([...invalid, ...records.map(({ recordId }) => recordId)])].sort()
      .map((itemIdentifier) => ({ itemIdentifier })) };
  }
}
