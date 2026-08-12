import { createPipelineRuntime } from "../runtime.js";
import { recoverPipelineWork } from "../services/recovery.js";

export async function handler(event = {}) {
  const runtime = await createPipelineRuntime();
  if (!runtime.repository || !runtime.coordinator || !runtime.dispatcher) throw new Error("PIPELINE_INPUT_CONFLICT");
  return recoverPipelineWork({ now: new Date(), limit: event.limit ?? 100 }, runtime);
}
