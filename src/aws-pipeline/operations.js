import { createPipelineRuntime } from "./runtime.js";
import { cancelAwsRunGeneration } from "./services/recovery.js";

export async function cancelAwsRun(input, { createRuntime = createPipelineRuntime,
  cancel = cancelAwsRunGeneration } = {}) {
  const runtime = await createRuntime();
  return cancel({ ...input, now: input.now ?? new Date() }, runtime);
}
