import { PipelineInvariantError } from "../contracts/errors.js";

export async function mapWithConcurrency(items, limit, mapper) {
  if (!Array.isArray(items) || !Number.isInteger(limit) || limit < 1 || limit > 32 ||
      typeof mapper !== "function") {
    throw new PipelineInvariantError("PIPELINE_INPUT_CONFLICT");
  }
  if (items.length === 0) return [];

  const output = new Array(items.length);
  const failures = [];
  let nextIndex = 0;
  let stopped = false;
  async function worker() {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        output[index] = await mapper(items[index], index);
      } catch (error) {
        failures.push({ index, error });
        stopped = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (failures.length) {
    failures.sort((left, right) => left.index - right.index);
    throw failures[0].error;
  }
  return output;
}
