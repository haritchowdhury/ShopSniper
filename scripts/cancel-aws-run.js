import { pathToFileURL } from "node:url";
import { cancelAwsRun } from "../src/aws-pipeline/operations.js";

export function parseCancellationArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) throw new Error("PIPELINE_INPUT_CONFLICT");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!["--run-id", "--generation", "--confirm"].includes(flag) || flag in values || !value)
      throw new Error("PIPELINE_INPUT_CONFLICT");
    values[flag] = value;
  }
  const runId = values["--run-id"]; const generation = Number(values["--generation"]);
  if (!/^run_[A-Za-z0-9_-]{16,80}$/u.test(runId) || !Number.isInteger(generation) || generation < 1 ||
      values["--confirm"] !== `${runId}:${generation}`) throw new Error("PIPELINE_INPUT_CONFLICT");
  return { runId, generation };
}

export async function main(argv = process.argv.slice(2), { operation = cancelAwsRun,
  write = (value) => process.stdout.write(`${value}\n`) } = {}) {
  const input = parseCancellationArguments(argv);
  const result = await operation(input);
  write(JSON.stringify({ runId: input.runId, generation: input.generation,
    stages: result.stages.length, tasks: result.tasks.length, state: result.run.state,
    safeErrorCode: result.run.safeErrorCode }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch(() => {
  process.stderr.write("PIPELINE_CANCELLED_OPERATION_FAILED\n"); process.exitCode = 1;
});
