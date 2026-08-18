import { SendMessageBatchCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { PipelineContractError } from "../contracts/errors.js";
import { canonicalJson } from "../core/canonical.js";
import { mapWithConcurrency } from "../core/bounded-concurrency.js";

const SQS_BATCH_CONCURRENCY = 4;

function invalid() {
  throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
}

function parsed(schema, message) {
  const result = schema?.safeParse?.(message);
  if (!result?.success) invalid();
  return result.data;
}

function itemId(message) {
  return message.itemId ?? `${message.runId}:${message.stage}:${message.generation}:${message.reason}`;
}

export class SqsDispatcher {
  constructor({ client }) {
    if (!client || typeof client.send !== "function") invalid();
    this.client = client;
  }

  async sendOne(queueUrl, message, schema, options = {}) {
    const value = parsed(schema, message);
    const logicalId = itemId(value);
    let delaySeconds;
    if (options === null || typeof options !== "object" || Array.isArray(options) ||
        Object.getPrototypeOf(options) !== Object.prototype) invalid();
    const keys = Object.keys(options);
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== "delaySeconds")) invalid();
    if (keys.length === 1) {
      delaySeconds = options.delaySeconds;
      if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 900) invalid();
    }
    try {
      const command = delaySeconds === undefined
        ? new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: canonicalJson(value) })
        : new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: canonicalJson(value), DelaySeconds: delaySeconds });
      await this.client.send(command);
      return { sentItemIds: [logicalId], failedItemIds: [] };
    } catch {
      return { sentItemIds: [], failedItemIds: [logicalId] };
    }
  }

  async sendMany(queueUrl, messages, schema) {
    if (!Array.isArray(messages)) invalid();
    const values = messages.map((message) => parsed(schema, message));
    const chunks = [];
    for (let offset = 0; offset < values.length; offset += 10) {
      chunks.push({ offset, chunk: values.slice(offset, offset + 10) });
    }
    const chunkResults = await mapWithConcurrency(chunks, SQS_BATCH_CONCURRENCY,
      async ({ offset, chunk }) => {
      const entries = chunk.map((message, index) => ({
        Id: `m${String(offset + index).padStart(4, "0")}`,
        MessageBody: canonicalJson(message)
      }));
      const byId = new Map(entries.map((entry, index) => [entry.Id, itemId(chunk[index])]));
      let response;
      try {
        response = await this.client.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }));
      } catch {
        return chunk.map((message, index) => ({ index: offset + index,
          itemId: itemId(message), outcome: "failed" }));
      }
      const successful = response?.Successful ?? [];
      const failed = response?.Failed ?? [];
      const responseIds = [...successful, ...failed].map(({ Id }) => Id);
      if (new Set(responseIds).size !== responseIds.length ||
          responseIds.some((id) => !byId.has(id)) || responseIds.length !== chunk.length) invalid();
      const successfulIds = new Set(successful.map(({ Id }) => Id));
      return entries.map((entry, index) => ({ index: offset + index, itemId: byId.get(entry.Id),
        outcome: successfulIds.has(entry.Id) ? "sent" : "failed" }));
    });
    const results = chunkResults.flat().sort((left, right) => left.index - right.index);
    const sentItemIds = results.filter(({ outcome }) => outcome === "sent").map(({ itemId }) => itemId);
    const failedItemIds = results.filter(({ outcome }) => outcome === "failed").map(({ itemId }) => itemId);
    return { sentItemIds, failedItemIds, results };
  }
}
