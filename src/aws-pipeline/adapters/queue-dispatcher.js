import { SendMessageBatchCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { PipelineContractError } from "../contracts/errors.js";
import { canonicalJson } from "../core/canonical.js";

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

  async sendOne(queueUrl, message, schema) {
    const value = parsed(schema, message);
    const logicalId = itemId(value);
    try {
      await this.client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: canonicalJson(value) }));
      return { sentItemIds: [logicalId], failedItemIds: [] };
    } catch {
      return { sentItemIds: [], failedItemIds: [logicalId] };
    }
  }

  async sendMany(queueUrl, messages, schema) {
    if (!Array.isArray(messages)) invalid();
    const values = messages.map((message) => parsed(schema, message));
    const sentItemIds = [];
    const failedItemIds = [];
    for (let offset = 0; offset < values.length; offset += 10) {
      const chunk = values.slice(offset, offset + 10);
      const entries = chunk.map((message, index) => ({
        Id: `m${String(offset + index).padStart(4, "0")}`,
        MessageBody: canonicalJson(message)
      }));
      const byId = new Map(entries.map((entry, index) => [entry.Id, itemId(chunk[index])]));
      let response;
      try {
        response = await this.client.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }));
      } catch {
        failedItemIds.push(...chunk.map(itemId));
        continue;
      }
      const successful = response?.Successful ?? [];
      const failed = response?.Failed ?? [];
      const responseIds = [...successful, ...failed].map(({ Id }) => Id);
      if (new Set(responseIds).size !== responseIds.length ||
          responseIds.some((id) => !byId.has(id)) || responseIds.length !== chunk.length) invalid();
      sentItemIds.push(...successful.map(({ Id }) => byId.get(Id)));
      failedItemIds.push(...failed.map(({ Id }) => byId.get(Id)));
    }
    return { sentItemIds, failedItemIds };
  }
}
