export async function handleSqsBatch(event, processRecord) {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  const failures = [];
  await Promise.all(records.map(async (record) => {
    const messageId = typeof record?.messageId === "string" ? record.messageId : "";
    try {
      if (!messageId || typeof record?.body !== "string") throw new Error("PIPELINE_MESSAGE_INVALID");
      const message = JSON.parse(record.body);
      const result = await processRecord(message, record);
      if (result?.terminal === false) failures.push({ itemIdentifier: messageId });
    } catch (error) {
      if (error?.terminal === true) return;
      if (messageId) failures.push({ itemIdentifier: messageId });
    }
  }));
  failures.sort((left, right) => left.itemIdentifier.localeCompare(right.itemIdentifier));
  return { batchItemFailures: failures };
}
