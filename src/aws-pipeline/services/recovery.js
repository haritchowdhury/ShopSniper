import { aggregationCheckMessageSchema, parseAggregationCheckMessage,
  parseWorkMessage, workMessageSchema } from "../contracts/messages.js";
import { PipelineInvariantError } from "../contracts/errors.js";

const taskMap = Object.freeze({ discovery: ["discovery.query", "awsPipelineDiscoveryQueueUrl"],
  lead: ["lead.domain", "awsPipelineLeadQueueUrl"],
  traffic_crux: ["traffic.domain", "awsPipelineTrafficQueueUrl"] });
const checkMap = Object.freeze({ discovery: "awsPipelineDomainAggregationQueueUrl",
  lead: "awsPipelineLeadAggregationQueueUrl", traffic_crux: "awsPipelineFinalAggregationQueueUrl" });

export async function recoverPipelineWork({ now, limit = 100 }, runtime) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(runtime.config.awsPipelineRecoveryAgeMs) || runtime.config.awsPipelineRecoveryAgeMs < 1)
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  const paidMarkedAmbiguous = await runtime.repository.markStaleDataForSeoRequestsAmbiguous(now);
  const olderThan = new Date(now.getTime() - runtime.config.awsPipelineRecoveryAgeMs);
  const recoverable = await runtime.coordinator.listRecoverable({ olderThan, limit }, now);
  let taskPlan; let checkPlan;
  try { taskPlan = recoverable.tasks.map(({ task, stage }) => {
    const mapping = taskMap[stage.stage]; if (!mapping) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    const message = parseWorkMessage({ version: 1, type: mapping[0], runId: stage.runId, stage: stage.stage,
      generation: stage.generation, itemId: task.itemKey, manifestKey: stage.manifestS3Key,
      manifestFingerprint: stage.manifestFingerprint, manifestProducedAt: stage.manifestProducedAt.toISOString(),
      attempt: task.dispatchCount + 1 });
    const queueUrl = runtime.config[mapping[1]];
    if (typeof queueUrl !== "string" || !queueUrl) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    return { task, stage, message, queueUrl };
  });
  checkPlan = recoverable.stages.map((stage) => {
    const message = parseAggregationCheckMessage({ version: 1, type: "aggregation.check", runId: stage.runId,
      stage: stage.stage, generation: stage.generation, reason: "recovery", attempt: stage.aggregationAttempt + 1 });
    const queueUrl = runtime.config[checkMap[stage.stage]];
    if (typeof queueUrl !== "string" || !queueUrl) throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    return { stage, message, queueUrl };
  }); } catch { throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT"); }
  let tasksSent = 0; let checksSent = 0;
  for (const queueUrl of [...new Set(taskPlan.map(({ queueUrl }) => queueUrl))]) {
    const entries = taskPlan.filter((entry) => entry.queueUrl === queueUrl);
    const sent = await runtime.dispatcher.sendMany(queueUrl, entries.map(({ message }) => message), workMessageSchema);
    if (!Array.isArray(sent.results) || sent.results.length !== entries.length ||
        new Set(sent.results.map(({ index }) => index)).size !== entries.length ||
        sent.results.some(({ index, itemId, outcome }) => !Number.isInteger(index) || index < 0 || index >= entries.length ||
          entries[index].message.itemId !== itemId || !["sent", "failed"].includes(outcome)))
      throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
    tasksSent += sent.sentItemIds.length;
    const byStage = new Map();
    for (const result of sent.results) {
      if (result.outcome !== "sent") continue;
      const entry = entries[result.index];
      const values = byStage.get(entry.stage.id) || []; values.push(entry.task.itemKey);
      byStage.set(entry.stage.id, values);
    }
    for (const [stageId, itemKeys] of byStage) await runtime.coordinator.recordDispatch({ stageId, itemKeys }, now);
  }
  for (const { queueUrl, message } of checkPlan) {
    const sent = await runtime.dispatcher.sendOne(queueUrl, message, aggregationCheckMessageSchema);
    checksSent += sent.sentItemIds.length;
  }
  return { tasksScanned: taskPlan.length, tasksSent, checksScanned: checkPlan.length,
    checksSent, paidMarkedAmbiguous: typeof paidMarkedAmbiguous === "number"
      ? paidMarkedAmbiguous : paidMarkedAmbiguous?.count ?? 0 };
}

export async function cancelAwsRunGeneration({ runId, generation, now }, runtime) {
  if (typeof runId !== "string" || !Number.isInteger(generation) || generation < 1 ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  return runtime.coordinator.cancelRunGeneration({ runId, generation }, now);
}
